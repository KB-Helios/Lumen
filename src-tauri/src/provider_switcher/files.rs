//! Minimal atomic file-switch engine.
//!
//! Switches provider credentials in third-party client config files the way
//! cc-switch does, minus the database: only the per-tool key fields ("floor")
//! are replaced, every other byte belongs to the user and is preserved.
//!
//! Safety rules (mirrored from the Lumen constraints):
//! - writes stay inside the caller's home dir (lexical containment check);
//! - symlinks are never followed for the target file;
//! - credential-bearing files are written `0600` on Unix;
//! - files larger than [`MAX_TEXT_BYTES`] are refused, never truncated;
//! - every write is `tmp + fsync + rename`; a `live-state.json` intent journal
//!   lets the next run discard or roll forward a crashed operation.
//!
//! Key-field tables are copied from `cc-switch/src-tauri/src/live/floor.rs`
//! (Claude `ANTHROPIC_*` floor, Codex `[model_providers.custom]`, Gemini `.env`
//! floor) and the OpenCode `provider.<id>` / OpenClaw `models.providers.<id>`
//! node conventions.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::paths;

const STATE_VERSION: u32 = 1;

/// Largest text config the engine will rewrite (mirrors the 64 KiB text
/// preview cap). Anything bigger is refused, never truncated.
pub const MAX_TEXT_BYTES: usize = 64 * 1024;

// ---------------------------------------------------------------------------
// Key-field tables (copied from cc-switch `live/floor.rs`)
// ---------------------------------------------------------------------------

/// Claude Code protocol selectors (`CLAUDE_CODE_USE_*` cannot match by prefix:
/// the same prefix also holds unrelated feature switches).
pub const CLAUDE_PROTOCOL_SELECTORS: &[&str] = &[
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
];

/// `env` prefixes that are entirely connection/auth owned.
pub const CLAUDE_FLOOR_ENV_PREFIXES: &[&str] = &["ANTHROPIC_", "AWS_", "VERTEX_REGION_"];

/// `env` key fields listed by name (besides the protocol selectors).
pub const CLAUDE_FLOOR_ENV_KEYS: &[&str] = &[
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
    "CLOUD_ML_REGION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
];

/// Whether a Claude Code `settings.json` `env` key is a key field.
pub fn claude_floor_env(key: &str) -> bool {
    CLAUDE_FLOOR_ENV_PREFIXES
        .iter()
        .any(|prefix| key.starts_with(prefix))
        || CLAUDE_PROTOCOL_SELECTORS.contains(&key)
        || CLAUDE_FLOOR_ENV_KEYS.contains(&key)
        || (key.starts_with("CLAUDE_CODE_SKIP_") && key.ends_with("_AUTH"))
}

/// Claude Code `settings.json` top-level key fields.
pub const CLAUDE_FLOOR_TOP: &[&str] = &[
    "apiKeyHelper",
    "apiBaseUrl",
    "primaryModel",
    "smallFastModel",
    "apiKey",
    "model",
    "fallbackModel",
    "modelOverrides",
    "advisorModel",
    "awsAuthRefresh",
    "awsCredentialExport",
    "gcpAuthRefresh",
];

/// Whether a Claude Code `settings.json` top-level key is a key field.
pub fn claude_floor_top(key: &str) -> bool {
    CLAUDE_FLOOR_TOP.contains(&key)
}

/// Codex `config.toml` top-level key fields; `[model_providers.custom]` is
/// additionally owned as a whole table.
pub const CODEX_FLOOR_TOP: &[&str] = &[
    "model_provider",
    "openai_base_url",
    "model",
    "review_model",
    "model_reasoning_effort",
    "plan_mode_reasoning_effort",
    "disable_response_storage",
    "model_catalog_json",
    "experimental_bearer_token",
    "base_url",
    "wire_api",
];

/// Model names nested inside the user's own tables: only these keys are
/// cleared, everything else in the table stays.
pub const CODEX_FLOOR_NESTED: &[&[&str]] = &[
    &["agents", "default_subagent_model"],
    &["agents", "default_subagent_reasoning_effort"],
    &["memories", "extract_model"],
    &["memories", "consolidation_model"],
];

/// The supplier table this engine writes into Codex live config.
pub const CODEX_PROVIDER_TABLE: &[&str] = &["model_providers", "custom"];

/// Whether a Gemini CLI `.env` key is a key field.
///
/// `GOOGLE_*` matches by prefix (all connection/auth); `GEMINI_*` must not
/// match by prefix (same prefix holds `GEMINI_CLI_HOME`, `GEMINI_SANDBOX`,
/// telemetry switches, ...).
pub fn gemini_floor_env(key: &str) -> bool {
    key.starts_with("GOOGLE_")
        || matches!(
            key,
            "GEMINI_API_KEY"
                | "GEMINI_MODEL"
                | "GEMINI_API_KEY_AUTH_MECHANISM"
                | "GEMINI_CLI_CUSTOM_HEADERS"
                | "GEMINI_DEFAULT_AUTH_TYPE"
                | "GEMINI_CLI_USE_COMPUTE_ADC"
                | "CODE_ASSIST_ENDPOINT"
                | "CODE_ASSIST_API_VERSION"
        )
}

// ---------------------------------------------------------------------------
// Hashing + atomic writes
// ---------------------------------------------------------------------------

/// SHA-256 hex of file bytes; `None` means the file does not exist.
pub fn digest(bytes: Option<&[u8]>) -> Option<String> {
    bytes.map(|b| {
        Sha256::digest(b)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    })
}

/// Read a file; missing files are `None`. Anything over [`MAX_TEXT_BYTES`] or
/// any other IO error is reported and nothing is written.
fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            if bytes.len() > MAX_TEXT_BYTES {
                return Err(format!(
                    "refusing to rewrite {}: larger than 64 KiB",
                    path.display()
                ));
            }
            Ok(Some(bytes))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot read {}: {error}", path.display())),
    }
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(format!(
            "refusing to write through symlink: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("cannot stat {}: {error}", path.display())),
    }
}

