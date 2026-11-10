//! `/api/pair/*`: windows, devices, renewal and (further down) the key exchanges.
mod support;

use serde_json::{json, Value};
use support::*;

fn config(pairing: &str) -> String {
    format!(
        r#"
[server.namespaces.default]
rw_token = "rw"
read_token = "ro"
[server.namespaces.other]
rw_token = "other-rw"
{pairing}"#
    )
}

const ENABLED: &str = "[server.pairing]\nenabled = true\nstate_dir = \"{STATE}\"\n";

fn server(pairing: &str) -> Server {
    start(&config(pairing), vec![])
}

fn open_window(s: &Server, token: &str, body: Value) -> (u16, Value) {
    let (code, text) = s.call("POST", "/api/pair/windows", token, "default", Some(&body.to_string()));
    (code, serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn enroll(s: &Server, ns: &str, acc: &str, ttl_ms: u64) -> (String, String) {
    let (t, rec) = s.state.tokens.as_ref().unwrap().enroll("test device", ns, acc, ttl_ms, NOW).unwrap();
    (t, rec.dev)
}

// ── disabled ──────────────────────────────────────────────────────────────────

#[test]
fn everything_is_404_when_pairing_is_disabled() {
    for cfg in ["", "[server.pairing]\nenabled = false\n"] {
        let s = server(cfg);
        assert!(s.state.pairing.is_none() && s.state.tokens.is_none());
        assert_eq!(s.call("POST", "/api/pair/windows", "rw", "default", Some("{}")).0, 404);
        assert_eq!(s.call("GET", "/api/pair/devices", "rw", "default", None).0, 404);
        assert_eq!(s.call("DELETE", "/api/pair/devices/x", "rw", "default", None).0, 404);
        assert_eq!(s.call("POST", "/api/pair/renew", "rw", "default", Some("")).0, 404);
        // and a 404 does not depend on credentials: nothing about the feature leaks
        assert_eq!(s.call("POST", "/api/pair/windows", "", "default", Some("{}")).0, 404);
    }
}

// ── opening windows ───────────────────────────────────────────────────────────

#[test]
fn a_writer_opens_a_window_and_gets_a_code() {
    let s = server(ENABLED);
    let (code, w) = open_window(&s, "rw", json!({ "access": "r", "name": "kitchen tablet" }));
    assert_eq!(code, 200, "{w}");
    assert_eq!((w["namespace"].as_str(), w["access"].as_str()), (Some("default"), Some("r")));
    let (id, secret) = (w["window_id"].as_str().unwrap(), w["code"].as_str().unwrap());
    assert_eq!(id.len(), 6);
    assert!(secret.len() == 8 && secret.bytes().all(|b| b.is_ascii_digit()));
    assert_eq!(w["display_code"], format!("{id}-{secret}"));
    assert_eq!(w["expires_at"].as_u64(), Some(NOW + 120_000));
}

#[test]
fn the_default_access_is_read_write_and_an_empty_body_is_fine() {
    let s = server(ENABLED);
    let (code, text) = s.call("POST", "/api/pair/windows", "rw", "default", Some(""));
    assert_eq!(code, 200, "{text}");
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap()["access"], "rw");
}

#[test]
fn only_writers_may_open_windows() {
    let s = server(ENABLED);
    assert_eq!(open_window(&s, "", json!({})).0, 401);
    assert_eq!(open_window(&s, "wrong", json!({})).0, 401);
    assert_eq!(open_window(&s, "ro", json!({})).0, 401, "a read-only token must not admit new devices");
    assert_eq!(open_window(&s, "other-rw", json!({})).0, 401, "another namespace's token");
    // a read-only *device* cannot either
    let (t, _) = enroll(&s, "default", "r", 60_000);
    assert_eq!(open_window(&s, &t, json!({})).0, 401);
    // a read-write device can
    let (t, _) = enroll(&s, "default", "rw", 60_000);
    assert_eq!(open_window(&s, &t, json!({})).0, 200);
}

#[test]
fn invalid_access_levels_are_refused() {
    let s = server(ENABLED);
    for bad in ["admin", "RW", "", "rwx", "x"] {
        assert_eq!(open_window(&s, "rw", json!({ "access": bad })).0, 400, "{bad:?}");
    }
}

#[test]
fn the_number_of_open_windows_is_capped() {
    let s = server(ENABLED);
    for i in 0..16 {
        assert_eq!(open_window(&s, "rw", json!({})).0, 200, "window {i}");
        if i % 8 == 7 {
            s.advance(1); // keep the rate limiter happy: the cap is what is tested
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    // (the limiter allows 30 per 10 s; 16 + 1 stay well below it)
    assert_eq!(open_window(&s, "rw", json!({})).0, 429);
    s.advance(121_000);
    assert_eq!(open_window(&s, "rw", json!({})).0, 200, "expired windows free their slots");
}

// ── rate limiting ─────────────────────────────────────────────────────────────

#[test]
fn a_flood_from_one_source_is_answered_with_429_and_retry_after() {
    let s = server(ENABLED);
    let mut limited = None;
    for i in 0..60 {
        let r = ureq::get(&format!("{}/api/pair/devices", s.url)).set("Authorization", "Bearer rw").set("X-Copa-Namespace", "default").call();
        match r {
            Ok(_) => {}
            Err(ureq::Error::Status(429, resp)) => {
                limited = Some((i, resp.header("Retry-After").map(str::to_owned)));
                break;
            }
            Err(e) => panic!("{e}"),
        }
    }
    let (at, retry) = limited.expect("the flood must be limited");
    assert_eq!(at, 30, "30 requests per 10 s are allowed");
    assert_eq!(retry.as_deref(), Some("10"));
    s.advance(10_001);
    assert_eq!(s.call("GET", "/api/pair/devices", "rw", "default", None).0, 200, "recovers after the window");
}

// ── devices ───────────────────────────────────────────────────────────────────

#[test]
fn devices_are_listed_without_secrets_and_scoped_to_the_namespace() {
    let s = server(ENABLED);
    let (token, dev) = enroll(&s, "default", "rw", 60_000);
    enroll(&s, "other", "r", 60_000);
    let (code, text) = s.call("GET", "/api/pair/devices", "rw", "default", None);
    assert_eq!(code, 200);
    let list: Vec<Value> = serde_json::from_str(&text).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0]["dev"].as_str(), list[0]["ns"].as_str(), list[0]["acc"].as_str()), (Some(dev.as_str()), Some("default"), Some("rw")));
    assert!(!text.contains(&token) && !text.contains("secret"), "{text}");
    assert_eq!(s.call("GET", "/api/pair/devices", "ro", "default", None).0, 401);
    assert_eq!(s.call("GET", "/api/pair/devices", "", "default", None).0, 401);
}

