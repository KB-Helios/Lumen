use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    io::{BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use zeroize::{Zeroize, Zeroizing};

use super::{
    activation::ActivationQueue,
    preferences::Preferences,
    protocol::{self, Envelope, Event},
    types::{Agent, Snapshot},
};

struct HelperProcess {
    child: Arc<Mutex<Child>>,
    input: SyncSender<Zeroizing<Vec<u8>>>,
    output: Receiver<Result<Vec<u8>, String>>,
    #[cfg(windows)]
    job: isize,
}

impl HelperProcess {
    fn start(path: &Path) -> Result<Self, String> {
        if !path.is_file() {
            return Err("The Windows AI helper is not staged or packaged".to_owned());
        }
        let mut command = Command::new(path);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(directory) = path.parent() {
            command.current_dir(directory);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "The Windows AI helper could not start".to_owned())?;
        #[cfg(windows)]
        let job = match attach_job(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Windows AI helper input is unavailable".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Windows AI helper output is unavailable".to_owned())?;
        let child = Arc::new(Mutex::new(child));
        let (input, input_receiver) = mpsc::sync_channel::<Zeroizing<Vec<u8>>>(2);
        let (output_sender, output) = mpsc::sync_channel(16);
        let writer_child = child.clone();
        std::thread::spawn(move || {
            let mut stdin = stdin;
            while let Ok(bytes) = input_receiver.recv() {
                if stdin
                    .write_all(&bytes)
                    .and_then(|()| stdin.flush())
                    .is_err()
                {
                    if let Ok(mut child) = writer_child.lock() {
                        let _ = child.kill();
                    }
                    break;
                }
            }
        });
        let reader_child = child.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let result = protocol::read_bounded_line(&mut reader);
                match result {
                    Ok(Some(line)) => {
                        if output_sender.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => {
                        let _ = output_sender.send(Err(
                            "The Windows AI helper exited before its response".to_owned(),
                        ));
                        break;
                    }
                    Err(error) => {
                        if let Ok(mut child) = reader_child.lock() {
                            let _ = child.kill();
                        }
                        let _ = output_sender.send(Err(error));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            input,
            output,
            #[cfg(windows)]
            job,
        })
    }

    fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }

    fn alive(&self) -> bool {
        self.child
            .lock()
            .ok()
            .is_some_and(|mut child| matches!(child.try_wait(), Ok(None)))
    }
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        self.kill();
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                self.job as *mut _,
            ));
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.wait();
        }
    }
}

#[cfg(windows)]
fn attach_job(child: &Child) -> Result<isize, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::{
        Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
        },
        core::PCWSTR,
    };
    let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .map_err(|_| "The Windows AI process sandbox could not be created".to_owned())?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let result = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&limits).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
        .and_then(|()| AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())))
    };
    if result.is_err() {
        unsafe {
            let _ = CloseHandle(job);
        }
        return Err("The Windows AI helper could not be confined to its job".to_owned());
    }
    Ok(job.0 as isize)
}

struct ActiveControl {
    request_id: String,
    cancelled: Arc<AtomicBool>,
    input: SyncSender<Zeroizing<Vec<u8>>>,
    dispatched: bool,
}

pub struct WindowsAiRuntime {
    helper: PathBuf,
    pub agent_definition: PathBuf,
    preferences_path: PathBuf,
    pub preferences: Mutex<Preferences>,
    pub agents: Mutex<Vec<Agent>>,
    pub activations: Mutex<ActivationQueue>,
    cached: Mutex<Snapshot>,
    busy: AtomicBool,
    active: Mutex<Option<ActiveControl>>,
    cancellations: Mutex<VecDeque<(String, Instant)>>,
    policy_revision: AtomicU64,
    idle: Mutex<Option<HelperProcess>>,
}

