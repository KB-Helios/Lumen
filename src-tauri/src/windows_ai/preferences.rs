use std::{fs, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[default]
    Auto,
    Runtime,
    Windows,
    Aion,
    Edge,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub local_engine: Engine,
    pub windows_enabled: bool,
    pub model_downloads_allowed: bool,
    pub app_content_enabled: bool,
    pub agents_enabled: bool,
    pub register_lumen_agent: bool,
    pub text_tools_enabled: bool,
    pub ocr_enabled: bool,
    pub image_descriptions_enabled: bool,
    pub edge_enabled: bool,
    pub dictation_enabled: bool,
    pub source_language: String,
    pub target_language: String,
    pub speech_language: String,
    pub keep_warm: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            local_engine: Engine::Auto,
            windows_enabled: false,
            model_downloads_allowed: false,
            app_content_enabled: false,
            agents_enabled: false,
            register_lumen_agent: false,
            text_tools_enabled: false,
            ocr_enabled: false,
            image_descriptions_enabled: false,
            edge_enabled: false,
            dictation_enabled: false,
            source_language: "en".to_owned(),
            target_language: "sv".to_owned(),
            speech_language: "en-US".to_owned(),
            keep_warm: false,
        }
    }
}

pub fn valid_language(value: &str) -> bool {
    if !(2..=35).contains(&value.len()) {
        return false;
    }
    let mut parts = value.split('-');
    let Some(first) = parts.next() else {
        return false;
    };
    (2..=8).contains(&first.len())
        && first.bytes().all(|c| c.is_ascii_alphabetic())
        && parts.all(|part| {
            (1..=8).contains(&part.len()) && part.bytes().all(|c| c.is_ascii_alphanumeric())
        })
}

impl Preferences {
    pub fn validate(&self) -> Result<(), String> {
        if [
            &self.source_language,
            &self.target_language,
            &self.speech_language,
        ]
        .into_iter()
        .all(|language| valid_language(language))
        {
            Ok(())
        } else {
            Err("Windows AI language settings are invalid".to_owned())
        }
    }

    pub fn load(path: &Path) -> Self {
        fs::read(path)
            .ok()
            .filter(|bytes| bytes.len() <= 16 * 1024)
            .and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok())
            .filter(|preferences| preferences.validate().is_ok())
            .unwrap_or_default()
    }

    pub fn patch(&self, patch: Value) -> Result<Self, String> {
        let patch = patch
            .as_object()
            .filter(|patch| patch.len() <= 16)
            .ok_or_else(|| "Windows AI preferences must be a bounded settings patch".to_owned())?;
        let mut value = serde_json::to_value(self)
            .map_err(|_| "Windows AI preferences are unavailable".to_owned())?;
        let settings = value
            .as_object_mut()
            .ok_or_else(|| "Windows AI preferences are unavailable".to_owned())?;
        for (key, value) in patch {
            if !settings.contains_key(key) {
                return Err("Unknown Windows AI preference".to_owned());
            }
            settings.insert(key.clone(), value.clone());
        }
        let updated: Self = serde_json::from_value(value)
            .map_err(|_| "Invalid Windows AI preference value".to_owned())?;
        updated.validate()?;
        Ok(updated)
    }

    pub fn persist(&self, path: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec(self)
            .map_err(|_| "Windows AI preferences could not be saved".to_owned())?;
        let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| "Windows AI preferences could not be saved".to_owned())?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|_| "Windows AI preferences could not be saved".to_owned())?;
            drop(file);
            replace_file(&temporary, path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }

    pub fn gate(&self, operation: &str) -> Result<(), String> {
        let enabled = match operation {
            "status" | "indexDelete" | "unregisterAgent" | "verifyOwnRegistration" => true,
            "prepare" => self.windows_enabled && self.model_downloads_allowed,
            "answer" => self.windows_enabled,
            "text" => self.windows_enabled && self.text_tools_enabled,
            "ocr" => self.windows_enabled && self.ocr_enabled,
            "describe" => self.windows_enabled && self.image_descriptions_enabled,
            "indexSync" | "indexSearch" => self.windows_enabled && self.app_content_enabled,
            "agents" | "invokeAgent" => self.windows_enabled && self.agents_enabled,
            "registerAgent" => {
                self.windows_enabled && self.agents_enabled && self.register_lumen_agent
            }
            _ => false,
        };
        enabled
            .then_some(())
            .ok_or_else(|| "This Windows AI operation is disabled by native preferences".to_owned())
    }

    pub fn feature_enabled(&self, feature: &str) -> bool {
        self.windows_enabled
            && match feature {
                "languageModel" | "aion" => true,
                "summarize" | "rewrite" => self.text_tools_enabled,
                "ocr" => self.ocr_enabled,
                "imageDescription" => self.image_descriptions_enabled,
                "appContentSearch" => self.app_content_enabled,
                "agentDiscovery" | "agentInvocation" => self.agents_enabled,
                "agentRegistration" => self.agents_enabled && self.register_lumen_agent,
                _ => false,
            }
    }
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        },
        core::PCWSTR,
    };
    let source: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<_> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|_| "Windows AI preferences could not be saved".to_owned())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|_| "Windows AI preferences could not be saved".to_owned())
}