#[test]
fn revoking_a_device_cuts_it_off_and_leaves_the_others() {
    let s = server(ENABLED);
    let (a, da) = enroll(&s, "default", "rw", 60_000);
    let (b, _) = enroll(&s, "default", "rw", 60_000);
    assert_eq!(s.get("/api/clipboard", &a, "default"), 200);
    assert_eq!(s.call("DELETE", &format!("/api/pair/devices/{da}"), "rw", "default", None).0, 200);
    assert_eq!(s.get("/api/clipboard", &a, "default"), 401);
    assert_eq!(s.get("/api/clipboard", &b, "default"), 200);
    let list: Vec<Value> = serde_json::from_str(&s.call("GET", "/api/pair/devices", "rw", "default", None).1).unwrap();
    assert_eq!(list.iter().find(|d| d["dev"] == da.as_str()).unwrap()["revoked"], true);
}

#[test]
fn revoking_needs_write_access_and_respects_namespaces() {
    let s = server(ENABLED);
    let (_, dev) = enroll(&s, "default", "rw", 60_000);
    assert_eq!(s.call("DELETE", &format!("/api/pair/devices/{dev}"), "ro", "default", None).0, 401);
    assert_eq!(s.call("DELETE", &format!("/api/pair/devices/{dev}"), "other-rw", "other", None).0, 404, "not visible from another namespace");
    assert_eq!(s.call("DELETE", "/api/pair/devices/nope", "rw", "default", None).0, 404);
}

// ── renewal ───────────────────────────────────────────────────────────────────

#[test]
fn renewal_is_off_unless_configured() {
    let s = server(ENABLED);
    let (t, _) = enroll(&s, "default", "rw", 60_000);
    assert_eq!(s.call("POST", "/api/pair/renew", &t, "default", Some("")).0, 404);
}

#[test]
fn a_valid_device_token_buys_a_fresh_one_when_renewal_is_enabled() {
    let s = server(&format!("{ENABLED}sliding_renewal = true\ndevice_ttl_secs = 600\n"));
    let (t, dev) = enroll(&s, "default", "rw", 60_000);
    s.advance(50_000);
    let (code, text) = s.call("POST", "/api/pair/renew", &t, "default", Some(""));
    assert_eq!(code, 200, "{text}");
    let v: Value = serde_json::from_str(&text).unwrap();
    let fresh = v["token"].as_str().unwrap().to_owned();
    assert_eq!(v["expires_at"].as_u64(), Some(NOW + 50_000 + 600_000));
    s.advance(20_000); // the old token has expired by now, the new one has not
    assert_eq!(s.get("/api/clipboard", &t, "default"), 401);
    assert_eq!(s.get("/api/clipboard", &fresh, "default"), 200);
    // the record follows the device
    let list: Vec<Value> = serde_json::from_str(&s.call("GET", "/api/pair/devices", "rw", "default", None).1).unwrap();
    assert_eq!(list[0]["dev"], dev.as_str());
}

#[test]
fn expired_revoked_and_garbage_tokens_cannot_renew() {
    let s = server(&format!("{ENABLED}sliding_renewal = true\n"));
    let (t, dev) = enroll(&s, "default", "rw", 1_000);
    s.advance(1_000);
    assert_eq!(s.call("POST", "/api/pair/renew", &t, "default", Some("")).0, 401);
    let (t2, dev2) = enroll(&s, "default", "rw", 600_000);
    s.state.tokens.as_ref().unwrap().revoke(&dev2).unwrap();
    assert_eq!(s.call("POST", "/api/pair/renew", &t2, "default", Some("")).0, 401);
    for bad in ["", "rw", "v1.a.b", "garbage"] {
        assert_eq!(s.call("POST", "/api/pair/renew", bad, "default", Some("")).0, 401, "{bad:?}");
    }
    let _ = dev;
}

#[test]
fn a_static_token_cannot_renew() {
    let s = server(&format!("{ENABLED}sliding_renewal = true\n"));
    assert_eq!(s.call("POST", "/api/pair/renew", "rw", "default", Some("")).0, 401);
}

#[test]
fn invalid_pairing_settings_stop_the_server_from_building() {
    for bad in ["window_ttl_secs = 0", "max_attempts = 0", "device_ttl_secs = 0"] {
        let cfg: copa::server::config::ConfigFile = toml::from_str(&config(&format!("[server.pairing]\nenabled = true\n{bad}\n"))).unwrap();
        let r = copa::server::state::build_app_state(&cfg.server, None, std::sync::Arc::new(|| 0), 0, "127.0.0.1");
        assert!(r.is_err(), "{bad}");
    }
}

#[test]
fn a_malformed_body_is_a_400_not_silently_the_defaults() {
    let s = server(ENABLED);
    for bad in ["{nope", "[]", "\"rw\"", "{\"access\": 5}"] {
        assert_eq!(s.call("POST", "/api/pair/windows", "rw", "default", Some(bad)).0, 400, "{bad}");
    }
}

// ── SPAKE2 pairing ────────────────────────────────────────────────────────────

