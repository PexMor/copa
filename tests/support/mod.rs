//! Shared harness for the issuer tests: an in-process copasrv with a controllable
//! clock, a JWKS fixture server, and token signing helpers.
#![allow(dead_code)]
pub mod keys;

use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Json, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use copa::server::{
    config::ConfigFile,
    serve,
    state::{build_app_state, AppState},
};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde_json::{json, Value};
use std::{
    net::TcpStream,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio_tungstenite::tungstenite::{self, stream::MaybeTlsStream, WebSocket};

/// "Now" of the in-process server: unix ms.
pub const NOW: u64 = 1_800_000_000_000;

// ── JWKS fixture ──────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct JwksState {
    pub keys:     Arc<Mutex<Vec<Value>>>,
    pub hits:     Arc<AtomicUsize>,
    pub fail:     Arc<AtomicBool>,
    pub delay_ms: Arc<AtomicU64>,
}

pub struct JwksServer {
    pub url: String,
    pub st:  JwksState,
}

async fn serve_jwks(State(st): State<JwksState>) -> impl IntoResponse {
    st.hits.fetch_add(1, Ordering::SeqCst);
    let delay = st.delay_ms.load(Ordering::SeqCst);
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    if st.fail.load(Ordering::SeqCst) {
        return (StatusCode::INTERNAL_SERVER_ERROR, "down").into_response();
    }
    Json(json!({ "keys": st.keys.lock().unwrap().clone() })).into_response()
}

impl JwksServer {
    pub fn start(rt: &tokio::runtime::Runtime, keys: Vec<Value>) -> Self {
        let st = JwksState {
            keys: Arc::new(Mutex::new(keys)),
            hits: Arc::new(AtomicUsize::new(0)),
            fail: Arc::new(AtomicBool::new(false)),
            delay_ms: Arc::new(AtomicU64::new(0)),
        };
        let listener = rt.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
        let url = format!("http://{}/jwks.json", listener.local_addr().unwrap());
        let app = Router::new().route("/jwks.json", get(serve_jwks)).with_state(st.clone());
        rt.spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { url, st }
    }

    pub fn hits(&self) -> usize {
        self.st.hits.load(Ordering::SeqCst)
    }
    pub fn set_keys(&self, keys: Vec<Value>) {
        *self.st.keys.lock().unwrap() = keys;
    }
    pub fn set_down(&self, down: bool) {
        self.st.fail.store(down, Ordering::SeqCst);
    }
}

pub fn ec_jwk(kid: &str, x: &str, y: &str) -> Value {
    json!({ "kty": "EC", "crv": "P-256", "kid": kid, "use": "sig", "alg": "ES256", "x": x, "y": y })
}

pub fn rsa_jwk(kid: &str, n: &str, e: &str) -> Value {
    json!({ "kty": "RSA", "kid": kid, "use": "sig", "alg": "RS256", "n": n, "e": e })
}

pub fn ec1_jwk() -> Value {
    ec_jwk("ec1", keys::EC1_X, keys::EC1_Y)
}
pub fn ec2_jwk() -> Value {
    ec_jwk("ec2", keys::EC2_X, keys::EC2_Y)
}
pub fn rsa1_jwk() -> Value {
    rsa_jwk("rsa1", keys::RSA1_N, keys::RSA1_E)
}

// ── Token signing ─────────────────────────────────────────────────────────────

pub const ISS: &str = "https://auth.example.com";
pub const AUD: &str = "https://copa.example.com";

pub fn ec1() -> EncodingKey {
    EncodingKey::from_ec_pem(keys::EC1_PEM.as_bytes()).unwrap()
}
pub fn ec2() -> EncodingKey {
    EncodingKey::from_ec_pem(keys::EC2_PEM.as_bytes()).unwrap()
}
pub fn rsa1() -> EncodingKey {
    EncodingKey::from_rsa_pem(keys::RSA1_PEM.as_bytes()).unwrap()
}

/// Claims of a good token valid for `ttl_ms` from NOW.
pub fn claims(scope: &str, ttl_ms: u64) -> Value {
    json!({
        "iss": ISS, "aud": AUD, "sub": "alice", "email": "alice@example.com",
        "groups": ["copa-team"], "scope": scope,
        "iat": NOW / 1000, "nbf": NOW / 1000, "exp": (NOW + ttl_ms) as f64 / 1000.0,
    })
}

pub fn sign(alg: Algorithm, kid: Option<&str>, key: &EncodingKey, claims: &Value) -> String {
    let mut h = Header::new(alg);
    h.kid = kid.map(str::to_owned);
    encode(&h, claims, key).unwrap()
}

pub fn es256(kid: &str, claims: &Value) -> String {
    sign(Algorithm::ES256, Some(kid), &ec1(), claims)
}

/// Hand-assembled token (for `alg: none` and friends).
pub fn raw_token(header: &Value, claims: &Value, signature: &[u8]) -> String {
    format!(
        "{}.{}.{}",
        B64.encode(serde_json::to_vec(header).unwrap()),
        B64.encode(serde_json::to_vec(claims).unwrap()),
        B64.encode(signature)
    )
}

// ── copasrv ───────────────────────────────────────────────────────────────────

pub struct Server {
    pub url:   String,
    pub clock: Arc<AtomicU64>,
    pub state: Arc<AppState>,
    pub jwks:  JwksServer,
    _dir:      tempfile::TempDir,
    pub rt:    tokio::runtime::Runtime,
}

/// `config` may contain `{JWKS}` which is replaced by the fixture's URL.
pub fn start(config: &str, keys: Vec<Value>) -> Server {
    let dir = tempfile::tempdir().unwrap();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(3).enable_all().build().unwrap();
    let jwks = JwksServer::start(&rt, keys);
    let config = config.replace("{JWKS}", &jwks.url).replace("{STATE}", dir.path().to_str().unwrap());
    let cfg: ConfigFile = toml::from_str(&config).unwrap();
    let clock = Arc::new(AtomicU64::new(NOW));
    let c = clock.clone();
    let state = build_app_state(&cfg.server, None, Arc::new(move || c.load(Ordering::SeqCst)), 0, "127.0.0.1").unwrap();
    let listener = rt.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let s = state.clone();
    rt.spawn(async move { serve(listener, s, None).await.unwrap() });
    Server { url, clock, state, jwks, _dir: dir, rt }
}

impl Server {
    pub fn call(&self, method: &str, path: &str, token: &str, ns: &str, body: Option<&str>) -> (u16, String) {
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

    pub fn get(&self, path: &str, token: &str, ns: &str) -> u16 {
        self.call("GET", path, token, ns, None).0
    }

    pub fn push(&self, token: &str, ns: &str, text: &str) -> u16 {
        self.call("POST", "/api/clipboard", token, ns, Some(text)).0
    }

    pub fn advance(&self, ms: u64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn ws(&self, path: &str) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, tungstenite::Error> {
        let (socket, _) = tungstenite::connect(format!("{}{path}", self.url.replace("http", "ws")))?;
        set_timeout(&socket, 1500);
        Ok(socket)
    }
}

pub fn set_timeout(socket: &WebSocket<MaybeTlsStream<TcpStream>>, ms: u64) {
    if let MaybeTlsStream::Plain(s) = socket.get_ref() {
        s.set_read_timeout(Some(Duration::from_millis(ms))).unwrap();
    }
}

pub fn is_closed(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>) -> bool {
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
