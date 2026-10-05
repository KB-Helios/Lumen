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

    /// `GET /v8/management/oauth/auth-url?provider=` — starts a sidecar OAuth
    /// flow and returns the sign-in URL plus the opaque session state.
    pub async fn oauth_auth_url(&self, provider: &str) -> Result<OAuthStart, String> {
        let provider = provider.trim();
        if provider.is_empty() {
            return Err("OAuth provider is required".to_owned());
        }
        let value = self
            .get(&format!(
                "/oauth/auth-url?provider={}",
                encode_query(provider)
            ))
            .await?;
        OAuthStart::from_sidecar(&value)
    }

    /// `GET /v8/management/oauth/status?state=` — polls a pending OAuth
    /// session. Maps the sidecar `wait`/`ok`/`error` envelope to `{done, error?}`.
    pub async fn oauth_status(&self, state: &str) -> Result<OAuthPoll, String> {
        let state = state.trim();
        if state.is_empty() {
            return Err("OAuth state is required".to_owned());
        }
        let value = self
            .get(&format!("/oauth/status?state={}", encode_query(state)))
            .await?;
        Ok(map_oauth_status(&value))
    }

    /// `DELETE /v8/management/oauth/session?state=` — cancels a pending OAuth
    /// session. Returns the sidecar `cancelled` flag (false when the state was
    /// already gone).
    pub async fn oauth_cancel(&self, state: &str) -> Result<bool, String> {
        let state = state.trim();
        if state.is_empty() {
            return Err("OAuth state is required".to_owned());
        }
        let response = self
            .client
            .delete(format!(
                "{}/oauth/session?state={}",
                self.base,
                encode_query(state)
            ))
            .bearer_auth(&self.mgmt_key)
            .send()
            .await
            .map_err(|error| format!("Cliproxy request failed: {error}"))?;
        let value = check_status(response).await?;
        Ok(value
            .get("cancelled")
            .and_then(Value::as_bool)
            .unwrap_or(false))
    }

    /// Boolean link status for one OAuth provider, derived from
    /// `GET /v8/management/credentials` file metadata (`type`/`provider`
    /// fields, ignoring disabled entries). Key material is never read.
    pub async fn oauth_linked(&self, provider: &str) -> Result<bool, String> {
        let provider = provider.trim();
        if provider.is_empty() {
            return Err("OAuth provider is required".to_owned());
        }
        let value = self.list_credentials().await?;
        Ok(credentials_linked(&value, provider))
    }

    /// `GET /v8/management/observability/usage/api-keys` — per-key request
    /// counters (`{provider: {"base_url|api_key": {success, failed, ...}}}`).
    /// Composite map keys embed key material, so the frontend folds only
    /// provider names and counters out of this payload.
    pub async fn api_key_usage(&self) -> Result<Value, String> {
        self.get("/observability/usage/api-keys").await
    }
}

/// Percent-encodes one query-string value (RFC 3986 unreserved set passes
/// through; everything else becomes `%XX`). Keeps OAuth `provider`/`state`
/// values safe without adding a URL-encoding dependency.
fn encode_query(value: &str) -> String {
    const UNRESERVED: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~";
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if UNRESERVED.contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Sign-in URL plus opaque session state handed to the webview. `user_code`
/// serializes as `userCode` for the `AuthCenterPanel` contract; no secret is
/// ever part of this payload.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStart {
    pub url: String,
    pub state: String,
    pub user_code: Option<String>,
}

impl OAuthStart {
    fn from_sidecar(value: &Value) -> Result<Self, String> {
        let url = value
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
        let state = value
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
        if url.is_empty() || state.is_empty() {
            return Err("Cliproxy returned an incomplete OAuth URL".to_owned());
        }
        let user_code = value
            .get("user_code")
            .and_then(Value::as_str)
            .map(|code| code.trim().to_owned())
            .filter(|code| !code.is_empty());
        Ok(Self {
            url,
            state,
            user_code,
        })
    }
}

/// Boolean-only poll result for the webview (`AuthCenterPanel` contract).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct OAuthPoll {
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Maps the sidecar `{"status": "wait"|"ok"|"error", "error"?: ...}` envelope.
fn map_oauth_status(value: &Value) -> OAuthPoll {
    match value.get("status").and_then(Value::as_str).unwrap_or("") {
        "ok" => OAuthPoll {
            done: true,
            error: None,
        },
        "error" => OAuthPoll {
            done: false,
            error: Some(
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(|message| message.trim().to_owned())
                    .filter(|message| !message.is_empty())
                    .unwrap_or_else(|| "Authentication failed".to_owned()),
            ),
        },
        _ => OAuthPoll {
            done: false,
            error: None,
        },
    }
}

/// Provider aliases accepted when matching credential-file entries
/// (`type`/`provider` fields, case-insensitive).
fn provider_aliases(provider: &str) -> Vec<String> {
    match provider.to_lowercase().as_str() {
        "codex" | "chatgpt" | "openai" => vec![
            "codex".to_owned(),
            "chatgpt".to_owned(),
            "openai".to_owned(),
        ],
        "claude" | "anthropic" => vec!["claude".to_owned(), "anthropic".to_owned()],
        "xai" | "grok" => vec!["xai".to_owned(), "grok".to_owned()],
        other => vec![other.to_owned()],
    }
}

fn entry_matches_provider(entry: &Value, aliases: &[String]) -> bool {
    if entry
        .get("disabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return false;
    }
    for field in ["type", "provider"] {
        let candidate = entry
            .get(field)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_lowercase();
        if !candidate.is_empty() && aliases.iter().any(|alias| alias == &candidate) {
            return true;
        }
    }
    false
}

