use std::{
    fs,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivityMode {
    #[default]
    Indexing,
    Gaming,
    Fullscreen,
    Cinema,
    Battery,
    User,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundPolicy {
    #[default]
    Normal,
    MetadataOnly,
    Paused,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OverridePolicy {
    Automatic,
    Pause,
    Cinema,
    Allow,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityOverride {
    pub identity_hash: String,
    pub policy: OverridePolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ActivityPolicy {
    pub detect_games: bool,
    pub detect_fullscreen: bool,
    pub allow_during_video: bool,
    pub cinema_metadata_only: bool,
    pub pause_on_battery: bool,
    pub user_paused: bool,
    pub resume_delay_seconds: u64,
    pub game_identities: Vec<String>,
    pub overrides: Vec<ActivityOverride>,
}

impl Default for ActivityPolicy {
    fn default() -> Self {
        Self {
            detect_games: true,
            detect_fullscreen: true,
            allow_during_video: false,
            cinema_metadata_only: true,
            pause_on_battery: true,
            user_paused: false,
            resume_delay_seconds: 30,
            game_identities: Vec::new(),
            overrides: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ObservedActivity {
    pub identity_hash: Option<String>,
    pub fullscreen: bool,
    pub video: bool,
    pub on_battery: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub mode: ActivityMode,
    pub background_policy: BackgroundPolicy,
    pub foreground_identity: Option<String>,
    pub fullscreen: bool,
    pub on_battery: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutableIdentity {
    pub file_name: String,
    pub identity_hash: String,
}

fn snapshot(
    mode: ActivityMode,
    background_policy: BackgroundPolicy,
    observed: &ObservedActivity,
) -> ActivitySnapshot {
    ActivitySnapshot {
        mode,
        background_policy,
        foreground_identity: observed.identity_hash.clone(),
        fullscreen: observed.fullscreen,
        on_battery: observed.on_battery,
    }
}

pub fn classify_activity(observed: &ObservedActivity, policy: &ActivityPolicy) -> ActivitySnapshot {
    if policy.user_paused {
        return snapshot(ActivityMode::User, BackgroundPolicy::Paused, observed);
    }
    if policy.pause_on_battery && observed.on_battery {
        return snapshot(ActivityMode::Battery, BackgroundPolicy::Paused, observed);
    }
    if let Some(identity) = observed.identity_hash.as_deref()
        && let Some(override_policy) = policy
            .overrides
            .iter()
            .find(|item| item.identity_hash == identity)
            .map(|item| item.policy)
    {
        return match override_policy {
            OverridePolicy::Allow => {
                snapshot(ActivityMode::Indexing, BackgroundPolicy::Normal, observed)
            }
            OverridePolicy::Pause => {
                snapshot(ActivityMode::Fullscreen, BackgroundPolicy::Paused, observed)
            }
            OverridePolicy::Cinema => snapshot(
                ActivityMode::Cinema,
                BackgroundPolicy::MetadataOnly,
                observed,
            ),
            OverridePolicy::Automatic => automatic_classification(observed, policy),
        };
    }
    automatic_classification(observed, policy)
}

fn automatic_classification(
    observed: &ObservedActivity,
    policy: &ActivityPolicy,
) -> ActivitySnapshot {
    if policy.detect_games
        && observed
            .identity_hash
            .as_ref()
            .is_some_and(|identity| policy.game_identities.contains(identity))
    {
        return snapshot(ActivityMode::Gaming, BackgroundPolicy::Paused, observed);
    }
    if observed.video && !policy.allow_during_video {
        return snapshot(
            ActivityMode::Cinema,
            if policy.cinema_metadata_only {
                BackgroundPolicy::MetadataOnly
            } else {
                BackgroundPolicy::Paused
            },
            observed,
        );
    }
    if policy.detect_fullscreen && observed.fullscreen {
        return snapshot(ActivityMode::Fullscreen, BackgroundPolicy::Paused, observed);
    }
    snapshot(ActivityMode::Indexing, BackgroundPolicy::Normal, observed)
}

struct ActivityState {
    policy: Mutex<ActivityPolicy>,
    last_restricted: Mutex<Option<(Instant, ActivityMode, BackgroundPolicy)>>,
}

pub struct ActivityRuntime {
    state: ActivityState,
}

impl ActivityRuntime {
    pub fn load(path: &Path) -> Self {
        let activity = fs::read_to_string(path)
            .ok()
            .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok())
            .and_then(|settings| settings.get("management")?.get("activity").cloned());
        let mut policy: ActivityPolicy = activity
            .as_ref()
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default();
        policy.game_identities = activity
            .as_ref()
            .and_then(|value| value.get("userGames"))
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|game| game.get("identityHash")?.as_str())
            .filter(|identity| is_identity_hash(identity))
            .map(ToOwned::to_owned)
            .collect();
        Self {
            state: ActivityState {
                policy: Mutex::new(policy),
                last_restricted: Mutex::new(None),
            },
        }
    }

    pub fn set_policy(&self, policy: ActivityPolicy) -> Result<ActivitySnapshot, String> {
        *self
            .state
            .policy
            .lock()
            .map_err(|_| "Activity policy is unavailable.".to_owned())? = policy;
        Ok(self.snapshot())
    }

    pub fn set_user_paused(&self, paused: bool) -> Result<ActivitySnapshot, String> {
        self.state
            .policy
            .lock()
            .map_err(|_| "Activity policy is unavailable.".to_owned())?
            .user_paused = paused;
        Ok(self.snapshot())
    }

    pub fn snapshot(&self) -> ActivitySnapshot {
        let observed = observe_activity();
        let policy = self
            .state
            .policy
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let current = classify_activity(&observed, &policy);
        let now = Instant::now();
        let mut last_restricted = self
            .state
            .last_restricted
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if current.background_policy != BackgroundPolicy::Normal {
            *last_restricted = Some((now, current.mode, current.background_policy));
            return current;
        }
        if let Some((at, mode, background_policy)) = *last_restricted
            && keep_restricted_during_resume_delay(
                now.saturating_duration_since(at),
                policy.resume_delay_seconds,
            )
        {
            return snapshot(mode, background_policy, &observed);
        }
        *last_restricted = None;
        current
    }
}

fn keep_restricted_during_resume_delay(elapsed: Duration, delay_seconds: u64) -> bool {
    elapsed < Duration::from_secs(delay_seconds)
}

fn hash_identity(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/").to_lowercase();
    Sha256::digest(normalized.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_identity_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn executable_identity(path: &Path) -> Result<ExecutableIdentity, String> {
    let canonical =
        fs::canonicalize(path).map_err(|_| "The selected executable is unavailable.".to_owned())?;
    let valid_extension = canonical
        .extension()
        .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("exe"));
    if !canonical.is_file() || !valid_extension {
        return Err("Select a Windows executable file.".to_owned());
    }
    let file_name = canonical
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .ok_or_else(|| "The selected executable has no file name.".to_owned())?;
    Ok(ExecutableIdentity {
        file_name,
        identity_hash: hash_identity(&canonical),
    })
}

#[cfg(windows)]
fn observe_activity() -> ObservedActivity {
    use windows::Win32::{
        Foundation::{CloseHandle, RECT},
        Graphics::Gdi::{
            GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
        },
        System::{
            Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS},
            Threading::{
                OpenProcess, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
                QueryFullProcessImageNameW,
            },
        },
        UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId},
    };
    use windows::core::PWSTR;

    unsafe {
        let foreground = GetForegroundWindow();
        let mut observed = ObservedActivity::default();
        let mut power = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut power).is_ok() {
            observed.on_battery = power.ACLineStatus == 0;
        }
        if foreground.0.is_null() {
            return observed;
        }
        let mut process_id = 0_u32;
        GetWindowThreadProcessId(foreground, Some(&mut process_id));
        if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) {
            let mut buffer = vec![0_u16; 32_768];
            let mut length = buffer.len() as u32;
            if QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_FORMAT(0),
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
            .is_ok()
            {
                observed.identity_hash = Some(hash_identity(Path::new(&String::from_utf16_lossy(
                    &buffer[..length as usize],
                ))));
            }
            let _ = CloseHandle(process);
        }
        let mut window_rect = RECT::default();
        let monitor = MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST);
        let mut monitor_info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetWindowRect(foreground, &mut window_rect).is_ok()
            && GetMonitorInfoW(monitor, &mut monitor_info).as_bool()
        {
            let monitor_rect = monitor_info.rcMonitor;
            observed.fullscreen = window_rect.left <= monitor_rect.left
                && window_rect.top <= monitor_rect.top
                && window_rect.right >= monitor_rect.right
                && window_rect.bottom >= monitor_rect.bottom;
        }
        observed
    }
}

#[cfg(not(windows))]
fn observe_activity() -> ObservedActivity {
    ObservedActivity::default()
}

#[tauri::command]
pub fn get_activity_status(
    state: State<'_, ActivityRuntime>,
    index: State<'_, crate::search::IndexRuntime>,
    enrichment: State<'_, crate::gateway::EnrichmentSupervisor>,
) -> ActivitySnapshot {
    let snapshot = state.snapshot();
    enrichment.set_activity_paused(snapshot.background_policy != BackgroundPolicy::Normal);
    index.set_content_enabled(snapshot.background_policy == BackgroundPolicy::Normal);
    snapshot
}

#[tauri::command]
pub fn set_activity_policy(
    state: State<'_, ActivityRuntime>,
    index: State<'_, crate::search::IndexRuntime>,
    enrichment: State<'_, crate::gateway::EnrichmentSupervisor>,
    policy: ActivityPolicy,
) -> Result<ActivitySnapshot, String> {
    let snapshot = state.set_policy(policy)?;
    enrichment.set_activity_paused(snapshot.background_policy != BackgroundPolicy::Normal);
    index.set_content_enabled(snapshot.background_policy == BackgroundPolicy::Normal);
    Ok(snapshot)
}

#[tauri::command]
pub fn set_user_pause(
    state: State<'_, ActivityRuntime>,
    index: State<'_, crate::search::IndexRuntime>,
    enrichment: State<'_, crate::gateway::EnrichmentSupervisor>,
    paused: bool,
) -> Result<ActivitySnapshot, String> {
    let snapshot = state.set_user_paused(paused)?;
    enrichment.set_activity_paused(snapshot.background_policy != BackgroundPolicy::Normal);
    index.set_content_enabled(snapshot.background_policy == BackgroundPolicy::Normal);
    Ok(snapshot)
}

#[tauri::command]
pub fn choose_activity_executable(app: AppHandle) -> Result<Option<ExecutableIdentity>, String> {
    app.dialog()
        .file()
        .add_filter("Windows executable", &["exe"])
        .blocking_pick_file()
        .map(|path| {
            path.into_path()
                .map_err(|_| "The selected executable path is invalid.".to_owned())
                .and_then(|path| executable_identity(&path))
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> ActivityPolicy {
        ActivityPolicy {
            detect_games: true,
            detect_fullscreen: true,
            allow_during_video: false,
            cinema_metadata_only: true,
            pause_on_battery: true,
            user_paused: false,
            resume_delay_seconds: 30,
            game_identities: vec!["game-hash".to_owned()],
            overrides: Vec::new(),
        }
    }

    #[test]
    fn user_battery_game_fullscreen_and_video_precedence_is_stable() {
        let observed = ObservedActivity {
            identity_hash: Some("game-hash".to_owned()),
            fullscreen: true,
            video: true,
            on_battery: true,
        };
        let mut settings = policy();

        assert_eq!(
            classify_activity(&observed, &settings).mode,
            ActivityMode::Battery
        );
        settings.pause_on_battery = false;
        assert_eq!(
            classify_activity(&observed, &settings).mode,
            ActivityMode::Gaming
        );
        settings.detect_games = false;
        assert_eq!(
            classify_activity(&observed, &settings).mode,
            ActivityMode::Cinema
        );
        settings.allow_during_video = true;
        assert_eq!(
            classify_activity(&observed, &settings).mode,
            ActivityMode::Fullscreen
        );
        settings.user_paused = true;
        assert_eq!(
            classify_activity(&observed, &settings).mode,
            ActivityMode::User
        );
    }

    #[test]
    fn executable_overrides_are_enforced_before_automatic_classification() {
        let observed = ObservedActivity {
            identity_hash: Some("editor-hash".to_owned()),
            fullscreen: true,
            video: false,
            on_battery: false,
        };
        let mut settings = policy();
        settings.overrides.push(ActivityOverride {
            identity_hash: "editor-hash".to_owned(),
            policy: OverridePolicy::Allow,
        });

        let snapshot = classify_activity(&observed, &settings);

        assert_eq!(snapshot.mode, ActivityMode::Indexing);
        assert_eq!(snapshot.background_policy, BackgroundPolicy::Normal);
    }

    #[test]
    fn executable_identity_is_canonical_and_secret_free() {
        let root = std::env::temp_dir().join(format!("lumen-activity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let executable = root.join("Sample.EXE");
        std::fs::write(&executable, b"test").unwrap();

        let identity = executable_identity(&executable).unwrap();

        assert_eq!(identity.file_name, "Sample.EXE");
        assert_eq!(identity.identity_hash.len(), 64);
        let serialized = serde_json::to_string(&identity).unwrap();
        assert!(!serialized.contains(&root.to_string_lossy().to_string()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn resume_delay_retains_restriction_until_elapsed() {
        assert!(keep_restricted_during_resume_delay(
            Duration::from_secs(29),
            30
        ));
        assert!(!keep_restricted_during_resume_delay(
            Duration::from_secs(30),
            30
        ));
    }

    #[test]
    fn persisted_ui_game_identities_are_loaded_without_paths() {
        let root = std::env::temp_dir().join(format!("lumen-activity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("lumen.settings.json");
        let identity = "a".repeat(64);
        std::fs::write(
            &path,
            format!(
                r#"{{"management":{{"activity":{{"detectGames":true,"userGames":[{{"id":"game","name":"game.exe","identityHash":"{identity}"}}]}}}}}}"#
            ),
        )
        .unwrap();

        let runtime = ActivityRuntime::load(&path);
        let policy = runtime.state.policy.lock().unwrap();
        assert_eq!(policy.game_identities, [identity]);
        let _ = std::fs::remove_dir_all(root);
    }
}
