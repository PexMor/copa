/// `/api/clipboard` — the original single-buffer API, now backed by history
use super::auth::{denied, extract_bearer, extract_ns_name, perms};
use super::state::AppState;
use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
};
use std::{collections::HashMap, sync::Arc};

pub const TTL_HEADER: &str = "x-copa-ttl";

/// Optional client-requested lifetime in seconds. `Err` when malformed.
pub fn requested_ttl(headers: &HeaderMap) -> Result<Option<u64>, ()> {
    match headers.get(TTL_HEADER) {
        None => Ok(None),
        Some(v) => match v.to_str().ok().and_then(|s| s.trim().parse::<u64>().ok()) {
            Some(secs) if secs > 0 => Ok(Some(secs)),
            _ => Err(()),
        },
    }
}

pub async fn handle_get(
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
    let caller = perms(&state, &ns, &tok);
    if !caller.read && !perms(&state, &ns, tok_q).read {
        eprintln!("GET /api/clipboard ns={ns_name} {}", if caller.forbidden { 403 } else { 401 });
        return denied(&caller);
    }
    let content = ns.history().latest_text(state.now()).map(<[u8]>::to_vec).unwrap_or_default();
    eprintln!("GET /api/clipboard ns={ns_name} {} bytes", content.len());
    (StatusCode::OK, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], content).into_response()
}

pub async fn handle_post(
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
    let caller = perms(&state, &ns, &tok);
    if !caller.write && !perms(&state, &ns, tok_q).write {
        eprintln!("POST /api/clipboard ns={ns_name} {}", if caller.forbidden { 403 } else { 401 });
        return denied(&caller);
    }
    if body.len() > ns.size_limit {
        eprintln!("POST /api/clipboard ns={ns_name} 413 {} > {}", body.len(), ns.size_limit);
        return (StatusCode::PAYLOAD_TOO_LARGE, r#"{"error":"content too large"}"#).into_response();
    }
    let Ok(ttl) = requested_ttl(&headers) else {
        return (StatusCode::BAD_REQUEST, r#"{"error":"X-Copa-TTL must be a positive number of seconds"}"#)
            .into_response();
    };
    state.push_text(&ns, body.to_vec(), ttl);
    eprintln!("POST /api/clipboard ns={ns_name} {} bytes", body.len());
    (StatusCode::OK, "ok").into_response()
}