fn comparable_key(path: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::RootDir => parts.push(String::new()),
            Component::Prefix(prefix) => {
                parts.push(prefix.as_os_str().to_string_lossy().into_owned());
            }
        }
    }
    let mut key = parts.join("/");
    #[cfg(windows)]
    {
        key.make_ascii_lowercase();
    }
    key
}

/// Lexical containment check: `path` must be `home` or live under it, so a
/// crafted home can never make the engine write outside its root.
fn ensure_within_home(home: &Path, path: &Path) -> Result<(), String> {
    let home_key = comparable_key(home);
    let path_key = comparable_key(path);
    if path_key == home_key || path_key.starts_with(&format!("{home_key}/")) {
        Ok(())
    } else {
        Err(format!(
            "refusing to write outside the home dir: {}",
            path.display()
        ))
    }
}

/// Write `bytes` to a fsync'd temp file next to `path`; returns the temp path.
/// The caller publishes it with [`commit_staged`] or deletes it on failure.
fn stage_bytes(path: &Path, bytes: &[u8], private: bool) -> Result<PathBuf, String> {
    #[cfg(not(unix))]
    let _ = private;
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid path: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("invalid file name: {}", path.display()))?
        .to_string_lossy()
        .into_owned();
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut last_collision: Option<std::io::Error> = None;
    for _ in 0..16 {
        let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let tmp = parent.join(format!(
            "{name}.tmp.{}.{nanos}.{counter}",
            std::process::id()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&tmp) {
            Ok(mut file) => {
                use std::io::Write;
                let written = file
                    .write_all(bytes)
                    .and_then(|()| file.flush())
                    .and_then(|()| file.sync_all());
                drop(file);
                if let Err(error) = written {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(format!("cannot stage {}: {error}", tmp.display()));
                }
                #[cfg(unix)]
                if private {
                    use std::os::unix::fs::PermissionsExt;
                    if let Err(error) =
                        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
                    {
                        let _ = std::fs::remove_file(&tmp);
                        return Err(format!("cannot secure {}: {error}", tmp.display()));
                    }
                }
                return Ok(tmp);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_collision = Some(error);
            }
            Err(error) => {
                return Err(format!("cannot stage {}: {error}", tmp.display()));
            }
        }
    }
    Err(format!(
        "cannot pick a temp name for {}: {}",
        path.display(),
        last_collision.map(|e| e.to_string()).unwrap_or_default()
    ))
}

/// Publish a staged temp file over its target. On failure the temp file is
/// kept: a pending intent points at it and recovery rolls it forward.
fn commit_staged(tmp: &Path, path: &Path) -> Result<(), String> {
    let mut attempts = if cfg!(windows) { 3 } else { 1 };
    loop {
        match std::fs::rename(tmp, path) {
            Ok(()) => return Ok(()),
            Err(error) => {
                attempts -= 1;
                if attempts == 0 {
                    return Err(format!("cannot replace {}: {error}", path.display()));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

/// Atomic write: temp file + fsync + rename. `private` selects `0600` on Unix
/// (credential files). The temp file is removed when the replace fails.
pub fn atomic_write(path: &Path, bytes: &[u8], private: bool) -> Result<(), String> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "refusing to write {}: larger than 64 KiB",
            path.display()
        ));
    }
    reject_symlink(path)?;
    let staged = stage_bytes(path, bytes, private)?;
    commit_staged(&staged, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&staged);
    })
}

// ---------------------------------------------------------------------------
// Pending-intent journal (`live-state.json`)
// ---------------------------------------------------------------------------

/// This machine's state dir: `<home>/.lumen`, holding `live-state.json`.
#[derive(Debug, Clone)]
pub struct DeviceStore {
    root: PathBuf,
}

impl DeviceStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn for_home(home: &Path) -> Self {
        Self {
            root: paths::device_dir(home),
        }
    }

    pub fn state_path(&self) -> PathBuf {
        self.root.join("live-state.json")
    }
}

/// One file of a pending operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingFile {
    pub path: PathBuf,
    /// Hash before the operation; `None` means the file did not exist.
    pub pre: Option<String>,
    /// Hash after the operation; `None` means the operation deletes the file.
    #[serde(default)]
    pub planned: Option<String>,
    /// Staged replacement holding the new bytes; absent for deletions.
    #[serde(default)]
    pub staged: Option<PathBuf>,
}

/// A crash-recoverable write intent for one app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pending {
    pub op: String,
    pub files: Vec<PendingFile>,
    /// Provider id to record as current once the files are published.
    #[serde(default)]
    pub target: Option<String>,
    /// Set just before the first file is published; tells recovery apart a
    /// pre-publish crash (discard) from a mid-publish crash (roll forward).
    #[serde(default, skip_serializing_if = "is_false")]
    pub published: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct AppLiveState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<Pending>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    current: Option<String>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

impl AppLiveState {
    fn is_empty(&self) -> bool {
        self.pending.is_none() && self.current.is_none() && self.extra.is_empty()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct LiveState {
    #[serde(default = "state_version")]
    version: u32,
    #[serde(default)]
    apps: BTreeMap<String, AppLiveState>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

fn state_version() -> u32 {
    STATE_VERSION
}

static STATE_LOCK: Mutex<()> = Mutex::new(());

fn load_state(store: &DeviceStore) -> Result<LiveState, String> {
    let path = store.state_path();
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LiveState::default());
        }
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    match serde_json::from_slice::<LiveState>(&bytes) {
        Ok(state) => Ok(state),
        Err(error) => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let aside = path.with_file_name(format!("live-state.json.corrupt-{stamp}"));
            let _ = std::fs::rename(&path, &aside);
            let _ = error;
            Ok(LiveState::default())
        }
    }
}

