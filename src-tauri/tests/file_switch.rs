//! File-switch engine tests, isolated per test via `LUMEN_TEST_HOME`.
//!
//! A process-wide lock serializes the tests because they share the process
//! environment variable; every test gets a fresh temp home and the engine
//! functions under test resolve all paths from it.

use lumen_lib::provider_switcher::files::{
    DeviceStore, LiveFile, Pending, PendingFile, ProviderTarget, RecoveryOutcome, atomic_write,
    current, digest, pending, plan_from, recover, remove_provider, stage, switch_claude,
    switch_codex, switch_gemini, switch_provider, upsert_openclaw, upsert_opencode,
};
use lumen_lib::provider_switcher::paths;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

static ENV_LOCK: Mutex<()> = Mutex::new(());
static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TestHome {
    home: PathBuf,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl TestHome {
    fn fresh() -> Self {
        let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let home =
            std::env::temp_dir().join(format!("lumen-file-switch-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("create test home");
        // SAFETY: `ENV_LOCK` serializes every test that touches the process
        // environment, and no other thread reads `LUMEN_TEST_HOME` meanwhile.
        unsafe {
            std::env::set_var("LUMEN_TEST_HOME", &home);
        }
        assert_eq!(paths::home_dir(), home, "test home override applies");
        Self {
            home,
            _guard: guard,
        }
    }

    fn path(&self) -> &Path {
        &self.home
    }
}

impl Drop for TestHome {
    fn drop(&mut self) {
        // SAFETY: same serialization guarantee as in `fresh`.
        unsafe {
            std::env::remove_var("LUMEN_TEST_HOME");
        }
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn target(id: &str) -> ProviderTarget {
    ProviderTarget::new(id, "https://proxy.example/v1", "sk-test-123", "test-model")
        .expect("valid target")
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).expect("read file")
}

fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().expect("parent")).expect("create parent dirs");
    std::fs::write(path, contents).expect("write fixture");
}

fn temp_files_near(path: &Path) -> Vec<PathBuf> {
    let dir = path.parent().expect("parent");
    let name = path
        .file_name()
        .expect("file name")
        .to_string_lossy()
        .into_owned();
    std::fs::read_dir(dir)
        .expect("read dir")
        .map(|entry| entry.expect("dir entry").path())
        .filter(|path| {
            path.file_name()
                .is_some_and(|file| file.to_string_lossy().starts_with(&format!("{name}.tmp.")))
        })
        .collect()
}

#[test]
fn claude_switch_replaces_only_floor_keys() {
    let home = TestHome::fresh();
    let settings = paths::claude_settings(home.path());
    write(
        &settings,
        r#"{
  "model": "old-model",
  "apiKeyHelper": "/old/helper.sh",
  "hooks": {"Startup": []},
  "env": {
    "ANTHROPIC_BASE_URL": "https://old.example",
    "ANTHROPIC_API_KEY": "sk-old",
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "MY_COMPANY_PROXY": "keep-me",
    "DISABLE_TELEMETRY": "1"
  }
}"#,
    );

    let changed = switch_claude(home.path(), &target("proxy")).expect("switch");
    assert_eq!(changed, vec![settings.clone()]);

    let value: serde_json::Value = serde_json::from_str(&read(&settings)).expect("valid json");
    let env = value.get("env").expect("env survives");
    assert_eq!(env["ANTHROPIC_BASE_URL"], "https://proxy.example/v1");
    assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "sk-test-123");
    assert!(env.get("ANTHROPIC_API_KEY").is_none(), "stale key is gone");
    assert!(
        env.get("CLAUDE_CODE_USE_BEDROCK").is_none(),
        "stale selector is gone"
    );
    assert_eq!(env["MY_COMPANY_PROXY"], "keep-me", "user key preserved");
    assert_eq!(env["DISABLE_TELEMETRY"], "1", "user key preserved");
    assert_eq!(value["model"], "test-model");
    assert!(value.get("apiKeyHelper").is_none(), "stale top key is gone");
    assert!(value.get("hooks").is_some(), "user top key preserved");

    let store = DeviceStore::for_home(home.path());
    assert_eq!(
        current(&store, "claude").expect("read pointer"),
        Some("proxy".to_string())
    );
    assert!(temp_files_near(&settings).is_empty(), "no temp files left");

    // Switching to the same target again is a noop.
    let again = switch_claude(home.path(), &target("proxy")).expect("switch");
    assert!(again.is_empty(), "identical switch writes nothing");
}

