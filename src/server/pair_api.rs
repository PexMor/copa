/// `/api/pair/*` — operator endpoints (open a window, list/revoke devices) and renewal.
/// The device-side exchanges (SPAKE2 / ECDH) are added alongside.
use super::auth::{authorize, extract_bearer, extract_ns_name, json_error, Access};
use super::history_api::json_ok;
use super::pair_crypto as pc;
use super::pairing::{EcdhStatus, PairError, Pairing};
use super::state::AppState;
use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, net::SocketAddr, sync::Arc};

/// Pairing must be enabled (404 otherwise) and the caller within its rate limit (429).
pub fn gate<'a>(state: &'a AppState, addr: &SocketAddr) -> Result<&'a Pairing, Response> {
    let Some(p) = &state.pairing else {
        return Err(json_error(StatusCode::NOT_FOUND, "pairing not enabled"));
    };
    if !p.rate_ok(addr.ip(), state.now()) {
        let mut resp = json_error(StatusCode::TOO_MANY_REQUESTS, "too many requests");
        resp.headers_mut().insert(header::RETRY_AFTER, "10".parse().expect("static header"));
        return Err(resp);
    }
    Ok(p)
}

#[derive(Deserialize)]
pub struct OpenWindow {
    /// `r`, `w` or `rw` (default `rw`).
    access: Option<String>,
    /// Optional label shown to the operator.
    name: Option<String>,
}

/// Open a pairing window for the request's namespace. Needs write access there: whoever can
/// write to a namespace may decide which devices join it, never with more than `rw`.
pub async fn handle_open_window(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let pairing = match gate(&state, &addr) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let ns = match authorize(&state, &headers, &params, Access::Write) {
        Ok(ns) => ns,
        Err(r) => return r,
    };
    // An empty body means the defaults; anything else must be valid JSON (never silently ignored).
    let req = if body.iter().all(u8::is_ascii_whitespace) {
        OpenWindow { access: None, name: None }
    } else {
        match serde_json::from_slice::<OpenWindow>(&body) {
            Ok(r) => r,
            Err(_) => return json_error(StatusCode::BAD_REQUEST, "the body must be JSON like {\"access\":\"rw\",\"name\":\"...\"}"),
        }
    };
    let acc = req.access.unwrap_or_else(|| "rw".into());
    if !matches!(acc.as_str(), "r" | "w" | "rw") {
        return json_error(StatusCode::BAD_REQUEST, "access must be r, w or rw");
    }
    match pairing.open_window(&ns.name, &acc, req.name.as_deref().unwrap_or(""), state.now()) {
        Ok(w) => {
            eprintln!("pair: window opened ns={} access={acc}", ns.name); // never the code
            json_ok(json!({
                "window_id": w.id, "code": w.code, "display_code": w.display_code(),
                "expires_at": w.expires_ms, "namespace": w.ns, "access": w.acc,
            }))
        }
        Err(PairError::TooManyWindows) => json_error(StatusCode::TOO_MANY_REQUESTS, "too many open pairing windows"),
        Err(_) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open a window"),
    }
}

/// Paired devices of the request's namespace.
pub async fn handle_list_devices(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = gate(&state, &addr) {
        return r;
    }
    let ns = match authorize(&state, &headers, &params, Access::Write) {
        Ok(ns) => ns,
        Err(r) => return r,
    };
    let tokens = state.tokens.as_ref().expect("pairing implies tokens");
    let list: Vec<Value> = tokens.devices().into_iter().filter(|d| d.ns == ns.name).map(|d| json!(d)).collect();
    json_ok(Value::Array(list))
}

/// Revoke one device of the request's namespace.
pub async fn handle_revoke_device(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = gate(&state, &addr) {
        return r;
    }
    let ns = match authorize(&state, &headers, &params, Access::Write) {
        Ok(ns) => ns,
        Err(r) => return r,
    };
    let tokens = state.tokens.as_ref().expect("pairing implies tokens");
    if !tokens.devices().iter().any(|d| d.dev == id && d.ns == ns.name) {
        return json_error(StatusCode::NOT_FOUND, "no such device");
    }
    match tokens.revoke(&id) {
        Ok(()) => {
            eprintln!("pair: device {id} revoked ns={}", ns.name);
            json_ok(json!({ "revoked": id }))
        }
        Err(e) => {
            eprintln!("pair: cannot persist revocation: {e}");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "cannot persist the revocation")
        }
    }
}

