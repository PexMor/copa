//! HTTP/WebSocket level tests for copasrv, against a real listener.
//!
//! File tests use an in-process fake object store (no signature checks);
//! the real thing is covered by `scripts/test-s3.sh` against Garage.
use axum::{
    body::Bytes,
    extract::{Request, State},
    http::{header, Method, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use copa::server::{config::ConfigFile, reaper, serve, state::{build_app_state, AppState}};
use copa::storage::{Storage, StorageConfig};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::TcpStream,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio_tungstenite::tungstenite::{self, stream::MaybeTlsStream, WebSocket};

// ── Fake object store ─────────────────────────────────────────────────────────

type Objects = Arc<Mutex<HashMap<String, usize>>>;

async fn fake_s3(State(objects): State<Objects>, req: Request) -> Response {
    let method = req.method().clone();
    let key = req.uri().path().trim_start_matches("/bucket").trim_start_matches('/').to_owned();
    let body = if method == Method::PUT {
        axum::body::to_bytes(req.into_body(), usize::MAX).await.unwrap_or_default()
    } else {
        Bytes::new()
    };
    let mut objects = objects.lock().unwrap();
    match method {
        Method::PUT => {
            objects.insert(key, body.len());
            StatusCode::OK.into_response()
        }
        Method::HEAD => match objects.get(&key) {
            Some(len) => (StatusCode::OK, [(header::CONTENT_LENGTH, len.to_string())]).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        },
        Method::DELETE => {
            objects.remove(&key);
            StatusCode::NO_CONTENT.into_response()
        }
        Method::GET if key.is_empty() => {
            let contents: String = objects
                .iter()
                .map(|(k, len)| {
                    format!(
                        "<Contents><Key>{k}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified>\
                         <ETag>&quot;e&quot;</ETag><Size>{len}</Size><StorageClass>STANDARD</StorageClass></Contents>"
                    )
                })
                .collect();
            let xml = format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
                 <ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">\
                 <Name>bucket</Name><Prefix>copa/</Prefix><KeyCount>{}</KeyCount><MaxKeys>1000</MaxKeys>\
                 <IsTruncated>false</IsTruncated>{contents}</ListBucketResult>",
                objects.len()
            );
            (StatusCode::OK, [(header::CONTENT_TYPE, "application/xml")], xml).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

// ── Harness ───────────────────────────────────────────────────────────────────

const CONFIG: &str = r#"
[server.namespaces.default]
rw_token = "rw"
read_token = "ro"
write_token = "wo"
history_limit = 3
item_ttl_secs = 3600
max_file_size = 1000
file_quota_bytes = 1500

[server.namespaces.other]
rw_token = "other-rw"
files = false
"#;

struct TestServer {
    url:     String,
    clock:   Arc<AtomicU64>,
    state:   Arc<AppState>,
    objects: Objects,
    rt:      tokio::runtime::Runtime,
}

fn start_with(config: &str, with_storage: bool) -> TestServer {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let objects: Objects = Arc::default();

    let storage = with_storage.then(|| {
        let listener = rt.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new().fallback(fake_s3).with_state(objects.clone());
        rt.spawn(async move { axum::serve(listener, app).await.unwrap() });
        let cfg = StorageConfig {
            public_url:        Some(format!("http://{addr}")),
            bucket:            Some("bucket".into()),
            access_key_id:     Some("GKtest".into()),
            secret_access_key: Some("secret".into()),
            ..Default::default()
        };
        Arc::new(Storage::from_config(&cfg, None).unwrap().0)
    });

    let cfg: ConfigFile = toml::from_str(config).unwrap();
    let clock = Arc::new(AtomicU64::new(1_000_000));
    let c = clock.clone();
    let state = build_app_state(&cfg.server, storage, Arc::new(move || c.load(Ordering::SeqCst)), 0, "127.0.0.1")
        .unwrap();

    let listener = rt.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let s = state.clone();
    rt.spawn(async move { serve(listener, s, None).await.unwrap() });
    TestServer { url, clock, state, objects, rt }
}

fn start() -> TestServer {
    start_with(CONFIG, false)
}

impl TestServer {
    fn advance(&self, secs: u64) {
        self.clock.fetch_add(secs * 1000, Ordering::SeqCst);
    }

    fn reap(&self) {
        self.rt.block_on(reaper::reap_once(&self.state));
    }

    fn req(&self, method: &str, path: &str, token: &str) -> ureq::Request {
        let req = ureq::request(method, &format!("{}{path}", self.url));
        if token.is_empty() { req } else { req.set("Authorization", &format!("Bearer {token}")) }
    }

    fn call(&self, method: &str, path: &str, token: &str) -> (u16, String) {
        done(self.req(method, path, token).call())
    }

    fn send(&self, method: &str, path: &str, token: &str, body: &str) -> (u16, String) {
        done(self.req(method, path, token).send_string(body))
    }

    fn json(&self, method: &str, path: &str, token: &str) -> Value {
        let (code, body) = self.call(method, path, token);
        assert_eq!(code, 200, "{method} {path}: {body}");
        serde_json::from_str(&body).unwrap()
    }

    fn push(&self, text: &str) {
        assert_eq!(self.send("POST", "/api/clipboard", "rw", text), (200, "ok".into()));
    }

    fn history(&self) -> Vec<Value> {
        self.json("GET", "/api/history", "rw").as_array().unwrap().clone()
    }

    fn ws(&self, path: &str) -> WebSocket<MaybeTlsStream<TcpStream>> {
        let (socket, _) = tungstenite::connect(format!("{}{path}", self.url.replace("http", "ws"))).unwrap();
        if let MaybeTlsStream::Plain(s) = socket.get_ref() {
            s.set_read_timeout(Some(Duration::from_millis(1500))).unwrap();
        }
        socket
    }

    /// Request an upload, PUT `size` bytes to the store, complete it. Returns the id.
    fn upload(&self, name: &str, size: usize) -> String {
        let grant = self.request_upload(name, size);
        ureq::put(grant["upload_url"].as_str().unwrap()).send_bytes(&vec![7u8; size]).unwrap();
        let id = grant["id"].as_str().unwrap().to_owned();
        let (code, body) = self.send("POST", &format!("/api/files/{id}/complete"), "rw", "");
        assert_eq!(code, 200, "{body}");
        id
    }

    fn request_upload(&self, name: &str, size: usize) -> Value {
        let (code, body) = self.send("POST", "/api/files", "rw", &json!({ "name": name, "size": size }).to_string());
        assert_eq!(code, 200, "{body}");
        serde_json::from_str(&body).unwrap()
    }

    fn object_count(&self) -> usize {
        self.objects.lock().unwrap().len()
    }

    /// Object deletions triggered by a request run in the background.
    fn wait_for_objects(&self, expected: usize) {
        for _ in 0..100 {
            if self.object_count() == expected {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("expected {expected} objects, store has {}", self.object_count());
    }
}

fn done(result: Result<ureq::Response, ureq::Error>) -> (u16, String) {
    match result {
        Ok(r) => (r.status(), r.into_string().unwrap()),
        Err(ureq::Error::Status(code, r)) => (code, r.into_string().unwrap()),
        Err(e) => panic!("transport error: {e}"),
    }
}

fn next_text(ws: &mut WebSocket<MaybeTlsStream<TcpStream>>) -> Option<String> {
    match ws.read() {
        Ok(tungstenite::Message::Text(t)) => Some(t.to_string()),
        Ok(other) => panic!("unexpected frame: {other:?}"),
        Err(_) => None, // read timeout
    }
}

// ── Legacy clipboard API ──────────────────────────────────────────────────────

#[test]
fn old_style_push_and_pull_round_trip() {
    let s = start();
    assert_eq!(s.call("GET", "/api/clipboard", "rw"), (200, String::new()));
    s.push("hello");
    assert_eq!(s.call("GET", "/api/clipboard", "rw"), (200, "hello".into()));
    // query-string token and namespace keep working on the legacy endpoint
    assert_eq!(s.call("GET", "/api/clipboard?token=ro&namespace=default", ""), (200, "hello".into()));
    assert_eq!(s.call("GET", "/api/clipboard", "wo").0, 401);
    assert_eq!(s.send("POST", "/api/clipboard", "ro", "x").0, 401);
    assert_eq!(s.send("POST", "/api/clipboard", "rw", &"x".repeat(16_385)).0, 413);
    assert_eq!(s.req("GET", "/api/clipboard", "rw").set("X-Copa-Namespace", "nope").call().unwrap_err().into_response().unwrap().status(), 404);
}

#[test]
fn expired_newest_text_yields_empty_body() {
    let s = start();
    s.push("short lived");
    s.advance(3599);
    assert_eq!(s.call("GET", "/api/clipboard", "rw").1, "short lived");
    s.advance(1);
    assert_eq!(s.call("GET", "/api/clipboard", "rw"), (200, String::new()));
    assert!(s.history().is_empty());
}

#[test]
fn ttl_header_is_honoured_clamped_and_validated() {
    let s = start();
    let push_ttl = |ttl: &str, body: &str| done(s.req("POST", "/api/clipboard", "rw").set("X-Copa-TTL", ttl).send_string(body));
    assert_eq!(push_ttl("60", "a").0, 200);
    let item = &s.history()[0];
    assert_eq!(item["expires_at"].as_u64().unwrap() - item["created_at"].as_u64().unwrap(), 60_000);

    assert_eq!(push_ttl("999999", "b").0, 200);
    let item = &s.history()[0];
    assert_eq!(item["expires_at"].as_u64().unwrap() - item["created_at"].as_u64().unwrap(), 3_600_000);

    assert_eq!(push_ttl("0", "c").0, 400);
    assert_eq!(push_ttl("soon", "c").0, 400);
}

// ── History API ───────────────────────────────────────────────────────────────

#[test]
fn history_lists_newest_first_with_bounded_preview() {
    let s = start();
    s.push("first");
    s.advance(1);
    let long = "x".repeat(500);
    s.push(&long);
    let items = s.history();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["preview"].as_str().unwrap().len(), 200);
    assert_eq!(items[0]["size"], 500);
    assert_eq!(items[0]["kind"], "text");
    assert_eq!(items[1]["preview"], "first");
    for key in ["id", "created_at", "expires_at"] {
        assert!(!items[0][key].is_null(), "{key}");
    }
    assert!(!serde_json::to_string(&items).unwrap().contains(&long));

    // older item is retrievable in full by id
    let id = items[1]["id"].as_str().unwrap();
    assert_eq!(s.call("GET", &format!("/api/history/{id}"), "ro"), (200, "first".into()));
}

#[test]
fn history_limit_evicts_oldest() {
    let s = start();
    for n in 0..4 {
        s.push(&format!("item {n}"));
        s.advance(1);
    }
    let previews: Vec<_> = s.history().iter().map(|i| i["preview"].as_str().unwrap().to_owned()).collect();
    assert_eq!(previews, ["item 3", "item 2", "item 1"]);
}

#[test]
fn identical_push_does_not_duplicate() {
    let s = start();
    s.push("same");
    s.advance(5);
    s.push("same");
    assert_eq!(s.history().len(), 1);
}

#[test]
fn history_permissions_and_namespace_isolation() {
    let s = start();
    s.push("secret");
    let id = s.history()[0]["id"].as_str().unwrap().to_owned();
    let item = format!("/api/history/{id}");

    // wrong permission
    assert_eq!(s.call("GET", "/api/history", "wo").0, 401);
    assert_eq!(s.call("GET", "/api/history", "bogus").0, 401);
    assert_eq!(s.call("GET", &item, "wo").0, 401);
    assert_eq!(s.call("DELETE", &item, "ro").0, 401);
    assert_eq!(s.call("DELETE", "/api/history", "ro").0, 401);
    assert_eq!(s.history().len(), 1);

    // the query-string token is not accepted on the new endpoints
    assert_eq!(s.call("GET", "/api/history?token=rw", "").0, 401);
    assert_eq!(s.call("GET", &format!("{item}?token=rw"), "").0, 401);
    assert_eq!(s.call("GET", "/api/capabilities?token=rw", "").0, 401);

    // an id is only reachable through its own namespace
    let other = done(s.req("GET", &item, "other-rw").set("X-Copa-Namespace", "other").call());
    assert_eq!(other.0, 404);
    let wrong_ns_token = done(s.req("GET", &item, "rw").set("X-Copa-Namespace", "other").call());
    assert_eq!(wrong_ns_token.0, 401);
    assert_eq!(s.call("GET", "/api/history/doesnotexist", "rw").0, 404);
}

#[test]
fn delete_one_and_clear() {
    let s = start();
    s.push("a");
    s.advance(1);
    s.push("b");
    let id = s.history()[1]["id"].as_str().unwrap().to_owned();
    assert_eq!(s.call("DELETE", &format!("/api/history/{id}"), "wo").0, 200);
    assert_eq!(s.call("GET", &format!("/api/history/{id}"), "rw").0, 404);
    assert_eq!(s.history().len(), 1);
    assert_eq!(s.json("DELETE", "/api/history", "rw")["deleted"], 1);
    assert!(s.history().is_empty());
    assert_eq!(s.call("GET", "/api/clipboard", "rw"), (200, String::new()));
}

#[test]
fn expired_item_is_gone_before_and_after_reaping() {
    let s = start();
    let mut events = s.ws("/ws/events?token=ro");
    done(s.req("POST", "/api/clipboard", "rw").set("X-Copa-TTL", "5").send_string("brief"));
    let added: Value = serde_json::from_str(&next_text(&mut events).unwrap()).unwrap();
    let id = added["item"]["id"].as_str().unwrap().to_owned();

    s.advance(5);
    // not served even though the reaper has not run yet
    assert_eq!(s.call("GET", &format!("/api/history/{id}"), "rw").0, 404);
    assert!(s.history().is_empty());

    s.reap();
    let removed: Value = serde_json::from_str(&next_text(&mut events).unwrap()).unwrap();
    assert_eq!(removed, json!({ "type": "item_removed", "id": id, "reason": "expired" }));
    assert!(s.state.namespaces["default"].history().referenced_keys().is_empty());
}

// ── WebSockets ────────────────────────────────────────────────────────────────

#[test]
fn events_stream_reports_add_and_delete_while_ws_gets_text_only() {
    let s = start();
    let mut text_ws = s.ws("/ws?token=ro");
    let mut events = s.ws("/ws/events?token=ro");
    assert_eq!(next_text(&mut text_ws).as_deref(), Some("")); // current (empty) content on connect

    s.push("hello");
    assert_eq!(next_text(&mut text_ws).as_deref(), Some("hello"));
    let added: Value = serde_json::from_str(&next_text(&mut events).unwrap()).unwrap();
    assert_eq!(added["type"], "item_added");
    assert_eq!(added["item"]["kind"], "text");
    assert_eq!(added["item"]["preview"], "hello");
    let id = added["item"]["id"].as_str().unwrap().to_owned();

    assert_eq!(s.call("DELETE", &format!("/api/history/{id}"), "rw").0, 200);
    let removed: Value = serde_json::from_str(&next_text(&mut events).unwrap()).unwrap();
    assert_eq!(removed, json!({ "type": "item_removed", "id": id, "reason": "deleted" }));

    // the plain-text socket saw exactly one frame for all of that
    assert_eq!(next_text(&mut text_ws), None);
}

#[test]
fn events_stream_requires_read_permission_and_ignores_input() {
    let s = start();
    assert!(tungstenite::connect(format!("{}/ws/events?token=wo", s.url.replace("http", "ws"))).is_err());
    assert!(tungstenite::connect(format!("{}/ws/events", s.url.replace("http", "ws"))).is_err());

    let mut events = s.ws("/ws/events?token=rw");
    events.send(tungstenite::Message::Text("injected".into())).unwrap();
    assert_eq!(next_text(&mut events), None);
    assert!(s.history().is_empty());
}

#[test]
fn ws_write_adds_history_item() {
    let s = start();
    let mut ws = s.ws("/ws?token=rw");
    assert_eq!(next_text(&mut ws).as_deref(), Some(""));
    ws.send(tungstenite::Message::Text("typed".into())).unwrap();
    assert_eq!(next_text(&mut ws).as_deref(), Some("typed"));
    assert_eq!(s.history()[0]["preview"], "typed");
}

// ── Capabilities, CORS ────────────────────────────────────────────────────────

#[test]
fn capabilities_without_storage() {
    let s = start();
    let caps = s.json("GET", "/api/capabilities", "ro");
    assert_eq!(caps["history"], true);
    assert_eq!(caps["history_limit"], 3);
    assert_eq!(caps["item_ttl_secs"], 3600);
    assert_eq!(caps["files"], false);
    assert!(caps.get("max_file_size").is_none());
    assert_eq!((caps["read"].clone(), caps["write"].clone()), (json!(true), json!(false)));
    assert_eq!(s.call("GET", "/api/capabilities", "").0, 401);

    let (code, body) = s.send("POST", "/api/files", "rw", r#"{"name":"a","size":1}"#);
    assert_eq!((code, body.as_str()), (404, r#"{"error":"files not enabled"}"#));
}

#[test]
fn default_limits_match_documentation() {
    let s = start_with("[server.namespaces.default]\nrw_token = \"rw\"\n", true);
    let caps = s.json("GET", "/api/capabilities", "rw");
    assert_eq!(caps["history_limit"], 20);
    assert_eq!(caps["item_ttl_secs"], 86_400);
    assert_eq!(caps["size_limit"], 16_384);
    assert_eq!(caps["files"], true);
    assert_eq!(caps["max_file_size"], 52_428_800);
    assert_eq!(caps["file_quota_bytes"], 524_288_000);
    assert_eq!(caps["presign_ttl_secs"], 300);
}

#[test]
fn cors_is_open_by_default_and_restricted_when_configured() {
    let origin_header = |s: &TestServer, origin: &str| {
        s.req("GET", "/api/clipboard", "rw")
            .set("Origin", origin)
            .call()
            .unwrap()
            .header("access-control-allow-origin")
            .map(str::to_owned)
    };
    let open = start();
    assert_eq!(origin_header(&open, "https://anything.example").as_deref(), Some("*"));

    let cfg = format!("[server]\nallowed_origins = [\"https://copa.example.com\"]\n{CONFIG}");
    let strict = start_with(&cfg, false);
    assert_eq!(origin_header(&strict, "https://copa.example.com").as_deref(), Some("https://copa.example.com"));
    assert_eq!(origin_header(&strict, "https://evil.example"), None);
}

// ── Files ─────────────────────────────────────────────────────────────────────

#[test]
fn file_upload_flow_makes_item_visible_only_after_complete() {
    let s = start_with(CONFIG, true);
    s.push("text stays current");
    let mut text_ws = s.ws("/ws?token=ro");
    let mut events = s.ws("/ws/events?token=ro");
    assert_eq!(next_text(&mut text_ws).as_deref(), Some("text stays current"));

    let grant = s.request_upload("../../etc/report.pdf", 100);
    assert_eq!(grant["method"], "PUT");
    assert_eq!(grant["headers"]["Content-Length"], "100");
    assert_eq!(grant["headers"]["Content-Type"], "application/octet-stream");
    assert!(grant["headers"]["Content-Disposition"].as_str().unwrap().starts_with("attachment;"));
    let upload_url = grant["upload_url"].as_str().unwrap();
    assert!(upload_url.contains("/bucket/copa/default/") && !upload_url.contains("report"));
    assert_eq!(grant["expires_at"].as_u64().unwrap(), s.clock.load(Ordering::SeqCst) + 300_000);
    let id = grant["id"].as_str().unwrap();
    assert_eq!(s.history().len(), 1, "pending upload must be invisible");

    ureq::put(upload_url).send_bytes(&[1u8; 100]).unwrap();
    assert_eq!(s.history().len(), 1, "uploaded but not completed must be invisible");

    let meta = s.json("POST", &format!("/api/files/{id}/complete"), "wo");
    assert_eq!(meta["kind"], "file");
    assert_eq!(meta["name"], "report.pdf");
    assert_eq!(meta["size"], 100);

    let items = s.history();
    assert_eq!(items[0]["id"], id);
    assert_eq!(items[0]["content_type"], "application/octet-stream");
    assert!(!serde_json::to_string(&items).unwrap().contains("X-Amz-Signature"));

    let added: Value = serde_json::from_str(&next_text(&mut events).unwrap()).unwrap();
    assert_eq!((added["type"].as_str(), added["item"]["name"].as_str()), (Some("item_added"), Some("report.pdf")));

    // text clients are not disturbed by the file item
    assert_eq!(s.call("GET", "/api/clipboard", "rw").1, "text stays current");
    assert_eq!(next_text(&mut text_ws), None);

    // a file id on the text endpoint points at the file endpoint
    assert_eq!(s.call("GET", &format!("/api/history/{id}"), "rw").0, 409);
    // completing twice is not possible
    assert_eq!(s.call("POST", &format!("/api/files/{id}/complete"), "rw").0, 404);
}

#[test]
fn file_endpoint_auth() {
    let s = start_with(CONFIG, true);
    let body = r#"{"name":"a.bin","size":10}"#;
    assert_eq!(s.send("POST", "/api/files", "ro", body).0, 401);
    assert_eq!(s.send("POST", "/api/files", "", body).0, 401);
    assert_eq!(s.send("POST", "/api/files?token=rw", "", body).0, 401);

    let id = s.upload("a.bin", 10);
    assert_eq!(s.call("GET", &format!("/api/files/{id}"), "wo").0, 401);
    assert_eq!(s.call("GET", &format!("/api/files/{id}?token=rw"), "").0, 401);
    assert_eq!(s.call("GET", &format!("/api/files/{id}"), "ro").0, 200);
    assert_eq!(s.call("POST", &format!("/api/files/{id}/complete"), "ro").0, 401);
}

#[test]
fn file_size_and_quota_limits() {
    let s = start_with(CONFIG, true);
    let ask = |size: u64| s.send("POST", "/api/files", "rw", &json!({ "name": "f", "size": size }).to_string()).0;
    assert_eq!(ask(0), 400);
    assert_eq!(ask(1001), 413);
    assert_eq!(s.send("POST", "/api/files", "rw", "not json").0, 400);

    s.upload("a", 1000);
    assert_eq!(ask(501), 507, "stored bytes count against the quota");
    assert_eq!(ask(400), 200);
    assert_eq!(ask(101), 507, "pending bytes count against the quota");
    assert_eq!(ask(100), 200);
}

#[test]
fn complete_without_upload_or_with_wrong_size_is_rejected() {
    let s = start_with(CONFIG, true);
    let grant = s.request_upload("a", 100);
    let id = grant["id"].as_str().unwrap();
    assert_eq!(s.call("POST", &format!("/api/files/{id}/complete"), "rw").0, 409);
    assert!(s.history().is_empty());
    assert_eq!(s.call("POST", &format!("/api/files/{id}/complete"), "rw").0, 404, "pending upload is discarded");

    let grant = s.request_upload("b", 100);
    let id = grant["id"].as_str().unwrap();
    ureq::put(grant["upload_url"].as_str().unwrap()).send_bytes(&[1u8; 50]).unwrap();
    assert_eq!(s.call("POST", &format!("/api/files/{id}/complete"), "rw").0, 409);
    assert!(s.history().is_empty());
    assert_eq!(s.object_count(), 0, "mismatching object is deleted");
    assert_eq!(s.call("POST", "/api/files/unknown/complete", "rw").0, 404);
}

#[test]
fn download_url_is_issued_and_never_outlives_the_item() {
    let s = start_with(CONFIG, true);
    let grant = s.request_upload("doc.txt", 10);
    let (code, _) = done(
        s.req("POST", "/api/files", "rw")
            .set("X-Copa-TTL", "400")
            .send_string(&json!({ "name": "doc.txt", "size": 10, "content_type": "text/plain" }).to_string()),
    );
    assert_eq!(code, 200);
    drop(grant);

    let id = s.upload("doc.txt", 10);
    let now = s.clock.load(Ordering::SeqCst);
    let dl = s.json("GET", &format!("/api/files/{id}"), "ro");
    assert_eq!(dl["name"], "doc.txt");
    assert_eq!(dl["size"], 10);
    assert!(dl["download_url"].as_str().unwrap().contains("X-Amz-Expires=300&"));
    assert_eq!(dl["expires_at"].as_u64().unwrap(), now + 300_000);

    s.advance(3600 - 30);
    let dl = s.json("GET", &format!("/api/files/{id}"), "ro");
    assert!(dl["download_url"].as_str().unwrap().contains("X-Amz-Expires=30&"));

    s.advance(30);
    assert_eq!(s.call("GET", &format!("/api/files/{id}"), "ro").0, 404);

    s.push("text");
    let text_id = s.history()[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(s.call("GET", &format!("/api/files/{text_id}"), "ro").0, 409);
}

#[test]
fn requested_ttl_applies_to_file_items() {
    let s = start_with(CONFIG, true);
    let (_, body) = s.send("POST", "/api/files", "rw", &json!({ "name": "f", "size": 5, "ttl_secs": 60 }).to_string());
    let grant: Value = serde_json::from_str(&body).unwrap();
    ureq::put(grant["upload_url"].as_str().unwrap()).send_bytes(&[0u8; 5]).unwrap();
    let meta = s.json("POST", &format!("/api/files/{}/complete", grant["id"].as_str().unwrap()), "rw");
    assert_eq!(meta["expires_at"].as_u64().unwrap() - meta["created_at"].as_u64().unwrap(), 60_000);
}

#[test]
fn namespace_can_opt_out_of_files() {
    let s = start_with(CONFIG, true);
    let other = |method: &str, path: &str| {
        done(s.req(method, path, "other-rw").set("X-Copa-Namespace", "other").send_string(r#"{"name":"a","size":1}"#))
    };
    assert_eq!(other("POST", "/api/files"), (404, r#"{"error":"files not enabled"}"#.into()));
    assert_eq!(other("POST", "/api/files/x/complete").0, 404);
    let caps: Value =
        serde_json::from_str(&done(s.req("GET", "/api/capabilities", "other-rw").set("X-Copa-Namespace", "other").call()).1)
            .unwrap();
    assert_eq!(caps["files"], false);
    assert_eq!(s.json("GET", "/api/capabilities", "rw")["files"], true);
}

#[test]
fn objects_are_deleted_on_delete_clear_eviction_and_expiry() {
    let s = start_with(CONFIG, true);

    // explicit delete
    let id = s.upload("a", 10);
    assert_eq!(s.object_count(), 1);
    assert_eq!(s.call("DELETE", &format!("/api/history/{id}"), "rw").0, 200);
    s.wait_for_objects(0);

    // clear
    s.upload("b", 10);
    s.upload("c", 10);
    assert_eq!(s.json("DELETE", "/api/history", "rw")["deleted"], 2);
    s.wait_for_objects(0);

    // eviction by history_limit (3)
    s.upload("d", 10);
    for n in 0..3 {
        s.advance(1);
        s.push(&format!("text {n}"));
    }
    s.wait_for_objects(0);

    // expiry
    let id = s.upload("e", 10);
    s.advance(3600);
    assert_eq!(s.call("GET", &format!("/api/files/{id}"), "rw").0, 404);
    s.reap();
    assert_eq!(s.object_count(), 0);
}

#[test]
fn abandoned_upload_is_discarded_with_its_object() {
    let s = start_with(CONFIG, true);
    let grant = s.request_upload("a", 1000);
    ureq::put(grant["upload_url"].as_str().unwrap()).send_bytes(&[0u8; 1000]).unwrap();
    assert_eq!(s.object_count(), 1);
    assert_eq!(s.send("POST", "/api/files", "rw", r#"{"name":"b","size":600}"#).0, 507);

    s.advance(300 + 60);
    let id = grant["id"].as_str().unwrap();
    assert_eq!(s.call("POST", &format!("/api/files/{id}/complete"), "rw").0, 404);
    assert_eq!(s.send("POST", "/api/files", "rw", r#"{"name":"b","size":600}"#).0, 200, "quota is freed");
    s.reap();
    assert_eq!(s.object_count(), 0);
}

#[test]
fn reconcile_removes_orphans_but_keeps_referenced_objects() {
    let s = start_with(CONFIG, true);
    let kept = s.upload("keep", 10);
    let pending = s.request_upload("pending", 10);
    ureq::put(pending["upload_url"].as_str().unwrap()).send_bytes(&[0u8; 10]).unwrap();
    s.objects.lock().unwrap().insert("copa/default/leftover-from-previous-run".into(), 5);
    assert_eq!(s.object_count(), 3);

    assert_eq!(s.rt.block_on(reaper::reconcile(&s.state)), Ok(1));
    let keys: Vec<String> = s.objects.lock().unwrap().keys().cloned().collect();
    assert_eq!(keys.len(), 2);
    assert!(keys.contains(&format!("copa/default/{kept}")));
    assert!(!keys.iter().any(|k| k.contains("leftover")));
}