fn save_state(store: &DeviceStore, state: &LiveState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("cannot serialize live state: {error}"))?;
    atomic_write(&store.state_path(), &bytes, true)
}

fn update_state<R>(
    store: &DeviceStore,
    change: impl FnOnce(&mut LiveState) -> R,
) -> Result<R, String> {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = load_state(store)?;
    let result = change(&mut state);
    state.apps.retain(|_, app| !app.is_empty());
    save_state(store, &state)?;
    Ok(result)
}

/// The unfinished intent for `app`, if any.
pub fn pending(store: &DeviceStore, app: &str) -> Result<Option<Pending>, String> {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(load_state(store)?
        .apps
        .get(app)
        .and_then(|state| state.pending.clone()))
}

fn set_pending(store: &DeviceStore, app: &str, intent: Option<Pending>) -> Result<(), String> {
    update_state(store, |state| {
        state.apps.entry(app.to_string()).or_default().pending = intent;
    })
}

/// The provider id last switched into `app` live files, if any.
pub fn current(store: &DeviceStore, app: &str) -> Result<Option<String>, String> {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(load_state(store)?
        .apps
        .get(app)
        .and_then(|state| state.current.clone()))
}

fn set_current(store: &DeviceStore, app: &str, id: Option<String>) -> Result<(), String> {
    update_state(store, |state| {
        state.apps.entry(app.to_string()).or_default().current = id;
    })
}

// ---------------------------------------------------------------------------
// Plan / stage / publish
// ---------------------------------------------------------------------------

/// A client file managed by the engine. `private` selects `0600` on Unix.
#[derive(Debug, Clone)]
pub struct LiveFile {
    pub path: PathBuf,
    pub private: bool,
}

impl LiveFile {
    pub fn private(path: PathBuf) -> Self {
        Self {
            path,
            private: true,
        }
    }

    pub fn shared(path: PathBuf) -> Self {
        Self {
            path,
            private: false,
        }
    }
}

/// A write computed in memory; nothing hits disk until [`run_operation`].
#[derive(Debug, Clone)]
pub struct Planned {
    pub file: LiveFile,
    pub pre: Option<String>,
    pub planned: Option<String>,
    pub bytes: Option<Vec<u8>>,
}

impl Planned {
    pub fn is_noop(&self) -> bool {
        self.pre == self.planned
    }
}

/// Plan a write from already-read bytes (pure; performs no IO).
pub fn plan_from(file: &LiveFile, pre_bytes: Option<Vec<u8>>, bytes: Option<Vec<u8>>) -> Planned {
    Planned {
        file: file.clone(),
        pre: digest(pre_bytes.as_deref()),
        planned: digest(bytes.as_deref()),
        bytes,
    }
}

/// Read the current bytes and plan a write in memory.
pub fn plan(file: &LiveFile, bytes: Option<Vec<u8>>) -> Result<Planned, String> {
    let pre_bytes = read_bytes(&file.path)?;
    if let Some(next) = &bytes
        && next.len() > MAX_TEXT_BYTES
    {
        return Err(format!(
            "refusing to write {}: larger than 64 KiB",
            file.path.display()
        ));
    }
    Ok(plan_from(file, pre_bytes, bytes))
}

/// Stage the new bytes into a fsync'd temp file; deletions stage nothing.
pub fn stage(planned: &Planned) -> Result<Option<PathBuf>, String> {
    let Some(bytes) = planned.bytes.as_deref() else {
        return Ok(None);
    };
    stage_bytes(&planned.file.path, bytes, planned.file.private).map(Some)
}

/// Publish one pending file: rename its staged temp over the target, or
/// delete the target when the operation removes it.
fn publish(file: &PendingFile) -> Result<(), String> {
    match &file.staged {
        Some(staged) => commit_staged(staged, &file.path),
        None => {
            if file.path.exists() {
                std::fs::remove_file(&file.path)
                    .map_err(|error| format!("cannot delete {}: {error}", file.path.display()))
            } else {
                Ok(())
            }
        }
    }
}

fn discard_all(staged: &[Option<PathBuf>]) {
    for path in staged.iter().flatten() {
        let _ = std::fs::remove_file(path);
    }
}

fn discard_pending_files(intent: &Pending) {
    for file in &intent.files {
        if let Some(staged) = &file.staged {
            let _ = std::fs::remove_file(staged);
        }
    }
}

fn pending_file(planned: &Planned, staged: Option<PathBuf>) -> PendingFile {
    PendingFile {
        path: planned.file.path.clone(),
        pre: planned.pre.clone(),
        planned: planned.planned.clone(),
        staged,
    }
}

/// Give up on a conflicting publish: with nothing published yet the intent is
/// dropped and nothing changed; mid-publish the intent stays for recovery.
fn drop_unpublished(store: &DeviceStore, app: &str, intent: &Pending) {
    discard_pending_files(intent);
    if let Err(error) = set_pending(store, app, None) {
        let _ = error;
    }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/// Outcome of rolling a crashed operation forward or discarding it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum RecoveryOutcome {
    /// Nothing was published yet; the intent was discarded.
    Discarded,
    /// Remaining files were published and the target recorded.
    RolledForward,
    /// Rolled forward except externally modified (or missing-temp) files,
    /// which were left alone.
    RolledForwardExcept { paths: Vec<PathBuf> },
    /// Nothing was published and files changed meanwhile: discarded without
    /// touching anything.
    Abandoned { paths: Vec<PathBuf> },
}