#[test]
fn codex_switch_rewrites_custom_table_only() {
    let home = TestHome::fresh();
    let config = paths::codex_config(home.path());
    write(
        &config,
        "model_provider = \"east\"\nmodel = \"gpt-old\"\ncustom_note = \"mine\"\n\n[model_providers.east]\nname = \"East\"\nbase_url = \"https://east.example/v1\"\n\n[model_providers.custom]\nname = \"custom\"\nbase_url = \"https://stale.example/v1\"\n",
    );

    let changed = switch_codex(home.path(), &target("proxy")).expect("switch");
    assert_eq!(changed, vec![config.clone()]);

    let text = read(&config);
    assert!(
        text.contains("custom_note = \"mine\""),
        "user key preserved"
    );
    assert!(
        text.contains("[model_providers.east]"),
        "user table preserved"
    );
    assert!(
        text.contains("https://east.example/v1"),
        "user table untouched"
    );
    assert!(
        !text.contains("https://stale.example"),
        "stale custom table replaced"
    );
    assert!(text.contains("model_provider = \"custom\""));
    assert!(text.contains("model = \"test-model\""));
    assert!(text.contains("experimental_bearer_token = \"sk-test-123\""));
    assert_eq!(
        text.matches("[model_providers.custom]").count(),
        1,
        "exactly one custom table"
    );
}

#[test]
fn gemini_switch_preserves_user_env() {
    let home = TestHome::fresh();
    let env = paths::gemini_env(home.path());
    write(
        &env,
        "# mine\nGEMINI_SANDBOX=docker\nexport GEMINI_API_KEY=\"key-old\"\nGOOGLE_GEMINI_BASE_URL=https://old.example\nDEBUG=1\nGEMINI_API_KEY=key-dup\n",
    );

    switch_gemini(home.path(), &target("proxy")).expect("switch");
    let text = read(&env);
    assert!(text.starts_with("# mine\n"), "comment preserved");
    assert!(text.contains("GEMINI_SANDBOX=docker"), "user var preserved");
    assert!(text.contains("DEBUG=1"), "user var preserved");
    assert!(
        text.contains("GOOGLE_GEMINI_BASE_URL=https://proxy.example/v1"),
        "base url switched"
    );
    assert!(
        text.contains("GEMINI_MODEL=test-model"),
        "model switched, got:\n{text}"
    );
    assert_eq!(
        text.matches("GEMINI_API_KEY=").count(),
        1,
        "duplicate key rows collapse, got:\n{text}"
    );
    assert!(!text.contains("key-old") && !text.contains("key-dup"));
    assert!(
        text.contains("export GEMINI_API_KEY=sk-test-123"),
        "export prefix preserved, got:\n{text}"
    );

    let again = switch_gemini(home.path(), &target("proxy")).expect("switch");
    assert!(again.is_empty(), "identical switch writes nothing");
}

#[test]
fn opencode_upsert_and_remove_round_trip() {
    let home = TestHome::fresh();
    let path = paths::opencode_config(home.path());
    write(&path, "{\"model\": \"keep-me\"}");

    upsert_opencode(
        home.path(),
        "proxy",
        serde_json::json!({"options": {"baseURL": "https://proxy.example/v1"}}),
    )
    .expect("upsert");
    let value: serde_json::Value = serde_json::from_str(&read(&path)).expect("valid json");
    assert_eq!(
        value["provider"]["proxy"]["options"]["baseURL"],
        "https://proxy.example/v1"
    );
    assert_eq!(value["model"], "keep-me", "unrelated keys preserved");

    assert!(remove_provider(home.path(), "opencode", "proxy").expect("remove"));
    let value: serde_json::Value = serde_json::from_str(&read(&path)).expect("valid json");
    assert!(
        value
            .get("provider")
            .is_none_or(|p| p.get("proxy").is_none()),
        "node removed"
    );
    assert_eq!(value["model"], "keep-me");
    assert!(
        !remove_provider(home.path(), "opencode", "proxy").expect("remove"),
        "second remove is a noop"
    );
}

#[test]
fn openclaw_upsert_and_remove_round_trip() {
    let home = TestHome::fresh();
    upsert_openclaw(
        home.path(),
        "proxy",
        serde_json::json!({"base_url": "https://proxy.example/v1"}),
    )
    .expect("upsert");
    let path = paths::openclaw_config(home.path());
    let value: serde_json::Value = serde_json::from_str(&read(&path)).expect("valid json");
    assert_eq!(
        value["models"]["providers"]["proxy"]["base_url"],
        "https://proxy.example/v1"
    );
    assert_eq!(value["models"]["mode"], "merge", "defaults seeded");

    assert!(remove_provider(home.path(), "openclaw", "proxy").expect("remove"));
    let value: serde_json::Value = serde_json::from_str(&read(&path)).expect("valid json");
    assert!(
        value["models"]["providers"].get("proxy").is_none(),
        "node removed"
    );
}

#[test]
fn remove_from_live_clears_claude_floor() {
    let home = TestHome::fresh();
    let settings = paths::claude_settings(home.path());
    write(
        &settings,
        "{\"model\": \"old\", \"env\": {\"ANTHROPIC_BASE_URL\": \"https://old.example\", \"KEEP\": \"1\"}}",
    );

    switch_claude(home.path(), &target("proxy")).expect("switch");
    assert!(remove_provider(home.path(), "claude", "proxy").expect("remove"));
    let value: serde_json::Value = serde_json::from_str(&read(&settings)).expect("valid json");
    assert!(
        value.get("model").is_none(),
        "floor top key cleared, got: {value}"
    );
    assert!(
        value["env"].get("ANTHROPIC_BASE_URL").is_none(),
        "floor env cleared, got: {value}"
    );
    assert_eq!(value["env"]["KEEP"], "1", "user key preserved");
    assert!(
        !remove_provider(home.path(), "claude", "proxy").expect("remove"),
        "second remove is a noop"
    );

    let store = DeviceStore::for_home(home.path());
    assert_eq!(
        current(&store, "claude").expect("read pointer"),
        None,
        "pointer cleared with the floor"
    );
}

