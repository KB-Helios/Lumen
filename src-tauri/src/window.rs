use std::{fs, path::Path, sync::Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, State, WebviewWindow,
    window::{Color, Effect, EffectsBuilder},
};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowMode {
    Collapsed,
    Expanded,
    Onboarding,
    Settings,
    Gallery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowStateSource {
    Command,
    Shortcut,
    SecondInstance,
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStateEvent {
    pub mode: Option<WindowMode>,
    pub source: WindowStateSource,
    pub visible: bool,
}

impl WindowStateEvent {
    const fn visible(mode: WindowMode, source: WindowStateSource) -> Self {
        Self {
            mode: Some(mode),
            source,
            visible: true,
        }
    }

    pub const fn hidden(source: WindowStateSource) -> Self {
        Self {
            mode: None,
            source,
            visible: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowGeometry {
    pub width: f64,
    pub height: f64,
    pub min_width: f64,
    pub max_width: f64,
    pub min_height: f64,
    pub max_height: f64,
    pub resizable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LauncherPosition {
    x: i32,
    y: i32,
}

#[derive(Default)]
struct ShortcutRegistrationState {
    accelerator: Option<String>,
    error_code: Option<String>,
}

#[derive(Default)]
pub struct ShortcutRegistration(Mutex<ShortcutRegistrationState>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub registered: bool,
    pub accelerator: Option<String>,
    pub error_code: Option<String>,
}

impl ShortcutRegistration {
    pub fn snapshot(&self) -> ShortcutStatus {
        self.0
            .lock()
            .map(|state| ShortcutStatus {
                registered: state.accelerator.is_some(),
                accelerator: state.accelerator.clone(),
                error_code: state.error_code.clone(),
            })
            .unwrap_or(ShortcutStatus {
                registered: false,
                accelerator: None,
                error_code: Some("state-unavailable".to_owned()),
            })
    }
}

fn native_accelerator(accelerator: &str) -> String {
    accelerator
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

pub fn register_initial_shortcut(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    let native = native_accelerator(accelerator);
    let registration = app.state::<ShortcutRegistration>();
    let mut state = registration
        .0
        .lock()
        .map_err(|_| "Shortcut registration state is unavailable.".to_owned())?;
    if let Err(error) = shortcuts.register(native.as_str()) {
        state.error_code = Some("registration-unavailable".to_owned());
        return Err(format!("Could not register {accelerator}: {error}"));
    }
    state.accelerator = Some(accelerator.to_owned());
    state.error_code = None;
    Ok(())
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MonitorBehavior {
    #[default]
    Active,
    Primary,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseBehavior {
    #[default]
    Hide,
    Quit,
}

#[derive(Debug, Clone)]
struct RuntimePreferenceValues {
    monitor_behavior: MonitorBehavior,
    close_behavior: CloseBehavior,
    shortcut: String,
}

impl Default for RuntimePreferenceValues {
    fn default() -> Self {
        Self {
            monitor_behavior: MonitorBehavior::Active,
            close_behavior: CloseBehavior::Hide,
            shortcut: "Alt + Space".to_owned(),
        }
    }
}

#[derive(Default)]
pub struct RuntimePreferences(Mutex<RuntimePreferenceValues>);

impl RuntimePreferences {
    pub fn load(path: &Path) -> Self {
        let general = fs::read_to_string(path)
            .ok()
            .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok())
            .and_then(|settings| settings.get("management")?.get("general").cloned());
        let values = RuntimePreferenceValues {
            monitor_behavior: general
                .as_ref()
                .and_then(|value| value.get("monitorBehavior"))
                .and_then(|value| serde_json::from_value(value.clone()).ok())
                .unwrap_or_default(),
            close_behavior: general
                .as_ref()
                .and_then(|value| value.get("closeBehavior"))
                .and_then(|value| serde_json::from_value(value.clone()).ok())
                .unwrap_or_default(),
            shortcut: general
                .as_ref()
                .and_then(|value| value.get("shortcut"))
                .and_then(Value::as_str)
                .filter(|shortcut| (3..=64).contains(&shortcut.len()))
                .unwrap_or("Alt + Space")
                .to_owned(),
        };
        Self(Mutex::new(values))
    }

    pub fn monitor_behavior(&self) -> MonitorBehavior {
        self.0
            .lock()
            .map(|values| values.monitor_behavior)
            .unwrap_or_default()
    }

    pub fn close_behavior(&self) -> CloseBehavior {
        self.0
            .lock()
            .map(|values| values.close_behavior)
            .unwrap_or_default()
    }

    pub fn shortcut(&self) -> String {
        self.0
            .lock()
            .map(|values| values.shortcut.clone())
            .unwrap_or_else(|_| "Alt + Space".to_owned())
    }

    pub fn set_monitor_behavior(&self, behavior: MonitorBehavior) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "Window preference state is unavailable.".to_owned())?
            .monitor_behavior = behavior;
        Ok(())
    }

    pub fn set_close_behavior(&self, behavior: CloseBehavior) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "Window preference state is unavailable.".to_owned())?
            .close_behavior = behavior;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MonitorCandidate {
    Active,
    Primary,
}

const fn monitor_candidate_order(behavior: MonitorBehavior) -> [MonitorCandidate; 2] {
    match behavior {
        MonitorBehavior::Active => [MonitorCandidate::Active, MonitorCandidate::Primary],
        MonitorBehavior::Primary => [MonitorCandidate::Primary, MonitorCandidate::Active],
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloseAction {
    Hide,
    Exit,
}

pub(crate) const fn close_action(behavior: CloseBehavior) -> CloseAction {
    match behavior {
        CloseBehavior::Hide => CloseAction::Hide,
        CloseBehavior::Quit => CloseAction::Exit,
    }
}

pub const fn geometry_for(mode: WindowMode) -> WindowGeometry {
    match mode {
        WindowMode::Collapsed => WindowGeometry {
            width: 700.0,
            height: 66.0,
            min_width: 620.0,
            max_width: 760.0,
            min_height: 66.0,
            max_height: 66.0,
            resizable: false,
        },
        WindowMode::Expanded => WindowGeometry {
            width: 800.0,
            height: 540.0,
            min_width: 720.0,
            max_width: 960.0,
            min_height: 320.0,
            max_height: 600.0,
            resizable: true,
        },
        WindowMode::Onboarding => WindowGeometry {
            width: 800.0,
            height: 600.0,
            min_width: 720.0,
            max_width: 960.0,
            min_height: 560.0,
            max_height: 720.0,
            resizable: true,
        },
        WindowMode::Settings => WindowGeometry {
            width: 880.0,
            height: 600.0,
            min_width: 760.0,
            max_width: 1080.0,
            min_height: 520.0,
            max_height: 760.0,
            resizable: true,
        },
        WindowMode::Gallery => WindowGeometry {
            width: 1120.0,
            height: 760.0,
            min_width: 880.0,
            max_width: 1440.0,
            min_height: 640.0,
            max_height: 960.0,
            resizable: true,
        },
    }
}

pub fn effect_fallback_order() -> [Effect; 3] {
    [Effect::Acrylic, Effect::Mica, Effect::Blur]
}

fn launcher_position(
    work_area: WorkArea,
    logical_width: f64,
    logical_height: f64,
    scale_factor: f64,
) -> LauncherPosition {
    let physical_width = (logical_width * scale_factor).round() as i32;
    let physical_height = (logical_height * scale_factor).round() as i32;
    let horizontal_space = (work_area.width as i32 - physical_width).max(0);
    let vertical_space = (work_area.height as i32 - physical_height).max(0);

    LauncherPosition {
        x: work_area.x + horizontal_space / 2,
        y: work_area.y + (f64::from(vertical_space) * 0.18).round() as i32,
    }
}

fn apply_geometry(window: &WebviewWindow, geometry: WindowGeometry) -> Result<(), String> {
    window
        .set_resizable(true)
        .map_err(|error| error.to_string())?;
    window
        .set_min_size(None::<LogicalSize<f64>>)
        .map_err(|error| error.to_string())?;
    window
        .set_max_size(None::<LogicalSize<f64>>)
        .map_err(|error| error.to_string())?;
    window
        .set_size(LogicalSize::new(geometry.width, geometry.height))
        .map_err(|error| error.to_string())?;
    window
        .set_min_size(Some(LogicalSize::new(
            geometry.min_width,
            geometry.min_height,
        )))
        .map_err(|error| error.to_string())?;
    window
        .set_max_size(Some(LogicalSize::new(
            geometry.max_width,
            geometry.max_height,
        )))
        .map_err(|error| error.to_string())?;
    window
        .set_resizable(geometry.resizable)
        .map_err(|error| error.to_string())
}

fn monitor_for_candidate(
    window: &WebviewWindow,
    candidate: MonitorCandidate,
) -> Result<Option<Monitor>, String> {
    match candidate {
        MonitorCandidate::Primary => window.primary_monitor().map_err(|error| error.to_string()),
        MonitorCandidate::Active => {
            let cursor_monitor = window
                .cursor_position()
                .ok()
                .and_then(|cursor| window.monitor_from_point(cursor.x, cursor.y).ok().flatten());
            if cursor_monitor.is_some() {
                Ok(cursor_monitor)
            } else {
                window.current_monitor().map_err(|error| error.to_string())
            }
        }
    }
}

fn place_on_preferred_monitor(
    window: &WebviewWindow,
    geometry: WindowGeometry,
    behavior: MonitorBehavior,
) -> Result<(), String> {
    let mut monitor = None;
    for candidate in monitor_candidate_order(behavior) {
        monitor = monitor_for_candidate(window, candidate)?;
        if monitor.is_some() {
            break;
        }
    }

    let Some(monitor) = monitor else {
        return Ok(());
    };

    let work_area = monitor.work_area();
    let position = launcher_position(
        WorkArea {
            x: work_area.position.x,
            y: work_area.position.y,
            width: work_area.size.width,
            height: work_area.size.height,
        },
        geometry.width,
        geometry.height,
        monitor.scale_factor(),
    );

    window
        .set_position(PhysicalPosition::new(position.x, position.y))
        .map_err(|error| error.to_string())
}

pub fn apply_native_material(window: &WebviewWindow) -> Result<(), String> {
    window
        .set_effects(
            EffectsBuilder::new()
                .effects(effect_fallback_order())
                .color(Color(10, 18, 27, 196))
                .build(),
        )
        .map_err(|error| error.to_string())
}

pub fn show_from_app(
    app: &AppHandle,
    mode: WindowMode,
    source: WindowStateSource,
) -> Result<WindowStateEvent, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The Lumen window is unavailable.".to_owned())?;
    show_window(&window, mode, source)
}

#[cfg(all(debug_assertions, target_os = "windows"))]
pub(crate) fn show_for_performance_fixture(
    window: &WebviewWindow,
    mode: WindowMode,
) -> Result<WindowStateEvent, String> {
    use windows::Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SetWindowPos,
        },
    };
    let geometry = geometry_for(mode);
    apply_geometry(window, geometry)?;
    place_on_preferred_monitor(window, geometry, MonitorBehavior::default())?;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    // ShowWindow's first call can honor STARTUPINFO instead of its no-activate flag.
    unsafe {
        SetWindowPos(
            HWND(hwnd.0),
            None,
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW,
        )
    }
    .map_err(|error| error.to_string())?;
    Ok(WindowStateEvent::visible(mode, WindowStateSource::Command))
}

fn show_window(
    window: &WebviewWindow,
    mode: WindowMode,
    source: WindowStateSource,
) -> Result<WindowStateEvent, String> {
    let geometry = geometry_for(mode);
    let monitor_behavior = window
        .try_state::<RuntimePreferences>()
        .map(|preferences| preferences.monitor_behavior())
        .unwrap_or_default();
    apply_geometry(window, geometry)?;
    place_on_preferred_monitor(window, geometry, monitor_behavior)?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    window
        .emit("lumen://focus-input", ())
        .map_err(|error| error.to_string())?;
    let state = WindowStateEvent::visible(mode, source);
    if source != WindowStateSource::Command {
        window
            .emit("lumen://window-state", state)
            .map_err(|error| error.to_string())?;
    }
    Ok(state)
}

#[tauri::command]
pub fn show_lumen_window(
    window: WebviewWindow,
    mode: WindowMode,
) -> Result<WindowStateEvent, String> {
    show_window(&window, mode, WindowStateSource::Command)
}

#[tauri::command]
pub fn hide_lumen_window(window: WebviewWindow) -> Result<WindowStateEvent, String> {
    window.hide().map_err(|error| error.to_string())?;
    Ok(WindowStateEvent::hidden(WindowStateSource::Command))
}

pub fn emit_hidden_from_app(app: &AppHandle, source: WindowStateSource) -> Result<(), String> {
    app.emit_to(
        "main",
        "lumen://window-state",
        WindowStateEvent::hidden(source),
    )
    .map_err(|error| error.to_string())
}

pub fn hide_for_close(window: &WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|error| error.to_string())?;
    emit_hidden_from_app(window.app_handle(), WindowStateSource::Close)
}

#[tauri::command]
pub fn focus_lumen_input(window: WebviewWindow) -> Result<(), String> {
    window.set_focus().map_err(|error| error.to_string())?;
    window
        .emit("lumen://focus-input", ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_lumen_shortcut(app: AppHandle, accelerator: String) -> Result<(), String> {
    let registered = app.state::<ShortcutRegistration>();
    let mut current = registered
        .0
        .lock()
        .map_err(|_| "Shortcut registration state is unavailable.".to_owned())?;

    if current.accelerator.as_deref() == Some(accelerator.as_str()) {
        return Ok(());
    }

    let shortcuts = app.global_shortcut();
    let native = native_accelerator(&accelerator);
    if let Err(error) = shortcuts.register(native.as_str()) {
        current.error_code = Some("registration-unavailable".to_owned());
        return Err(format!("Could not register {accelerator}: {error}"));
    }

    if let Some(previous) = current.accelerator.as_deref()
        && let Err(error) = shortcuts.unregister(native_accelerator(previous).as_str())
    {
        let _ = shortcuts.unregister(native.as_str());
        current.error_code = Some("replacement-unavailable".to_owned());
        return Err(format!("Could not replace the current shortcut: {error}"));
    }

    current.accelerator = Some(accelerator);
    current.error_code = None;
    Ok(())
}

#[tauri::command]
pub fn set_monitor_behavior(
    preferences: State<'_, RuntimePreferences>,
    behavior: MonitorBehavior,
) -> Result<(), String> {
    preferences.set_monitor_behavior(behavior)
}

#[tauri::command]
pub fn set_close_behavior(
    preferences: State<'_, RuntimePreferences>,
    behavior: CloseBehavior,
) -> Result<(), String> {
    preferences.set_close_behavior(behavior)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_lifecycle_preferences_load_persisted_values_and_fail_safe() {
        let directory = std::env::temp_dir().join(format!("lumen-window-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("lumen.settings.json");

        let missing = RuntimePreferences::load(&path);
        assert_eq!(missing.monitor_behavior(), MonitorBehavior::Active);
        assert_eq!(missing.close_behavior(), CloseBehavior::Hide);
        assert_eq!(missing.shortcut(), "Alt + Space");

        std::fs::write(
            &path,
            r#"{"management":{"general":{"monitorBehavior":"primary","closeBehavior":"quit","shortcut":"Ctrl + Shift + L"}}}"#,
        )
        .unwrap();
        let persisted = RuntimePreferences::load(&path);
        assert_eq!(persisted.monitor_behavior(), MonitorBehavior::Primary);
        assert_eq!(persisted.close_behavior(), CloseBehavior::Quit);
        assert_eq!(persisted.shortcut(), "Ctrl + Shift + L");

        std::fs::write(
            &path,
            r#"{"management":{"general":{"monitorBehavior":"nearest","closeBehavior":false}}}"#,
        )
        .unwrap();
        let invalid = RuntimePreferences::load(&path);
        assert_eq!(invalid.monitor_behavior(), MonitorBehavior::Active);
        assert_eq!(invalid.close_behavior(), CloseBehavior::Hide);

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn native_shortcut_accelerators_remove_display_spacing() {
        assert_eq!(native_accelerator("Alt + Space"), "Alt+Space");
        assert_eq!(native_accelerator("Ctrl + Shift + L"), "Ctrl+Shift+L");
    }

    #[test]
    fn lifecycle_commands_reject_unknown_enum_values_and_apply_valid_values() {
        assert!(serde_json::from_value::<MonitorBehavior>(serde_json::json!("nearest")).is_err());
        assert!(serde_json::from_value::<CloseBehavior>(serde_json::json!("minimize")).is_err());

        let preferences = RuntimePreferences::default();
        preferences
            .set_monitor_behavior(MonitorBehavior::Primary)
            .unwrap();
        preferences.set_close_behavior(CloseBehavior::Quit).unwrap();
        assert_eq!(preferences.monitor_behavior(), MonitorBehavior::Primary);
        assert_eq!(preferences.close_behavior(), CloseBehavior::Quit);
    }

    #[test]
    fn lifecycle_preferences_drive_monitor_and_close_branches() {
        assert_eq!(
            monitor_candidate_order(MonitorBehavior::Active),
            [MonitorCandidate::Active, MonitorCandidate::Primary]
        );
        assert_eq!(
            monitor_candidate_order(MonitorBehavior::Primary),
            [MonitorCandidate::Primary, MonitorCandidate::Active]
        );
        assert_eq!(close_action(CloseBehavior::Hide), CloseAction::Hide);
        assert_eq!(close_action(CloseBehavior::Quit), CloseAction::Exit);
    }

    #[test]
    fn native_geometry_table_matches_each_window_mode_contract() {
        let expected = [
            (
                WindowMode::Collapsed,
                WindowGeometry {
                    width: 700.0,
                    height: 66.0,
                    min_width: 620.0,
                    max_width: 760.0,
                    min_height: 66.0,
                    max_height: 66.0,
                    resizable: false,
                },
            ),
            (
                WindowMode::Expanded,
                WindowGeometry {
                    width: 800.0,
                    height: 540.0,
                    min_width: 720.0,
                    max_width: 960.0,
                    min_height: 320.0,
                    max_height: 600.0,
                    resizable: true,
                },
            ),
            (
                WindowMode::Onboarding,
                WindowGeometry {
                    width: 800.0,
                    height: 600.0,
                    min_width: 720.0,
                    max_width: 960.0,
                    min_height: 560.0,
                    max_height: 720.0,
                    resizable: true,
                },
            ),
            (
                WindowMode::Settings,
                WindowGeometry {
                    width: 880.0,
                    height: 600.0,
                    min_width: 760.0,
                    max_width: 1080.0,
                    min_height: 520.0,
                    max_height: 760.0,
                    resizable: true,
                },
            ),
            (
                WindowMode::Gallery,
                WindowGeometry {
                    width: 1120.0,
                    height: 760.0,
                    min_width: 880.0,
                    max_width: 1440.0,
                    min_height: 640.0,
                    max_height: 960.0,
                    resizable: true,
                },
            ),
        ];

        for (mode, geometry) in expected {
            assert_eq!(geometry_for(mode), geometry, "{mode:?}");
        }
    }

    #[test]
    fn launcher_position_respects_scale_and_upper_fifth() {
        let position = launcher_position(
            WorkArea {
                x: 1920,
                y: 0,
                width: 2560,
                height: 1400,
            },
            700.0,
            66.0,
            1.5,
        );

        assert_eq!(position, LauncherPosition { x: 2675, y: 234 });
    }

    #[test]
    fn native_material_uses_documented_fallback_order() {
        assert_eq!(
            effect_fallback_order(),
            [Effect::Acrylic, Effect::Mica, Effect::Blur]
        );
    }

    #[test]
    fn window_state_events_serialize_for_native_visibility_reconciliation() {
        assert_eq!(
            serde_json::to_value(WindowStateEvent::visible(
                WindowMode::Expanded,
                WindowStateSource::SecondInstance,
            ))
            .expect("visible window state should serialize"),
            serde_json::json!({
                "mode": "expanded",
                "source": "secondInstance",
                "visible": true,
            }),
        );
        assert_eq!(
            serde_json::to_value(WindowStateEvent::hidden(WindowStateSource::Close))
                .expect("hidden window state should serialize"),
            serde_json::json!({
                "mode": null,
                "source": "close",
                "visible": false,
            }),
        );
    }
}