impl WindowsAiRuntime {
    pub fn new(data: &Path, resources: &Path) -> Self {
        let staged =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/windows-ai/lumen-windows-ai.exe");
        let packaged = resources.join("windows-ai/lumen-windows-ai.exe");
        let helper = if packaged.is_file() || !cfg!(debug_assertions) {
            packaged
        } else {
            staged
        };
        let packaged_definition = resources.join("Assets/agentRegistration.json");
        let agent_definition = if packaged_definition.is_file() || !cfg!(debug_assertions) {
            packaged_definition
        } else {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../packaging/windows/Assets/agentRegistration.json")
        };
        let preferences_path = data.join("windows-ai-preferences.json");
        let preferences = Preferences::load(&preferences_path);
        let cached = Snapshot::fallback(preferences.clone(), "helper-not-staged");
        Self {
            helper,
            agent_definition,
            preferences_path,
            preferences: Mutex::new(preferences),
            agents: Mutex::new(Vec::new()),
            activations: Mutex::new(ActivationQueue::default()),
            cached: Mutex::new(cached),
            busy: AtomicBool::new(false),
            active: Mutex::new(None),
            cancellations: Mutex::new(VecDeque::new()),
            policy_revision: AtomicU64::new(0),
            idle: Mutex::new(None),
        }
    }

