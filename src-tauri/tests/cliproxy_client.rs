use lumen_lib::provider_switcher::client::CliproxyClient;
use lumen_lib::provider_switcher::config::minimal_yaml;
use std::io::{Read, Write};
use std::net::TcpListener;

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
    assert_eq!(value["routing"]["strategy"], "round-robin");
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
    assert_eq!(value["ok"], true);
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
    assert!(value["files"].is_array());
    server.join().expect("mock server");
}
