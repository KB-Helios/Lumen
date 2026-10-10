use std::{
    env, fs,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

const LEMONADE_PORT: u16 = 13_305;
const REQUIRED_LEMONADE: &str = super::provisioning::RUNTIME_VERSION;
const REQUIRED_FLM: &str = "0.9.46";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeComponent {
    pub installed: bool,
    pub version: Option<String>,
    pub required_version: &'static str,
    pub state: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntimeHealth {
    pub profile: &'static str,
    pub state: &'static str,
    pub accelerator: String,
    pub answer_model: &'static str,
    pub embedding_model: &'static str,
    pub transcription_model: &'static str,
    pub base_url: &'static str,
    pub lemonade: RuntimeComponent,
    pub flm: RuntimeComponent,
    pub mistral_rs: RuntimeComponent,
    pub detail: Option<String>,
}

struct RuntimeProcess {
    child: Child,
    #[cfg(windows)]
    job: isize,
}

impl Drop for RuntimeProcess {
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

pub struct LocalRuntimeSupervisor {
    provisioning_root: Option<PathBuf>,
    system_cli: Option<PathBuf>,
    system_server: Option<PathBuf>,
    flm: Option<PathBuf>,
    mistral_rs: Option<PathBuf>,
    process: Mutex<Option<RuntimeProcess>>,
    answer_startup: tokio::sync::Mutex<()>,
    #[cfg(test)]
    answer_fixture: Option<answer_preparation_tests::Fixture>,
}

#[derive(Clone)]
struct RuntimeBinaries {
    cli: Option<PathBuf>,
    server: Option<PathBuf>,
    root: Option<PathBuf>,
}

fn executable_on_path(names: &[&str]) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| candidate.is_file())
}

fn known_executable(path: Option<PathBuf>, names: &[&str]) -> Option<PathBuf> {
    path.filter(|candidate| candidate.is_file())
        .or_else(|| executable_on_path(names))
}

fn command_output(binary: &Path, arguments: &[&str]) -> Option<String> {
    let mut command = Command::new(binary);
    command.args(arguments).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().ok()?;
    let combined = format!(
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let version = parse_version(&combined)?;
    (!version.is_empty()).then_some(version)
}

fn parse_version(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|part| {
        let candidate = part
            .trim_start_matches('v')
            .trim_matches(|value: char| !value.is_ascii_digit() && value != '.');
        (candidate
            .chars()
            .next()
            .is_some_and(|value| value.is_ascii_digit())
            && candidate.contains('.'))
        .then(|| candidate.to_owned())
    })
}

fn component(
    binary: Option<&Path>,
    version: Option<String>,
    required: &'static str,
) -> RuntimeComponent {
    let installed = binary.is_some();
    let state = if !installed {
        "missing"
    } else if version.as_deref() == Some(required) {
        "ready"
    } else {
        "update-required"
    };
    RuntimeComponent {
        installed,
        version,
        required_version: required,
        state,
    }
}

fn lemonade_ready() -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], LEMONADE_PORT)),
        Duration::from_millis(150),
    )
    .is_ok()
}

/// Returns cancellation before timeout when both interrupt local preparation.
fn preparation_interrupted(
    cancellation: &CancellationToken,
    deadline: tokio::time::Instant,
) -> Option<&'static str> {
    if cancellation.is_cancelled() {
        Some("cancelled")
    } else if tokio::time::Instant::now() >= deadline {
        Some("request_timeout")
    } else {
        None
    }
}

/// Attempts a 150-ms TCP readiness probe within the shared deadline and cancellation token.
async fn answer_ready(
    address: SocketAddr,
    cancellation: &CancellationToken,
    deadline: tokio::time::Instant,
) -> Result<bool, &'static str> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err("cancelled"),
        _ = tokio::time::sleep_until(deadline) => Err("request_timeout"),
        connected = tokio::time::timeout(Duration::from_millis(150), tokio::net::TcpStream::connect(address)) => Ok(matches!(connected, Ok(Ok(_)))),
    }
}

/// Reads one version-output pipe, rejecting more than 16 KiB or any read failure.
async fn bounded_version_output(reader: impl AsyncRead + Unpin) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    reader
        .take(16_385)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "local_runtime_unavailable")?;
    if bytes.len() > 16_384 {
        return Err("local_runtime_unavailable");
    }
    Ok(bytes)
}

