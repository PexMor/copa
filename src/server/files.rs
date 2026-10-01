/// `/api/files` — file items via presigned object-store URLs
///
/// Flow: `POST /api/files` (get an upload URL) → client PUTs the bytes to the
/// object store → `POST /api/files/{id}/complete` (verified, becomes visible)
/// → `GET /api/files/{id}` (get a download URL).
use super::auth::{authorize, json_error, Access};
use super::clipboard::requested_ttl;
use super::history_api::json_ok;
use super::state::{AppState, NamespaceState};
use crate::history::{ItemKind, UploadError};
use crate::storage::Storage;
use crate::{gen_token, sanitize_filename};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde::Deserialize;
use serde_json::json;
use std::{collections::HashMap, sync::Arc, time::Duration};

/// Extra time after the upload URL expires in which `complete` is accepted.
const COMPLETE_GRACE_MS: u64 = 60_000;

#[derive(Deserialize)]
struct UploadRequest {
    name:         String,
    size:         u64,
    content_type: Option<String>,
    ttl_secs:     Option<u64>,
}

fn files_disabled() -> Response {
    json_error(StatusCode::NOT_FOUND, "files not enabled")
}

/// Authorize, then make sure file items are available for the namespace.
fn file_access(
    state: &AppState,
    headers: &HeaderMap,
    params: &HashMap<String, String>,
    access: Access,
) -> Result<(Arc<NamespaceState>, Arc<Storage>), Response> {
    let ns = authorize(state, headers, params, access)?;
    match &state.storage {
        Some(storage) if ns.files => Ok((ns, storage.clone())),
        _ => Err(files_disabled()),
    }
}

/// Declared type is metadata only (objects are stored as octet-stream).
fn clean_content_type(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some(t) if !t.is_empty() && t.len() <= 255 && t.chars().all(|c| c.is_ascii_graphic() || c == ' ') => {
            t.to_owned()
        }
        _ => "application/octet-stream".to_owned(),
    }
}

pub async fn handle_request_upload(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (ns, storage) = match file_access(&state, &headers, &params, Access::Write) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Ok(req) = serde_json::from_slice::<UploadRequest>(&body) else {
        return json_error(StatusCode::BAD_REQUEST, "expected JSON with 'name' and 'size'");
    };
    let Ok(header_ttl) = requested_ttl(&headers) else {
        return json_error(StatusCode::BAD_REQUEST, "X-Copa-TTL must be a positive number of seconds");
    };
    if req.ttl_secs == Some(0) {
        return json_error(StatusCode::BAD_REQUEST, "ttl_secs must be greater than 0");
    }

    let now = state.now();
    let id = gen_token();
    let key = storage.object_key(&ns.name, &id);
    let name = sanitize_filename(&req.name);
    let url_expires_at = now + storage.presign_ttl().as_millis() as u64;

    let begun = ns.history().begin_upload(
        id.clone(),
        key.clone(),
        name.clone(),
        clean_content_type(req.content_type.as_deref()),
        req.size,
        req.ttl_secs.or(header_ttl),
        url_expires_at + COMPLETE_GRACE_MS,
        now,
    );
    if let Err(e) = begun {
        eprintln!("POST /api/files ns={} rejected size={} ({e:?})", ns.name, req.size);
        return match e {
            UploadError::Empty => json_error(StatusCode::BAD_REQUEST, "size must be greater than 0"),
            UploadError::TooLarge => json_error(StatusCode::PAYLOAD_TOO_LARGE, "file exceeds max_file_size"),
            UploadError::QuotaExceeded => {
                json_error(StatusCode::INSUFFICIENT_STORAGE, "namespace file quota exceeded")
            }
            UploadError::TooManyPending => {
                json_error(StatusCode::TOO_MANY_REQUESTS, "too many uploads in progress")
            }
        };
    }

    let upload = storage.presign_put(&key, req.size, &name);
    let upload_headers: serde_json::Map<String, serde_json::Value> =
        upload.headers.into_iter().map(|(k, v)| (k.to_owned(), json!(v))).collect();
    eprintln!("POST /api/files ns={} id={id} size={}", ns.name, req.size);
    json_ok(json!({
        "id":         id,
        "upload_url": upload.url.as_str(),
        "method":     "PUT",
        "headers":    upload_headers,
        "expires_at": url_expires_at,
    }))
}

pub async fn handle_complete_upload(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let (ns, storage) = match file_access(&state, &headers, &params, Access::Write) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(pending) = ns.history().pending(&id, state.now()).cloned() else {
        return json_error(StatusCode::NOT_FOUND, "no such pending upload");
    };

    let key = pending.key.clone();
    let head = tokio::task::spawn_blocking(move || storage.head(&key))
        .await
        .unwrap_or_else(|e| Err(format!("head task failed: {e}")));

    match head {
        Ok(Some(size)) if size == pending.size => {
            let Some(added) = ns.history().commit_upload(&id, state.now()) else {
                return json_error(StatusCode::NOT_FOUND, "no such pending upload");
            };
            eprintln!("POST /api/files/complete ns={} id={id} size={size}", ns.name);
            state.publish_added(&ns, &added.item);
            state.apply_removed(&ns, added.removed);
            json_ok(added.item.meta_json())
        }
        Ok(found) => {
            // Missing or wrong size: forget the upload and remove whatever is there.
            let aborted = ns.history().abort_upload(&id);
            if let Some(key) = aborted {
                state.delete_objects(vec![key]).await;
            }
            eprintln!("POST /api/files/complete ns={} id={id} 409 found={found:?}", ns.name);
            json_error(
                StatusCode::CONFLICT,
                if found.is_some() { "uploaded size does not match declared size" } else { "object was not uploaded" },
            )
        }
        Err(e) => {
            eprintln!("POST /api/files/complete ns={} id={id} 502 {e}", ns.name);
            json_error(StatusCode::BAD_GATEWAY, "object store unavailable, try again")
        }
    }
}

pub async fn handle_request_download(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let (ns, storage) = match file_access(&state, &headers, &params, Access::Read) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let now = state.now();
    let history = ns.history();
    let Some(item) = history.get(&id, now) else {
        return json_error(StatusCode::NOT_FOUND, "item not found or expired");
    };
    let ItemKind::File { key, name, content_type } = &item.kind else {
        return json_error(StatusCode::CONFLICT, "item is not a file");
    };
    // The URL must not outlive the item.
    let remaining_ms = item.expires_at - now;
    let ttl_ms = remaining_ms.min(storage.presign_ttl().as_millis() as u64);
    let ttl = Duration::from_secs((ttl_ms / 1000).max(1));
    let url = storage.presign_get(key, ttl);
    eprintln!("GET /api/files ns={} id={id} size={}", ns.name, item.size);
    json_ok(json!({
        "id":           item.id,
        "download_url": url.as_str(),
        "name":         name,
        "size":         item.size,
        "content_type": content_type,
        "expires_at":   now + ttl.as_millis() as u64,
    }))
}
