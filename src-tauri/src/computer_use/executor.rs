use super::{protocol::*, windows::WindowIdentity};
use std::{
    env,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command as ProcessCommand, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub enum Executable {
    Binary(PathBuf),
    Python { binary: PathBuf, script: PathBuf },
    Missing,
}
impl Executable {
    pub fn detect(packaged: PathBuf, staged: PathBuf, source: PathBuf) -> Self {
        if packaged.is_file() {
            return Self::Binary(packaged);
        }
        if staged.is_file() {
            return Self::Binary(staged);
        }
        let python = source
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join(".venv/Scripts/python.exe");
        if source.is_file() && python.is_file() {
            Self::Python {
                binary: python,
                script: source,
            }
        } else {
            Self::Missing
        }
    }
    pub fn mode(&self) -> &'static str {
        match self {
            Self::Binary(_) => "packaged",
            Self::Python { .. } => "python",
            Self::Missing => "missing",
        }
    }
    fn command(&self) -> Result<ProcessCommand, String> {
        let mut command = match self {
            Self::Binary(path) => ProcessCommand::new(path),
            Self::Python { binary, script } => {
                let mut command = ProcessCommand::new(binary);
                command.arg(script);
                command
            }
            Self::Missing => return Err("Computer Use executor is not staged".to_owned()),
        };
        // Credential-bearing environment variables never cross the executor boundary.
        command.env_clear();
        for name in [
            "PATH",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "LOCALAPPDATA",
            "APPDATA",
            "PROGRAMFILES",
            "PROGRAMFILES(X86)",
            "PROGRAMDATA",
            "PATHEXT",
            "COMSPEC",
            "PROCESSOR_ARCHITECTURE",
            "NUMBER_OF_PROCESSORS",
        ] {
            if let Some(value) = env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        Ok(command)
    }
    pub fn health(&self) -> Result<WorkerHealth, String> {
        let mut command = self.command()?;
        command.arg("--health").stdin(Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|_| "Executor health could not start")?;
        let job = match Job::assign(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let stdout = child.stdout.take().ok_or("Executor health has no output")?;
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = BufReader::new(stdout)
                .take(8193)
                .read_until(b'\n', &mut bytes)
                .map_err(|_| "Executor health failed".to_owned())
                .and_then(|_| {
                    if bytes.len() > 8192 {
                        Err("Invalid executor health".to_owned())
                    } else {
                        serde_json::from_slice(&bytes)
                            .map_err(|_| "Invalid executor health".to_owned())
                    }
                });
            let _ = sender.send(result);
        });
        let result = receiver
            .recv_timeout(Duration::from_secs(12))
            .map_err(|_| "Executor health timed out".to_owned())
            .and_then(|r| r);
        job.terminate();
        let _ = child.wait();
        result
    }
}

pub struct Job {
    #[cfg(windows)]
    handle: isize,
}
impl Job {
    pub(super) fn assign(child: &Child) -> Result<Arc<Self>, String> {
        #[cfg(windows)]
        {
            let handle = crate::gateway::supervisor::assign_kill_on_close_job(child)?;
            Ok(Arc::new(Self {
                handle: handle.0 as isize,
            }))
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Err("Windows 11 is required".to_owned())
        }
    }
    pub fn terminate(&self) {
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(
                windows::Win32::Foundation::HANDLE(self.handle as *mut _),
                1,
            );
        }
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        self.terminate();
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                self.handle as *mut _,
            ));
        }
    }
}

