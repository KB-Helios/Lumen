//! Saved profiles contain metadata only; immutable credential slots make failed saves reversible.
use super::{files, paths};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;
use zeroize::Zeroizing;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderApp {
    Claude,
    Codex,
    Gemini,
    Opencode,
    Openclaw,
}

impl ProviderApp {
    fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::Opencode => "opencode",
            Self::Openclaw => "openclaw",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileInput {
    pub app: ProviderApp,
    pub id: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedProfile {
    app: ProviderApp,
    id: String,
    base_url: String,
    model: String,
    credential: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub app: ProviderApp,
    pub id: String,
    pub base_url: String,
    pub model: String,
    pub active: bool,
    pub enabled: bool,
}

pub trait Credentials {
    fn get(&self, id: &str) -> Result<String, String>;
    fn set(&self, id: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}

pub struct ProfileStore<C: Credentials> {
    root: PathBuf,
    home: PathBuf,
    credentials: C,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialChange {
    new: String,
    old: Option<String>,
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let bytes = files::read_bytes(path).map_err(|_| "Provider metadata could not be read")?;
    bytes
        .map(|bytes| {
            serde_json::from_slice(&bytes).map_err(|_| "Provider metadata is invalid".into())
        })
        .transpose()
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Provider metadata could not be saved")?;
    if bytes.len() > files::MAX_TEXT_BYTES {
        return Err("Provider metadata limit reached".into());
    }
    files::atomic_write(path, &bytes, true)
        .map_err(|_| "Provider metadata could not be saved".into())
}

impl<C: Credentials> ProfileStore<C> {
    pub fn new(root: PathBuf, home: PathBuf, credentials: C) -> Self {
        Self {
            root,
            home,
            credentials,
        }
    }
    fn metadata(&self) -> Result<Vec<SavedProfile>, String> {
        let profiles: Vec<SavedProfile> =
            read_json(&self.root.join("profiles.json"))?.unwrap_or_default();
        if profiles.len() > 128 {
            return Err("Provider metadata limit reached".into());
        }
        for profile in &profiles {
            files::ProviderTarget::new(
                &profile.id,
                &profile.base_url,
                "validation",
                &profile.model,
            )?;
            uuid::Uuid::parse_str(&profile.credential)
                .map_err(|_| "Provider metadata is invalid")?;
        }
        Ok(profiles)
    }

    fn recover_credentials(&self, profiles: &[SavedProfile]) -> Result<(), String> {
        let path = self.root.join("credential-change.json");
        if let Some(change) = read_json::<CredentialChange>(&path)? {
            for id in std::iter::once(change.new).chain(change.old) {
                uuid::Uuid::parse_str(&id).map_err(|_| "Provider recovery metadata is invalid")?;
                if !profiles.iter().any(|profile| profile.credential == id) {
                    self.credentials
                        .delete(&id)
                        .map_err(|_| "Provider credential cleanup needs retry")?;
                }
            }
            std::fs::remove_file(path).map_err(|_| "Provider recovery cleanup needs retry")?;
        }
        Ok(())
    }

    fn load(&self) -> Result<Vec<SavedProfile>, String> {
        let profiles = self.metadata()?;
        self.recover_credentials(&profiles)?;
        Ok(profiles)
    }

    fn status(&self, profile: &SavedProfile, key: &str) -> Result<Profile, String> {
        let target =
            files::ProviderTarget::new(&profile.id, &profile.base_url, key, &profile.model)?;
        let (active, enabled) = files::profile_status(&self.home, profile.app.name(), &target)
            .map_err(|_| "Provider live configuration could not be inspected")?;
        Ok(Profile {
            app: profile.app,
            id: profile.id.clone(),
            base_url: profile.base_url.clone(),
            model: profile.model.clone(),
            active,
            enabled,
        })
    }

    pub fn list(&self) -> Result<Vec<Profile>, String> {
        self.load()?
            .iter()
            .map(|profile| {
                let key = Zeroizing::new(
                    self.credentials
                        .get(&profile.credential)
                        .map_err(|_| "Stored provider credential is unavailable")?,
                );
                self.status(profile, &key)
            })
            .collect()
    }

    pub fn save(&self, input: ProfileInput, adding: bool) -> Result<Profile, String> {
        let mut profiles = self.load()?;
        let index = profiles
            .iter()
            .position(|profile| profile.app == input.app && profile.id == input.id);
        if adding == index.is_some() {
            return Err(if adding {
                "Provider profile already exists"
            } else {
                "Provider profile was not found"
            }
            .into());
        }
        if adding && profiles.len() >= 128 {
            return Err("Provider profile limit reached".into());
        }
        let previous = index.map(|index| profiles[index].credential.clone());
        let replacement = input
            .api_key
            .filter(|key| !key.is_empty())
            .map(Zeroizing::new);
        let key = match &replacement {
            Some(key) => Zeroizing::new(key.to_string()),
            None => Zeroizing::new(
                self.credentials
                    .get(previous.as_deref().ok_or("An API key is required")?)
                    .map_err(|_| "Stored provider credential is unavailable")?,
            ),
        };
        files::ProviderTarget::new(&input.id, &input.base_url, &key, &input.model)?;
        let credential = if replacement.is_some() {
            uuid::Uuid::new_v4().to_string()
        } else {
            previous.clone().ok_or("An API key is required")?
        };
        let profile = SavedProfile {
            app: input.app,
            id: input.id,
            base_url: input.base_url,
            model: input.model,
            credential: credential.clone(),
        };
        let result = self.status(&profile, &key)?;
        if let Some(index) = index {
            profiles[index] = profile;
        } else {
            profiles.push(profile);
        }
        // The intent contains references only. Recovery keeps whichever slot the atomic metadata points to.
        if replacement.is_some() {
            write_json(
                &self.root.join("credential-change.json"),
                &CredentialChange {
                    new: credential.clone(),
                    old: previous,
                },
            )?;
            if self.credentials.set(&credential, &key).is_err() {
                let _ = self.recover_credentials(&self.metadata()?);
                return Err("Provider credential could not be saved".into());
            }
        }
        if let Err(error) = write_json(&self.root.join("profiles.json"), &profiles) {
            let _ = self.recover_credentials(&self.metadata()?);
            return Err(error);
        }
        // A cleanup failure leaves the secret-free intent for the next operation; the save is committed.
        let _ = self.recover_credentials(&profiles);
        Ok(result)
    }

    pub fn activate(&self, app: ProviderApp, id: &str) -> Result<Profile, String> {
        files::validate_provider_id(id)?;
        let profiles = self.load()?;
        let profile = profiles
            .iter()
            .find(|profile| profile.app == app && profile.id == id)
            .ok_or("Provider profile was not found")?;
        let key = Zeroizing::new(
            self.credentials
                .get(&profile.credential)
                .map_err(|_| "Stored provider credential is unavailable")?,
        );
        let target = files::ProviderTarget::new(id, &profile.base_url, &key, &profile.model)?;
        files::activate_profile(&self.home, app.name(), &target)
            .map_err(|_| "Provider activation failed; retry to recover the pending operation")?;
        self.status(profile, &key)
    }

    pub fn remove(&self, app: ProviderApp, id: &str) -> Result<bool, String> {
        files::validate_provider_id(id)?;
        let profiles = self.load()?;
        let profile = profiles
            .iter()
            .find(|profile| profile.app == app && profile.id == id)
            .ok_or("Provider profile was not found")?;
        let key = Zeroizing::new(
            self.credentials
                .get(&profile.credential)
                .map_err(|_| "Stored provider credential is unavailable")?,
        );
        let target = files::ProviderTarget::new(id, &profile.base_url, &key, &profile.model)?;
        files::remove_managed_profile(&self.home, app.name(), &target)
            .map_err(|_| "Provider removal failed; retry to recover the pending operation".into())
    }
}

pub struct WindowsCredentials;
#[cfg(windows)]
impl Credentials for WindowsCredentials {
    fn get(&self, id: &str) -> Result<String, String> {
        keyring::Entry::new("com.bridgehammer.lumen.tool-profiles", id)
            .and_then(|entry| entry.get_password())
            .map_err(|_| "Provider credential is unavailable".into())
    }
    fn set(&self, id: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new("com.bridgehammer.lumen.tool-profiles", id)
            .and_then(|entry| entry.set_password(secret))
            .map_err(|_| "Provider credential could not be saved".into())
    }
    fn delete(&self, id: &str) -> Result<(), String> {
        match keyring::Entry::new("com.bridgehammer.lumen.tool-profiles", id)
            .and_then(|entry| entry.delete_credential())
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Provider credential could not be removed".into()),
        }
    }
}
#[cfg(not(windows))]
impl Credentials for WindowsCredentials {
    fn get(&self, _: &str) -> Result<String, String> {
        Err("Windows Credential Manager is required".into())
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Err("Windows Credential Manager is required".into())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Err("Windows Credential Manager is required".into())
    }
}

fn native_store(app: &tauri::AppHandle) -> Result<ProfileStore<WindowsCredentials>, String> {
    let home = paths::home_dir();
    if !home.is_absolute() {
        return Err("Provider home directory is unavailable".into());
    }
    Ok(ProfileStore::new(
        app.path()
            .app_data_dir()
            .map_err(|_| "Provider storage is unavailable")?
            .join("tool-profiles"),
        home,
        WindowsCredentials,
    ))
}
#[tauri::command]
pub fn list_provider_profiles(app: tauri::AppHandle) -> Result<Vec<Profile>, String> {
    let _guard = files::PROFILE_LOCK
        .lock()
        .map_err(|_| "Provider storage is busy")?;
    native_store(&app)?.list()
}
#[tauri::command]
pub fn add_provider(app: tauri::AppHandle, input: ProfileInput) -> Result<Profile, String> {
    let _guard = files::PROFILE_LOCK
        .lock()
        .map_err(|_| "Provider storage is busy")?;
    native_store(&app)?.save(input, true)
}
#[tauri::command]
pub fn update_provider(app: tauri::AppHandle, input: ProfileInput) -> Result<Profile, String> {
    let _guard = files::PROFILE_LOCK
        .lock()
        .map_err(|_| "Provider storage is busy")?;
    native_store(&app)?.save(input, false)
}
#[tauri::command]
pub fn activate_provider_profile(
    handle: tauri::AppHandle,
    app: ProviderApp,
    id: String,
) -> Result<Profile, String> {
    let _guard = files::PROFILE_LOCK
        .lock()
        .map_err(|_| "Provider storage is busy")?;
    native_store(&handle)?.activate(app, &id)
}
#[tauri::command]
pub fn remove_provider_profile_from_live(
    handle: tauri::AppHandle,
    app: ProviderApp,
    id: String,
) -> Result<bool, String> {
    let _guard = files::PROFILE_LOCK
        .lock()
        .map_err(|_| "Provider storage is busy")?;
    native_store(&handle)?.remove(app, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::HashMap};

    #[cfg(windows)]
    #[test]
    #[ignore = "writes one owned synthetic Windows Credential Manager slot; run explicitly"]
    fn windows_credentials_owned_slot_round_trip() {
        struct OwnedSlot(String);
        impl Drop for OwnedSlot {
            fn drop(&mut self) {
                if WindowsCredentials.delete(&self.0).is_err() {
                    eprintln!("Owned credential cleanup failed for slot {}", self.0);
                }
            }
        }

        let id = uuid::Uuid::new_v4().to_string();
        let entry = keyring::Entry::new("com.bridgehammer.lumen.tool-profiles", &id)
            .expect("create owned credential reference");
        assert!(
            matches!(entry.get_password(), Err(keyring::Error::NoEntry)),
            "fresh owned slot must be absent before writing"
        );
        // Arm cleanup only after proving the slot is absent, before any write can fail.
        let slot = OwnedSlot(id);
        let credentials = WindowsCredentials;
        for secret in [
            "lumen-synthetic-fixture-first",
            "lumen-synthetic-fixture-replacement",
        ] {
            credentials
                .set(&slot.0, secret)
                .expect("save owned fixture");
            assert!(
                credentials.get(&slot.0).expect("read owned fixture") == secret,
                "owned fixture must round-trip without exposing its value"
            );
        }
        credentials.delete(&slot.0).expect("delete owned fixture");
        assert!(
            matches!(entry.get_password(), Err(keyring::Error::NoEntry)),
            "owned slot must be absent after deletion"
        );
        credentials
            .delete(&slot.0)
            .expect("missing slot deletion is idempotent");
    }

    #[derive(Default)]
    struct FakeCredentials {
        entries: RefCell<HashMap<String, String>>,
        fail_set: std::cell::Cell<bool>,
        fail_delete: std::cell::Cell<bool>,
        block_metadata: RefCell<Option<PathBuf>>,
    }
    impl Credentials for FakeCredentials {
        fn get(&self, id: &str) -> Result<String, String> {
            self.entries
                .borrow()
                .get(id)
                .cloned()
                .ok_or("missing".into())
        }
        fn set(&self, id: &str, secret: &str) -> Result<(), String> {
            if self.fail_set.get() {
                return Err("secret-backend-error".into());
            }
            self.entries.borrow_mut().insert(id.into(), secret.into());
            if let Some(path) = self.block_metadata.borrow_mut().take() {
                std::fs::remove_file(&path).unwrap();
                std::fs::create_dir(&path).unwrap();
            }
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            if self.fail_delete.get() {
                return Err("secret-backend-error".into());
            }
            self.entries.borrow_mut().remove(id);
            Ok(())
        }
    }
    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            Self {
                root: std::env::temp_dir().join(format!("lumen-profiles-{}", uuid::Uuid::new_v4())),
            }
        }
        fn store(&self) -> ProfileStore<FakeCredentials> {
            ProfileStore::new(
                self.root.join("data"),
                self.root.join("home"),
                FakeCredentials::default(),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    fn input(app: ProviderApp, key: Option<&str>) -> ProfileInput {
        ProfileInput {
            app,
            id: "fixture".into(),
            base_url: "https://fixture.example/v1".into(),
            model: "fixture-model".into(),
            api_key: key.map(str::to_owned),
        }
    }

    #[test]
    fn saves_metadata_without_secret_or_live_configuration() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let result = store
            .save(input(ProviderApp::Claude, Some("fixture-secret")), true)
            .expect("save profile");
        assert!(
            !serde_json::to_string(&result)
                .unwrap()
                .contains("fixture-secret")
        );
        assert!(
            !std::fs::read_to_string(store.root.join("profiles.json"))
                .unwrap()
                .contains("fixture-secret")
        );
        assert!(!store.home.join(".claude/settings.json").exists());
        assert_eq!(store.credentials.entries.borrow().len(), 1);
    }

    #[test]
    fn all_five_targets_activate_remove_and_retain_unrelated_configuration() {
        for (app, relative, contents, marker) in [
            (
                ProviderApp::Claude,
                ".claude/settings.json",
                r#"{"hooks":{"keep":"sentinel"}}"#,
                "sentinel",
            ),
            (
                ProviderApp::Codex,
                ".codex/config.toml",
                "[projects.keep]\ntrust_level = \"trusted\"\n",
                "trust_level",
            ),
            (
                ProviderApp::Gemini,
                ".gemini/.env",
                "# keep\nDEBUG=sentinel\n",
                "DEBUG=sentinel",
            ),
            (
                ProviderApp::Opencode,
                ".config/opencode/opencode.json",
                r#"{"provider":{"other":{"sentinel":true}}}"#,
                "sentinel",
            ),
            (
                ProviderApp::Openclaw,
                ".openclaw/openclaw.json",
                r#"{"models":{"providers":{"other":{"sentinel":true}}}}"#,
                "sentinel",
            ),
        ] {
            let fixture = Fixture::new();
            let store = fixture.store();
            let path = store.home.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, contents).unwrap();
            store
                .save(input(app, Some("fixture-secret")), true)
                .unwrap();
            assert!(!store.list().unwrap()[0].active);
            assert!(store.activate(app, "fixture").unwrap().active);
            assert!(
                std::fs::read_to_string(&path)
                    .unwrap()
                    .contains("fixture-secret")
            );
            assert!(std::fs::read_to_string(&path).unwrap().contains(marker));
            let mut edited = input(app, None);
            edited.model = "updated-model".into();
            store.save(edited, false).unwrap();
            assert!(
                !store.list().unwrap()[0].active,
                "saved edits require activation"
            );
            assert!(store.list().unwrap()[0].enabled);
            store.activate(app, "fixture").unwrap();
            assert!(
                std::fs::read_to_string(&path)
                    .unwrap()
                    .contains("updated-model")
            );
            assert!(store.remove(app, "fixture").unwrap());
            let remaining = std::fs::read_to_string(&path).unwrap();
            assert!(remaining.contains(marker));
            assert!(!remaining.contains("fixture-secret"));
            assert!(!store.list().unwrap()[0].enabled);
            assert_eq!(store.credentials.entries.borrow().len(), 1);
        }
    }

    #[test]
    fn empty_key_keeps_stored_credential_and_secret_failures_do_not_replace_metadata() {
        let fixture = Fixture::new();
        let store = fixture.store();
        store
            .save(input(ProviderApp::Claude, Some("original-secret")), true)
            .unwrap();
        let original = std::fs::read(store.root.join("profiles.json")).unwrap();
        store
            .save(input(ProviderApp::Claude, Some("")), false)
            .unwrap();
        assert_eq!(
            std::fs::read(store.root.join("profiles.json")).unwrap(),
            original
        );
        store.credentials.fail_set.set(true);
        let error = store
            .save(
                input(ProviderApp::Claude, Some("replacement-secret")),
                false,
            )
            .err()
            .unwrap();
        assert_eq!(error, "Provider credential could not be saved");
        assert_eq!(
            std::fs::read(store.root.join("profiles.json")).unwrap(),
            original
        );
        store.activate(ProviderApp::Claude, "fixture").unwrap();
        assert!(
            std::fs::read_to_string(paths::claude_settings(&store.home))
                .unwrap()
                .contains("original-secret")
        );
    }

    #[test]
    fn failed_metadata_publish_keeps_previous_key_and_recovers_unused_slot() {
        let fixture = Fixture::new();
        let store = fixture.store();
        store
            .save(input(ProviderApp::Claude, Some("original-secret")), true)
            .unwrap();
        let metadata = store.root.join("profiles.json");
        let original = std::fs::read(&metadata).unwrap();
        *store.credentials.block_metadata.borrow_mut() = Some(metadata.clone());
        assert!(
            store
                .save(
                    input(ProviderApp::Claude, Some("replacement-secret")),
                    false
                )
                .is_err()
        );
        std::fs::remove_dir(&metadata).unwrap();
        std::fs::write(&metadata, &original).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(store.credentials.entries.borrow().len(), 1);
        store.activate(ProviderApp::Claude, "fixture").unwrap();
        assert!(
            std::fs::read_to_string(paths::claude_settings(&store.home))
                .unwrap()
                .contains("original-secret")
        );
    }

    #[test]
    fn committed_credential_cleanup_resumes_after_restart() {
        let fixture = Fixture::new();
        let store = fixture.store();
        store
            .save(input(ProviderApp::Claude, Some("original-secret")), true)
            .unwrap();
        store.credentials.fail_delete.set(true);
        store
            .save(
                input(ProviderApp::Claude, Some("replacement-secret")),
                false,
            )
            .unwrap();
        assert!(store.root.join("credential-change.json").exists());
        store.credentials.fail_delete.set(false);
        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(store.credentials.entries.borrow().len(), 1);
        assert!(!store.root.join("credential-change.json").exists());
        store.activate(ProviderApp::Claude, "fixture").unwrap();
        assert!(
            std::fs::read_to_string(paths::claude_settings(&store.home))
                .unwrap()
                .contains("replacement-secret")
        );
    }

    #[test]
    fn inactive_exclusive_removal_never_clears_current_profile() {
        let fixture = Fixture::new();
        let store = fixture.store();
        store
            .save(input(ProviderApp::Claude, Some("first-secret")), true)
            .unwrap();
        store.activate(ProviderApp::Claude, "fixture").unwrap();
        let mut other = input(ProviderApp::Claude, Some("second-secret"));
        other.id = "other".into();
        store.save(other, true).unwrap();
        assert!(!store.remove(ProviderApp::Claude, "other").unwrap());
        assert!(store.list().unwrap()[0].active);
    }

    #[test]
    fn unsupported_targets_missing_keys_and_bad_fields_do_not_write() {
        assert!(
            serde_json::from_str::<ProfileInput>(
                r#"{"app":"unsupported","id":"x","baseUrl":"https://x","model":"m"}"#
            )
            .is_err()
        );
        let fixture = Fixture::new();
        let store = fixture.store();
        assert!(store.save(input(ProviderApp::Claude, None), true).is_err());
        let mut invalid = input(ProviderApp::Gemini, Some("secret"));
        invalid.base_url = "file:///secret".into();
        assert!(store.save(invalid, true).is_err());
        assert!(store.credentials.entries.borrow().is_empty());
        assert!(!store.root.join("profiles.json").exists());
    }

    #[test]
    fn openclaw_activation_uses_documented_connection_fields() {
        let fixture = Fixture::new();
        let store = fixture.store();
        store
            .save(input(ProviderApp::Openclaw, Some("fixture-secret")), true)
            .unwrap();
        store.activate(ProviderApp::Openclaw, "fixture").unwrap();
        let live: serde_json::Value =
            serde_json::from_slice(&std::fs::read(paths::openclaw_config(&store.home)).unwrap())
                .unwrap();
        let node = &live["models"]["providers"]["fixture"];
        assert!(
            node["baseUrl"] == "https://fixture.example/v1" && node["apiKey"] == "fixture-secret"
        );
        assert!(node.get("base_url").is_none() && node.get("api_key").is_none());
        assert!(
            node["models"][0]["name"] == "fixture-model",
            "OpenClaw requires a nonempty model name"
        );
    }

    #[test]
    fn managed_additive_removal_restores_prior_fields_and_preserves_later_user_edits() {
        for (app, relative, contents, pointer) in [
            (
                ProviderApp::Opencode,
                ".config/opencode/opencode.json",
                r#"{"provider":{"fixture":{"npm":"user-package","options":{"baseURL":"https://user.example","apiKey":"user-key","headers":{"X-Keep":"yes"}},"models":{"fixture-model":{"name":"User name","limit":123},"other-model":{"name":"Other"}}}}}"#,
                "/provider/fixture",
            ),
            (
                ProviderApp::Openclaw,
                ".openclaw/openclaw.json",
                r#"{"models":{"providers":{"fixture":{"baseUrl":"https://user.example","apiKey":"user-key","models":[{"id":"fixture-model","name":"User name"},{"id":"other-model","name":"Other"}],"keep":"yes"}}}}"#,
                "/models/providers/fixture",
            ),
        ] {
            let fixture = Fixture::new();
            let store = fixture.store();
            let path = store.home.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, contents).unwrap();
            store
                .save(input(app, Some("fixture-secret")), true)
                .unwrap();
            store.activate(app, "fixture").unwrap();
            let mut live: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            live.pointer_mut(pointer).unwrap()["user-added"] = serde_json::json!(true);
            if app == ProviderApp::Opencode {
                live.pointer_mut(pointer).unwrap()["options"]["apiKey"] =
                    serde_json::json!("external-key");
            } else {
                live.pointer_mut(pointer).unwrap()["apiKey"] = serde_json::json!("external-key");
            }
            std::fs::write(&path, serde_json::to_vec(&live).unwrap()).unwrap();
            assert!(store.remove(app, "fixture").unwrap());
            let remaining: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let mut expected: serde_json::Value = serde_json::from_str(contents).unwrap();
            expected.pointer_mut(pointer).unwrap()["user-added"] = serde_json::json!(true);
            if app == ProviderApp::Opencode {
                expected.pointer_mut(pointer).unwrap()["options"]["apiKey"] =
                    serde_json::json!("external-key");
            } else {
                expected.pointer_mut(pointer).unwrap()["apiKey"] =
                    serde_json::json!("external-key");
            }
            assert!(
                remaining == expected,
                "removal must restore prior fields and preserve external changes"
            );
            assert!(!store.list().unwrap()[0].enabled);
        }
    }

    #[test]
    fn reactivating_additive_edits_removes_only_the_previous_owned_model() {
        for (app, relative, pointer) in [
            (
                ProviderApp::Opencode,
                ".config/opencode/opencode.json",
                "/provider/fixture",
            ),
            (
                ProviderApp::Openclaw,
                ".openclaw/openclaw.json",
                "/models/providers/fixture",
            ),
        ] {
            let fixture = Fixture::new();
            let store = fixture.store();
            let path = store.home.join(relative);
            store
                .save(input(app, Some("fixture-secret")), true)
                .unwrap();
            store.activate(app, "fixture").unwrap();
            let mut live: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let node = live.pointer_mut(pointer).unwrap();
            if app == ProviderApp::Opencode {
                node["models"]["external-model"] = serde_json::json!({"name":"External"});
            } else {
                node["models"]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::json!({"id":"external-model","name":"External"}));
                assert!(
                    node.get("baseUrl").is_some() && node.get("apiKey").is_some(),
                    "OpenClaw uses camel-case connection fields"
                );
                assert!(node.get("base_url").is_none() && node.get("api_key").is_none());
            }
            std::fs::write(&path, serde_json::to_vec(&live).unwrap()).unwrap();
            let mut edited = input(app, None);
            edited.model = "updated-model".into();
            store.save(edited, false).unwrap();
            assert!(store.list().unwrap()[0].enabled);
            store.activate(app, "fixture").unwrap();
            let live = std::fs::read_to_string(&path).unwrap();
            assert!(
                !live.contains("fixture-model"),
                "obsolete owned model must be removed"
            );
            assert!(live.contains("updated-model") && live.contains("external-model"));
            assert!(store.remove(app, "fixture").unwrap());
            let live = std::fs::read_to_string(&path).unwrap();
            assert!(live.contains("external-model") && !live.contains("updated-model"));
        }
    }

