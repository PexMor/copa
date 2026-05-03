/// Shared utilities for copasrv and copacli
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
