use std::{collections::HashSet, sync::Arc, time::Duration};

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, State, ipc::Channel};

use super::{
    activation::{Activation, validate_prompt},
    catalogue::{Catalogue, ContentMatch},
    files,
    preferences::{Engine, valid_language},
    protocol::{self, Event},
    supervisor::WindowsAiRuntime,
    types::{
        Agent, ImageRequest, OperationResult, Snapshot, TextRequest, TextResult, package_family,
    },
};

fn publish(app: &AppHandle, snapshot: &Snapshot) {
    let _ = app.emit("lumen://windows-ai-status", snapshot);
}

fn operation_result(data: Value) -> Result<OperationResult, String> {
    let result: OperationResult = serde_json::from_value(data)
        .map_err(|_| "Windows AI helper returned an invalid operation result".to_owned())?;
    result.validate()?;
    Ok(result)
}

fn request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn finish<T>(request_id: &str, channel: &Channel<Event>, result: &Result<T, String>) {
    let event = match result {
        Ok(_) => Event::Completed {
            request_id: request_id.to_owned(),
        },
        Err(error) if error == "Windows AI operation cancelled" => Event::Cancelled {
            request_id: request_id.to_owned(),
        },
        Err(error) => Event::Failed {
            request_id: request_id.to_owned(),
            code: "windows-ai-operation-failed".to_owned(),
            message: error.chars().take(600).collect(),
        },
    };
    let _ = channel.send(event);
}

#[tauri::command]
pub async fn windows_ai_status(
    app: AppHandle,
    runtime: State<'_, Arc<WindowsAiRuntime>>,
) -> Result<Snapshot, String> {
    let runtime = runtime.inner().clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || runtime.snapshot())
        .await
        .map_err(|_| "Windows AI status could not be refreshed".to_owned())?;
    publish(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub async fn windows_ai_update_preferences(
    app: AppHandle,
    runtime: State<'_, Arc<WindowsAiRuntime>>,
    patch: Value,
) -> Result<Snapshot, String> {
    let runtime = runtime.inner().clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        if patch.get("registerLumenAgent").is_some() {
            return Err(
                "Use the Windows agent registration control to change registration".to_owned(),
            );
        }
        runtime.update_preferences(patch)?;
        Ok::<_, String>(runtime.snapshot())
    })
    .await
    .map_err(|_| "Windows AI preferences could not be updated".to_owned())??;
    publish(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub async fn windows_ai_prepare(
    app: AppHandle,
    runtime: State<'_, Arc<WindowsAiRuntime>>,
    feature_id: String,
    request_id: String,
    on_event: Channel<Event>,
) -> Result<Snapshot, String> {
    protocol::validate_request_id(&request_id)?;
    if ![
        "languageModel",
        "aion",
        "summarize",
        "rewrite",
        "ocr",
        "imageDescription",
        "appContentSearch",
    ]
    .contains(&feature_id.as_str())
    {
        return Err("Unknown native Windows AI preparation feature".to_owned());
    }
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let data = runtime.call(
                "prepare",
                "prepare",
                &request_id,
                json!({"featureId":feature_id}),
                Duration::from_secs(1200),
                Some(&on_event),
                Some(&feature_id),
            )?;
            if data.get("version").is_some() {
                let snapshot: Snapshot = serde_json::from_value(data).map_err(|_| {
                    "Windows AI helper returned an invalid preparation result".to_owned()
                })?;
                snapshot.validate()?;
            } else if !operation_result(data)?.ok {
                return Err("Windows AI preparation did not complete".to_owned());
            }
            let snapshot = runtime.snapshot();
            if !snapshot
                .features
                .iter()
                .any(|f| f.id == feature_id && f.enabled && f.availability == "ready")
            {
                publish(&app, &snapshot);
                return Err(
                    "Windows AI preparation finished without a ready feature; refresh availability"
                        .to_owned(),
                );
            }
            publish(&app, &snapshot);
            Ok(snapshot)
        })();
        finish(&request_id, &on_event, &result);
        result
    })
    .await
    .map_err(|_| "Windows AI preparation could not be supervised".to_owned())?
}

fn text_result(
    data: Value,
    expected_engine: Engine,
    citations: Vec<files::Citation>,
) -> Result<TextResult, String> {
    let text = data
        .get("text")
        .and_then(Value::as_str)
        .filter(|s| s.len() <= protocol::MAX_TEXT)
        .ok_or_else(|| "Windows AI helper returned an invalid text result".to_owned())?
        .to_owned();
    let engine: Engine = serde_json::from_value(data.get("engine").cloned().unwrap_or(Value::Null))
        .map_err(|_| "Windows AI helper returned an invalid engine".to_owned())?;
    if engine != expected_engine {
        return Err("Windows AI helper returned a result for the wrong engine".to_owned());
    }
    let model = match data.get("model") {
        Some(Value::String(model)) if model.len() <= 160 => Some(model.clone()),
        None | Some(Value::Null) => None,
        _ => return Err("Windows AI helper returned invalid model metadata".to_owned()),
    };
    // Helpers cannot manufacture local file citations. Only native, re-confined
    // retrieval records are returned to React.
    Ok(TextResult {
        text,
        engine,
        model,
        citations,
    })
}

