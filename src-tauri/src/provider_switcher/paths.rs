//! Client config file locations for the file-switch engine.
//!
//! Every path derives from a home directory. Tests override the home with the
//! `LUMEN_TEST_HOME` environment variable so real user files are never touched.

use std::path::{Path, PathBuf};

/// Home directory for client config files.
///
/// Honors a non-empty `LUMEN_TEST_HOME` (test isolation) first, then falls
/// back to `USERPROFILE` (Windows) / `HOME`, then the current directory.
pub fn home_dir() -> PathBuf {
    if let Ok(home) = std::env::var("LUMEN_TEST_HOME")
        && !home.trim().is_empty()
    {
        return PathBuf::from(home);
    }
    for key in ["USERPROFILE", "HOME"] {
        if let Ok(home) = std::env::var(key)
            && !home.trim().is_empty()
        {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(".")
}

/// Claude Code live settings: `~/.claude/settings.json`.
pub fn claude_settings(home: &Path) -> PathBuf {
    home.join(".claude").join("settings.json")
}

/// Codex CLI live config: `~/.codex/config.toml`.
pub fn codex_config(home: &Path) -> PathBuf {
    home.join(".codex").join("config.toml")
}

/// Codex CLI auth state: `~/.codex/auth.json`.
///
/// Exposed for recovery context only; the minimal engine never writes it.
pub fn codex_auth(home: &Path) -> PathBuf {
    home.join(".codex").join("auth.json")
}

/// Gemini CLI live env: `~/.gemini/.env`.
pub fn gemini_env(home: &Path) -> PathBuf {
    home.join(".gemini").join(".env")
}

/// OpenCode config dir: `~/.config/opencode` on every platform.
pub fn opencode_dir(home: &Path) -> PathBuf {
    home.join(".config").join("opencode")
}

/// OpenCode live config: `opencode.jsonc` wins when present, else `opencode.json`.
pub fn opencode_config(home: &Path) -> PathBuf {
    let dir = opencode_dir(home);
    let jsonc = dir.join("opencode.jsonc");
    if jsonc.exists() {
        jsonc
    } else {
        dir.join("opencode.json")
    }
}

/// OpenClaw live config: `~/.openclaw/openclaw.json`.
pub fn openclaw_config(home: &Path) -> PathBuf {
    home.join(".openclaw").join("openclaw.json")
}

/// Device-local state dir for `live-state.json` (this machine's intents).
pub fn device_dir(home: &Path) -> PathBuf {
    home.join(".lumen")
}

/// Pending-intent journal for crash recovery.
pub fn live_state(home: &Path) -> PathBuf {
    device_dir(home).join("live-state.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_paths_derive_from_home() {
        let home = Path::new("/tmp/fake-home");
        assert_eq!(
            claude_settings(home),
            PathBuf::from("/tmp/fake-home/.claude/settings.json")
        );
        assert_eq!(
            codex_config(home),
            PathBuf::from("/tmp/fake-home/.codex/config.toml")
        );
        assert_eq!(
            codex_auth(home),
            PathBuf::from("/tmp/fake-home/.codex/auth.json")
        );
        assert_eq!(
            gemini_env(home),
            PathBuf::from("/tmp/fake-home/.gemini/.env")
        );
        assert_eq!(
            openclaw_config(home),
            PathBuf::from("/tmp/fake-home/.openclaw/openclaw.json")
        );
        assert_eq!(
            live_state(home),
            PathBuf::from("/tmp/fake-home/.lumen/live-state.json")
        );
    }

    #[test]
    fn opencode_prefers_jsonc_when_present() {
        let root = std::env::temp_dir().join(format!(
            "lumen-paths-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(opencode_dir(&root)).unwrap();
        assert_eq!(
            opencode_config(&root),
            opencode_dir(&root).join("opencode.json")
        );
        std::fs::write(opencode_dir(&root).join("opencode.jsonc"), "{}").unwrap();
        assert_eq!(
            opencode_config(&root),
            opencode_dir(&root).join("opencode.jsonc")
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
