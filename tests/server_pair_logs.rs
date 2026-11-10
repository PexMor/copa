//! The server log of a pairing never contains codes, keys, sessions or credentials
//! (real binary, captured stderr).
use copa::server::pair_crypto as pc;
use p256::{ecdh::EphemeralSecret, elliptic_curve::sec1::ToEncodedPoint, PublicKey};
use serde_json::{json, Value};
use spake2::{Ed25519Group, Identity, Password, Spake2};
use std::process::{Command, Stdio};
use std::time::Duration;

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn post(base: &str, path: &str, token: &str, body: &Value) -> (u16, Value) {
    let mut r = ureq::post(&format!("{base}{path}")).set("X-Copa-Namespace", "default");
    if !token.is_empty() {
        r = r.set("Authorization", &format!("Bearer {token}"));
    }
    match r.send_string(&body.to_string()) {
        Ok(r) => (r.status(), r.into_json().unwrap_or(Value::Null)),
        Err(ureq::Error::Status(c, r)) => (c, r.into_json().unwrap_or(Value::Null)),
        Err(e) => panic!("{e}"),
    }
}

#[test]
fn the_pairing_log_contains_events_but_no_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = dir.path().join("config.toml");
    std::fs::write(
        &cfg,
        format!(
            "[server.namespaces.default]\nrw_token = \"static-pairing-secret-1234\"\n[server.pairing]\nenabled = true\nstate_dir = {:?}\nsliding_renewal = true\n",
            dir.path()
        ),
    )
    .unwrap();
    let log_path = dir.path().join("server.log");
    let port = free_port();
    let mut child = Command::new(env!("CARGO_BIN_EXE_copasrv"))
        .args(["--config", cfg.to_str().unwrap(), "--port", &port.to_string(), "--bind", "127.0.0.1"])
        .stderr(std::fs::File::create(&log_path).unwrap())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let base = format!("http://127.0.0.1:{port}");
    assert!((0..100).any(|_| {
        std::thread::sleep(Duration::from_millis(50));
        ureq::get(&format!("{base}/api/version")).call().is_ok()
    }));

    let mut secrets: Vec<String> = vec!["static-pairing-secret-1234".into()];

    // ── SPAKE2: one failure, one success ──
    let (_, w) = post(&base, "/api/pair/windows", "static-pairing-secret-1234", &json!({ "name": "log test" }));
    let (wid, code) = (w["window_id"].as_str().unwrap().to_owned(), w["code"].as_str().unwrap().to_owned());
    secrets.extend([code.clone(), w["display_code"].as_str().unwrap().to_owned()]);
    let mut attempt = |password: &str| -> (u16, Value, pc::Keys) {
        let (sp, msg_a) = Spake2::<Ed25519Group>::start_a(&Password::new(password.as_bytes()), &Identity::new(b"copa-widget"), &Identity::new(b"copa-server"));
        let (_, s) = post(&base, "/api/pair/spake2/start", "", &json!({ "window_id": wid, "msg": pc::b64(&msg_a) }));
        let msg_b = pc::unb64(s["msg"].as_str().unwrap()).unwrap();
        let key = sp.finish(&msg_b).unwrap();
        let keys = pc::derive(&key, pc::transcript("spake2", &[wid.as_bytes(), &msg_a, &msg_b]));
        secrets.push(s["session_id"].as_str().unwrap().to_owned());
        let mac = pc::mac(&keys.client_mac, pc::LABEL_CLIENT, &keys.transcript);
        let (c, v) = post(&base, "/api/pair/spake2/confirm", "", &json!({ "session_id": s["session_id"], "mac": pc::b64(&mac) }));
        (c, v, keys)
    };
    assert_eq!(attempt("00000000").0, 403);
    let (c, v, keys) = attempt(&code);
    assert_eq!(c, 200);
    let token = serde_json::from_slice::<Value>(&pc::open(&keys.enc, &keys.transcript, &pc::unb64(v["sealed"].as_str().unwrap()).unwrap()).unwrap()).unwrap()["token"].as_str().unwrap().to_owned();
    secrets.extend([token.clone(), v["sealed"].as_str().unwrap().to_owned(), v["mac"].as_str().unwrap().to_owned(), pc::b64(&keys.enc), pc::b64(&keys.client_mac)]);

    // ── use and renew the device token, then ECDH ──
    assert_eq!(post(&base, "/api/pair/renew", &token, &json!({})).0, 200);
    let (_, w2) = post(&base, "/api/pair/windows", "static-pairing-secret-1234", &json!({}));
    secrets.push(w2["code"].as_str().unwrap().to_owned());
    let secret = EphemeralSecret::random(&mut rand::thread_rng());
    let public = secret.public_key().to_encoded_point(false).as_bytes().to_vec();
    let (_, e) = post(&base, "/api/pair/ecdh/start", "", &json!({ "window_id": w2["window_id"], "pub": pc::b64(&public) }));
    secrets.extend([pc::b64(&public), e["pub"].as_str().unwrap().to_owned(), e["session_id"].as_str().unwrap().to_owned()]);
    let server_pub = pc::unb64(e["pub"].as_str().unwrap()).unwrap();
    let shared = secret.diffie_hellman(&PublicKey::from_sec1_bytes(&server_pub).unwrap());
    let ekeys = pc::derive(shared.raw_secret_bytes().as_slice(), pc::transcript("ecdh", &[w2["window_id"].as_str().unwrap().as_bytes(), &public, &server_pub]));
    secrets.push(pc::b64(&shared.raw_secret_bytes()));
    let pend: Vec<Value> = ureq::get(&format!("{base}/api/pair/pending")).set("Authorization", "Bearer static-pairing-secret-1234").set("X-Copa-Namespace", "default").call().unwrap().into_json().unwrap();
    let pid = pend[0]["id"].as_str().unwrap().to_owned();
    secrets.push(pid.clone());
    assert_eq!(post(&base, &format!("/api/pair/pending/{pid}/approve"), "static-pairing-secret-1234", &json!({})).0, 200);
    let mac = pc::mac(&ekeys.client_mac, pc::LABEL_CLIENT, &ekeys.transcript);
    let (c, r) = post(&base, "/api/pair/ecdh/result", "", &json!({ "session_id": e["session_id"], "mac": pc::b64(&mac) }));
    assert_eq!((c, r["status"].as_str()), (200, Some("approved")));
    secrets.push(r["sealed"].as_str().unwrap().to_owned());
    std::thread::sleep(Duration::from_millis(200));

    let _ = child.kill();
    let _ = child.wait();
    let log = std::fs::read_to_string(&log_path).unwrap();

    for event in ["pair: window opened", "pair: confirmation failed", "enrolled", "pair: ecdh pairing waiting for approval", "pair: ecdh pairing approved"] {
        assert!(log.contains(event), "the log should record {event:?}:\n{log}");
    }
    for s in &secrets {
        assert!(!log.contains(s.as_str()), "the log leaks a secret ({}…):\n{log}", &s[..s.len().min(12)]);
    }
    for part in token.split('.') {
        assert!(!log.contains(part), "no part of the device token may appear in the log");
    }
    assert!(!log.to_lowercase().contains("bearer "));
}
