use super::{
    executor::{Executable, ExecutorPool, Job, Worker},
    foreground::OwnedInputs,
    gate::InputGate,
    policy,
    protocol::*,
    provider::{self, Planner},
    stop::NativeStop,
    windows::{self, TargetRegistry, WindowIdentity},
};
use crate::consent::PersistedConsent;
use crate::improvement::{
    coordinator::ImprovementRuntime,
    types::{ExecutionTrace, HarnessVersion, ToolId, TraceError, TraceOutcome, digest, now_ms},
};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::Instant,
};
use tauri::ipc::Channel;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

struct PendingApproval {
    id: String,
    generation: u64,
    action_id: String,
    snapshot_id: String,
    target_id: String,
    created: Instant,
    sender: oneshot::Sender<bool>,
}
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub provider: String,
    pub execution_mode: String,
    pub target_kind: String,
    pub startup_wall_ms: u64,
    pub local_execution_ms: u64,
    pub provider_latency_ms: u64,
    pub approval_wait_ms: u64,
    pub provider_turns: u32,
    pub executed_actions: u32,
    pub verified_actions: u32,
    pub outcome_reviews: u32,
    pub screenshots: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub routes: HashMap<String, u32>,
    pub terminal: String,
    pub uncertain: bool,
    pub stop_gate_micros: u64,
    pub teardown_dispatch_micros: u64,
}
pub struct Run {
    harness: HarnessVersion,
    request: ComputerUseRequest,
    run_id: String,
    target_id: String,
    generation: u64,
    gate: InputGate,
    cancel: CancellationToken,
    terminal: AtomicBool,
    stop_reason: AtomicU8,
    inflight: AtomicBool,
    uncertain: AtomicBool,
    job: Mutex<Option<Arc<Job>>>,
    pending: Mutex<Option<PendingApproval>>,
    inputs: OwnedInputs,
    channel: Channel<ComputerUseEvent>,
    events: Mutex<()>,
    metrics: Mutex<Metrics>,
}
impl Run {
    #[cfg(test)]
    fn new(request: ComputerUseRequest, channel: Channel<ComputerUseEvent>) -> Arc<Self> {
        Self::with_harness(request, channel, HarnessVersion::default())
    }
    fn with_harness(
        request: ComputerUseRequest,
        channel: Channel<ComputerUseEvent>,
        harness: HarnessVersion,
    ) -> Arc<Self> {
        let target_id = match &request.target {
            TargetSelection::Browser { .. } => format!("edge:{}", uuid::Uuid::new_v4()),
            TargetSelection::Window { target_id } => target_id.clone(),
        };
        let metrics = Metrics {
            provider: request.provider.id().to_owned(),
            execution_mode: format!("{:?}", request.execution_mode).to_lowercase(),
            target_kind: if matches!(request.target, TargetSelection::Browser { .. }) {
                "browser"
            } else {
                "window"
            }
            .to_owned(),
            ..Metrics::default()
        };
        Arc::new(Self {
            harness,
            request,
            run_id: uuid::Uuid::new_v4().to_string(),
            target_id,
            generation: 1,
            gate: InputGate::new(),
            cancel: CancellationToken::new(),
            terminal: AtomicBool::new(false),
            stop_reason: AtomicU8::new(0),
            inflight: AtomicBool::new(false),
            uncertain: AtomicBool::new(false),
            job: Mutex::new(None),
            pending: Mutex::new(None),
            inputs: OwnedInputs::default(),
            channel,
            events: Mutex::new(()),
            metrics: Mutex::new(metrics),
        })
    }
    fn send(&self, event: EventKind, generation: u64) {
        let _ = self.channel.send(ComputerUseEvent {
            task_id: self.request.task_id,
            run_id: self.run_id.clone(),
            generation,
            target_id: self.target_id.clone(),
            event,
        });
    }
    fn emit(&self, event: EventKind) {
        if let Ok(_serial) = self.events.lock()
            && self.gate.is_open(self.generation)
            && !self.terminal.load(Ordering::Acquire)
        {
            self.send(event, self.generation);
        }
    }
    fn finish(&self, event: EventKind, terminal: &str) -> bool {
        let Ok(_serial) = self.events.lock() else {
            return false;
        };
        if !matches!(event, EventKind::Stopped { .. })
            && self.stop_reason.load(Ordering::Acquire) != 0
        {
            return false;
        }
        if self.terminal.swap(true, Ordering::AcqRel) {
            return false;
        }
        self.gate.close();
        self.cancel.cancel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.take();
        }
        if let Ok(mut metrics) = self.metrics.lock() {
            metrics.terminal = terminal.to_owned();
            metrics.uncertain = self.uncertain.load(Ordering::Acquire);
        }
        self.send(event, self.gate.generation());
        true
    }
    pub fn stop(&self, reason: StopReason) {
        if self.terminal.load(Ordering::Acquire) {
            return;
        }
        self.stop_reason
            .compare_exchange(
                0,
                match reason {
                    StopReason::Stop => 1,
                    StopReason::TakeOver => 2,
                    StopReason::ConsentRevoked => 3,
                },
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .ok();
        let began = Instant::now();
        self.gate.close();
        let gate_micros = began.elapsed().as_micros() as u64;
        self.cancel.cancel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.take();
        }
        if self.inflight.load(Ordering::Acquire) {
            self.uncertain.store(true, Ordering::Release);
        }
        let job = self.job.lock().ok().and_then(|job| job.clone());
        if let Some(job) = job {
            job.terminate();
        }
        self.inputs.release();
        if let Ok(mut metrics) = self.metrics.lock() {
            metrics.stop_gate_micros = gate_micros;
            metrics.teardown_dispatch_micros = began.elapsed().as_micros() as u64;
        }
        let reason = match self.stop_reason.load(Ordering::Acquire) {
            2 => StopReason::TakeOver,
            3 => StopReason::ConsentRevoked,
            _ => StopReason::Stop,
        };
        self.finish(
            EventKind::Stopped {
                reason,
                uncertain: self.uncertain.load(Ordering::Acquire),
            },
            "stopped",
        );
    }
    fn install_job(&self, job: Arc<Job>) {
        if let Ok(mut slot) = self.job.lock() {
            *slot = Some(Arc::clone(&job));
        }
        if !self.gate.is_open(self.generation) {
            job.terminate();
        }
    }
    fn live(
        &self,
        consent: &PersistedConsent,
        target: Option<&WindowIdentity>,
    ) -> Result<(), String> {
        if !self.gate.is_open(self.generation) {
            return Err("stopped".to_owned());
        }
        if !policy::consent_current(&self.request, consent) {
            self.stop(StopReason::ConsentRevoked);
            return Err("stopped".to_owned());
        }
        if let Some(target) = target {
            windows::revalidate(target)?;
        }
        Ok(())
    }
    async fn approve(
        &self,
        action_id: &str,
        snapshot_id: &str,
        scope: ApprovalScope,
        explanation: String,
    ) -> Result<(), String> {
        if !self.gate.is_open(self.generation) {
            return Err("stopped".to_owned());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|_| "approval_unavailable")?;
            if pending.is_some() {
                return Err("approval_already_pending".to_owned());
            }
            *pending = Some(PendingApproval {
                id: id.clone(),
                generation: self.generation,
                action_id: action_id.to_owned(),
                snapshot_id: snapshot_id.to_owned(),
                target_id: self.target_id.clone(),
                created: Instant::now(),
                sender,
            });
        }
        self.emit(EventKind::ApprovalRequired {
            approval_id: id.clone(),
            action_id: action_id.to_owned(),
            snapshot_id: snapshot_id.to_owned(),
            scope,
            explanation,
        });
        let began = Instant::now();
        let approved = tokio::select! {_=self.cancel.cancelled()=>None,result=tokio::time::timeout(std::time::Duration::from_secs(60),receiver)=>Some(result.ok().and_then(Result::ok).unwrap_or(false))};
        if let Ok(mut metrics) = self.metrics.lock() {
            metrics.approval_wait_ms += began.elapsed().as_millis() as u64;
        }
        let approved = approved.ok_or("stopped")?;
        if let Ok(mut pending) = self.pending.lock() {
            pending.take();
        }
        self.emit(EventKind::ApprovalResolved {
            approval_id: id,
            approved,
        });
        if approved {
            Ok(())
        } else {
            self.stop(StopReason::Stop);
            Err("stopped".to_owned())
        }
    }
    fn respond(&self, id: &str, approved: bool) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|_| "approval_unavailable")?;
        let valid = pending.as_ref().is_some_and(|a| {
            a.id == id
                && a.generation == self.generation
                && a.target_id == self.target_id
                && !a.action_id.is_empty()
                && !a.snapshot_id.is_empty()
                && a.created.elapsed() < std::time::Duration::from_secs(60)
                && self.gate.is_open(a.generation)
        });
        if !valid {
            return Err("The approval is stale or already resolved".to_owned());
        }
        pending
            .take()
            .unwrap()
            .sender
            .send(approved)
            .map_err(|_| "The approval is no longer active".to_owned())
    }
}

