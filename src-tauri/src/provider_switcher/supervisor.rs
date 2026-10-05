use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};

/// Fixed loopback port for the CLIProxyAPI Go sidecar.
pub const CLIPROXY_PORT: u16 = 8317;

/// Loopback-only health endpoint for the sidecar.
pub fn health_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/healthz")
}

struct RunningChild {
    child: Child,
    #[cfg(windows)]
    job: isize,
}

impl Drop for RunningChild {
    /// Kill and reap the child, then close its Windows Job handle when present.
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

/// Owns the `cliproxy-sidecar` process lifecycle.
///
/// The binary is fixed (packaged `cliproxy-sidecar.exe` or the staged
/// `cliproxy-sidecar-x86_64-pc-windows-msvc.exe`) with fixed `-config` args;
/// Rust never passes webview-controlled arguments to the process.
pub struct ProviderSwitcherSupervisor {
    binary: PathBuf,
    config: PathBuf,
    child: Option<RunningChild>,
}

impl ProviderSwitcherSupervisor {
    /// Select the packaged binary when present, otherwise the staged binary.
    /// Record the runtime config path without creating files or starting the process.
    pub fn new(packaged: &Path, staged: &Path, runtime_dir: &Path) -> Self {
        let binary = if packaged.is_file() {
            packaged.to_path_buf()
        } else {
            staged.to_path_buf()
        };
        let config = runtime_dir.join("config.yaml");
        Self {
            binary,
            config,
            child: None,
        }
    }

    /// Start the selected binary with the runtime config unless its child is running.
    /// Report a missing binary, process error, or Windows Job assignment failure.
    pub fn start(&mut self) -> Result<(), String> {
        if let Some(running) = self.child.as_mut() {
            let still_running = running
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none();
            if still_running {
                return Ok(());
            }
        }
        self.child = None;
        if !self.binary.is_file() {
            return Err("Cliproxy sidecar is not staged".to_owned());
        }
        if let Some(parent) = self.config.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut command = Command::new(&self.binary);
        command
            .arg("-config")
            .arg(&self.config)
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
            .map_err(|error| format!("Could not start cliproxy: {error}"))?;
        #[cfg(windows)]
        let job = crate::gateway::supervisor::assign_kill_on_close_job(&child)?;
        self.child = Some(RunningChild {
            child,
            #[cfg(windows)]
            job: job.0 as isize,
        });
        Ok(())
    }

    /// Drop the current child and start a new sidecar process.
    pub fn restart(&mut self) -> Result<(), String> {
        self.child = None;
        self.start()
    }

    /// Return whether the loopback health endpoint responds with a successful status.
    pub async fn health(&self) -> bool {
        reqwest::get(health_url(CLIPROXY_PORT))
            .await
            .is_ok_and(|response| response.status().is_success())
    }
}

/// Check sidecar health while holding the managed supervisor lock.
#[tauri::command]
pub async fn cliproxy_health(
    state: tauri::State<'_, tokio::sync::Mutex<ProviderSwitcherSupervisor>>,
) -> Result<bool, String> {
    Ok(state.lock().await.health().await)
}

/// Restart the sidecar while holding the managed supervisor lock.
#[tauri::command]
pub async fn cliproxy_restart(
    state: tauri::State<'_, tokio::sync::Mutex<ProviderSwitcherSupervisor>>,
) -> Result<(), String> {
    state.lock().await.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_url_is_loopback() {
        assert_eq!(health_url(8317), "http://127.0.0.1:8317/healthz");
    }
}