use copa::server::pair_crypto as pc;
use spake2::{Ed25519Group, Identity, Password, Spake2};

struct Paired {
    token: String,
    json:  Value,
}

/// What a device does, step by step. `code` is what the user typed.
fn spake2_start(s: &Server, window_id: &str, code: &str) -> Result<(String, pc::Keys, Vec<u8>, Vec<u8>), (u16, String)> {
    let (spake, msg_a) = Spake2::<Ed25519Group>::start_a(&Password::new(code.as_bytes()), &Identity::new(b"copa-widget"), &Identity::new(b"copa-server"));
    let body = json!({ "window_id": window_id, "msg": pc::b64(&msg_a) }).to_string();
    let (status, text) = s.call("POST", "/api/pair/spake2/start", "", "default", Some(&body));
    if status != 200 {
        return Err((status, text));
    }
    let v: Value = serde_json::from_str(&text).unwrap();
    let msg_b = pc::unb64(v["msg"].as_str().unwrap()).unwrap();
    let key = spake.finish(&msg_b).expect("a valid server message");
    let t = pc::transcript("spake2", &[window_id.as_bytes(), &msg_a, &msg_b]);
    Ok((v["session_id"].as_str().unwrap().to_owned(), pc::derive(&key, t), msg_a, msg_b))
}

fn spake2_confirm(s: &Server, session_id: &str, keys: &pc::Keys, name: Option<&str>) -> (u16, String) {
    let mac = pc::mac(&keys.client_mac, pc::LABEL_CLIENT, &keys.transcript);
    let mut body = json!({ "session_id": session_id, "mac": pc::b64(&mac) });
    if let Some(n) = name {
        body["name"] = json!(n);
    }
    s.call("POST", "/api/pair/spake2/confirm", "", "default", Some(&body.to_string()))
}

fn pair(s: &Server, w: &Value, code: &str) -> Result<Paired, (u16, String)> {
    let (sid, keys, _, _) = spake2_start(s, w["window_id"].as_str().unwrap(), code)?;
    let (status, text) = spake2_confirm(s, &sid, &keys, None);
    if status != 200 {
        return Err((status, text));
    }
    let v: Value = serde_json::from_str(&text).unwrap();
    let server_mac = pc::unb64(v["mac"].as_str().unwrap()).unwrap();
    assert!(pc::mac_matches(&pc::mac(&keys.server_mac, pc::LABEL_SERVER, &keys.transcript), &server_mac), "the server proves it knew the key");
    let plain = pc::open(&keys.enc, &keys.transcript, &pc::unb64(v["sealed"].as_str().unwrap()).unwrap()).expect("sealed credential opens");
    let json: Value = serde_json::from_slice(&plain).unwrap();
    Ok(Paired { token: json["token"].as_str().unwrap().to_owned(), json })
}

fn window(s: &Server, access: &str) -> Value {
    let (code, w) = open_window(s, "rw", json!({ "access": access, "name": "kitchen tablet" }));
    assert_eq!(code, 200);
    w
}

#[test]
fn the_right_code_pairs_a_device_that_can_then_use_the_namespace() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let p = pair(&s, &w, w["code"].as_str().unwrap()).expect("pairing succeeds");
    assert_eq!((p.json["namespace"].as_str(), p.json["access"].as_str()), (Some("default"), Some("rw")));
    assert_eq!(p.json["expires_at"].as_u64(), Some(NOW + 86_400_000));
    assert_eq!(s.push(&p.token, "default", "from the new device"), 200);
    assert_eq!(s.get("/api/clipboard", &p.token, "default"), 200);
    assert_eq!(s.get("/api/clipboard", &p.token, "other"), 401, "bound to the window's namespace");
    let list: Vec<Value> = serde_json::from_str(&s.call("GET", "/api/pair/devices", "rw", "default", None).1).unwrap();
    assert_eq!((list.len(), list[0]["name"].as_str()), (1, Some("kitchen tablet")));
}

#[test]
fn the_window_decides_the_access_level() {
    let s = server(ENABLED);
    let w = window(&s, "r");
    let p = pair(&s, &w, w["code"].as_str().unwrap()).unwrap();
    assert_eq!(s.get("/api/clipboard", &p.token, "default"), 200);
    assert_eq!(s.push(&p.token, "default", "x"), 401);
}

#[test]
fn the_device_may_label_itself() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let (sid, keys, ..) = spake2_start(&s, w["window_id"].as_str().unwrap(), w["code"].as_str().unwrap()).unwrap();
    assert_eq!(spake2_confirm(&s, &sid, &keys, Some("Pixel 9")).0, 200);
    let list: Vec<Value> = serde_json::from_str(&s.call("GET", "/api/pair/devices", "rw", "default", None).1).unwrap();
    assert_eq!(list[0]["name"], "Pixel 9");
}

#[test]
fn a_window_pairs_one_device_only() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let code = w["code"].as_str().unwrap();
    assert!(pair(&s, &w, code).is_ok());
    assert_eq!(pair(&s, &w, code).err().map(|e| e.0), Some(403), "the same code cannot be used twice");
}

#[test]
fn a_wrong_code_gets_nothing() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let err = pair(&s, &w, "00000000").err().expect("must fail");
    assert_eq!(err.0, 403);
    assert!(err.1.contains("pairing failed") && !err.1.contains("token"));
    assert!(serde_json::from_str::<Vec<Value>>(&s.call("GET", "/api/pair/devices", "rw", "default", None).1).unwrap().is_empty());
}

#[test]
fn five_wrong_codes_close_the_window_even_for_the_right_code() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    for i in 0..5 {
        s.advance(10_000 / 5 + 1); // stay clear of the rate limiter
        let guess = format!("{:08}", i);
        assert_eq!(pair(&s, &w, &guess).err().map(|e| e.0), Some(403));
    }
    s.advance(10_001);
    assert_eq!(pair(&s, &w, w["code"].as_str().unwrap()).err().map(|e| e.0), Some(403), "the window is closed after five failures");
}

