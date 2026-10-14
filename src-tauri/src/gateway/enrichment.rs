use std::{
    fs,
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::{Serialize, de::DeserializeOwned};
use tauri::State;

use crate::{local_http, search::EnrichmentJobRecord};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichmentHealth {
    pub state: &'static str,
    pub paused: bool,
    pub control_port: u16,
    pub actor_port: u16,
    pub detail: Option<String>,
}

struct ManagedProcess {
    child: Child,
    #[cfg(windows)]
    job: isize,
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                self.job as *mut _,
            ));
        }
    }
}

struct EnrichmentProcesses {
    worker: ManagedProcess,
    engine: ManagedProcess,
}

impl EnrichmentProcesses {
    fn is_running(&mut self) -> bool {
        self.worker.child.try_wait().ok() == Some(None)
            && self.engine.child.try_wait().ok() == Some(None)
    }
}

pub struct EnrichmentSupervisor {
    binary: PathBuf,
    engine_binary: PathBuf,
    runtime_directory: PathBuf,
    control_port: u16,
    actor_port: u16,
    engine_port: u16,
    bearer: String,
    user_paused: AtomicBool,
    activity_paused: AtomicBool,
    ready: AtomicBool,
    process_generation: AtomicU64,
    process: Mutex<Option<EnrichmentProcesses>>,
    detail: Mutex<Option<String>>,
}

fn free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .map_err(|error| error.to_string())?
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| error.to_string())
}

fn owned_command(binary: &std::path::Path) -> Command {
    let mut command = Command::new(binary);
    command.env_clear();
    for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
}

impl EnrichmentSupervisor {
    fn engine_config(&self, engine_db: &std::path::Path) -> serde_json::Value {
        serde_json::json!({
            "auth":{"admin_token":self.bearer},
            "guard":{"host":"127.0.0.1","port":self.engine_port},
            "api_peer":{"host":"127.0.0.1","port":self.engine_port + 1},
            "metrics":{"host":"127.0.0.1","port":self.engine_port + 10},
            "topology":{"datacenter_label":1,"datacenters":{"default":{
                "datacenter_label":1,"is_leader":true,
                "public_url":format!("http://127.0.0.1:{}",self.engine_port),
                "peer_url":format!("http://127.0.0.1:{}",self.engine_port + 1)
            }}},
            "file_system":{"path":engine_db},"telemetry":{"enabled":false}
        })
    }

    pub fn new(
        binary: PathBuf,
        engine_binary: PathBuf,
        runtime_directory: PathBuf,
    ) -> Result<Self, String> {
        fs::create_dir_all(&runtime_directory).map_err(|error| error.to_string())?;
        Ok(Self {
            binary,
            engine_binary,
            runtime_directory,
            control_port: free_port()?,
            actor_port: free_port()?,
            engine_port: free_port()?,
            bearer: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            user_paused: AtomicBool::new(false),
            activity_paused: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            process_generation: AtomicU64::new(0),
            process: Mutex::new(None),
            detail: Mutex::new(None),
        })
    }

    pub fn start(&self) -> Result<(), String> {
        let result = self.start_inner();
        if let Err(error) = &result {
            *self
                .detail
                .lock()
                .unwrap_or_else(|value| value.into_inner()) = Some(error.clone());
        }
        result
    }

