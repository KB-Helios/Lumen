use std::path::{Path, PathBuf};

/// Reject blank or placeholder keys and characters unsafe for this YAML template.
fn reject_bad_key(label: &str, key: &str) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    if key.contains("your-api-key") {
        return Err(format!("{label} must not contain placeholder keys"));
    }
    if key.chars().any(|c| c == '\n' || c == '\r' || c == '"') {
        return Err(format!("{label} contains an unsupported character"));
    }
    Ok(())
}

/// Minimal sidecar config in the v8 layout.
///
/// Pins the listener to loopback, disables remote management and the bundled
/// control panel, and never emits `your-api-key` placeholders.
pub fn minimal_yaml(auth_dir: &str, mgmt_key: &str, client_key: &str) -> String {
    format!(
        r#"config-version: 8
server:
  host: "127.0.0.1"
  port: 8317
  discovery:
    enabled: false
management:
  allow-remote: false
  secret-key: "{mgmt_key}"
  disable-control-panel: true
auth-dir: "{auth_dir}"
access:
  api-keys:
    - "{client_key}"
usage-statistics-enabled: false
logging-to-file: false
routing:
  strategy: "round-robin"
"#
    )
}

/// Writes a minimal `config.yaml` plus the `auths/` dir and `mgmt.key` into
/// `dir` (which becomes `<dir>/config.yaml`). Returns the config path.
///
/// The write is atomic (tmp file + rename) and rejects empty keys,
/// `your-api-key` placeholders, and keys with newlines/quotes.
pub fn write_minimal_config(
    dir: &Path,
    mgmt_key: &str,
    client_key: &str,
) -> Result<PathBuf, String> {
    reject_bad_key("management key", mgmt_key)?;
    reject_bad_key("client key", client_key)?;
    if auth_dir_placeholder(dir) {
        return Err("Refusing to write config into a placeholder path".to_owned());
    }

    std::fs::create_dir_all(dir).map_err(|error| format!("Cannot create dir: {error}"))?;
    let auth_dir = dir.join("auths");
    std::fs::create_dir_all(&auth_dir).map_err(|error| format!("Cannot create auths: {error}"))?;

    let yaml = minimal_yaml(&auth_dir.to_string_lossy(), mgmt_key, client_key);
    debug_assert!(!yaml.contains("your-api-key"));
    if yaml.contains("your-api-key") {
        return Err("Generated config contains a placeholder key".to_owned());
    }

    let config_path = dir.join("config.yaml");
    atomic_write(&config_path, yaml.as_bytes())?;
    atomic_write(&dir.join("mgmt.key"), mgmt_key.as_bytes())?;
    Ok(config_path)
}

/// Detect the placeholder key marker in the proposed config directory.
fn auth_dir_placeholder(dir: &Path) -> bool {
    dir.as_os_str().to_string_lossy().contains("your-api-key")
}

/// Write and sync a sibling temporary file, then rename it over the destination.
/// Return an error if creation, writing, syncing, or replacement fails.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    let mut file =
        std::fs::File::create(&tmp).map_err(|error| format!("Cannot write file: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("Cannot write file: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Cannot flush file: {error}"))?;
    drop(file);
    std::fs::rename(&tmp, path).map_err(|error| format!("Cannot replace file: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_yaml_pins_loopback_and_hardening() {
        let yaml = minimal_yaml("/tmp/auths", "mgmt-123", "client-abc");
        assert!(yaml.contains("127.0.0.1"));
        assert!(yaml.contains("allow-remote: false"));
        assert!(yaml.contains("disable-control-panel: true"));
        assert!(!yaml.contains("your-api-key"));
    }

    #[test]
    fn write_rejects_placeholders_and_empty_keys() {
        let dir = std::env::temp_dir().join("lumen-cliproxy-test");
        assert!(write_minimal_config(&dir, "", "client-abc").is_err());
        assert!(write_minimal_config(&dir, "mgmt-123", "your-api-key-1").is_err());
    }
}
