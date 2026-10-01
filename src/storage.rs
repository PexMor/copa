/// S3-compatible object storage for file clipboard items.
///
/// copasrv never moves file bytes itself: it signs short-lived URLs that
/// clients use directly, and only issues small HEAD / DELETE / LIST calls of
/// its own to verify uploads and clean up.
use rusty_s3::{actions::ListObjectsV2, Bucket, Credentials, S3Action, UrlStyle};
use serde::Deserialize;
use std::time::Duration;
use url::Url;

pub const SECRET_ENV: &str = "COPA_S3_SECRET_ACCESS_KEY";
pub const DEFAULT_REGION: &str = "garage";
pub const DEFAULT_KEY_PREFIX: &str = "copa/";
pub const DEFAULT_PRESIGN_TTL_SECS: u64 = 300;
/// Objects are always stored with this type so browsers never render them.
pub const STORED_CONTENT_TYPE: &str = "application/octet-stream";

#[derive(Deserialize, Default, Debug, Clone)]
pub struct StorageConfig {
    /// Base URL clients reach; presigned URLs are signed for this host.
    pub public_url:        Option<String>,
    /// Base URL copasrv itself uses (defaults to `public_url`).
    pub endpoint:          Option<String>,
    pub region:            Option<String>,
    pub bucket:            Option<String>,
    pub access_key_id:     Option<String>,
    pub secret_access_key: Option<String>,
    pub key_prefix:        Option<String>,
    pub presign_ttl_secs:  Option<u64>,
}

pub struct Storage {
    public:      Bucket,
    internal:    Bucket,
    credentials: Credentials,
    key_prefix:  String,
    presign_ttl: Duration,
    agent:       ureq::Agent,
}

pub struct PresignedUpload {
    pub url:     Url,
    /// Headers the client must send verbatim; they are part of the signature.
    pub headers: Vec<(&'static str, String)>,
}

fn required<'a>(value: &'a Option<String>, key: &str) -> Result<&'a str, String> {
    match value.as_deref().map(str::trim) {
        Some(v) if !v.is_empty() => Ok(v),
        _ => Err(format!("[server.storage] is missing required key '{key}'")),
    }
}

