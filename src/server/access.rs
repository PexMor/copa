/// Identity-proxy control plane (Cloudflare Access, Tailscale, oauth2-proxy, IAP).
///
/// Both routes carry no secrets and need no bearer token: they only mean
/// something when the proxy in front of copa protects them. If a request
/// reaches the origin, the browser holds a valid proxy session.
use axum::{
    extract::Query,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use std::collections::HashMap;

pub const PROBE_HEADER: &str = "x-app-access-probe";

/// `GET /__access/probe` → `204` + `X-App-Access-Probe: ok`, never cached.
pub async fn handle_probe() -> Response {
    (
        StatusCode::NO_CONTENT,
        [
            (header::HeaderName::from_static(PROBE_HEADER), "ok"),
            (header::CACHE_CONTROL, "no-store"),
        ],
    )
        .into_response()
}

/// Accept only a same-origin relative target: exactly one leading `/`, no
/// backslashes or control characters (rules out `//host`, `/\host`, schemes).
pub fn safe_return(target: &str) -> Option<&str> {
    let ok = target.starts_with('/')
        && !target.starts_with("//")
        && !target.contains('\\')
        && !target.chars().any(|c| c.is_control());
    ok.then_some(target)
}

/// `GET /__access/login?return=/path?q#hash` → `302` to the validated target.
/// The proxy intercepts this request when the session is missing, so landing
/// here after sign-in bounces the user back to the same SPA route.
pub async fn handle_login(Query(params): Query<HashMap<String, String>>) -> Response {
    let target = params
        .get("return")
        .and_then(|r| safe_return(r))
        .unwrap_or("/");
    let Ok(location) = HeaderValue::from_str(target) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    (
        StatusCode::FOUND,
        [(header::LOCATION, location), (header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
    )
        .into_response()
}

/// `GET /api/version` — build identity for client compatibility checks.
/// Unauthenticated on purpose (a client must be able to compare versions
/// before it has a working token) and carries nothing secret.
pub async fn handle_version() -> Response {
    let body = serde_json::to_string(&crate::version::VersionInfo::current("copasrv")).unwrap_or_default();
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_relative_targets() {
        for t in ["/", "/app", "/a?b=1#c", "/#token=x&url=y"] {
            assert_eq!(safe_return(t), Some(t), "{t}");
        }
    }

    #[test]
    fn rejects_open_redirects() {
        for t in ["", "//evil.com", "https://evil.com", "/\\evil.com", "evil", "javascript:alert(1)", "/a\r\nSet-Cookie: x", "/a\tb"] {
            assert_eq!(safe_return(t), None, "{t:?}");
        }
    }

    #[tokio::test]
    async fn probe_contract() {
        let r = handle_probe().await;
        assert_eq!(r.status(), StatusCode::NO_CONTENT);
        assert_eq!(r.headers()[PROBE_HEADER], "ok");
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
    }

    #[tokio::test]
    async fn login_redirects_safely() {
        let q = |v: &str| Query(HashMap::from([("return".to_string(), v.to_string())]));
        let r = handle_login(q("/x#y")).await;
        assert_eq!(r.status(), StatusCode::FOUND);
        assert_eq!(r.headers()[header::LOCATION], "/x#y");
        let r = handle_login(q("//evil.com")).await;
        assert_eq!(r.headers()[header::LOCATION], "/");
    }
}