    fn start_inner(&self) -> Result<(), String> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| "Worker state is poisoned")?;
        if process
            .as_mut()
            .is_some_and(EnrichmentProcesses::is_running)
        {
            return Ok(());
        }
        self.process_generation.fetch_add(1, Ordering::SeqCst);
        let previous = process.take();
        self.ready.store(false, Ordering::SeqCst);
        if !self.binary.is_file() {
            let message = "Rivet enrichment worker is not staged".to_owned();
            *self
                .detail
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(message.clone());
            return Err(message);
        }
        if !self.engine_binary.is_file() {
            return Err("Rivet engine sidecar is not staged".to_owned());
        }
        let mut engine = match previous {
            Some(mut previous) => {
                if previous
                    .engine
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_none()
                {
                    drop(previous.worker);
                    previous.engine
                } else {
                    drop(previous);
                    self.start_engine()?
                }
            }
            _ => self.start_engine()?,
        };
        self.wait_engine_listening(&mut engine)?;

        let mut command = owned_command(&self.binary);
        let log_path = self.runtime_directory.join("rivet-worker.log");
        let log = fs::File::create(&log_path).map_err(|error| error.to_string())?;
        let error_log = log.try_clone().map_err(|error| error.to_string())?;
        command
            .current_dir(&self.runtime_directory)
            .env("LUMEN_WORKER_CONTROL_PORT", self.control_port.to_string())
            .env("LUMEN_RIVET_PORT", self.actor_port.to_string())
            .env("LUMEN_RIVET_ENGINE_PORT", self.engine_port.to_string())
            .env("LUMEN_WORKER_BEARER", &self.bearer)
            .env("RIVET_PORT", self.actor_port.to_string())
            .env("RIVETKIT_RUNTIME", "wasm")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(error_log));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("Could not start the Rivet worker: {error}"))?;
        #[cfg(windows)]
        let job = super::supervisor::assign_kill_on_close_job(&child)?;
        *process = Some(EnrichmentProcesses {
            worker: ManagedProcess {
                child,
                #[cfg(windows)]
                job: job.0 as isize,
            },
            engine,
        });
        *self
            .detail
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        Ok(())
    }

    fn start_engine(&self) -> Result<ManagedProcess, String> {
        let engine_log_path = self.runtime_directory.join("rivet-engine.log");
        let engine_log = fs::File::create(&engine_log_path).map_err(|error| error.to_string())?;
        let engine_error_log = engine_log.try_clone().map_err(|error| error.to_string())?;
        let engine_db = self.runtime_directory.join("rivet-engine-db");
        fs::create_dir_all(&engine_db).map_err(|error| error.to_string())?;
        let engine_config = self.runtime_directory.join("rivet-engine.json");
        fs::write(
            &engine_config,
            serde_json::to_vec(&self.engine_config(&engine_db))
                .map_err(|_| "Rivet configuration could not be serialized")?,
        )
        .map_err(|_| "Rivet configuration could not be saved")?;
        let mut engine_command = owned_command(&self.engine_binary);
        engine_command
            .arg("start")
            .arg("--except-services")
            .arg("api_peer")
            .env("RUST_LOG", "info")
            .arg("--config")
            .arg(&engine_config)
            .current_dir(&self.runtime_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::from(engine_log))
            .stderr(Stdio::from(engine_error_log));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            engine_command.creation_flags(0x0800_0000);
        }
        let engine_child = engine_command
            .spawn()
            .map_err(|error| format!("Could not start the Rivet engine: {error}"))?;
        #[cfg(windows)]
        let engine_job = super::supervisor::assign_kill_on_close_job(&engine_child)?;
        let engine = ManagedProcess {
            child: engine_child,
            #[cfg(windows)]
            job: engine_job.0 as isize,
        };

        Ok(engine)
    }

    fn wait_engine_listening(&self, engine: &mut ManagedProcess) -> Result<(), String> {
        let engine_log_path = self.runtime_directory.join("rivet-engine.log");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", self.engine_port)
                .parse()
                .map_err(|error| format!("Invalid Rivet engine address: {error}"))?,
            Duration::from_millis(100),
        )
        .is_err()
        {
            if let Some(status) = engine.child.try_wait().map_err(|error| error.to_string())? {
                return Err(format!(
                    "Rivet 2.3.10 Windows engine exited before readiness ({status})"
                ));
            }
            if std::time::Instant::now() >= deadline {
                return Err(fs::read_to_string(&engine_log_path)
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| "Rivet engine did not become ready".to_owned()));
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        Ok(())
    }

    async fn engine_is_ready(&self) -> bool {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct EngineReady {
            runtime: String,
            status: String,
            version: String,
        }
        let Ok(client) = local_http::client(Duration::from_secs(5)) else {
            return false;
        };
        let response: Result<EngineReady, _> = local_http::json(
            client
                .get(format!("http://127.0.0.1:{}/health", self.engine_port))
                .bearer_auth(&self.bearer),
        )
        .await;
        response.is_ok_and(|value| {
            value.runtime == "engine" && value.status == "ok" && value.version == "2.3.10"
        })
    }

    pub async fn restart(&self) -> Result<(), String> {
        let (generation, alive) = {
            let mut process = self
                .process
                .lock()
                .map_err(|_| "Worker state is poisoned")?;
            let alive = if let Some(process) = process.as_mut() {
                process
                    .engine
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_none()
            } else {
                false
            };
            (self.process_generation.load(Ordering::SeqCst), alive)
        };
        self.ready.store(false, Ordering::SeqCst);
        let healthy = alive && self.engine_is_ready().await;
        {
            let mut process = self
                .process
                .lock()
                .map_err(|_| "Worker state is poisoned")?;
            if self.process_generation.load(Ordering::SeqCst) != generation {
                return Err("Rivet runtime changed during restart; retry the request.".into());
            }
            self.process_generation.fetch_add(1, Ordering::SeqCst);
            if !healthy {
                *process = None;
            } else if let Some(process) = process.as_mut() {
                if process
                    .worker
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_none()
                {
                    process
                        .worker
                        .child
                        .kill()
                        .map_err(|error| error.to_string())?;
                }
                process
                    .worker
                    .child
                    .wait()
                    .map_err(|error| error.to_string())?;
            }
        }
        self.ready.store(false, Ordering::SeqCst);
        self.start()
    }

    fn endpoint(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.control_port)
    }

    fn record_readiness(&self, generation: u64, ready: bool) -> bool {
        let _guard = self
            .process
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if self.process_generation.load(Ordering::SeqCst) != generation {
            return false;
        }
        self.ready.store(ready, Ordering::SeqCst);
        true
    }

    pub async fn sync_jobs(&self, jobs: &[EnrichmentJobRecord]) -> bool {
        let generation = self.process_generation.load(Ordering::SeqCst);
        if self.is_paused() {
            return false;
        }
        let client = match local_http::client(Duration::from_secs(5)) {
            Ok(client) => client,
            Err(error) => {
                *self
                    .detail
                    .lock()
                    .unwrap_or_else(|value| value.into_inner()) =
                    Some(error.message("Rivet queue sync"));
                return false;
            }
        };
        for job in jobs {
            let response = local_http::response(
                client
                    .post(self.endpoint("/jobs"))
                    .bearer_auth(&self.bearer)
                    .json(job),
            )
            .await;
            if let Err(error) = response {
                self.record_readiness(generation, false);
                *self
                    .detail
                    .lock()
                    .unwrap_or_else(|value| value.into_inner()) =
                    Some(error.message("Rivet queue sync"));
                return false;
            }
            if !self.record_readiness(generation, true) {
                return false;
            }
        }
        true
    }

    pub async fn queue_status(&self) -> Result<serde_json::Value, String> {
        let generation = self.process_generation.load(Ordering::SeqCst);
        let client = local_http::client(Duration::from_secs(5))
            .map_err(|error| error.message("Enrichment queue"))?;
        let result = local_http::json(client.get(self.endpoint("/jobs")).bearer_auth(&self.bearer))
            .await
            .map_err(|error| error.message("Enrichment queue"));
        if !self.record_readiness(generation, result.is_ok()) {
            return Err("Enrichment runtime changed; retry the request.".into());
        }
        result
    }

    async fn verify_readiness(&self) {
        let generation = self.process_generation.load(Ordering::SeqCst);
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct WorkerReady {
            status: String,
        }
        let ready = async {
            let client = local_http::client(Duration::from_secs(5)).ok()?;
            let response: WorkerReady = local_http::json(
                client
                    .get(self.endpoint("/health"))
                    .bearer_auth(&self.bearer),
            )
            .await
            .ok()?;
            Some(response.status == "ready")
        }
        .await
            == Some(true);
        self.record_readiness(generation, ready);
    }

    pub(crate) async fn enrichment_request<T: DeserializeOwned>(
        &self,
        operation: &str,
        body: &serde_json::Value,
    ) -> Result<T, String> {
        let path = match operation {
            "lease" => "/jobs/lease",
            "heartbeat" => "/jobs/heartbeat",
            "finish" => "/jobs/finish",
            "retain" => "/jobs/retain",
            "failed" => "/jobs/failed",
            _ => return Err("Invalid enrichment queue operation.".into()),
        };
        let client = local_http::client(Duration::from_secs(5))
            .map_err(|e| e.message("Enrichment queue"))?;
        local_http::json(
            client
                .post(self.endpoint(path))
                .bearer_auth(&self.bearer)
                .json(body),
        )
        .await
        .map_err(|e| e.message("Enrichment queue"))
    }

    pub(crate) async fn improvement_request(
        &self,
        operation: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let (method, path) = match operation {
            "enqueue" => (reqwest::Method::POST, "/improvements"),
            "lease" => (reqwest::Method::POST, "/improvements/lease"),
            "heartbeat" => (reqwest::Method::POST, "/improvements/heartbeat"),
            "advance" => (reqwest::Method::POST, "/improvements/advance"),
            "finish" => (reqwest::Method::POST, "/improvements/finish"),
            "clear" => (reqwest::Method::DELETE, "/improvements"),
            _ => return Err("Invalid improvement queue operation.".into()),
        };
        let client = local_http::client(Duration::from_secs(5))
            .map_err(|error| error.message("Improvement queue"))?;
        local_http::json(
            client
                .request(method, self.endpoint(path))
                .bearer_auth(&self.bearer)
                .json(body),
        )
        .await
        .map_err(|error| error.message("Improvement queue"))
    }

    pub async fn resume(&self) -> Result<(), String> {
        let client = local_http::client(Duration::from_secs(5))
            .map_err(|error| error.message("Enrichment queue"))?;
        local_http::response(
            client
                .post(self.endpoint("/jobs/resume"))
                .bearer_auth(&self.bearer),
        )
        .await
        .map_err(|error| error.message("Enrichment queue"))?;
        self.user_paused.store(false, Ordering::Relaxed);
        Ok(())
    }

    pub fn pause(&self) {
        self.user_paused.store(true, Ordering::Relaxed);
    }

    pub fn set_activity_paused(&self, paused: bool) {
        self.activity_paused.store(paused, Ordering::Relaxed);
    }

    pub(crate) fn is_paused(&self) -> bool {
        self.user_paused.load(Ordering::Relaxed) || self.activity_paused.load(Ordering::Relaxed)
    }

    pub fn health(&self) -> EnrichmentHealth {
        let mut process = self
            .process
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let running = process
            .as_mut()
            .is_some_and(EnrichmentProcesses::is_running);
        if !running {
            let mut detail = self
                .detail
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if detail.is_none() {
                *detail = fs::read_to_string(self.runtime_directory.join("rivet-worker.log"))
                    .ok()
                    .filter(|value| !value.trim().is_empty());
            }
        }
        EnrichmentHealth {
            state: if running && self.ready.load(Ordering::SeqCst) {
                "ready"
            } else {
                "unavailable"
            },
            paused: self.is_paused(),
            control_port: self.control_port,
            actor_port: self.actor_port,
            detail: self
                .detail
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone(),
        }
    }
}

