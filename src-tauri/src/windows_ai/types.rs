use super::{
    files::Citation,
    preferences::{Engine, Preferences},
};
use serde::{Deserialize, Serialize};

pub const FEATURES: [(&str, &str); 10] = [
    ("languageModel", "Windows language model"),
    ("aion", "Native Aion"),
    ("summarize", "Windows summarization"),
    ("rewrite", "Windows rewriting"),
    ("ocr", "Windows OCR"),
    ("imageDescription", "Windows image descriptions"),
    ("appContentSearch", "Windows public app content"),
    ("agentDiscovery", "Windows agent discovery"),
    ("agentInvocation", "Windows agent launchers"),
    ("agentRegistration", "Lumen browser agent registration"),
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub package_family_name: String,
    pub action_id: String,
}

impl Agent {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 512
            || self.name.is_empty()
            || self.name.len() > 256
            || self.display_name.is_empty()
            || self.display_name.len() > 160
            || self.description.len() > 600
            || self.package_family_name.is_empty()
            || self.package_family_name.len() > 256
            || self.action_id.is_empty()
            || self.action_id.len() > 256
            || [
                &self.id,
                &self.name,
                &self.display_name,
                &self.package_family_name,
                &self.action_id,
            ]
            .iter()
            .any(|v| v.chars().any(char::is_control))
        {
            Err("Windows returned invalid agent metadata".to_owned())
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Feature {
    pub id: String,
    pub host: String,
    pub label: String,
    pub availability: String,
    pub reason_code: String,
    pub detail: Option<String>,
    pub enabled: bool,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Host {
    pub os_build: String,
    pub architecture: String,
    pub package_identity: bool,
    pub runtime_version: Option<String>,
    pub npu_providers: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppIndex {
    pub state: String,
    pub items: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub version: u8,
    pub host: Host,
    pub features: Vec<Feature>,
    pub preferences: Preferences,
    pub agents: Vec<Agent>,
    pub app_index: AppIndex,
    pub access_token_configured: bool,
}

pub fn package_family() -> Option<String> {
    #[cfg(windows)]
    {
        use windows::{
            Win32::{
                Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS},
                Storage::Packaging::Appx::GetCurrentPackageFamilyName,
            },
            core::PWSTR,
        };
        let mut length = 0;
        if unsafe { GetCurrentPackageFamilyName(&mut length, None) } != ERROR_INSUFFICIENT_BUFFER
            || length > 256
        {
            return None;
        }
        let mut buffer = vec![0u16; length as usize];
        if unsafe { GetCurrentPackageFamilyName(&mut length, Some(PWSTR(buffer.as_mut_ptr()))) }
            != ERROR_SUCCESS
        {
            return None;
        }
        let family = String::from_utf16(
            &buffer[..buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len())],
        )
        .ok()?;
        family.starts_with("Bridgehammer.Lumen_").then_some(family)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

impl Snapshot {
    pub fn fallback(preferences: Preferences, reason: &str) -> Self {
        let identity = package_family().is_some();
        let architecture = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            "x86" => "x86",
            _ => "unknown",
        };
        let features = FEATURES.into_iter().map(|(id, label)| {
            let availability = if id == "aion" && architecture != "arm64" { "unsupported" }
                else if id == "agentRegistration" && !identity { "identityRequired" }
                else { "runtimeRequired" };
            Feature {id: id.to_owned(),host: "windows".to_owned(),label: label.to_owned(),availability: availability.to_owned(),reason_code: reason.to_owned(),detail: Some("The staged Windows AI helper or a required native prerequisite is unavailable.".to_owned()),enabled: preferences.feature_enabled(id),model: None}
        }).collect();
        let index_state = if preferences.app_content_enabled {
            "unavailable"
        } else {
            "disabled"
        };
        Self {
            version: 1,
            host: Host {
                os_build: "unknown".to_owned(),
                architecture: architecture.to_owned(),
                package_identity: identity,
                runtime_version: None,
                npu_providers: Vec::new(),
            },
            features,
            preferences,
            agents: Vec::new(),
            app_index: AppIndex {
                state: index_state.to_owned(),
                items: 0,
            },
            access_token_configured: super::credentials::get().is_some(),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        let availability = [
            "ready",
            "downloadable",
            "preparing",
            "unavailable",
            "accessRequired",
            "identityRequired",
            "runtimeRequired",
            "unsupported",
            "disabled",
            "failed",
        ];
        if self.version != 1
            || self.host.os_build.len() > 64
            || !["x64", "arm64", "x86", "unknown"].contains(&self.host.architecture.as_str())
            || self
                .host
                .runtime_version
                .as_ref()
                .is_some_and(|s| s.len() > 100)
            || self.host.npu_providers.len() > 32
            || self.host.npu_providers.iter().any(|s| s.len() > 200)
            || self.features.len() != FEATURES.len()
            || FEATURES.iter().any(|(id, _)| {
                self.features
                    .iter()
                    .filter(|feature| feature.id == *id)
                    .count()
                    != 1
            })
            || self.features.iter().any(|f| {
                !FEATURES.iter().any(|(id, _)| *id == f.id)
                    || f.host != "windows"
                    || f.label.is_empty()
                    || f.label.len() > 120
                    || !availability.contains(&f.availability.as_str())
                    || f.reason_code.is_empty()
                    || f.reason_code.len() > 80
                    || f.detail.as_ref().is_some_and(|s| s.len() > 600)
                    || f.model.as_ref().is_some_and(|s| s.len() > 160)
            })
            || self.agents.len() > 128
            || self.agents.iter().any(|a| a.validate().is_err())
            || self.app_index.items > 1000
            || !["disabled", "ready", "indexing", "unavailable", "error"]
                .contains(&self.app_index.state.as_str())
        {
            return Err("Windows AI helper returned an invalid status snapshot".to_owned());
        }
        self.preferences.validate()
    }

    pub fn authoritative(&mut self, preferences: Preferences, agents: Vec<Agent>) {
        self.host.package_identity = self.host.package_identity && package_family().is_some();
        self.access_token_configured = super::credentials::get().is_some();
        for feature in &mut self.features {
            feature.enabled = preferences.feature_enabled(&feature.id);
        }
        self.preferences = preferences;
        self.agents = if self.preferences.agents_enabled {
            agents
        } else {
            Vec::new()
        };
        if !self.preferences.windows_enabled || !self.preferences.app_content_enabled {
            self.app_index = AppIndex {
                state: "disabled".to_owned(),
                items: 0,
            };
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextRequest {
    pub request_id: String,
    pub engine: Engine,
    pub task: String,
    pub text: String,
    pub source_language: Option<String>,
    pub target_language: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageRequest {
    pub request_id: String,
    pub file_id: String,
    pub operation: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextResult {
    pub text: String,
    pub engine: Engine,
    pub model: Option<String>,
    pub citations: Vec<Citation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperationResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl OperationResult {
    pub fn validate(&self) -> Result<(), String> {
        if self.message.len() > 600 || self.code.as_ref().is_some_and(|c| c.len() > 80) {
            Err("Windows AI helper returned an invalid operation result".to_owned())
        } else {
            Ok(())
        }
    }
}