#[cfg(windows)]
struct ProbeJob(isize);

#[cfg(windows)]
impl Drop for ProbeJob {
    /// Closes the job handle, terminating any processes still contained by this probe.
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                self.0 as *mut _,
            ));
        }
    }
}

#[cfg(windows)]
/// Contains the probe in a Windows Job Object that kills its processes when closed.
fn answer_probe_job(child: &tokio::process::Child) -> Result<ProbeJob, &'static str> {
    use windows::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
    };
    unsafe {
        let job = CreateJobObjectW(None, None).map_err(|_| "local_runtime_unavailable")?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        let assigned = child.raw_handle().is_some_and(|handle| {
            configured.is_ok() && AssignProcessToJobObject(job, HANDLE(handle)).is_ok()
        });
        if !assigned {
            let _ = CloseHandle(job);
            return Err("local_runtime_unavailable");
        }
        Ok(ProbeJob(job.0 as isize))
    }
}

/// Runs an owned version probe with bounded pipes and a five-second maximum wait.
/// Cancellation or failure kills and reaps the child before returning a safe error code.
async fn answer_version(
    mut command: tokio::process::Command,
    cancellation: &CancellationToken,
    deadline: tokio::time::Instant,
) -> Result<String, &'static str> {
    if let Some(error) = preparation_interrupted(cancellation, deadline) {
        return Err(error);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().map_err(|_| "local_runtime_unavailable")?;
    #[cfg(windows)]
    let _job = match answer_probe_job(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error);
        }
    };
    let stdout = child.stdout.take().ok_or("local_runtime_unavailable")?;
    let stderr = child.stderr.take().ok_or("local_runtime_unavailable")?;
    let probe_deadline = deadline.min(tokio::time::Instant::now() + Duration::from_secs(5));
    let result = {
        let output = async {
            let (stdout, stderr, status) = tokio::try_join!(
                bounded_version_output(stdout),
                bounded_version_output(stderr),
                async { child.wait().await.map_err(|_| "local_runtime_unavailable") },
            )?;
            if !status.success() {
                return Err("local_runtime_unavailable");
            }
            let stdout = std::str::from_utf8(&stdout).map_err(|_| "local_runtime_unavailable")?;
            let stderr = std::str::from_utf8(&stderr).map_err(|_| "local_runtime_unavailable")?;
            parse_version(&format!("{stdout} {stderr}")).ok_or("local_runtime_unavailable")
        };
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err("cancelled"),
            _ = tokio::time::sleep_until(probe_deadline) => Err(preparation_interrupted(cancellation, deadline).unwrap_or("local_runtime_unavailable")),
            result = output => result,
        }
    };
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    if let Some(error) = preparation_interrupted(cancellation, deadline) {
        return Err(error);
    }
    result
}

fn profile_for(flm: bool, accelerator: &str) -> &'static str {
    if flm {
        "laptop-amd-npu"
    } else if accelerator.contains("RTX 5070 Ti") {
        "desktop-nvidia-cuda"
    } else {
        "generic-local"
    }
}

