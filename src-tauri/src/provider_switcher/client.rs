use serde_json::Value;
use tauri::Manager;

/// Fixed loopback-only base for the Go management API (`/v8` only; `/v0` is
/// deprecated and must not be used).
pub const MANAGEMENT_BASE: &str = "http://127.0.0.1:8317/v8/management";

/// Bearer-auth HTTP client for the sidecar management surface.
#[derive(Debug, Clone)]
pub struct CliproxyClient {
    base: String,
    mgmt_key: String,
    client: reqwest::Client,
}

impl CliproxyClient {
    pub fn new(mgmt_key: String) -> Self {
        Self {
            base: MANAGEMENT_BASE.to_owned(),
            mgmt_key,
            client: reqwest::Client::new(),
        }
    }

    /// Test-only override for the base URL (mock servers bind an ephemeral
    /// port; production always uses [`MANAGEMENT_BASE`]).
    pub fn with_base(base: String, mgmt_key: String) -> Self {
        Self {
            base,
            mgmt_key,
            client: reqwest::Client::new(),
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    async fn get(&self, path: &str) -> Result<Value, String> {
        let response = self
            .client
            .get(format!("{}{path}", self.base))
            .bearer_auth(&self.mgmt_key)
            .send()
            .await
            .map_err(|error| format!("Cliproxy request failed: {error}"))?;
        check_status(response).await
    }

    /// `GET /v8/management/config` — persisted config in the v8 layout.
    pub async fn get_config(&self) -> Result<Value, String> {
        self.get("/config").await
    }

    /// `PATCH /v8/management/config` — merges objects, replaces lists/scalars.
    /// The patch value is sent directly (no `{value:}` envelope).
    pub async fn patch_config(&self, patch: Value) -> Result<Value, String> {
        let response = self
            .client
            .patch(format!("{}/config", self.base))
            .bearer_auth(&self.mgmt_key)
            .json(&patch)
            .send()
            .await
            .map_err(|error| format!("Cliproxy request failed: {error}"))?;
        check_status(response).await
    }

    /// `GET /v8/management/credentials` — credential-file metadata.
    /// Returns the sidecar payload (file metadata/status, never key material
    /// fetched out-of-band); callers must not log or forward secrets.
    pub async fn list_credentials(&self) -> Result<Value, String> {
        self.get("/credentials").await
    }
}

async fn check_status(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Cliproxy returned HTTP {status}"));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Cliproxy returned invalid JSON: {error}"))
}

/// Resolves the management key without ever exposing it to the webview:
/// `CLIPROXY_MGMT_KEY` env (dev/tests) first, then `<app-data>/cliproxy/mgmt.key`.
pub fn resolve_mgmt_key(app: &tauri::AppHandle) -> Result<String, String> {
    if let Ok(key) = std::env::var("CLIPROXY_MGMT_KEY")
        && !key.trim().is_empty()
    {
        return Ok(key);
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("App data unavailable: {error}"))?;
    let key_path = data_dir.join("cliproxy").join("mgmt.key");
    let key = std::fs::read_to_string(&key_path)
        .map_err(|_| "Cliproxy management key is not configured".to_owned())?;
    let key = key.trim().to_owned();
    if key.is_empty() {
        return Err("Cliproxy management key is not configured".to_owned());
    }
    Ok(key)
}

fn client_for(app: &tauri::AppHandle) -> Result<CliproxyClient, String> {
    Ok(CliproxyClient::new(resolve_mgmt_key(app)?))
}

#[tauri::command]
pub async fn cliproxy_get_config(app: tauri::AppHandle) -> Result<Value, String> {
    client_for(&app)?.get_config().await
}

#[tauri::command]
pub async fn cliproxy_patch_config(app: tauri::AppHandle, patch: Value) -> Result<Value, String> {
    client_for(&app)?.patch_config(patch).await
}

#[tauri::command]
pub async fn cliproxy_list_credentials(app: tauri::AppHandle) -> Result<Value, String> {
    client_for(&app)?.list_credentials().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_is_loopback_v8() {
        let client = CliproxyClient::new("mgmt-123".to_owned());
        assert_eq!(client.base(), "http://127.0.0.1:8317/v8/management");
    }
}