/// Finish or discard `app`'s unfinished operation.
///
/// - No file holds post-write bytes and the publish marker is unset: the
///   crash happened before publishing, so the intent is discarded.
/// - Otherwise staged temps are published over files still holding pre-write
///   bytes; externally modified files are left alone and reported.
pub fn recover(store: &DeviceStore, app: &str) -> Result<Option<RecoveryOutcome>, String> {
    let Some(intent) = pending(store, app)? else {
        return Ok(None);
    };
    enum At {
        Pre,
        Planned,
        Elsewhere,
    }
    let mut positions = Vec::with_capacity(intent.files.len());
    for file in &intent.files {
        let present = digest(read_bytes(&file.path)?.as_deref());
        positions.push(if present == file.planned {
            At::Planned
        } else if present == file.pre {
            At::Pre
        } else {
            At::Elsewhere
        });
    }
    let elsewhere = || -> Vec<PathBuf> {
        intent
            .files
            .iter()
            .zip(&positions)
            .filter(|(_, at)| matches!(at, At::Elsewhere))
            .map(|(file, _)| file.path.clone())
            .collect()
    };

    if !intent.published && !positions.iter().any(|at| matches!(at, At::Planned)) {
        discard_pending_files(&intent);
        set_pending(store, app, None)?;
        let paths = elsewhere();
        if paths.is_empty() {
            return Ok(Some(RecoveryOutcome::Discarded));
        }
        return Ok(Some(RecoveryOutcome::Abandoned { paths }));
    }

    let mut skipped = elsewhere();
    for (file, at) in intent.files.iter().zip(&positions) {
        if !matches!(at, At::Pre) {
            continue;
        }
        let staged_ok = match &file.staged {
            Some(staged) => digest(read_bytes(staged)?.as_deref()) == file.planned,
            None => file.planned.is_none(),
        };
        if !staged_ok {
            skipped.push(file.path.clone());
            continue;
        }
        publish(file)?;
    }
    if let Some(id) = &intent.target {
        set_current(store, app, Some(id.clone()))?;
    }
    discard_pending_files(&intent);
    set_pending(store, app, None)?;
    if skipped.is_empty() {
        Ok(Some(RecoveryOutcome::RolledForward))
    } else {
        Ok(Some(RecoveryOutcome::RolledForwardExcept {
            paths: skipped,
        }))
    }
}

/// Run one operation: stage every file, journal the intent, then publish each
/// file after a final pre-write check. A conflicting external edit aborts
/// before anything is published (nothing changed) or leaves the intent for
/// recovery (already publishing). Returns the files actually replaced.
pub fn run_operation(
    store: &DeviceStore,
    app: &str,
    op: &str,
    plans: &[Planned],
    target: Option<String>,
) -> Result<Vec<PathBuf>, String> {
    let active: Vec<&Planned> = plans.iter().filter(|plan| !plan.is_noop()).collect();
    if active.is_empty() {
        if let Some(id) = target {
            set_current(store, app, Some(id))?;
        }
        return Ok(Vec::new());
    }

    let _ = recover(store, app)?;

    let mut staged = Vec::with_capacity(active.len());
    for planned in &active {
        match stage(planned) {
            Ok(path) => staged.push(path),
            Err(error) => {
                discard_all(&staged);
                return Err(error);
            }
        }
    }

    let mut intent = Pending {
        op: op.to_string(),
        files: active
            .iter()
            .zip(&staged)
            .map(|(planned, staged)| pending_file(planned, staged.clone()))
            .collect(),
        target,
        published: false,
    };
    if let Err(error) = set_pending(store, app, Some(intent.clone())) {
        discard_all(&staged);
        return Err(error);
    }

    let mut changed = Vec::new();
    let mut published_any = false;
    for (index, planned) in active.iter().enumerate() {
        let present = digest(read_bytes(&planned.file.path)?.as_deref());
        if present != planned.pre {
            if !published_any {
                drop_unpublished(store, app, &intent);
                return Err(format!(
                    "{} changed while switching; nothing was written",
                    planned.file.path.display()
                ));
            }
            return Err(format!(
                "{} changed while switching; the rest rolls forward on the next run",
                planned.file.path.display()
            ));
        }
        if !intent.published {
            intent.published = true;
            if let Err(error) = set_pending(store, app, Some(intent.clone())) {
                drop_unpublished(store, app, &intent);
                return Err(error);
            }
        }
        if let Err(error) = publish(&intent.files[index]) {
            if !published_any {
                drop_unpublished(store, app, &intent);
            }
            return Err(error);
        }
        published_any = true;
        changed.push(planned.file.path.clone());
    }

    if let Some(id) = &intent.target {
        set_current(store, app, Some(id.clone()))?;
    }
    set_pending(store, app, None)?;
    Ok(changed)
}

// ---------------------------------------------------------------------------
// Provider targets
// ---------------------------------------------------------------------------

/// A provider to switch a tool to: where requests go, what authorizes them,
/// and which model name is selected.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderTarget {
    pub id: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl ProviderTarget {
    pub fn new(id: &str, base_url: &str, api_key: &str, model: &str) -> Result<Self, String> {
        for (label, value) in [
            ("id", id),
            ("base URL", base_url),
            ("API key", api_key),
            ("model", model),
        ] {
            if value.trim().is_empty() {
                return Err(format!("provider {label} cannot be empty"));
            }
            if value.contains('\n') || value.contains('\r') {
                return Err(format!("provider {label} must be a single line"));
            }
        }
        Ok(Self {
            id: id.to_string(),
            base_url: base_url.to_string(),
            api_key: api_key.to_string(),
            model: model.to_string(),
        })
    }
}

fn parse_json_object(path: &Path, bytes: &[u8]) -> Result<Value, String> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| format!("{} is not UTF-8 text", path.display()))?;
    serde_json::from_str(text).map_err(|error| format!("cannot parse {}: {error}", path.display()))
}

fn pretty(value: &Value) -> Result<Vec<u8>, String> {
    serde_json::to_string_pretty(value)
        .map(|mut text| {
            text.push('\n');
            text.into_bytes()
        })
        .map_err(|error| format!("cannot serialize config: {error}"))
}