/// Sliding renewal: a valid device token buys a fresh one (only when `sliding_renewal = true`).
pub async fn handle_renew(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let pairing = match gate(&state, &addr) {
        Ok(p) => p,
        Err(r) => return r,
    };
    if !pairing.cfg.sliding_renewal {
        return json_error(StatusCode::NOT_FOUND, "renewal not enabled");
    }
    let _ = extract_ns_name(&headers, &params);
    let tokens = state.tokens.as_ref().expect("pairing implies tokens");
    match tokens.renew(extract_bearer(&headers), pairing.cfg.device_ttl_ms(), state.now()) {
        Ok((token, rec)) => json_ok(json!({ "token": token, "expires_at": rec.exp, "namespace": rec.ns, "access": rec.acc })),
        Err(_) => json_error(StatusCode::UNAUTHORIZED, "unauthorized"),
    }
}

// ── SPAKE2 ────────────────────────────────────────────────────────────────────

const ID_CLIENT: &[u8] = b"copa-widget";
const ID_SERVER: &[u8] = b"copa-server";

fn pairing_failed() -> Response {
    // One answer for every kind of failure: nothing about windows, codes or sessions leaks.
    json_error(StatusCode::FORBIDDEN, "pairing failed")
}

#[derive(Deserialize)]
pub struct Spake2Start {
    window_id: String,
    /// The device's SPAKE2 message (side byte 0x41 + 32-byte point), base64url.
    msg: String,
}

/// Step 1: the device sends its SPAKE2 message; we answer with ours. Nothing is decided yet —
/// the code is only checked (without being revealed) by the confirmation in step 2.
pub async fn handle_spake2_start(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: axum::body::Bytes,
) -> Response {
    use spake2::{Ed25519Group, Identity, Password, Spake2};
    let pairing = match gate(&state, &addr) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let Ok(req) = serde_json::from_slice::<Spake2Start>(&body) else {
        return json_error(StatusCode::BAD_REQUEST, "bad request");
    };
    let Some(msg_a) = pc::unb64(&req.msg).filter(|m| m.len() == 33 && m[0] == 0x41) else {
        return json_error(StatusCode::BAD_REQUEST, "bad message");
    };
    let now = state.now();
    // An unknown, expired or closed window gets a decoy exchange with a random password.
    let (window_id, code, decoy) = match pairing.usable(&req.window_id, now) {
        Ok(w) => (w.id, w.code, false),
        Err(_) => (req.window_id.chars().take(16).collect::<String>(), format!("{:08}", rand::random::<u32>() % 100_000_000), true),
    };
    let (spake, msg_b) = Spake2::<Ed25519Group>::start_b(&Password::new(code.as_bytes()), &Identity::new(ID_CLIENT), &Identity::new(ID_SERVER));
    let Ok(shared) = spake.finish(&msg_a) else {
        return json_error(StatusCode::BAD_REQUEST, "bad message");
    };
    let t = pc::transcript("spake2", &[window_id.as_bytes(), &msg_a, &msg_b]);
    let keys = pc::derive(&shared, t);
    let Some(session_id) = pairing.add_session(&window_id, decoy, keys, now) else {
        return json_error(StatusCode::TOO_MANY_REQUESTS, "too many pending pairings");
    };
    json_ok(json!({ "session_id": session_id, "msg": pc::b64(&msg_b) }))
}

#[derive(Deserialize)]
pub struct Spake2Confirm {
    session_id: String,
    /// Client key confirmation, base64url.
    mac: String,
    /// Label for the device (optional, cleaned).
    name: Option<String>,
}

