/// WebSocket endpoints: `/ws` (plain text content) and `/ws/events` (JSON item events)
use super::auth::{can_read, can_write, extract_bearer, extract_ns_name};
use super::state::{AppState, NamespaceState};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::broadcast;

/// Token from the header, or `?token=` for clients that cannot set headers
/// during the upgrade (browsers).
fn effective_token(headers: &HeaderMap, params: &HashMap<String, String>) -> String {
    let tok = extract_bearer(headers);
    if !tok.is_empty() {
        tok.to_owned()
    } else {
        params.get("token").cloned().unwrap_or_default()
    }
}

pub async fn handle_ws_upgrade(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let ns_name = extract_ns_name(&headers, &params).to_owned();
    let Some(ns) = state.namespaces.get(&ns_name).cloned() else {
        return (StatusCode::NOT_FOUND, "namespace not found").into_response();
    };

    let effective = effective_token(&headers, &params);
    let read_ok  = can_read(&ns, &effective);
    let write_ok = can_write(&ns, &effective);

    if !read_ok && !write_ok {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }

    eprintln!("WS /ws ns={ns_name} read={read_ok} write={write_ok}");
    ws.on_upgrade(move |socket| ws_session(socket, state, ns, read_ok, write_ok))
        .into_response()
}

async fn ws_session(
    socket: WebSocket,
    state: Arc<AppState>,
    ns: Arc<NamespaceState>,
    read_ok: bool,
    write_ok: bool,
) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = ns.tx.subscribe();

    // Send current content immediately on connect
    if read_ok {
        let current = ns.history().latest_text(state.now()).map(<[u8]>::to_vec).unwrap_or_default();
        let _ = sender.send(Message::Text(String::from_utf8_lossy(&current).into_owned())).await;
    }

    let ns_w = ns.clone();
    let inbound = async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) if write_ok => {
                    if text.len() <= ns_w.size_limit {
                        state.push_text(&ns_w, text.into_bytes(), None);
                    }
                }
                Message::Binary(data) if write_ok => {
                    if data.len() <= ns_w.size_limit {
                        state.push_text(&ns_w, data, None);
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };

    let outbound = async move {
        if !read_ok {
            // Write-only session: stay open until the client leaves.
            return std::future::pending::<()>().await;
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

pub async fn handle_events_upgrade(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let ns_name = extract_ns_name(&headers, &params).to_owned();
    let Some(ns) = state.namespaces.get(&ns_name).cloned() else {
        return (StatusCode::NOT_FOUND, "namespace not found").into_response();
    };
    if !can_read(&ns, &effective_token(&headers, &params)) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    eprintln!("WS /ws/events ns={ns_name}");
    ws.on_upgrade(move |socket| events_session(socket, ns)).into_response()
}

async fn events_session(socket: WebSocket, ns: Arc<NamespaceState>) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = ns.events.subscribe();

    // Inbound frames are ignored; only watch for the client going away.
    let inbound = async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if matches!(msg, Message::Close(_)) {
                break;
            }
        }
    };

    let outbound = async move {
        loop {
            match rx.recv().await {
                Ok(frame) => {
                    if sender.send(Message::Text(frame)).await.is_err() {
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