pub struct Worker {
    stdin: Mutex<ChildStdin>,
    responses: Mutex<std::sync::mpsc::Receiver<Result<Response, String>>>,
    child: Mutex<Child>,
    pub job: Arc<Job>,
    sequence: AtomicU64,
    pub manifest_path: Option<PathBuf>,
}
impl Worker {
    fn spawn(executable: &Executable, manifest_path: Option<PathBuf>) -> Result<Arc<Self>, String> {
        let mut command = executable.command()?;
        command.arg("--executor");
        let mut child = command.spawn().map_err(|_| "Executor could not start")?;
        let job = match Job::assign(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let stdin = child.stdin.take().ok_or("Executor has no input")?;
        let stdout = child.stdout.take().ok_or("Executor has no output")?;
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                match (&mut reader)
                    .take((MAX_LINE + 1) as u64)
                    .read_until(b'\n', &mut bytes)
                {
                    Ok(0) => break,
                    Ok(_) if bytes.len() <= MAX_LINE && bytes.last() == Some(&b'\n') => {
                        let response = serde_json::from_slice::<Response>(&bytes)
                            .map_err(|_| "invalid_worker_message".to_owned());
                        let bad = response.is_err();
                        if sender.send(response).is_err() || bad {
                            break;
                        }
                    }
                    _ => {
                        let _ = sender.send(Err("invalid_worker_message".to_owned()));
                        break;
                    }
                }
            }
        });
        Ok(Arc::new(Self {
            stdin: Mutex::new(stdin),
            responses: Mutex::new(receiver),
            child: Mutex::new(child),
            job,
            sequence: AtomicU64::new(1),
            manifest_path,
        }))
    }
    pub async fn rpc(
        self: &Arc<Self>,
        run_id: &str,
        generation: u64,
        operation: Operation,
        cancel: &CancellationToken,
    ) -> Result<Response, String> {
        let worker = Arc::clone(self);
        let id = self.sequence.fetch_add(1, Ordering::AcqRel);
        let run_id = run_id.to_owned();
        let expected_run = run_id.clone();
        let command = Command {
            id,
            run_id,
            generation,
            operation,
        };
        let token = cancel.clone();
        let rpc = tauri::async_runtime::spawn_blocking(move || {
            if token.is_cancelled() {
                return Err("stopped".to_owned());
            }
            let mut stdin = worker
                .stdin
                .lock()
                .map_err(|_| "executor_input_unavailable")?;
            if token.is_cancelled() {
                return Err("stopped".to_owned());
            }
            serde_json::to_writer(&mut *stdin, &command)
                .map_err(|_| "executor_input_unavailable")?;
            stdin
                .write_all(b"\n")
                .and_then(|_| stdin.flush())
                .map_err(|_| "executor_input_unavailable")?;
            drop(stdin);
            let response = worker
                .responses
                .lock()
                .map_err(|_| "executor_output_unavailable")?
                .recv_timeout(Duration::from_secs(30))
                .map_err(|_| "executor_timeout")??;
            if token.is_cancelled() {
                return Err("stopped".to_owned());
            }
            if response.id != id
                || response.run_id != expected_run
                || response.generation != generation
                || response.ok == response.error.is_some()
            {
                return Err("invalid_worker_identity".to_owned());
            }
            if let Some(observation) = &response.observation {
                super::policy::validate_observation(observation)?;
            }
            if let Some(result) = &response.result
                && (result.verified != (result.effect == Effect::Confirmed)
                    || result.detail.as_ref().is_some_and(|v| v.len() > 240))
            {
                return Err("invalid_worker_result".to_owned());
            }
            if let Some(error) = &response.error
                && (![
                    "backgroundUnavailable",
                    "staleSnapshot",
                    "targetUnavailable",
                    "invalidAction",
                    "observationUnavailable",
                    "workerError",
                ]
                .contains(&error.code.as_str())
                    || error.message.len() > 240)
            {
                return Err("invalid_worker_error".to_owned());
            }
            Ok(response)
        });
        tokio::select! {
            _=cancel.cancelled()=>{self.job.terminate(); Err("stopped".to_owned())},
            _=tokio::time::sleep(Duration::from_secs(30))=>{self.job.terminate(); Err("executor_timeout".to_owned())},
            result=rpc=>result.map_err(|_|"executor_join_failed".to_owned())?,
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.job.terminate();
        if let Ok(child) = self.child.get_mut() {
            let _ = child.wait();
        }
        if let Some(path) = &self.manifest_path {
            let _ = std::fs::remove_file(path);
        }
    }
}

