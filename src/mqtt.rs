//! Shared MQTT helpers: config type, AES-256-GCM crypto, broker options builder.
//!
//! The envelope format is interoperable with the web app (web/src/utils/crypto.ts):
//!   {"v":1,"iv":"<base64-12B-IV>","d":"<base64-ciphertext>","cs":"<8-hex-sha256>"}
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rumqttc::{MqttOptions, TlsConfiguration, Transport};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

// ── Config type ───────────────────────────────────────────────────────────────

pub fn default_max_message_size() -> usize { 65535 }

#[derive(Deserialize, Default, Debug, Clone)]
pub struct MqttServerCfg {
    pub broker_url: String,
    pub topic:      String,
    #[serde(default)]
    pub aes_key:    Option<String>,
    #[serde(default = "default_max_message_size")]
    pub max_message_size: usize,
    #[serde(default)]
    pub client_id:  Option<String>,
}

// ── AES-256-GCM crypto ────────────────────────────────────────────────────────

const B58_ALPHA: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

#[derive(Serialize, Deserialize)]
struct MqttEnvelope {
    v:  u8,
    iv: String,
    d:  String,
    cs: String,
}

/// Accept 64-char hex, base58 (Bitcoin alphabet), or base64 — must decode to 32 bytes.
fn key_to_bytes(key_str: &str) -> Result<[u8; 32], String> {
    if key_str.len() == 64 && key_str.chars().all(|c| c.is_ascii_hexdigit()) {
        let bytes = hex::decode(key_str).map_err(|e| format!("hex decode: {e}"))?;
        return bytes.try_into().map_err(|_| "AES key must be 32 bytes".into());
    }
    let all_b58 = key_str.bytes().all(|b| B58_ALPHA.contains(&b));
    if all_b58 && !key_str.contains('+') && !key_str.contains('/') && !key_str.contains('=') {
        let bytes = bs58::decode(key_str)
            .into_vec()
            .map_err(|e| format!("base58 decode: {e}"))?;
        return bytes.try_into().map_err(|_| "AES key must be 32 bytes".into());
    }
    let bytes = B64.decode(key_str).map_err(|e| format!("base64 decode: {e}"))?;
    bytes.try_into().map_err(|_| "AES key must be 32 bytes".into())
}

fn sha256_hex8(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(&h.finalize()[..4])
}

/// Encrypt `plaintext` with AES-256-GCM and return the JSON envelope string.
pub fn mqtt_encrypt(plaintext: &str, key_str: &str) -> Result<String, String> {
    let key_bytes = key_to_bytes(key_str)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));

    let mut iv_bytes = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut iv_bytes);
    let nonce = Nonce::from_slice(&iv_bytes);

    let plain_bytes = plaintext.as_bytes();
    let ciphertext  = cipher
        .encrypt(nonce, plain_bytes)
        .map_err(|_| "encryption failed".to_string())?;

    serde_json::to_string(&MqttEnvelope {
        v:  1,
        iv: B64.encode(iv_bytes),
        d:  B64.encode(&ciphertext),
        cs: sha256_hex8(plain_bytes),
    })
    .map_err(|e| format!("json serialize: {e}"))
}

/// Decrypt a JSON envelope produced by `mqtt_encrypt` (or the web app).
pub fn mqtt_decrypt(raw: &str, key_str: &str) -> Result<String, String> {
    let env: MqttEnvelope = serde_json::from_str(raw)
        .map_err(|_| "not-copa-mqtt".to_string())?;
    if env.v != 1 { return Err("not-copa-mqtt".into()); }

    let key_bytes  = key_to_bytes(key_str)?;
    let cipher     = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let iv         = B64.decode(&env.iv).map_err(|e| format!("iv decode: {e}"))?;
    let ciphertext = B64.decode(&env.d).map_err(|e| format!("d decode: {e}"))?;

    let plain_bytes = cipher
        .decrypt(Nonce::from_slice(&iv), ciphertext.as_slice())
        .map_err(|_| "decryption failed (wrong key?)".to_string())?;

    let plaintext = String::from_utf8(plain_bytes).map_err(|e| format!("utf-8: {e}"))?;
    if sha256_hex8(plaintext.as_bytes()) != env.cs {
        return Err("checksum-mismatch".into());
    }
    Ok(plaintext)
}

// ── MQTT broker options builder ───────────────────────────────────────────────

fn make_tls_config() -> Result<TlsConfiguration, String> {
    let mut roots = rustls::RootCertStore::empty();
    let certs = rustls_native_certs::load_native_certs()
        .map_err(|e| format!("load native certs: {e}"))?;
    for cert in certs {
        roots.add(cert).ok();
    }
    Ok(TlsConfiguration::Rustls(Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )))
}

/// Parse `scheme://host[:port][/path]` and build `MqttOptions`.
///
/// Supported schemes: `mqtt`, `mqtts`, `ws`, `wss`.
/// For WebSocket transports, `broker_addr` in `MqttOptions` must be the full URL
/// because rumqttc calls `broker_addr.into_client_request()` internally.
pub fn build_mqtt_options(broker_url: &str, client_id: &str) -> Result<MqttOptions, String> {
    let (scheme, rest) = broker_url
        .split_once("://")
        .ok_or_else(|| format!("invalid broker URL (expected scheme://host): {broker_url}"))?;

    let hostport = rest.split('/').next().unwrap_or(rest);

    let (host, port) = if let Some(pos) = hostport.rfind(':') {
        let p: u16 = hostport[pos + 1..].parse()
            .map_err(|_| format!("invalid port in broker URL: {broker_url}"))?;
        (hostport[..pos].to_string(), p)
    } else {
        let default_port = match scheme {
            "mqtt"  => 1883u16,
            "mqtts" => 8883u16,
            "ws"    => 8083u16,
            "wss"   => 8084u16,
            s       => return Err(format!("unsupported MQTT scheme: {s}")),
        };
        (hostport.to_string(), default_port)
    };

    let broker_addr = match scheme {
        "ws" | "wss" => broker_url.to_string(),
        _            => host,
    };

    let mut opts = MqttOptions::new(client_id, &broker_addr, port);
    opts.set_keep_alive(std::time::Duration::from_secs(30));
    opts.set_clean_session(true);

    match scheme {
        "mqtt"  => {}
        "mqtts" => { opts.set_transport(Transport::Tls(make_tls_config()?)); }
        "ws"    => { opts.set_transport(Transport::Ws); }
        "wss"   => { opts.set_transport(Transport::Wss(make_tls_config()?)); }
        s       => return Err(format!("unsupported MQTT scheme: {s}")),
    }

    Ok(opts)
}

pub fn mqtt_client_id(cfg_id: &Option<String>) -> String {
    cfg_id.clone().unwrap_or_else(|| {
        use rand::RngCore;
        let mut b = [0u8; 4];
        rand::thread_rng().fill_bytes(&mut b);
        format!("copa_{}", hex::encode(b))
    })
}
