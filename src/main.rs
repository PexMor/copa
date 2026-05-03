/// copasrv — clipboard-over-HTTP server with namespace support and WebSocket push
use copa::{config_path, gen_token, load_config_file};
use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::{collections::HashMap, net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::sync::{broadcast, RwLock};
use tower_http::cors::{Any, CorsLayer};

// ── Config ────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default, Debug, Clone)]
struct NamespaceConfig {
    size_limit:  Option<usize>,
    read_token:  Option<String>,
    write_token: Option<String>,
    rw_token:    Option<String>,
}

#[derive(Deserialize, Default, Debug)]
struct ServerConfig {
    port: Option<u16>,
    bind: Option<String>,
    /// Legacy single-token: treated as rw_token for the "default" namespace.
    token: Option<String>,
    #[serde(default)]
    namespaces: HashMap<String, NamespaceConfig>,
}

#[derive(Deserialize, Default, Debug)]
struct ConfigFile {
    #[serde(default)]
    server: ServerConfig,
}

fn load_config() -> ConfigFile {
    load_config_file::<ConfigFile>(&config_path())
}

// ── AppState ──────────────────────────────────────────────────────────────────

const DEFAULT_SIZE_LIMIT: usize = 16_384;
const BROADCAST_CAP: usize = 64;
const NS_HEADER: &str = "x-copa-namespace";

struct NamespaceState {
    content:     RwLock<Vec<u8>>,
    size_limit:  usize,
    read_token:  Option<String>,
    write_token: Option<String>,
    rw_token:    Option<String>,
    tx:          broadcast::Sender<Vec<u8>>,
}

impl NamespaceState {
    fn new(cfg: &NamespaceConfig) -> Self {
        let (tx, _) = broadcast::channel(BROADCAST_CAP);
        Self {
            content:     RwLock::new(Vec::new()),
            size_limit:  cfg.size_limit.unwrap_or(DEFAULT_SIZE_LIMIT),
            read_token:  cfg.read_token.clone(),
            write_token: cfg.write_token.clone(),
            rw_token:    cfg.rw_token.clone(),
            tx,
        }
    }
}

struct AppState {
    namespaces: HashMap<String, Arc<NamespaceState>>,
}

fn build_app_state(srv: &ServerConfig, port: u16, bind: &str) -> Arc<AppState> {
    let mut namespaces: HashMap<String, Arc<NamespaceState>> = HashMap::new();

    if !srv.namespaces.is_empty() {
        for (name, cfg) in &srv.namespaces {
            if cfg.read_token.is_none() && cfg.write_token.is_none() && cfg.rw_token.is_none() {
                eprintln!("warning: namespace '{name}' has no tokens — it will be inaccessible");
            }
            namespaces.insert(name.clone(), Arc::new(NamespaceState::new(cfg)));
        }
    } else {
        // Legacy path: promote server.token → default namespace rw_token
        let rw = srv.token.clone().unwrap_or_else(|| {
            let t = gen_token();
            eprintln!("token: {t}");
            eprintln!("hint: save to {} under [server.namespaces.default]", config_path().display());
            t
        });
        namespaces.insert(
            "default".to_owned(),
            Arc::new(NamespaceState::new(&NamespaceConfig {
                size_limit: None,
                read_token: None,
                write_token: None,
                rw_token: Some(rw.clone()),
            })),
        );
        eprintln!("URL:  http://{}:{}/#token={rw}", bind, port);
    }

    // Always ensure "default" exists
    namespaces.entry("default".to_owned()).or_insert_with(|| {
        let t = gen_token();
        eprintln!("auto-generated default namespace token: {t}");
        Arc::new(NamespaceState::new(&NamespaceConfig {
            size_limit: None,
            read_token: None,
            write_token: None,
            rw_token: Some(t),
        }))
    });

    Arc::new(AppState { namespaces })
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

fn extract_bearer(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
}

fn extract_ns_name<'a>(headers: &'a HeaderMap, params: &'a HashMap<String, String>) -> &'a str {
    headers
        .get(NS_HEADER)
        .and_then(|v| v.to_str().ok())
        .or_else(|| params.get("namespace").map(String::as_str))
        .unwrap_or("default")
}

fn can_read(ns: &NamespaceState, tok: &str) -> bool {
    ns.rw_token.as_deref() == Some(tok) || ns.read_token.as_deref() == Some(tok)
}

fn can_write(ns: &NamespaceState, tok: &str) -> bool {
    ns.rw_token.as_deref() == Some(tok) || ns.write_token.as_deref() == Some(tok)
}

// ── REST handlers ─────────────────────────────────────────────────────────────

async fn handle_get(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let ns_name = extract_ns_name(&headers, &params).to_owned();
    let Some(ns) = state.namespaces.get(&ns_name).cloned() else {
        return (StatusCode::NOT_FOUND, "namespace not found").into_response();
    };
    let tok = extract_bearer(&headers).to_owned();
    let tok_q = params.get("token").map(String::as_str).unwrap_or("");
    if !can_read(&ns, &tok) && !can_read(&ns, tok_q) {
        eprintln!("GET /api/clipboard ns={ns_name} 401");
        return (StatusCode::UNAUTHORIZED, r#"{"error":"unauthorized"}"#).into_response();
    }
    let content = ns.content.read().await.clone();
    eprintln!("GET /api/clipboard ns={ns_name} {} bytes", content.len());
    (StatusCode::OK, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], content).into_response()
}

async fn handle_post(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let ns_name = extract_ns_name(&headers, &params).to_owned();
    let Some(ns) = state.namespaces.get(&ns_name).cloned() else {
        return (StatusCode::NOT_FOUND, "namespace not found").into_response();
    };
    let tok = extract_bearer(&headers).to_owned();
    let tok_q = params.get("token").map(String::as_str).unwrap_or("");
    if !can_write(&ns, &tok) && !can_write(&ns, tok_q) {
        eprintln!("POST /api/clipboard ns={ns_name} 401");
        return (StatusCode::UNAUTHORIZED, r#"{"error":"unauthorized"}"#).into_response();
    }
    if body.len() > ns.size_limit {
        eprintln!("POST /api/clipboard ns={ns_name} 413 {} > {}", body.len(), ns.size_limit);
        return (StatusCode::PAYLOAD_TOO_LARGE, r#"{"error":"content too large"}"#).into_response();
    }
    let bytes = body.to_vec();
    let _ = ns.tx.send(bytes.clone());
    *ns.content.write().await = bytes;
    eprintln!("POST /api/clipboard ns={ns_name} {} bytes", body.len());
    (StatusCode::OK, "ok").into_response()
}

// ── WebSocket handler ─────────────────────────────────────────────────────────

async fn handle_ws_upgrade(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let ns_name = extract_ns_name(&headers, &params).to_owned();
    let Some(ns) = state.namespaces.get(&ns_name).cloned() else {
        return (StatusCode::NOT_FOUND, "namespace not found").into_response();
    };

    let tok = extract_bearer(&headers).to_owned();
    let tok_q = params.get("token").cloned().unwrap_or_default();
    let effective = if !tok.is_empty() { &tok } else { &tok_q };

    let read_ok  = can_read(&ns, effective);
    let write_ok = can_write(&ns, effective);

    if !read_ok && !write_ok {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }

    eprintln!("WS /ws ns={ns_name} read={read_ok} write={write_ok}");
    ws.on_upgrade(move |socket| ws_session(socket, ns, read_ok, write_ok))
        .into_response()
}

async fn ws_session(socket: WebSocket, ns: Arc<NamespaceState>, read_ok: bool, write_ok: bool) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = ns.tx.subscribe();

    // Send current content immediately on connect
    if read_ok {
        let current = ns.content.read().await.clone();
        let _ = sender.send(Message::Text(String::from_utf8_lossy(&current).into_owned())).await;
    }

    let ns_w = ns.clone();
    let inbound = async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) if write_ok => {
                    let bytes = text.into_bytes();
                    if bytes.len() <= ns_w.size_limit {
                        let _ = ns_w.tx.send(bytes.clone());
                        *ns_w.content.write().await = bytes;
                    }
                }
                Message::Binary(data) if write_ok => {
                    if data.len() <= ns_w.size_limit {
                        let _ = ns_w.tx.send(data.clone());
                        *ns_w.content.write().await = data;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };

    let outbound = async move {
        if !read_ok {
            return;
        }
        loop {
            match rx.recv().await {
                Ok(data) => {
                    let text = String::from_utf8_lossy(&data).into_owned();
                    if sender.send(Message::Text(text)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    tokio::select! {
        _ = inbound  => {}
        _ = outbound => {}
    }
}

// ── Static assets ─────────────────────────────────────────────────────────────

const HTML: &str = include_str!("../web/ui.html");

const ICON_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="20" fill="#7c6af7"/>
<rect x="16" y="28" width="44" height="54" rx="8" fill="white" fill-opacity="0.28"/>
<rect x="28" y="20" width="44" height="58" rx="8" fill="white"/>
<rect x="40" y="15" width="20" height="11" rx="4" fill="white"/>
<rect x="37" y="36" width="28" height="5" rx="2.5" fill="#7c6af7"/>
<rect x="37" y="47" width="22" height="5" rx="2.5" fill="#7c6af7" opacity="0.55"/>
<rect x="37" y="58" width="25" height="5" rx="2.5" fill="#7c6af7" opacity="0.55"/>
</svg>"##;

const MANIFEST_JSON: &str = r##"{"name":"copa","short_name":"copa","description":"Clipboard over HTTP","start_url":"/","display":"standalone","background_color":"#0f1117","theme_color":"#7c6af7","permissions":["clipboard-read","clipboard-write"],"icons":[{"src":"/icon.svg","type":"image/svg+xml","sizes":"any","purpose":"any maskable"}]}"##;

async fn handler_ui() -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], HTML)
}
async fn handler_icon() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "image/svg+xml"),
         (header::CACHE_CONTROL, "public, max-age=86400")],
        ICON_SVG,
    )
}
async fn handler_manifest() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/manifest+json"),
         (header::CACHE_CONTROL, "public, max-age=86400")],
        MANIFEST_JSON,
    )
}

