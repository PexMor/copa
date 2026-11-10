/// copasrv configuration (`[server]` section of config.toml)
use crate::history::{
    Limits, DEFAULT_FILE_QUOTA_BYTES, DEFAULT_HISTORY_LIMIT, DEFAULT_ITEM_TTL_SECS, DEFAULT_MAX_FILE_SIZE,
};
use crate::storage::StorageConfig;
use crate::{config_path, load_config_file};
use serde::Deserialize;
use std::{collections::HashMap, path::PathBuf};

pub const DEFAULT_SIZE_LIMIT: usize = 16_384;

#[derive(Deserialize, Default, Debug, Clone)]
pub struct NamespaceConfig {
    pub size_limit:  Option<usize>,
    pub read_token:  Option<String>,
    pub write_token: Option<String>,
    pub rw_token:    Option<String>,
    /// Max items kept in history (default 20).
    pub history_limit: Option<usize>,
    /// Lifetime of every item in seconds (default 86400). Must be > 0.
    pub item_ttl_secs: Option<i64>,
    /// Set to false to disable file items for this namespace.
    pub files: Option<bool>,
    /// Max size of a single file in bytes (default 50 MiB).
    pub max_file_size: Option<u64>,
    /// Max total bytes of stored + pending files (default 500 MiB).
    pub file_quota_bytes: Option<u64>,
}

impl NamespaceConfig {
    pub fn limits(&self, name: &str) -> Result<Limits, String> {
        let ttl = self.item_ttl_secs.unwrap_or(DEFAULT_ITEM_TTL_SECS as i64);
        if ttl <= 0 {
            return Err(format!("namespace '{name}': item_ttl_secs must be greater than 0 (got {ttl})"));
        }
        let history_limit = self.history_limit.unwrap_or(DEFAULT_HISTORY_LIMIT);
        if history_limit == 0 {
            return Err(format!("namespace '{name}': history_limit must be at least 1"));
        }
        Ok(Limits {
            history_limit,
            item_ttl_ms:      (ttl as u64).saturating_mul(1000),
            max_file_size:    self.max_file_size.unwrap_or(DEFAULT_MAX_FILE_SIZE),
            file_quota_bytes: self.file_quota_bytes.unwrap_or(DEFAULT_FILE_QUOTA_BYTES),
        })
    }
}

/// One claim → permission rule of a trusted issuer.
///
/// `claim` names a claim of the token (dotted path allowed, e.g. `realm_access.roles`);
/// `value` is matched against a string claim, against each element of an array claim, and
/// — for the `scope`/`scp` claims — against each space-separated scope. `*` matches any
/// text. A match grants `access` (`r`, `w` or `rw`) in `namespace`.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ClaimRule {
    pub claim:     String,
    pub value:     String,
    pub namespace: String,
    pub access:    String,
}

/// `[server.auth.issuers.<name>]` — a token service whose JWTs copasrv accepts.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct IssuerConfig {
    /// Expected `iss` claim; the token's own `iss` only selects this entry.
    pub iss: String,
    /// Where the issuer publishes its signing keys (JWKS).
    pub jwks_url: String,
    /// Expected `aud`: this copa server's identifier (usually its public URL).
    pub audience: String,
    /// Allowed signature algorithms; default `["ES256", "RS256"]`. Symmetric (HS*) and `none` are refused.
    pub algorithms: Option<Vec<String>>,
    /// Clock skew tolerated for `exp`/`nbf` (default 30, at most 300).
    pub leeway_secs: Option<u64>,
    /// How long fetched keys are trusted before a refresh is attempted (default 600).
    pub jwks_ttl_secs: Option<u64>,
    /// Minimum time between JWKS fetches, so unknown key ids cannot flood the issuer (default 10).
    pub jwks_min_refresh_secs: Option<u64>,
    #[serde(default)]
    pub map: Vec<ClaimRule>,
}

/// `[server.auth]`
#[derive(Deserialize, Default, Debug, Clone)]
pub struct AuthConfig {
    #[serde(default)]
    pub issuers: HashMap<String, IssuerConfig>,
}