/// Scans a `GET /credentials` payload (`{"files": [...]}` or a bare array)
/// for a non-disabled entry belonging to `provider`.
fn credentials_linked(payload: &Value, provider: &str) -> bool {
    let aliases = provider_aliases(provider);
    let files = match payload {
        Value::Array(files) => files.as_slice(),
        Value::Object(_) => payload
            .get("files")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        _ => &[],
    };
    files
        .iter()
        .any(|entry| entry_matches_provider(entry, &aliases))
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

/// Starts a sidecar OAuth flow. Returns the sign-in URL plus session state;
/// secrets never cross this boundary.
#[tauri::command]
pub async fn cliproxy_oauth_auth_url(
    app: tauri::AppHandle,
    provider: String,
) -> Result<OAuthStart, String> {
    client_for(&app)?.oauth_auth_url(&provider).await
}

/// Polls a pending OAuth session until `{done: true}` or an error message.
#[tauri::command]
pub async fn cliproxy_oauth_poll(
    app: tauri::AppHandle,
    state: String,
) -> Result<OAuthPoll, String> {
    client_for(&app)?.oauth_status(&state).await
}

/// Cancels a pending OAuth session; true when the sidecar dropped the state.
#[tauri::command]
pub async fn cliproxy_oauth_cancel(app: tauri::AppHandle, state: String) -> Result<bool, String> {
    client_for(&app)?.oauth_cancel(&state).await
}

/// Boolean link status for one OAuth provider (credential metadata only).
#[tauri::command]
pub async fn cliproxy_oauth_linked(
    app: tauri::AppHandle,
    provider: String,
) -> Result<bool, String> {
    client_for(&app)?.oauth_linked(&provider).await
}

/// Pasted-token import. The sidecar only supports file-based import (`vertex`
/// service accounts), so there is no safe server-side shape for a raw pasted
/// token — OAuth sign-in is the supported path. Fails with a plain message
/// instead of writing a malformed credential file. The token is never logged.
#[tauri::command]
pub async fn cliproxy_oauth_import(provider: String, token: String) -> Result<(), String> {
    let provider = provider.trim();
    if provider.is_empty() {
        return Err("OAuth provider is required".to_owned());
    }
    if token.trim().is_empty() {
        return Err("Token is empty".to_owned());
    }
    Err(format!(
        "Token import is not supported for '{provider}'; use Sign in instead"
    ))
}

/// Per-key request counters for the Usage panel (provider names + counters
/// only; composite keys holding key material stay server-side).
#[tauri::command]
pub async fn cliproxy_usage(app: tauri::AppHandle) -> Result<Value, String> {
    client_for(&app)?.api_key_usage().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_is_loopback_v8() {
        let client = CliproxyClient::new("mgmt-123".to_owned());
        assert_eq!(client.base(), "http://127.0.0.1:8317/v8/management");
    }

    #[test]
    fn query_encoding_keeps_unreserved_and_escapes_rest() {
        assert_eq!(encode_query("codex"), "codex");
        assert_eq!(encode_query("a b+c/d"), "a%20b%2Bc%2Fd");
    }

    #[test]
    fn oauth_start_requires_url_and_state() {
        let full = serde_json::json!({
            "status": "ok",
            "url": "https://example.com/auth",
            "state": "state-123",
            "user_code": "ABCD-1234",
        });
        let start = OAuthStart::from_sidecar(&full).expect("full payload");
        assert_eq!(start.url, "https://example.com/auth");
        assert_eq!(start.state, "state-123");
        assert_eq!(start.user_code.as_deref(), Some("ABCD-1234"));
        // Webview contract: camelCase `userCode`.
        let serialized = serde_json::to_value(&start).expect("serialize");
        assert_eq!(serialized["userCode"], "ABCD-1234");

        let without_code = serde_json::json!({"url": "https://example.com/auth", "state": "s"});
        let start = OAuthStart::from_sidecar(&without_code).expect("no user code");
        assert_eq!(start.user_code, None);

        assert!(
            OAuthStart::from_sidecar(&serde_json::json!({"url": "https://example.com/auth"}))
                .is_err()
        );
    }

    #[test]
    fn oauth_status_maps_wait_ok_error() {
        assert_eq!(
            map_oauth_status(&serde_json::json!({"status": "wait"})),
            OAuthPoll {
                done: false,
                error: None
            }
        );
        assert_eq!(
            map_oauth_status(&serde_json::json!({"status": "ok"})),
            OAuthPoll {
                done: true,
                error: None
            }
        );
        assert_eq!(
            map_oauth_status(&serde_json::json!({"status": "error", "error": "denied"})),
            OAuthPoll {
                done: false,
                error: Some("denied".to_owned())
            }
        );
    }

    #[test]
    fn credentials_linked_matches_aliases_and_skips_disabled() {
        let payload = serde_json::json!({"files": [
            {"name": "codex.json", "type": "codex", "provider": "codex", "disabled": false},
            {"name": "old.json", "type": "claude", "provider": "claude", "disabled": true},
        ]});
        assert!(credentials_linked(&payload, "codex"));
        assert!(credentials_linked(&payload, "ChatGPT"));
        assert!(!credentials_linked(&payload, "claude"));
        assert!(!credentials_linked(&payload, "xai"));
        assert!(!credentials_linked(
            &serde_json::json!({"files": []}),
            "codex"
        ));
    }
}