fn validate_provider_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("provider id cannot be empty".to_owned());
    }
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("invalid provider id: {id}"));
    }
    if id.chars().any(|c| c.is_control()) {
        return Err(format!("invalid provider id: {id}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Claude Code (`settings.json`)
// ---------------------------------------------------------------------------

fn apply_claude_bytes(
    pre: Option<&[u8]>,
    path: &Path,
    target: Option<&ProviderTarget>,
) -> Result<Option<Vec<u8>>, String> {
    if target.is_none() && pre.is_none() {
        return Ok(None);
    }
    let mut value = match pre {
        None => Value::Object(Map::new()),
        Some(bytes) => parse_json_object(path, bytes)?,
    };
    let root = value
        .as_object_mut()
        .ok_or_else(|| format!("{} root must be an object", path.display()))?;
    {
        let env_value = root
            .entry("env")
            .or_insert_with(|| Value::Object(Map::new()));
        let env = env_value
            .as_object_mut()
            .ok_or_else(|| format!("{} env must be an object", path.display()))?;
        env.retain(|key, _| !claude_floor_env(key));
        if let Some(target) = target {
            env.insert(
                "ANTHROPIC_BASE_URL".to_string(),
                Value::String(target.base_url.clone()),
            );
            env.insert(
                "ANTHROPIC_AUTH_TOKEN".to_string(),
                Value::String(target.api_key.clone()),
            );
        }
    }
    let doomed: Vec<String> = root
        .keys()
        .filter(|key| claude_floor_top(key.as_str()))
        .cloned()
        .collect();
    for key in doomed {
        root.remove(&key);
    }
    if let Some(target) = target {
        root.insert("model".to_string(), Value::String(target.model.clone()));
    }
    pretty(&value).map(Some)
}

/// Point Claude Code at `target`: floor keys are replaced, user keys stay.
pub fn switch_claude(home: &Path, target: &ProviderTarget) -> Result<Vec<PathBuf>, String> {
    let path = paths::claude_settings(home);
    ensure_within_home(home, &path)?;
    reject_symlink(&path)?;
    let pre_bytes = read_bytes(&path)?;
    let bytes = apply_claude_bytes(pre_bytes.as_deref(), &path, Some(target))?;
    let store = DeviceStore::for_home(home);
    let file = LiveFile::private(path);
    run_operation(
        &store,
        "claude",
        "switch",
        &[plan_from(&file, pre_bytes, bytes)],
        Some(target.id.clone()),
    )
}

// ---------------------------------------------------------------------------
// Codex CLI (`config.toml`)
// ---------------------------------------------------------------------------

/// Parse a `[dotted.table]` header; `[[array]]` headers are left untouched
/// (returned as `None`) so unknown shapes are preserved verbatim.
fn parse_table_header(line: &str) -> Option<Vec<String>> {
    let rest = line.trim().strip_prefix('[')?;
    if rest.starts_with('[') {
        return None;
    }
    let end = rest.find(']')?;
    let after = rest[end + 1..].trim();
    if !after.is_empty() && !after.starts_with('#') {
        return None;
    }
    let parts: Vec<String> = rest[..end]
        .split('.')
        .map(|part| part.trim().trim_matches('"').trim_matches('\'').to_string())
        .collect();
    if parts.iter().any(String::is_empty) {
        return None;
    }
    Some(parts)
}

/// A `key = value` line's key; comments, blanks, and headers have none.
fn toml_key(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('[') {
        return None;
    }
    let (key, _) = trimmed.split_once('=')?;
    let key = key.trim().trim_matches('"').trim_matches('\'');
    if key.is_empty() {
        None
    } else {
        Some(key.to_string())
    }
}

fn is_codex_nested_floor(section: &[String], key: &str) -> bool {
    CODEX_FLOOR_NESTED.iter().any(|path| {
        path.len() >= 2
            && section.len() == path.len() - 1
            && section
                .iter()
                .zip(&path[..path.len() - 1])
                .all(|(got, want)| got == want)
            && key == path[path.len() - 1]
    })
}

/// Quote a TOML basic string.
fn toml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn apply_codex_toml(
    pre: Option<&[u8]>,
    path: &Path,
    target: Option<&ProviderTarget>,
) -> Result<Option<Vec<u8>>, String> {
    let text = match pre {
        Some(bytes) => std::str::from_utf8(bytes)
            .map_err(|_| format!("{} is not UTF-8 text", path.display()))?
            .to_string(),
        None => String::new(),
    };
    if target.is_none() && text.is_empty() {
        return Ok(None);
    }
    let crlf = text.contains("\r\n");
    let trailing_newline = text.is_empty() || text.ends_with('\n');
    let mut raw: Vec<&str> = if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').collect()
    };
    if text.ends_with('\n') {
        raw.pop();
    }

    // Partition root lines from tables, preserving order and comments.
    let mut root: Vec<String> = Vec::new();
    let mut tables: Vec<(Vec<String>, String, Vec<String>)> = Vec::new();
    let mut open: Option<(Vec<String>, String, Vec<String>)> = None;
    for line in raw {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(section) = parse_table_header(line) {
            if let Some(table) = open.take() {
                tables.push(table);
            }
            open = Some((section, line.to_string(), Vec::new()));
        } else if let Some((_, _, lines)) = open.as_mut() {
            lines.push(line.to_string());
        } else {
            root.push(line.to_string());
        }
    }
    if let Some(table) = open.take() {
        tables.push(table);
    }

    let mut new_root: Vec<String> = Vec::new();
    for line in root {
        if let Some(key) = toml_key(&line)
            && CODEX_FLOOR_TOP.contains(&key.as_str())
        {
            continue;
        }
        new_root.push(line);
    }
    let mut kept: Vec<(String, Vec<String>)> = Vec::new();
    for (section, header, lines) in tables {
        if section
            .iter()
            .map(String::as_str)
            .eq(CODEX_PROVIDER_TABLE.iter().copied())
        {
            continue;
        }
        let mut out = Vec::with_capacity(lines.len());
        for line in lines {
            if let Some(key) = toml_key(&line)
                && is_codex_nested_floor(&section, &key)
            {
                continue;
            }
            out.push(line);
        }
        kept.push((header, out));
    }

    if let Some(target) = target {
        while new_root.last().is_some_and(|line| line.trim().is_empty()) {
            new_root.pop();
        }
        new_root.push(format!("model_provider = {}", toml_string("custom")));
        new_root.push(format!("model = {}", toml_string(&target.model)));
        kept.push((
            "[model_providers.custom]".to_string(),
            vec![
                format!("name = {}", toml_string("custom")),
                format!("base_url = {}", toml_string(&target.base_url)),
                format!(
                    "experimental_bearer_token = {}",
                    toml_string(&target.api_key)
                ),
                "wire_api = \"responses\"".to_string(),
            ],
        ));
    }

    let mut out = new_root;
    for (header, lines) in kept {
        if !out.is_empty() && !out.last().is_some_and(|line| line.trim().is_empty()) {
            out.push(String::new());
        }
        out.push(header);
        out.extend(lines);
    }
    let separator = if crlf { "\r\n" } else { "\n" };
    let mut text = out.join(separator);
    if trailing_newline && !out.is_empty() {
        text.push_str(separator);
    }
    Ok(Some(text.into_bytes()))
}

/// Point Codex CLI at `target`: floor top keys plus the whole
/// `[model_providers.custom]` table are replaced, user tables stay.
pub fn switch_codex(home: &Path, target: &ProviderTarget) -> Result<Vec<PathBuf>, String> {
    let path = paths::codex_config(home);
    ensure_within_home(home, &path)?;
    reject_symlink(&path)?;
    let pre_bytes = read_bytes(&path)?;
    let bytes = apply_codex_toml(pre_bytes.as_deref(), &path, Some(target))?;
    let store = DeviceStore::for_home(home);
    let file = LiveFile::private(path);
    run_operation(
        &store,
        "codex",
        "switch",
        &[plan_from(&file, pre_bytes, bytes)],
        Some(target.id.clone()),
    )
}

// ---------------------------------------------------------------------------
// Gemini CLI (`.env`)
// ---------------------------------------------------------------------------

/// A dotenv variable name (`KEY=...` or `export KEY=...`); comments, blanks,
/// and unrecognized lines have none and are preserved verbatim.
fn dotenv_key(line: &str) -> Option<&str> {
    let mut text = line.trim_start();
    if text.starts_with('#') {
        return None;
    }
    text = text.strip_prefix("export ").unwrap_or(text);
    let (key, _) = text.split_once('=')?;
    let key = key.trim();
    if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        Some(key)
    } else {
        None
    }
}

fn apply_gemini_env(
    pre: Option<&[u8]>,
    path: &Path,
    target: Option<&ProviderTarget>,
) -> Result<Option<Vec<u8>>, String> {
    let text = match pre {
        Some(bytes) => std::str::from_utf8(bytes)
            .map_err(|_| format!("{} is not UTF-8 text", path.display()))?
            .to_string(),
        None => String::new(),
    };
    if target.is_none() && text.is_empty() {
        return Ok(None);
    }
    let wanted: Vec<(String, String)> = match target {
        Some(target) => vec![
            (
                "GOOGLE_GEMINI_BASE_URL".to_string(),
                target.base_url.clone(),
            ),
            ("GEMINI_API_KEY".to_string(), target.api_key.clone()),
            ("GEMINI_MODEL".to_string(), target.model.clone()),
        ],
        None => Vec::new(),
    };
    let crlf = text.contains("\r\n");
    let trailing_newline = pre.is_none() || text.is_empty() || text.ends_with('\n');
    let mut raw: Vec<&str> = if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').collect()
    };
    if text.ends_with('\n') {
        raw.pop();
    }
    let mut lines: Vec<(String, Option<String>)> = raw
        .iter()
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            (line.to_string(), dotenv_key(line).map(str::to_string))
        })
        .collect();

    // Drop every key field except the ones about to be set in place.
    lines.retain(|(_, key)| {
        key.as_deref()
            .is_none_or(|key| !gemini_floor_env(key) || wanted.iter().any(|(want, _)| want == key))
    });
    // Set each wanted key at its first occurrence (keeping `export `), drop
    // duplicates, append missing keys.
    for (key, value) in &wanted {
        let mut seen = false;
        lines.retain_mut(|(raw, existing)| {
            if existing.as_deref() != Some(key.as_str()) {
                return true;
            }
            if seen {
                return false;
            }
            seen = true;
            let export = if raw.trim_start().starts_with("export ") {
                "export "
            } else {
                ""
            };
            *raw = format!("{export}{key}={value}");
            true
        });
        if !seen {
            lines.push((format!("{key}={value}"), Some(key.clone())));
        }
    }

    let separator = if crlf { "\r\n" } else { "\n" };
    let mut out = lines
        .iter()
        .map(|(raw, _)| raw.as_str())
        .collect::<Vec<_>>()
        .join(separator);
    if trailing_newline && !lines.is_empty() {
        out.push_str(separator);
    }
    Ok(Some(out.into_bytes()))
}