struct Warm {
    scope: String,
    worker: Arc<Worker>,
    idle: Instant,
}
pub struct ExecutorPool {
    executable: Executable,
    directory: PathBuf,
    warm: Mutex<Option<Warm>>,
    epoch: AtomicU64,
}
impl ExecutorPool {
    pub fn new(executable: Executable, directory: PathBuf) -> Arc<Self> {
        let pool = Arc::new(Self {
            executable,
            directory,
            warm: Mutex::new(None),
            epoch: AtomicU64::new(1),
        });
        let weak = Arc::downgrade(&pool);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(5));
                let Some(pool) = weak.upgrade() else {
                    break;
                };
                let expired = pool.warm.lock().ok().and_then(|mut warm| {
                    if warm
                        .as_ref()
                        .is_some_and(|w| w.idle.elapsed() >= Duration::from_secs(120))
                    {
                        warm.take()
                    } else {
                        None
                    }
                });
                drop(expired);
            }
        });
        pool
    }
    pub fn mode(&self) -> &'static str {
        self.executable.mode()
    }
    pub fn health(&self) -> Result<WorkerHealth, String> {
        self.executable.health()
    }
    pub fn discard(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
        let previous = self.warm.lock().ok().and_then(|mut w| w.take());
        if let Some(previous) = previous {
            previous.worker.job.terminate();
        }
    }
    pub fn check_consent(&self, consent: &crate::consent::PersistedConsent) {
        let revoked = self.warm.lock().ok().and_then(|mut warm| {
            let allowed = warm.as_ref().is_none_or(|w| {
                if w.scope.starts_with("browser:") {
                    consent.computer_use_granted()
                } else {
                    consent.desktop_control_granted() && consent.desktop_cloud_granted()
                }
            });
            if allowed { None } else { warm.take() }
        });
        if let Some(revoked) = revoked {
            self.epoch.fetch_add(1, Ordering::AcqRel);
            revoked.worker.job.terminate();
        }
    }
    pub fn acquire(
        &self,
        scope: &str,
        target: Option<&WindowIdentity>,
    ) -> Result<Arc<Worker>, String> {
        let previous = self
            .warm
            .lock()
            .map_err(|_| "executor_state_unavailable")?
            .take();
        if let Some(previous) = previous {
            if previous.scope == scope && previous.idle.elapsed() < Duration::from_secs(120) {
                return Ok(previous.worker);
            }
            previous.worker.job.terminate();
        }
        let manifest_path = if let Some(target) = target {
            std::fs::create_dir_all(&self.directory).map_err(|_| "executor_scope_unavailable")?;
            let path = self
                .directory
                .join(format!("{}.json", uuid::Uuid::new_v4()));
            let manifest = serde_json::json!({"version":3,"expires_after":"10m","idle_timeout":"2m","allow":{"tools":["get_window_state","click","set_value","scroll","end_session"]},"resources":{"apps":[{"executable":target.executable,"launch":false,"windows":"all","terminate":"driver_launched"}],"desktop":{"display":false}}});
            std::fs::write(
                &path,
                serde_json::to_vec(&manifest).map_err(|_| "invalid_executor_scope")?,
            )
            .map_err(|_| "executor_scope_unavailable")?;
            Some(path)
        } else {
            None
        };
        Worker::spawn(&self.executable, manifest_path)
    }
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }
    pub fn release(&self, scope: String, worker: Arc<Worker>, epoch: u64) {
        if let Ok(mut warm) = self.warm.lock() {
            if self.epoch() != epoch {
                drop(warm);
                worker.job.terminate();
                return;
            }
            let previous = warm.replace(Warm {
                scope,
                worker,
                idle: Instant::now(),
            });
            drop(warm);
            drop(previous);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_untyped_or_unknown_worker_messages() {
        assert!(serde_json::from_value::<Response>(serde_json::json!({"id":1,"runId":"x","generation":1,"ok":true,"event":"do_anything"})).is_err());
    }
    #[test]
    fn missing_executor_never_uses_a_path_supplied_by_the_caller() {
        let missing = Executable::detect(
            "missing.exe".into(),
            "missing-staged.exe".into(),
            "missing.py".into(),
        );
        assert_eq!(missing.mode(), "missing");
        assert!(missing.command().is_err());
    }
    #[test]
    #[cfg(windows)]
    #[ignore = "installed Edge and staged executor acceptance; run separately"]
    fn rust_executor_wire_and_warm_pool_verify_real_edge_state() {
        use std::net::TcpListener;
        use std::sync::atomic::AtomicBool;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let done = Arc::new(AtomicBool::new(false));
        let finished = Arc::clone(&done);
        let server = std::thread::spawn(move || {
            while !finished.load(Ordering::Acquire) {
                if let Ok((mut stream, _)) = listener.accept() {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut request = [0u8; 4096];
                    let _ = stream.read(&mut request);
                    let html = "<!doctype html><title>Local fixture</title><label for='name'>Name</label><input id='name' autocomplete='off'>";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                        html.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                } else {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        });
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let executable = Executable::Binary(
            root.join("src-tauri/binaries/lumen-computer-use-x86_64-pc-windows-msvc.exe"),
        );
        let pool = ExecutorPool::new(
            executable,
            root.join("workers/computer-use-preview/.build/rust-wire"),
        );
        tauri::async_runtime::block_on(async {
            let scope = "browser:gemini";
            let epoch = pool.epoch();
            let worker = pool.acquire(scope, None).unwrap();
            let cancel = CancellationToken::new();
            for iteration in 0..2 {
                let run = uuid::Uuid::new_v4().to_string();
                let begin = worker
                    .rpc(
                        &run,
                        1,
                        Operation::Begin {
                            target: WorkerTarget::Browser {
                                initial_url: format!("http://{address}"),
                                headless: true,
                            },
                            manifest_path: None,
                        },
                        &cancel,
                    )
                    .await
                    .unwrap();
                assert!(begin.ok);
                let before = worker
                    .rpc(&run, 1, Operation::Observe { screenshot: false }, &cancel)
                    .await
                    .unwrap()
                    .observation
                    .unwrap();
                let element = before.elements.iter().find(|e| e.name == "Name").unwrap();
                assert_eq!(
                    element.value.as_deref(),
                    Some(""),
                    "Every begin must use a fresh browser context"
                );
                let action: Action = serde_json::from_value(serde_json::json!({"kind":"setValue","element":element.reference,"text":"Local fixture value"})).unwrap();
                let after = worker
                    .rpc(
                        &run,
                        1,
                        Operation::Act {
                            snapshot_id: before.snapshot_id,
                            action,
                        },
                        &cancel,
                    )
                    .await
                    .unwrap();
                assert!(after.ok);
                assert!(after.result.unwrap().verified);
                let observed = after.observation.unwrap();
                assert!(observed.screenshot.is_none());
                assert!(
                    observed
                        .elements
                        .iter()
                        .any(|e| e.name == "Name"
                            && e.value.as_deref() == Some("Local fixture value"))
                );
                assert!(
                    worker
                        .rpc(&run, 1, Operation::End, &cancel)
                        .await
                        .unwrap()
                        .ok
                );
                if iteration == 0 {
                    pool.release(scope.to_owned(), Arc::clone(&worker), epoch);
                    let reused = pool.acquire(scope, None).unwrap();
                    assert!(
                        Arc::ptr_eq(&worker, &reused),
                        "Scope-identical ended executor should stay warm"
                    );
                }
            }
            // A late completed run cannot cache its executor after native Stop.
            pool.discard();
            pool.release(scope.to_owned(), Arc::clone(&worker), epoch);
            assert!(pool.warm.lock().unwrap().is_none());
            let began = Instant::now();
            while worker.child.lock().unwrap().try_wait().unwrap().is_none() {
                assert!(began.elapsed() < Duration::from_secs(1));
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });
        done.store(true, Ordering::Release);
        server.join().unwrap();
    }
}