#[test]
fn failures_before_the_limit_do_not_stop_the_right_code() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    for g in ["11111111", "22222222"] {
        assert!(pair(&s, &w, g).is_err());
    }
    assert!(pair(&s, &w, w["code"].as_str().unwrap()).is_ok());
}

#[test]
fn a_confirmation_cannot_be_replayed() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let (sid, keys, ..) = spake2_start(&s, w["window_id"].as_str().unwrap(), w["code"].as_str().unwrap()).unwrap();
    assert_eq!(spake2_confirm(&s, &sid, &keys, None).0, 200);
    assert_eq!(spake2_confirm(&s, &sid, &keys, None).0, 403, "the session is spent");
}

#[test]
fn a_tampered_confirmation_is_refused_and_counts_as_a_failure() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let (sid, keys, ..) = spake2_start(&s, w["window_id"].as_str().unwrap(), w["code"].as_str().unwrap()).unwrap();
    let mut mac = pc::mac(&keys.client_mac, pc::LABEL_CLIENT, &keys.transcript);
    mac[0] ^= 1;
    let body = json!({ "session_id": sid, "mac": pc::b64(&mac) }).to_string();
    assert_eq!(s.call("POST", "/api/pair/spake2/confirm", "", "default", Some(&body)).0, 403);
    assert_eq!(s.call("POST", "/api/pair/spake2/confirm", "", "default", Some(&json!({ "session_id": "nope", "mac": "AAAA" }).to_string())).0, 403);
}

#[test]
fn the_server_answers_a_decoy_for_windows_that_do_not_exist_or_have_expired() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let id = w["window_id"].as_str().unwrap();
    // a real window and a made-up one answer the same way at the start ...
    let real = s.call("POST", "/api/pair/spake2/start", "", "default", Some(&json!({ "window_id": id, "msg": pc::b64(&spake_msg()) }).to_string()));
    let fake = s.call("POST", "/api/pair/spake2/start", "", "default", Some(&json!({ "window_id": "ZZZZZZ", "msg": pc::b64(&spake_msg()) }).to_string()));
    assert_eq!((real.0, fake.0), (200, 200));
    let keys = |t: &str| -> Vec<String> { let mut k: Vec<_> = serde_json::from_str::<Value>(t).unwrap().as_object().unwrap().keys().cloned().collect(); k.sort(); k };
    assert_eq!(keys(&real.1), keys(&fake.1));
    // ... and the made-up one can never be confirmed, not even with the real code
    assert_eq!(pair(&s, &json!({ "window_id": "ZZZZZZ" }), w["code"].as_str().unwrap()).err().map(|e| e.0), Some(403));
    // expiry behaves the same way
    s.advance(121_000);
    assert_eq!(pair(&s, &w, w["code"].as_str().unwrap()).err().map(|e| e.0), Some(403));
}

fn spake_msg() -> Vec<u8> {
    Spake2::<Ed25519Group>::start_a(&Password::new(b"x"), &Identity::new(b"copa-widget"), &Identity::new(b"copa-server")).1
}

#[test]
fn a_started_exchange_must_be_confirmed_within_thirty_seconds() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let (sid, keys, ..) = spake2_start(&s, w["window_id"].as_str().unwrap(), w["code"].as_str().unwrap()).unwrap();
    s.advance(30_001);
    assert_eq!(spake2_confirm(&s, &sid, &keys, None).0, 403);
}

#[test]
fn malformed_start_messages_are_rejected() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let id = w["window_id"].as_str().unwrap();
    let mut wrong_side = spake_msg();
    wrong_side[0] = 0x42;
    for msg in ["", "AAAA", &pc::b64(&[0u8; 33]), &pc::b64(&wrong_side), &pc::b64(&spake_msg()[..32]), "!!!"] {
        let body = json!({ "window_id": id, "msg": msg }).to_string();
        let code = s.call("POST", "/api/pair/spake2/start", "", "default", Some(&body)).0;
        assert!(code == 400, "{msg:?}: {code}");
    }
    assert_eq!(s.call("POST", "/api/pair/spake2/start", "", "default", Some("not json")).0, 400);
}

#[test]
fn pending_exchanges_per_window_are_bounded() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let id = w["window_id"].as_str().unwrap();
    let mut codes = vec![];
    for i in 0..10 {
        if i == 5 {
            s.advance(10_001); // stay clear of the rate limiter
        }
        codes.push(spake2_start(&s, id, "00000000").map(|_| 200).unwrap_or_else(|e| e.0));
    }
    assert_eq!(&codes[..8], &[200; 8]);
    assert!(codes[8..].iter().all(|c| *c == 429), "{codes:?}");
}

#[test]
fn the_secret_never_appears_in_any_response_and_the_credential_only_in_the_sealed_box() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let code = w["code"].as_str().unwrap();
    let (sid, keys, ..) = spake2_start(&s, w["window_id"].as_str().unwrap(), code).unwrap();
    let (status, text) = spake2_confirm(&s, &sid, &keys, None);
    assert_eq!(status, 200);
    assert!(!text.contains(code) && !text.contains("\"token\""), "{text}");
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v.as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>(), ["mac", "sealed"].map(String::from).into());
    // a party without the exchange's key cannot open it
    let other = pc::derive(b"not the key", keys.transcript);
    assert!(pc::open(&other.enc, &keys.transcript, &pc::unb64(v["sealed"].as_str().unwrap()).unwrap()).is_none());
}

#[test]
fn the_exchange_endpoints_are_404_when_pairing_is_disabled() {
    let s = server("");
    let body = json!({ "window_id": "AAAAAA", "msg": pc::b64(&spake_msg()) }).to_string();
    assert_eq!(s.call("POST", "/api/pair/spake2/start", "", "default", Some(&body)).0, 404);
    assert_eq!(s.call("POST", "/api/pair/spake2/confirm", "", "default", Some("{}")).0, 404);
}

