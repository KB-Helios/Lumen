//! Offline developer fixture: this builder has no ordinary runtime/plugin state.
use crate::window::{WindowMode, WindowStateEvent};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

struct ForegroundWatch {
    initial: usize,
    changed: AtomicBool,
    stop: AtomicBool,
    samples: Mutex<Vec<(u128, usize)>>,
}

fn foreground() -> usize {
    // Read only: never restore, activate, or focus an OS window.
    unsafe { GetForegroundWindow().0 as usize }
}

impl ForegroundWatch {
    fn check(&self) -> Result<(), String> {
        if foreground() != self.initial {
            self.changed.store(true, Ordering::SeqCst);
        }
        if self.changed.load(Ordering::SeqCst) {
            Err("Foreground window changed; fixture capture is invalid".into())
        } else {
            Ok(())
        }
    }
}

#[tauri::command]
fn show_lumen_window(
    window: WebviewWindow,
    mode: WindowMode,
    watch: tauri::State<'_, Arc<ForegroundWatch>>,
) -> Result<WindowStateEvent, String> {
    watch.check()?;
    let result = crate::window::show_for_performance_fixture(&window, mode)?;
    watch.check()?;
    Ok(result)
}

#[tauri::command]
fn focus_lumen_input(
    window: WebviewWindow,
    watch: tauri::State<'_, Arc<ForegroundWatch>>,
) -> Result<(), String> {
    watch.check()?;
    window
        .emit("lumen://focus-input", ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn native_performance_status(
    window: WebviewWindow,
    watch: tauri::State<'_, Arc<ForegroundWatch>>,
) -> Result<serde_json::Value, String> {
    let valid = watch.check().is_ok();
    Ok(serde_json::json!({
        "fixture": "offline-ui-memory", "foregroundUnchanged": valid,
        "initialForeground": watch.initial, "currentForeground": foreground(),
        "foregroundSamples": *watch.samples.lock().map_err(|_| "Foreground monitor unavailable")?,
        "innerSize": window.inner_size().map_err(|error| error.to_string())?,
        "scaleFactor": window.scale_factor().map_err(|error| error.to_string())?,
        "visible": window.is_visible().map_err(|error| error.to_string())?,
    }))
}

pub fn run(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let root = crate::native_performance_root::admit_root(root)?;
    let watch = Arc::new(ForegroundWatch {
        initial: foreground(),
        changed: AtomicBool::new(false),
        stop: AtomicBool::new(false),
        samples: Mutex::new(Vec::new()),
    });
    let monitoring = watch.clone();
    let thread = std::thread::spawn(move || {
        let started = Instant::now();
        while !monitoring.stop.load(Ordering::SeqCst) {
            let current = foreground();
            if current != monitoring.initial {
                monitoring.changed.store(true, Ordering::SeqCst);
            }
            if let Ok(mut samples) = monitoring.samples.lock() {
                samples.push((started.elapsed().as_millis(), current));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    let result = (|| {
        let mut context = tauri::generate_context!();
        let mut config = context
            .config()
            .app
            .windows
            .first()
            .cloned()
            .ok_or("Missing main window configuration")?;
        context.config_mut().app.windows.clear();
        context.config_mut().identifier = "com.bridgehammer.lumen.native-performance".into();
        config.url =
            WebviewUrl::External("http://localhost:1420/scripts/native-performance.html".parse()?);
        config.visible = false;
        config.focus = false;
        tauri::Builder::default()
            .manage(watch.clone())
            .invoke_handler(tauri::generate_handler![show_lumen_window, crate::window::hide_lumen_window, focus_lumen_input, native_performance_status])
            .setup(move |app| {
                let window = WebviewWindowBuilder::from_config(app, &config)?
                    .data_directory(root.join("webview"))
                    .focusable(false)
                    .initialization_script("Object.defineProperty(window, '__LUMEN_NATIVE_PERFORMANCE__', {value: true});")
                    .on_navigation(|url| url.scheme() == "http" && url.host_str() == Some("localhost") && url.port() == Some(1420) && url.path() == "/scripts/native-performance.html")
                    .build()?;
                crate::window::apply_native_material(&window, WindowMode::Collapsed)?;
                Ok(())
            })
            .run(context)?;
        Ok::<(), Box<dyn std::error::Error>>(())
    })();
    watch.stop.store(true, Ordering::SeqCst);
    let _ = thread.join();
    result
}
