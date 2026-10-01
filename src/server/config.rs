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