// ── ECDH pairing with operator confirmation ───────────────────────────────────

use p256::{ecdh::EphemeralSecret, elliptic_curve::sec1::ToEncodedPoint, PublicKey};

struct Device {
    secret:  EphemeralSecret,
    public:  Vec<u8>,
}

impl Device {
    fn new() -> Self {
        let secret = EphemeralSecret::random(&mut rand::thread_rng());
        let public = secret.public_key().to_encoded_point(false).as_bytes().to_vec();
        Self { secret, public }
    }
}

struct Started {
    session_id:  String,
    fingerprint: String,
    keys:        pc::Keys,
}

fn ecdh_start(s: &Server, window_id: &str, dev: &Device) -> Result<Started, (u16, String)> {
    let body = json!({ "window_id": window_id, "pub": pc::b64(&dev.public) }).to_string();
    let (status, text) = s.call("POST", "/api/pair/ecdh/start", "", "default", Some(&body));
    if status != 200 {
        return Err((status, text));
    }
    let v: Value = serde_json::from_str(&text).unwrap();
    let server_pub = pc::unb64(v["pub"].as_str().unwrap()).unwrap();
    let shared = dev.secret.diffie_hellman(&PublicKey::from_sec1_bytes(&server_pub).unwrap());
    let t = pc::transcript("ecdh", &[window_id.as_bytes(), &dev.public, &server_pub]);
    let keys = pc::derive(shared.raw_secret_bytes().as_slice(), t);
    // the device computes the fingerprint itself — it is not taken from the server's answer
    let fingerprint = pc::fingerprint(&t);
    assert_eq!(v["fingerprint"], fingerprint.as_str(), "both sides agree on the fingerprint");
    Ok(Started { session_id: v["session_id"].as_str().unwrap().to_owned(), fingerprint, keys })
}

fn ecdh_poll(s: &Server, st: &Started, name: Option<&str>) -> (u16, Value) {
    let mac = pc::mac(&st.keys.client_mac, pc::LABEL_CLIENT, &st.keys.transcript);
    let mut body = json!({ "session_id": st.session_id, "mac": pc::b64(&mac) });
    if let Some(n) = name {
        body["name"] = json!(n);
    }
    let (code, text) = s.call("POST", "/api/pair/ecdh/result", "", "default", Some(&body.to_string()));
    (code, serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn pending(s: &Server) -> Vec<Value> {
    let (code, text) = s.call("GET", "/api/pair/pending", "rw", "default", None);
    assert_eq!(code, 200, "{text}");
    serde_json::from_str(&text).unwrap()
}

fn decide(s: &Server, id: &str, verb: &str, body: Option<Value>) -> u16 {
    s.call("POST", &format!("/api/pair/pending/{id}/{verb}"), "rw", "default", Some(&body.map(|b| b.to_string()).unwrap_or_default())).0
}

fn collect(s: &Server, st: &Started) -> Paired {
    let (code, v) = ecdh_poll(s, st, None);
    assert_eq!((code, v["status"].as_str()), (200, Some("approved")), "{v}");
    let server_mac = pc::unb64(v["mac"].as_str().unwrap()).unwrap();
    assert!(pc::mac_matches(&pc::mac(&st.keys.server_mac, pc::LABEL_SERVER, &st.keys.transcript), &server_mac));
    let plain = pc::open(&st.keys.enc, &st.keys.transcript, &pc::unb64(v["sealed"].as_str().unwrap()).unwrap()).unwrap();
    let json: Value = serde_json::from_slice(&plain).unwrap();
    Paired { token: json["token"].as_str().unwrap().to_owned(), json }
}

#[test]
fn the_operator_sees_the_same_fingerprint_as_the_device_and_approves() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let dev = Device::new();
    let st = ecdh_start(&s, w["window_id"].as_str().unwrap(), &dev).unwrap();
    assert_eq!(ecdh_poll(&s, &st, None).1["status"], "pending");

    let p = pending(&s);
    assert_eq!(p.len(), 1);
    assert_eq!(p[0]["fingerprint"], st.fingerprint.as_str());
    assert_eq!(p[0]["window_id"], w["window_id"]);
    assert_eq!(decide(&s, p[0]["id"].as_str().unwrap(), "approve", None), 200);

    let paired = collect(&s, &st);
    assert_eq!((paired.json["namespace"].as_str(), paired.json["access"].as_str()), (Some("default"), Some("rw")));
    assert_eq!(s.push(&paired.token, "default", "via ecdh"), 200);
    assert!(pending(&s).is_empty());
    // the credential is delivered once
    assert_eq!(ecdh_poll(&s, &st, None).0, 403);
}

#[test]
fn nothing_is_issued_before_the_operator_decides() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let st = ecdh_start(&s, w["window_id"].as_str().unwrap(), &Device::new()).unwrap();
    for _ in 0..3 {
        let (code, v) = ecdh_poll(&s, &st, None);
        assert_eq!((code, v["status"].as_str()), (200, Some("pending")));
        assert!(v.get("sealed").is_none() && v.get("token").is_none());
    }
    assert!(serde_json::from_str::<Vec<Value>>(&s.call("GET", "/api/pair/devices", "rw", "default", None).1).unwrap().is_empty());
}

#[test]
fn a_rejected_pairing_gets_denied_and_nothing_else() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let st = ecdh_start(&s, w["window_id"].as_str().unwrap(), &Device::new()).unwrap();
    assert_eq!(decide(&s, pending(&s)[0]["id"].as_str().unwrap(), "reject", None), 200);
    let (code, v) = ecdh_poll(&s, &st, None);
    assert_eq!((code, v["status"].as_str()), (200, Some("denied")));
    assert_eq!(ecdh_poll(&s, &st, None).0, 403, "and it is gone");
    assert!(serde_json::from_str::<Vec<Value>>(&s.call("GET", "/api/pair/devices", "rw", "default", None).1).unwrap().is_empty());
}

