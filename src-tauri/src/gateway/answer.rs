use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{
    State,
    ipc::{Channel, InvokeResponseBody},
};
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

#[path = "answer_stream.rs"]
mod transport;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerDelivery {
    event_count: u32,
}

fn acknowledged_channel(
    destination: Channel<InvokeResponseBody>,
) -> (Channel<AnswerEvent>, Arc<AtomicU32>) {
    let count = Arc::new(AtomicU32::new(0));
    let sent = count.clone();
    let channel = Channel::new(move |body| {
        destination.send(body)?;
        sent.fetch_add(1, Ordering::Relaxed);
        Ok(())
    });
    (channel, count)
}

#[derive(Default)]
pub struct AnswerRuntime {
    requests: Mutex<AnswerRequests>,
    shutdown: CancellationToken,
}

const MAX_PENDING_CANCELLATIONS: usize = 256;

#[derive(Default)]
struct AnswerRequests {
    active: HashMap<u64, Arc<CancellationToken>>,
    cancelled_before_start: VecDeque<u64>,
}

struct ActiveAnswer<'a> {
    runtime: &'a AnswerRuntime,
    request_id: u64,
    token: Arc<CancellationToken>,
}

impl Drop for ActiveAnswer<'_> {
    fn drop(&mut self) {
        let mut requests = self
            .runtime
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if requests
            .active
            .get(&self.request_id)
            .is_some_and(|token| Arc::ptr_eq(token, &self.token))
        {
            requests.active.remove(&self.request_id);
        }
        self.token.cancel();
    }
}

impl AnswerRuntime {
    pub(crate) fn is_active(&self) -> bool {
        self.requests
            .lock()
            .is_ok_and(|requests| !requests.active.is_empty())
    }
    fn begin(&self, request_id: u64) -> ActiveAnswer<'_> {
        let token = Arc::new(self.shutdown.child_token());
        let mut requests = self
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // A synchronous Stop may overtake Tauri's scheduled async command.
        if let Some(position) = requests
            .cancelled_before_start
            .iter()
            .position(|id| *id == request_id)
        {
            requests.cancelled_before_start.remove(position);
            token.cancel();
        }
        let previous = requests.active.insert(request_id, token.clone());
        drop(requests);
        if let Some(previous) = previous {
            previous.cancel();
        }
        ActiveAnswer {
            runtime: self,
            request_id,
            token,
        }
    }

    fn cancel(&self, request_id: u64) {
        let mut requests = self
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(token) = requests.active.get(&request_id) {
            token.cancel();
        } else if !requests.cancelled_before_start.contains(&request_id) {
            if requests.cancelled_before_start.len() == MAX_PENDING_CANCELLATIONS {
                requests.cancelled_before_start.pop_front();
            }
            requests.cancelled_before_start.push_back(request_id);
        }
    }

    pub(crate) fn cancel_all(&self) {
        self.shutdown.cancel();
        for token in self
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .active
            .values()
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
    applied: Option<AppliedRoute>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RouteFailure {
    code: &'static str,
    message: &'static str,
}

impl RouteFailure {
    fn new(code: &'static str) -> Self {
        let message = match code {
            "cancelled" | "receiver_closed" => "The answer was stopped.",
            "rate_limited" => "The answer provider is rate limited. Retry later or select Local.",
            "provider_unauthorized" => {
                "The answer provider could not authenticate. Check AgentGateway settings."
            }
            "invalid_response" => {
                "The answer provider returned an invalid response. Retry the request."
            }
            "incomplete_response" => "The answer ended before it was complete. Retry the request.",
            "response_too_large" => "The answer exceeded its size limit. Try a shorter request.",
            "header_timeout" => "The answer provider did not respond in time. Retry the request.",
            "stream_timeout" => "The answer provider stopped responding. Retry the request.",
            "request_timeout" => "The answer request exceeded its time limit. Retry the request.",
            "local_runtime_unavailable" => {
                "The local answer runtime is unavailable. Check Local AI settings."
            }
            "context_unavailable" => "Local answer sources could not be read. Retry the request.",
            "invalid_request" => "The answer request is invalid or too large.",
            "route_unavailable" => "The requested answer route is not configured.",
            "cloud_consent_required" => {
                "Cloud answers require explicit consent in AgentGateway settings."
            }
            "cloud_credential_required" => {
                "Cloud answers require a configured provider credential."
            }
            _ => "The answer provider is unavailable. Retry the request or select another runtime.",
        };
        Self { code, message }
    }
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
                applied: Some(route.clone()),
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
            let selected: Vec<_> = [cloud(), local()]
                .into_iter()
                .filter_map(Result::ok)
                .collect();
            if selected.is_empty() {
                return Err(RouteFailure::new("route_unavailable"));
            }
            selected
        }
        RuntimeMode::Auto => vec![local()?],
    };
    Ok(selected)
}