/// Point Gemini CLI at `target`: floor env rows are replaced, user rows
/// (comments, order, `export ` prefixes) stay.
pub fn switch_gemini(home: &Path, target: &ProviderTarget) -> Result<Vec<PathBuf>, String> {
    let path = paths::gemini_env(home);
    ensure_within_home(home, &path)?;
    reject_symlink(&path)?;
    let pre_bytes = read_bytes(&path)?;
    let bytes = apply_gemini_env(pre_bytes.as_deref(), &path, Some(target))?;
    let store = DeviceStore::for_home(home);
    let file = LiveFile::private(path);
    run_operation(
        &store,
        "gemini",
        "switch",
        &[plan_from(&file, pre_bytes, bytes)],
        Some(target.id.clone()),
    )
}

// ---------------------------------------------------------------------------
// OpenCode (`provider.<id>`) + OpenClaw (`models.providers.<id>`)
// ---------------------------------------------------------------------------

/// Minimal OpenCode provider node for a switched target. Later tasks enrich
/// this with the model catalog; the node shape (`options.baseURL/apiKey`) is
/// what OpenCode reads.
fn opencode_node(target: &ProviderTarget) -> Value {
    serde_json::json!({
        "options": {
            "baseURL": target.base_url,
            "apiKey": target.api_key,
        }
    })
}