#[derive(Default)]
struct State {
    active: Option<Arc<Run>>,
    stopped: VecDeque<(u64, StopReason)>,
}
struct Inner {
    improvement: Mutex<Option<Arc<ImprovementRuntime>>>,
    state: Mutex<State>,
    targets: TargetRegistry,
    pool: Arc<ExecutorPool>,
    consent: PersistedConsent,
    directory: PathBuf,
    native_stop: AtomicBool,
    diagnostics: Mutex<VecDeque<Metrics>>,
}
impl Inner {
    fn stop(&self, task_id: Option<u64>, reason: StopReason) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Computer Use state unavailable")?;
        if let Some(task_id) = task_id
            && state
                .active
                .as_ref()
                .is_some_and(|run| run.request.task_id != task_id)
        {
            return Err("The requested task is not active".to_owned());
        }
        let task_id = task_id.or_else(|| state.active.as_ref().map(|run| run.request.task_id));
        if let Some(task_id) = task_id
            && !state.stopped.iter().any(|(id, _)| *id == task_id)
        {
            state.stopped.push_back((task_id, reason));
            if state.stopped.len() > 128 {
                state.stopped.pop_front();
            }
        }
        if let Some(run) = state.active.as_ref() {
            run.stop(reason);
        }
        // Keep start serialized through gate closure and pool invalidation.
        self.pool.discard();
        state.active.take();
        Ok(())
    }
}
pub struct ComputerUseSupervisor {
    inner: Arc<Inner>,
    _stop: NativeStop,
}
impl ComputerUseSupervisor {
    pub fn detect(
        packaged: PathBuf,
        staged: PathBuf,
        source: PathBuf,
        settings_path: PathBuf,
        directory: PathBuf,
    ) -> Self {
        let pool = ExecutorPool::new(
            Executable::detect(packaged, staged, source),
            directory.join("computer-use-scopes"),
        );
        let inner = Arc::new(Inner {
            improvement: Mutex::new(None),
            state: Mutex::new(State::default()),
            targets: TargetRegistry::default(),
            pool,
            consent: PersistedConsent::new(settings_path),
            directory,
            native_stop: AtomicBool::new(false),
            diagnostics: Mutex::new(VecDeque::new()),
        });
        let weak = Arc::downgrade(&inner);
        let stop = NativeStop::register(move || {
            if let Some(inner) = weak.upgrade() {
                let _ = inner.stop(None, StopReason::Stop);
            }
        });
        inner.native_stop.store(stop.available(), Ordering::Release);
        let weak = Arc::downgrade(&inner);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                let active = inner.state.lock().ok().and_then(|s| s.active.clone());
                if let Some(run) = active {
                    if !policy::consent_current(&run.request, &inner.consent) {
                        let _ = inner.stop(Some(run.request.task_id), StopReason::ConsentRevoked);
                    }
                } else {
                    inner.pool.check_consent(&inner.consent);
                }
            }
        });
        Self { inner, _stop: stop }
    }
    pub async fn health(&self) -> ComputerUseHealth {
        let pool = Arc::clone(&self.inner.pool);
        let (worker, gemini, openai) = tokio::join!(
            tauri::async_runtime::spawn_blocking(move || pool.health()),
            provider::availability(Provider::Gemini),
            provider::availability(Provider::Openai)
        );
        let worker = worker.ok().and_then(Result::ok);
        let native_stop = self.inner.native_stop.load(Ordering::Acquire);
        let browser = worker.as_ref().is_some_and(|w| w.ready && w.edge_available);
        let desktop = worker
            .as_ref()
            .is_some_and(|w| w.ready && w.desktop_available)
            && windows::interactive();
        ComputerUseHealth {
            state: if native_stop && (browser || desktop) {
                "ready"
            } else {
                "unavailable"
            },
            mode: self.inner.pool.mode(),
            browser: "Microsoft Edge",
            credential_configured: gemini.credential_configured,
            detail: worker.and_then(|w| w.detail),
            native_stop: Availability::from(
                native_stop,
                "Ctrl+Alt+Esc could not be registered; close the application using it and restart Lumen",
            ),
            routes: Routes {
                browser: Availability::from(
                    browser,
                    "Installed Microsoft Edge or its executor is unavailable",
                ),
                desktop: Availability::from(
                    desktop,
                    "The pinned Windows executor or interactive desktop is unavailable",
                ),
                foreground: Availability::from(
                    desktop && native_stop,
                    "Foreground input requires native Stop and an interactive desktop",
                ),
            },
            providers: Providers { gemini, openai },
        }
    }
    pub fn targets(&self) -> Result<Vec<WindowTarget>, String> {
        self.inner.targets.discover()
    }
    pub fn diagnostics(&self) -> Vec<Metrics> {
        self.inner
            .diagnostics
            .lock()
            .map(|d| d.iter().cloned().collect())
            .unwrap_or_default()
    }
    pub(crate) fn set_improvement(&self, runtime: Arc<ImprovementRuntime>) {
        if let Ok(mut slot) = self.inner.improvement.lock() {
            *slot = Some(runtime);
        }
    }
    pub(crate) fn is_active(&self) -> bool {
        self.inner
            .state
            .lock()
            .is_ok_and(|state| state.active.is_some())
    }
    pub(crate) fn start_with_harness(
        &self,
        request: ComputerUseRequest,
        channel: Channel<ComputerUseEvent>,
        harness: HarnessVersion,
    ) -> Result<(), String> {
        policy::validate_request(&request, &self.inner.consent)?;
        if !self.inner.native_stop.load(Ordering::Acquire) {
            return Err("Native Stop is unavailable".to_owned());
        }
        let window = match &request.target {
            TargetSelection::Window { target_id } => Some(self.inner.targets.resolve(target_id)?),
            _ => None,
        };
        let run = Run::with_harness(request, channel, harness);
        {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| "Computer Use state unavailable")?;
            if let Some((_, reason)) = state
                .stopped
                .iter()
                .find(|(id, _)| *id == run.request.task_id)
            {
                run.stop(*reason);
                return Ok(());
            }
            if state
                .active
                .as_ref()
                .is_some_and(|active| !active.terminal.load(Ordering::Acquire))
            {
                return Err("Another Computer Use task is still active".to_owned());
            }
            if state.active.is_some() {
                self.inner.pool.discard();
            }
            state.active = Some(Arc::clone(&run));
        }
        let inner = Arc::clone(&self.inner);
        tauri::async_runtime::spawn(async move {
            let result = execute(&inner, &run, window.as_ref()).await;
            if let Err(error) = result
                && error != "stopped"
            {
                run.finish(
                    EventKind::Failed {
                        code: "computer_use_failed".to_owned(),
                        message: error,
                    },
                    "failed",
                );
            }
            run.inputs.release();
            if let Ok(mut job) = run.job.lock() {
                job.take();
            }
            let saved_metrics = run.metrics.lock().ok().map(|m| m.clone());
            if let Some(metrics) = saved_metrics.as_ref()
                && let Some(runtime) = inner.improvement.lock().ok().and_then(|slot| slot.clone())
            {
                let completed = metrics.terminal == "completed";
                let cancelled = run.cancel.is_cancelled();
                let _ = runtime.store.append_trace(&ExecutionTrace {
                    id: run.run_id.clone(),
                    at: now_ms(),
                    tool_id: ToolId::ComputerUsePlan,
                    model: digest(run.request.model.as_bytes()),
                    route: format!("computerUse.{}", run.request.provider.id()),
                    error_code: if completed {
                        TraceError::None
                    } else if cancelled {
                        TraceError::Cancelled
                    } else if metrics.uncertain {
                        TraceError::VerificationFailed
                    } else {
                        TraceError::UnknownFailure
                    },
                    outcome: if completed {
                        TraceOutcome::Completed
                    } else if cancelled {
                        TraceOutcome::Cancelled
                    } else {
                        TraceOutcome::Failed
                    },
                    verified: completed,
                    duration_ms: metrics.startup_wall_ms
                        + metrics.local_execution_ms
                        + metrics.provider_latency_ms
                        + metrics.approval_wait_ms,
                    input_tokens: (metrics.input_tokens > 0).then_some(metrics.input_tokens),
                    output_tokens: (metrics.output_tokens > 0).then_some(metrics.output_tokens),
                    harness_version: run.harness.id,
                });
            }
            if let Some(metrics) = saved_metrics
                && let Ok(mut diagnostics) = inner.diagnostics.lock()
            {
                diagnostics.push_back(metrics.clone());
                while diagnostics.len() > 20 {
                    diagnostics.pop_front();
                }
                if let Ok(bytes) = serde_json::to_vec_pretty(&*diagnostics) {
                    let _ = std::fs::write(
                        inner.directory.join("computer-use-diagnostics.json"),
                        bytes,
                    );
                }
            }
            if let Ok(mut state) = inner.state.lock()
                && state
                    .active
                    .as_ref()
                    .is_some_and(|active| active.run_id == run.run_id)
            {
                state.active.take();
            }
        });
        Ok(())
    }
    pub fn stop(&self, task_id: u64, reason: StopReason) -> Result<(), String> {
        self.inner.stop(Some(task_id), reason)
    }
    pub fn respond(&self, task_id: u64, approval_id: &str, approved: bool) -> Result<(), String> {
        let run = self
            .inner
            .state
            .lock()
            .map_err(|_| "Computer Use state unavailable")?
            .active
            .clone()
            .filter(|run| run.request.task_id == task_id)
            .ok_or("The task is no longer active")?;
        run.respond(approval_id, approved)
    }
}
impl Drop for ComputerUseSupervisor {
    fn drop(&mut self) {
        let _ = self.inner.stop(None, StopReason::Stop);
    }
}