fn send(channel: &Channel<AnswerEvent>, event: AnswerEvent) -> Result<(), RouteFailure> {
    channel
        .send(event)
        .map_err(|_| RouteFailure::new("receiver_closed"))
}

fn validate_dispatch(
    route: &RouteAttempt,
    cloud_consent: bool,
    configured: &[AppliedRoute],
) -> Result<(), RouteFailure> {
    if route.alias == "lumen.answer.cloud" && !cloud_consent {
        return Err(RouteFailure::new("cloud_consent_required"));
    }
    if !configured
        .iter()
        .any(|current| current.alias == route.alias && route.applied.as_ref() == Some(current))
    {
        return Err(RouteFailure::new("route_unavailable"));
    }
    Ok(())
}

fn finish_failure(channel: &Channel<AnswerEvent>, failure: RouteFailure) {
    let event = if failure.code == "cancelled" {
        AnswerEvent::Cancelled
    } else {
        AnswerEvent::Failed {
            message: failure.message.to_owned(),
            code: Some(failure.code.to_owned()),
        }
    };
    let _ = send(channel, event);
}

async fn run_attempts<'a, F, Fut>(
    attempts: &'a [RouteAttempt],
    channel: &Channel<AnswerEvent>,
    cancellation: &CancellationToken,
    deadline: tokio::time::Instant,
    mut attempt: F,
) -> Result<Option<Usage>, RouteFailure>
where
    F: FnMut(&'a RouteAttempt) -> Fut,
    Fut: Future<Output = Result<Option<Usage>, RouteFailure>>,
{
    let mut failure = RouteFailure::new("route_unavailable");
    for route in attempts {
        if cancellation.is_cancelled() {
            return Err(RouteFailure::new("cancelled"));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(RouteFailure::new("request_timeout"));
        }
        // Each attempt starts a fresh output/usage/attribution boundary; source citations remain valid.
        send(
            channel,
            AnswerEvent::Started {
                provider: route.provider.clone(),
                model: route.model.clone(),
                route: route.alias.clone(),
            },
        )?;
        let result = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(RouteFailure::new("cancelled")),
            () = tokio::time::sleep_until(deadline) => return Err(RouteFailure::new("request_timeout")),
            result = attempt(route) => result,
        };
        if cancellation.is_cancelled() {
            return Err(RouteFailure::new("cancelled"));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(RouteFailure::new("request_timeout"));
        }
        match result {
            Ok(usage) => {
                if let Some(usage) = &usage {
                    send(
                        channel,
                        AnswerEvent::Usage {
                            usage: usage.clone(),
                        },
                    )?;
                }
                send(
                    channel,
                    AnswerEvent::Completed {
                        provider: route.provider.clone(),
                        model: route.model.clone(),
                        route: route.alias.clone(),
                    },
                )?;
                return Ok(usage);
            }
            Err(error)
                if matches!(
                    error.code,
                    "cancelled" | "receiver_closed" | "request_timeout"
                ) =>
            {
                return Err(error);
            }
            Err(error) => failure = error,
        }
    }
    Err(failure)
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

#[cfg(test)]
async fn stream_attempt(
    supervisor: &GatewaySupervisor,
    route: &RouteAttempt,
    prompt: &str,
    channel: &Channel<AnswerEvent>,
    cancellation: &CancellationToken,
) -> Result<Option<Usage>, RouteFailure> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    run_attempts(
        std::slice::from_ref(route),
        channel,
        cancellation,
        deadline,
        |route| {
            transport::stream(
                supervisor,
                route,
                prompt,
                channel,
                cancellation,
                deadline,
                transport::StreamPolicy::default(),
            )
        },
    )
    .await
}