fn validate_text(request: &TextRequest) -> Result<(), String> {
    protocol::validate_request_id(&request.request_id)?;
    if !matches!(request.engine, Engine::Windows | Engine::Aion)
        || !["answer", "summarize", "rewrite", "write"].contains(&request.task.as_str())
    {
        return Err("Unsupported native Windows AI text operation".to_owned());
    }
    if request.text.trim().is_empty()
        || request.text.len() > 64 * 1024
        || request.text.contains('\0')
    {
        return Err("Windows AI text input must contain 1 to 64 KiB of UTF-8 text".to_owned());
    }
    if [&request.source_language, &request.target_language]
        .into_iter()
        .flatten()
        .any(|language| !valid_language(language))
    {
        return Err("Invalid Windows AI language setting".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub async fn windows_ai_text(
    runtime: State<'_, Arc<WindowsAiRuntime>>,
    index: State<'_, crate::search::IndexRuntime>,
    privacy: State<'_, crate::privacy::PrivacyRuntime>,
    request: TextRequest,
    on_event: Channel<Event>,
) -> Result<TextResult, String> {
    validate_text(&request)?;
    let runtime = runtime.inner().clone();
    let index = index.inner().clone();
    let privacy = privacy.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let gate = if request.task == "answer" { "answer" } else { "text" };
            runtime.preferences().gate(gate)?;
            let (text, citations) = if request.task == "answer" {
                privacy.ensure_previews_enabled().map_err(|_| "Local-file answer context is disabled by Privacy settings".to_owned())?;
                files::answer_context(&index, &request.text)?
            } else { (request.text.clone(), Vec::new()) };
            if request.task == "answer" { privacy.ensure_previews_enabled().map_err(|_| "Local-file answer context is disabled by Privacy settings".to_owned())?; }
            let data = runtime.call("text", gate, &request.request_id, json!({"requestId":request.request_id,"engine":request.engine,"task":request.task,"text":text}), Duration::from_secs(180), Some(&on_event), None)?;
            text_result(data, request.engine, citations)
        })();
        finish(&request.request_id, &on_event, &result);
        result
    }).await.map_err(|_| "Windows AI text could not be supervised".to_owned())?
}

#[tauri::command]
pub async fn windows_ai_image(
    runtime: State<'_, Arc<WindowsAiRuntime>>,
    index: State<'_, crate::search::IndexRuntime>,
    privacy: State<'_, crate::privacy::PrivacyRuntime>,
    request: ImageRequest,
    on_event: Channel<Event>,
) -> Result<TextResult, String> {
    protocol::validate_request_id(&request.request_id)?;
    if !["ocr", "describe"].contains(&request.operation.as_str()) {
        return Err("Unknown Windows AI image operation".to_owned());
    }
    let runtime = runtime.inner().clone();
    let index = index.inner().clone();
    let privacy = privacy.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            runtime.preferences().gate(&request.operation)?;
            privacy.ensure_previews_enabled().map_err(|_| "Image tools are disabled by Privacy settings".to_owned())?;
            let bytes = files::image_bytes(&index, &request.file_id)?;
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            privacy.ensure_previews_enabled().map_err(|_| "Image tools are disabled by Privacy settings".to_owned())?;
            let data = runtime.call("image", &request.operation, &request.request_id, json!({"requestId":request.request_id,"operation":request.operation,"imageBase64":encoded}), Duration::from_secs(180), Some(&on_event), None)?;
            text_result(data, Engine::Windows, Vec::new())
        })();
        finish(&request.request_id, &on_event, &result);
        result
    }).await.map_err(|_| "Windows AI image tools could not be supervised".to_owned())?
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexMatch {
    id: String,
    source: String,
}