impl LocalRuntimeSupervisor {
    /// Checks the registered child for exit, returning an error if state or process inspection fails.
    fn answer_process_alive(&self) -> Result<bool, &'static str> {
        Ok(self
            .process
            .lock()
            .map_err(|_| "local_runtime_unavailable")?
            .as_mut()
            .map(|process| process.child.try_wait())
            .transpose()
            .map_err(|_| "local_runtime_unavailable")?
            .is_some_and(|status| status.is_none()))
    }

    /// Serializes local answer startup and verifies readiness within the request deadline.
    /// New children remain owned by this future until adoption; interruption preserves existing children.
    pub(super) async fn prepare_answer(
        &self,
        cancellation: &CancellationToken,
        deadline: tokio::time::Instant,
    ) -> Result<(), &'static str> {
        if let Some(error) = preparation_interrupted(cancellation, deadline) {
            return Err(error);
        }
        let _startup = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err("cancelled"),
            _ = tokio::time::sleep_until(deadline) => return Err("request_timeout"),
            lock = self.answer_startup.lock() => lock,
        };
        let address = SocketAddr::from(([127, 0, 0, 1], LEMONADE_PORT));
        #[cfg(test)]
        let address = self
            .answer_fixture
            .as_ref()
            .map_or(address, |fixture| fixture.address);
        if self.answer_process_alive()? && answer_ready(address, cancellation, deadline).await? {
            if let Some(error) = preparation_interrupted(cancellation, deadline) {
                return Err(error);
            }
            return Ok(());
        }

        let binaries = self.binaries();
        let cli = binaries.cli.as_deref().ok_or("local_runtime_unavailable")?;
        let server = binaries
            .server
            .as_deref()
            .ok_or("local_runtime_unavailable")?;
        let mut version = tokio::process::Command::new(cli);
        version.arg("--version");
        #[cfg(test)]
        if let Some(fixture) = &self.answer_fixture {
            version = tokio::process::Command::new(cli);
            version.args(&fixture.arguments);
        }
        if answer_version(version, cancellation, deadline).await? != REQUIRED_LEMONADE {
            return Err("local_runtime_unavailable");
        }
        if let Some(flm) = &self.flm {
            let mut version = tokio::process::Command::new(flm);
            version.args(["version", "--json"]);
            if answer_version(version, cancellation, deadline).await? != REQUIRED_FLM {
                return Err("local_runtime_unavailable");
            }
        }
        if answer_ready(address, cancellation, deadline).await? {
            if let Some(error) = preparation_interrupted(cancellation, deadline) {
                return Err(error);
            }
            return Ok(());
        }
        if let Some(error) = preparation_interrupted(cancellation, deadline) {
            return Err(error);
        }

        let spawn = || -> Result<RuntimeProcess, &'static str> {
            let mut command = Command::new(server);
            if let Some(root) = binaries.root.as_deref() {
                command
                    .arg(".")
                    .arg("--port")
                    .arg(LEMONADE_PORT.to_string())
                    .current_dir(root)
                    .env("LEMONADE_API_KEY", "lumen-local");
            }
            #[cfg(test)]
            if let Some(fixture) = &self.answer_fixture {
                command.args(&fixture.server_arguments);
            }
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000);
            }
            let mut child = command.spawn().map_err(|_| "local_runtime_unavailable")?;
            #[cfg(windows)]
            let job = match super::supervisor::assign_kill_on_close_job(&child) {
                Ok(job) => job,
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("local_runtime_unavailable");
                }
            };
            Ok(RuntimeProcess {
                child,
                #[cfg(windows)]
                job: job.0 as isize,
            })
        };
        let mut owned = None;
        let readiness_deadline = deadline.min(tokio::time::Instant::now() + Duration::from_secs(8));
        loop {
            if let Some(error) = preparation_interrupted(cancellation, deadline) {
                return Err(error);
            }
            if tokio::time::Instant::now() >= readiness_deadline {
                return Err("local_runtime_unavailable");
            }
            // Management may replace the process, or it may exit during an async wait.
            if owned.is_none() && !self.answer_process_alive()? {
                owned = Some(spawn()?);
            }
            if let Some(process) = &mut owned
                && process
                    .child
                    .try_wait()
                    .map_err(|_| "local_runtime_unavailable")?
                    .is_some()
            {
                return Err("local_runtime_unavailable");
            }
            if answer_ready(address, cancellation, deadline).await? {
                if let Some(error) = preparation_interrupted(cancellation, deadline) {
                    return Err(error);
                }
                if let Some(process) = owned.take() {
                    let mut current = self
                        .process
                        .lock()
                        .map_err(|_| "local_runtime_unavailable")?;
                    if current.as_mut().is_some_and(|process| {
                        process
                            .child
                            .try_wait()
                            .is_ok_and(|status| status.is_none())
                    }) {
                        // TCP readiness cannot identify which competing process serves this port.
                        return Err("local_runtime_unavailable");
                    }
                    *current = Some(process);
                }
                return Ok(());
            }
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err("cancelled"),
                _ = tokio::time::sleep_until(deadline) => return Err("request_timeout"),
                _ = tokio::time::sleep_until(readiness_deadline.min(tokio::time::Instant::now() + Duration::from_millis(100))) => {},
            }
        }
    }

    /// Discovers provisioned and system runtime paths without starting a local process.
    pub fn detect(app_data: Option<PathBuf>) -> Self {
        let system_root = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("lemonade_server/bin"));
        let system_cli = known_executable(
            system_root.as_ref().map(|path| path.join("lemonade.exe")),
            &["lemonade.exe"],
        );
        let system_server = known_executable(
            system_root
                .as_ref()
                .map(|path| path.join("LemonadeServer.exe")),
            &["lemond.exe", "LemonadeServer.exe"],
        );
        let flm = known_executable(
            env::var_os("ProgramFiles")
                .map(PathBuf::from)
                .map(|path| path.join("flm/flm.exe")),
            &["flm.exe"],
        );
        let mistral_rs = executable_on_path(&["mistralrs-server.exe", "mistralrs.exe"]);
        Self {
            provisioning_root: app_data.map(|path| path.join("provisioning")),
            system_cli,
            system_server,
            flm,
            mistral_rs,
            process: Mutex::new(None),
            answer_startup: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            answer_fixture: None,
        }
    }

    fn binaries(&self) -> RuntimeBinaries {
        if let Some((_, root)) = self
            .provisioning_root
            .as_deref()
            .and_then(super::provisioning::current_runtime_path)
        {
            return RuntimeBinaries {
                cli: Some(root.join("lemonade.exe")),
                server: Some(root.join("lemond.exe")),
                root: Some(root),
            };
        }
        RuntimeBinaries {
            cli: self.system_cli.clone(),
            server: self.system_server.clone(),
            root: None,
        }
    }

    fn accelerator(&self) -> String {
        let nvidia = executable_on_path(&["nvidia-smi.exe"])
            .and_then(|binary| {
                let mut command = Command::new(binary);
                command.args(["--query-gpu=name", "--format=csv,noheader"]);
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x0800_0000);
                }
                command.output().ok()
            })
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .filter(|value| !value.is_empty());
        if self.flm.is_some() {
            match nvidia {
                Some(gpu) => format!("AMD Ryzen AI NPU + {gpu}"),
                None => "AMD Ryzen AI NPU".to_owned(),
            }
        } else {
            nvidia.unwrap_or_else(|| "CPU".to_owned())
        }
    }

    pub fn health(&self) -> LocalRuntimeHealth {
        let binaries = self.binaries();
        let accelerator = self.accelerator();
        let profile = profile_for(self.flm.is_some(), &accelerator);
        let lemonade_version = binaries.cli.as_deref().and_then(|binary| {
            fs::metadata(binary).ok()?;
            command_output(binary, &["--version"])
        });
        let flm_version = self
            .flm
            .as_deref()
            .and_then(|binary| command_output(binary, &["version", "--json"]));
        let mistral_version = self
            .mistral_rs
            .as_deref()
            .and_then(|binary| command_output(binary, &["--version"]));
        let running = lemonade_ready();
        let lemonade_compatible =
            binaries.server.is_some() && lemonade_version.as_deref() == Some(REQUIRED_LEMONADE);
        let flm_compatible = self.flm.is_none() || flm_version.as_deref() == Some(REQUIRED_FLM);
        let compatible = lemonade_compatible && flm_compatible;
        let detail = if binaries.server.is_none() {
            Some("The Lemonade runtime is not installed".to_owned())
        } else if !lemonade_compatible {
            Some(format!(
                "Lemonade {REQUIRED_LEMONADE} is required for local answers"
            ))
        } else if !flm_compatible {
            Some(format!(
                "FLM {REQUIRED_FLM} is required for the qualified NPU profile"
            ))
        } else if !running {
            Some("Lemonade is installed but its loopback API is stopped".to_owned())
        } else {
            None
        };
        LocalRuntimeHealth {
            profile,
            state: if !compatible {
                "update-required"
            } else if running {
                "ready"
            } else {
                "stopped"
            },
            accelerator,
            answer_model: "extra.Qwen3.5-4B-UD-Q4_K_XL.gguf",
            embedding_model: "extra.nomic-embed-text-v1.Q4_K_S.gguf",
            transcription_model: "whisper-v3:turbo",
            base_url: "http://127.0.0.1:13305/v1",
            lemonade: component(
                binaries.server.as_deref(),
                lemonade_version,
                REQUIRED_LEMONADE,
            ),
            flm: component(self.flm.as_deref(), flm_version, REQUIRED_FLM),
            mistral_rs: component(self.mistral_rs.as_deref(), mistral_version, "0.9.0"),
            detail,
        }
    }

    /// Starts or reuses a healthy runtime, rejecting management startup during answer preparation.
    pub fn start(&self) -> Result<(), String> {
        // Synchronous management callers must never block a Tokio worker on answer startup.
        let _startup = self.answer_startup.try_lock().map_err(|_| {
            "The local runtime is already preparing. Retry when preparation finishes.".to_owned()
        })?;
        let health = self.health();
        if health.lemonade.state != "ready" || health.flm.state == "update-required" {
            return Err(health
                .detail
                .unwrap_or_else(|| "The local AI runtime must be updated".to_owned()));
        }
        if lemonade_ready() {
            return Ok(());
        }
        let binaries = self.binaries();
        let binary = binaries
            .server
            .as_ref()
            .ok_or_else(|| "The Lemonade runtime is not installed".to_owned())?;
        let mut command = Command::new(binary);
        if let Some(root) = binaries.root.as_deref() {
            command
                .arg(".")
                .arg("--port")
                .arg(LEMONADE_PORT.to_string())
                .current_dir(root)
                .env("LEMONADE_API_KEY", "lumen-local");
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("Could not start Lemonade: {error}"))?;
        #[cfg(windows)]
        let job = super::supervisor::assign_kill_on_close_job(&child)?;
        *self
            .process
            .lock()
            .map_err(|_| "Local runtime state is poisoned")? = Some(RuntimeProcess {
            child,
            #[cfg(windows)]
            job: job.0 as isize,
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while !lemonade_ready() {
            if std::time::Instant::now() >= deadline {
                return Err("Lemonade did not open its loopback API".to_owned());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    }

    /// Applies local, auto, or cloud warm-state policy under shared startup admission.
    pub fn apply_mode(&self, mode: &str, keep_warm: bool) -> Result<(), String> {
        match mode {
            "local" => self.start(),
            "auto" if keep_warm => self.start(),
            "auto" => Ok(()),
            "cloud" if keep_warm => self.start(),
            "cloud" => {
                // Do not acknowledge Stop while preparation can still adopt a new child.
                let _startup = self.answer_startup.try_lock().map_err(|_| {
                    "The local runtime is already preparing. Retry when preparation finishes."
                        .to_owned()
                })?;
                *self
                    .process
                    .lock()
                    .map_err(|_| "Local runtime state is poisoned")? = None;
                Ok(())
            }
            _ => Err("Unsupported runtime mode".to_owned()),
        }
    }
}

#[cfg(test)]
#[path = "local_runtime_answer_tests.rs"]
mod answer_preparation_tests;

#[tauri::command]
pub fn local_runtime_health(state: State<'_, LocalRuntimeSupervisor>) -> LocalRuntimeHealth {
    state.inner().health()
}

#[tauri::command]
pub fn set_local_runtime_mode(
    mode: String,
    keep_warm: bool,
    state: State<'_, LocalRuntimeSupervisor>,
) -> Result<(), String> {
    state.inner().apply_mode(&mode, keep_warm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hardware_profiles_prefer_qualified_accelerators() {
        assert_eq!(profile_for(true, "AMD Ryzen AI NPU"), "laptop-amd-npu");
        assert_eq!(
            profile_for(false, "NVIDIA GeForce RTX 5070 Ti"),
            "desktop-nvidia-cuda"
        );
        assert_eq!(profile_for(false, "CPU"), "generic-local");
    }

    #[test]
    fn component_requires_the_pinned_version() {
        assert_eq!(
            component(
                Some(Path::new("runtime.exe")),
                Some("0.9.43".to_owned()),
                "0.9.46"
            )
            .state,
            "update-required"
        );
        assert_eq!(component(None, None, "0.9.46").state, "missing");
    }

    #[test]
    fn parses_plain_and_json_version_output() {
        assert_eq!(parse_version("Lemonade 11.5.1"), Some("11.5.1".to_owned()));
        assert_eq!(
            parse_version(r#"{\"version\": \"0.9.43\"}"#),
            Some("0.9.43".to_owned())
        );
    }
}
