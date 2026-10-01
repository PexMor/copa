/// Shared utilities for copasrv, copacli, and copa-tray
pub mod history;
pub mod mqtt;
pub mod server;
pub mod storage;
use rand::Rng;
use serde::de::DeserializeOwned;
use std::path::PathBuf;

pub fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join("copa")
        .join("config.toml")
}

pub fn gen_token() -> String {
    let b: [u8; 16] = rand::thread_rng().gen();
    hex::encode(b)
}

/// Load and deserialize a TOML config file, returning `T::default()` on any error.
pub fn load_config_file<T: DeserializeOwned + Default>(path: &PathBuf) -> T {
    match std::fs::read_to_string(path) {
        Ok(s) => toml::from_str(&s).unwrap_or_else(|e| {
            eprintln!("warning: failed to parse {}: {e}", path.display());
            T::default()
        }),
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            eprintln!("warning: failed to read {}: {e}", path.display());
            T::default()
        }
        _ => T::default(),
    }
}

/// Current time as unix milliseconds.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Reduce a client-supplied file name to a safe single path component:
/// last component only, no control characters, at most 255 bytes.
pub fn sanitize_filename(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return "file".to_owned();
    }
    let mut end = cleaned.len().min(255);
    while !cleaned.is_char_boundary(end) {
        end -= 1;
    }
    cleaned[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::sanitize_filename;

    #[test]
    fn sanitize_strips_paths_and_control_characters() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("C:\\Users\\x\\report.pdf"), "report.pdf");
        assert_eq!(sanitize_filename("a\nb\r\0c.txt"), "abc.txt");
        assert_eq!(sanitize_filename("report.pdf"), "report.pdf");
    }

    #[test]
    fn sanitize_falls_back_for_empty_or_dot_names() {
        for bad in ["", "..", ".", "dir/", "a/..", "  "] {
            assert_eq!(sanitize_filename(bad), "file", "{bad:?}");
        }
    }

    #[test]
    fn sanitize_limits_length_on_a_char_boundary() {
        let s = sanitize_filename(&"é".repeat(300));
        assert!(s.len() <= 255);
        assert!(s.chars().all(|c| c == 'é'));
    }
}