#[tauri::command]
pub async fn windows_ai_search_content(
    runtime: State<'_, Arc<WindowsAiRuntime>>,
    query: String,
) -> Result<Vec<ContentMatch>, String> {
    if query.len() > 1024 || query.contains('\0') {
        return Err("Public content query is too large or invalid".to_owned());
    }
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.preferences().gate("indexSearch")?;
        let catalogue = Catalogue::embedded()?;
        let data = runtime.call(
            "indexSearch",
            "indexSearch",
            &request_id(),
            json!({"query":query,"limit":20}),
            Duration::from_secs(20),
            None,
            None,
        );
        let mut matches = match data {
            Ok(data) => {
                let results: Vec<IndexMatch> = serde_json::from_value(data)
                    .map_err(|_| "Windows public content returned invalid results".to_owned())?;
                if results.len() > 20 || results.iter().any(|r| r.source != "semantic") {
                    return Err("Windows public content returned invalid results".to_owned());
                }
                catalogue.resolve(&results.into_iter().map(|r| r.id).collect::<Vec<_>>())?
            }
            Err(_) => Vec::new(),
        };
        for result in catalogue.lexical(&query) {
            if matches.len() >= 20 {
                break;
            }
            if !matches.iter().any(|item| item.id == result.id) {
                matches.push(result);
            }
        }
        runtime.preferences().gate("indexSearch")?;
        Ok(matches)
    })
    .await
    .map_err(|_| "Windows public content search could not complete".to_owned())?
}

#[tauri::command]
pub async fn windows_ai_rebuild_content(
    app: AppHandle,
    runtime: State<'_, Arc<WindowsAiRuntime>>,
) -> Result<OperationResult, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let catalogue = Catalogue::embedded()?;
        let result = operation_result(runtime.call(
            "indexSync",
            "indexSync",
            &request_id(),
            json!({"version":1,"items":catalogue.items}),
            Duration::from_secs(120),
            None,
            None,
        )?)?;
        publish(&app, &runtime.snapshot());
        Ok(result)
    })
    .await
    .map_err(|_| "Windows public content could not be rebuilt".to_owned())?
}

#[tauri::command]
pub async fn windows_ai_delete_content(
    app: AppHandle,
    runtime: State<'_, Arc<WindowsAiRuntime>>,
) -> Result<OperationResult, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = operation_result(runtime.call(
            "indexDelete",
            "indexDelete",
            &request_id(),
            json!({}),
            Duration::from_secs(60),
            None,
            None,
        )?)?;
        publish(&app, &runtime.snapshot());
        Ok(result)
    })
    .await
    .map_err(|_| "Windows public content could not be deleted".to_owned())?
}

fn discover(runtime: &WindowsAiRuntime) -> Result<Vec<Agent>, String> {
    runtime
        .agents
        .lock()
        .map_err(|_| "Windows agent catalogue is unavailable".to_owned())?
        .clear();
    let data = runtime.call(
        "agents",
        "agents",
        &request_id(),
        json!({}),
        Duration::from_secs(20),
        None,
        None,
    )?;
    let agents: Vec<Agent> = serde_json::from_value(data)
        .map_err(|_| "Windows returned an invalid agent catalogue".to_owned())?;
    let mut ids = HashSet::new();
    if agents.len() > 128
        || agents
            .iter()
            .any(|agent| agent.validate().is_err() || !ids.insert(&agent.id))
    {
        return Err("Windows returned an invalid agent catalogue".to_owned());
    }
    runtime.preferences().gate("agents")?;
    *runtime
        .agents
        .lock()
        .map_err(|_| "Windows agent catalogue is unavailable".to_owned())? = agents.clone();
    Ok(agents)
}

#[tauri::command]
pub async fn windows_ai_discover_agents(
    app: AppHandle,
    runtime: State<'_, Arc<WindowsAiRuntime>>,
) -> Result<Vec<Agent>, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = discover(&runtime);
        publish(&app, &runtime.snapshot());
        result
    })
    .await
    .map_err(|_| "Windows agent discovery could not complete".to_owned())?
}

#[tauri::command]
pub async fn windows_ai_invoke_agent(
    runtime: State<'_, Arc<WindowsAiRuntime>>,
    agent_id: String,
    prompt: String,
) -> Result<OperationResult, String> {
    validate_prompt(&prompt)?;
    if agent_id.is_empty() || agent_id.len() > 512 {
        return Err("Invalid Windows agent ID".to_owned());
    }
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.preferences().gate("invokeAgent")?;
        let agent = runtime
            .agents
            .lock()
            .map_err(|_| "Windows agent catalogue is unavailable".to_owned())?
            .iter()
            .find(|agent| agent.id == agent_id)
            .cloned()
            .ok_or_else(|| "Choose an agent from a fresh Windows discovery catalogue".to_owned())?;
        operation_result(runtime.call(
            "invokeAgent",
            "invokeAgent",
            &request_id(),
            json!({"agent":agent,"prompt":prompt}),
            Duration::from_secs(60),
            None,
            None,
        )?)
    })
    .await
    .map_err(|_| "Windows agent invocation could not complete".to_owned())?
}