/// `[server.pairing]` — device pairing and the tokens it issues (see docs/WIDGET.md).
#[derive(Deserialize, Default, Debug, Clone)]
pub struct PairingConfig {
    /// Pairing and device tokens are off unless this is true.
    #[serde(default)]
    pub enabled: bool,
    /// Where `auth.json` (signing secret, devices, revocations) lives. Default `~/.local/state/copa`.
    pub state_dir: Option<PathBuf>,
    /// Lifetime of a device token in seconds (default 86400).
    pub device_ttl_secs: Option<u64>,
    /// Allow `POST /api/pair/renew`: a valid device token buys a fresh one (default false).
    #[serde(default)]
    pub sliding_renewal: bool,
    /// How long a pairing window stays open, in seconds (default 120).
    pub window_ttl_secs: Option<u64>,
    /// Failed code attempts after which a window closes (default 5).
    pub max_attempts: Option<u32>,
    /// Requests per source address per 10 seconds on the pairing endpoints (default 30). Behind a
    /// reverse proxy every client shares the proxy's address: raise it there or limit at the proxy.
    pub rate_limit: Option<usize>,
}

impl PairingConfig {
    pub fn device_ttl_ms(&self) -> u64 {
        self.device_ttl_secs.unwrap_or(86_400).saturating_mul(1000)
    }
    pub fn window_ttl_ms(&self) -> u64 {
        self.window_ttl_secs.unwrap_or(120).saturating_mul(1000)
    }
    pub fn rate_limit(&self) -> usize {
        self.rate_limit.unwrap_or(30)
    }
    pub fn max_attempts(&self) -> u32 {
        self.max_attempts.unwrap_or(5)
    }
    /// Reject settings that would defeat the protection (zero lifetimes, unlimited attempts).
    pub fn validate(&self) -> Result<(), String> {
        if self.device_ttl_secs == Some(0) {
            return Err("[server.pairing] device_ttl_secs must be greater than 0".into());
        }
        if self.window_ttl_secs == Some(0) || self.window_ttl_secs > Some(3600) {
            return Err("[server.pairing] window_ttl_secs must be between 1 and 3600".into());
        }
        if matches!(self.max_attempts, Some(0)) || self.max_attempts > Some(20) {
            return Err("[server.pairing] max_attempts must be between 1 and 20".into());
        }
        if matches!(self.rate_limit, Some(0)) || self.rate_limit > Some(100_000) {
            return Err("[server.pairing] rate_limit must be between 1 and 100000".into());
        }
        Ok(())
    }
}

#[derive(Deserialize, Default, Debug)]
pub struct ServerConfig {
    pub port: Option<u16>,
    pub bind: Option<String>,
    /// Legacy single-token: treated as rw_token for the "default" namespace.
    pub token: Option<String>,
    /// Origins allowed by CORS. Unset: any origin.
    pub allowed_origins: Option<Vec<String>>,
    /// S3-compatible storage; enables file items when present.
    pub storage: Option<StorageConfig>,
    /// Device pairing; absent or disabled keeps copasrv on static tokens only.
    pub pairing: Option<PairingConfig>,
    /// Trusted token issuers; absent keeps copasrv on static tokens (and device tokens).
    pub auth: Option<AuthConfig>,
    #[serde(default)]
    pub namespaces: HashMap<String, NamespaceConfig>,
}

#[derive(Deserialize, Default, Debug)]
pub struct ConfigFile {
    #[serde(default)]
    pub server: ServerConfig,
}