#[test]
fn a_man_in_the_middle_shows_up_as_a_fingerprint_mismatch() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let id = w["window_id"].as_str().unwrap();
    // The attacker sits between the device and the server and runs two separate exchanges.
    let device = Device::new();
    let attacker_towards_server = Device::new();
    let at_server = ecdh_start(&s, id, &attacker_towards_server).unwrap();           // what the server sees
    let attacker_key_for_device = Device::new();
    // the device believes the attacker's public key is the server's:
    let shared = device.secret.diffie_hellman(&attacker_key_for_device.secret.public_key());
    let t = pc::transcript("ecdh", &[id.as_bytes(), &device.public, &attacker_key_for_device.public]);
    let device_fingerprint = pc::fingerprint(&pc::derive(shared.raw_secret_bytes().as_slice(), t).transcript);

    let operator_sees = pending(&s)[0]["fingerprint"].as_str().unwrap().to_owned();
    assert_eq!(operator_sees, at_server.fingerprint);
    assert_ne!(operator_sees, device_fingerprint, "the two displays differ, so a careful operator rejects");
}

#[test]
fn scanning_the_devices_key_approves_only_the_matching_pairing() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let id = w["window_id"].as_str().unwrap();
    let (a, b) = (Device::new(), Device::new());
    let sa = ecdh_start(&s, id, &a).unwrap();
    let _sb = ecdh_start(&s, id, &b).unwrap();
    let pend = pending(&s);
    assert_eq!(pend.len(), 2);
    let a_id = pend.iter().find(|p| p["fingerprint"] == sa.fingerprint.as_str()).unwrap()["id"].as_str().unwrap().to_owned();
    let b_id = pend.iter().find(|p| p["fingerprint"] != sa.fingerprint.as_str()).unwrap()["id"].as_str().unwrap().to_owned();
    // the operator scanned B's QR code but is about to approve A: refused
    assert_eq!(decide(&s, &a_id, "approve", Some(json!({ "client_pub": pc::b64(&b.public) }))), 409);
    assert_eq!(ecdh_poll(&s, &sa, None).1["status"], "pending", "A is still waiting");
    // scanning A's own key approves A
    assert_eq!(decide(&s, &a_id, "approve", Some(json!({ "client_pub": pc::b64(&a.public) }))), 200);
    assert!(collect(&s, &sa).token.len() > 10);
    // B's pairing was denied when the window was used up
    assert_eq!(decide(&s, &b_id, "approve", None), 404);
}

#[test]
fn approving_one_pairing_denies_the_other_pending_ones_of_the_window() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let id = w["window_id"].as_str().unwrap();
    let (sa, sb) = (ecdh_start(&s, id, &Device::new()).unwrap(), ecdh_start(&s, id, &Device::new()).unwrap());
    let a_id = pending(&s).into_iter().find(|p| p["fingerprint"] == sa.fingerprint.as_str()).unwrap()["id"].as_str().unwrap().to_owned();
    assert_eq!(decide(&s, &a_id, "approve", None), 200);
    assert_eq!(ecdh_poll(&s, &sb, None).1["status"], "denied");
    assert!(collect(&s, &sa).token.len() > 10);
}

#[test]
fn only_the_device_that_started_can_collect_and_only_with_the_key() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let st = ecdh_start(&s, w["window_id"].as_str().unwrap(), &Device::new()).unwrap();
    assert_eq!(decide(&s, pending(&s)[0]["id"].as_str().unwrap(), "approve", None), 200);
    // someone who knows the session id but not the key
    let body = json!({ "session_id": st.session_id, "mac": pc::b64(&[0u8; 32]) }).to_string();
    assert_eq!(s.call("POST", "/api/pair/ecdh/result", "", "default", Some(&body)).0, 403);
    assert_eq!(s.call("POST", "/api/pair/ecdh/result", "", "default", Some("junk")).0, 403);
    // the real device still gets it
    assert!(collect(&s, &st).token.len() > 10);
}

#[test]
fn only_writers_of_the_namespace_see_and_decide_pending_pairings() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let st = ecdh_start(&s, w["window_id"].as_str().unwrap(), &Device::new()).unwrap();
    let id = pending(&s)[0]["id"].as_str().unwrap().to_owned();
    for token in ["", "ro", "garbage"] {
        assert_eq!(s.call("GET", "/api/pair/pending", token, "default", None).0, 401, "{token:?}");
        assert_eq!(s.call("POST", &format!("/api/pair/pending/{id}/approve"), token, "default", Some("")).0, 401, "{token:?}");
    }
    // another namespace's writer sees its own (empty) list, and cannot touch this pairing
    let (code, text) = s.call("GET", "/api/pair/pending", "other-rw", "other", None);
    assert_eq!((code, text.as_str()), (200, "[]"));
    assert_eq!(s.call("POST", &format!("/api/pair/pending/{id}/approve"), "other-rw", "other", Some("")).0, 404, "not visible from another namespace");
    assert_eq!(s.call("GET", "/api/pair/pending", "other-rw", "default", None).0, 401, "and its token is no good for this namespace");
    assert_eq!(ecdh_poll(&s, &st, None).1["status"], "pending");
}

#[test]
fn ecdh_needs_an_open_window_and_a_valid_key() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let id = w["window_id"].as_str().unwrap();
    let dev = Device::new();
    assert_eq!(ecdh_start(&s, "NOWINDOW", &dev).err().map(|e| e.0), Some(403));
    for bad in [pc::b64(&[]), pc::b64(&[4u8; 65]), pc::b64(&dev.public[..64]), "!!!".to_owned()] {
        let body = json!({ "window_id": id, "pub": bad }).to_string();
        assert_eq!(s.call("POST", "/api/pair/ecdh/start", "", "default", Some(&body)).0, 400, "{bad}");
    }
    s.advance(121_000);
    assert_eq!(ecdh_start(&s, id, &dev).err().map(|e| e.0), Some(403), "expired window");
}

