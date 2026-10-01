/// Token auth and namespace resolution
use super::state::{AppState, NamespaceState};
use axum::{
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::{collections::HashMap, sync::Arc};
use subtle::ConstantTimeEq;

pub const NS_HEADER: &str = "x-copa-namespace";

pub fn extract_bearer(headers: &HeaderMap) -> &str {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
}

pub fn extract_ns_name<'a>(headers: &'a HeaderMap, params: &'a HashMap<String, String>) -> &'a str {
    headers
        .get(NS_HEADER)
        .and_then(|v| v.to_str().ok())
        .or_else(|| params.get("namespace").map(String::as_str))
        .unwrap_or("default")
}

/// Constant-time comparison; an empty presented token never matches.
fn token_matches(configured: &Option<String>, presented: &str) -> bool {
    match configured {
        Some(c) if !presented.is_empty() => bool::from(c.as_bytes().ct_eq(presented.as_bytes())),
        _ => false,
    }
}

pub fn can_read(ns: &NamespaceState, tok: &str) -> bool {
    // `|` not `||`: always evaluate both comparisons
    token_matches(&ns.rw_token, tok) | token_matches(&ns.read_token, tok)
}

pub fn can_write(ns: &NamespaceState, tok: &str) -> bool {
    token_matches(&ns.rw_token, tok) | token_matches(&ns.write_token, tok)
}

pub fn json_error(status: StatusCode, msg: &str) -> Response {
    let body = serde_json::json!({ "error": msg }).to_string();
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
    /// Any token of the namespace.
    Any,
}

/// Resolve the namespace and check the bearer token from the `Authorization`
/// header only. Used by every endpoint added after the original clipboard API;
/// `?token=` is deliberately not accepted here.
pub fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    params: &HashMap<String, String>,
    access: Access,
) -> Result<Arc<NamespaceState>, Response> {
    let ns_name = extract_ns_name(headers, params);
    let Some(ns) = state.namespaces.get(ns_name).cloned() else {
        return Err(json_error(StatusCode::NOT_FOUND, "namespace not found"));
    };
    let tok = extract_bearer(headers);
    let (r, w) = (can_read(&ns, tok), can_write(&ns, tok));
    let ok = match access {
        Access::Read => r,
        Access::Write => w,
        Access::Any => r | w,
    };
    if !ok {
        return Err(json_error(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    Ok(ns)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::config::NamespaceConfig;

    fn ns(read: Option<&str>, write: Option<&str>, rw: Option<&str>) -> NamespaceState {
        let cfg = NamespaceConfig {
            read_token:  read.map(str::to_owned),
            write_token: write.map(str::to_owned),
            rw_token:    rw.map(str::to_owned),
            ..Default::default()
        };
        NamespaceState::new("t", &cfg, false).unwrap()
    }

    #[test]
    fn rw_token_grants_both() {
        let n = ns(None, None, Some("rw"));
        assert!(can_read(&n, "rw") && can_write(&n, "rw"));
    }

    #[test]
    fn read_token_grants_read_only() {
        let n = ns(Some("r"), Some("w"), None);
        assert!(can_read(&n, "r") && !can_write(&n, "r"));
    }

    #[test]
    fn write_token_grants_write_only() {
        let n = ns(Some("r"), Some("w"), None);
        assert!(can_write(&n, "w") && !can_read(&n, "w"));
    }

    #[test]
    fn wrong_or_prefix_tokens_are_rejected() {
        let n = ns(Some("reader"), Some("writer"), Some("readwrite"));
        for tok in ["nope", "read", "readwritex", "READWRITE"] {
            assert!(!can_read(&n, tok) && !can_write(&n, tok), "{tok}");
        }
    }

    #[test]
    fn empty_token_never_matches() {
        assert!(!can_read(&ns(None, None, None), ""));
        // even when a token is (mis)configured as the empty string
        let n = ns(Some(""), Some(""), Some(""));
        assert!(!can_read(&n, "") && !can_write(&n, ""));
    }
}
