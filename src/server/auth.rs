/// Token auth and namespace resolution
use super::issuers::Decision;
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

/// What a credential allows in one namespace.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Perms {
    pub read:  bool,
    pub write: bool,
    /// Unix ms at which the credential stops being valid; `None` for static tokens.
    pub expires_ms: Option<u64>,
    /// A valid credential that has no access to this namespace (answered with 403, not 401).
    pub forbidden: bool,
}

impl Perms {
    pub fn any(&self) -> bool {
        self.read | self.write
    }
}

/// Resolve a presented credential to permissions in `ns`.
///
/// Sources, in order: the namespace's static tokens (constant-time, unchanged
/// cost), then device tokens (`v1.…`, pairing). Anything else grants nothing.
pub fn perms(state: &AppState, ns: &NamespaceState, tok: &str) -> Perms {
    let (read, write) = (can_read(ns, tok), can_write(ns, tok));
    if read | write {
        return Perms { read, write, expires_ms: None, forbidden: false };
    }
    dynamic_perms(state, ns, tok)
}

fn dynamic_perms(state: &AppState, ns: &NamespaceState, tok: &str) -> Perms {
    if let (Some(tokens), true) = (&state.tokens, tok.starts_with(super::token::PREFIX)) {
        return match tokens.verify(tok, state.now()) {
            Ok(c) if c.ns == ns.name => Perms { read: c.can_read(), write: c.can_write(), expires_ms: Some(c.exp), forbidden: false },
            Ok(c) => {
                eprintln!("auth: device {} presented a token for namespace '{}' on '{}'", c.dev, c.ns, ns.name);
                Perms::default()
            }
            Err(e) => {
                eprintln!("auth: device token rejected: {e}");
                Perms::default()
            }
        };
    }
    if let (Some(issuers), true) = (&state.issuers, super::issuers::looks_like_jwt(tok)) {
        return match issuers.decide(&ns.name, tok, state.now()) {
            Decision::Granted { read, write, exp_ms } => Perms { read, write, expires_ms: Some(exp_ms), forbidden: false },
            Decision::NoMapping { .. } => {
                eprintln!("auth: valid token has no mapping for namespace '{}'", ns.name);
                Perms { forbidden: true, ..Perms::default() }
            }
            Decision::Rejected(reason) => {
                eprintln!("auth: token rejected: {reason}");
                Perms::default()
            }
        };
    }
    Perms::default()
}

/// Static-token check only (no dynamic sources).
pub fn can_read(ns: &NamespaceState, tok: &str) -> bool {
    // `|` not `||`: always evaluate both comparisons
    token_matches(&ns.rw_token, tok) | token_matches(&ns.read_token, tok)
}

pub fn can_write(ns: &NamespaceState, tok: &str) -> bool {
    token_matches(&ns.rw_token, tok) | token_matches(&ns.write_token, tok)
}

/// 403 for a valid credential without access to the namespace, otherwise 401.
pub fn denied(p: &Perms) -> Response {
    if p.forbidden {
        json_error(StatusCode::FORBIDDEN, "forbidden")
    } else {
        json_error(StatusCode::UNAUTHORIZED, "unauthorized")
    }
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
    authorize_with_perms(state, headers, params, access).map(|(ns, _)| ns)
}

/// Like [`authorize`], also returning what the credential allows (and when it expires).
pub fn authorize_with_perms(
    state: &AppState,
    headers: &HeaderMap,
    params: &HashMap<String, String>,
    access: Access,
) -> Result<(Arc<NamespaceState>, Perms), Response> {
    let ns_name = extract_ns_name(headers, params);
    let Some(ns) = state.namespaces.get(ns_name).cloned() else {
        return Err(json_error(StatusCode::NOT_FOUND, "namespace not found"));
    };
    let p = perms(state, &ns, extract_bearer(headers));
    let ok = match access {
        Access::Read => p.read,
        Access::Write => p.write,
        Access::Any => p.any(),
    };
    if !ok {
        return Err(denied(&p));
    }
    Ok((ns, p))
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
