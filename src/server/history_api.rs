/// `/api/history` and `/api/capabilities`
use super::auth::{authorize, can_read, can_write, extract_bearer, json_error, Access};
use super::state::AppState;
use crate::history::ItemKind;
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};

pub fn json_ok(body: Value) -> Response {
    (StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
}

pub async fn handle_list(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let ns = match authorize(&state, &headers, &params, Access::Read) {
        Ok(ns) => ns,
        Err(resp) => return resp,
    };
    let items: Vec<Value> = ns.history().list(state.now()).iter().map(|i| i.meta_json()).collect();
    json_ok(Value::Array(items))
}

pub async fn handle_get_item(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let ns = match authorize(&state, &headers, &params, Access::Read) {
        Ok(ns) => ns,
        Err(resp) => return resp,
    };
    let history = ns.history();
    match history.get(&id, state.now()).map(|i| &i.kind) {
        None => json_error(StatusCode::NOT_FOUND, "item not found or expired"),
        Some(ItemKind::Text(data)) => {
            (StatusCode::OK, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], data.clone()).into_response()
        }
        Some(ItemKind::File { .. }) => {
            let body = json!({ "error": "item is a file", "hint": format!("GET /api/files/{id}") });
            (StatusCode::CONFLICT, [(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
        }
    }
}

pub async fn handle_delete_item(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let ns = match authorize(&state, &headers, &params, Access::Write) {
        Ok(ns) => ns,
        Err(resp) => return resp,
    };
    let removed = ns.history().remove(&id, state.now());
    match removed {
        None => json_error(StatusCode::NOT_FOUND, "item not found or expired"),
        Some(r) => {
            state.apply_removed(&ns, vec![r]);
            json_ok(json!({ "deleted": 1 }))
        }
    }
}

pub async fn handle_clear(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let ns = match authorize(&state, &headers, &params, Access::Write) {
        Ok(ns) => ns,
        Err(resp) => return resp,
    };
    let removed = ns.history().clear();
    let count = removed.len();
    state.apply_removed(&ns, removed);
    json_ok(json!({ "deleted": count }))
}

pub async fn handle_capabilities(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let ns = match authorize(&state, &headers, &params, Access::Any) {
        Ok(ns) => ns,
        Err(resp) => return resp,
    };
    let tok = extract_bearer(&headers);
    let history = ns.history();
    let limits = history.limits();
    let mut caps = json!({
        "history":       true,
        "history_limit": limits.history_limit,
        "item_ttl_secs": limits.item_ttl_ms / 1000,
        "size_limit":    ns.size_limit,
        "files":         ns.files,
        "read":          can_read(&ns, tok),
        "write":         can_write(&ns, tok),
    });
    if ns.files {
        caps["max_file_size"] = json!(limits.max_file_size);
        caps["file_quota_bytes"] = json!(limits.file_quota_bytes);
        if let Some(storage) = &state.storage {
            caps["presign_ttl_secs"] = json!(storage.presign_ttl().as_secs());
        }
    }
    json_ok(caps)
}
