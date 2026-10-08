use std::{fs, path::PathBuf, sync::Mutex};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::consent::PersistedConsent;

use super::{GatewaySupervisor, credentials};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub enum ProviderId {
    #[serde(rename = "local")]
    Local,
    #[serde(rename = "openai")]
    Openai,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "google")]
    Google,
    #[serde(rename = "openai-compatible")]
    OpenaiCompatible,
}

impl ProviderId {
    pub(crate) fn credential_key(self) -> Option<&'static str> {
        match self {
            Self::Local => None,
            Self::Openai => Some("openai"),
            Self::Anthropic => Some("anthropic"),
            Self::Google => Some("google"),
            Self::OpenaiCompatible => Some("openai-compatible"),
        }
    }

    pub fn is_cloud(self) -> bool {
        self != Self::Local
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Local => "local-openai-compatible",
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Google => "google",
            Self::OpenaiCompatible => "openai-compatible",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelCapability {
    Answer,
    Embedding,
    Vision,
    Audio,
    Rerank,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDescriptor {
    pub id: ProviderId,
    pub label: &'static str,
    pub cloud: bool,
    pub credential_configured: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDescriptor {
    pub id: &'static str,
    pub label: &'static str,
    pub provider_id: ProviderId,
    pub capabilities: &'static [ModelCapability],
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedRoute {
    pub alias: String,
    pub capability: ModelCapability,
    pub provider_id: ProviderId,
    pub model_id: String,
    pub base_url: Option<String>,
    pub upstream_model: Option<String>,
}

impl AppliedRoute {
    pub(crate) fn upstream_model(&self) -> &str {
        match self.model_id.as_str() {
            "local:qwen3.5:4b" => return "extra.Qwen3.5-4B-UD-Q4_K_XL.gguf",
            "local:nomic-embed-text-v1" => {
                return "extra.nomic-embed-text-v1.Q4_K_S.gguf";
            }
            _ => {}
        }
        self.upstream_model.as_deref().unwrap_or_else(|| {
            self.model_id
                .split_once(':')
                .map(|(_, model)| model)
                .unwrap_or(&self.model_id)
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteDescriptor {
    pub alias: String,
    pub capability: ModelCapability,
    pub provider_id: ProviderId,
    pub model_id: String,
    pub status: &'static str,
    pub base_url: Option<String>,
    pub upstream_model: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRegistrySnapshot {
    pub providers: Vec<ProviderDescriptor>,
    pub models: Vec<ModelDescriptor>,
    pub routes: Vec<RouteDescriptor>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteUpdate {
    pub alias: String,
    pub provider_id: ProviderId,
    pub model_id: String,
    pub base_url: Option<String>,
    pub upstream_model: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteApplyResult {
    pub applied: bool,
    pub message: String,
    pub route: RouteDescriptor,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteTestResult {
    pub ready: bool,
    pub message: String,
}

const ANSWER: &[ModelCapability] = &[ModelCapability::Answer];
const EMBEDDING: &[ModelCapability] = &[ModelCapability::Embedding];
const ANSWER_VISION_RERANK: &[ModelCapability] = &[
    ModelCapability::Answer,
    ModelCapability::Vision,
    ModelCapability::Rerank,
];
const ANSWER_VISION: &[ModelCapability] = &[ModelCapability::Answer, ModelCapability::Vision];
const AUDIO: &[ModelCapability] = &[ModelCapability::Audio];
const CUSTOM: &[ModelCapability] = &[
    ModelCapability::Answer,
    ModelCapability::Embedding,
    ModelCapability::Vision,
    ModelCapability::Audio,
    ModelCapability::Rerank,
];

fn providers() -> Vec<(ProviderId, &'static str)> {
    vec![
        (ProviderId::Local, "Local runtime"),
        (ProviderId::Openai, "OpenAI"),
        (ProviderId::Anthropic, "Anthropic"),
        (ProviderId::Google, "Google"),
        (ProviderId::OpenaiCompatible, "OpenAI-compatible"),
    ]
}

fn models() -> Vec<ModelDescriptor> {
    vec![
        ModelDescriptor {
            id: "local:qwen3.5:4b",
            label: "Qwen 3.5 4B",
            provider_id: ProviderId::Local,
            capabilities: ANSWER,
        },
        ModelDescriptor {
            id: "local:nomic-embed-text-v1",
            label: "Nomic Embed Text v1",
            provider_id: ProviderId::Local,
            capabilities: EMBEDDING,
        },
        ModelDescriptor {
            id: "openai:gpt-5-mini",
            label: "GPT-5 mini",
            provider_id: ProviderId::Openai,
            capabilities: ANSWER_VISION_RERANK,
        },
        ModelDescriptor {
            id: "openai:text-embedding-3-small",
            label: "text-embedding-3-small",
            provider_id: ProviderId::Openai,
            capabilities: EMBEDDING,
        },
        ModelDescriptor {
            id: "openai:gpt-4o-mini-transcribe",
            label: "GPT-4o mini Transcribe",
            provider_id: ProviderId::Openai,
            capabilities: AUDIO,
        },
        ModelDescriptor {
            id: "anthropic:claude-sonnet-4-5",
            label: "Claude Sonnet 4.5",
            provider_id: ProviderId::Anthropic,
            capabilities: ANSWER_VISION,
        },
        ModelDescriptor {
            id: "google:gemini-2.5-flash",
            label: "Gemini 2.5 Flash",
            provider_id: ProviderId::Google,
            capabilities: ANSWER_VISION,
        },
        ModelDescriptor {
            id: "google:gemini-embedding-001",
            label: "Gemini Embedding",
            provider_id: ProviderId::Google,
            capabilities: EMBEDDING,
        },
        ModelDescriptor {
            id: "google:gemini-3.8-flash",
            label: "Gemini 3.8 Flash (verify availability)",
            provider_id: ProviderId::Google,
            capabilities: ANSWER_VISION,
        },
        ModelDescriptor {
            id: "openai:gpt-6.1-sol",
            label: "GPT-6.1 Sol (verify availability)",
            provider_id: ProviderId::Openai,
            capabilities: ANSWER_VISION,
        },
        ModelDescriptor {
            id: "openai-compatible:custom",
            label: "Custom model",
            provider_id: ProviderId::OpenaiCompatible,
            capabilities: CUSTOM,
        },
    ]
}

fn default_routes() -> Vec<AppliedRoute> {
    [
        (
            "lumen.answer.local",
            ModelCapability::Answer,
            ProviderId::Local,
            "local:qwen3.5:4b",
        ),
        (
            "lumen.answer.cloud",
            ModelCapability::Answer,
            ProviderId::Openai,
            "openai:gpt-5-mini",
        ),
        (
            "lumen.embed.local",
            ModelCapability::Embedding,
            ProviderId::Local,
            "local:nomic-embed-text-v1",
        ),
        (
            "lumen.embed.cloud",
            ModelCapability::Embedding,
            ProviderId::Openai,
            "openai:text-embedding-3-small",
        ),
        (
            "lumen.vision.cloud",
            ModelCapability::Vision,
            ProviderId::Openai,
            "openai:gpt-5-mini",
        ),
        (
            "lumen.audio.cloud",
            ModelCapability::Audio,
            ProviderId::Openai,
            "openai:gpt-4o-mini-transcribe",
        ),
        (
            "lumen.rerank.cloud",
            ModelCapability::Rerank,
            ProviderId::Openai,
            "openai:gpt-5-mini",
        ),
        (
            "lumen.improvement.local",
            ModelCapability::Answer,
            ProviderId::Local,
            "local:qwen3.5:4b",
        ),
        (
            "lumen.improvement.cloud",
            ModelCapability::Answer,
            ProviderId::Openai,
            "openai:gpt-5-mini",
        ),
    ]
    .into_iter()
    .map(|(alias, capability, provider_id, model_id)| AppliedRoute {
        alias: alias.to_owned(),
        capability,
        provider_id,
        model_id: model_id.to_owned(),
        base_url: None,
        upstream_model: None,
    })
    .collect()
}

pub struct ProviderRegistry {
    path: Option<PathBuf>,
    routes: Mutex<Vec<AppliedRoute>>,
}

impl ProviderRegistry {
    pub fn load(path: PathBuf) -> Self {
        let routes = fs::read_to_string(&path)
            .ok()
            .and_then(|contents| serde_json::from_str::<Vec<AppliedRoute>>(&contents).ok())
            .and_then(|routes| migrate_routes(routes).ok())
            .unwrap_or_else(default_routes);
        Self {
            path: Some(path),
            routes: Mutex::new(routes),
        }
    }

    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        Self {
            path: None,
            routes: Mutex::new(default_routes()),
        }
    }

    pub fn routes(&self) -> Vec<AppliedRoute> {
        self.routes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn snapshot(&self, cloud_consent: bool) -> ProviderRegistrySnapshot {
        let providers = providers()
            .into_iter()
            .map(|(id, label)| ProviderDescriptor {
                id,
                label,
                cloud: id.is_cloud(),
                credential_configured: id
                    .credential_key()
                    .is_none_or(|key| credentials::get(key).is_some()),
            })
            .collect();
        let routes = self
            .routes()
            .iter()
            .map(|route| route_descriptor(route, cloud_consent))
            .collect();
        ProviderRegistrySnapshot {
            providers,
            models: models(),
            routes,
        }
    }

    pub fn propose(
        &self,
        update: RouteUpdate,
        cloud_consent: bool,
    ) -> Result<Vec<AppliedRoute>, String> {
        let mut candidate = self.routes();
        let index = candidate
            .iter()
            .position(|route| route.alias == update.alias)
            .ok_or_else(|| "Unknown provider route.".to_owned())?;
        if update.provider_id.is_cloud() && !cloud_consent {
            return Err("Cloud provider routes require explicit device consent.".to_owned());
        }
        let model = models()
            .into_iter()
            .find(|model| model.id == update.model_id)
            .ok_or_else(|| "Unknown provider model.".to_owned())?;
        if update.alias.ends_with(".local") != (update.provider_id == ProviderId::Local) {
            return Err("Local and cloud aliases cannot cross provider boundaries.".to_owned());
        }
        if model.provider_id != update.provider_id
            || !model.capabilities.contains(&candidate[index].capability)
        {
            return Err("The selected model does not support this route.".to_owned());
        }
        let (base_url, upstream_model) = if update.provider_id == ProviderId::OpenaiCompatible {
            let base_url = validate_remote_url(update.base_url.as_deref())?;
            let upstream_model = validate_upstream_model(update.upstream_model.as_deref())?;
            (Some(base_url), Some(upstream_model))
        } else {
            if update.base_url.is_some() || update.upstream_model.is_some() {
                return Err("Built-in providers do not accept custom endpoints.".to_owned());
            }
            (None, None)
        };
        candidate[index] = AppliedRoute {
            alias: update.alias,
            capability: candidate[index].capability,
            provider_id: update.provider_id,
            model_id: update.model_id,
            base_url,
            upstream_model,
        };
        validate_route_set(&candidate)?;
        Ok(candidate)
    }

    pub fn commit(&self, candidate: Vec<AppliedRoute>) -> Result<(), String> {
        validate_route_set(&candidate)?;
        if let Some(path) = &self.path {
            let serialized = serde_json::to_vec_pretty(&candidate)
                .map_err(|_| "Provider routes could not be saved.".to_owned())?;
            fs::write(path, serialized)
                .map_err(|_| "Provider routes could not be saved.".to_owned())?;
        }
        *self
            .routes
            .lock()
            .map_err(|_| "Provider registry is unavailable.".to_owned())? = candidate;
        Ok(())
    }
}

fn migrate_routes(mut routes: Vec<AppliedRoute>) -> Result<Vec<AppliedRoute>, String> {
    let defaults = default_routes();
    // Only the known, ordered phase-one schema may be extended. Unknown aliases
    // and corrupt selections still fail closed; existing valid selections survive.
    if routes.len() == defaults.len() - 2
        && routes.iter().zip(&defaults).all(|(route, expected)| {
            route.alias == expected.alias && route.capability == expected.capability
        })
    {
        routes.extend_from_slice(&defaults[defaults.len() - 2..]);
    }
    validate_route_set(&routes)?;
    Ok(routes)
}

fn route_descriptor(route: &AppliedRoute, cloud_consent: bool) -> RouteDescriptor {
    let status = if route.provider_id.is_cloud() && !cloud_consent {
        "needsConsent"
    } else if route
        .provider_id
        .credential_key()
        .is_some_and(|key| credentials::get(key).is_none())
    {
        "needsCredential"
    } else {
        "ready"
    };
    RouteDescriptor {
        alias: route.alias.clone(),
        capability: route.capability,
        provider_id: route.provider_id,
        model_id: route.model_id.clone(),
        status,
        base_url: route.base_url.clone(),
        upstream_model: route.upstream_model.clone(),
    }
}

fn validate_route_set(routes: &[AppliedRoute]) -> Result<(), String> {
    let defaults = default_routes();
    if routes.len() != defaults.len()
        || routes.iter().zip(defaults).any(|(route, expected)| {
            route.alias != expected.alias || route.capability != expected.capability
        })
    {
        return Err("Provider routes do not match Lumen's stable aliases.".to_owned());
    }
    for route in routes {
        let model = models()
            .into_iter()
            .find(|model| model.id == route.model_id)
            .ok_or_else(|| "Unknown provider model.".to_owned())?;
        if model.provider_id != route.provider_id || !model.capabilities.contains(&route.capability)
        {
            return Err("A provider route has incompatible capabilities.".to_owned());
        }
        if route.alias.ends_with(".local") != (route.provider_id == ProviderId::Local) {
            return Err("Local and cloud aliases cannot cross provider boundaries.".to_owned());
        }
        if route.provider_id == ProviderId::OpenaiCompatible {
            validate_remote_url(route.base_url.as_deref())?;
            validate_upstream_model(route.upstream_model.as_deref())?;
        } else if route.base_url.is_some() || route.upstream_model.is_some() {
            return Err("A built-in provider route contains a custom endpoint.".to_owned());
        }
    }
    Ok(())
}

fn validate_remote_url(value: Option<&str>) -> Result<String, String> {
    let value =
        value.ok_or_else(|| "OpenAI-compatible routes require an HTTPS base URL.".to_owned())?;
    let url = Url::parse(value).map_err(|_| "OpenAI-compatible base URL is invalid.".to_owned())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "OpenAI-compatible routes require a credential-free HTTPS base URL.".to_owned(),
        );
    }
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

fn validate_upstream_model(value: Option<&str>) -> Result<String, String> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "OpenAI-compatible routes require a model name.".to_owned())?;
    if value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte))
    {
        return Err("The provider model name contains unsupported characters.".to_owned());
    }
    Ok(value.to_owned())
}

#[tauri::command]
pub fn list_provider_registry(
    registry: State<'_, ProviderRegistry>,
    consent: State<'_, PersistedConsent>,
    improvement: State<'_, std::sync::Arc<crate::improvement::coordinator::ImprovementRuntime>>,
) -> ProviderRegistrySnapshot {
    let mut snapshot = registry.snapshot(consent.answer_granted());
    let improvement_consent = improvement.store.settings().is_ok_and(|s| s.cloud_consent);
    for descriptor in &mut snapshot.routes {
        if descriptor.alias.starts_with("lumen.improvement.")
            && let Some(route) = registry
                .routes()
                .iter()
                .find(|r| r.alias == descriptor.alias)
        {
            *descriptor = route_descriptor(route, improvement_consent);
        }
    }
    snapshot
}

#[tauri::command]
pub fn set_provider_route(
    registry: State<'_, ProviderRegistry>,
    supervisor: State<'_, GatewaySupervisor>,
    consent: State<'_, PersistedConsent>,
    update: RouteUpdate,
    improvement: State<'_, std::sync::Arc<crate::improvement::coordinator::ImprovementRuntime>>,
) -> Result<RouteApplyResult, String> {
    let granted = if update.alias.starts_with("lumen.improvement.") {
        improvement.store.settings().is_ok_and(|s| s.cloud_consent)
    } else {
        consent.answer_granted()
    };
    let old_routes = registry.routes();
    let candidate = registry.propose(update.clone(), granted)?;
    if let Err(error) = supervisor.apply_routes(&candidate) {
        return Ok(RouteApplyResult {
            applied: false,
            message: error,
            route: route_descriptor(
                old_routes
                    .iter()
                    .find(|route| route.alias == update.alias)
                    .ok_or_else(|| "Unknown provider route.".to_owned())?,
                granted,
            ),
        });
    }
    if let Err(error) = registry.commit(candidate.clone()) {
        let _ = supervisor.apply_routes(&old_routes);
        return Ok(RouteApplyResult {
            applied: false,
            message: error,
            route: route_descriptor(
                old_routes
                    .iter()
                    .find(|route| route.alias == update.alias)
                    .ok_or_else(|| "Unknown provider route.".to_owned())?,
                granted,
            ),
        });
    }
    Ok(RouteApplyResult {
        applied: true,
        message: "Provider route applied.".to_owned(),
        route: route_descriptor(
            candidate
                .iter()
                .find(|route| route.alias == update.alias)
                .ok_or_else(|| "Unknown provider route.".to_owned())?,
            granted,
        ),
    })
}

#[tauri::command]
pub fn test_provider_route(
    registry: State<'_, ProviderRegistry>,
    supervisor: State<'_, GatewaySupervisor>,
    consent: State<'_, PersistedConsent>,
    alias: String,
    improvement: State<'_, std::sync::Arc<crate::improvement::coordinator::ImprovementRuntime>>,
) -> Result<RouteTestResult, String> {
    let route = registry
        .routes()
        .into_iter()
        .find(|route| route.alias == alias)
        .ok_or_else(|| "Unknown provider route.".to_owned())?;
    let granted = if alias.starts_with("lumen.improvement.") {
        improvement.store.settings().is_ok_and(|s| s.cloud_consent)
    } else {
        consent.answer_granted()
    };
    let descriptor = route_descriptor(&route, granted);
    let gateway_ready = supervisor.health().state == "ready";
    let ready = descriptor.status == "ready" && gateway_ready;
    Ok(RouteTestResult {
        ready,
        message: if ready {
            "Route configuration and AgentGateway are ready.".to_owned()
        } else if !gateway_ready {
            "AgentGateway is unavailable; the previous route remains applied.".to_owned()
        } else if descriptor.status == "needsConsent" {
            "Cloud consent is required before this route can run.".to_owned()
        } else {
            "A provider credential is required before this route can run.".to_owned()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_stable_aliases_capabilities_and_no_secrets() {
        let registry = ProviderRegistry::in_memory();
        let snapshot = registry.snapshot(false);
        let aliases = snapshot
            .routes
            .iter()
            .map(|route| route.alias.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            aliases,
            [
                "lumen.answer.local",
                "lumen.answer.cloud",
                "lumen.embed.local",
                "lumen.embed.cloud",
                "lumen.vision.cloud",
                "lumen.audio.cloud",
                "lumen.rerank.cloud",
                "lumen.improvement.local",
                "lumen.improvement.cloud",
            ]
        );
        assert!(snapshot.models.iter().any(|model| {
            model.id == "openai:text-embedding-3-small"
                && model.capabilities == [ModelCapability::Embedding]
        }));
        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(!serialized.to_ascii_lowercase().contains("api_key"));
        assert!(!serialized.contains("sk-test"));
    }

    #[test]
    fn route_validation_is_capability_consent_and_url_safe() {
        let registry = ProviderRegistry::in_memory();
        let remote_http = RouteUpdate {
            alias: "lumen.answer.cloud".to_owned(),
            provider_id: ProviderId::OpenaiCompatible,
            model_id: "openai-compatible:custom".to_owned(),
            base_url: Some("http://example.com/v1".to_owned()),
            upstream_model: Some("model-a".to_owned()),
        };
        assert!(registry.propose(remote_http, true).is_err());
        let wrong_capability = RouteUpdate {
            alias: "lumen.embed.cloud".to_owned(),
            provider_id: ProviderId::Anthropic,
            model_id: "anthropic:claude-sonnet-4-5".to_owned(),
            base_url: None,
            upstream_model: None,
        };
        assert!(registry.propose(wrong_capability, true).is_err());
        let cloud = RouteUpdate {
            alias: "lumen.answer.cloud".to_owned(),
            provider_id: ProviderId::Google,
            model_id: "google:gemini-2.5-flash".to_owned(),
            base_url: None,
            upstream_model: None,
        };
        assert!(registry.propose(cloud.clone(), false).is_err());
        let candidate = registry.propose(cloud, true).unwrap();
        assert_eq!(
            registry.snapshot(true).routes[1].provider_id,
            ProviderId::Openai
        );
        registry.commit(candidate).unwrap();
        assert_eq!(
            registry.snapshot(true).routes[1].provider_id,
            ProviderId::Google
        );
    }

    #[test]
    fn legacy_route_migration_preserves_user_models_and_adds_improvement_defaults() {
        let mut legacy = default_routes();
        legacy.truncate(7);
        legacy[1].provider_id = ProviderId::Google;
        legacy[1].model_id = "google:gemini-2.5-flash".into();
        let migrated = migrate_routes(legacy.clone()).unwrap();
        assert_eq!(&migrated[..7], legacy.as_slice());
        assert_eq!(migrated[7].alias, "lumen.improvement.local");
        assert_eq!(migrated[8].alias, "lumen.improvement.cloud");
        legacy[0].alias = "unknown".into();
        assert!(migrate_routes(legacy).is_err());
    }
}
