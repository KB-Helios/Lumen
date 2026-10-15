use std::{
    fs,
    io::Read,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    config::{
        AGENTGATEWAY_VERSION, GatewayPorts, agentgateway_sha256, render_enrichment_config,
        render_gateway_config,
    },
    credentials,
    registry::AppliedRoute,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHealth {
    pub state: &'static str,
    pub version: &'static str,
    pub interactive_port: u16,
    pub enrichment_port: u16,
    pub admin_port: u16,
    pub cloud_credential_configured: bool,
    pub detail: Option<String>,
}

struct ProcessState {
    slots: Vec<ProcessSlot>,
    detail: Option<String>,
}

struct ProcessSlot {
    child: Child,
    #[cfg(windows)]
    job: isize,
}

impl Drop for ProcessSlot {
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

pub struct GatewaySupervisor {
    binary: PathBuf,
    config_paths: [PathBuf; 2],
    log_paths: [PathBuf; 2],
    ports: GatewayPorts,
    bearer: String,
    state: Mutex<ProcessState>,
    enrichment_budget: Arc<super::enrichment_budget::EnrichmentBudget>,
}

fn free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Could not reserve a loopback port: {error}"))?
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Could not inspect a loopback port: {error}"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    use std::fmt::Write;
    let mut output = String::with_capacity(64);
    for byte in hash.finalize() {
        let _ = write!(output, "{byte:02x}");
    }
    Ok(output)
}

impl GatewaySupervisor {
    pub fn new(
        binary: PathBuf,
        runtime_directory: &Path,
        routes: &[AppliedRoute],
    ) -> Result<Self, String> {
        fs::create_dir_all(runtime_directory).map_err(|error| error.to_string())?;
        let ports = GatewayPorts {
            interactive: free_port()?,
            enrichment: free_port()?,
            admin: free_port()?,
        };
        let interactive_config = runtime_directory.join("agentgateway.interactive.yaml");
        let enrichment_config = runtime_directory.join("agentgateway.enrichment.yaml");
        let interactive_log = runtime_directory.join("agentgateway.interactive.log");
        let enrichment_log = runtime_directory.join("agentgateway.enrichment.log");
        fs::write(&interactive_config, render_gateway_config(ports, routes))
            .map_err(|error| error.to_string())?;
        fs::write(&enrichment_config, render_enrichment_config(ports, routes))
            .map_err(|error| error.to_string())?;
        Ok(Self {
            enrichment_budget: super::enrichment_budget::EnrichmentBudget::open(
                &runtime_directory.join("enrichment-budget.sqlite"),
            )?,
            binary,
            config_paths: [interactive_config, enrichment_config],
            log_paths: [interactive_log, enrichment_log],
            ports,
            bearer: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            state: Mutex::new(ProcessState {
                slots: Vec::new(),
                detail: None,
            }),
        })
    }

    pub fn start(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "Gateway state is poisoned")?;
        let mut all_running = state.slots.len() == self.config_paths.len();
        for slot in &mut state.slots {
            all_running &= slot
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none();
        }
        if all_running {
            return Ok(());
        }
        state.slots.clear();
        if !self.binary.is_file() {
            state.detail = Some("AgentGateway sidecar is not staged".to_owned());
            return Err(state.detail.clone().unwrap_or_default());
        }
        let actual = sha256_file(&self.binary)?;
        if actual != agentgateway_sha256() {
            state.detail = Some("AgentGateway checksum validation failed".to_owned());
            return Err(state.detail.clone().unwrap_or_default());
        }

        let cloud_key = credentials::get("openai").unwrap_or_default();
        let anthropic_key = credentials::get("anthropic").unwrap_or_default();
        let google_key = credentials::get("google").unwrap_or_default();
        let compatible_key = credentials::get("openai-compatible").unwrap_or_default();
        for (index, config_path) in self.config_paths.iter().enumerate() {
            let log =
                fs::File::create(&self.log_paths[index]).map_err(|error| error.to_string())?;
            let error_log = log.try_clone().map_err(|error| error.to_string())?;
            let mut command = Command::new(&self.binary);
            command
                .arg("-f")
                .arg(config_path)
                .env("LUMEN_GATEWAY_BEARER", &self.bearer)
                .env("LUMEN_OPENAI_API_KEY", &cloud_key)
                .env("LUMEN_ANTHROPIC_API_KEY", &anthropic_key)
                .env("LUMEN_GOOGLE_API_KEY", &google_key)
                .env("LUMEN_OPENAI_COMPATIBLE_API_KEY", &compatible_key)
                .env("LUMEN_LOCAL_BASE_URL", "http://127.0.0.1:13305/v1")
                .env("LUMEN_LOCAL_API_KEY", "lumen-local")
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
                .map_err(|error| format!("Could not start AgentGateway: {error}"))?;
            #[cfg(windows)]
            let job = assign_kill_on_close_job(&child)?;
            state.slots.push(ProcessSlot {
                child,
                #[cfg(windows)]
                job: job.0 as isize,
            });
        }
        state.detail = None;
        Ok(())
    }

    pub fn restart(&self) -> Result<(), String> {
        {
            let mut state = self.state.lock().map_err(|_| "Gateway state is poisoned")?;
            state.slots.clear();
        }
        self.start()
    }

    fn validate_config(&self, path: &Path) -> Result<(), String> {
        if !self.binary.is_file() {
            return Err(
                "AgentGateway is not staged; the previous route remains applied.".to_owned(),
            );
        }
        let output = Command::new(&self.binary)
            .arg("-f")
            .arg(path)
            .arg("--validate-only")
            .env("LUMEN_GATEWAY_BEARER", "lumen-validation-token")
            .env("LUMEN_OPENAI_API_KEY", "validation")
            .env("LUMEN_ANTHROPIC_API_KEY", "validation")
            .env("LUMEN_GOOGLE_API_KEY", "validation")
            .env("LUMEN_OPENAI_COMPATIBLE_API_KEY", "validation")
            .env("LUMEN_LOCAL_BASE_URL", "http://127.0.0.1:13305/v1")
            .env("LUMEN_LOCAL_API_KEY", "validation")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|_| "AgentGateway could not validate the candidate route.".to_owned())?;
        if output.success() {
            Ok(())
        } else {
            Err(
                "AgentGateway rejected the candidate route; the previous route remains applied."
                    .to_owned(),
            )
        }
    }

    pub fn apply_routes(&self, routes: &[AppliedRoute]) -> Result<(), String> {
        let candidates = [
            self.config_paths[0].with_extension("candidate.yaml"),
            self.config_paths[1].with_extension("candidate.yaml"),
        ];
        let rendered = [
            render_gateway_config(self.ports, routes),
            render_enrichment_config(self.ports, routes),
        ];
        for (path, contents) in candidates.iter().zip(&rendered) {
            fs::write(path, contents)
                .map_err(|_| "The candidate provider route could not be staged.".to_owned())?;
            if let Err(error) = self.validate_config(path) {
                for candidate in &candidates {
                    let _ = fs::remove_file(candidate);
                }
                return Err(error);
            }
        }
        let previous = self
            .config_paths
            .iter()
            .map(fs::read)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "The current provider routes could not be backed up.".to_owned())?;
        for (target, contents) in self.config_paths.iter().zip(&rendered) {
            if fs::write(target, contents).is_err() {
                for (previous_target, previous_contents) in
                    self.config_paths.iter().zip(previous.iter())
                {
                    let _ = fs::write(previous_target, previous_contents);
                }
                for candidate in &candidates {
                    let _ = fs::remove_file(candidate);
                }
                return Err(
                    "The candidate provider route could not be installed; the previous route was restored."
                        .to_owned(),
                );
            }
        }
        for candidate in &candidates {
            let _ = fs::remove_file(candidate);
        }
        if let Err(error) = self.restart() {
            for (target, contents) in self.config_paths.iter().zip(previous) {
                let _ = fs::write(target, contents);
            }
            let _ = self.restart();
            return Err(format!("{error}; the previous route was restored."));
        }
        Ok(())
    }

    pub fn health(&self) -> GatewayHealth {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut running = state.slots.len() == self.config_paths.len();
        for slot in &mut state.slots {
            running &= slot
                .child
                .try_wait()
                .ok()
                .is_some_and(|status| status.is_none());
        }
        if !running && state.detail.is_none() {
            state.detail = self.log_paths.iter().find_map(|path| {
                fs::read_to_string(path)
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| {
                        value
                            .chars()
                            .rev()
                            .take(1_000)
                            .collect::<String>()
                            .chars()
                            .rev()
                            .collect()
                    })
            });
        }
        GatewayHealth {
            state: if running { "ready" } else { "unavailable" },
            version: AGENTGATEWAY_VERSION,
            interactive_port: self.ports.interactive,
            enrichment_port: self.ports.enrichment,
            admin_port: self.ports.admin,
            cloud_credential_configured: ["openai", "anthropic", "google", "openai-compatible"]
                .iter()
                .any(|provider| credentials::get(provider).is_some()),
            detail: state.detail.clone(),
        }
    }

    pub(crate) fn endpoint(&self, enrichment: bool) -> (String, String) {
        let port = if enrichment {
            self.ports.enrichment
        } else {
            self.ports.interactive
        };
        (format!("http://127.0.0.1:{port}"), self.bearer.clone())
    }

    pub(crate) fn enrichment_budget(&self) -> Arc<super::enrichment_budget::EnrichmentBudget> {
        self.enrichment_budget.clone()
    }
}