pub fn load_config(path: Option<PathBuf>) -> ConfigFile {
    load_config_file::<ConfigFile>(&path.unwrap_or_else(config_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(toml_src: &str) -> ConfigFile {
        toml::from_str(toml_src).expect("valid toml")
    }

    #[test]
    fn namespace_defaults() {
        let cfg = parse("[server.namespaces.default]\nrw_token = \"t\"\n");
        let limits = cfg.server.namespaces["default"].limits("default").unwrap();
        assert_eq!(limits.history_limit, 20);
        assert_eq!(limits.item_ttl_ms, 86_400_000);
        assert_eq!(limits.max_file_size, 50 * 1024 * 1024);
        assert_eq!(limits.file_quota_bytes, 500 * 1024 * 1024);
        assert!(cfg.server.storage.is_none());
        assert!(cfg.server.allowed_origins.is_none());
    }

    #[test]
    fn namespace_overrides_are_parsed() {
        let cfg = parse(
            "[server.namespaces.a]\nrw_token = \"t\"\nhistory_limit = 3\nitem_ttl_secs = 3600\n\
             files = false\nmax_file_size = 10\nfile_quota_bytes = 100\n",
        );
        let ns = &cfg.server.namespaces["a"];
        let limits = ns.limits("a").unwrap();
        assert_eq!((limits.history_limit, limits.item_ttl_ms), (3, 3_600_000));
        assert_eq!((limits.max_file_size, limits.file_quota_bytes), (10, 100));
        assert_eq!(ns.files, Some(false));
    }

    #[test]
    fn non_positive_ttl_and_zero_limit_are_rejected() {
        for ttl in [0, -5] {
            let cfg = parse(&format!("[server.namespaces.a]\nitem_ttl_secs = {ttl}\n"));
            let e = cfg.server.namespaces["a"].limits("a").unwrap_err();
            assert!(e.contains("item_ttl_secs") && e.contains("'a'"), "{e}");
        }
        let cfg = parse("[server.namespaces.a]\nhistory_limit = 0\n");
        assert!(cfg.server.namespaces["a"].limits("a").unwrap_err().contains("history_limit"));
    }

    const EXAMPLE: &str = include_str!("../../config.toml.example");

    #[test]
    fn the_example_config_parses_as_shipped() {
        let cfg = parse(EXAMPLE);
        assert!(cfg.server.namespaces.contains_key("default"));
        assert!(cfg.server.pairing.is_none(), "pairing is only an opt-in example");
    }

    /// Uncomment the lines between `# >>> name` and `# <<< name`.
    fn uncommented(block: &str) -> String {
        let begin = format!("# >>> {block}");
        let end = format!("# <<< {block}");
        EXAMPLE
            .lines()
            .skip_while(|l| l.trim() != begin)
            .skip(1)
            .take_while(|l| l.trim() != end)
            .map(|l| l.strip_prefix("# ").or_else(|| l.strip_prefix('#')).unwrap_or(l))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_pairing_example_parses_when_uncommented() {
        let cfg = parse(&uncommented("pairing"));
        let p = cfg.server.pairing.expect("pairing section");
        assert!(p.enabled);
        assert_eq!(p.state_dir.unwrap().to_str(), Some("/var/lib/copa"));
    }

    #[test]
    fn the_issuer_example_parses_and_validates_against_its_own_namespaces() {
        let cfg = parse(&format!("{EXAMPLE}\n{}", uncommented("issuers")));
        let issuers = cfg.server.auth.expect("auth section").issuers;
        let names: std::collections::HashSet<String> = cfg.server.namespaces.keys().cloned().collect();
        let specs = crate::server::issuers::validate(&issuers, &names).expect("the example must be valid");
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].rules.len(), 2);
    }

    #[test]
    fn pairing_settings_have_safe_defaults_and_limits() {
        let p = parse("[server.pairing]\nenabled = true\n").server.pairing.unwrap();
        assert_eq!((p.device_ttl_ms(), p.window_ttl_ms(), p.max_attempts(), p.sliding_renewal), (86_400_000, 120_000, 5, false));
        assert!(p.validate().is_ok());
        for bad in ["device_ttl_secs = 0", "window_ttl_secs = 0", "window_ttl_secs = 99999", "max_attempts = 0", "max_attempts = 500", "rate_limit = 0", "rate_limit = 9999999"] {
            let p = parse(&format!("[server.pairing]\nenabled = true\n{bad}\n")).server.pairing.unwrap();
            assert!(p.validate().is_err(), "{bad}");
        }
    }

    #[test]
    fn pairing_defaults_to_disabled() {
        let cfg = parse("[server.pairing]\n");
        assert!(!cfg.server.pairing.unwrap().enabled);
    }

    #[test]
    fn storage_and_origins_are_parsed() {
        let cfg = parse(
            "[server]\nallowed_origins = [\"https://copa.example.com\"]\n\
             [server.storage]\npublic_url = \"https://s3.example.com\"\nbucket = \"copa\"\n\
             access_key_id = \"GK\"\nsecret_access_key = \"s\"\n",
        );
        assert_eq!(cfg.server.allowed_origins.unwrap(), ["https://copa.example.com"]);
        assert_eq!(cfg.server.storage.unwrap().bucket.as_deref(), Some("copa"));
    }
}
