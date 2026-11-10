/// Device tokens issued by copasrv itself (pairing): `v1.<payload>.<mac>`.
///
/// The payload is base64url JSON (`Claims`), the mac is HMAC-SHA256 over
/// `"v1." + payload` with a server secret. Verification is stateless apart
/// from the revocation list. The secret and the revocation list live in
/// `auth.json` (mode 0600) or the secret comes from `COPA_TOKEN_SECRET`.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const PREFIX: &str = "v1.";
pub const SECRET_ENV: &str = "COPA_TOKEN_SECRET";
const MIN_SECRET_LEN: usize = 16;

type HmacSha256 = Hmac<Sha256>;

/// What a device token grants. Times are unix milliseconds.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Claims {
    /// Device id (the unit of revocation).
    pub dev: String,
    pub ns: String,
    /// `r`, `w` or `rw`.
    pub acc: String,
    pub iat: u64,
    pub exp: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Claims {
    pub fn can_read(&self) -> bool {
        self.acc.contains('r')
    }
    pub fn can_write(&self) -> bool {
        self.acc.contains('w')
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum TokenError {
    /// Not a `v1.` token or structurally broken.
    Malformed,
    BadSignature,
    Expired,
    Revoked,
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            TokenError::Malformed => "malformed token",
            TokenError::BadSignature => "bad signature",
            TokenError::Expired => "token expired",
            TokenError::Revoked => "device revoked",
        })
    }
}

/// A paired device as listed to the operator (no secrets).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct DeviceRecord {
    pub dev:     String,
    pub name:    String,
    pub ns:      String,
    pub acc:     String,
    pub created: u64,
    /// Expiry of the newest token issued to the device (unix ms).
    pub exp:     u64,
    #[serde(default)]
    pub revoked: bool,
}

/// Persistent part of the service state.
#[derive(Serialize, Deserialize, Default, Debug)]
struct Persisted {
    #[serde(default)]
    devices: std::collections::BTreeMap<String, DeviceRecord>,
    /// Hex signing secret; absent when `COPA_TOKEN_SECRET` supplies it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secret: Option<String>,
    #[serde(default)]
    revoked: BTreeSet<String>,
}

pub struct TokenService {
    secret: Vec<u8>,
    path: Option<PathBuf>,
    persisted: Mutex<Persisted>,
}

/// Default state directory: `$XDG_STATE_HOME/copa` or `~/.local/state/copa`.
pub fn default_state_dir() -> PathBuf {
    dirs::state_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("state")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("copa")
}

impl TokenService {
    /// Open (or create) the service. With `dir = None` nothing is persisted:
    /// the secret is random per run (useful for tests). `env_secret`
    /// overrides the stored secret and is never written to disk.
    pub fn open(dir: Option<&Path>, env_secret: Option<String>) -> Result<Self, String> {
        if let Some(s) = &env_secret {
            if s.len() < MIN_SECRET_LEN {
                return Err(format!("{SECRET_ENV} must be at least {MIN_SECRET_LEN} characters"));
            }
        }
        let path = dir.map(|d| d.join("auth.json"));
        let mut persisted = match &path {
            Some(p) => match fs::read_to_string(p) {
                Ok(s) => serde_json::from_str::<Persisted>(&s)
                    .map_err(|e| format!("{}: not valid JSON: {e}", p.display()))?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Persisted::default(),
                Err(e) => return Err(format!("{}: {e}", p.display())),
            },
            None => Persisted::default(),
        };

        let secret = if let Some(env) = env_secret {
            persisted.secret = None; // an env secret must not linger in the file
            env.into_bytes()
        } else if let Some(hex_secret) = &persisted.secret {
            hex::decode(hex_secret).map_err(|e| format!("auth.json: bad secret: {e}"))?
        } else {
            let fresh: [u8; 32] = rand::random();
            persisted.secret = path.as_ref().map(|_| hex::encode(fresh));
            fresh.to_vec()
        };

        let svc = Self { secret, path, persisted: Mutex::new(persisted) };
        svc.save()?;
        Ok(svc)
    }