    pub fn preferences(&self) -> Preferences {
        self.preferences
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn update_preferences(&self, patch: Value) -> Result<Preferences, String> {
        let mut preferences = self
            .preferences
            .lock()
            .map_err(|_| "Windows AI preferences are unavailable".to_owned())?;
        let updated = preferences.patch(patch)?;
        updated.persist(&self.preferences_path)?;
        *preferences = updated.clone();
        drop(preferences);
        // Any policy change revokes already dispatched work; a subsequent operation
        // always takes a fresh native snapshot. No stale queued work survives.
        self.cancel_active(None)?;
        if !updated.keep_warm || !updated.windows_enabled {
            self.idle
                .lock()
                .map_err(|_| "Windows AI helper is unavailable".to_owned())?
                .take();
        }
        if !updated.agents_enabled {
            self.agents
                .lock()
                .map_err(|_| "Windows agent catalogue is unavailable".to_owned())?
                .clear();
        }
        Ok(updated)
    }

    pub fn cancel_active(&self, request_id: Option<&str>) -> Result<(), String> {
        if let Some(id) = request_id {
            protocol::validate_request_id(id)?;
        } else {
            self.policy_revision.fetch_add(1, Ordering::SeqCst);
        }
        let active = self
            .active
            .lock()
            .map_err(|_| "Windows AI cancellation is unavailable".to_owned())?;
        if let Some(id) = request_id {
            // Cancellation can arrive before a blocking command has read its
            // context or started the helper. Retain bounded request tombstones.
            let mut cancellations = self
                .cancellations
                .lock()
                .map_err(|_| "Windows AI cancellation is unavailable".to_owned())?;
            cancellations
                .retain(|(request, at)| request != id && at.elapsed() < Duration::from_secs(180));
            cancellations.push_back((id.to_owned(), Instant::now()));
            while cancellations.len() > 128 {
                cancellations.pop_front();
            }
        }
        if let Some(active) = active
            .as_ref()
            .filter(|active| request_id.is_none_or(|id| active.request_id == id))
        {
            active.cancelled.store(true, Ordering::SeqCst);
            if !active.dispatched {
                return Ok(());
            }
            let bytes = serialize_request(
                "cancel-control",
                "cancel",
                json!({"requestId":active.request_id}),
            )?;
            let _ = active.input.try_send(bytes);
        }
        Ok(())
    }

    fn was_cancelled(&self, request_id: &str) -> bool {
        let mut cancellations = self.cancellations.lock().unwrap_or_else(|e| e.into_inner());
        cancellations.retain(|(_, at)| at.elapsed() < Duration::from_secs(180));
        cancellations.iter().any(|(id, _)| id == request_id)
    }

    pub fn snapshot(&self) -> Snapshot {
        let preferences = self.preferences();
        let data = self.call(
            "status",
            "status",
            "status",
            json!({}),
            Duration::from_secs(20),
            None,
            None,
        );
        let mut snapshot = match data {
            Ok(data) => serde_json::from_value::<Snapshot>(data)
                .ok()
                .filter(|s| s.validate().is_ok())
                .unwrap_or_else(|| {
                    Snapshot::fallback(preferences.clone(), "invalid-helper-status")
                }),
            Err(_) if self.busy.load(Ordering::SeqCst) => self
                .cached
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            Err(_) => Snapshot::fallback(
                preferences.clone(),
                if self.helper.is_file() {
                    "helper-probe-failed"
                } else {
                    "helper-not-staged"
                },
            ),
        };
        snapshot.authoritative(
            self.preferences(),
            self.agents
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        );
        *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = snapshot.clone();
        snapshot
    }

    // The fixed operation, gate, request, payload, and stream bounds are explicit
    // at every dispatch site; no generic process or provider API is exposed.
    #[allow(clippy::too_many_arguments)]
    pub fn call(
        &self,
        operation: &str,
        gate: &str,
        request_id: &str,
        payload: Value,
        deadline: Duration,
        channel: Option<&Channel<Event>>,
        feature: Option<&str>,
    ) -> Result<Value, String> {
        let policy_revision = self.policy_revision.load(Ordering::SeqCst);
        protocol::validate_request_id(request_id)?;
        if self.was_cancelled(request_id) {
            return Err("Windows AI operation cancelled".to_owned());
        }
        if ![
            "status",
            "prepare",
            "text",
            "image",
            "indexSync",
            "indexSearch",
            "indexDelete",
            "agents",
            "invokeAgent",
            "registerAgent",
            "unregisterAgent",
        ]
        .contains(&operation)
        {
            return Err("Unknown Windows AI operation".to_owned());
        }
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "Another Windows AI operation is active".to_owned())?;
        let _guard = RequestGuard(self);
        let cancelled = Arc::new(AtomicBool::new(false));
        let helper = self
            .idle
            .lock()
            .map_err(|_| "Windows AI helper is unavailable".to_owned())?
            .take()
            .filter(HelperProcess::alive)
            .map_or_else(|| HelperProcess::start(&self.helper), Ok)?;
        *self
            .active
            .lock()
            .map_err(|_| "Windows AI helper is unavailable".to_owned())? = Some(ActiveControl {
            request_id: request_id.to_owned(),
            cancelled: cancelled.clone(),
            input: helper.input.clone(),
            dispatched: false,
        });
        let result = (|| {
            let preferences = self
                .preferences
                .lock()
                .map_err(|_| "Windows AI preferences are unavailable".to_owned())?;
            preferences.gate(gate)?;
            if feature.is_some_and(|id| !preferences.feature_enabled(id)) {
                return Err("This Windows AI feature is disabled by native preferences".to_owned());
            }
            let mut payload = payload;
            let object = payload
                .as_object_mut()
                .ok_or_else(|| "Invalid Windows AI operation payload".to_owned())?;
            object.insert(
                "preferences".to_owned(),
                serde_json::to_value(&*preferences)
                    .map_err(|_| "Windows AI preferences are unavailable".to_owned())?,
            );
            if matches!(operation, "status" | "prepare" | "text" | "image")
                && let Some(token) = super::credentials::get()
            {
                object.insert("accessToken".to_owned(), Value::String(token.to_string()));
            }
            let bytes = serialize_request(request_id, operation, payload);
            let bytes = bytes?;
            let mut active = self
                .active
                .lock()
                .map_err(|_| "Windows AI cancellation is unavailable".to_owned())?;
            if cancelled.load(Ordering::SeqCst)
                || self.was_cancelled(request_id)
                || self.policy_revision.load(Ordering::SeqCst) != policy_revision
            {
                return Err("Windows AI operation cancelled".to_owned());
            }
            helper
                .input
                .try_send(bytes)
                .map_err(|_| "The Windows AI request queue is full or unavailable".to_owned())?;
            if let Some(control) = active.as_mut() {
                control.dispatched = true;
            }
            drop(active);
            drop(preferences);
            let started = Instant::now();
            let mut cancellation_started = None;
            let mut output_bytes = 0usize;
            let mut delta_bytes = 0usize;
            let mut messages = 0usize;
            loop {
                if cancelled.load(Ordering::SeqCst) {
                    let cancelled_at = cancellation_started.get_or_insert_with(Instant::now);
                    if cancelled_at.elapsed() >= Duration::from_secs(2) {
                        return Err("Windows AI operation cancelled".to_owned());
                    }
                }
                if started.elapsed() >= deadline {
                    return Err("Windows AI operation exceeded its deadline".to_owned());
                }
                let line = match helper.output.recv_timeout(Duration::from_millis(50)) {
                    Ok(line) => line?,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(_) => {
                        return Err("The Windows AI helper response is unavailable".to_owned());
                    }
                };
                output_bytes = output_bytes.saturating_add(line.len());
                messages += 1;
                if output_bytes > 8 * 1024 * 1024 || messages > 4096 {
                    return Err("Windows AI output exceeds its response limit".to_owned());
                }
                if cancelled.load(Ordering::SeqCst) {
                    if serde_json::from_slice::<Value>(&line)
                        .ok()
                        .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_owned))
                        .as_deref()
                        == Some("cancel-control")
                    {
                        continue;
                    }
                    return Err("Windows AI operation cancelled".to_owned());
                }
                match protocol::parse_envelope(&line, request_id)? {
                    Envelope::Result { data, .. } => return Ok(data),
                    Envelope::Error { code, .. } => return Err(safe_failure(&code).to_owned()),
                    Envelope::Delta { text, .. } => {
                        delta_bytes = delta_bytes.saturating_add(text.len());
                        if delta_bytes > protocol::MAX_TEXT {
                            return Err("Windows AI response text exceeds its limit".to_owned());
                        }
                        if let Some(channel) = channel {
                            channel
                                .send(Event::Delta {
                                    request_id: request_id.to_owned(),
                                    text,
                                })
                                .map_err(|_| "Windows AI event receiver disconnected".to_owned())?;
                        }
                    }
                    Envelope::Progress {
                        phase, progress, ..
                    } => {
                        if let Some(channel) = channel {
                            channel
                                .send(Event::Progress {
                                    request_id: request_id.to_owned(),
                                    phase,
                                    progress,
                                })
                                .map_err(|_| "Windows AI event receiver disconnected".to_owned())?;
                        }
                    }
                }
            }
        })();
        self.active.lock().unwrap_or_else(|e| e.into_inner()).take();
        if result.is_ok() && !cancelled.load(Ordering::SeqCst) && self.preferences().keep_warm {
            *self.idle.lock().unwrap_or_else(|e| e.into_inner()) = Some(helper);
        }
        result
    }
}