/// Step 2: the device proves it derived the same key (so it knew the code). Only then the
/// credential is created and returned, encrypted under the exchange's key, with our own
/// confirmation so the device knows it talked to the real server.
pub async fn handle_spake2_confirm(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: axum::body::Bytes,
) -> Response {
    let pairing = match gate(&state, &addr) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let Ok(req) = serde_json::from_slice::<Spake2Confirm>(&body) else {
        return pairing_failed();
    };
    let now = state.now();
    let Some(session) = pairing.take_session(&req.session_id, now) else {
        return pairing_failed();
    };
    let given = pc::unb64(&req.mac).unwrap_or_default();
    let expected = pc::mac(&session.keys.client_mac, pc::LABEL_CLIENT, &session.keys.transcript);
    let confirmed = pc::mac_matches(&expected, &given) && !session.decoy;
    if !confirmed {
        let closed = pairing.fail(&session.window_id);
        eprintln!("pair: confirmation failed{}", if closed { " (window closed)" } else { "" });
        return pairing_failed();
    }
    // The window may have been closed or have expired while the exchange was pending.
    let Ok(window) = pairing.usable(&session.window_id, now) else {
        return pairing_failed();
    };
    pairing.close(&window.id);
    let tokens = state.tokens.as_ref().expect("pairing implies tokens");
    let label = req.name.as_deref().filter(|n| !n.trim().is_empty()).unwrap_or(&window.name);
    let (token, rec) = match tokens.enroll(label, &window.ns, &window.acc, pairing.cfg.device_ttl_ms(), now) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("pair: cannot enroll device: {e}");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "cannot enroll the device");
        }
    };
    eprintln!("pair: device {} enrolled ns={} access={}", rec.dev, rec.ns, rec.acc); // never the token or the code
    let plaintext = json!({ "token": token, "expires_at": rec.exp, "namespace": rec.ns, "access": rec.acc, "device": rec.dev });
    let sealed = pc::seal(&session.keys.enc, &session.keys.transcript, plaintext.to_string().as_bytes());
    let server_mac = pc::mac(&session.keys.server_mac, pc::LABEL_SERVER, &session.keys.transcript);
    json_ok(json!({ "mac": pc::b64(&server_mac), "sealed": pc::b64(&sealed) }))
}

// ── ECDH (P-256) with operator confirmation ────────────────────────────────────

#[derive(Deserialize)]
pub struct EcdhStart {
    window_id: String,
    /// The device's ephemeral public key: uncompressed SEC1 point (65 bytes), base64url.
    #[serde(rename = "pub")]
    public: String,
}

/// Step 1: exchange ephemeral keys. The response carries our key and the fingerprint of the
/// exchange; the operator sees the same fingerprint (`GET /api/pair/pending`) and approves only
/// if it matches the one shown on the device. Nothing is issued yet.
pub async fn handle_ecdh_start(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: axum::body::Bytes,
) -> Response {
    use p256::{ecdh::EphemeralSecret, elliptic_curve::sec1::ToEncodedPoint, PublicKey};
    let pairing = match gate(&state, &addr) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let Ok(req) = serde_json::from_slice::<EcdhStart>(&body) else {
        return json_error(StatusCode::BAD_REQUEST, "bad request");
    };
    let Some(client_pub) = pc::unb64(&req.public).filter(|b| b.len() == 65 && b[0] == 4) else {
        return json_error(StatusCode::BAD_REQUEST, "bad key");
    };
    let Ok(client_key) = PublicKey::from_sec1_bytes(&client_pub) else {
        return json_error(StatusCode::BAD_REQUEST, "bad key");
    };
    let now = state.now();
    let Ok(window) = pairing.usable(&req.window_id, now) else {
        return pairing_failed(); // unlike SPAKE2 there is no secret to protect: refusing early is fine
    };
    let secret = EphemeralSecret::random(&mut rand::thread_rng());
    let server_pub = secret.public_key().to_encoded_point(false).as_bytes().to_vec();
    let shared = secret.diffie_hellman(&client_key);
    let t = pc::transcript("ecdh", &[window.id.as_bytes(), &client_pub, &server_pub]);
    let keys = pc::derive(shared.raw_secret_bytes().as_slice(), t);
    let fingerprint = pc::fingerprint(&t);
    let Some(session_id) = pairing.add_ecdh(&window, client_pub, fingerprint.clone(), keys, now) else {
        return json_error(StatusCode::TOO_MANY_REQUESTS, "too many pending pairings");
    };
    eprintln!("pair: ecdh pairing waiting for approval ns={}", window.ns);
    json_ok(json!({ "session_id": session_id, "pub": pc::b64(&server_pub), "fingerprint": fingerprint, "expires_at": window.expires_ms }))
}

