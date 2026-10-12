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
    #[cfg(test)]
    health_port: u16,
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
            #[cfg(test)]
            health_port: CLIPROXY_PORT,
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
        check_health(self.health_endpoint()).await
    }

    fn health_endpoint(&self) -> String {
        #[cfg(test)]
        let port = self.health_port;
        #[cfg(not(test))]
        let port = CLIPROXY_PORT;
        health_url(port)
    }
}

async fn check_health(url: String) -> bool {
    let Ok(client) = crate::local_http::client(std::time::Duration::from_secs(5)) else {
        return false;
    };
    crate::local_http::response(client.get(url)).await.is_ok()
}

async fn supervisor_health(state: &tokio::sync::Mutex<ProviderSwitcherSupervisor>) -> bool {
    let url = state.lock().await.health_endpoint();
    check_health(url).await
}

/// Capture the owned endpoint under the supervisor lock, then probe without blocking restart.
#[tauri::command]
pub async fn cliproxy_health(
    state: tauri::State<'_, tokio::sync::Mutex<ProviderSwitcherSupervisor>>,
) -> Result<bool, String> {
    Ok(supervisor_health(state.inner()).await)
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
    use crate::local_http_tests as http;
    use std::time::{Duration, Instant};

    fn supervisor(base: &str) -> ProviderSwitcherSupervisor {
        let mut supervisor = ProviderSwitcherSupervisor::new(
            Path::new("unused"),
            Path::new("unused"),
            Path::new("unused"),
        );
        supervisor.health_port = reqwest::Url::parse(base).unwrap().port().unwrap();
        supervisor
    }

    #[test]
    fn local_http_stalled_health_does_not_block_restart() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (entered, ready) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            assert!(stream.read(&mut [0; 4096]).unwrap() > 0);
            entered.send(()).unwrap();
            std::thread::sleep(Duration::from_secs(6));
            let _ = stream.write_all(&http::json("{}"));
        });
        let state = std::sync::Arc::new(tokio::sync::Mutex::new(supervisor(&base)));
        tauri::async_runtime::block_on(async {
            let checking = state.clone();
            let health =
                tauri::async_runtime::spawn(async move { supervisor_health(&checking).await });
            ready.recv_timeout(Duration::from_secs(2)).unwrap();
            let restart = tokio::time::timeout(Duration::from_millis(200), async {
                state.lock().await.restart()
            })
            .await;
            health.abort();
            assert!(
                restart.is_ok(),
                "stalled health must not retain the restart mutex"
            );
            assert_eq!(
                restart.unwrap().unwrap_err(),
                "Cliproxy sidecar is not staged"
            );
        });
        server.join().unwrap();
    }

    #[test]
    fn local_http_health_has_total_deadline() {
        let (base, server) = http::server(http::json("{}"), Duration::from_secs(6));
        let began = Instant::now();
        let healthy = tauri::async_runtime::block_on(supervisor(&base).health());
        let elapsed = began.elapsed();
        server.join().unwrap();
        assert!(!healthy);
        assert!(elapsed < Duration::from_secs(6));
    }

    #[test]
    fn local_http_health_refuses_redirects() {
        let (target, target_server) = http::server(http::json("{}"), Duration::ZERO);
        let (base, server) = http::server(format!("HTTP/1.1 302 Found\r\nLocation: {target}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes(), Duration::ZERO);
        let healthy = tauri::async_runtime::block_on(supervisor(&base).health());
        server.join().unwrap();
        let redirected = target_server.join().unwrap();
        assert!(!healthy);
        assert!(redirected.is_empty());
    }

    #[test]
    fn local_http_health_bounds_response_body() {
        let mut health = Vec::new();
        for chunked in [false, true] {
            let (base, server) = http::server(http::oversized(chunked), Duration::ZERO);
            let healthy = tauri::async_runtime::block_on(supervisor(&base).health());
            server.join().unwrap();
            health.push(healthy);
        }
        assert_eq!(health, [false, false]);
    }

    #[test]
    #[ignore = "invoked only by isolated proxy regression"]
    fn local_http_proxy_probe_health() {
        assert_eq!(
            std::env::var("LUMEN_LOCAL_HTTP_PROXY_PROBE").as_deref(),
            Ok("1")
        );
        let (base, server) = http::server(http::json("{}"), Duration::ZERO);
        assert!(tauri::async_runtime::block_on(supervisor(&base).health()));
        assert!(!server.join().unwrap().is_empty());
    }

    #[test]
    fn health_url_is_loopback() {
        assert_eq!(health_url(8317), "http://127.0.0.1:8317/healthz");
    }
}