struct RequestGuard<'a>(&'a WindowsAiRuntime);
impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        self.0
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        self.0.busy.store(false, Ordering::SeqCst);
    }
}

fn serialize_request(
    id: &str,
    operation: &str,
    payload: Value,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut request = serde_json::Map::new();
    request.insert("id".to_owned(), Value::String(id.to_owned()));
    request.insert("operation".to_owned(), Value::String(operation.to_owned()));
    request.insert("payload".to_owned(), payload);
    let bytes = serde_json::to_vec(&request)
        .map_err(|_| "Windows AI request could not be encoded".to_owned());
    if let Some(Value::String(mut token)) = request
        .get_mut("payload")
        .and_then(Value::as_object_mut)
        .and_then(|v| v.remove("accessToken"))
    {
        token.zeroize();
    }
    let mut bytes = Zeroizing::new(bytes?);
    if bytes.len() + 1 > protocol::MAX_INPUT {
        return Err("Windows AI request exceeds its input limit".to_owned());
    }
    bytes.push(b'\n');
    Ok(bytes)
}

fn safe_failure(code: &str) -> &'static str {
    match code {
        "identity_required" | "identity-required" | "identityRequired" => {
            "Windows AI requires a registered package identity"
        }
        "access_required" | "access-required" | "accessRequired" => {
            "The Windows AI model requires a configured, valid access token"
        }
        "model_not_ready" | "model-not-ready" | "download-required" => {
            "The Windows AI model is not ready; prepare it with download consent first"
        }
        "cancelled" => "Windows AI operation cancelled",
        "odr_unavailable" | "odr-unavailable" => {
            "The Windows agent registry is unavailable on this host"
        }
        "runtime_required" => "The required Windows AI runtime is not installed",
        "index_missing" => "Build Lumen's public help index before using semantic search",
        "unsupported" | "api-unavailable" => "This Windows AI API is unavailable on this host",
        "blocked_by_policy" | "permission-denied" | "disabled" => {
            "This Windows AI operation is disabled by native preferences"
        }
        _ => "The Windows AI operation failed; refresh native availability for details",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_preference_write_never_enables_in_memory_policy() {
        let fixture = crate::search::test_support::SearchFixture::new("windows-ai-preferences");
        let runtime = WindowsAiRuntime::new(&fixture.root().join("missing"), fixture.root());
        assert!(
            runtime
                .update_preferences(json!({"windowsEnabled":true}))
                .is_err()
        );
        assert!(!runtime.preferences().windows_enabled);
    }

    #[test]
    fn busy_dispatch_is_bounded_and_rejects_work_instead_of_queueing_it() {
        let fixture = crate::search::test_support::SearchFixture::new("windows-ai-busy");
        let runtime = WindowsAiRuntime::new(fixture.root(), fixture.root());
        runtime.busy.store(true, Ordering::SeqCst);
        let error = runtime
            .call(
                "status",
                "status",
                "busy-request",
                json!({}),
                Duration::from_secs(1),
                None,
                None,
            )
            .unwrap_err();
        assert_eq!(error, "Another Windows AI operation is active");
    }

    #[test]
    fn cancellation_only_targets_the_current_native_request() {
        let fixture = crate::search::test_support::SearchFixture::new("windows-ai-cancel");
        let runtime = WindowsAiRuntime::new(fixture.root(), fixture.root());
        let cancelled = Arc::new(AtomicBool::new(false));
        let (input, receiver) = mpsc::sync_channel(2);
        *runtime.active.lock().unwrap() = Some(ActiveControl {
            request_id: "current".to_owned(),
            cancelled: cancelled.clone(),
            input,
            dispatched: true,
        });
        runtime.cancel_active(Some("stale")).unwrap();
        assert!(!cancelled.load(Ordering::SeqCst));
        runtime.cancel_active(Some("current")).unwrap();
        assert!(cancelled.load(Ordering::SeqCst));
        let bytes = receiver.try_recv().unwrap();
        let control: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(control["payload"]["requestId"], "current");
        assert_eq!(control["operation"], "cancel");
    }

    #[test]
    fn cancellation_before_dispatch_never_overtakes_the_original_request() {
        let fixture =
            crate::search::test_support::SearchFixture::new("windows-ai-cancel-before-dispatch");
        let runtime = WindowsAiRuntime::new(fixture.root(), fixture.root());
        let cancelled = Arc::new(AtomicBool::new(false));
        let (input, receiver) = mpsc::sync_channel(2);
        *runtime.active.lock().unwrap() = Some(ActiveControl {
            request_id: "current".to_owned(),
            cancelled: cancelled.clone(),
            input,
            dispatched: false,
        });
        runtime.cancel_active(Some("current")).unwrap();
        assert!(cancelled.load(Ordering::SeqCst));
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn cancellation_before_helper_start_prevents_dispatch_and_is_bounded() {
        let fixture = crate::search::test_support::SearchFixture::new("windows-ai-early-cancel");
        let mut runtime = WindowsAiRuntime::new(fixture.root(), fixture.root());
        runtime.helper = fixture.root().join("missing-helper.exe");
        runtime.cancel_active(Some("early-request")).unwrap();
        assert_eq!(
            runtime
                .call(
                    "status",
                    "status",
                    "early-request",
                    json!({}),
                    Duration::from_secs(1),
                    None,
                    None
                )
                .unwrap_err(),
            "Windows AI operation cancelled"
        );
        assert!(!runtime.busy.load(Ordering::SeqCst));
        for number in 0..140 {
            runtime
                .cancel_active(Some(&format!("cancel-{number}")))
                .unwrap();
        }
        assert_eq!(runtime.cancellations.lock().unwrap().len(), 128);
        assert!(runtime.was_cancelled("cancel-139"));
        assert!(!runtime.was_cancelled("cancel-0"));
    }

    #[test]
    fn helper_absence_is_truthful_and_cannot_mark_a_feature_ready() {
        let fixture = crate::search::test_support::SearchFixture::new("windows-ai-missing");
        let mut runtime = WindowsAiRuntime::new(fixture.root(), fixture.root());
        runtime.helper = fixture.root().join("missing-helper.exe");
        let snapshot = runtime.snapshot();
        assert!(snapshot.features.iter().all(|f| f.availability != "ready"));
        assert!(snapshot.features.iter().all(|f| !f.enabled));
        assert!(
            snapshot
                .features
                .iter()
                .all(|f| f.reason_code == "helper-not-staged")
        );
    }

    #[test]
    #[ignore = "Requires the real staged Windows AI helper; run explicitly after staging"]
    fn real_staged_helper_status_probe() {
        let fixture = crate::search::test_support::SearchFixture::new("windows-ai-real-probe");
        let runtime = WindowsAiRuntime::new(fixture.root(), fixture.root());
        assert!(runtime.helper.is_file());
        let snapshot = runtime.snapshot();
        snapshot.validate().unwrap();
        assert!(!snapshot.features.iter().any(|f| {
            [
                "helper-not-staged",
                "invalid-helper-status",
                "helper-probe-failed",
            ]
            .contains(&f.reason_code.as_str())
        }));
        assert!(snapshot.features.iter().all(|f| !f.enabled));
        println!("{}", serde_json::to_string(&snapshot).unwrap());
    }
}
