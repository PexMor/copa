//! Authorization sources of copasrv against a real listener: static tokens,
//! device tokens (pairing), and — added later — tokens from trusted issuers.
use copa::server::{
    config::ConfigFile,
    serve,
    state::{build_app_state, AppState},
    token::Claims,
};
use std::{
    net::TcpStream,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio_tungstenite::tungstenite::{self, stream::MaybeTlsStream, WebSocket};

const NOW: u64 = 1_800_000_000_000;

struct Server {
    url:   String,
    clock: Arc<AtomicU64>,
    state: Arc<AppState>,
    _dir:  tempfile::TempDir,
    _rt:   tokio::runtime::Runtime,
}

fn start(pairing: bool) -> Server {
    let dir = tempfile::tempdir().unwrap();
    let config = format!(
        r#"
[server.namespaces.default]
rw_token = "rw"
[server.namespaces.team]
read_token = "team-ro"
[server.namespaces.other]
rw_token = "other-rw"
{}"#,
        if pairing { format!("[server.pairing]\nenabled = true\nstate_dir = {:?}\n", dir.path()) } else { String::new() }
    );
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let cfg: ConfigFile = toml::from_str(&config).unwrap();
    let clock = Arc::new(AtomicU64::new(NOW));
    let c = clock.clone();
    let state = build_app_state(&cfg.server, None, Arc::new(move || c.load(Ordering::SeqCst)), 0, "127.0.0.1").unwrap();
    let listener = rt.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let s = state.clone();
    rt.spawn(async move { serve(listener, s, None).await.unwrap() });
    Server { url, clock, state, _dir: dir, _rt: rt }
}

impl Server {
    fn device(&self, dev: &str, ns: &str, acc: &str, ttl_ms: u64) -> String {
        self.state
            .tokens
            .as_ref()
            .expect("pairing enabled")
            .issue(&Claims { dev: dev.into(), ns: ns.into(), acc: acc.into(), iat: NOW, exp: NOW + ttl_ms, name: None })
    }

    fn call(&self, method: &str, path: &str, token: &str, ns: &str, body: Option<&str>) -> (u16, String) {
        let mut req = ureq::request(method, &format!("{}{path}", self.url)).set("X-Copa-Namespace", ns);
        if !token.is_empty() {
            req = req.set("Authorization", &format!("Bearer {token}"));
        }
        let res = match body {
            Some(b) => req.send_string(b),
            None => req.call(),
        };
        match res {
            Ok(r) => (r.status(), r.into_string().unwrap_or_default()),
            Err(ureq::Error::Status(c, r)) => (c, r.into_string().unwrap_or_default()),
            Err(e) => panic!("{e}"),
        }
    }

    fn get(&self, path: &str, token: &str, ns: &str) -> (u16, String) {
        self.call("GET", path, token, ns, None)
    }

    fn post_clip(&self, token: &str, ns: &str, text: &str) -> u16 {
        self.call("POST", "/api/clipboard", token, ns, Some(text)).0
    }

    fn advance(&self, ms: u64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    fn ws(&self, path: &str) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, tungstenite::Error> {
        let (socket, _) = tungstenite::connect(format!("{}{path}", self.url.replace("http", "ws")))?;
        if let MaybeTlsStream::Plain(s) = socket.get_ref() {
            s.set_read_timeout(Some(Duration::from_millis(1500))).unwrap();
        }
        Ok(socket)
    }
}

fn caps(s: &Server, token: &str, ns: &str) -> serde_json::Value {
    let (code, body) = s.get("/api/capabilities", token, ns);
    assert_eq!(code, 200, "{body}");
    serde_json::from_str(&body).unwrap()
}

// ── static tokens are unchanged ───────────────────────────────────────────────

#[test]
fn static_tokens_work_with_and_without_pairing() {
    for pairing in [false, true] {
        let s = start(pairing);
        assert_eq!(s.post_clip("rw", "default", "hi"), 200, "pairing={pairing}");
        assert_eq!(s.get("/api/clipboard", "rw", "default").1, "hi");
        assert_eq!(s.get("/api/clipboard", "wrong", "default").0, 401);
        assert_eq!(s.get("/api/clipboard", "", "default").0, 401);
    }
}

#[test]
fn without_pairing_a_v1_token_grants_nothing() {
    let s = start(false);
    assert!(s.state.tokens.is_none());
    assert_eq!(s.get("/api/clipboard", "v1.e30.AAAA", "default").0, 401);
}

// ── device tokens ─────────────────────────────────────────────────────────────

#[test]
fn a_read_write_device_token_authorizes_like_a_static_one() {
    let s = start(true);
    let t = s.device("laptop", "default", "rw", 60_000);
    assert_eq!(s.post_clip(&t, "default", "from device"), 200);
    assert_eq!(s.get("/api/clipboard", &t, "default"), (200, "from device".into()));
    assert_eq!(s.get("/api/history", &t, "default").0, 200);
    let c = caps(&s, &t, "default");
    assert_eq!((c["read"].as_bool(), c["write"].as_bool()), (Some(true), Some(true)));
}

#[test]
fn a_read_only_device_token_cannot_write() {
    let s = start(true);
    assert_eq!(s.post_clip("rw", "default", "seed"), 200);
    let t = s.device("phone", "default", "r", 60_000);
    assert_eq!(s.get("/api/clipboard", &t, "default"), (200, "seed".into()));
    assert_eq!(s.post_clip(&t, "default", "nope"), 401);
    assert_eq!(s.call("DELETE", "/api/history", &t, "default", None).0, 401);
    let c = caps(&s, &t, "default");
    assert_eq!((c["read"].as_bool(), c["write"].as_bool()), (Some(true), Some(false)));
}

#[test]
fn a_write_only_device_token_cannot_read() {
    let s = start(true);
    let t = s.device("sensor", "default", "w", 60_000);
    assert_eq!(s.post_clip(&t, "default", "reading"), 200);
    assert_eq!(s.get("/api/clipboard", &t, "default").0, 401);
    assert_eq!(s.get("/api/history", &t, "default").0, 401);
}

#[test]
fn a_device_token_is_bound_to_its_namespace() {
    let s = start(true);
    let t = s.device("laptop", "default", "rw", 60_000);
    for ns in ["other", "team"] {
        assert_eq!(s.get("/api/clipboard", &t, ns).0, 401, "{ns}");
        assert_eq!(s.post_clip(&t, ns, "x"), 401, "{ns}");
    }
    assert_eq!(s.get("/api/clipboard", &t, "missing").0, 404);
}

#[test]
fn an_expired_device_token_is_refused() {
    let s = start(true);
    let t = s.device("laptop", "default", "rw", 60_000);
    s.advance(59_999);
    assert_eq!(s.get("/api/clipboard", &t, "default").0, 200);
    s.advance(1);
    assert_eq!(s.get("/api/clipboard", &t, "default").0, 401);
}

#[test]
fn revoking_one_device_leaves_the_others() {
    let s = start(true);
    let (a, b) = (s.device("a", "default", "rw", 60_000), s.device("b", "default", "rw", 60_000));
    s.state.tokens.as_ref().unwrap().revoke("a").unwrap();
    assert_eq!(s.get("/api/clipboard", &a, "default").0, 401);
    assert_eq!(s.get("/api/clipboard", &b, "default").0, 200);
}

#[test]
fn forged_and_garbled_v1_tokens_are_refused() {
    let s = start(true);
    let t = s.device("laptop", "default", "r", 60_000);
    let mut forged: Vec<&str> = t.split('.').collect();
    forged[1] = "eyJkZXYiOiJ4IiwibnMiOiJkZWZhdWx0IiwiYWNjIjoicnciLCJpYXQiOjAsImV4cCI6OTk5OTk5OTk5OTk5OTl9";
    for bad in [forged.join("."), "v1.".into(), "v1..".into(), "v1.a.b.c".into(), format!("{t}x")] {
        assert_eq!(s.get("/api/clipboard", &bad, "default").0, 401, "{bad}");
    }
}

#[test]
fn the_legacy_query_token_path_accepts_device_tokens_too() {
    let s = start(true);
    let t = s.device("laptop", "default", "r", 60_000);
    let (code, _) = s.get(&format!("/api/clipboard?token={t}"), "", "default");
    assert_eq!(code, 200);
}

#[test]
fn the_event_stream_accepts_a_readable_device_token_and_refuses_a_write_only_one() {
    let s = start(true);
    let ok = s.device("a", "default", "r", 60_000);
    assert!(s.ws(&format!("/ws/events?namespace=default&token={ok}")).is_ok());
    let wo = s.device("b", "default", "w", 60_000);
    assert!(s.ws(&format!("/ws/events?namespace=default&token={wo}")).is_err());
}

#[test]
fn device_tokens_do_not_unlock_static_only_paths_of_other_namespaces() {
    let s = start(true);
    let t = s.device("a", "other", "rw", 60_000);
    assert_eq!(s.post_clip(&t, "other", "ok"), 200);
    assert_eq!(s.post_clip(&t, "default", "no"), 401);
}

// ── event-stream tickets ──────────────────────────────────────────────────────

fn ticket(s: &Server, token: &str, ns: &str) -> (u16, String) {
    let (code, body) = s.call("POST", "/api/events/ticket", token, ns, Some(""));
    if code != 200 {
        return (code, body);
    }
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    (code, v["ticket"].as_str().unwrap().to_owned())
}

fn set_timeout(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>, ms: u64) {
    if let MaybeTlsStream::Plain(s) = socket.get_ref() {
        s.set_read_timeout(Some(Duration::from_millis(ms))).unwrap();
    }
}

fn is_closed(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>) -> bool {
    loop {
        match socket.read() {
            Ok(tungstenite::Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed) => return true,
            Ok(_) => continue,
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                return false
            }
            Err(_) => return true,
        }
    }
}

#[test]
fn a_ticket_opens_the_stream_once() {
    let s = start(false);
    let (code, t) = ticket(&s, "rw", "default");
    assert_eq!(code, 200);
    assert!(s.ws(&format!("/ws/events?namespace=default&ticket={t}")).is_ok());
    assert!(s.ws(&format!("/ws/events?namespace=default&ticket={t}")).is_err(), "second use must fail");
}

#[test]
fn tickets_are_unique_and_unguessable_looking() {
    let s = start(false);
    let a = ticket(&s, "rw", "default").1;
    let b = ticket(&s, "rw", "default").1;
    assert_ne!(a, b);
    assert!(a.len() >= 48 && a.chars().all(|c| c.is_ascii_hexdigit()), "{a}");
}

#[test]
fn a_ticket_expires_after_30_seconds() {
    let s = start(false);
    let (_, fresh) = ticket(&s, "rw", "default");
    let (_, stale) = ticket(&s, "rw", "default");
    s.advance(29_999);
    assert!(s.ws(&format!("/ws/events?namespace=default&ticket={fresh}")).is_ok());
    s.advance(1);
    assert!(s.ws(&format!("/ws/events?namespace=default&ticket={stale}")).is_err());
}

#[test]
fn the_ticket_response_states_its_expiry() {
    let s = start(false);
    let (code, body) = s.call("POST", "/api/events/ticket", "rw", "default", Some(""));
    assert_eq!(code, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["expires_at"].as_u64(), Some(NOW + 30_000));
}

#[test]
fn credentials_that_cannot_read_get_no_ticket() {
    let s = start(true);
    assert_eq!(ticket(&s, "", "default").0, 401);
    assert_eq!(ticket(&s, "nope", "default").0, 401);
    let wo = s.device("sensor", "default", "w", 60_000);
    assert_eq!(ticket(&s, &wo, "default").0, 401);
    // a namespace that only has a read token works with it
    assert_eq!(ticket(&s, "team-ro", "team").0, 200);
}

#[test]
fn a_ticket_is_bound_to_its_namespace_and_spent_when_misused() {
    let s = start(false);
    let (_, t) = ticket(&s, "rw", "default");
    assert!(s.ws(&format!("/ws/events?namespace=other&ticket={t}")).is_err());
    assert!(s.ws(&format!("/ws/events?namespace=default&ticket={t}")).is_err(), "the misused ticket is gone");
}

#[test]
fn unknown_tickets_are_refused() {
    let s = start(false);
    assert!(s.ws("/ws/events?namespace=default&ticket=deadbeef").is_err());
}

#[test]
fn a_ticket_is_not_a_bearer_token() {
    let s = start(false);
    let (_, t) = ticket(&s, "rw", "default");
    assert_eq!(s.get("/api/clipboard", &t, "default").0, 401);
    assert_eq!(s.get(&format!("/api/clipboard?token={t}"), "", "default").0, 401);
}

#[test]
fn a_ticket_stream_delivers_events() {
    let s = start(false);
    let (_, t) = ticket(&s, "rw", "default");
    let mut ws = s.ws(&format!("/ws/events?namespace=default&ticket={t}")).unwrap();
    assert_eq!(s.post_clip("rw", "default", "live"), 200);
    let frame = ws.read().unwrap().into_text().unwrap();
    let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(v["type"], "item_added");
}

#[test]
fn the_stream_ends_when_the_device_credential_expires() {
    let s = start(true);
    let t = s.device("laptop", "default", "r", 400); // valid for 400 ms
    let (code, tk) = ticket(&s, &t, "default");
    assert_eq!(code, 200);
    let mut ws = s.ws(&format!("/ws/events?namespace=default&ticket={tk}")).unwrap();
    set_timeout(&mut ws, 100);
    assert!(!is_closed(&mut ws), "open while the credential is valid");
    set_timeout(&mut ws, 1500);
    std::thread::sleep(Duration::from_millis(500));
    assert!(is_closed(&mut ws), "closed after the credential expired");
}

#[test]
fn the_token_query_path_also_ends_at_expiry() {
    let s = start(true);
    let t = s.device("laptop", "default", "r", 300);
    let mut ws = s.ws(&format!("/ws/events?namespace=default&token={t}")).unwrap();
    std::thread::sleep(Duration::from_millis(450));
    assert!(is_closed(&mut ws));
}

#[test]
fn static_token_streams_do_not_expire() {
    let s = start(false);
    let (_, t) = ticket(&s, "rw", "default");
    let mut ws = s.ws(&format!("/ws/events?namespace=default&ticket={t}")).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    set_timeout(&mut ws, 100);
    assert!(!is_closed(&mut ws));
}