async fn observe(run: &Run, worker: &Arc<Worker>, screenshot: bool) -> Result<Observation, String> {
    let began = Instant::now();
    let response = worker
        .rpc(
            &run.run_id,
            run.generation,
            Operation::Observe { screenshot },
            &run.cancel,
        )
        .await;
    if let Ok(mut metrics) = run.metrics.lock() {
        metrics.local_execution_ms += began.elapsed().as_millis() as u64;
    }
    let response = response?;
    if !response.ok {
        return Err(response
            .error
            .map(|e| e.code)
            .unwrap_or_else(|| "observation_unavailable".to_owned()));
    }
    let observation = response.observation.ok_or("observation_unavailable")?;
    if observation.screenshot.is_some()
        && let Ok(mut metrics) = run.metrics.lock()
    {
        metrics.screenshots += 1;
    }
    run.emit(EventKind::Observation {
        snapshot_id: observation.snapshot_id.clone(),
        url: observation.url.clone(),
    });
    Ok(observation)
}
async fn execute(
    inner: &Inner,
    run: &Arc<Run>,
    window: Option<&WindowIdentity>,
) -> Result<(), String> {
    run.live(&inner.consent, window)?;
    let start = Instant::now();
    let mut planner = Planner::new(&run.request, &run.cancel).await?;
    planner.set_supplement(run.harness.computer_use_supplement());
    run.live(&inner.consent, window)?;
    let scope = if let Some(window) = window {
        format!(
            "window:{}:{}:{}:{}:{}",
            run.request.provider.id(),
            run.target_id,
            window.pid,
            window.hwnd,
            window.created
        )
    } else {
        format!("browser:{}", run.request.provider.id())
    };
    let pool = Arc::clone(&inner.pool);
    let epoch = pool.epoch();
    let worker_scope = scope.clone();
    let target = window.cloned();
    let acquire =
        tauri::async_runtime::spawn_blocking(move || pool.acquire(&worker_scope, target.as_ref()));
    let worker = tokio::select! {_=run.cancel.cancelled()=>return Err("stopped".to_owned()),result=acquire=>result.map_err(|_|"executor_start_failed")??};
    run.install_job(Arc::clone(&worker.job));
    run.live(&inner.consent, window)?;
    if matches!(
        run.request.target,
        TargetSelection::Browser { visible: true, .. }
    ) {
        run.approve(
            &uuid::Uuid::new_v4().to_string(),
            "startup",
            ApprovalScope::VisibleBrowser,
            "Open this fresh Edge session visibly? It may take foreground focus.".to_owned(),
        )
        .await?;
        run.live(&inner.consent, window)?;
    }
    let target = match &run.request.target {
        TargetSelection::Browser {
            initial_url,
            visible,
        } => WorkerTarget::Browser {
            initial_url: initial_url.clone(),
            headless: !*visible,
        },
        TargetSelection::Window { .. } => {
            let window = window.ok_or("target_unavailable")?;
            WorkerTarget::Window {
                pid: window.pid,
                window_id: window.hwnd,
                executable: window.executable.clone(),
            }
        }
    };
    let begin = worker
        .rpc(
            &run.run_id,
            run.generation,
            Operation::Begin {
                target,
                manifest_path: worker
                    .manifest_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().into_owned()),
            },
            &run.cancel,
        )
        .await?;
    if !begin.ok {
        return Err(begin
            .error
            .map(|e| e.code)
            .unwrap_or_else(|| "executor_start_failed".to_owned()));
    }
    if let Ok(mut metrics) = run.metrics.lock() {
        metrics.startup_wall_ms = start.elapsed().as_millis() as u64;
    }
    run.emit(EventKind::Started {
        provider: run.request.provider,
        model: run.request.model.clone(),
        execution_mode: run.request.execution_mode,
        browser: if window.is_some() {
            "Selected Windows window"
        } else {
            "Microsoft Edge"
        }
        .to_owned(),
    });
    let mut observation = observe(run, &worker, false).await?;
    let mut vision = false;
    let mut budget = policy::Budget::default();
    let mut empty_turns = 0;
    let mut outcome_review: Option<policy::OutcomeReview> = None;
    loop {
        run.live(&inner.consent, window)?;
        budget.turn()?;
        if let Ok(mut metrics) = run.metrics.lock() {
            metrics.provider_turns = budget.provider_turns;
        }
        run.emit(EventKind::Reasoning {
            text: "Planning from the selected target's current state".to_owned(),
        });
        let began = Instant::now();
        let turn = planner
            .plan(&observation, vision, outcome_review.is_some(), &run.cancel)
            .await?;
        if let Ok(mut metrics) = run.metrics.lock() {
            metrics.provider_latency_ms += began.elapsed().as_millis() as u64;
            metrics.input_tokens += turn.input_tokens;
            metrics.output_tokens += turn.output_tokens;
        }
        run.live(&inner.consent, window)?;
        if let Some(review) = outcome_review.as_mut() {
            review.admit_plan(&turn.plan, vision)?;
        }
        if turn.plan.done {
            // Delivery uncertainty remains in diagnostics. A bounded read-only
            // review may independently establish the task's postconditions.
            let fresh = observe(run, &worker, vision).await?;
            run.live(&inner.consent, window)?;
            if let Some(review) = outcome_review.as_ref() {
                review.verify(&turn.plan, &observation, &fresh)?;
            } else if run.uncertain.load(Ordering::Acquire) {
                return Err(
                    "The final result remains uncertain; inspect the target before continuing"
                        .to_owned(),
                );
            } else {
                policy::verify_completion(&turn.plan.completion_checks, &observation, &fresh)?;
            }
            let end = worker
                .rpc(&run.run_id, run.generation, Operation::End, &run.cancel)
                .await?;
            if !end.ok {
                return Err("executor_end_failed".to_owned());
            }
            run.live(&inner.consent, window)?;
            if run.finish(
                EventKind::Completed {
                    summary: if turn.plan.summary.is_empty() {
                        "Task finished; review the target's observed state".to_owned()
                    } else {
                        turn.plan.summary.clone()
                    },
                },
                "completed",
            ) {
                if let Ok(mut job) = run.job.lock() {
                    job.take();
                }
                inner.pool.release(scope, worker, epoch);
            }
            return Ok(());
        }
        if turn.plan.needs_vision {
            if vision {
                return Err(
                    "No supported action could be established from the selected target".to_owned(),
                );
            }
            observation = observe(run, &worker, true).await?;
            planner.feedback(&turn, &[], &observation, false)?;
            vision = true;
            continue;
        }
        if turn.plan.actions.is_empty() {
            empty_turns += 1;
            if empty_turns > 2 {
                return Err("The planner did not propose an executable action".to_owned());
            }
        } else {
            empty_turns = 0;
        }
        let original = observation.clone();
        let mut results = Vec::new();
        let mut approved = false;
        for (index, planned) in turn.plan.actions.iter().enumerate() {
            run.live(&inner.consent, window)?;
            let mut action = planned.clone();
            if index > 0 && policy::rebind(&mut action, &original, &observation).is_err() {
                break;
            }
            if let Some(semantic) = policy::semantic_coordinate(&action, &observation) {
                action = semantic;
            }
            policy::validate_action(&action, &observation)?;
            let action_id = uuid::Uuid::new_v4().to_string();
            let mut approval_boundary = false;
            for safety in turn.safety.iter().filter(|s| s.action_index == index) {
                run.approve(
                    &action_id,
                    &observation.snapshot_id,
                    ApprovalScope::Safety,
                    safety.explanation.clone(),
                )
                .await?;
                approved = true;
                approval_boundary = true;
                run.live(&inner.consent, window)?;
                let current = observe(run, &worker, vision).await?;
                if !policy::approval_state_matches(&action, &observation, &current) {
                    return Err("approval_snapshot_changed".to_owned());
                }
                if action.element.is_some() {
                    policy::rebind(&mut action, &observation, &current)?;
                }
                observation = current;
            }
            if action.kind == ActionKind::Wait {
                let before_wait = observation.clone();
                tokio::select! {_=run.cancel.cancelled()=>return Err("stopped".to_owned()),_=tokio::time::sleep(std::time::Duration::from_millis(action.amount.unwrap_or(0.0) as u64))=>{}}
                observation = observe(run, &worker, vision).await?;
                results.push(ActionResult {
                    effect: Effect::Confirmed,
                    route: if window.is_some() {
                        Route::Uia
                    } else {
                        Route::Playwright
                    },
                    verified: true,
                    detail: None,
                });
                if policy::batch_boundary(&action, approval_boundary, &before_wait, &observation) {
                    break;
                }
                continue;
            }
            budget.action()?;
            let permit = run.gate.admit(run.generation).map_err(str::to_owned)?;
            run.live(&inner.consent, window)?;
            run.emit(EventKind::Action {
                action_id: action_id.clone(),
                action: action.kind.id().to_owned(),
            });
            run.inflight.store(true, Ordering::Release);
            if let Ok(mut metrics) = run.metrics.lock() {
                metrics.executed_actions = budget.executed_actions;
            }
            let input_observation = observation.clone();
            let mut outcome_before = input_observation.clone();
            let began = Instant::now();
            let response = worker
                .rpc(
                    &run.run_id,
                    run.generation,
                    Operation::Act {
                        snapshot_id: observation.snapshot_id.clone(),
                        action: action.clone(),
                    },
                    &run.cancel,
                )
                .await;
            if let Ok(mut metrics) = run.metrics.lock() {
                metrics.local_execution_ms += began.elapsed().as_millis() as u64;
            }
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    run.uncertain.store(true, Ordering::Release);
                    run.inflight.store(false, Ordering::Release);
                    return Err(error);
                }
            };
            let mut result = if response.ok {
                observation = response.observation.ok_or_else(|| {
                    run.uncertain.store(true, Ordering::Release);
                    "missing_post_observation"
                })?;
                if observation.screenshot.is_some()
                    && let Ok(mut metrics) = run.metrics.lock()
                {
                    metrics.screenshots += 1;
                }
                response.result.ok_or_else(|| {
                    run.uncertain.store(true, Ordering::Release);
                    "missing_verification"
                })?
            } else {
                let error = response.error.ok_or_else(|| {
                    run.uncertain.store(true, Ordering::Release);
                    "invalid_worker_error"
                })?;
                ActionResult {
                    effect: if ["backgroundUnavailable", "staleSnapshot", "invalidAction"]
                        .contains(&error.code.as_str())
                    {
                        Effect::Refused
                    } else {
                        Effect::Unverifiable
                    },
                    route: if window.is_some() {
                        Route::Uia
                    } else {
                        Route::Playwright
                    },
                    verified: false,
                    detail: Some(error.code.clone()),
                }
            };
            if !result.verified && result.effect != Effect::Refused {
                run.uncertain.store(true, Ordering::Release);
            }
            run.inflight.store(false, Ordering::Release);
            run.emit(EventKind::Observation {
                snapshot_id: observation.snapshot_id.clone(),
                url: observation.url.clone(),
            });
            drop(permit);
            if result.effect == Effect::Refused {
                // No worker action is retried with foreground input except a
                // proved background refusal plus a fresh, scoped approval.
                if result.detail.as_deref() == Some("backgroundUnavailable")
                    && run.request.execution_mode == ExecutionMode::Fast
                    && let Some(foreground_window) = window
                {
                    if !super::foreground::supported(&action) {
                        return Err("foreground_gesture_unavailable".to_owned());
                    }
                    observation = observe(run, &worker, true).await?;
                    if action.element.is_some() {
                        policy::rebind(&mut action, &input_observation, &observation)?;
                    } else if action.kind.coordinates()
                        && !policy::pixels_unchanged(&input_observation, &observation)
                    {
                        return Err(
                            "Refresh coordinates before requesting foreground input".to_owned()
                        );
                    }
                    let foreground_id = uuid::Uuid::new_v4().to_string();
                    run.approve(
                        &foreground_id,
                        &observation.snapshot_id,
                        ApprovalScope::Foreground,
                        "This action needs foreground input in the selected window. Allow it once?"
                            .to_owned(),
                    )
                    .await?;
                    run.live(&inner.consent, window)?;
                    // Approval belongs to this observation. Probe the target
                    // after the user wait and refuse changed state before input.
                    let current = observe(run, &worker, true).await?;
                    if !policy::approval_state_matches(&action, &observation, &current) {
                        return Err("approval_snapshot_changed".to_owned());
                    }
                    outcome_before = current;
                    budget.action()?;
                    let _foreground = run.gate.admit(run.generation).map_err(str::to_owned)?;
                    run.emit(EventKind::Action {
                        action_id: foreground_id,
                        action: action.kind.id().to_owned(),
                    });
                    run.inflight.store(true, Ordering::Release);
                    if let Ok(mut metrics) = run.metrics.lock() {
                        metrics.executed_actions = budget.executed_actions;
                    }
                    let began = Instant::now();
                    let foreground_result = run.inputs.execute(
                        foreground_window,
                        &run.gate,
                        run.generation,
                        &action,
                        &observation,
                    );
                    if let Ok(mut metrics) = run.metrics.lock() {
                        metrics.local_execution_ms += began.elapsed().as_millis() as u64;
                    }
                    result = foreground_result.inspect_err(|_error| {
                        run.uncertain.store(true, Ordering::Release);
                    })?;
                    let before = observation.clone();
                    observation = observe(run, &worker, vision).await.inspect_err(|_error| {
                        run.uncertain.store(true, Ordering::Release);
                    })?;
                    if action.kind == ActionKind::SetValue {
                        let mut rebound = action.clone();
                        if policy::rebind(&mut rebound, &before, &observation).is_ok()
                            && observation
                                .elements
                                .iter()
                                .find(|e| Some(&e.reference) == rebound.element.as_ref())
                                .is_some_and(|e| e.value == action.text)
                        {
                            result.effect = Effect::Confirmed;
                            result.verified = true;
                        }
                    }
                    if !result.verified {
                        run.uncertain.store(true, Ordering::Release);
                    }
                    run.inflight.store(false, Ordering::Release);
                    approval_boundary = true;
                } else {
                    if result.detail.as_deref() == Some("backgroundUnavailable") {
                        return Err("backgroundUnavailable: this target does not support the requested background action".to_owned());
                    }
                    return Err(
                        "The executor refused this action before delivering input".to_owned()
                    );
                }
            }
            if let Ok(mut metrics) = run.metrics.lock() {
                metrics.executed_actions = budget.executed_actions;
                metrics.verified_actions += u32::from(result.verified);
                *metrics
                    .routes
                    .entry(format!("{:?}", result.route))
                    .or_default() += 1;
            }
            run.live(&inner.consent, window)?;
            let verified = result.verified;
            results.push(result);
            if !verified {
                run.uncertain.store(true, Ordering::Release);
                outcome_review = Some(policy::OutcomeReview::new(outcome_before));
                if let Ok(mut metrics) = run.metrics.lock() {
                    metrics.outcome_reviews += 1;
                }
                break;
            }
            // A verified input can change the page URL without being Navigate
            // (for example setValue triggering pushState). Replan that context.
            if policy::batch_boundary(&action, approval_boundary, &input_observation, &observation)
            {
                break;
            }
        }
        if vision || outcome_review.is_some() {
            // Even an uncertain worker error may lack a post-observation.
            // Read current target state once before the bounded review turn.
            observation = observe(run, &worker, vision).await?;
            run.live(&inner.consent, window)?;
        }
        planner.feedback(&turn, &results, &observation, approved)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Builds a synthetic Stop supervisor without registering a global hotkey or real executor.
    fn supervisor_fixture() -> ComputerUseSupervisor {
        let directory =
            std::env::temp_dir().join(format!("lumen-stop-test-{}", uuid::Uuid::new_v4()));
        // Direct Stop tests do not own the global shortcut or admit a real executor.
        ComputerUseSupervisor {
            inner: Arc::new(Inner {
                improvement: Mutex::new(None),
                state: Mutex::new(State::default()),
                targets: TargetRegistry::default(),
                pool: ExecutorPool::new(Executable::Missing, directory.join("computer-use-scopes")),
                consent: PersistedConsent::new(directory.join("settings.json")),
                directory,
                native_stop: AtomicBool::new(false),
                diagnostics: Mutex::new(VecDeque::new()),
            }),
            _stop: NativeStop::unregistered_fixture(),
        }
    }

    fn request() -> ComputerUseRequest {
        serde_json::from_value(serde_json::json!({"taskId":1,"task":"Fixture","provider":"gemini","model":"gemini-3.8-flash","executionMode":"fast","target":{"kind":"browser","initialUrl":"https://example.com"},"cloudConsent":true,"desktopControlConsent":false,"desktopCloudConsent":false})).unwrap()
    }
    #[test]
    fn acknowledged_stop_releases_the_run_before_executor_cleanup() {
        let supervisor = supervisor_fixture();
        assert!(
            !supervisor._stop.available(),
            "Synthetic Stop fixtures must not register the global hotkey"
        );
        assert!(!supervisor.inner.native_stop.load(Ordering::Acquire));
        let run = Run::new(request(), Channel::new(|_| Ok(())));
        supervisor.inner.state.lock().unwrap().active = Some(Arc::clone(&run));

        supervisor.stop(1, StopReason::Stop).unwrap();

        assert!(run.terminal.load(Ordering::Acquire));
        assert!(!run.gate.is_open(run.generation));
        assert!(supervisor.inner.state.lock().unwrap().active.is_none());
        let mut next = request();
        next.task_id = 2;
        let next_run = Run::new(next, Channel::new(|_| Ok(())));
        supervisor.inner.state.lock().unwrap().active = Some(Arc::clone(&next_run));
        supervisor.stop(2, StopReason::TakeOver).unwrap();
        assert!(next_run.terminal.load(Ordering::Acquire));
    }
    #[test]
    fn denied_approval_closes_admission_and_finishes_as_stopped() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let output = Arc::clone(&events);
        let run = Run::new(
            request(),
            Channel::new(move |body| {
                output.lock().unwrap().push(format!("{body:?}"));
                Ok(())
            }),
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let outcome = runtime.block_on(async {
            let deny = async {
                let id = loop {
                    if let Some(id) = run
                        .pending
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map(|approval| approval.id.clone())
                    {
                        break id;
                    }
                    tokio::task::yield_now().await;
                };
                run.respond(&id, false).unwrap();
            };
            tokio::join!(
                run.approve(
                    "action",
                    "snapshot",
                    ApprovalScope::Safety,
                    "Submit?".into()
                ),
                deny
            )
            .0
        });
        assert_eq!(outcome, Err("stopped".to_owned()));
        assert!(run.terminal.load(Ordering::Acquire));
        assert!(!run.gate.is_open(run.generation));
        assert_eq!(run.metrics.lock().unwrap().terminal, "stopped");
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 3);
        assert!(events[2].contains("stopped"));
    }
    #[test]
    fn stop_does_not_need_stdin_and_invalidates_approvals_and_generations() {
        let run = Run::new(request(), Channel::new(|_| Ok(())));
        let (sender, receiver) = oneshot::channel();
        *run.pending.lock().unwrap() = Some(PendingApproval {
            id: "approval".into(),
            generation: 1,
            action_id: "action".into(),
            snapshot_id: "snapshot".into(),
            target_id: run.target_id.clone(),
            created: Instant::now(),
            sender,
        });
        run.inflight.store(true, Ordering::Release);
        run.stop(StopReason::TakeOver);
        assert_eq!(run.gate.generation(), 2);
        assert!(run.respond("approval", true).is_err());
        assert!(receiver.blocking_recv().is_err());
        assert!(run.uncertain.load(Ordering::Acquire));
        assert!(run.cancel.is_cancelled());
    }
    #[test]
    fn exactly_one_terminal_event_and_no_late_worker_events() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let output = Arc::clone(&events);
        let run = Run::new(
            request(),
            Channel::new(move |body| {
                output.lock().unwrap().push(format!("{body:?}"));
                Ok(())
            }),
        );
        run.stop(StopReason::Stop);
        run.stop(StopReason::TakeOver);
        run.emit(EventKind::Reasoning {
            text: "late".into(),
        });
        run.finish(
            EventKind::Completed {
                summary: "late".into(),
            },
            "completed",
        );
        assert_eq!(events.lock().unwrap().len(), 1);
    }
    #[test]
    fn verified_task_completion_preserves_delivery_uncertainty_and_stop_still_wins() {
        let run = Run::new(request(), Channel::new(|_| Ok(())));
        run.uncertain.store(true, Ordering::Release);
        run.metrics.lock().unwrap().outcome_reviews = 1;
        assert!(run.finish(
            EventKind::Completed {
                summary: "Observed result".into()
            },
            "completed"
        ));
        let metrics = run.metrics.lock().unwrap();
        assert!(metrics.uncertain);
        assert_eq!(metrics.outcome_reviews, 1);
        assert_eq!(metrics.verified_actions, 0);
        drop(metrics);

        let stopped = Run::new(request(), Channel::new(|_| Ok(())));
        stopped.uncertain.store(true, Ordering::Release);
        stopped.stop(StopReason::TakeOver);
        assert!(!stopped.finish(
            EventKind::Completed {
                summary: "Late result".into()
            },
            "completed"
        ));
        assert!(stopped.uncertain.load(Ordering::Acquire));
        assert_eq!(stopped.metrics.lock().unwrap().terminal, "stopped");
    }
    #[test]
    fn replayed_or_wrong_approval_does_not_consume_a_valid_pending_approval() {
        let run = Run::new(request(), Channel::new(|_| Ok(())));
        let (sender, receiver) = oneshot::channel();
        *run.pending.lock().unwrap() = Some(PendingApproval {
            id: "good".into(),
            generation: 1,
            action_id: "action".into(),
            snapshot_id: "snapshot".into(),
            target_id: run.target_id.clone(),
            created: Instant::now(),
            sender,
        });
        assert!(run.respond("wrong", true).is_err());
        run.respond("good", true).unwrap();
        assert_eq!(receiver.blocking_recv(), Ok(true));
        assert!(run.respond("good", true).is_err());
    }
    #[test]
    #[cfg(windows)]
    fn native_stop_terminates_a_worker_with_blocked_stdin() {
        use std::{
            io::Write,
            os::windows::process::CommandExt,
            process::{Command, Stdio},
            time::Duration,
        };
        let mut child = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let job = Job::assign(&child).unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let (started, ready) = std::sync::mpsc::sync_channel(1);
        let writer = std::thread::spawn(move || {
            started.send(()).unwrap();
            stdin.write_all(&vec![b'x'; 8 * 1024 * 1024])
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        let run = Run::new(request(), Channel::new(|_| Ok(())));
        run.install_job(job);
        run.inflight.store(true, Ordering::Release);
        let began = Instant::now();
        run.stop(StopReason::Stop);
        assert!(began.elapsed() < Duration::from_millis(50));
        while child.try_wait().unwrap().is_none() {
            assert!(began.elapsed() < Duration::from_secs(1));
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(writer.join().unwrap().is_err());
        assert!(run.uncertain.load(Ordering::Acquire));
    }
    #[test]
    fn stop_during_startup_kills_a_late_executor_before_input_admission() {
        let run = Run::new(request(), Channel::new(|_| Ok(())));
        run.stop(StopReason::Stop);
        assert!(!run.gate.is_open(1));
        assert!(run.gate.admit(1).is_err());
        // The executor receives no begin/action when a reserved run is stopped.
        assert!(run.cancel.is_cancelled());
        run.emit(EventKind::Started {
            provider: Provider::Gemini,
            model: "gemini-3.8-flash".into(),
            execution_mode: ExecutionMode::Fast,
            browser: "Edge".into(),
        });
        assert!(run.terminal.load(Ordering::Acquire));
    }
    #[test]
    #[cfg(windows)]
    #[ignore = "native reference-machine acceptance; writes content-free timing evidence"]
    fn native_stop_twenty_blocked_worker_samples() {
        use std::{
            io::Write,
            os::windows::process::CommandExt,
            process::{Command, Stdio},
            time::Duration,
        };
        let mut samples = Vec::new();
        for _ in 0..20 {
            let mut child = Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 60",
                ])
                .creation_flags(0x0800_0000)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let job = Job::assign(&child).unwrap();
            let mut stdin = child.stdin.take().unwrap();
            let (sender, blocked) = std::sync::mpsc::sync_channel(1);
            let writer = std::thread::spawn(move || {
                let result = stdin.write_all(&vec![b'x'; 8 * 1024 * 1024]);
                let _ = sender.send(result);
            });
            assert!(
                blocked.recv_timeout(Duration::from_millis(20)).is_err(),
                "Worker input must be blocked before Stop"
            );
            let run = Run::new(request(), Channel::new(|_| Ok(())));
            run.install_job(job);
            let permit = run.gate.admit(1).unwrap();
            run.inflight.store(true, Ordering::Release);
            let began = Instant::now();
            run.stop(StopReason::Stop);
            assert!(run.gate.admit(1).is_err());
            while child.try_wait().unwrap().is_none() {
                assert!(began.elapsed() < Duration::from_secs(1));
                std::thread::sleep(Duration::from_millis(1));
            }
            let teardown_us = began.elapsed().as_micros() as u64;
            assert!(
                blocked
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap()
                    .is_err()
            );
            writer.join().unwrap();
            drop(permit);
            let metrics = run.metrics.lock().unwrap();
            samples.push(serde_json::json!({"gateMicros":metrics.stop_gate_micros,"teardownMicros":teardown_us}));
        }
        let mut gate: Vec<u64> = samples
            .iter()
            .map(|s| s["gateMicros"].as_u64().unwrap())
            .collect();
        let mut teardown: Vec<u64> = samples
            .iter()
            .map(|s| s["teardownMicros"].as_u64().unwrap())
            .collect();
        gate.sort_unstable();
        teardown.sort_unstable();
        assert!(gate[18] <= 50_000);
        assert!(teardown[18] <= 1_000_000);
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../artifacts/performance/computer-use-stop.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec_pretty(&serde_json::json!({"platform":"Windows x64","repetitions":20,"method":"native gate and Job Object with blocked stdin and held admission permit","gateP95Micros":gate[18],"teardownP95Micros":teardown[18],"samples":samples})).unwrap()).unwrap();
    }
}