    #[test]
    fn exclusive_removal_refuses_external_connection_edits_even_after_saved_edits() {
        for (app, relative) in [
            (ProviderApp::Claude, ".claude/settings.json"),
            (ProviderApp::Codex, ".codex/config.toml"),
            (ProviderApp::Gemini, ".gemini/.env"),
        ] {
            let fixture = Fixture::new();
            let store = fixture.store();
            let path = store.home.join(relative);
            store
                .save(input(app, Some("fixture-secret")), true)
                .unwrap();
            store.activate(app, "fixture").unwrap();
            let mut edited = input(app, Some("replacement-secret"));
            edited.model = "saved-model".into();
            store.save(edited, false).unwrap();
            assert!(
                store.list().unwrap()[0].enabled,
                "saved edits must not discard live ownership"
            );
            let external = std::fs::read_to_string(&path)
                .unwrap()
                .replace("fixture-secret", "external-secret");
            std::fs::write(&path, &external).unwrap();
            assert!(
                !store.list().unwrap()[0].enabled,
                "external edits invalidate removal admission"
            );
            assert!(!store.remove(app, "fixture").unwrap());
            assert!(std::fs::read_to_string(&path).unwrap() == external);
        }
    }

    #[test]
    fn enabling_additive_profiles_preserves_other_model_entries_in_the_same_node() {
        for (app, relative, contents) in [
            (
                ProviderApp::Opencode,
                ".config/opencode/opencode.json",
                r#"{"provider":{"fixture":{"models":{"other-model":{"name":"Other"}},"options":{"headers":{"X-Keep":"yes"}}}}}"#,
            ),
            (
                ProviderApp::Openclaw,
                ".openclaw/openclaw.json",
                r#"{"models":{"providers":{"fixture":{"models":[{"id":"other-model","name":"Other"}],"keep":"yes"}}}}"#,
            ),
        ] {
            let fixture = Fixture::new();
            let store = fixture.store();
            let path = store.home.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, contents).unwrap();
            store
                .save(input(app, Some("fixture-secret")), true)
                .unwrap();
            store.activate(app, "fixture").unwrap();
            let live = std::fs::read_to_string(path).unwrap();
            assert!(live.contains("other-model"));
            assert!(live.contains("yes"));
            assert!(live.contains("fixture-model"));
            assert!(store.list().unwrap()[0].active);
        }
    }
}
