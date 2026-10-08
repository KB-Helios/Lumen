use super::{
    broker::GatewayBroker, docker::DockerRuntime, evaluation, store::ImprovementStore, types::*,
};
use crate::{
    activity::{ActivityRuntime, BackgroundPolicy},
    computer_use::ComputerUseSupervisor,
    gateway::{
        EnrichmentSupervisor, GatewaySupervisor, answer::AnswerRuntime, registry::ProviderRegistry,
    },
};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, ipc::Channel};
use tokio_util::sync::CancellationToken;

struct ActiveJob {
    id: String,
    phase: String,
    cancel: CancellationToken,
    paused: bool,
}
struct WorkflowRun {
    harness: HarnessVersion,
    remaining_answers: usize,
    began: Instant,
    config: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Lease {
    idempotency_key: String,
    base_version: u64,
    config_digest: String,
    phase: String,
    candidate_id: Option<String>,
    generation: u64,
}
pub struct ImprovementRuntime {
    pub store: Arc<ImprovementStore>,
    docker: DockerRuntime,
    active: Mutex<Option<ActiveJob>>,
    compatible: Mutex<Option<String>>,
    workflows: Mutex<HashMap<String, WorkflowRun>>,
}
fn config_digest(registry: &ProviderRegistry, mode: RouteMode) -> String {
    // Include all execution routes, tools, fixtures and immutable native policies.
    digest(json!({"routes":registry.routes(),"mode":mode,"suite":evaluation::suite_digest(),"policy":"lumen-native-1","tools":["files.search","answer.generate","computerUse.plan"],"computerUseModels":{"openai":crate::computer_use::protocol::OPENAI_MODELS,"gemini":crate::computer_use::protocol::GEMINI_MODELS},"generationTokens":20000,"evaluationRepetitions":3}).to_string().as_bytes())
}
fn policy_allows(app: &AppHandle) -> bool {
    app.state::<ActivityRuntime>().snapshot().background_policy == BackgroundPolicy::Normal
        && !app.state::<AnswerRuntime>().is_active()
        && !app.state::<ComputerUseSupervisor>().is_active()
        && !app.state::<EnrichmentSupervisor>().health().paused
        && !app.state::<Arc<ImprovementRuntime>>().workflow_active()
}
fn send(
    channel: &Option<Channel<ImprovementEvent>>,
    id: &str,
    kind: &'static str,
    phase: &str,
    message: Option<String>,
) {
    if let Some(channel) = channel {
        let _ = channel.send(ImprovementEvent {
            r#type: kind,
            job_id: id.into(),
            phase: phase.into(),
            message,
        });
    }
}
impl ImprovementRuntime {
    pub fn open(database: &Path, assets: PathBuf) -> Result<Self, String> {
        let store = Arc::new(ImprovementStore::open(database)?);
        let docker = DockerRuntime::new(store.owner()?, assets);
        Ok(Self {
            store,
            docker,
            active: Mutex::new(None),
            compatible: Mutex::new(None),
            workflows: Mutex::new(HashMap::new()),
        })
    }
    pub fn capture(&self, registry: &ProviderRegistry) -> HarnessVersion {
        self.store.effective(&self.configuration(registry))
    }
    pub fn configuration(&self, registry: &ProviderRegistry) -> String {
        config_digest(
            registry,
            self.store.settings().unwrap_or_default().route_mode,
        )
    }
    fn model_matches(&self, registry: &ProviderRegistry, provider: &str, model: &str) -> bool {
        let mode = self.store.settings().unwrap_or_default().route_mode;
        let alias = if mode == RouteMode::Local {
            "lumen.improvement.local"
        } else {
            "lumen.improvement.cloud"
        };
        registry.routes().iter().any(|route| {
            route.alias == alias
                && route.upstream_model() == model
                && (route.provider_id.label() == provider
                    || (route.provider_id == crate::gateway::registry::ProviderId::Google
                        && provider == "gemini"))
        })
    }
    pub fn answer_harness(
        &self,
        mut version: HarnessVersion,
        registry: &ProviderRegistry,
        provider: &str,
        model: &str,
    ) -> HarnessVersion {
        if !self.model_matches(registry, provider, model) {
            version.answer_instructions.clear();
            version.tool_hints.clear();
        }
        version
    }
    pub fn computer_use_harness(
        &self,
        registry: &ProviderRegistry,
        provider: &str,
        model: &str,
    ) -> HarnessVersion {
        let mut version = self.capture(registry);
        if !self.model_matches(registry, provider, model) {
            version.computer_use_instructions.clear();
            version.tool_hints.clear();
        }
        version
    }
    fn workflow_active(&self) -> bool {
        self.workflows.lock().is_ok_and(|runs| {
            runs.values()
                .any(|run| run.began.elapsed() < Duration::from_secs(600))
        })
    }
    pub fn authorize_workflow(
        &self,
        id: &str,
        version: u64,
        registry: &ProviderRegistry,
    ) -> Result<WorkflowAuthorization, String> {
        let harness = self.capture(registry);
        if harness.id != version {
            return Err("Workflow version changed; refresh before running.".into());
        }
        let workflow = harness
            .workflows
            .iter()
            .find(|workflow| workflow.id == id)
            .cloned()
            .ok_or("Workflow is not active and approved.")?;
        workflow.validate()?;
        let mut runs = self
            .workflows
            .lock()
            .map_err(|_| "Workflow state is busy.")?;
        runs.retain(|_, run| run.began.elapsed() < Duration::from_secs(600));
        if runs.len() >= 16 {
            return Err("Too many active workflows.".into());
        }
        let run_id = uuid::Uuid::new_v4().to_string();
        runs.insert(
            run_id.clone(),
            WorkflowRun {
                harness,
                remaining_answers: workflow
                    .steps
                    .iter()
                    .filter(|step| step.kind == WorkflowStepKind::Answer)
                    .count(),
                began: Instant::now(),
                config: self.configuration(registry),
            },
        );
        drop(runs);
        self.cancel(true);
        Ok(WorkflowAuthorization {
            run_id,
            version_id: version,
            workflow,
        })
    }
    pub fn workflow_harness(
        &self,
        id: &str,
        registry: &ProviderRegistry,
    ) -> Result<HarnessVersion, String> {
        let mut runs = self
            .workflows
            .lock()
            .map_err(|_| "Workflow state is busy.")?;
        let run = runs
            .get_mut(id)
            .ok_or("Workflow authorization is unavailable.")?;
        if run.began.elapsed() >= Duration::from_secs(600)
            || run.remaining_answers == 0
            || !self.store.settings()?.enabled
            || run.config != self.configuration(registry)
        {
            return Err("Workflow authorization expired or reached its answer limit.".into());
        }
        run.remaining_answers -= 1;
        Ok(run.harness.clone())
    }
    pub fn end_workflow(&self, id: &str, outcome: TraceOutcome) {
        if let Some(run) = self
            .workflows
            .lock()
            .ok()
            .and_then(|mut runs| runs.remove(id))
        {
            let _ = self.store.append_trace(&ExecutionTrace {
                id: id.into(),
                at: now_ms(),
                tool_id: ToolId::WorkflowRun,
                model: digest(run.config.as_bytes()),
                route: "lumen.workflow".into(),
                error_code: if outcome == TraceOutcome::Cancelled {
                    TraceError::Cancelled
                } else if outcome == TraceOutcome::Failed {
                    TraceError::UnknownFailure
                } else {
                    TraceError::None
                },
                outcome,
                verified: false,
                duration_ms: run.began.elapsed().as_millis() as u64,
                input_tokens: None,
                output_tokens: None,
                harness_version: run.harness.id,
            });
        }
    }
    pub fn snapshot(&self) -> Result<ImprovementSnapshot, String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Improvement state is busy.")?;
        let settings = self.store.settings()?;
        Ok(ImprovementSnapshot {
            paused: settings.paused,
            settings,
            active_version: self.store.active()?,
            candidates: self.store.candidates()?,
            trace_count: self.store.trace_count()?,
            job: active.as_ref().map(|job| JobSnapshot {
                id: job.id.clone(),
                phase: job.phase.clone(),
            }),
        })
    }
    pub async fn health(
        &self,
        registry: &ProviderRegistry,
        enrichment: &EnrichmentSupervisor,
    ) -> ImprovementHealth {
        let settings = self.store.settings().unwrap_or_default();
        let model_ready = self
            .compatible
            .lock()
            .ok()
            .and_then(|v| v.clone())
            .is_some_and(|binding| binding == self.configuration(registry));
        if !settings.enabled {
            return ImprovementHealth {
                state: "disabled",
                version: "0.9.8",
                detail: Some(
                    "Enable verified improvement and explicitly prepare Docker to begin.".into(),
                ),
                prepared: false,
                model_ready,
            };
        }
        let health = self.docker.health().await;
        let queue = enrichment.health();
        let state = if settings.paused || queue.paused {
            "paused"
        } else if health.state != "ready" || queue.state != "ready" || !model_ready {
            "unavailable"
        } else {
            "ready"
        };
        ImprovementHealth {
            state,
            version: "0.9.8",
            detail: health.detail.or_else(|| (queue.state != "ready").then(|| "The Rivet improvement queue is unavailable. Review AgentGateway runtime diagnostics.".into())).or_else(|| {
                (!model_ready).then(|| {
                    "Start analysis to verify the selected model's Prime tool-calling support."
                        .into()
                })
            }),
            prepared: health.prepared,
            model_ready,
        }
    }
    pub async fn prepare(&self) -> Result<(), String> {
        self.docker.prepare().await.map(|_| ())
    }
    pub fn cancel(&self, paused: bool) {
        if let Ok(mut active) = self.active.lock()
            && let Some(job) = active.as_mut()
        {
            job.paused = paused;
            job.cancel.cancel();
        }
    }
    pub fn set_settings(&self, settings: ImprovementSettings) -> Result<(), String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Improvement state is busy.")?;
        let previous = self.store.settings()?;
        if (settings.paused
            || !settings.enabled
            || settings.route_mode != previous.route_mode
            || (previous.route_mode == RouteMode::Cloud && !settings.cloud_consent))
            && let Some(job) = active.as_mut()
        {
            job.paused = settings.paused;
            job.cancel.cancel();
        }
        self.store.set_settings(&settings)
    }
    pub fn approve(
        &self,
        approval: &ApprovalRef,
        registry: &ProviderRegistry,
    ) -> Result<(), String> {
        let _active = self
            .active
            .lock()
            .map_err(|_| "Improvement state is busy.")?;
        if !self.store.settings()?.enabled {
            return Err("Verified improvement is disabled.".into());
        }
        self.store.approve(approval, &self.configuration(registry))
    }
    pub fn reject(&self, id: &str) -> Result<(), String> {
        let _active = self
            .active
            .lock()
            .map_err(|_| "Improvement state is busy.")?;
        self.store.mark(id, CandidateStatus::Rejected)
    }
    pub fn rollback(&self, id: u64) -> Result<(), String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Improvement state is busy.")?;
        if let Some(job) = active.as_ref() {
            job.cancel.cancel();
        }
        self.store.rollback(id)
    }
    pub fn preference(&self, preference: Preference) -> Result<(), String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Improvement state is busy.")?;
        if let Some(job) = active.as_ref() {
            job.cancel.cancel();
        }
        self.store.save_preference(preference)
    }
    pub async fn clear(&self, app: &AppHandle) -> Result<(), String> {
        {
            let active = self
                .active
                .lock()
                .map_err(|_| "Improvement state is busy.")?;
            if let Some(job) = active.as_ref() {
                job.cancel.cancel();
            }
            self.store.clear()?;
            self.workflows
                .lock()
                .map_err(|_| "Workflow state is busy.")?
                .clear();
            *self
                .compatible
                .lock()
                .map_err(|_| "Improvement state is busy.")? = None;
        }
        app.state::<EnrichmentSupervisor>()
            .improvement_request("clear", &json!({}))
            .await?;
        Ok(())
    }
    pub fn analyze(
        self: Arc<Self>,
        app: AppHandle,
        channel: Option<Channel<ImprovementEvent>>,
        automatic: bool,
    ) -> Result<(), String> {
        let settings = self.store.settings()?;
        if !settings.enabled
            || settings.paused
            || (settings.route_mode == RouteMode::Cloud && !settings.cloud_consent)
        {
            return Err("Improvement requires enabled settings and separate route consent.".into());
        }
        if !policy_allows(&app) {
            return Err(
                "Background improvement is paused by Activity or an interactive AI run.".into(),
            );
        }
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Improvement state is busy.")?;
        if active.is_some() {
            return Err("An improvement job is already running.".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = CancellationToken::new();
        *active = Some(ActiveJob {
            id: id.clone(),
            phase: "analysis".into(),
            cancel: cancel.clone(),
            paused: false,
        });
        drop(active);
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            send(&channel, &id, "started", "analysis", None);
            let result = runtime
                .clone()
                .run_job(&app, &id, cancel.clone(), &channel, automatic)
                .await;
            let cancelled = cancel.is_cancelled()
                && result
                    .as_ref()
                    .err()
                    .is_none_or(|error| error != super::docker::CLEANUP_UNCERTAIN);
            if let Ok(mut active) = runtime.active.lock()
                && active.as_ref().is_some_and(|job| job.id == id)
            {
                *active = None;
            }
            match result {
                Ok(()) => send(&channel, &id, "completed", "idle", None),
                Err(error) => send(
                    &channel,
                    &id,
                    if cancelled { "cancelled" } else { "failed" },
                    "idle",
                    Some(error),
                ),
            }
        });
        Ok(())
    }
    fn broker(
        &self,
        app: &AppHandle,
        config: &str,
        cancel: CancellationToken,
        job: &str,
        phase: &'static str,
    ) -> Result<Arc<GatewayBroker>, String> {
        let (budget, deadline) = match phase {
            "generation" => (20_000, Duration::from_secs(600)),
            "evaluation" => (480_000, Duration::from_secs(45 * 60)),
            _ => return Err("Invalid improvement phase.".into()),
        };
        let settings = self.store.settings()?;
        let cloud = settings.route_mode == RouteMode::Cloud;
        let alias = if cloud {
            "lumen.improvement.cloud"
        } else {
            "lumen.improvement.local"
        }
        .to_owned();
        let handle = app.clone();
        let binding = config.to_owned();
        let current = Arc::new(move || {
            policy_allows(&handle)
                && handle
                    .state::<Arc<ImprovementRuntime>>()
                    .configuration(&handle.state::<ProviderRegistry>())
                    == binding
        });
        GatewayBroker::new(
            app.state::<GatewaySupervisor>().endpoint(true),
            alias,
            self.store.clone(),
            cloud,
            budget,
            job.into(),
            phase,
            deadline,
            cancel,
            current,
        )
        .map(Arc::new)
    }
    async fn run_job(
        self: Arc<Self>,
        app: &AppHandle,
        id: &str,
        cancel: CancellationToken,
        channel: &Option<Channel<ImprovementEvent>>,
        automatic: bool,
    ) -> Result<(), String> {
        let config = self.configuration(&app.state::<ProviderRegistry>());
        let evidence = self.store.evidence(automatic)?;
        if !evidence.is_empty() && self.store.daily_candidate_available()? {
            let key = digest(
                format!(
                    "{}|{}|{}|{}",
                    self.store.active()?.id,
                    config,
                    digest(
                        serde_json::to_string(&evidence)
                            .map_err(|_| "Invalid evidence.")?
                            .as_bytes()
                    ),
                    if automatic { String::new() } else { id.into() }
                )
                .as_bytes(),
            );
            app.state::<EnrichmentSupervisor>().improvement_request("enqueue",&json!({"idempotencyKey":key,"baseVersion":self.store.active()?.id,"configDigest":config,"phase":"analysis","candidateId":null})).await?;
        }
        let payload = app
            .state::<EnrichmentSupervisor>()
            .improvement_request("lease", &json!({}))
            .await?;
        if payload.is_null() {
            return Err("No eligible failures or recoverable improvement jobs are queued.".into());
        }
        let mut lease: Lease = serde_json::from_value(payload)
            .map_err(|_| "Improvement queue returned invalid data.")?;
        if !safe_id(&lease.idempotency_key, 128)
            || lease.generation == 0
            || !["analysis", "generation", "evaluation"].contains(&lease.phase.as_str())
        {
            return Err("Invalid improvement lease.".into());
        }
        let heartbeat_app = app.clone();
        let heartbeat_cancel = cancel.clone();
        let heartbeat_lease = lease.clone();
        let heartbeat = tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {_=heartbeat_cancel.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs(8))=>{}}
                let response=heartbeat_app.state::<EnrichmentSupervisor>().improvement_request("heartbeat",&json!({"idempotencyKey":heartbeat_lease.idempotency_key,"generation":heartbeat_lease.generation})).await;
                if response.is_err()
                    || !response.is_ok_and(|r| r["accepted"] == true)
                    || !policy_allows(&heartbeat_app)
                {
                    heartbeat_cancel.cancel();
                    break;
                }
            }
        });
        let result = async {
            let recovered = match &lease.candidate_id {
                Some(candidate_id) => Some(self.store.candidate(candidate_id)?),
                None => self.store.candidate_for_job(&lease.idempotency_key)?,
            };
            if recovered.as_ref().is_some_and(|candidate| candidate.report.is_some() || !matches!(candidate.status, CandidateStatus::Proposed | CandidateStatus::Evaluating)) {
                return Ok(());
            }
            let base = self.store.active()?;
            if lease.config_digest != config || lease.base_version != base.id {
                return Err("Recovered job requires a new base version or evaluation configuration.".into());
            }
            if recovered.is_none() {
                let runtime_health = self.docker.health().await;
                if runtime_health.state != "ready" {
                    return Err(runtime_health.detail.unwrap_or_else(|| "Prepare the pinned Docker runtime first.".into()));
                }
            }
            if self.store.settings()?.route_mode == RouteMode::Local {
                app.state::<crate::gateway::LocalRuntimeSupervisor>().start().map_err(|_| "The prepared local improvement model is unavailable.")?;
            }
            let probe_phase = if recovered.is_some() { "evaluation" } else { "generation" };
            let probe = self.broker(app, &config, cancel.clone(), &lease.idempotency_key, probe_phase)?;
            probe.probe(cancel.child_token()).await?;
            *self.compatible.lock().map_err(|_| "Improvement state is busy.")? = Some(config.clone());
            let evaluation_broker = recovered.as_ref().map(|_| probe.clone());
            let candidate = if let Some(candidate) = recovered { candidate } else {
                if evidence.is_empty() { return Err("Synthetic reproduction requires eligible sanitized failure metadata.".into()); }
                self.phase(id, "generation", channel);
                lease.phase = "generation".into();
                self.advance(app, &lease).await?;
                let evidence_digest = digest(serde_json::to_string(&evidence).map_err(|_| "Invalid evidence.")?.as_bytes());
                let input = json!({"activeVersion":base,"evidenceDigest":evidence_digest,"configDigest":config,"failures":evidence,"developmentCases":evaluation::development_cases()});
                let result = self.docker.run(input, cancel.clone(), probe).await?;
                if !self.store.phase_budget_valid(&lease.idempotency_key, "generation")? { return Err("improvement_budget_exceeded".into()); }
                let manifest: CandidateManifest = serde_json::from_value(result.manifest).map_err(|_| "Prime returned an invalid candidate manifest.")?;
                let active = self.active.lock().map_err(|_| "Improvement state is busy.")?;
                if cancel.is_cancelled() || active.as_ref().is_none_or(|job| job.id != id) { return Err("improvement_cancelled".into()); }
                self.store.create_for_job(&lease.idempotency_key, manifest, &config)?
            };
            if candidate.base_version != base.id || candidate.config_digest != config { return Err("Recovered candidate binding changed.".into()); }
            lease.candidate_id = Some(candidate.id.clone());
            lease.phase = "evaluation".into();
            self.advance(app, &lease).await?;
            self.phase(id, "evaluation", channel);
            self.store.mark(&candidate.id, CandidateStatus::Evaluating)?;
            let broker = match evaluation_broker { Some(broker) => broker, None => self.broker(app, &config, cancel.clone(), &lease.idempotency_key, "evaluation")? };
            let mut report = evaluation::evaluate(&candidate, &base, broker, cancel.clone()).await;
            if !self.store.phase_budget_valid(&lease.idempotency_key, "evaluation")? { report.budget_exceeded = true; report.complete = false; }
            // Fresh fence before publishing; never hold an admission lock during model work.
            self.advance(app, &lease).await?;
            let active = self.active.lock().map_err(|_| "Improvement state is busy.")?;
            if cancel.is_cancelled() || active.as_ref().is_none_or(|job| job.id != id) || !policy_allows(app) || self.configuration(&app.state::<ProviderRegistry>()) != config || !self.store.settings()?.enabled { return Err("improvement_cancelled".into()); }
            self.store.record_report(&candidate.id, report, candidate.kind == CandidateKind::Workflow)?;
            Ok(())
        }.await;
        let paused = self
            .active
            .lock()
            .ok()
            .is_some_and(|active| active.as_ref().is_some_and(|job| job.paused))
            || !policy_allows(app)
            || self.store.settings().is_ok_and(|s| s.paused);
        let cleanup_uncertain = result
            .as_ref()
            .err()
            .is_some_and(|error| error == super::docker::CLEANUP_UNCERTAIN);
        let status = if result.is_ok() {
            "completed"
        } else if cleanup_uncertain {
            "failed"
        } else if paused {
            "queued"
        } else if cancel.is_cancelled() {
            "cancelled"
        } else {
            "failed"
        };
        if result.is_err()
            && let Some(candidate_id) = lease.candidate_id.as_ref()
        {
            let _ = self.store.finish_interrupted_evaluation(
                candidate_id,
                paused && !cleanup_uncertain,
                cancel.is_cancelled() && !cleanup_uncertain,
            );
        }
        let _=app.state::<EnrichmentSupervisor>().improvement_request("finish",&json!({"idempotencyKey":lease.idempotency_key,"generation":lease.generation,"status":status})).await;
        heartbeat.abort();
        result
    }
    async fn advance(&self, app: &AppHandle, lease: &Lease) -> Result<(), String> {
        let response=app.state::<EnrichmentSupervisor>().improvement_request("advance",&json!({"idempotencyKey":lease.idempotency_key,"generation":lease.generation,"phase":lease.phase,"candidateId":lease.candidate_id})).await?;
        if response["accepted"] == true {
            Ok(())
        } else {
            Err("Improvement lease has expired.".into())
        }
    }
    fn phase(&self, id: &str, phase: &str, channel: &Option<Channel<ImprovementEvent>>) {
        if let Ok(mut active) = self.active.lock()
            && let Some(job) = active.as_mut()
            && job.id == id
        {
            job.phase = phase.into();
        }
        send(channel, id, "progress", phase, None);
    }
    pub fn start_scheduler(self: Arc<Self>, app: AppHandle) {
        tauri::async_runtime::spawn(async move {
            let _ = self.docker.cleanup_owned().await;
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let _ = self.store.prune();
                if !policy_allows(&app) {
                    self.cancel(true);
                    continue;
                }
                if self.store.settings().is_ok_and(|s| {
                    s.enabled && !s.paused && (s.route_mode != RouteMode::Cloud || s.cloud_consent)
                }) && self.active.lock().is_ok_and(|job| job.is_none())
                {
                    let _ = self.clone().analyze(app.clone(), None, true);
                }
            }
        });
    }
}
