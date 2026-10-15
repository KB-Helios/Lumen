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
    let auth_dir = serde_json::to_string(auth_dir).expect("path string is serializable");
    let mgmt_key = serde_json::to_string(mgmt_key).expect("key string is serializable");
    let client_key = serde_json::to_string(client_key).expect("key string is serializable");
    format!(
        r#"config-version: 8
server:
  host: "127.0.0.1"
  port: 8317
  discovery:
    enabled: false
management:
  allow-remote: false
  secret-key: {mgmt_key}
  disable-control-panel: true
auth-dir: {auth_dir}
access:
  api-keys:
    - {client_key}
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
    validate_directory(dir)?;
    validate_directory(&dir.join("auths"))?;
    for name in ["config.yaml", "mgmt.key"] {
        if regular_file(&dir.join(name))? {
            return Err("Cliproxy configuration already exists; refusing to replace it".to_owned());
        }
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
    super::files::atomic_write(&dir.join("mgmt.key"), mgmt_key.as_bytes(), true)?;
    super::files::atomic_write(&config_path, yaml.as_bytes(), true)?;
    Ok(config_path)
}

/// Bootstrap only a clean runtime; existing sidecar settings and credentials stay owned by it.
pub(super) fn initialize_runtime(dir: &Path, management_key: Option<&str>) -> Result<(), String> {
    validate_directory(dir)?;
    validate_directory(&dir.join("auths"))?;
    let config = dir.join("config.yaml");
    let key = dir.join("mgmt.key");
    let config_exists = regular_file(&config)?;
    let key_exists = regular_file(&key)?;
    let management_key = management_key.filter(|key| !key.trim().is_empty());
    if let Some(key) = management_key {
        reject_bad_key("management key", key)?;
    }
    if config_exists {
        if std::fs::metadata(&config)
            .map_err(|_| invalid_runtime())?
            .len()
            == 0
        {
            return Err(invalid_runtime());
        }
        if management_key.is_none() {
            if std::fs::metadata(&key)
                .map_err(|_| invalid_runtime())?
                .len()
                > super::files::MAX_TEXT_BYTES as u64
            {
                return Err(invalid_runtime());
            }
            let key = std::fs::read_to_string(&key).map_err(|_| invalid_runtime())?;
            reject_bad_key("management key", key.trim())?;
        }
        return Ok(());
    }
    if key_exists {
        return Err(
            "Cliproxy configuration is incomplete; existing management key was preserved"
                .to_owned(),
        );
    }
    let generated_key = uuid::Uuid::new_v4().to_string();
    let client_key = uuid::Uuid::new_v4().to_string();
    write_minimal_config(dir, management_key.unwrap_or(&generated_key), &client_key)?;
    Ok(())
}

fn invalid_runtime() -> String {
    "Cliproxy runtime contains an invalid path or incomplete configuration".to_owned()
}

fn is_reparse(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn validate_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| part == std::path::Component::ParentDir)
    {
        return Err(invalid_runtime());
    }
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) if !metadata.is_dir() || is_reparse(&metadata) => {
                return Err(invalid_runtime());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(invalid_runtime()),
        }
    }
    Ok(())
}

fn regular_file(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !is_reparse(&metadata) => Ok(true),
        Ok(_) => Err(invalid_runtime()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(invalid_runtime()),
    }
}