#[test]
fn a_pending_pairing_expires_with_its_window() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let st = ecdh_start(&s, w["window_id"].as_str().unwrap(), &Device::new()).unwrap();
    s.advance(121_000);
    assert_eq!(ecdh_poll(&s, &st, None).0, 403);
    assert!(pending(&s).is_empty());
}

#[test]
fn the_credential_survives_the_window_being_purged_before_the_device_collects() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let st = ecdh_start(&s, w["window_id"].as_str().unwrap(), &Device::new()).unwrap();
    assert_eq!(decide(&s, pending(&s)[0]["id"].as_str().unwrap(), "approve", None), 200);
    window(&s, "r"); // opening another window purges closed ones
    assert!(collect(&s, &st).token.len() > 10);
}

#[test]
fn pending_pairings_per_window_are_bounded() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let id = w["window_id"].as_str().unwrap();
    let mut codes = vec![];
    for i in 0..10 {
        if i == 5 {
            s.advance(10_001);
        }
        codes.push(ecdh_start(&s, id, &Device::new()).map(|_| 200).unwrap_or_else(|e| e.0));
    }
    assert_eq!(&codes[..8], &[200; 8]);
    assert!(codes[8..].iter().all(|c| *c == 429), "{codes:?}");
}

#[test]
fn the_ecdh_endpoints_are_404_when_pairing_is_disabled() {
    let s = server("");
    for (m, p) in [("POST", "/api/pair/ecdh/start"), ("POST", "/api/pair/ecdh/result"), ("GET", "/api/pair/pending"), ("POST", "/api/pair/pending/x/approve")] {
        assert_eq!(s.call(m, p, "rw", "default", Some("{}")).0, 404, "{p}");
    }
}

// ── operator CLI: copacli pair … ──────────────────────────────────────────────

const COPACLI: &str = env!("CARGO_BIN_EXE_copacli");

