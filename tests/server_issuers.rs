//! Trusted-issuer configuration and (further down) JWT verification, exercised
//! through the real `copasrv` binary and HTTP.
mod support;

use jsonwebtoken::Algorithm;
use serde_json::json;
use std::{
    io::Read,
    process::{Command, Stdio},
    time::Duration,
};
use support::*;

const COPASRV: &str = env!("CARGO_BIN_EXE_copasrv");

/// A minimal web app directory: copasrv refuses to start without one.
fn fake_web_app() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("index.html"), "<!doctype html>").unwrap();
    d
}

/// Run copasrv with a config file; returns (exit success, stderr). Port 0 is not
/// accepted by the flag parser path used here, so a startup failure is the only
/// outcome these tests look at.
fn run_expecting_failure(config: &str) -> (bool, String) {
    let dir = tempfile::tempdir().unwrap();
    let web = fake_web_app();
    let path = dir.path().join("config.toml");
    std::fs::write(&path, config).unwrap();
    let mut child = Command::new(COPASRV)
        .args(["--config", path.to_str().unwrap(), "--port", "0", "--bind", "127.0.0.1", "--static-dir", web.path().to_str().unwrap()])
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    // A refused configuration exits quickly; a valid one would keep running.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            let mut err = String::new();
            child.stderr.take().unwrap().read_to_string(&mut err).unwrap();
            return (status.success(), err);
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return (true, "still running".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn config_with_issuer(extra: &str) -> String {
    format!(
        r#"
[server.namespaces.team]
rw_token = "t"

[server.auth.issuers.hub]
iss = "https://auth.example.com"
jwks_url = "https://auth.example.com/jwks.json"
audience = "https://copa.example.com"
{extra}
[[server.auth.issuers.hub.map]]
claim = "scope"
value = "copa:team:rw"
namespace = "team"
access = "rw"
"#
    )
}

#[test]
fn a_symmetric_algorithm_stops_the_server_with_a_clear_message() {
    let (ok, err) = run_expecting_failure(&config_with_issuer("algorithms = [\"ES256\", \"HS256\"]"));
    assert!(!ok, "must refuse to start");
    assert!(err.contains("[server.auth.issuers.hub]") && err.contains("HS256") && err.contains("symmetric"), "{err}");
}

#[test]
fn an_insecure_jwks_url_stops_the_server() {
    let cfg = config_with_issuer("").replace("https://auth.example.com/jwks.json", "http://auth.example.com/jwks.json");
    let (ok, err) = run_expecting_failure(&cfg);
    assert!(!ok && err.contains("jwks_url") && err.contains("https"), "{err}");
}

#[test]
fn a_rule_for_an_unknown_namespace_stops_the_server() {
    let cfg = config_with_issuer("").replace("namespace = \"team\"", "namespace = \"nope\"");
    let (ok, err) = run_expecting_failure(&cfg);
    assert!(!ok && err.contains("map[0]") && err.contains("nope"), "{err}");
}

#[test]
fn an_issuer_without_rules_stops_the_server() {
    let cfg = r#"
[server.namespaces.team]
rw_token = "t"
[server.auth.issuers.hub]
iss = "https://auth.example.com"
jwks_url = "https://auth.example.com/jwks.json"
audience = "https://copa.example.com"
"#;
    let (ok, err) = run_expecting_failure(cfg);
    assert!(!ok && err.contains("at least one rule"), "{err}");
}

// ── JWT verification and claim mapping (in-process server) ────────────────────

const CONFIG: &str = r#"
[server.namespaces.default]
rw_token = "static-rw"
[server.namespaces.team]
rw_token = "team-static"
[server.namespaces.ops]
rw_token = "ops-static"

[server.auth.issuers.hub]
iss = "https://auth.example.com"
jwks_url = "{JWKS}"
audience = "https://copa.example.com"
leeway_secs = 30
jwks_min_refresh_secs = 0

[[server.auth.issuers.hub.map]]
claim = "scope"
value = "copa:team:rw"
namespace = "team"
access = "rw"

[[server.auth.issuers.hub.map]]
claim = "scope"
value = "copa:team:r"
namespace = "team"
access = "r"

[[server.auth.issuers.hub.map]]
claim = "groups"
value = "copa-readers"
namespace = "default"
access = "r"

[[server.auth.issuers.hub.map]]
claim = "email"
value = "*@example.com"
namespace = "ops"
access = "rw"
"#;

fn server() -> Server {
    start(CONFIG, vec![ec1_jwk(), rsa1_jwk()])
}

fn good(scope: &str) -> String {
    es256("ec1", &claims(scope, 60_000))
}

#[test]
fn a_valid_es256_token_is_accepted_and_mapped() {
    let s = server();
    let t = good("copa:team:rw");
    assert_eq!(s.push(&t, "team", "from jwt"), 200);
    assert_eq!(s.get("/api/clipboard", &t, "team"), 200);
    let (code, body) = s.call("GET", "/api/capabilities", &t, "team", None);
    assert_eq!(code, 200);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!((v["read"].as_bool(), v["write"].as_bool()), (Some(true), Some(true)));
}

#[test]
fn a_valid_rs256_token_is_accepted() {
    let s = server();
    let t = sign(Algorithm::RS256, Some("rsa1"), &rsa1(), &claims("copa:team:rw", 60_000));
    assert_eq!(s.push(&t, "team", "rsa"), 200);
}

#[test]
fn static_tokens_keep_working_next_to_issuers() {
    let s = server();
    assert_eq!(s.push("static-rw", "default", "x"), 200);
    assert_eq!(s.get("/api/clipboard", "team-static", "team"), 200);
    assert_eq!(s.get("/api/clipboard", "nope", "team"), 401);
}

#[test]
fn an_expired_token_is_refused_but_leeway_is_honoured() {
    let s = server();
    let t = es256("ec1", &claims("copa:team:rw", 1_000)); // exp = NOW + 1 s
    assert_eq!(s.get("/api/clipboard", &t, "team"), 200);
    s.advance(1_000 + 29_999); // inside the 30 s leeway
    assert_eq!(s.get("/api/clipboard", &t, "team"), 200);
    s.advance(1); // exp + leeway reached
    assert_eq!(s.get("/api/clipboard", &t, "team"), 401);
}

#[test]
fn a_token_that_is_not_yet_valid_is_refused() {
    let s = server();
    let mut c = claims("copa:team:rw", 600_000);
    c["nbf"] = json!(NOW / 1000 + 120);
    let t = es256("ec1", &c);
    assert_eq!(s.get("/api/clipboard", &t, "team"), 401);
    s.advance(100_000); // within leeway of nbf
    assert_eq!(s.get("/api/clipboard", &t, "team"), 200);
}

#[test]
fn the_wrong_audience_is_refused_and_an_audience_array_containing_ours_is_accepted() {
    let s = server();
    let mut c = claims("copa:team:rw", 60_000);
    c["aud"] = json!("https://other.example");
    assert_eq!(s.get("/api/clipboard", &es256("ec1", &c), "team"), 401);
    c["aud"] = json!(["https://other.example", AUD]);
    assert_eq!(s.get("/api/clipboard", &es256("ec1", &c), "team"), 200);
    c.as_object_mut().unwrap().remove("aud");
    assert_eq!(s.get("/api/clipboard", &es256("ec1", &c), "team"), 401);
}

#[test]
fn an_unknown_issuer_is_refused() {
    let s = server();
    let mut c = claims("copa:team:rw", 60_000);
    c["iss"] = json!("https://evil.example");
    assert_eq!(s.get("/api/clipboard", &es256("ec1", &c), "team"), 401);
    c.as_object_mut().unwrap().remove("iss");
    assert_eq!(s.get("/api/clipboard", &es256("ec1", &c), "team"), 401);
}

#[test]
fn an_unknown_key_id_and_a_bad_signature_are_refused() {
    let s = server();
    assert_eq!(s.get("/api/clipboard", &es256("nope", &claims("copa:team:rw", 60_000)), "team"), 401);
    // right kid, wrong key: signed by ec2, claims to be ec1
    let forged = sign(Algorithm::ES256, Some("ec1"), &ec2(), &claims("copa:team:rw", 60_000));
    assert_eq!(s.get("/api/clipboard", &forged, "team"), 401);
}

#[test]
fn a_tampered_payload_is_refused() {
    let s = server();
    let t = good("copa:team:r");
    let parts: Vec<&str> = t.split('.').collect();
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
    let forged_payload = B64.encode(serde_json::to_vec(&claims("copa:team:rw", 60_000)).unwrap());
    assert_eq!(s.push(&format!("{}.{}.{}", parts[0], forged_payload, parts[2]), "team", "x"), 401);
}

#[test]
fn alg_none_is_refused() {
    let s = server();
    let t = raw_token(&json!({ "alg": "none", "typ": "JWT", "kid": "ec1" }), &claims("copa:team:rw", 60_000), b"");
    assert_eq!(s.get("/api/clipboard", &t, "team"), 401);
    for alg in ["None", "NONE", "nOnE"] {
        let t = raw_token(&json!({ "alg": alg, "kid": "ec1" }), &claims("copa:team:rw", 60_000), b"");
        assert_eq!(s.get("/api/clipboard", &t, "team"), 401, "{alg}");
    }
}

#[test]
fn the_hs256_public_key_confusion_attack_is_refused() {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let s = server();
    // HMAC-SHA256 over the token using the (public) key material as the secret
    let header = json!({ "alg": "HS256", "typ": "JWT", "kid": "rsa1" });
    let body = claims("copa:team:rw", 60_000);
    let unsigned = raw_token(&header, &body, b"");
    let signing_input = unsigned.rsplit_once('.').unwrap().0;
    let mut mac = Hmac::<Sha256>::new_from_slice(keys::RSA1_N.as_bytes()).unwrap();
    mac.update(signing_input.as_bytes());
    let t = raw_token(&header, &body, &mac.finalize().into_bytes());
    assert_eq!(s.get("/api/clipboard", &t, "team"), 401);
}

#[test]
fn an_algorithm_outside_the_issuers_allow_list_is_refused() {
    let cfg = CONFIG.replace("leeway_secs = 30", "leeway_secs = 30\nalgorithms = [\"ES256\"]");
    let s = start(&cfg, vec![ec1_jwk(), rsa1_jwk()]);
    let rs = sign(Algorithm::RS256, Some("rsa1"), &rsa1(), &claims("copa:team:rw", 60_000));
    assert_eq!(s.get("/api/clipboard", &rs, "team"), 401);
    assert_eq!(s.get("/api/clipboard", &good("copa:team:rw"), "team"), 200);
}

#[test]
fn a_token_without_exp_is_refused() {
    let s = server();
    let mut c = claims("copa:team:rw", 60_000);
    c.as_object_mut().unwrap().remove("exp");
    assert_eq!(s.get("/api/clipboard", &es256("ec1", &c), "team"), 401);
    let mut c = claims("copa:team:rw", 60_000);
    c["exp"] = json!("tomorrow");
    assert_eq!(s.get("/api/clipboard", &es256("ec1", &c), "team"), 401);
}

#[test]
fn malformed_bearers_are_refused_without_a_panic() {
    let s = server();
    for bad in ["a.b.c", "....", "e30.e30.", "e30.e30.e30", "x.y", "ey.ey.ey"] {
        let code = s.call("GET", "/api/clipboard", bad, "team", None).0;
        assert!(code == 401 || code == 400, "{bad}: {code}");
    }
    assert_eq!(s.get("/api/clipboard", "a.b.c", "team"), 401);
}

// mapping --------------------------------------------------------------------

#[test]
fn a_read_scope_reads_but_cannot_write() {
    let s = server();
    assert_eq!(s.push("team-static", "team", "seed"), 200);
    let t = good("copa:team:r");
    assert_eq!(s.get("/api/clipboard", &t, "team"), 200);
    assert_eq!(s.push(&t, "team", "nope"), 401);
}

#[test]
fn a_group_claim_maps_to_read_access() {
    let s = server();
    let t = good("something-else"); // groups = ["copa-team"] does not match "copa-readers"
    assert_eq!(s.get("/api/clipboard", &t, "default"), 403);
    let mut c = claims("x", 60_000);
    c["groups"] = json!(["staff", "copa-readers"]);
    let t = es256("ec1", &c);
    assert_eq!(s.get("/api/clipboard", &t, "default"), 200);
    assert_eq!(s.push(&t, "default", "x"), 401, "read-only mapping");
}

#[test]
fn a_glob_rule_on_the_email_claim() {
    let s = server();
    assert_eq!(s.push(&good("whatever"), "ops", "x"), 200);
    let mut c = claims("whatever", 60_000);
    c["email"] = json!("mallory@evil.example");
    assert_eq!(s.get("/api/clipboard", &es256("ec1", &c), "ops"), 403);
}

#[test]
fn rules_are_unioned() {
    let s = server();
    let t = good("copa:team:r copa:team:rw");
    assert_eq!(s.push(&t, "team", "x"), 200);
}

#[test]
fn a_valid_token_without_a_mapping_for_the_namespace_is_forbidden() {
    let s = server();
    let t = good("copa:team:rw");
    for path in ["/api/clipboard", "/api/history", "/api/capabilities"] {
        assert_eq!(s.get(path, &t, "ops"), 200, "mapped via email: {path}"); // sanity: ops is mapped by the email rule
    }
    let mut c = claims("copa:team:rw", 60_000);
    c["email"] = json!("x@evil.example");
    let t = es256("ec1", &c);
    for path in ["/api/clipboard", "/api/history", "/api/capabilities"] {
        assert_eq!(s.get(path, &t, "ops"), 403, "{path}");
    }
    assert_eq!(s.push(&t, "ops", "x"), 403);
    assert_eq!(s.call("POST", "/api/events/ticket", &t, "ops", Some("")).0, 403);
    // a missing namespace is still a 404, and an invalid token still a 401
    assert_eq!(s.get("/api/clipboard", &t, "nope"), 404);
    assert_eq!(s.get("/api/clipboard", "garbage", "ops"), 401);
}

#[test]
fn two_issuers_are_checked_independently() {
    let cfg = format!(
        "{CONFIG}\n[server.auth.issuers.other]\niss = \"https://other.example\"\njwks_url = \"{{JWKS}}\"\naudience = \"https://copa.example.com\"\n\
         [[server.auth.issuers.other.map]]\nclaim = \"scope\"\nvalue = \"read-ops\"\nnamespace = \"ops\"\naccess = \"r\"\n"
    );
    let s = start(&cfg, vec![ec1_jwk()]);
    let mut c = claims("read-ops", 60_000);
    c["iss"] = json!("https://other.example");
    let theirs = es256("ec1", &c);
    assert_eq!(s.get("/api/clipboard", &theirs, "ops"), 200);
    assert_eq!(s.push(&theirs, "ops", "x"), 401, "the other issuer's rule is read-only");
    // the first issuer's mapping does not apply to the second issuer's tokens
    assert_eq!(s.get("/api/clipboard", &theirs, "team"), 403);
    assert_eq!(s.push(&good("copa:team:rw"), "team", "x"), 200);
}

// JWKS behaviour ----------------------------------------------------------------

#[test]
fn key_rotation_is_picked_up_and_the_old_key_keeps_working_during_the_overlap() {
    let s = start(CONFIG, vec![ec1_jwk()]);
    let old = good("copa:team:rw");
    assert_eq!(s.get("/api/clipboard", &old, "team"), 200);
    let new = sign(Algorithm::ES256, Some("ec2"), &ec2(), &claims("copa:team:rw", 60_000));
    assert_eq!(s.get("/api/clipboard", &new, "team"), 401, "not published yet");
    s.jwks.set_keys(vec![ec1_jwk(), ec2_jwk()]);
    assert_eq!(s.get("/api/clipboard", &new, "team"), 200, "unknown kid triggered a refresh");
    assert_eq!(s.get("/api/clipboard", &old, "team"), 200, "overlap");
    s.jwks.set_keys(vec![ec2_jwk()]); // ec1 retired at the issuer
    assert_eq!(s.get("/api/clipboard", &es256("zzz", &claims("copa:team:rw", 60_000)), "team"), 401); // forces a refresh
    assert_eq!(s.get("/api/clipboard", &old, "team"), 401, "retired key no longer verifies");
    assert_eq!(s.get("/api/clipboard", &new, "team"), 200);
}

#[test]
fn a_failing_jwks_keeps_cached_keys_working() {
    let cfg = CONFIG.replace("jwks_min_refresh_secs = 0", "jwks_min_refresh_secs = 0\njwks_ttl_secs = 1");
    let s = start(&cfg, vec![ec1_jwk()]);
    let t = good("copa:team:rw");
    assert_eq!(s.get("/api/clipboard", &t, "team"), 200);
    s.jwks.set_down(true);
    std::thread::sleep(Duration::from_millis(1100)); // cache is now stale
    let before = s.jwks.hits();
    assert_eq!(s.get("/api/clipboard", &t, "team"), 200, "served from the stale cache");
    assert!(s.jwks.hits() > before, "a refresh was attempted");
}

#[test]
fn a_jwks_that_is_down_at_first_use_recovers_later() {
    let s = start(CONFIG, vec![ec1_jwk()]);
    s.jwks.set_down(true);
    let t = good("copa:team:rw");
    assert_eq!(s.get("/api/clipboard", &t, "team"), 401);
    s.jwks.set_down(false);
    assert_eq!(s.get("/api/clipboard", &t, "team"), 200);
}

#[test]
fn bogus_key_ids_cannot_flood_the_issuer() {
    let cfg = CONFIG.replace("jwks_min_refresh_secs = 0", "jwks_min_refresh_secs = 60");
    let s = start(&cfg, vec![ec1_jwk()]);
    assert_eq!(s.get("/api/clipboard", &good("copa:team:rw"), "team"), 200);
    for i in 0..60 {
        assert_eq!(s.get("/api/clipboard", &es256(&format!("bogus{i}"), &claims("copa:team:rw", 60_000)), "team"), 401);
    }
    assert!(s.jwks.hits() <= 2, "only the initial fetch (plus at most one refresh), got {}", s.jwks.hits());
}

// tickets and event streams -----------------------------------------------------

#[test]
fn an_event_stream_opened_with_a_jwt_ticket_ends_when_the_token_expires() {
    let s = server();
    let t = es256("ec1", &claims("copa:team:rw", 400)); // valid 400 ms
    let (code, body) = s.call("POST", "/api/events/ticket", &t, "team", Some(""));
    assert_eq!(code, 200, "{body}");
    let ticket = serde_json::from_str::<serde_json::Value>(&body).unwrap()["ticket"].as_str().unwrap().to_owned();
    let mut ws = s.ws(&format!("/ws/events?namespace=team&ticket={ticket}")).unwrap();
    set_timeout(&ws, 100);
    assert!(!is_closed(&mut ws), "open while the token is valid");
    set_timeout(&ws, 1500);
    std::thread::sleep(Duration::from_millis(500));
    assert!(is_closed(&mut ws), "closed when the token expired");
}

#[test]
fn the_ticket_endpoint_needs_read_access_through_the_mapping() {
    let s = server();
    let mut c = claims("copa:team:rw", 60_000);
    c["scope"] = json!("unrelated");
    c["email"] = json!("x@evil.example");
    assert_eq!(s.call("POST", "/api/events/ticket", &es256("ec1", &c), "team", Some("")).0, 403);
    assert_eq!(s.call("POST", "/api/events/ticket", &good("copa:team:r"), "team", Some("")).0, 200);
}

// ── logs never contain credentials (real binary, captured stderr) ─────────────

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn real_claims(scope: &str, ttl_secs: i64) -> serde_json::Value {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    json!({
        "iss": ISS, "aud": AUD, "sub": "alice", "email": "alice@example.com", "scope": scope,
        "iat": now, "nbf": now - 5, "exp": now + ttl_secs,
    })
}

#[test]
fn the_server_log_explains_rejections_without_ever_containing_a_credential() {
    const STATIC_SECRET: &str = "team-static-secret-xyz-123456";
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let jwks = JwksServer::start(&rt, vec![ec1_jwk()]);
    let dir = tempfile::tempdir().unwrap();
    let web = fake_web_app();
    let cfg_path = dir.path().join("config.toml");
    let cfg = CONFIG
        .replace("{JWKS}", &jwks.url)
        .replace("rw_token = \"team-static\"", &format!("rw_token = \"{STATIC_SECRET}\""));
    std::fs::write(&cfg_path, cfg).unwrap();
    let log_path = dir.path().join("server.log");
    let port = free_port();
    let mut child = Command::new(COPASRV)
        .args(["--config", cfg_path.to_str().unwrap(), "--port", &port.to_string(), "--bind", "127.0.0.1", "--static-dir", web.path().to_str().unwrap()])
        .stderr(std::fs::File::create(&log_path).unwrap())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let base = format!("http://127.0.0.1:{port}");
    let up = (0..100).any(|_| {
        std::thread::sleep(Duration::from_millis(50));
        ureq::get(&format!("{base}/api/version")).call().is_ok()
    });
    assert!(up, "copasrv did not start");

    let call = |token: &str, path: &str, ns: &str| -> u16 {
        let mut r = ureq::get(&format!("{base}{path}")).set("X-Copa-Namespace", ns);
        if !token.is_empty() {
            r = r.set("Authorization", &format!("Bearer {token}"));
        }
        match r.call() {
            Ok(r) => r.status(),
            Err(ureq::Error::Status(c, _)) => c,
            Err(e) => panic!("{e}"),
        }
    };

    let valid = es256("ec1", &real_claims("copa:team:rw", 600));
    let expired = es256("ec1", &real_claims("copa:team:rw", -3600));
    let mut wrong_aud = real_claims("copa:team:rw", 600);
    wrong_aud["aud"] = json!("https://other.example");
    let wrong_aud = es256("ec1", &wrong_aud);
    let forged = sign(Algorithm::ES256, Some("ec1"), &ec2(), &real_claims("copa:team:rw", 600));
    let unmapped = {
        let mut c = real_claims("nothing", 600);
        c["email"] = json!("x@evil.example");
        es256("ec1", &c)
    };
    let none_alg = raw_token(&json!({ "alg": "none", "kid": "ec1" }), &real_claims("copa:team:rw", 600), b"");
    let unknown_kid = es256("not-published", &real_claims("copa:team:rw", 600));
    let wrong_static = "definitely-not-the-static-token-98765";

    assert_eq!(call(&valid, "/api/clipboard", "team"), 200);
    assert_eq!(call(&expired, "/api/clipboard", "team"), 401);
    assert_eq!(call(&wrong_aud, "/api/clipboard", "team"), 401);
    assert_eq!(call(&forged, "/api/clipboard", "team"), 401);
    assert_eq!(call(&unmapped, "/api/clipboard", "ops"), 403);
    assert_eq!(call(&none_alg, "/api/clipboard", "team"), 401);
    assert_eq!(call(&unknown_kid, "/api/clipboard", "team"), 401);
    assert_eq!(call(wrong_static, "/api/clipboard", "default"), 401);
    assert_eq!(call(STATIC_SECRET, "/api/clipboard", "team"), 200);
    // the legacy ?token= path and the ticket flow must not leak either
    assert_eq!(call("", &format!("/api/clipboard?token={valid}"), "team"), 200);
    let ticket = ureq::post(&format!("{base}/api/events/ticket"))
        .set("Authorization", &format!("Bearer {valid}"))
        .set("X-Copa-Namespace", "team")
        .send_string("")
        .unwrap()
        .into_json::<serde_json::Value>()
        .unwrap()["ticket"]
        .as_str()
        .unwrap()
        .to_owned();
    let _ws = tokio_tungstenite::tungstenite::connect(format!("ws://127.0.0.1:{port}/ws/events?namespace=team&ticket={ticket}")).unwrap();
    std::thread::sleep(Duration::from_millis(200));

    let _ = child.kill();
    let _ = child.wait();
    let log = std::fs::read_to_string(&log_path).unwrap();

    // 1. the log explains what happened ...
    for reason in ["token expired", "claim check failed: aud", "signature does not verify", "no mapping for namespace 'ops'",
                   "algorithm", "no matching signing key"] {
        assert!(log.contains(reason), "log should mention {reason:?}:\n{log}");
    }
    // 2. ... and never contains a credential, in whole or in part
    let mut secrets: Vec<&str> = vec![&valid, &expired, &wrong_aud, &forged, &unmapped, &none_alg, &unknown_kid,
                                      wrong_static, STATIC_SECRET, &ticket];
    let mut pieces: Vec<String> = Vec::new();
    for t in [&valid, &expired, &wrong_aud, &forged, &unmapped, &unknown_kid] {
        pieces.extend(t.split('.').filter(|p| p.len() > 12).map(str::to_owned));
    }
    secrets.extend(pieces.iter().map(String::as_str));
    for secret in secrets {
        assert!(!log.contains(secret), "the log leaks {:?}…:\n{log}", &secret[..secret.len().min(20)]);
    }
    assert!(!log.to_lowercase().contains("bearer "), "the Authorization header must never be logged:\n{log}");
    assert!(!log.contains("token="), "query strings with tokens must never be logged:\n{log}");
}