    fn save(&self) -> Result<(), String> {
        let Some(path) = &self.path else { return Ok(()) };
        let p = self.persisted.lock().unwrap_or_else(|e| e.into_inner());
        let json = serde_json::to_vec_pretty(&*p).map_err(|e| e.to_string())?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let tmp = path.with_extension("json.tmp");
        write_private(&tmp, &json).map_err(|e| format!("{}: {e}", tmp.display()))?;
        fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
    }

    fn mac(&self, signing_input: &str) -> HmacSha256 {
        let mut mac = HmacSha256::new_from_slice(&self.secret).expect("HMAC accepts any key length");
        mac.update(signing_input.as_bytes());
        mac
    }

    pub fn issue(&self, claims: &Claims) -> String {
        let payload = B64.encode(serde_json::to_vec(claims).expect("claims serialize"));
        let signing_input = format!("{PREFIX}{payload}");
        let sig = B64.encode(self.mac(&signing_input).finalize().into_bytes());
        format!("{signing_input}.{sig}")
    }

    /// Verify signature, expiry and revocation. `now_ms` is unix milliseconds.
    pub fn verify(&self, token: &str, now_ms: u64) -> Result<Claims, TokenError> {
        let rest = token.strip_prefix(PREFIX).ok_or(TokenError::Malformed)?;
        let (payload, sig) = rest.split_once('.').ok_or(TokenError::Malformed)?;
        if sig.contains('.') {
            return Err(TokenError::Malformed);
        }
        let sig = B64.decode(sig).map_err(|_| TokenError::Malformed)?;
        // MAC first: nothing in the payload is trusted (or even parsed) before it verifies.
        self.mac(&format!("{PREFIX}{payload}")).verify_slice(&sig).map_err(|_| TokenError::BadSignature)?;
        let raw = B64.decode(payload).map_err(|_| TokenError::Malformed)?;
        let claims: Claims = serde_json::from_slice(&raw).map_err(|_| TokenError::Malformed)?;
        if !matches!(claims.acc.as_str(), "r" | "w" | "rw") {
            return Err(TokenError::Malformed);
        }
        if now_ms >= claims.exp {
            return Err(TokenError::Expired);
        }
        if self.is_revoked(&claims.dev) {
            return Err(TokenError::Revoked);
        }
        Ok(claims)
    }

    pub fn is_revoked(&self, dev: &str) -> bool {
        self.persisted.lock().unwrap_or_else(|e| e.into_inner()).revoked.contains(dev)
    }

    /// Revoke every token of a device (persisted).
    pub fn revoke(&self, dev: &str) -> Result<(), String> {
        {
            let mut p = self.persisted.lock().unwrap_or_else(|e| e.into_inner());
            p.revoked.insert(dev.to_owned());
            if let Some(d) = p.devices.get_mut(dev) {
                d.revoked = true;
            }
        }
        self.save()
    }

    /// Register a new device and issue its first token.
    pub fn enroll(&self, name: &str, ns: &str, acc: &str, ttl_ms: u64, now_ms: u64) -> Result<(String, DeviceRecord), String> {
        if !matches!(acc, "r" | "w" | "rw") {
            return Err(format!("access must be r, w or rw (got {acc:?})"));
        }
        let dev = hex::encode(rand::random::<[u8; 8]>());
        let rec = DeviceRecord {
            dev: dev.clone(),
            name: name.chars().filter(|c| !c.is_control()).take(64).collect(),
            ns: ns.to_owned(),
            acc: acc.to_owned(),
            created: now_ms,
            exp: now_ms + ttl_ms,
            revoked: false,
        };
        let token = self.issue(&Claims {
            dev, ns: ns.to_owned(), acc: acc.to_owned(), iat: now_ms, exp: rec.exp, name: Some(rec.name.clone()),
        });
        self.persisted.lock().unwrap_or_else(|e| e.into_inner()).devices.insert(rec.dev.clone(), rec.clone());
        self.save()?;
        Ok((token, rec))
    }