// ── Server runner ─────────────────────────────────────────────────────────────

async fn run_server(port: u16, bind: String, state: Arc<AppState>) {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_headers(Any)
        .allow_methods(Any);

    let app = Router::new()
        .route("/",              get(handler_ui))
        .route("/icon.svg",      get(handler_icon))
        .route("/manifest.json", get(handler_manifest))
        .route("/api/clipboard", get(handle_get).post(handle_post))
        .route("/ws",            get(handle_ws_upgrade))
        .with_state(state)
        .layer(cors);

    let addr: SocketAddr = format!("{bind}:{port}").parse().expect("bad addr");
    eprintln!("listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind failed");
    axum::serve(listener, app).await.expect("server error");
}

// ── CLI ───────────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(name = "copasrv", about = "copa server — clipboard over HTTP with namespace support")]
struct Cli {
    #[arg(short, long, env = "COPA_CONFIG")]
    config: Option<PathBuf>,
    #[arg(long)]
    print_config_path: bool,
    #[arg(long)]
    generate_token: bool,
    #[arg(short, long, env = "COPA_PORT")]
    port: Option<u16>,
    #[arg(short, long, env = "COPA_BIND")]
    bind: Option<String>,
    /// Legacy: sets the rw_token for the auto-created "default" namespace.
    #[arg(short, long, env = "COPA_TOKEN")]
    token: Option<String>,
}

// ── main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    if cli.print_config_path {
        println!("{}", config_path().display());
        return;
    }
    if cli.generate_token {
        println!("{}", gen_token());
        return;
    }

    let cfg = load_config();
    let port = cli.port.or(cfg.server.port).unwrap_or(8080);
    let bind = cli.bind.or(cfg.server.bind).unwrap_or_else(|| "127.0.0.1".to_string());

    // CLI --token overrides config server.token (legacy path)
    let effective_srv = ServerConfig {
        port: Some(port),
        bind: Some(bind.clone()),
        token: cli.token.or(cfg.server.token),
        namespaces: cfg.server.namespaces,
    };

    let state = build_app_state(&effective_srv, port, &bind);
    run_server(port, bind, state).await;
}