#[cfg(windows)]
pub(crate) fn assign_kill_on_close_job(
    child: &Child,
) -> Result<windows::Win32::Foundation::HANDLE, String> {
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows::Win32::{
        Foundation::{HANDLE, INVALID_HANDLE_VALUE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
    };

    unsafe {
        let job = CreateJobObjectW(None, None).map_err(|error| error.to_string())?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Err(error) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            let _ = windows::Win32::Foundation::CloseHandle(job);
            return Err(error.to_string());
        }
        let process = HANDLE(child.as_raw_handle());
        if process == INVALID_HANDLE_VALUE || AssignProcessToJobObject(job, process).is_err() {
            let _ = windows::Win32::Foundation::CloseHandle(job);
            return Err("Could not assign AgentGateway to the Lumen Job Object".to_owned());
        }
        Ok(job)
    }
}

#[tauri::command]
pub fn gateway_health(supervisor: tauri::State<'_, GatewaySupervisor>) -> GatewayHealth {
    supervisor.inner().health()
}

#[tauri::command]
pub fn restart_gateway(supervisor: tauri::State<'_, GatewaySupervisor>) -> Result<(), String> {
    supervisor.inner().restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpStream, thread, time::Duration};

    #[test]
    fn generated_config_is_secret_free_and_uses_loopback_admin() {
        let root = std::env::temp_dir().join(format!("lumen-gateway-{}", uuid::Uuid::new_v4()));
        let routes = crate::gateway::registry::ProviderRegistry::in_memory().routes();
        let supervisor = GatewaySupervisor::new(root.join("missing.exe"), &root, &routes).unwrap();
        let config = fs::read_to_string(&supervisor.config_paths[0]).unwrap();
        assert!(config.contains("adminAddr: 127.0.0.1:"));
        assert!(config.contains("$LUMEN_GATEWAY_BEARER"));
        assert!(!config.contains(&supervisor.bearer));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn gateway_admission_rejects_changed_bytes_before_credentials_or_spawn() {
        let root =
            std::env::temp_dir().join(format!("lumen-gateway-seal-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let binary = root.join("agentgateway.exe");
        fs::write(&binary, b"untrusted executable bytes").unwrap();
        let routes = crate::gateway::registry::ProviderRegistry::in_memory().routes();
        let supervisor = GatewaySupervisor::new(binary, &root, &routes).unwrap();
        assert_eq!(
            supervisor.start().unwrap_err(),
            "AgentGateway checksum validation failed"
        );
        assert!(supervisor.state.lock().unwrap().slots.is_empty());
        assert!(!supervisor.log_paths.iter().any(|path| path.exists()));
        drop(supervisor);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires the verified staged Gateway; never reads credentials or starts it"]
    fn pinned_gateway_digest_matches_compiled_admission() {
        let binary = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/agentgateway-x86_64-pc-windows-msvc.exe");
        assert_eq!(sha256_file(&binary).unwrap(), agentgateway_sha256());
    }

    #[test]
    #[ignore = "requires the checksum-pinned AgentGateway sidecar"]
    fn pinned_gateway_starts_restarts_and_stops_both_lanes() {
        let binary = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/agentgateway-x86_64-pc-windows-msvc.exe");
        let root = std::env::temp_dir().join(format!("lumen-gateway-{}", uuid::Uuid::new_v4()));
        let routes = crate::gateway::registry::ProviderRegistry::in_memory().routes();
        let supervisor = GatewaySupervisor::new(binary, &root, &routes).unwrap();
        supervisor.start().unwrap();
        thread::sleep(Duration::from_millis(500));
        let health = supervisor.health();
        assert_eq!(health.state, "ready", "{:?}", health.detail);
        for port in [health.interactive_port, health.enrichment_port] {
            assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
        }
        supervisor.restart().unwrap();
        thread::sleep(Duration::from_millis(500));
        assert_eq!(supervisor.health().state, "ready");
        drop(supervisor);
        let _ = fs::remove_dir_all(root);
    }
}