    /// Sliding renewal: a still-valid device token buys a new one with a fresh lifetime.
    pub fn renew(&self, token: &str, ttl_ms: u64, now_ms: u64) -> Result<(String, DeviceRecord), TokenError> {
        let c = self.verify(token, now_ms)?;
        let rec = {
            let mut p = self.persisted.lock().unwrap_or_else(|e| e.into_inner());
            let rec = p.devices.get_mut(&c.dev).ok_or(TokenError::Revoked)?; // unknown device: treat as revoked
            if rec.revoked {
                return Err(TokenError::Revoked);
            }
            rec.exp = now_ms + ttl_ms;
            rec.clone()
        };
        let fresh = self.issue(&Claims { iat: now_ms, exp: rec.exp, ..c });
        let _ = self.save();
        Ok((fresh, rec))
    }

    /// Every paired device, newest first.
    pub fn devices(&self) -> Vec<DeviceRecord> {
        let mut v: Vec<_> = self.persisted.lock().unwrap_or_else(|e| e.into_inner()).devices.values().cloned().collect();
        v.sort_by(|a, b| b.created.cmp(&a.created));
        v
    }
}

#[cfg(unix)]
fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    f.write_all(data)?;
    f.sync_all()
}

#[cfg(not(unix))]
fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut f = fs::File::create(path)?;
    f.write_all(data)?;
    f.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;

    fn claims(dev: &str) -> Claims {
        Claims { dev: dev.into(), ns: "team".into(), acc: "rw".into(), iat: NOW, exp: NOW + 60_000, name: Some("laptop".into()) }
    }

    fn svc() -> TokenService {
        TokenService::open(None, None).unwrap()
    }

    #[test]
    fn round_trip() {
        let s = svc();
        let t = s.issue(&claims("d1"));
        assert!(t.starts_with("v1.") && t.matches('.').count() == 2);
        assert_eq!(s.verify(&t, NOW).unwrap(), claims("d1"));
    }

    #[test]
    fn permissions_follow_acc() {
        for (acc, r, w) in [("r", true, false), ("w", false, true), ("rw", true, true)] {
            let c = Claims { acc: acc.into(), ..claims("d") };
            assert_eq!((c.can_read(), c.can_write()), (r, w), "{acc}");
        }
    }

    #[test]
    fn tampered_payload_is_rejected_before_it_is_parsed() {
        let s = svc();
        let t = s.issue(&claims("d1"));
        let mut parts: Vec<&str> = t.split('.').collect();
        let forged = B64.encode(serde_json::to_vec(&Claims { acc: "rw".into(), ns: "other".into(), ..claims("d1") }).unwrap());
        parts[1] = &forged;
        assert_eq!(s.verify(&parts.join("."), NOW), Err(TokenError::BadSignature));
        // garbage in the payload slot is also a signature failure, not a panic or a parse error
        parts[1] = "!!!not-base64!!!";
        assert_eq!(s.verify(&parts.join("."), NOW), Err(TokenError::BadSignature));
    }

    #[test]
    fn tampered_signature_is_rejected() {
        let s = svc();
        let t = s.issue(&claims("d1"));
        let mut bytes = t.into_bytes();
        // a character in the middle of the signature (the last one only carries padding bits)
        let at = bytes.len() - 20;
        bytes[at] = if bytes[at] == b'A' { b'B' } else { b'A' };
        assert_eq!(s.verify(&String::from_utf8(bytes).unwrap(), NOW), Err(TokenError::BadSignature));
    }

    #[test]
    fn a_token_from_another_secret_is_rejected() {
        let t = svc().issue(&claims("d1"));
        assert_eq!(svc().verify(&t, NOW), Err(TokenError::BadSignature));
    }

    #[test]
    fn expiry_is_exclusive_at_the_boundary() {
        let s = svc();
        let t = s.issue(&claims("d1"));
        assert!(s.verify(&t, NOW + 59_999).is_ok());
        assert_eq!(s.verify(&t, NOW + 60_000), Err(TokenError::Expired));
        assert_eq!(s.verify(&t, NOW + 1_000_000), Err(TokenError::Expired));
    }

    #[test]
    fn revocation_affects_only_that_device() {
        let s = svc();
        let (a, b) = (s.issue(&claims("a")), s.issue(&claims("b")));
        s.revoke("a").unwrap();
        assert_eq!(s.verify(&a, NOW), Err(TokenError::Revoked));
        assert!(s.verify(&b, NOW).is_ok());
        assert!(s.is_revoked("a") && !s.is_revoked("b"));
    }

    #[test]
    fn malformed_tokens() {
        let s = svc();
        for bad in ["", "v1", "v1.", "v1.x", "v1.x.y.z", "v2.x.y", "Bearer v1.a.b", "abc.def.ghi", "v1..", "v1.a.!!"] {
            assert!(matches!(s.verify(bad, NOW), Err(TokenError::Malformed | TokenError::BadSignature)), "{bad:?}");
        }
    }

    #[test]
    fn a_correctly_signed_but_invalid_payload_is_malformed() {
        let s = svc();
        let sign = |payload: &str| {
            let p = B64.encode(payload);
            let input = format!("v1.{p}");
            format!("{input}.{}", B64.encode(s.mac(&input).finalize().into_bytes()))
        };
        assert_eq!(s.verify(&sign("not json"), NOW), Err(TokenError::Malformed));
        assert_eq!(s.verify(&sign(r#"{"dev":"d"}"#), NOW), Err(TokenError::Malformed));
        let weird = serde_json::to_string(&Claims { acc: "admin".into(), ..claims("d") }).unwrap();
        assert_eq!(s.verify(&sign(&weird), NOW), Err(TokenError::Malformed));
    }

    #[test]
    fn secret_and_revocations_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let first = TokenService::open(Some(dir.path()), None).unwrap();
        let (keep, gone) = (first.issue(&claims("keep")), first.issue(&claims("gone")));
        first.revoke("gone").unwrap();
        drop(first);

        let second = TokenService::open(Some(dir.path()), None).unwrap();
        assert!(second.verify(&keep, NOW).is_ok());
        assert_eq!(second.verify(&gone, NOW), Err(TokenError::Revoked));
    }

    #[cfg(unix)]
    #[test]
    fn the_state_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let s = TokenService::open(Some(dir.path()), None).unwrap();
        s.revoke("x").unwrap();
        let mode = fs::metadata(dir.path().join("auth.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn env_secret_overrides_the_file_and_is_never_written() {
        let dir = tempfile::tempdir().unwrap();
        let secret = "an-environment-supplied-secret".to_string();
        let a = TokenService::open(Some(dir.path()), Some(secret.clone())).unwrap();
        let t = a.issue(&claims("d"));
        let on_disk = fs::read_to_string(dir.path().join("auth.json")).unwrap();
        assert!(!on_disk.contains(&secret) && !on_disk.contains("\"secret\""), "{on_disk}");
        // another instance with the same env secret verifies it, even with no state dir
        assert!(TokenService::open(None, Some(secret.clone())).unwrap().verify(&t, NOW).is_ok());
        // without the env secret a different (generated) secret is used
        let plain = TokenService::open(Some(dir.path()), None).unwrap();
        assert_eq!(plain.verify(&t, NOW), Err(TokenError::BadSignature));
    }

    #[test]
    fn short_env_secrets_are_refused() {
        let e = TokenService::open(None, Some("short".into())).err().unwrap();
        assert!(e.contains("COPA_TOKEN_SECRET") && e.contains("16"), "{e}");
    }

    #[test]
    fn a_corrupt_state_file_is_an_error_not_a_silent_new_secret() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("auth.json"), "{ nope").unwrap();
        assert!(TokenService::open(Some(dir.path()), None).err().unwrap().contains("not valid JSON"));
    }

    #[test]
    fn no_state_dir_means_nothing_is_persisted() {
        let s = TokenService::open(None, None).unwrap();
        s.revoke("x").unwrap(); // in-memory only
        assert!(s.is_revoked("x"));
    }

    #[test]
    fn enrolled_devices_get_a_working_token_and_a_record() {
        let s = svc();
        let (t, rec) = s.enroll("My laptop", "team", "rw", 60_000, NOW).unwrap();
        let c = s.verify(&t, NOW).unwrap();
        assert_eq!((c.dev.as_str(), c.ns.as_str(), c.acc.as_str(), c.exp), (rec.dev.as_str(), "team", "rw", NOW + 60_000));
        assert_eq!(c.name.as_deref(), Some("My laptop"));
        assert_eq!(s.devices(), vec![rec]);
        assert_eq!(s.verify(&t, NOW + 60_000), Err(TokenError::Expired));
        assert!(s.enroll("x", "team", "admin", 1, NOW).is_err());
    }

    #[test]
    fn device_names_are_cleaned() {
        let (_, rec) = svc().enroll(&format!("a\nb\x1b{}", "x".repeat(200)), "t", "r", 1000, NOW).unwrap();
        assert!(rec.name.len() <= 64 && !rec.name.contains('\n') && !rec.name.contains('\x1b'));
    }

    #[test]
    fn revoking_one_enrolled_device_marks_its_record_only() {
        let s = svc();
        let (a, ra) = s.enroll("a", "t", "rw", 60_000, NOW).unwrap();
        let (b, rb) = s.enroll("b", "t", "rw", 60_000, NOW).unwrap();
        s.revoke(&ra.dev).unwrap();
        assert_eq!(s.verify(&a, NOW), Err(TokenError::Revoked));
        assert!(s.verify(&b, NOW).is_ok());
        let by: std::collections::HashMap<_, _> = s.devices().into_iter().map(|d| (d.dev.clone(), d.revoked)).collect();
        assert_eq!((by[&ra.dev], by[&rb.dev]), (true, false));
    }

    #[test]
    fn devices_and_tokens_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let first = TokenService::open(Some(dir.path()), None).unwrap();
        let (t, rec) = first.enroll("phone", "team", "r", 60_000, NOW).unwrap();
        drop(first);
        let second = TokenService::open(Some(dir.path()), None).unwrap();
        assert!(second.verify(&t, NOW).is_ok());
        assert_eq!(second.devices(), vec![rec]);
    }

    #[test]
    fn sliding_renewal_extends_the_lifetime_but_not_for_expired_or_revoked_devices() {
        let s = svc();
        let (t, rec) = s.enroll("laptop", "team", "rw", 60_000, NOW).unwrap();
        let (fresh, r2) = s.renew(&t, 60_000, NOW + 50_000).unwrap();
        assert_eq!(r2.exp, NOW + 110_000);
        assert!(s.verify(&fresh, NOW + 100_000).is_ok());
        assert_eq!(s.verify(&fresh, NOW + 100_000).unwrap().dev, rec.dev);
        assert_eq!(s.renew(&t, 60_000, NOW + 60_000).err(), Some(TokenError::Expired));
        s.revoke(&rec.dev).unwrap();
        assert_eq!(s.renew(&fresh, 60_000, NOW + 100_000).err(), Some(TokenError::Revoked));
    }

    #[test]
    fn a_validly_signed_token_for_an_unknown_device_cannot_renew() {
        let s = svc();
        let t = s.issue(&claims("ghost"));
        assert_eq!(s.renew(&t, 1000, NOW).err(), Some(TokenError::Revoked));
    }

    #[test]
    fn tokens_do_not_contain_the_secret() {
        let s = svc();
        let t = s.issue(&claims("d1"));
        assert!(!t.contains(&hex::encode(&s.secret)));
    }
}
