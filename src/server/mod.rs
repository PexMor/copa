/// copasrv HTTP/WebSocket server
pub mod access;
pub mod auth;
pub mod clipboard;
pub mod config;
pub mod files;
pub mod history_api;
pub mod issuers;
pub mod jwks;
pub mod pair_api;
pub mod pair_crypto;
pub mod pairing;
pub mod reaper;
pub mod state;
pub mod static_assets;
pub mod token;
pub mod ws;

use axum::{
    http::{header, HeaderValue},
    routing::{get, post},
    Router,
};
use state::AppState;
use std::{path::PathBuf, sync::Arc};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::services::ServeDir;

fn cors_layer(allowed_origins: &Option<Vec<String>>) -> Result<CorsLayer, String> {
    let layer = CorsLayer::new()
        .allow_headers(Any)
        .allow_methods(Any)
        .expose_headers([header::HeaderName::from_static(access::PROBE_HEADER)]);
    match allowed_origins {
        None => Ok(layer.allow_origin(Any)),
        Some(origins) => {
            let parsed = origins
                .iter()
                .map(|o| {
                    o.trim_end_matches('/')
                        .parse::<HeaderValue>()
                        .map_err(|_| format!("allowed_origins: '{o}' is not a valid origin"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(layer.allow_origin(AllowOrigin::list(parsed)))
        }
    }
}

/// API routes and CORS; static assets are added by [`serve`].
pub fn build_router(state: Arc<AppState>) -> Result<Router, String> {
    let cors = cors_layer(&state.allowed_origins)?;
    Ok(Router::new()
        .route("/__access/probe", get(access::handle_probe))
        .route("/__access/login", get(access::handle_login))
        .route("/api/version", get(access::handle_version))
        .route("/api/clipboard", get(clipboard::handle_get).post(clipboard::handle_post))
        .route("/api/capabilities", get(history_api::handle_capabilities))
        .route("/api/history", get(history_api::handle_list).delete(history_api::handle_clear))
        .route(
            "/api/history/:id",
            get(history_api::handle_get_item).delete(history_api::handle_delete_item),
        )
        .route("/api/files", post(files::handle_request_upload))
        .route("/api/files/:id", get(files::handle_request_download))
        .route("/api/files/:id/complete", post(files::handle_complete_upload))
        .route("/api/events/ticket", post(ws::handle_ticket))
        .route("/api/pair/windows", post(pair_api::handle_open_window))
        .route("/api/pair/devices", get(pair_api::handle_list_devices))
        .route("/api/pair/devices/:id", axum::routing::delete(pair_api::handle_revoke_device))
        .route("/api/pair/renew", post(pair_api::handle_renew))
        .route("/api/pair/spake2/start", post(pair_api::handle_spake2_start))
        .route("/api/pair/spake2/confirm", post(pair_api::handle_spake2_confirm))
        .route("/api/pair/ecdh/start", post(pair_api::handle_ecdh_start))
        .route("/api/pair/ecdh/result", post(pair_api::handle_ecdh_result))
        .route("/api/pair/pending", get(pair_api::handle_pending))
        .route("/api/pair/pending/:id/approve", post(pair_api::handle_decide_approve))
        .route("/api/pair/pending/:id/reject", post(pair_api::handle_decide_reject))
        .route("/ws", get(ws::handle_ws_upgrade))
        .route("/ws/events", get(ws::handle_events_upgrade))
        .with_state(state)
        .layer(cors))
}

pub async fn serve(
    listener: tokio::net::TcpListener,
    state: Arc<AppState>,
    static_dir: Option<PathBuf>,
) -> Result<(), String> {
    let api = build_router(state.clone())?;
    let app = if let Some(dir) = static_dir {
        if !dir.is_dir() {
            return Err(format!("--static-dir '{}' is not a directory", dir.display()));
        }
        api.fallback_service(ServeDir::new(&dir))
    } else {
        api.route("/",              get(static_assets::handler_ui))
           .route("/icon.svg",      get(static_assets::handler_icon))
           .route("/manifest.json", get(static_assets::handler_manifest))
    };
    reaper::spawn(state);
    // connect info: the pairing endpoints rate-limit per source address
    axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .await
        .map_err(|e| format!("server error: {e}"))
}