/// Minimal OpenClaw provider node (`models.providers.<id>`), matching the
/// `OpenClawProviderConfig` shape (`base_url`, `api_key`, `models[].id`).
fn openclaw_node(target: &ProviderTarget) -> Value {
    serde_json::json!({
        "base_url": target.base_url,
        "api_key": target.api_key,
        "models": [{ "id": target.model }],
    })
}

/// Insert or replace OpenCode's `provider.<id>` node; other nodes and top-level
/// keys are preserved. Commented (JSONC) files are refused rather than
/// rewritten, so no comment is ever lost.
pub fn upsert_opencode(home: &Path, id: &str, config: Value) -> Result<PathBuf, String> {
    validate_provider_id(id)?;
    let path = paths::opencode_config(home);
    ensure_within_home(home, &path)?;
    reject_symlink(&path)?;
    let pre_bytes = read_bytes(&path)?;
    let mut value = match &pre_bytes {
        None => serde_json::json!({"$schema": "https://opencode.ai/config.json"}),
        Some(bytes) => parse_json_object(&path, bytes)?,
    };
    let root = value
        .as_object_mut()
        .ok_or_else(|| format!("{} root must be an object", path.display()))?;
    let providers = root
        .entry("provider")
        .or_insert_with(|| Value::Object(Map::new()));
    if !providers.is_object() {
        *providers = Value::Object(Map::new());
    }
    providers
        .as_object_mut()
        .expect("provider is an object after normalization")
        .insert(id.to_string(), config);
    let bytes = pretty(&value)?;
    let store = DeviceStore::for_home(home);
    let file = LiveFile::private(path.clone());
    run_operation(
        &store,
        "opencode",
        "upsert",
        &[plan_from(&file, pre_bytes, Some(bytes))],
        None,
    )?;
    Ok(path)
}

/// Insert or replace OpenClaw's `models.providers.<id>` node; everything else
/// is preserved. JSON5 comments are refused rather than rewritten.
pub fn upsert_openclaw(home: &Path, id: &str, config: Value) -> Result<PathBuf, String> {
    validate_provider_id(id)?;
    let path = paths::openclaw_config(home);
    ensure_within_home(home, &path)?;
    reject_symlink(&path)?;
    let pre_bytes = read_bytes(&path)?;
    let mut value = match &pre_bytes {
        None => serde_json::json!({"models": {"mode": "merge", "providers": {}}}),
        Some(bytes) => parse_json_object(&path, bytes)?,
    };
    let root = value
        .as_object_mut()
        .ok_or_else(|| format!("{} root must be an object", path.display()))?;
    let models = root
        .entry("models")
        .or_insert_with(|| Value::Object(Map::new()));
    if !models.is_object() {
        *models = Value::Object(Map::new());
    }
    let models = models
        .as_object_mut()
        .expect("models is an object after normalization");
    let providers = models
        .entry("providers")
        .or_insert_with(|| Value::Object(Map::new()));
    if !providers.is_object() {
        *providers = Value::Object(Map::new());
    }
    providers
        .as_object_mut()
        .expect("providers is an object after normalization")
        .insert(id.to_string(), config);
    let bytes = pretty(&value)?;
    let store = DeviceStore::for_home(home);
    let file = LiveFile::private(path.clone());
    run_operation(
        &store,
        "openclaw",
        "upsert",
        &[plan_from(&file, pre_bytes, Some(bytes))],
        None,
    )?;
    Ok(path)
}

fn remove_opencode_provider(home: &Path, id: &str) -> Result<bool, String> {
    validate_provider_id(id)?;
    let path = paths::opencode_config(home);
    ensure_within_home(home, &path)?;
    let Some(pre_bytes) = read_bytes(&path)? else {
        return Ok(false);
    };
    let mut value = parse_json_object(&path, &pre_bytes)?;
    let removed = value
        .get_mut("provider")
        .and_then(Value::as_object_mut)
        .is_some_and(|providers| providers.remove(id).is_some());
    if !removed {
        return Ok(false);
    }
    let bytes = pretty(&value)?;
    let store = DeviceStore::for_home(home);
    let file = LiveFile::private(path);
    run_operation(
        &store,
        "opencode",
        "remove",
        &[plan_from(&file, Some(pre_bytes), Some(bytes))],
        None,
    )?;
    Ok(true)
}

fn remove_openclaw_provider(home: &Path, id: &str) -> Result<bool, String> {
    validate_provider_id(id)?;
    let path = paths::openclaw_config(home);
    ensure_within_home(home, &path)?;
    let Some(pre_bytes) = read_bytes(&path)? else {
        return Ok(false);
    };
    let mut value = parse_json_object(&path, &pre_bytes)?;
    let removed = value
        .get_mut("models")
        .and_then(|models| models.get_mut("providers"))
        .and_then(Value::as_object_mut)
        .is_some_and(|providers| providers.remove(id).is_some());
    if !removed {
        return Ok(false);
    }
    let bytes = pretty(&value)?;
    let store = DeviceStore::for_home(home);
    let file = LiveFile::private(path);
    run_operation(
        &store,
        "openclaw",
        "remove",
        &[plan_from(&file, Some(pre_bytes), Some(bytes))],
        None,
    )?;
    Ok(true)
}

