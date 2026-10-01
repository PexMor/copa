/// copasrv HTTP/WebSocket server
pub mod auth;
pub mod clipboard;
pub mod config;
pub mod files;
pub mod history_api;
pub mod reaper;
pub mod state;
pub mod static_assets;
pub mod ws;

use axum::{
    http::HeaderValue,
    routing::{get, post},
    Router,
};
use state::AppState;
use std::{path::PathBuf, sync::Arc};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::services::ServeDir;

fn cors_layer(allowed_origins: &Option<Vec<String>>) -> Result<CorsLayer, String> {
    let layer = CorsLayer::new().allow_headers(Any).allow_methods(Any);
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
    axum::serve(listener, app).await.map_err(|e| format!("server error: {e}"))
}