#[tauri::command]
pub async fn windows_ai_set_registration(
    app: AppHandle,
    runtime: State<'_, Arc<WindowsAiRuntime>>,
    enabled: bool,
) -> Result<Snapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let family = package_family().ok_or_else(|| {
            "Windows agent registration requires Lumen's optional registered package identity"
                .to_owned()
        })?;
        if !runtime.agent_definition.is_file() {
            return Err("The fixed Lumen agent definition is missing".to_owned());
        }
        let previous = runtime.preferences().register_lumen_agent;
        runtime.update_preferences(json!({"registerLumenAgent":enabled}))?;
        let operation = if enabled {
            "registerAgent"
        } else {
            "unregisterAgent"
        };
        let result = runtime
            .call(
                operation,
                operation,
                &request_id(),
                json!({"agentDefinitionPath":runtime.agent_definition}),
                Duration::from_secs(30),
                None,
                None,
            )
            .and_then(operation_result);
        let result = match result {
            Ok(result) if result.ok => result,
            Ok(_) | Err(_) => {
                runtime.update_preferences(json!({"registerLumenAgent":previous}))?;
                publish(&app, &runtime.snapshot());
                return Err(
                    "Lumen agent registration did not complete; refresh native availability"
                        .to_owned(),
                );
            }
        };
        let _ = result;
        // Registration is reported only after a separate fresh catalogue read.
        let data = runtime.call(
            "agents",
            "verifyOwnRegistration",
            &request_id(),
            json!({"verifyOwnRegistration":true}),
            Duration::from_secs(20),
            None,
            None,
        )?;
        let agents: Vec<Agent> = serde_json::from_value(data)
            .map_err(|_| "Windows returned an invalid registration verification".to_owned())?;
        if agents.len() > 1
            || agents.iter().any(|agent| {
                agent.validate().is_err()
                    || agent.name != "lumen.browser"
                    || agent.action_id != "LumenBrowserAgent"
                    || agent.package_family_name != family
            })
        {
            return Err("Windows returned an invalid registration verification".to_owned());
        }
        let registered = agents.iter().any(|agent| {
            agent.name == "lumen.browser"
                && agent.action_id == "LumenBrowserAgent"
                && agent.package_family_name == family
        });
        if registered != enabled {
            publish(&app, &runtime.snapshot());
            return Err(
                "The Windows catalogue did not verify the requested Lumen registration".to_owned(),
            );
        }
        let mut cached = runtime
            .agents
            .lock()
            .map_err(|_| "Windows agent catalogue is unavailable".to_owned())?;
        cached.retain(|agent| {
            !(agent.name == "lumen.browser"
                && agent.action_id == "LumenBrowserAgent"
                && agent.package_family_name == family)
        });
        if runtime.preferences().windows_enabled && runtime.preferences().agents_enabled {
            cached.extend(agents);
        } else {
            cached.clear();
        }
        drop(cached);
        let snapshot = runtime.snapshot();
        publish(&app, &snapshot);
        Ok(snapshot)
    })
    .await
    .map_err(|_| "Windows agent registration could not be supervised".to_owned())?
}

#[tauri::command]
pub async fn windows_ai_set_access_token(
    app: AppHandle,
    runtime: State<'_, Arc<WindowsAiRuntime>>,
    token: String,
) -> Result<Snapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.cancel_active(None)?;
        super::credentials::set(Some(token))?;
        let snapshot = runtime.snapshot();
        publish(&app, &snapshot);
        Ok(snapshot)
    })
    .await
    .map_err(|_| "Windows AI access token could not be saved".to_owned())?
}

#[tauri::command]
pub fn windows_ai_cancel(
    runtime: State<'_, Arc<WindowsAiRuntime>>,
    request_id: String,
) -> Result<(), String> {
    runtime.cancel_active(Some(&request_id))
}

#[tauri::command]
pub fn windows_ai_consume_activation(
    runtime: State<'_, Arc<WindowsAiRuntime>>,
) -> Result<Option<Activation>, String> {
    Ok(runtime
        .activations
        .lock()
        .map_err(|_| "Windows agent draft is unavailable".to_owned())?
        .consume())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_citations_cannot_escape_native_context() {
        let data = json!({"text":"A result", "engine":"windows", "model":null, "citations":[{"fileId":"private","label":"fabricated"}]});
        let result = text_result(data, Engine::Windows, Vec::new()).unwrap();
        assert!(result.citations.is_empty());
        assert!(
            text_result(
                json!({"text":"x","engine":"aion","model":null}),
                Engine::Windows,
                Vec::new()
            )
            .is_err()
        );
    }

    #[test]
    fn native_text_rejects_edge_and_oversize_utf8_inputs() {
        let mut request = TextRequest {
            request_id: "test".to_owned(),
            engine: Engine::Edge,
            task: "answer".to_owned(),
            text: "test".to_owned(),
            source_language: None,
            target_language: None,
        };
        assert!(validate_text(&request).is_err());
        request.engine = Engine::Windows;
        request.text = "ä".repeat(40_000);
        assert!(validate_text(&request).is_err());
    }
}
