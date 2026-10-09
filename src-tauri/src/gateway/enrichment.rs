use std::{
    fs,
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde::Serialize;
use tauri::State;

use crate::search::EnrichmentJobRecord;

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

impl EnrichmentSupervisor {
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
        *process = None;
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
        let engine_log_path = self.runtime_directory.join("rivet-engine.log");
        let engine_log = fs::File::create(&engine_log_path).map_err(|error| error.to_string())?;
        let engine_error_log = engine_log.try_clone().map_err(|error| error.to_string())?;
        let engine_db = self.runtime_directory.join("rivet-engine-db");
        fs::create_dir_all(&engine_db).map_err(|error| error.to_string())?;
        let mut engine_command = Command::new(&self.engine_binary);
        engine_command
            .arg("start")
            .current_dir(&self.runtime_directory)
            .env("RIVET__GUARD__HOST", "127.0.0.1")
            .env("RIVET__GUARD__PORT", self.engine_port.to_string())
            .env("RIVET__API_PEER__HOST", "127.0.0.1")
            .env("RIVET__API_PEER__PORT", (self.engine_port + 1).to_string())
            .env("RIVET__METRICS__HOST", "127.0.0.1")
            .env("RIVET__METRICS__PORT", (self.engine_port + 10).to_string())
            .env("RIVET__FILE_SYSTEM__PATH", &engine_db)
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
        let mut engine = ManagedProcess {
            child: engine_child,
            #[cfg(windows)]
            job: engine_job.0 as isize,
        };

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

        let mut command = Command::new(&self.binary);
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

    pub fn restart(&self) -> Result<(), String> {
        *self
            .process
            .lock()
            .map_err(|_| "Worker state is poisoned")? = None;
        self.start()
    }

    fn endpoint(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.control_port)
    }

    pub async fn sync_jobs(&self, jobs: &[EnrichmentJobRecord]) -> bool {
        if self.is_paused() {
            return false;
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();
        for job in jobs {
            let response = client
                .post(self.endpoint("/jobs"))
                .bearer_auth(&self.bearer)
                .json(job)
                .send()
                .await
                .and_then(reqwest::Response::error_for_status);
            if let Err(error) = response {
                *self
                    .detail
                    .lock()
                    .unwrap_or_else(|value| value.into_inner()) =
                    Some(format!("Rivet queue sync is waiting: {error}"));
                return false;
            }
        }
        true
    }

    pub async fn queue_status(&self) -> Result<serde_json::Value, String> {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|error| error.to_string())?
            .get(self.endpoint("/jobs"))
            .bearer_auth(&self.bearer)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?
            .json()
            .await
            .map_err(|error| error.to_string())
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
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| "Improvement queue is unavailable.")?
            .request(method, self.endpoint(path))
            .bearer_auth(&self.bearer)
            .json(body)
            .send()
            .await
            .map_err(|_| "Improvement queue is unavailable.")?
            .error_for_status()
            .map_err(|_| "Improvement queue refused the request.")?
            .json()
            .await
            .map_err(|_| "Improvement queue returned invalid data.".into())
    }

    pub async fn resume(&self) -> Result<(), String> {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|error| error.to_string())?
            .post(self.endpoint("/jobs/resume"))
            .bearer_auth(&self.bearer)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;
        self.user_paused.store(false, Ordering::Relaxed);
        Ok(())
    }

    pub fn pause(&self) {
        self.user_paused.store(true, Ordering::Relaxed);
    }

    pub fn set_activity_paused(&self, paused: bool) {
        self.activity_paused.store(paused, Ordering::Relaxed);
    }

    fn is_paused(&self) -> bool {
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
            state: if running { "ready" } else { "unavailable" },
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
pub fn enrichment_health(state: State<'_, EnrichmentSupervisor>) -> EnrichmentHealth {
    state.inner().health()
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
pub fn restart_enrichment(state: State<'_, EnrichmentSupervisor>) -> Result<(), String> {
    state.inner().restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{thread, time::Duration};

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
            supervisor.restart().unwrap();
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
        thread::sleep(Duration::from_secs(2));
        let job = EnrichmentJobRecord {
            idempotency_key: "file:hash:ocr:route".to_owned(),
            file_id: "file".to_owned(),
            content_hash: "hash".to_owned(),
            kind: "ocr".to_owned(),
            route: "lumen.vision.cloud".to_owned(),
        };
        tauri::async_runtime::block_on(async {
            supervisor.sync_jobs(&[job.clone(), job]).await;
            let first = supervisor.queue_status().await.unwrap();
            assert_eq!(first[0]["count"].as_u64(), Some(1));
        });
        supervisor.restart().unwrap();
        thread::sleep(Duration::from_secs(2));
        tauri::async_runtime::block_on(async {
            supervisor.resume().await.unwrap();
            let after_restart = supervisor.queue_status().await.unwrap();
            assert_eq!(after_restart[0]["count"].as_u64(), Some(1));
        });
        drop(supervisor);
        let _ = fs::remove_dir_all(root);
    }
}