fn cli(s: &Server, token: &str, args: &[&str]) -> (bool, String, String) {
    let out = std::process::Command::new(COPACLI)
        .args(["pair", "--server", &s.url, "--token", token, "--namespace", "default"])
        .args(args)
        .env("HOME", "/nonexistent-home-for-tests")
        .output()
        .unwrap();
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

#[test]
fn the_operator_pairs_with_a_code_and_revokes_through_the_cli() {
    let s = server(ENABLED);
    // open a window with the CLI
    let (ok, out, err) = cli(&s, "rw", &["open", "--access", "r", "--name", "kitchen tablet", "--json"]);
    assert!(ok, "{err}");
    let w: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(w["access"], "r");

    // the human-readable form shows the code to type
    let (ok, text, _) = cli(&s, "rw", &["open"]);
    assert!(ok);
    assert!(text.contains("code:") && text.contains("copacli pair pending"), "{text}");
    assert!(!text.contains("rw\n") || !text.contains("Bearer"), "no credentials in the output");

    // the device pairs with it (SPAKE2)
    let paired = pair(&s, &w, w["code"].as_str().unwrap()).expect("pairing works");
    assert_eq!(s.get("/api/clipboard", &paired.token, "default"), 200);
    assert_eq!(s.push(&paired.token, "default", "x"), 401, "read-only");

    // listing
    let (ok, list, _) = cli(&s, "rw", &["devices"]);
    assert!(ok && list.contains("kitchen tablet") && list.contains(" r "), "{list}");
    let (_, json, _) = cli(&s, "rw", &["devices", "--json"]);
    let devices: Vec<Value> = serde_json::from_str(json.trim()).unwrap();
    let dev = devices[0]["dev"].as_str().unwrap().to_owned();
    assert!(!json.contains(&paired.token));

    // revoking
    let (ok, out, _) = cli(&s, "rw", &["revoke", &dev]);
    assert!(ok && out.contains(&dev), "{out}");
    assert_eq!(s.get("/api/clipboard", &paired.token, "default"), 401, "the device is cut off at once");
    assert!(cli(&s, "rw", &["devices"]).1.contains("revoked"));
    let (ok, _, err) = cli(&s, "rw", &["revoke", "nonexistent"]);
    assert!(!ok && err.contains("404"), "{err}");
}

#[test]
fn the_operator_approves_an_ecdh_pairing_by_the_fingerprint_on_the_device() {
    let s = server(ENABLED);
    let (_, out, _) = cli(&s, "rw", &["open", "--json"]);
    let w: Value = serde_json::from_str(out.trim()).unwrap();
    let st = ecdh_start(&s, w["window_id"].as_str().unwrap(), &Device::new()).unwrap();

    let (ok, pend, _) = cli(&s, "rw", &["pending"]);
    assert!(ok && pend.contains(&st.fingerprint), "{pend}");

    // a wrong fingerprint matches nothing
    let (ok, _, err) = cli(&s, "rw", &["approve", "0000 0000 0000 0000"]);
    assert!(!ok && err.contains("no pending pairing matches"), "{err}");
    assert_eq!(ecdh_poll(&s, &st, None).1["status"], "pending");

    // the right one, typed the way it is read off the screen
    let (ok, out, err) = cli(&s, "rw", &["approve", &st.fingerprint]);
    assert!(ok, "{err}");
    assert!(out.contains("approved"));
    let paired = collect(&s, &st);
    assert_eq!(s.push(&paired.token, "default", "hello"), 200);
    assert!(cli(&s, "rw", &["pending"]).1.contains("nothing is waiting"));
}

#[test]
fn the_operator_can_reject_and_a_scanned_key_for_another_device_is_refused() {
    let s = server(ENABLED);
    let (_, out, _) = cli(&s, "rw", &["open", "--json"]);
    let w: Value = serde_json::from_str(out.trim()).unwrap();
    let id = w["window_id"].as_str().unwrap();
    let (a, b) = (Device::new(), Device::new());
    let sa = ecdh_start(&s, id, &a).unwrap();
    let digits: String = sa.fingerprint.split(' ').collect();

    let (ok, _, err) = cli(&s, "rw", &["approve", &digits, "--client-pub", &pc::b64(&b.public)]);
    assert!(!ok && err.contains("does not belong"), "{err}");

    let (ok, out, _) = cli(&s, "rw", &["reject", &digits]);
    assert!(ok && out.contains("rejected"));
    assert_eq!(ecdh_poll(&s, &sa, None).1["status"], "denied");
}

#[test]
fn the_cli_reports_missing_permission_and_disabled_pairing_clearly() {
    let s = server(ENABLED);
    let (ok, _, err) = cli(&s, "ro", &["open"]);
    assert!(!ok && err.contains("unauthorized"), "{err}");
    let (ok, _, err) = cli(&s, "wrong", &["devices"]);
    assert!(!ok && err.contains("unauthorized"), "{err}");
    let off = server("");
    let (ok, _, err) = cli(&off, "rw", &["open"]);
    assert!(!ok && err.contains("pairing not enabled"), "{err}");
}

// ── nothing about codes, windows or sessions leaks through failures ───────────

#[test]
fn every_kind_of_failed_confirmation_looks_exactly_alike() {
    let s = server(ENABLED);
    let mut bodies: Vec<(String, u16, String)> = vec![];
    let mut record = |what: &str, r: (u16, String)| bodies.push((what.to_owned(), r.0, r.1));

    let w = window(&s, "rw");
    let id = w["window_id"].as_str().unwrap();
    // wrong code
    let (sid, keys, ..) = spake2_start(&s, id, "00000000").unwrap();
    record("wrong code", spake2_confirm(&s, &sid, &keys, None));
    // unknown session
    record("unknown session", spake2_confirm(&s, "no-such-session", &keys, None));
    // replayed session
    record("replayed session", spake2_confirm(&s, &sid, &keys, None));
    // decoy (window id that does not exist)
    let (sid, keys, ..) = spake2_start(&s, "ZZZZZZ", w["code"].as_str().unwrap()).unwrap();
    record("decoy window", spake2_confirm(&s, &sid, &keys, None));
    // expired session
    let (sid, keys, ..) = spake2_start(&s, id, w["code"].as_str().unwrap()).unwrap();
    s.advance(31_000);
    record("expired session", spake2_confirm(&s, &sid, &keys, None));
    // closed window (the correct code, after a successful pairing used it up)
    let w2 = window(&s, "rw");
    let (sid, keys, ..) = spake2_start(&s, w2["window_id"].as_str().unwrap(), w2["code"].as_str().unwrap()).unwrap();
    let (sid2, keys2, ..) = spake2_start(&s, w2["window_id"].as_str().unwrap(), w2["code"].as_str().unwrap()).unwrap();
    assert_eq!(spake2_confirm(&s, &sid, &keys, None).0, 200);
    record("window already used", spake2_confirm(&s, &sid2, &keys2, None));
    // garbage body
    record("garbage body", s.call("POST", "/api/pair/spake2/confirm", "", "default", Some("not json")));

    let (first_what, first_status, first_body) = bodies[0].clone();
    for (what, status, body) in &bodies {
        assert_eq!((status, body), (&first_status, &first_body), "'{what}' must look exactly like '{first_what}'");
    }
    assert_eq!(first_status, 403);
}

#[test]
fn start_never_reveals_whether_a_window_exists_by_timing_class_or_shape() {
    let s = server(ENABLED);
    let w = window(&s, "rw");
    let real = spake2_start(&s, w["window_id"].as_str().unwrap(), "11111111").map(|(sid, ..)| sid.len());
    let fake = spake2_start(&s, "ABCDEF", "11111111").map(|(sid, ..)| sid.len());
    assert_eq!(real, fake, "same status and same shape of answer");
}

// ── restart ───────────────────────────────────────────────────────────────────

#[test]
fn after_a_restart_device_credentials_still_work_and_open_windows_are_gone() {
    use copa::server::{config::ConfigFile, state::build_app_state};
    use std::sync::{atomic::AtomicU64, Arc};
    let dir = tempfile::tempdir().unwrap();
    let cfg: ConfigFile = toml::from_str(&config(&format!("[server.pairing]\nenabled = true\nstate_dir = {:?}\n", dir.path()))).unwrap();
    let clock = Arc::new(AtomicU64::new(NOW));
    let build = || {
        let c = clock.clone();
        build_app_state(&cfg.server, None, Arc::new(move || c.load(std::sync::atomic::Ordering::SeqCst)), 0, "127.0.0.1").unwrap()
    };

    let before = build();
    let (token, rec) = before.tokens.as_ref().unwrap().enroll("laptop", "default", "rw", 3_600_000, NOW).unwrap();
    let window = before.pairing.as_ref().unwrap().open_window("default", "rw", "", NOW).unwrap();
    let revoked = before.tokens.as_ref().unwrap().enroll("gone", "default", "rw", 3_600_000, NOW).unwrap();
    before.tokens.as_ref().unwrap().revoke(&revoked.1.dev).unwrap();
    drop(before);

    let after = build(); // "restart": a new process would do exactly this
    assert!(after.tokens.as_ref().unwrap().verify(&token, NOW).is_ok(), "the device is still paired");
    assert!(after.tokens.as_ref().unwrap().verify(&revoked.0, NOW).is_err(), "a revocation survives too");
    assert_eq!(after.tokens.as_ref().unwrap().devices().len(), 2);
    assert!(after.tokens.as_ref().unwrap().devices().iter().any(|d| d.dev == rec.dev));
    assert!(after.pairing.as_ref().unwrap().usable(&window.id, NOW).is_err(), "open windows do not survive a restart");
    assert_eq!(after.pairing.as_ref().unwrap().open_count(NOW), 0);
}
