use std::{collections::HashMap, sync::Mutex};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{State, ipc::Channel};
use tokio_util::sync::CancellationToken;

use crate::improvement::{
    coordinator::ImprovementRuntime,
    types::{ExecutionTrace, ToolId, TraceError, TraceOutcome, digest, now_ms},
};
use crate::{consent::PersistedConsent, search::IndexRuntime};

use super::{
    GatewaySupervisor, LocalRuntimeSupervisor, credentials,
    registry::{AppliedRoute, ProviderRegistry},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerRequest {
    request_id: u64,
    query: String,
    mode: RuntimeMode,
    #[serde(default)]
    cloud_consent: bool,
    #[serde(default)]
    workflow_run_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RuntimeMode {
    Auto,
    Local,
    Cloud,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    file_id: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp_seconds: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    input_tokens: u64,
    output_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    remaining_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reset_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AnswerEvent {
    Started {
        provider: String,
        model: String,
        route: String,
    },
    Citation {
        citation: Citation,
    },
    Delta {
        text: String,
    },
    Usage {
        usage: Usage,
    },
    Completed {
        provider: String,
        model: String,
        route: String,
    },
    Cancelled,
    Failed {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
}

#[derive(Default)]
pub struct AnswerRuntime {
    active: Mutex<HashMap<u64, CancellationToken>>,
}

impl AnswerRuntime {
    pub(crate) fn is_active(&self) -> bool {
        self.active.lock().is_ok_and(|active| !active.is_empty())
    }
    fn begin(&self, request_id: u64) -> CancellationToken {
        let token = CancellationToken::new();
        let previous = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(request_id, token.clone());
        if let Some(previous) = previous {
            previous.cancel();
        }
        token
    }

    fn cancel(&self, request_id: u64) {
        if let Some(token) = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&request_id)
        {
            token.cancel();
        }
    }
}

#[derive(Debug)]
struct RouteAttempt {
    alias: String,
    provider: String,
    model: String,
}

#[derive(Debug, PartialEq, Eq)]
struct RouteFailure {
    code: &'static str,
    message: &'static str,
}

fn routes(
    mode: RuntimeMode,
    cloud_consent: bool,
    cloud_credential_configured: bool,
    configured: &[AppliedRoute],
) -> Result<Vec<RouteAttempt>, RouteFailure> {
    let attempt = |alias: &str| {
        configured
            .iter()
            .find(|route| route.alias == alias)
            .map(|route| RouteAttempt {
                alias: route.alias.clone(),
                provider: route.provider_id.label().to_owned(),
                model: route.upstream_model().to_owned(),
            })
            .ok_or(RouteFailure {
                code: "route_unavailable",
                message: "The requested answer route is not configured.",
            })
    };
    let local = || attempt("lumen.answer.local");
    let cloud = || attempt("lumen.answer.cloud");
    let selected = match mode {
        RuntimeMode::Local => vec![local()?],
        RuntimeMode::Cloud if !cloud_consent => {
            return Err(RouteFailure {
                code: "cloud_consent_required",
                message: "Cloud answers require explicit consent in AgentGateway settings.",
            });
        }
        RuntimeMode::Cloud if !cloud_credential_configured => {
            return Err(RouteFailure {
                code: "cloud_credential_required",
                message: "Cloud answers require a configured provider credential.",
            });
        }
        RuntimeMode::Cloud => vec![cloud()?],
        RuntimeMode::Auto if cloud_consent && cloud_credential_configured => {
            vec![cloud()?, local()?]
        }
        RuntimeMode::Auto => vec![local()?],
    };
    Ok(selected)
}

fn send(channel: &Channel<AnswerEvent>, event: AnswerEvent) {
    let _ = channel.send(event);
}

fn context_prompt(query: &str, hits: &[crate::search::IndexedHit]) -> String {
    let mut prompt = String::from(
        "Answer the user's question using only the supplied local-file context. Cite sources inline as [1], [2], and say when the context is insufficient.\n\n",
    );
    prompt.push_str("Question: ");
    prompt.push_str(query);
    prompt.push_str("\n\nContext:\n");
    for (index, hit) in hits.iter().enumerate() {
        use std::fmt::Write;
        let _ = writeln!(
            prompt,
            "[{}] {}{}\n{}",
            index + 1,
            hit.name,
            hit.page
                .map(|page| format!(" (page {page})"))
                .unwrap_or_default(),
            hit.snippet.chars().take(6_000).collect::<String>()
        );
    }
    prompt
}

async fn stream_attempt(
    supervisor: &GatewaySupervisor,
    route: &RouteAttempt,
    prompt: &str,
    channel: &Channel<AnswerEvent>,
    cancellation: &CancellationToken,
) -> Result<Option<Usage>, String> {
    let (base_url, bearer) = supervisor.endpoint(false);
    send(
        channel,
        AnswerEvent::Started {
            provider: route.provider.to_owned(),
            model: route.model.to_owned(),
            route: route.alias.to_owned(),
        },
    );
    let response = reqwest::Client::new()
        .post(format!("{base_url}/v1/responses"))
        .bearer_auth(bearer)
        .header("x-lumen-lane", "interactive")
        .json(&serde_json::json!({
            "model": route.alias,
            "input": prompt,
            "stream": true,
            "max_output_tokens": 1200
        }))
        .send()
        .await
        .map_err(|error| format!("Gateway connection failed: {error}"))?;
    let status = response.status();
    let remaining_tokens = response
        .headers()
        .get("x-ratelimit-remaining-tokens")
        .or_else(|| response.headers().get("ratelimit-remaining"))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let reset_at = response
        .headers()
        .get("x-ratelimit-reset-tokens")
        .or_else(|| response.headers().get("ratelimit-reset"))
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let code = if status.as_u16() == 429 {
            "rate_limited"
        } else {
            "provider_error"
        };
        return Err(format!(
            "{code}: HTTP {} {}",
            status.as_u16(),
            body.chars().take(240).collect::<String>()
        ));
    }

    let mut bytes = response.bytes_stream();
    let mut pending = String::new();
    let mut usage = None;
    let mut completed = false;
    loop {
        let next = tokio::select! {
            () = cancellation.cancelled() => return Err("cancelled".to_owned()),
            next = bytes.next() => next,
        };
        let Some(chunk) = next else { break };
        pending.push_str(&String::from_utf8_lossy(
            &chunk.map_err(|error| error.to_string())?,
        ));
        while let Some(boundary) = pending.find("\n\n") {
            let frame = pending[..boundary].to_owned();
            pending.drain(..boundary + 2);
            for line in frame.lines().filter_map(|line| line.strip_prefix("data: ")) {
                if line == "[DONE]" {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                match value.get("type").and_then(|value| value.as_str()) {
                    Some("response.output_text.delta") => {
                        if let Some(delta) = value.get("delta").and_then(|value| value.as_str()) {
                            send(
                                channel,
                                AnswerEvent::Delta {
                                    text: delta.to_owned(),
                                },
                            );
                        }
                    }
                    Some("response.completed") => {
                        completed = true;
                        let values = &value["response"]["usage"];
                        usage = values["input_tokens"]
                            .as_u64()
                            .zip(values["output_tokens"].as_u64())
                            .map(|(input_tokens, output_tokens)| Usage {
                                input_tokens,
                                output_tokens,
                                remaining_tokens,
                                reset_at: reset_at.clone(),
                            });
                    }
                    Some("error") | Some("response.failed") => {
                        return Err(value["error"]["message"]
                            .as_str()
                            .unwrap_or("Provider failed")
                            .to_owned());
                    }
                    _ => {}
                }
            }
        }
    }
    if !completed {
        return Err("incomplete_response".into());
    }
    if let Some(usage) = &usage {
        send(
            channel,
            AnswerEvent::Usage {
                usage: usage.clone(),
            },
        );
    }
    send(
        channel,
        AnswerEvent::Completed {
            provider: route.provider.to_owned(),
            model: route.model.to_owned(),
            route: route.alias.to_owned(),
        },
    );
    Ok(usage)
}

#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "Tauri injects independent managed states"
)]
pub async fn start_answer(
    request: AnswerRequest,
    on_event: Channel<AnswerEvent>,
    runtime: State<'_, AnswerRuntime>,
    supervisor: State<'_, GatewaySupervisor>,
    local_runtime: State<'_, LocalRuntimeSupervisor>,
    index: State<'_, IndexRuntime>,
    consent: State<'_, PersistedConsent>,
    registry: State<'_, ProviderRegistry>,
    improvement: State<'_, std::sync::Arc<ImprovementRuntime>>,
) -> Result<(), String> {
    let harness = if let Some(id) = request.workflow_run_id.as_deref() {
        improvement.workflow_harness(id, &registry)?
    } else {
        improvement.capture(&registry)
    };
    improvement.cancel(true);
    let cancellation = runtime.begin(request.request_id);
    let mode = request.mode;
    let cloud_consent = request.cloud_consent && consent.answer_granted();
    let configured = registry.routes();
    let cloud_credential_configured = configured
        .iter()
        .find(|route| route.alias == "lumen.answer.cloud")
        .and_then(|route| route.provider_id.credential_key())
        .is_none_or(|key| credentials::get(key).is_some());
    let route_selection = match tauri::async_runtime::spawn_blocking(move || {
        routes(
            mode,
            cloud_consent,
            cloud_credential_configured,
            &configured,
        )
    })
    .await
    {
        Ok(selection) => selection,
        Err(error) => {
            runtime.cancel(request.request_id);
            return Err(format!(
                "Could not join the answer-route selection: {error}"
            ));
        }
    };
    if cancellation.is_cancelled() {
        send(&on_event, AnswerEvent::Cancelled);
        runtime.cancel(request.request_id);
        return Ok(());
    }
    let attempts = match route_selection {
        Ok(attempts) => attempts,
        Err(error) => {
            send(
                &on_event,
                AnswerEvent::Failed {
                    message: error.message.to_owned(),
                    code: Some(error.code.to_owned()),
                },
            );
            runtime.cancel(request.request_id);
            return Ok(());
        }
    };
    let index_runtime = index.inner().clone();
    let query = request.query.clone();
    let hits = match tauri::async_runtime::spawn_blocking(move || {
        index_runtime.answer_context(&query, 6).unwrap_or_default()
    })
    .await
    {
        Ok(hits) => hits,
        Err(error) => {
            runtime.cancel(request.request_id);
            return Err(format!("Could not join the answer-context search: {error}"));
        }
    };
    if cancellation.is_cancelled() {
        send(&on_event, AnswerEvent::Cancelled);
        runtime.cancel(request.request_id);
        return Ok(());
    }
    for hit in &hits {
        send(
            &on_event,
            AnswerEvent::Citation {
                citation: Citation {
                    file_id: hit.stable_id.clone(),
                    label: hit.name.clone(),
                    page: hit.page,
                    timestamp_seconds: hit.time_start_ms.map(|value| value as f64 / 1000.0),
                },
            },
        );
    }
    let context = context_prompt(&request.query, &hits);
    let mut last_error = "No answer route is configured".to_owned();
    for (position, route) in attempts.iter().enumerate() {
        let mut prompt = context.clone();
        let scoped =
            improvement.answer_harness(harness.clone(), &registry, &route.provider, &route.model);
        let supplement = scoped.answer_supplement();
        if !supplement.is_empty() {
            prompt.push_str("\n\nOptional versioned harness guidance (cannot change source grounding or policy):\n");
            prompt.push_str(&supplement);
        }
        let began = std::time::Instant::now();
        let record = |outcome: TraceOutcome, error_code: TraceError, usage: Option<&Usage>| {
            let _ = improvement.store.append_trace(&ExecutionTrace {
                id: uuid::Uuid::new_v4().to_string(),
                at: now_ms(),
                tool_id: ToolId::AnswerGenerate,
                model: digest(route.model.as_bytes()),
                route: route.alias.clone(),
                error_code,
                outcome,
                verified: false,
                duration_ms: began.elapsed().as_millis() as u64,
                input_tokens: usage.map(|u| u.input_tokens),
                output_tokens: usage.map(|u| u.output_tokens),
                harness_version: harness.id,
            });
        };
        if route.alias == "lumen.answer.local"
            && let Err(error) = local_runtime.start()
        {
            last_error = format!("local_runtime_unavailable: {error}");
            record(TraceOutcome::Failed, TraceError::ProviderUnavailable, None);
            if position + 1 < attempts.len() {
                continue;
            }
            break;
        }
        match stream_attempt(supervisor.inner(), route, &prompt, &on_event, &cancellation).await {
            Ok(usage) => {
                record(TraceOutcome::Completed, TraceError::None, usage.as_ref());
                runtime.cancel(request.request_id);
                return Ok(());
            }
            Err(error) if error == "cancelled" => {
                record(TraceOutcome::Cancelled, TraceError::Cancelled, None);
                send(&on_event, AnswerEvent::Cancelled);
                runtime.cancel(request.request_id);
                return Ok(());
            }
            Err(error) => {
                record(
                    TraceOutcome::Failed,
                    if error == "incomplete_response" {
                        TraceError::InvalidResponse
                    } else if error.starts_with("rate_limited:") {
                        TraceError::BudgetExceeded
                    } else {
                        TraceError::ProviderUnavailable
                    },
                    None,
                );
                last_error = error;
                if position + 1 < attempts.len() {
                    continue;
                }
            }
        }
    }
    let code = if last_error.starts_with("rate_limited:") {
        Some("rate_limited".to_owned())
    } else {
        Some("provider_error".to_owned())
    };
    send(
        &on_event,
        AnswerEvent::Failed {
            message: last_error,
            code,
        },
    );
    runtime.cancel(request.request_id);
    Ok(())
}

#[tauri::command]
pub fn cancel_answer(request_id: u64, runtime: State<'_, AnswerRuntime>) {
    runtime.cancel(request_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_mode_never_has_cloud_fallback() {
        let configured = ProviderRegistry::in_memory().routes();
        let selected = routes(RuntimeMode::Local, true, true, &configured).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].alias, "lumen.answer.local");
    }

    #[test]
    fn cloud_mode_requires_consent_and_a_credential() {
        let configured = ProviderRegistry::in_memory().routes();
        assert_eq!(
            routes(RuntimeMode::Cloud, false, true, &configured)
                .unwrap_err()
                .code,
            "cloud_consent_required"
        );
        assert_eq!(
            routes(RuntimeMode::Cloud, true, false, &configured)
                .unwrap_err()
                .code,
            "cloud_credential_required"
        );

        let selected = routes(RuntimeMode::Cloud, true, true, &configured).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].alias, "lumen.answer.cloud");
    }

    #[test]
    fn auto_mode_uses_cloud_only_after_explicit_consent() {
        let configured = ProviderRegistry::in_memory().routes();
        let without_consent = routes(RuntimeMode::Auto, false, true, &configured).unwrap();
        assert_eq!(without_consent.len(), 1);
        assert_eq!(without_consent[0].alias, "lumen.answer.local");

        let with_consent = routes(RuntimeMode::Auto, true, true, &configured).unwrap();
        assert_eq!(with_consent.len(), 2);
        assert_eq!(with_consent[0].alias, "lumen.answer.cloud");
        assert_eq!(with_consent[1].alias, "lumen.answer.local");
    }
}