#[test]
fn broken_claude_settings_abort_without_writes() {
    let home = TestHome::fresh();
    let settings = paths::claude_settings(home.path());
    write(&settings, "{ broken");

    let error = switch_claude(home.path(), &target("proxy")).expect_err("refused");
    assert!(
        error.contains("settings.json"),
        "error names the file: {error}"
    );
    assert_eq!(read(&settings), "{ broken", "original untouched");
    let store = DeviceStore::for_home(home.path());
    assert!(
        pending(&store, "claude").expect("read pending").is_none(),
        "no intent journaled"
    );
    assert!(temp_files_near(&settings).is_empty(), "no temp files left");
}

#[test]
fn recover_discards_unpublished_intent() {
    let home = TestHome::fresh();
    let settings = paths::claude_settings(home.path());
    write(&settings, "{}\n");
    let store = DeviceStore::for_home(home.path());
    let stale = settings.with_file_name("settings.json.tmp.stale");
    let intent = Pending {
        op: "switch".to_string(),
        files: vec![PendingFile {
            path: settings.clone(),
            pre: digest(Some(b"{}\n")),
            planned: digest(Some(b"{\"model\":\"x\"}\n")),
            staged: Some(stale),
        }],
        target: Some("p1".to_string()),
        published: false,
    };
    // Seed the journal the way a crash between staging and publishing would.
    {
        let path = store.state_path();
        std::fs::create_dir_all(path.parent().expect("parent")).expect("state dir");
        atomic_write(
            &path,
            &serde_json::to_vec_pretty(&serde_json::json!({
                "version": 1,
                "apps": {"claude": {"pending": intent}},
            }))
            .expect("serialize"),
            true,
        )
        .expect("seed pending");
    }

    assert_eq!(
        recover(&store, "claude").expect("recover"),
        Some(RecoveryOutcome::Discarded)
    );
    assert_eq!(read(&settings), "{}\n", "file untouched");
    assert!(
        pending(&store, "claude").expect("read pending").is_none(),
        "intent cleared"
    );
    assert_eq!(
        current(&store, "claude").expect("read pointer"),
        None,
        "pointer not committed"
    );
}

#[test]
fn recover_rolls_forward_published_intent() {
    let home = TestHome::fresh();
    let settings = paths::claude_settings(home.path());
    write(&settings, "{}\n");
    let file = LiveFile::private(settings.clone());
    let new_bytes = b"{\"model\":\"x\"}\n".to_vec();
    let planned = plan_from(&file, Some(b"{}\n".to_vec()), Some(new_bytes));
    let staged = stage(&planned).expect("stage").expect("staged path");
    let store = DeviceStore::for_home(home.path());
    let intent = Pending {
        op: "switch".to_string(),
        files: vec![PendingFile {
            path: settings.clone(),
            pre: planned.pre.clone(),
            planned: planned.planned.clone(),
            staged: Some(staged),
        }],
        target: Some("p1".to_string()),
        published: true,
    };
    {
        let path = store.state_path();
        std::fs::create_dir_all(path.parent().expect("parent")).expect("state dir");
        atomic_write(
            &path,
            &serde_json::to_vec_pretty(&serde_json::json!({
                "version": 1,
                "apps": {"claude": {"pending": intent}},
            }))
            .expect("serialize"),
            true,
        )
        .expect("seed pending");
    }

    assert_eq!(
        recover(&store, "claude").expect("recover"),
        Some(RecoveryOutcome::RolledForward)
    );
    assert_eq!(
        read(&settings),
        "{\"model\":\"x\"}\n",
        "staged content published"
    );
    assert_eq!(
        current(&store, "claude").expect("read pointer"),
        Some("p1".to_string()),
        "pointer committed"
    );
    assert!(
        pending(&store, "claude").expect("read pending").is_none(),
        "intent cleared"
    );
    assert!(temp_files_near(&settings).is_empty(), "no temp files left");
}

#[test]
fn tauri_commands_switch_and_remove() {
    let _home = TestHome::fresh();
    let changed = switch_provider(
        "claude".to_string(),
        "proxy".to_string(),
        "https://proxy.example/v1".to_string(),
        "sk-test-123".to_string(),
        "test-model".to_string(),
    )
    .expect("switch_provider");
    assert_eq!(changed.len(), 1, "one file switched");

    let error = switch_provider(
        "wat".to_string(),
        "proxy".to_string(),
        "https://proxy.example/v1".to_string(),
        "sk-test-123".to_string(),
        "test-model".to_string(),
    )
    .expect_err("unknown app");
    assert!(error.contains("unknown app"), "{error}");

    assert!(
        lumen_lib::provider_switcher::files::remove_from_live(
            "claude".to_string(),
            "proxy".to_string()
        )
        .expect("remove_from_live"),
        "floor removed"
    );
}