/// Detect the placeholder key marker in the proposed config directory.
fn auth_dir_placeholder(dir: &Path) -> bool {
    dir.as_os_str().to_string_lossy().contains("your-api-key")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("lumen-cliproxy-config-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
            assert!(
                self.0
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("lumen-cliproxy-config-")
            );
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

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

    #[test]
    fn runtime_initialization_preserves_config_keys_and_auths_on_restart() {
        let fixture = Fixture::new();
        let runtime = fixture.0.join("runtime");
        initialize_runtime(&runtime, Some("owned-management-key")).unwrap();
        let key = std::fs::read(runtime.join("mgmt.key")).unwrap();
        let config_path = runtime.join("config.yaml");
        let config = std::fs::read_to_string(&config_path)
            .unwrap()
            .replace("port: 8317", "port: 9456");
        std::fs::write(&config_path, &config).unwrap();
        let auth = runtime.join("auths/owned.json");
        std::fs::write(&auth, b"owned synthetic auth metadata").unwrap();

        initialize_runtime(&runtime, None).unwrap();
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), config);
        assert_eq!(std::fs::read(runtime.join("mgmt.key")).unwrap(), key);
        assert_eq!(
            std::fs::read(&auth).unwrap(),
            b"owned synthetic auth metadata"
        );
        assert!(write_minimal_config(&runtime, "replacement-key", "replacement-client").is_err());
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), config);
        assert_eq!(std::fs::read(runtime.join("mgmt.key")).unwrap(), key);
    }

    #[test]
    fn runtime_initialization_fails_closed_on_incomplete_or_invalid_paths() {
        let fixture = Fixture::new();
        for (index, (name, bytes)) in [
            ("config.yaml", "existing config"),
            ("mgmt.key", "existing key"),
            ("auths", "not a directory"),
        ]
        .iter()
        .enumerate()
        {
            let runtime = fixture.0.join(index.to_string());
            std::fs::create_dir(&runtime).unwrap();
            let existing = runtime.join(name);
            std::fs::write(&existing, bytes).unwrap();
            assert!(initialize_runtime(&runtime, None).is_err());
            assert_eq!(std::fs::read_to_string(&existing).unwrap(), *bytes);
            assert_eq!(std::fs::read_dir(&runtime).unwrap().count(), 1);
        }
        let blank_key = fixture.0.join("blank-key");
        std::fs::create_dir(&blank_key).unwrap();
        std::fs::write(blank_key.join("config.yaml"), "existing config").unwrap();
        std::fs::write(blank_key.join("mgmt.key"), " \n").unwrap();
        assert!(initialize_runtime(&blank_key, None).is_err());
        assert!(initialize_runtime(&fixture.0.join("../escape"), None).is_err());
        assert!(initialize_runtime(Path::new("relative-runtime"), None).is_err());
    }

    #[test]
    #[cfg(windows)]
    fn runtime_initialization_refuses_reparse_ancestors_and_files() {
        use std::os::windows::fs::{symlink_dir, symlink_file};
        let fixture = Fixture::new();
        let outside = fixture.0.join("outside");
        std::fs::create_dir(&outside).unwrap();
        let link = fixture.0.join("linked-runtime");
        symlink_dir(&outside, &link)
            .expect("Windows developer mode must permit owned symlink fixture");
        assert!(initialize_runtime(&link.join("child"), None).is_err());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        std::fs::remove_dir(&link).unwrap();

        for name in ["config.yaml", "mgmt.key"] {
            let runtime = fixture.0.join(name.replace('.', "-"));
            std::fs::create_dir(&runtime).unwrap();
            let target = outside.join(name);
            std::fs::write(&target, "owned sentinel").unwrap();
            let link = runtime.join(name);
            symlink_file(&target, &link).unwrap();
            assert!(initialize_runtime(&runtime, None).is_err());
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "owned sentinel");
            std::fs::remove_file(&link).unwrap();
        }
    }

    #[test]
    fn yaml_quotes_windows_paths_without_escape_interpretation() {
        let path = r#"C:\Users\owned\new runtime\auths"#;
        let yaml = minimal_yaml(path, r"mgmt\key", "client-key");
        let quoted = yaml
            .lines()
            .find_map(|line| line.strip_prefix("auth-dir: "))
            .unwrap();
        assert_eq!(serde_json::from_str::<String>(quoted).unwrap(), path);
        assert!(yaml.contains(r#"secret-key: "mgmt\\key""#));
    }
}