fn clear_live_file(
    home: &Path,
    app: &str,
    path: PathBuf,
    pre_bytes: Option<Vec<u8>>,
    bytes: Option<Vec<u8>>,
    id: &str,
) -> Result<bool, String> {
    let store = DeviceStore::for_home(home);
    let file = LiveFile::private(path);
    let planned = plan_from(&file, pre_bytes, bytes);
    if planned.is_noop() {
        return Ok(false);
    }
    run_operation(&store, app, "remove", &[planned], None)?;
    if current(&store, app)?.as_deref() == Some(id) {
        set_current(&store, app, None)?;
    }
    Ok(true)
}

/// Remove a provider from a tool's live files: switch apps lose their floor
/// keys, additive apps lose the provider node. Returns whether anything
/// changed.
pub fn remove_provider(home: &Path, app: &str, id: &str) -> Result<bool, String> {
    validate_provider_id(id)?;
    match app {
        "claude" => {
            let path = paths::claude_settings(home);
            ensure_within_home(home, &path)?;
            let pre_bytes = read_bytes(&path)?;
            if pre_bytes.is_none() {
                return Ok(false);
            }
            let bytes = apply_claude_bytes(pre_bytes.as_deref(), &path, None)?;
            clear_live_file(home, app, path, pre_bytes, bytes, id)
        }
        "codex" => {
            let path = paths::codex_config(home);
            ensure_within_home(home, &path)?;
            let pre_bytes = read_bytes(&path)?;
            if pre_bytes.is_none() {
                return Ok(false);
            }
            let bytes = apply_codex_toml(pre_bytes.as_deref(), &path, None)?;
            clear_live_file(home, app, path, pre_bytes, bytes, id)
        }
        "gemini" => {
            let path = paths::gemini_env(home);
            ensure_within_home(home, &path)?;
            let pre_bytes = read_bytes(&path)?;
            if pre_bytes.is_none() {
                return Ok(false);
            }
            let bytes = apply_gemini_env(pre_bytes.as_deref(), &path, None)?;
            clear_live_file(home, app, path, pre_bytes, bytes, id)
        }
        "opencode" => remove_opencode_provider(home, id),
        "openclaw" => remove_openclaw_provider(home, id),
        _ => Err(format!(
            "unknown app '{app}'; expected claude, codex, gemini, opencode, or openclaw"
        )),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Switch a tool's live config to a provider.
///
/// `app` is one of `claude`, `codex`, `gemini`, `opencode`, `openclaw`.
/// Switch apps get their floor keys rewritten; additive apps (`opencode`,
/// `openclaw`) get a minimal provider node upserted. Never returns secrets:
/// only the changed file paths.
#[tauri::command]
pub fn switch_provider(
    app: String,
    id: String,
    base_url: String,
    api_key: String,
    model: String,
) -> Result<Vec<String>, String> {
    let home = paths::home_dir();
    let target = ProviderTarget::new(&id, &base_url, &api_key, &model)?;
    let changed = match app.as_str() {
        "claude" => switch_claude(&home, &target)?,
        "codex" => switch_codex(&home, &target)?,
        "gemini" => switch_gemini(&home, &target)?,
        "opencode" => vec![upsert_opencode(&home, &id, opencode_node(&target))?],
        "openclaw" => vec![upsert_openclaw(&home, &id, openclaw_node(&target))?],
        _ => {
            return Err(format!(
                "unknown app '{app}'; expected claude, codex, gemini, opencode, or openclaw"
            ));
        }
    };
    Ok(changed
        .iter()
        .map(|path| path.display().to_string())
        .collect())
}

/// Remove a provider from a tool's live files. Returns whether anything
/// changed. Secrets are never returned.
#[tauri::command]
pub fn remove_from_live(app: String, id: String) -> Result<bool, String> {
    remove_provider(&paths::home_dir(), &app, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_floor_covers_connection_keys() {
        for key in [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_MODEL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
            "AWS_REGION",
            "VERTEX_REGION_CLAUDE_4_5_SONNET",
            "CLAUDE_CODE_OAUTH_TOKEN",
        ] {
            assert!(claude_floor_env(key), "{key} should be a key field");
        }
        for key in ["apiKeyHelper", "model", "modelOverrides", "advisorModel"] {
            assert!(claude_floor_top(key), "{key} should be a key field");
        }
    }

    #[test]
    fn claude_floor_leaves_user_keys_alone() {
        for key in [
            "MY_COMPANY_PROXY",
            "DISABLE_TELEMETRY",
            "CLAUDE_CODE_USE_POWERSHELL_TOOL",
            "CLAUDE_CODE_DISABLE_ARTIFACT",
        ] {
            assert!(!claude_floor_env(key), "{key} must stay a user key");
        }
        for key in ["hooks", "permissions", "statusLine", "env"] {
            assert!(!claude_floor_top(key), "{key} must stay a user key");
        }
    }

    #[test]
    fn gemini_floor_keeps_cli_settings() {
        for key in [
            "GOOGLE_API_KEY",
            "GOOGLE_GEMINI_BASE_URL",
            "GEMINI_API_KEY",
            "GEMINI_MODEL",
        ] {
            assert!(gemini_floor_env(key), "{key} should be a key field");
        }
        for key in ["GEMINI_SANDBOX", "GEMINI_CLI_HOME", "DEBUG"] {
            assert!(!gemini_floor_env(key), "{key} must stay a user key");
        }
    }

    #[test]
    fn target_rejects_blank_or_multiline_fields() {
        assert!(ProviderTarget::new("", "https://x", "k", "m").is_err());
        assert!(ProviderTarget::new("id", "https://x", "line1\nline2", "m").is_err());
        assert!(ProviderTarget::new("ok", "https://x", "k", "m").is_ok());
    }
}