#[tauri::command]
pub async fn enrichment_health(
    state: State<'_, EnrichmentSupervisor>,
) -> Result<EnrichmentHealth, String> {
    state.inner().verify_readiness().await;
    Ok(state.inner().health())
}

#[tauri::command]
pub async fn enrichment_queue_status(
    state: State<'_, EnrichmentSupervisor>,
) -> Result<serde_json::Value, String> {
    state.inner().queue_status().await
}

#[tauri::command]
pub fn pause_enrichment(state: State<'_, EnrichmentSupervisor>) {
    state.inner().pause();
}

#[tauri::command]
pub async fn resume_enrichment(state: State<'_, EnrichmentSupervisor>) -> Result<(), String> {
    state.inner().resume().await
}

#[tauri::command]
pub async fn restart_enrichment(state: State<'_, EnrichmentSupervisor>) -> Result<(), String> {
    state.inner().restart().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_http_tests as http;
    use std::{thread, time::Duration};

    #[test]
    fn enrichment_process_environment_has_no_inherited_credentials_or_configuration() {
        let command = owned_command(std::path::Path::new("fixed-sidecar.exe"));
        for (name, _) in command.get_envs() {
            assert!(matches!(
                name.to_str().unwrap(),
                "SystemRoot" | "WINDIR" | "TEMP" | "TMP"
            ));
        }
        assert_eq!(command.get_program(), "fixed-sidecar.exe");
    }

    fn local_fixture(
        base: &str,
    ) -> (
        crate::search::test_support::SearchFixture,
        EnrichmentSupervisor,
    ) {
        let fixture = crate::search::test_support::SearchFixture::new("local-http-enrichment");
        let mut supervisor = EnrichmentSupervisor::new(
            PathBuf::from("unused"),
            PathBuf::from("unused"),
            fixture.root().join("runtime"),
        )
        .unwrap();
        supervisor.control_port = reqwest::Url::parse(base).unwrap().port().unwrap();
        (fixture, supervisor)
    }

    #[test]
    fn local_http_enrichment_refuses_redirects() {
        let mut outcomes = Vec::new();
        for operation in ["queue", "improvement", "resume", "sync"] {
            let (target, target_server) = http::server(http::json("{}"), Duration::ZERO);
            let (base, server) = http::server(format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: {target}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes(), Duration::ZERO);
            let (_fixture, supervisor) = local_fixture(&base);
            let failed = tauri::async_runtime::block_on(async {
                match operation {
                    "queue" => supervisor.queue_status().await.is_err(),
                    "improvement" => supervisor
                        .improvement_request("lease", &serde_json::json!({}))
                        .await
                        .is_err(),
                    "resume" => supervisor.resume().await.is_err(),
                    _ => {
                        !supervisor
                            .sync_jobs(&[EnrichmentJobRecord {
                                idempotency_key: "fixture".into(),
                                file_id: "fixture".into(),
                                content_hash: "hash".into(),
                                kind: "ocr".into(),
                                route: "fixture".into(),
                            }])
                            .await
                    }
                }
            });
            server.join().unwrap();
            let redirected = target_server.join().unwrap();
            outcomes.push((operation, failed, redirected.is_empty()));
        }
        assert_eq!(
            outcomes,
            [
                ("queue", true, true),
                ("improvement", true, true),
                ("resume", true, true),
                ("sync", true, true)
            ]
        );
    }

    #[test]
    fn local_http_enrichment_bounds_json_bodies() {
        let mut bounded = Vec::new();
        for chunked in [false, true] {
            let (base, server) = http::server(http::oversized(chunked), Duration::ZERO);
            let (_fixture, supervisor) = local_fixture(&base);
            let result = tauri::async_runtime::block_on(supervisor.queue_status());
            server.join().unwrap();
            bounded.push(result.is_err());
        }
        assert_eq!(bounded, [true, true]);
    }

    #[test]
    fn local_http_enrichment_status_operations_bound_body() {
        let mut bounded = Vec::new();
        for operation in ["resume", "sync"] {
            let (base, server) = http::server(http::oversized(true), Duration::ZERO);
            let (_fixture, supervisor) = local_fixture(&base);
            supervisor.pause();
            let failed = tauri::async_runtime::block_on(async {
                if operation == "resume" {
                    supervisor.resume().await.is_err()
                } else {
                    supervisor.user_paused.store(false, Ordering::Relaxed);
                    !supervisor
                        .sync_jobs(&[EnrichmentJobRecord {
                            idempotency_key: "fixture".into(),
                            file_id: "fixture".into(),
                            content_hash: "hash".into(),
                            kind: "ocr".into(),
                            route: "fixture".into(),
                        }])
                        .await
                }
            });
            server.join().unwrap();
            bounded.push((failed, operation != "resume" || supervisor.is_paused()));
        }
        assert_eq!(bounded, [(true, true), (true, true)]);
    }

    #[test]
    fn local_http_enrichment_failures_are_sanitized() {
        let (base, server) = http::server(http::json("{fixture-secret"), Duration::ZERO);
        let (_fixture, supervisor) = local_fixture(&base);
        let error = tauri::async_runtime::block_on(supervisor.queue_status()).unwrap_err();
        server.join().unwrap();
        assert_eq!(error, "Enrichment queue returned invalid data.");
        let error = tauri::async_runtime::block_on(supervisor.resume()).unwrap_err();
        assert_eq!(error, "Enrichment queue is unavailable.");
    }

    #[test]
    fn local_http_enrichment_deadline_includes_status_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = http::server_parts(
            listener,
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n".to_vec(),
            b"{}".to_vec(),
            Duration::from_secs(6),
        );
        let (_fixture, supervisor) = local_fixture(&base);
        supervisor.pause();
        let began = std::time::Instant::now();
        let result = tauri::async_runtime::block_on(supervisor.resume());
        let elapsed = began.elapsed();
        server.join().unwrap();
        assert!(result.is_err());
        assert!(supervisor.is_paused());
        assert!(elapsed < Duration::from_secs(6));
    }

    #[test]
    #[ignore = "invoked only by isolated proxy regression"]
    fn local_http_proxy_probe_enrichment() {
        assert_eq!(
            std::env::var("LUMEN_LOCAL_HTTP_PROXY_PROBE").as_deref(),
            Ok("1")
        );
        let (base, server) = http::server(http::json("[]"), Duration::ZERO);
        let (_fixture, supervisor) = local_fixture(&base);
        let result = tauri::async_runtime::block_on(supervisor.queue_status());
        assert!(result.is_ok());
        assert!(!server.join().unwrap().is_empty());
    }

    #[test]
    fn queue_transport_failure_reports_stop_before_another_submission() {
        use std::io::{Read, Write};
        for (healthy, expected_requests) in [(false, 1), (true, 2)] {
            let fixture =
                crate::search::test_support::SearchFixture::new("enrichment-transport-stop");
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let mut supervisor = EnrichmentSupervisor::new(
                PathBuf::from("unused-worker.exe"),
                PathBuf::from("unused-engine.exe"),
                fixture.root().join("runtime"),
            )
            .unwrap();
            supervisor.control_port = listener.local_addr().unwrap().port();
            let server = thread::spawn(move || {
                let mut requests = 0;
                let mut deadline = std::time::Instant::now() + Duration::from_secs(2);
                while std::time::Instant::now() < deadline {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            stream.set_nonblocking(false).unwrap();
                            stream
                                .set_read_timeout(Some(Duration::from_secs(1)))
                                .unwrap();
                            let mut request = [0u8; 1024];
                            assert!(stream.read(&mut request).unwrap() > 0);
                            requests += 1;
                            stream.write_all(if healthy {
                            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        } else {
                            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        }).unwrap();
                            deadline = std::time::Instant::now() + Duration::from_millis(100);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(error) => panic!("owned loopback listener failed: {error}"),
                    }
                }
                requests
            });
            let job = EnrichmentJobRecord {
                idempotency_key: "fixture:hash:ocr:route".into(),
                file_id: "fixture".into(),
                content_hash: "hash".into(),
                kind: "ocr".into(),
                route: "lumen.vision.cloud".into(),
            };
            let outcome = tauri::async_runtime::block_on(supervisor.sync_jobs(&[job.clone(), job]));
            assert_eq!(
                server.join().unwrap(),
                expected_requests,
                "failed requests stop while healthy requests complete the batch"
            );
            assert_eq!(
                outcome, healthy,
                "callers need the dispatch outcome to stop their outer batch"
            );
        }
    }

    #[test]
    fn worker_ports_are_loopback_selected_and_token_is_not_in_paths() {
        let root = std::env::temp_dir().join(format!("lumen-rivet-{}", uuid::Uuid::new_v4()));
        let supervisor = EnrichmentSupervisor::new(
            root.join("missing.exe"),
            root.join("missing-engine.exe"),
            root.clone(),
        )
        .unwrap();
        assert_ne!(supervisor.control_port, supervisor.actor_port);
        assert_ne!(supervisor.actor_port, supervisor.engine_port);
        assert!(
            !supervisor
                .runtime_directory
                .to_string_lossy()
                .contains(&supervisor.bearer)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "requires the compiled Rivet enrichment worker"]
    fn improvement_worker_recovers_crash_and_fences_old_generation() {
        let directory =
            std::env::temp_dir().join(format!("lumen-improvement-rivet-{}", uuid::Uuid::new_v4()));
        let binaries = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let supervisor = EnrichmentSupervisor::new(
            binaries.join("lumen-enrichment-x86_64-pc-windows-msvc.exe"),
            binaries.join("lumen-rivet-engine-x86_64-pc-windows-msvc.exe"),
            directory.clone(),
        )
        .unwrap();
        supervisor.start().unwrap();
        tauri::async_runtime::block_on(async {
            let ready = std::time::Instant::now();
            loop {
                if supervisor
                    .improvement_request("clear", &serde_json::json!({}))
                    .await
                    .is_ok()
                {
                    break;
                }
                assert!(ready.elapsed() < Duration::from_secs(20));
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let job = serde_json::json!({"idempotencyKey":"synthetic-recovery","baseVersion":0,"configDigest":"a".repeat(64),"phase":"analysis","candidateId":null});
            supervisor
                .improvement_request("enqueue", &job)
                .await
                .unwrap();
            supervisor
                .improvement_request("enqueue", &job)
                .await
                .unwrap();
            let first = supervisor
                .improvement_request("lease", &serde_json::json!({}))
                .await
                .unwrap();
            assert_eq!(first["generation"], 1);
            let advance = serde_json::json!({"idempotencyKey":"synthetic-recovery","generation":1,"phase":"evaluation","candidateId":"candidate-fixture"});
            assert_eq!(
                supervisor
                    .improvement_request("advance", &advance)
                    .await
                    .unwrap()["accepted"],
                true
            );
            supervisor.restart().await.unwrap();
            let began = std::time::Instant::now();
            let recovered = loop {
                if let Ok(lease) = supervisor
                    .improvement_request("lease", &serde_json::json!({}))
                    .await
                    && !lease.is_null()
                {
                    break lease;
                }
                assert!(
                    began.elapsed() < Duration::from_secs(40),
                    "expired lease was not recovered"
                );
                tokio::time::sleep(Duration::from_millis(200)).await;
            };
            assert_eq!(recovered["generation"], 2);
            assert_eq!(recovered["candidateId"], "candidate-fixture");
            assert_eq!(recovered["phase"], "evaluation");
            let mut finish = serde_json::json!({"idempotencyKey":"synthetic-recovery","generation":1,"status":"completed"});
            assert_eq!(
                supervisor
                    .improvement_request("finish", &finish)
                    .await
                    .unwrap()["accepted"],
                false
            );
            finish["generation"] = serde_json::json!(2);
            assert_eq!(
                supervisor
                    .improvement_request("finish", &finish)
                    .await
                    .unwrap()["accepted"],
                true
            );
            assert!(
                supervisor
                    .improvement_request("lease", &serde_json::json!({}))
                    .await
                    .unwrap()
                    .is_null()
            );
        });
        drop(supervisor);
        let resolved = std::fs::canonicalize(&directory).unwrap();
        let temporary = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        assert!(
            resolved.starts_with(&temporary)
                && resolved != temporary
                && resolved
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("lumen-improvement-rivet-")
        );
        std::fs::remove_dir_all(resolved).unwrap();
    }

    #[test]
    #[ignore = "requires the compiled Rivet enrichment worker"]
    fn rivet_worker_resumes_without_duplicate_jobs() {
        let binary = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/lumen-enrichment-x86_64-pc-windows-msvc.exe");
        let engine = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/lumen-rivet-engine-x86_64-pc-windows-msvc.exe");
        let root = std::env::temp_dir().join(format!("lumen-rivet-{}", uuid::Uuid::new_v4()));
        let supervisor = EnrichmentSupervisor::new(binary, engine, root.clone()).unwrap();
        supervisor.start().unwrap();
        let (engine_pid, worker_pid) = {
            let process = supervisor.process.lock().unwrap();
            let process = process.as_ref().unwrap();
            (process.engine.child.id(), process.worker.child.id())
        };
        assert!(
            TcpListener::bind(("127.0.0.1", supervisor.engine_port + 1)).is_ok(),
            "single local engine must not expose private peer API"
        );
        thread::sleep(Duration::from_secs(2));
        let job = EnrichmentJobRecord {
            idempotency_key: "file:owned-hash:ocr:route".to_owned(),
            file_id: "file".to_owned(),
            content_hash: "a".repeat(64),
            kind: "ocr".to_owned(),
            route: "lumen.vision.cloud".to_owned(),
        };
        tauri::async_runtime::block_on(async {
            assert!(supervisor.sync_jobs(&[job.clone(), job]).await);
            let first = supervisor.queue_status().await.unwrap();
            assert_eq!(first[0]["count"].as_u64(), Some(1));
        });
        tauri::async_runtime::block_on(supervisor.restart()).unwrap();
        {
            let process = supervisor.process.lock().unwrap();
            let process = process.as_ref().unwrap();
            assert_eq!(
                process.engine.child.id(),
                engine_pid,
                "normal worker restart retains the owned engine"
            );
            assert_ne!(process.worker.child.id(), worker_pid);
        }
        assert!(TcpListener::bind(("127.0.0.1", supervisor.engine_port + 1)).is_ok());
        thread::sleep(Duration::from_secs(2));
        tauri::async_runtime::block_on(async {
            supervisor.resume().await.unwrap();
            let after_restart = supervisor.queue_status().await.unwrap();
            assert_eq!(after_restart[0]["count"].as_u64(), Some(1));
        });
        drop(supervisor);
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    #[ignore = "explicit compiled enrichment engine ownership gate after staging"]
    fn rivet_worker_replaces_dead_engine_and_stops_owned_children() {
        let fixture = crate::search::test_support::SearchFixture::new("rivet-engine-ownership");
        let binaries = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let supervisor = EnrichmentSupervisor::new(
            binaries.join("lumen-enrichment-x86_64-pc-windows-msvc.exe"),
            binaries.join("lumen-rivet-engine-x86_64-pc-windows-msvc.exe"),
            fixture.root().join("owned-runtime"),
        )
        .unwrap();
        supervisor.start().unwrap();
        let old_engine = {
            let mut process = supervisor.process.lock().unwrap();
            let process = process.as_mut().unwrap();
            let id = process.engine.child.id();
            process.engine.child.kill().unwrap();
            process.engine.child.wait().unwrap();
            id
        };
        tauri::async_runtime::block_on(supervisor.restart()).unwrap();
        assert!(
            !supervisor.ready.load(Ordering::SeqCst),
            "a listening replacement engine is not actor readiness"
        );
        {
            let mut process = supervisor.process.lock().unwrap();
            let process = process.as_mut().unwrap();
            assert_ne!(process.engine.child.id(), old_engine);
            assert!(process.is_running());
        }
        assert!(TcpListener::bind(("127.0.0.1", supervisor.engine_port + 1)).is_ok());
        #[cfg(windows)]
        {
            use windows::Win32::{
                Foundation::CloseHandle,
                System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
            };
            let (engine, worker) = {
                let process = supervisor.process.lock().unwrap();
                let process = process.as_ref().unwrap();
                unsafe {
                    (
                        OpenProcess(PROCESS_SYNCHRONIZE, false, process.engine.child.id()).unwrap(),
                        OpenProcess(PROCESS_SYNCHRONIZE, false, process.worker.child.id()).unwrap(),
                    )
                }
            };
            drop(supervisor);
            unsafe {
                assert_eq!(WaitForSingleObject(engine, 1000).0, 0);
                assert_eq!(WaitForSingleObject(worker, 1000).0, 0);
                CloseHandle(engine).unwrap();
                CloseHandle(worker).unwrap();
            }
        }
    }
    #[test]
    fn missing_enrichment_engine_does_not_report_readiness_or_spawn_a_worker() {
        let fixture = crate::search::test_support::SearchFixture::new("rivet-missing-engine");
        let supervisor = EnrichmentSupervisor::new(
            std::env::current_exe().unwrap(),
            fixture.root().join("missing-engine.exe"),
            fixture.root().join("runtime"),
        )
        .unwrap();
        assert_eq!(
            supervisor.start().unwrap_err(),
            "Rivet engine sidecar is not staged"
        );
        assert!(!supervisor.ready.load(Ordering::SeqCst));
        assert!(supervisor.process.lock().unwrap().is_none());
    }
    #[test]
    fn enrichment_late_readiness_cannot_mark_a_replaced_runtime_ready() {
        for operation in ["health", "status", "sync"] {
            let fixture = crate::search::test_support::SearchFixture::new("rivet-late-readiness");
            let supervisor = EnrichmentSupervisor::new(
                PathBuf::from("unused"),
                PathBuf::from("unused"),
                fixture.root().join("runtime"),
            )
            .unwrap();
            let reply = if operation == "health" {
                r#"{"status":"ready"}"#
            } else {
                "[]"
            };
            let server = http::server_at(
                TcpListener::bind(("127.0.0.1", supervisor.control_port)).unwrap(),
                http::json(reply),
                Duration::from_millis(200),
            );
            tauri::async_runtime::block_on(async {
                let request = async {
                    match operation {
                        "health" => supervisor.verify_readiness().await,
                        "status" => {
                            assert_eq!(
                                supervisor.queue_status().await.unwrap_err(),
                                "Enrichment runtime changed; retry the request."
                            );
                        }
                        _ => {
                            assert!(
                                !supervisor
                                    .sync_jobs(&[EnrichmentJobRecord {
                                        idempotency_key: "owned:hash:ocr:route".into(),
                                        file_id: "owned".into(),
                                        content_hash: "a".repeat(64),
                                        kind: "ocr".into(),
                                        route: "lumen.vision.cloud".into(),
                                    }])
                                    .await
                            );
                        }
                    }
                };
                let replaced = async {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    let _guard = supervisor.process.lock().unwrap();
                    supervisor.process_generation.fetch_add(1, Ordering::SeqCst);
                    supervisor.ready.store(false, Ordering::SeqCst);
                };
                tokio::join!(request, replaced);
            });
            server.join().unwrap();
            assert!(
                !supervisor.ready.load(Ordering::SeqCst),
                "{operation}: old actor response must not mark the replacement ready"
            );
        }
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "explicit owned Windows hung-engine integration gate after staging"]
    fn rivet_worker_replaces_hung_owned_engine_without_false_readiness() {
        use windows::Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::Threading::{OpenProcess, PROCESS_SUSPEND_RESUME},
        };
        #[link(name = "ntdll")]
        unsafe extern "system" {
            fn NtSuspendProcess(handle: *mut std::ffi::c_void) -> i32;
            fn NtResumeProcess(handle: *mut std::ffi::c_void) -> i32;
        }
        struct OwnedSuspension(HANDLE);
        impl Drop for OwnedSuspension {
            fn drop(&mut self) {
                unsafe {
                    let _ = NtResumeProcess(self.0.0);
                    let _ = CloseHandle(self.0);
                }
            }
        }
        let fixture = crate::search::test_support::SearchFixture::new("rivet-hung-engine");
        let binaries = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let supervisor = EnrichmentSupervisor::new(
            binaries.join("lumen-enrichment-x86_64-pc-windows-msvc.exe"),
            binaries.join("lumen-rivet-engine-x86_64-pc-windows-msvc.exe"),
            fixture.root().join("owned-runtime"),
        )
        .unwrap();
        supervisor.start().unwrap();
        tauri::async_runtime::block_on(async {
            let started = std::time::Instant::now();
            while supervisor.queue_status().await.is_err() {
                assert!(started.elapsed() < Duration::from_secs(20));
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
        let old_engine = supervisor
            .process
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .engine
            .child
            .id();
        let suspension = OwnedSuspension(unsafe {
            OpenProcess(PROCESS_SUSPEND_RESUME, false, old_engine).unwrap()
        });
        assert_eq!(unsafe { NtSuspendProcess(suspension.0.0) }, 0);
        tauri::async_runtime::block_on(async {
            let (first, second) = tokio::time::timeout(Duration::from_secs(16), async {
                tokio::join!(supervisor.restart(), supervisor.restart())
            })
            .await
            .expect("owned hung-engine restart watchdog");
            assert!(
                first.is_ok() ^ second.is_ok(),
                "one concurrent restart wins; stale health must not replace its newer runtime"
            );
            let stale = first.err().or_else(|| second.err()).unwrap();
            assert_eq!(
                stale,
                "Rivet runtime changed during restart; retry the request."
            );
        });
        let process = supervisor.process.lock().unwrap();
        let process = process.as_ref().unwrap();
        assert_ne!(
            process.engine.child.id(),
            old_engine,
            "a listening but hung owned engine must be replaced"
        );
        assert!(!supervisor.ready.load(Ordering::SeqCst));
        drop(suspension);
    }
    #[test]
    fn enrichment_engine_config_matches_selected_loopback_ports_and_owned_database() {
        let fixture = crate::search::test_support::SearchFixture::new("rivet-topology-config");
        let mut supervisor = EnrichmentSupervisor::new(
            PathBuf::from("unused"),
            PathBuf::from("unused"),
            fixture.root().to_owned(),
        )
        .unwrap();
        supervisor.engine_port = 26422;
        let database = fixture.root().join("owned-db");
        let config: serde_json::Value = serde_json::from_slice(
            &serde_json::to_vec(&supervisor.engine_config(&database)).unwrap(),
        )
        .unwrap();
        assert_eq!(config["guard"]["host"], "127.0.0.1");
        assert_eq!(config["auth"]["admin_token"], supervisor.bearer);
        assert_eq!(config["guard"]["port"], 26422);
        assert_eq!(config["api_peer"]["port"], 26423);
        assert_eq!(config["file_system"]["path"], database.to_str().unwrap());
        assert_eq!(config["telemetry"]["enabled"], false);
        assert_eq!(config["topology"]["datacenter_label"], 1);
        assert_eq!(
            config["topology"]["datacenters"]["default"]["datacenter_label"],
            1
        );
        assert_eq!(
            config["topology"]["datacenters"]["default"]["is_leader"],
            true
        );
        assert_eq!(
            config["topology"]["datacenters"]["default"]["public_url"],
            "http://127.0.0.1:26422"
        );
        assert_eq!(
            config["topology"]["datacenters"]["default"]["peer_url"],
            "http://127.0.0.1:26423"
        );
    }
}
