/// Build identity and client/server compatibility.
///
/// Identity is `version` (Cargo.toml) + `built` (UTC) + `commit` (git short
/// hash). Compatibility is decided by `protocol`: bump [`PROTOCOL`] only for a
/// wire change an older peer cannot cope with (removed/renamed endpoint or
/// field, changed semantics). Additive changes keep the same protocol.
use serde::{Deserialize, Serialize};

pub const PROTOCOL: u32 = 1;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const COMMIT: &str = env!("COPA_GIT_COMMIT");
pub const BUILT: &str = env!("COPA_BUILD_TIME");
/// `0.3.0 (b8d4e54, 2026-11-05T10:00:00Z)` — for `--version`.
pub const LONG: &str = concat!(
    env!("CARGO_PKG_VERSION"), " (", env!("COPA_GIT_COMMIT"), ", ", env!("COPA_BUILD_TIME"), ")"
);

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct VersionInfo {
    pub name: String,
    pub version: String,
    pub commit: String,
    pub built: String,
    pub protocol: u32,
}

impl VersionInfo {
    pub fn current(name: &str) -> Self {
        Self {
            name: name.to_owned(),
            version: VERSION.to_owned(),
            commit: COMMIT.to_owned(),
            built: BUILT.to_owned(),
            protocol: PROTOCOL,
        }
    }
}

impl std::fmt::Display for VersionInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {} ({}, {})", self.name, self.version, self.commit, self.built)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Compat {
    /// Same protocol and same build.
    Identical,
    /// Same protocol, different build: works, worth mentioning.
    Compatible,
    /// Different protocol: expect failures.
    Incompatible(String),
}

pub fn compat(local: &VersionInfo, remote: &VersionInfo) -> Compat {
    if local.protocol != remote.protocol {
        let (who, hint) = if local.protocol < remote.protocol { ("client", "upgrade the client") } else { ("server", "upgrade the server") };
        return Compat::Incompatible(format!(
            "protocol mismatch: local {} ({}) vs remote {} ({}); {who} is older — {hint}",
            local.protocol, local.version, remote.protocol, remote.version
        ));
    }
    if local.version == remote.version && local.commit == remote.commit {
        Compat::Identical
    } else {
        Compat::Compatible
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(version: &str, commit: &str, protocol: u32) -> VersionInfo {
        VersionInfo { name: "x".into(), version: version.into(), commit: commit.into(), built: "t".into(), protocol }
    }

    #[test]
    fn compat_rules() {
        assert_eq!(compat(&v("1", "a", 1), &v("1", "a", 1)), Compat::Identical);
        assert_eq!(compat(&v("1", "a", 1), &v("2", "b", 1)), Compat::Compatible);
        assert!(matches!(compat(&v("1", "a", 1), &v("2", "b", 2)), Compat::Incompatible(m) if m.contains("upgrade the client")));
        assert!(matches!(compat(&v("2", "a", 2), &v("1", "b", 1)), Compat::Incompatible(m) if m.contains("upgrade the server")));
    }

    #[test]
    fn build_metadata_is_present() {
        assert!(!COMMIT.is_empty() && BUILT.ends_with('Z') && BUILT.len() == 20, "{BUILT}");
    }
}