fn parse_base_url(raw: &str, key: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("[server.storage] {key} '{raw}' is not a valid URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(format!("[server.storage] {key} '{raw}' must be an http(s) URL with a host"));
    }
    Ok(url)
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d == "localhost" || d.ends_with(".localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// `Content-Disposition` value for a stored object. ASCII only, so that
/// browsers can send it as a request header and the signature stays stable.
pub fn content_disposition(name: &str) -> String {
    let fallback: String = name
        .chars()
        .map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' && c != ';' && c != '%' { c } else { '_' })
        .collect();
    let mut encoded = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

impl Storage {
    /// Build from config. `env_secret` (the value of `COPA_S3_SECRET_ACCESS_KEY`)
    /// takes precedence over the config file. Returns warnings to print.
    pub fn from_config(cfg: &StorageConfig, env_secret: Option<String>) -> Result<(Self, Vec<String>), String> {
        let public_raw = required(&cfg.public_url, "public_url")?;
        let bucket = required(&cfg.bucket, "bucket")?.to_owned();
        let access_key = required(&cfg.access_key_id, "access_key_id")?.to_owned();
        let secret = match env_secret.filter(|s| !s.trim().is_empty()) {
            Some(s) => s,
            None => required(&cfg.secret_access_key, "secret_access_key")
                .map_err(|e| format!("{e} (or set {SECRET_ENV})"))?
                .to_owned(),
        };

        let public_url = parse_base_url(public_raw, "public_url")?;
        let internal_url = match cfg.endpoint.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(raw) => parse_base_url(raw, "endpoint")?,
            None => public_url.clone(),
        };

        let mut key_prefix = cfg.key_prefix.clone().unwrap_or_else(|| DEFAULT_KEY_PREFIX.to_owned());
        key_prefix = key_prefix.trim_start_matches('/').to_owned();
        if key_prefix.is_empty() {
            // The orphan sweep deletes unknown objects under the prefix; an
            // empty prefix would make that the whole bucket.
            return Err("[server.storage] key_prefix must not be empty".into());
        }
        if !key_prefix.ends_with('/') {
            key_prefix.push('/');
        }

        let presign_ttl = cfg.presign_ttl_secs.unwrap_or(DEFAULT_PRESIGN_TTL_SECS);
        if presign_ttl == 0 || presign_ttl > 604_800 {
            return Err("[server.storage] presign_ttl_secs must be between 1 and 604800".into());
        }

        let mut warnings = Vec::new();
        if public_url.scheme() == "http" && !is_loopback(&public_url) {
            warnings.push(format!(
                "storage public_url {public_url} is plain http on a non-loopback host — \
                 presigned URLs and file contents will travel unencrypted; use https"
            ));
        }

        let region = cfg.region.clone().unwrap_or_else(|| DEFAULT_REGION.to_owned());
        let make_bucket = |url: Url| {
            Bucket::new(url, UrlStyle::Path, bucket.clone(), region.clone())
                .map_err(|e| format!("[server.storage] invalid bucket configuration: {e}"))
        };

        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .build();

        Ok((
            Self {
                public: make_bucket(public_url)?,
                internal: make_bucket(internal_url)?,
                credentials: Credentials::new(access_key, secret),
                key_prefix,
                presign_ttl: Duration::from_secs(presign_ttl),
                agent,
            },
            warnings,
        ))
    }

    pub fn presign_ttl(&self) -> Duration {
        self.presign_ttl
    }

    pub fn key_prefix(&self) -> &str {
        &self.key_prefix
    }

    /// Object key for an item. Built only from server-side values — never
    /// from the client-supplied file name.
    pub fn object_key(&self, namespace: &str, id: &str) -> String {
        format!("{}{namespace}/{id}", self.key_prefix)
    }

    /// Presigned PUT bound to one key, one exact size and fixed headers.
    pub fn presign_put(&self, key: &str, size: u64, name: &str) -> PresignedUpload {
        let length = size.to_string();
        let disposition = content_disposition(name);
        let mut action = self.public.put_object(Some(&self.credentials), key);
        action.headers_mut().insert("content-length", length.as_str());
        action.headers_mut().insert("content-type", STORED_CONTENT_TYPE);
        action.headers_mut().insert("content-disposition", disposition.as_str());
        let url = action.sign(self.presign_ttl);
        PresignedUpload {
            url,
            headers: vec![
                ("Content-Length", length),
                ("Content-Type", STORED_CONTENT_TYPE.to_owned()),
                ("Content-Disposition", disposition),
            ],
        }
    }

    pub fn presign_get(&self, key: &str, ttl: Duration) -> Url {
        self.public.get_object(Some(&self.credentials), key).sign(ttl)
    }

    /// Size of the object, or `None` when it does not exist. Blocking.
    pub fn head(&self, key: &str) -> Result<Option<u64>, String> {
        let url = self.internal.head_object(Some(&self.credentials), key).sign(Duration::from_secs(60));
        match self.agent.request_url("HEAD", &url).call() {
            Ok(resp) => resp
                .header("content-length")
                .and_then(|v| v.parse::<u64>().ok())
                .map(Some)
                .ok_or_else(|| "object store HEAD response has no content-length".to_owned()),
            Err(ureq::Error::Status(404, _)) => Ok(None),
            Err(ureq::Error::Status(code, _)) => Err(format!("object store HEAD returned {code}")),
            Err(ureq::Error::Transport(t)) => Err(format!("object store unreachable: {}", t.kind())),
        }
    }

    /// Delete an object; a missing object counts as success. Blocking.
    pub fn delete(&self, key: &str) -> Result<(), String> {
        let url = self.internal.delete_object(Some(&self.credentials), key).sign(Duration::from_secs(60));
        match self.agent.request_url("DELETE", &url).call() {
            Ok(_) | Err(ureq::Error::Status(404, _)) => Ok(()),
            Err(ureq::Error::Status(code, _)) => Err(format!("object store DELETE returned {code}")),
            Err(ureq::Error::Transport(t)) => Err(format!("object store unreachable: {}", t.kind())),
        }
    }

    /// All object keys under the configured prefix. Blocking.
    pub fn list_keys(&self) -> Result<Vec<String>, String> {
        let mut keys = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut action = self.internal.list_objects_v2(Some(&self.credentials));
            action.with_prefix(self.key_prefix.as_str());
            if let Some(t) = &token {
                action.with_continuation_token(t.as_str());
            }
            let url = action.sign(Duration::from_secs(60));
            let body = match self.agent.request_url("GET", &url).call() {
                Ok(resp) => resp.into_string().map_err(|e| format!("object store LIST read failed: {e}"))?,
                Err(ureq::Error::Status(code, _)) => return Err(format!("object store LIST returned {code}")),
                Err(ureq::Error::Transport(t)) => return Err(format!("object store unreachable: {}", t.kind())),
            };
            let parsed = ListObjectsV2::parse_response(&body)
                .map_err(|e| format!("object store LIST response not understood: {e}"))?;
            keys.extend(parsed.contents.into_iter().map(|c| c.key));
            match parsed.next_continuation_token {
                Some(t) => token = Some(t),
                None => return Ok(keys),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn config() -> StorageConfig {
        StorageConfig {
            public_url:        Some("https://s3.example.com".into()),
            endpoint:          Some("http://127.0.0.1:3900".into()),
            region:            None,
            bucket:            Some("copa".into()),
            access_key_id:     Some("GKtest".into()),
            secret_access_key: Some("secret".into()),
            key_prefix:        None,
            presign_ttl_secs:  None,
        }
    }

    fn err(cfg: &StorageConfig, env: Option<&str>) -> String {
        match Storage::from_config(cfg, env.map(str::to_owned)) {
            Err(e) => e,
            Ok(_) => panic!("expected an error"),
        }
    }

    #[test]
    fn missing_required_keys_are_named() {
        for (key, cfg) in [
            ("public_url", StorageConfig { public_url: None, ..config() }),
            ("bucket", StorageConfig { bucket: None, ..config() }),
            ("access_key_id", StorageConfig { access_key_id: Some("  ".into()), ..config() }),
            ("secret_access_key", StorageConfig { secret_access_key: None, ..config() }),
        ] {
            let e = err(&cfg, None);
            assert!(e.contains(&format!("'{key}'")), "{key}: {e}");
        }
    }

    #[test]
    fn secret_from_environment_is_enough_and_wins() {
        let cfg = StorageConfig { secret_access_key: None, ..config() };
        assert!(Storage::from_config(&cfg, Some("from-env".into())).is_ok());

        // Different secrets must produce different signatures: env wins.
        let sign = |env: Option<&str>| {
            let (s, _) = Storage::from_config(&config(), env.map(str::to_owned)).unwrap();
            s.presign_get("copa/default/x", Duration::from_secs(60)).to_string()
        };
        let sig = |u: String| u.split("X-Amz-Signature=").nth(1).unwrap().to_owned();
        assert_ne!(sig(sign(None)), sig(sign(Some("other"))));
    }

    #[test]
    fn empty_prefix_and_bad_urls_are_rejected() {
        assert!(err(&StorageConfig { key_prefix: Some("/".into()), ..config() }, None).contains("key_prefix"));
        assert!(err(&StorageConfig { public_url: Some("ftp://x".into()), ..config() }, None).contains("public_url"));
        assert!(err(&StorageConfig { endpoint: Some("nope".into()), ..config() }, None).contains("endpoint"));
    }

    #[test]
    fn plain_http_public_url_warns_unless_loopback() {
        let warn = |url: &str| {
            let cfg = StorageConfig { public_url: Some(url.into()), ..config() };
            Storage::from_config(&cfg, None).unwrap().1
        };
        assert_eq!(warn("http://files.example.com").len(), 1);
        assert!(warn("https://files.example.com").is_empty());
        assert!(warn("http://127.0.0.1:3900").is_empty());
        assert!(warn("http://localhost:3900").is_empty());
        assert!(warn("http://[::1]:3900").is_empty());
    }

    #[test]
    fn upload_url_is_path_style_on_public_host_with_signed_headers() {
        let (s, _) = Storage::from_config(&config(), None).unwrap();
        let key = s.object_key("default", "abc123");
        assert_eq!(key, "copa/default/abc123");
        let up = s.presign_put(&key, 1234, "report.pdf");
        assert_eq!(up.url.scheme(), "https");
        assert_eq!(up.url.host_str(), Some("s3.example.com"));
        assert_eq!(up.url.path(), "/copa/copa/default/abc123");
        let q: std::collections::HashMap<_, _> = up.url.query_pairs().into_owned().collect();
        assert_eq!(q["X-Amz-Expires"], "300");
        assert_eq!(q["X-Amz-SignedHeaders"], "content-disposition;content-length;content-type;host");
        assert!(up.headers.contains(&("Content-Length", "1234".into())));
        assert!(up.headers.contains(&("Content-Type", STORED_CONTENT_TYPE.into())));
        assert!(!up.url.as_str().contains("report.pdf"));
    }

    #[test]
    fn download_url_uses_requested_lifetime() {
        let (s, _) = Storage::from_config(&config(), None).unwrap();
        let url = s.presign_get("copa/default/abc", Duration::from_secs(30));
        assert_eq!(url.host_str(), Some("s3.example.com"));
        assert!(url.query().unwrap().contains("X-Amz-Expires=30&"));
    }

    #[test]
    fn content_disposition_is_ascii_attachment() {
        let d = content_disposition("zpráva \"x\".pdf");
        assert!(d.is_ascii());
        assert!(d.starts_with("attachment; filename=\"zpr_va__x_.pdf\"; filename*=UTF-8''zpr%C3%A1va%20%22x%22.pdf"));
    }

    /// Round-trip against the reference Garage backend (`make s3-up`).
    /// Needs COPA_TEST_S3_URL, COPA_TEST_S3_BUCKET, COPA_TEST_S3_KEY_ID, COPA_TEST_S3_SECRET.
    #[test]
    #[ignore]
    fn garage_round_trip() {
        let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} not set"));
        let cfg = StorageConfig {
            public_url:        Some(env("COPA_TEST_S3_URL")),
            endpoint:          None,
            region:            std::env::var("COPA_TEST_S3_REGION").ok(),
            bucket:            Some(env("COPA_TEST_S3_BUCKET")),
            access_key_id:     Some(env("COPA_TEST_S3_KEY_ID")),
            secret_access_key: Some(env("COPA_TEST_S3_SECRET")),
            key_prefix:        Some("copa-unit-test/".into()),
            presign_ttl_secs:  Some(60),
        };
        let (s, _) = Storage::from_config(&cfg, None).unwrap();
        let key = s.object_key("default", &crate::gen_token());
        let body = b"hello garage";

        assert_eq!(s.head(&key).unwrap(), None);

        // A body of the wrong length is rejected by the signature.
        let up = s.presign_put(&key, body.len() as u64, "héllo.txt");
        let put = |data: &[u8]| {
            let mut req = ureq::request_url("PUT", &up.url);
            for (k, v) in &up.headers {
                if *k != "Content-Length" {
                    req = req.set(k, v);
                }
            }
            req.send_bytes(data)
        };
        assert!(put(b"this body is longer than declared").is_err());
        assert_eq!(s.head(&key).unwrap(), None);

        put(body).unwrap();
        assert_eq!(s.head(&key).unwrap(), Some(body.len() as u64));
        assert!(s.list_keys().unwrap().contains(&key));

        let resp = ureq::request_url("GET", &s.presign_get(&key, Duration::from_secs(60))).call().unwrap();
        assert_eq!(resp.header("content-type"), Some(STORED_CONTENT_TYPE));
        assert!(resp.header("content-disposition").unwrap().starts_with("attachment;"));
        assert_eq!(resp.into_string().unwrap().as_bytes(), body);

        s.delete(&key).unwrap();
        assert_eq!(s.head(&key).unwrap(), None);
        s.delete(&key).unwrap(); // deleting a missing object is fine
    }
}