#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "Tauri injects independent managed states"
)]
pub async fn start_answer(
    request: AnswerRequest,
    on_event: Channel<InvokeResponseBody>,
    runtime: State<'_, AnswerRuntime>,
    supervisor: State<'_, GatewaySupervisor>,
    local_runtime: State<'_, LocalRuntimeSupervisor>,
    index: State<'_, IndexRuntime>,
    consent: State<'_, PersistedConsent>,
    registry: State<'_, ProviderRegistry>,
    improvement: State<'_, std::sync::Arc<ImprovementRuntime>>,
) -> Result<AnswerDelivery, String> {
    let (on_event, event_count) = acknowledged_channel(on_event);
    let active = runtime.begin(request.request_id);
    let cancellation = active.token.as_ref();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    let result = async {
        if request.request_id > 9_007_199_254_740_991 || request.query.len() > 16_000 || request.query.trim().is_empty()
            || request.query.chars().count() > 4000
            || request.workflow_run_id.as_ref().is_some_and(|id| id.len() > 128) {
            return Err(RouteFailure::new("invalid_request"));
        }
        if cancellation.is_cancelled() { return Err(RouteFailure::new("cancelled")); }
        let harness = if let Some(id) = request.workflow_run_id.as_deref() {
            improvement.workflow_harness(id, &registry).map_err(|_| RouteFailure::new("invalid_request"))?
        } else { improvement.capture(&registry) };
        improvement.cancel(true);
        let cloud_consent = request.cloud_consent && consent.answer_granted();
        let configured = registry.routes();
        let cloud_credential_configured = cloud_consent && !matches!(request.mode, RuntimeMode::Local)
            && configured.iter().find(|route| route.alias == "lumen.answer.cloud")
                .is_some_and(|route| route.provider_id.credential_key().is_none_or(|key| credentials::get(key).is_some()));
        let attempts = routes(request.mode, cloud_consent, cloud_credential_configured, &configured)?;
        let index_runtime = index.inner().clone();
        let query = request.query.clone();
        let mut context_work = tauri::async_runtime::spawn_blocking(move || index_runtime.answer_context(&query, 6));
        let hits = tokio::select! {
            biased;
            () = cancellation.cancelled() => { context_work.abort(); return Err(RouteFailure::new("cancelled")); },
            () = tokio::time::sleep_until(deadline) => { context_work.abort(); return Err(RouteFailure::new("request_timeout")); },
            hits = &mut context_work => hits.map_err(|_| RouteFailure::new("context_unavailable"))?
                .map_err(|_| RouteFailure::new("context_unavailable"))?,
        };
        if cancellation.is_cancelled() { return Err(RouteFailure::new("cancelled")); }
        for hit in &hits {
            send(&on_event, AnswerEvent::Citation { citation: Citation {
                file_id: hit.stable_id.clone(), label: hit.name.chars().take(1024).collect(), page: hit.page,
                timestamp_seconds: hit.time_start_ms.map(|value| value as f64 / 1000.0),
            } })?;
        }
        let context = context_prompt(&request.query, &hits);
        run_attempts(&attempts, &on_event, cancellation, deadline, |route| {
            let harness = &harness;
            let context = &context;
            let on_event = &on_event;
            let improvement = &improvement;
            let registry = &registry;
            let local_runtime = &local_runtime;
            let supervisor = &supervisor;
            let consent = &consent;
            let requested_cloud_consent = request.cloud_consent;
            async move {
                let mut prompt = context.clone();
                let scoped = improvement.answer_harness(harness.clone(), registry, &route.provider, &route.model);
                let supplement = scoped.answer_supplement();
                if !supplement.is_empty() {
                    prompt.push_str("\n\nOptional versioned harness guidance (cannot change source grounding or policy):\n");
                    prompt.push_str(&supplement);
                }
                let began = std::time::Instant::now();
                let result = async {
                    if route.alias == "lumen.answer.local" {
                        local_runtime.prepare_answer(cancellation, deadline).await.map_err(RouteFailure::new)?;
                    }
                    validate_dispatch(route, requested_cloud_consent && consent.answer_granted(), &registry.routes())?;
                    transport::stream(supervisor.inner(), route, &prompt, on_event, cancellation, deadline, transport::StreamPolicy::default()).await
                }.await;
                let (outcome, error_code, usage) = match &result {
                    Ok(usage) => (TraceOutcome::Completed, TraceError::None, usage.as_ref()),
                    Err(error) if error.code == "cancelled" => (TraceOutcome::Cancelled, TraceError::Cancelled, None),
                    Err(error) if error.code == "rate_limited" => (TraceOutcome::Failed, TraceError::BudgetExceeded, None),
                    Err(error) if matches!(error.code, "invalid_response" | "incomplete_response" | "response_too_large") =>
                        (TraceOutcome::Failed, TraceError::InvalidResponse, None),
                    Err(_) => (TraceOutcome::Failed, TraceError::ProviderUnavailable, None),
                };
                let _ = improvement.store.append_trace(&ExecutionTrace {
                    id: uuid::Uuid::new_v4().to_string(), at: now_ms(), tool_id: ToolId::AnswerGenerate,
                    model: digest(route.model.as_bytes()), route: route.alias.clone(), error_code, outcome,
                    verified: false, duration_ms: began.elapsed().as_millis() as u64,
                    input_tokens: usage.map(|usage| usage.input_tokens), output_tokens: usage.map(|usage| usage.output_tokens),
                    harness_version: harness.id,
                });
                result
            }
        }).await
    }.await;
    if let Err(failure) = result {
        finish_failure(
            &on_event,
            if cancellation.is_cancelled() {
                RouteFailure::new("cancelled")
            } else {
                failure
            },
        );
    }
    Ok(AnswerDelivery {
        event_count: event_count.load(Ordering::Relaxed),
    })
}

