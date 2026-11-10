/// Locating the web app (the built Vite frontend). `copasrv` serves it from disk; there is no embedded UI.
use std::path::{Path, PathBuf};

/// Candidate directories searched when `--static-dir` / `COPA_STATIC_DIR` is not given, in order:
/// 1. `<exe dir>/../share/copa/dist` (what `make install` / `make install-web` produce for any PREFIX)
/// 2. `$XDG_DATA_HOME/copa/dist`, else `$HOME/.local/share/copa/dist` (what the ansible role installs)
pub fn default_candidates(exe: Option<&Path>, xdg_data_home: Option<&str>, home: Option<&str>) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(prefix) = exe.and_then(|e| e.parent()).and_then(|bin| bin.parent()) {
        v.push(prefix.join("share/copa/dist"));
    }
    match (xdg_data_home.filter(|s| !s.is_empty()), home.filter(|s| !s.is_empty())) {
        (Some(x), _) => v.push(Path::new(x).join("copa/dist")),
        (None, Some(h)) => v.push(Path::new(h).join(".local/share/copa/dist")),
        _ => {}
    }
    v
}

/// First candidate that contains an `index.html`.
pub fn find_default(exe: Option<&Path>, xdg_data_home: Option<&str>, home: Option<&str>) -> Result<PathBuf, Vec<PathBuf>> {
    let c = default_candidates(exe, xdg_data_home, home);
    c.iter().find(|d| d.join("index.html").is_file()).cloned().ok_or(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_are_exe_relative_then_data_home() {
        let c = default_candidates(Some(Path::new("/home/u/bin/copasrv")), None, Some("/home/u"));
        assert_eq!(c, vec![PathBuf::from("/home/u/share/copa/dist"), PathBuf::from("/home/u/.local/share/copa/dist")]);
        let c = default_candidates(Some(Path::new("/usr/local/bin/copasrv")), Some("/x"), Some("/home/u"));
        assert_eq!(c, vec![PathBuf::from("/usr/local/share/copa/dist"), PathBuf::from("/x/copa/dist")]);
    }

    #[test]
    fn find_default_needs_index_html() {
        let d = std::env::temp_dir().join(format!("copa-sa-{}", std::process::id()));
        let dist = d.join("share/copa/dist");
        std::fs::create_dir_all(&dist).unwrap();
        let exe = d.join("bin/copasrv");
        assert!(find_default(Some(&exe), None, None).is_err());
        std::fs::write(dist.join("index.html"), "x").unwrap();
        assert_eq!(find_default(Some(&exe), None, None).unwrap(), dist);
        std::fs::remove_dir_all(&d).ok();
    }
}
