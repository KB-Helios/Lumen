use lumen_lib::provider_switcher::client::CliproxyClient;
use lumen_lib::provider_switcher::config::minimal_yaml;
use std::io::{Read, Write};
use std::net::TcpListener;

#[test]
#[cfg(windows)]
fn pinned_executable_serves_isolated_authenticated_management() {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    struct Fixture {
        child: std::process::Child,
        directory: std::path::PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let prefix = std::env::temp_dir().join("lumen-proxy-native-");
            assert!(
                self.directory
                    .to_string_lossy()
                    .starts_with(prefix.to_string_lossy().as_ref())
            );
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    let directory =
        std::env::temp_dir().join(format!("lumen-proxy-native-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let auth_dir = directory.join("auths");
    std::fs::create_dir(&auth_dir).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let key = uuid::Uuid::new_v4().to_string();
    let client_key = uuid::Uuid::new_v4().to_string();
    let yaml = minimal_yaml(
        &auth_dir.to_string_lossy().replace('\\', "/"),
        &key,
        &client_key,
    )
    .replace("port: 8317", &format!("port: {port}"));
    let config = directory.join("config.yaml");
    std::fs::write(&config, yaml).unwrap();
    let executable = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries/cliproxy-sidecar-x86_64-pc-windows-msvc.exe");
    let mut command = Command::new(executable);
    command
        .args(["-config", config.to_str().unwrap()])
        .current_dir(&directory)
        .env("HOME", &directory)
        .env("USERPROFILE", &directory)
        .env("APPDATA", &directory)
        .env("LOCALAPPDATA", &directory)
        .env("XDG_CONFIG_HOME", &directory)
        .env_remove("MANAGEMENT_PASSWORD")
        .env_remove("CLIPROXY_MGMT_KEY")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.creation_flags(0x0800_0000);
    let mut fixture = Fixture {
        child: command.spawn().expect("staged executable starts"),
        directory,
    };
    let base = format!("http://127.0.0.1:{port}/v8/management");
    let client = CliproxyClient::with_base(base.clone(), key);
    let deadline = Instant::now() + Duration::from_secs(15);
    let config = loop {
        if let Ok(config) = tauri::async_runtime::block_on(client.get_config()) {
            break config;
        }
        assert!(
            fixture.child.try_wait().unwrap().is_none(),
            "proxy exited before readiness"
        );
        assert!(
            Instant::now() < deadline,
            "proxy management readiness deadline"
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(
        !serde_json::to_string(&config)
            .unwrap()
            .contains(&client_key)
    );
    let credentials = tauri::async_runtime::block_on(client.list_credentials()).unwrap();
    assert_eq!(
        serde_json::to_value(credentials).unwrap()["files"],
        serde_json::json!([])
    );
    let unauthorized = CliproxyClient::with_base(base, "incorrect-key".to_owned());
    assert!(
        tauri::async_runtime::block_on(unauthorized.get_config())
            .unwrap_err()
            .contains("401")
    );
}

#[test]
fn minimal_config_pins_loopback() {
    let yaml = minimal_yaml("/tmp/auths", "mgmt-123", "client-abc");
    assert!(yaml.contains("127.0.0.1"));
    assert!(yaml.contains("allow-remote: false"));
    assert!(yaml.contains("disable-control-panel: true"));
    assert!(!yaml.contains("your-api-key"));
}

/// Serves exactly one HTTP response on loopback, asserting the method, path,
/// and Bearer key. Returns the `/v8/management` base URL plus the server thread.
fn serve_once(
    expected_method: &str,
    expected_path: &str,
    mgmt_key: &str,
    body: &str,
) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
    let port = listener.local_addr().expect("mock addr").port();
    let expected_method = expected_method.to_owned();
    let expected_path = expected_path.to_owned();
    let mgmt_key = mgmt_key.to_owned();
    let body = body.to_owned();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept mock request");
        let mut buf = [0u8; 8192];
        let read = stream.read(&mut buf).expect("read mock request");
        let request = String::from_utf8_lossy(&buf[..read]).into_owned();
        assert!(
            request.starts_with(&format!("{expected_method} {expected_path} ")),
            "unexpected request line: {request}"
        );
        let request_lower = request.to_lowercase();
        assert!(
            request_lower.contains(&format!(
                "authorization: bearer {}",
                mgmt_key.to_lowercase()
            )),
            "missing bearer auth: {request}"
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream
            .write_all(response.as_bytes())
            .expect("write mock response");
    });
    (format!("http://127.0.0.1:{port}/v8/management"), handle)
}

#[test]
fn client_base_is_loopback_v8() {
    let client = CliproxyClient::new("mgmt-123".to_owned());
    assert_eq!(client.base(), "http://127.0.0.1:8317/v8/management");
}

#[test]
fn get_config_sends_bearer_to_v8_route() {
    let (base, server) = serve_once(
        "GET",
        "/v8/management/config",
        "mgmt-123",
        r#"{"routing":{"strategy":"round-robin"}}"#,
    );
    let client = CliproxyClient::with_base(base, "mgmt-123".to_owned());
    let value = tauri::async_runtime::block_on(client.get_config()).expect("get_config");
    assert_eq!(value.routing_strategy.as_deref(), Some("round-robin"));
    server.join().expect("mock server");
}

#[test]
fn patch_config_sends_bearer_to_v8_route() {
    let (base, server) = serve_once(
        "PATCH",
        "/v8/management/config",
        "mgmt-123",
        r#"{"ok":true}"#,
    );
    let client = CliproxyClient::with_base(base, "mgmt-123".to_owned());
    let value = tauri::async_runtime::block_on(
        client.patch_config(serde_json::json!({"routing": {"retry": {"request-retry": 0}}})),
    )
    .expect("patch_config");
    assert!(value.ok);
    server.join().expect("mock server");
}

#[test]
fn list_credentials_sends_bearer_to_v8_route() {
    let (base, server) = serve_once(
        "GET",
        "/v8/management/credentials",
        "mgmt-123",
        r#"{"files":[]}"#,
    );
    let client = CliproxyClient::with_base(base, "mgmt-123".to_owned());
    let value = tauri::async_runtime::block_on(client.list_credentials()).expect("list");
    assert!(value.files.is_empty());
    server.join().expect("mock server");
}

#[test]
fn oauth_auth_url_sends_bearer_and_maps_start() {
    let (base, server) = serve_once(
        "GET",
        "/v8/management/oauth/auth-url?provider=codex",
        "mgmt-123",
        r#"{"status":"ok","url":"https://example.com/auth","state":"state-123","user_code":"ABCD-1234"}"#,
    );
    let client = CliproxyClient::with_base(base, "mgmt-123".to_owned());
    let start = tauri::async_runtime::block_on(client.oauth_auth_url("codex")).expect("auth url");
    assert_eq!(start.url, "https://example.com/auth");
    assert_eq!(start.state, "state-123");
    assert_eq!(start.user_code.as_deref(), Some("ABCD-1234"));
    server.join().expect("mock server");
}

#[test]
fn oauth_status_poll_reports_pending() {
    let (base, server) = serve_once(
        "GET",
        "/v8/management/oauth/status?state=state-123",
        "mgmt-123",
        r#"{"status":"wait"}"#,
    );
    let client = CliproxyClient::with_base(base, "mgmt-123".to_owned());
    let poll = tauri::async_runtime::block_on(client.oauth_status("state-123")).expect("poll");
    assert!(!poll.done);
    assert_eq!(poll.error, None);
    server.join().expect("mock server");
}

#[test]
fn oauth_cancel_reports_sidecar_flag() {
    let (base, server) = serve_once(
        "DELETE",
        "/v8/management/oauth/session?state=state-123",
        "mgmt-123",
        r#"{"status":"ok","cancelled":true}"#,
    );
    let client = CliproxyClient::with_base(base, "mgmt-123".to_owned());
    let cancelled =
        tauri::async_runtime::block_on(client.oauth_cancel("state-123")).expect("cancel");
    assert!(cancelled);
    server.join().expect("mock server");
}

#[test]
fn oauth_linked_matches_credential_metadata() {
    let (base, server) = serve_once(
        "GET",
        "/v8/management/credentials",
        "mgmt-123",
        r#"{"files":[{"name":"codex.json","type":"codex","provider":"codex","disabled":false}]}"#,
    );
    let client = CliproxyClient::with_base(base, "mgmt-123".to_owned());
    let linked = tauri::async_runtime::block_on(client.oauth_linked("codex")).expect("linked");
    assert!(linked);
    server.join().expect("mock server");
}

#[test]
fn api_key_usage_aggregates_counters_without_secret_keys() {
    let (base, server) = serve_once(
        "GET",
        "/v8/management/observability/usage/api-keys",
        "mgmt-123",
        r#"{"codex":{"https://api.openai.com|sk-audit-secret":{"success":2,"failed":1,"nested":{"token":"sk-audit-secret"}},"second":{"success":1,"failed":1}},"sk-audit-secret":{"key":{"success":9}}}"#,
    );
    let client = CliproxyClient::with_base(base, "mgmt-123".to_owned());
    let value = tauri::async_runtime::block_on(client.api_key_usage()).expect("usage");
    assert!(
        !serde_json::to_string(&value)
            .unwrap()
            .contains("sk-audit-secret")
    );
    assert_eq!(value[0].success, 3);
    assert_eq!(value[0].failed, 2);
    assert_eq!(value[0].total, 5);
    server.join().expect("mock server");
}

#[test]
fn management_config_excludes_secret_fields() {
    let (base, server) = serve_once(
        "GET",
        "/v8/management/config",
        "mgmt-123",
        r#"{"routing":{"strategy":"round-robin","token":"sk-audit-secret"},"api-keys":{"codex":[{"name":"sk-audit-secret","keys":[{"api-key":"sk-audit-secret"},{"api-key":"sk-audit-secret"}]}]},"observability":{"usage":{"usage-statistics-enabled":true}},"remote-management":{"secret-key":"sk-audit-secret"}}"#,
    );
    let client = CliproxyClient::with_base(base, "mgmt-123".to_owned());
    let safe = tauri::async_runtime::block_on(client.get_config()).unwrap();
    assert!(
        !serde_json::to_string(&safe)
            .unwrap()
            .contains("sk-audit-secret")
    );
    assert_eq!(
        safe.provider_counts
            .iter()
            .map(|row| (row.provider.as_str(), row.count))
            .collect::<Vec<_>>(),
        vec![("codex", 2)]
    );
    assert!(safe.usage_statistics_enabled);
    server.join().unwrap();
}

#[test]
fn management_patch_response_excludes_secrets() {
    let (base, server) = serve_once(
        "PATCH",
        "/v8/management/config",
        "mgmt-123",
        r#"{"ok":true,"api-keys":["sk-audit-secret"],"nested":{"token":"sk-audit-secret"}}"#,
    );
    let client = CliproxyClient::with_base(base, "mgmt-123".to_owned());
    let safe = tauri::async_runtime::block_on(client.patch_config(serde_json::json!({}))).unwrap();
    assert!(
        !serde_json::to_string(&safe)
            .unwrap()
            .contains("sk-audit-secret")
    );
    server.join().unwrap();
}

#[test]
fn credential_metadata_excludes_secret_contents() {
    let (base, server) = serve_once(
        "GET",
        "/v8/management/credentials",
        "mgmt-123",
        r#"{"files":[{"type":"codex","disabled":false,"name":"sk-audit-secret.json","token":"sk-audit-secret","nested":{"sk-audit-secret":"secret"}}]}"#,
    );
    let client = CliproxyClient::with_base(base, "mgmt-123".to_owned());
    let safe = tauri::async_runtime::block_on(client.list_credentials()).unwrap();
    assert!(
        !serde_json::to_string(&safe)
            .unwrap()
            .contains("sk-audit-secret")
    );
    assert_eq!(
        safe.files
            .iter()
            .map(|file| (file.provider.as_str(), file.disabled))
            .collect::<Vec<_>>(),
        vec![("codex", false)]
    );
    server.join().unwrap();
}

#[test]
fn oauth_error_excludes_upstream_secret_contents() {
    let (base, server) = serve_once(
        "GET",
        "/v8/management/oauth/status?state=s",
        "mgmt-123",
        r#"{"status":"error","error":"invalid token sk-audit-secret"}"#,
    );
    let client = CliproxyClient::with_base(base, "mgmt-123".to_owned());
    let safe = tauri::async_runtime::block_on(client.oauth_status("s")).unwrap();
    assert!(
        !serde_json::to_string(&safe)
            .unwrap()
            .contains("sk-audit-secret")
    );
    assert_eq!(safe.error.as_deref(), Some("Authentication failed"));
    server.join().unwrap();
}