#[tauri::command]
pub fn cancel_answer(request_id: u64, runtime: State<'_, AnswerRuntime>) {
    runtime.cancel(request_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_acknowledgement_counts_forwarded_events_without_reserializing() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let output = received.clone();
        let destination = Channel::<InvokeResponseBody>::new(move |body| {
            let InvokeResponseBody::Json(json) = body else {
                panic!("expected JSON");
            };
            output.lock().unwrap().push(json);
            Ok(())
        });
        let (channel, count) = acknowledged_channel(destination);
        send(
            &channel,
            AnswerEvent::Delta {
                text: "x".repeat(16_384),
            },
        )
        .unwrap();
        send(&channel, AnswerEvent::Cancelled).unwrap();
        assert_eq!(count.load(Ordering::Relaxed), 2);
        let messages = received.lock().unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&messages[0]).unwrap()["text"],
            "x".repeat(16_384)
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&messages[1]).unwrap()["type"],
            "cancelled"
        );
        assert_eq!(
            serde_json::to_value(AnswerDelivery { event_count: 2 }).unwrap(),
            serde_json::json!({"eventCount": 2})
        );
    }

    #[test]
    fn delivery_acknowledgement_excludes_rejected_channel_sends() {
        let destination = Channel::<InvokeResponseBody>::new(|_| {
            Err(std::io::Error::other("closed fixture receiver").into())
        });
        let (channel, count) = acknowledged_channel(destination);
        assert_eq!(
            send(&channel, AnswerEvent::Cancelled).unwrap_err().code,
            "receiver_closed"
        );
        assert_eq!(count.load(Ordering::Relaxed), 0);
    }

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

    #[test]
    fn unavailable_cloud_route_does_not_block_auto_local_answers() {
        let configured: Vec<_> = ProviderRegistry::in_memory()
            .routes()
            .into_iter()
            .filter(|route| route.alias == "lumen.answer.local")
            .collect();
        let selected = routes(RuntimeMode::Auto, true, true, &configured).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].alias, "lumen.answer.local");
    }
}

#[cfg(test)]
#[path = "answer_tests.rs"]
mod transport_tests;