#[derive(Deserialize)]
pub struct EcdhResult {
    session_id: String,
    /// Proof that the device holds the exchange's key (so only it can collect the credential).
    mac: String,
    name: Option<String>,
}

/// Step 2 (polled): `pending` until the operator decides; then the credential, sealed under the
/// exchange's key, together with the server's key confirmation. Delivered once.
pub async fn handle_ecdh_result(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: axum::body::Bytes,
) -> Response {
    let pairing = match gate(&state, &addr) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let Ok(req) = serde_json::from_slice::<EcdhResult>(&body) else {
        return pairing_failed();
    };
    let now = state.now();
    let Some((status, keys, (ns, acc, wname))) = pairing.peek_ecdh(&req.session_id, now) else {
        return pairing_failed();
    };
    let given = pc::unb64(&req.mac).unwrap_or_default();
    if !pc::mac_matches(&pc::mac(&keys.client_mac, pc::LABEL_CLIENT, &keys.transcript), &given) {
        return pairing_failed(); // not the device that started it
    }
    match status {
        EcdhStatus::Pending => json_ok(json!({ "status": "pending" })),
        EcdhStatus::Denied => {
            pairing.finish_ecdh(&req.session_id);
            json_ok(json!({ "status": "denied" }))
        }
        EcdhStatus::Approved => {
            pairing.finish_ecdh(&req.session_id);
            let tokens = state.tokens.as_ref().expect("pairing implies tokens");
            let label = req.name.as_deref().filter(|n| !n.trim().is_empty()).unwrap_or(&wname);
            let (token, rec) = match tokens.enroll(label, &ns, &acc, pairing.cfg.device_ttl_ms(), now) {
                Ok(x) => x,
                Err(e) => {
                    eprintln!("pair: cannot enroll device: {e}");
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, "cannot enroll the device");
                }
            };
            eprintln!("pair: device {} enrolled ns={} access={}", rec.dev, rec.ns, rec.acc);
            let plain = json!({ "token": token, "expires_at": rec.exp, "namespace": rec.ns, "access": rec.acc, "device": rec.dev });
            let sealed = pc::seal(&keys.enc, &keys.transcript, plain.to_string().as_bytes());
            let server_mac = pc::mac(&keys.server_mac, pc::LABEL_SERVER, &keys.transcript);
            json_ok(json!({ "status": "approved", "mac": pc::b64(&server_mac), "sealed": pc::b64(&sealed) }))
        }
    }
}

/// Pairings waiting for the operator's decision in the request's namespace.
pub async fn handle_pending(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let pairing = match gate(&state, &addr) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let ns = match authorize(&state, &headers, &params, Access::Write) {
        Ok(ns) => ns,
        Err(r) => return r,
    };
    let list: Vec<Value> = pairing
        .pending_for(&ns.name, state.now())
        .into_iter()
        .map(|(id, window_id, fingerprint, created)| json!({ "id": id, "window_id": window_id, "fingerprint": fingerprint, "created_at": created }))
        .collect();
    json_ok(Value::Array(list))
}

async fn decide(state: Arc<AppState>, addr: SocketAddr, id: String, params: HashMap<String, String>, headers: HeaderMap, body: axum::body::Bytes, approve: bool) -> Response {
    let pairing = match gate(&state, &addr) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let ns = match authorize(&state, &headers, &params, Access::Write) {
        Ok(ns) => ns,
        Err(r) => return r,
    };
    // Optional: approving by scanned key — `{"client_pub": "<base64url>"}` must match this pairing.
    let scanned = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v.get("client_pub").and_then(Value::as_str).and_then(pc::unb64));
    match pairing.decide_ecdh(&id, &ns.name, approve, scanned.as_deref(), state.now()) {
        Ok(()) => {
            eprintln!("pair: ecdh pairing {} ns={}", if approve { "approved" } else { "rejected" }, ns.name);
            json_ok(json!({ "ok": true }))
        }
        Err(PairError::KeyMismatch) => json_error(StatusCode::CONFLICT, "the scanned key does not belong to this pairing"),
        Err(_) => json_error(StatusCode::NOT_FOUND, "no such pending pairing"),
    }
}

pub async fn handle_decide_approve(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    decide(state, addr, id, params, headers, body, true).await
}

pub async fn handle_decide_reject(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    decide(state, addr, id, params, headers, body, false).await
}
