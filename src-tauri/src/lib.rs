mod activity;
mod computer_use;
mod consent;
mod gateway;
mod privacy;
pub mod provider_switcher;
mod search;
mod window;
mod windows_ai;

use tauri::Manager;
use tauri_plugin_global_shortcut::ShortcutState;

// Fixed, secret-free checkpoints make isolated packaged startup failures
// diagnosable without changing normal launches or emitting user content.
fn smoke_checkpoint(phase: &str) {
    if std::env::var("LUMEN_PACKAGED_SMOKE").as_deref() != Ok("1") {
        return;
    }
    let Some(root) = std::env::var_os("LUMEN_SMOKE_APP_DATA") else {
        return;
    };
    let Ok(root) = std::fs::canonicalize(root) else {
        return;
    };
    let Ok(temporary) = std::fs::canonicalize(std::env::temp_dir()) else {
        return;
    };
    if root == temporary || !root.starts_with(temporary) {
        return;
    }
    use std::io::Write;
    if let Ok(mut log) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("startup-checkpoints.log"))
    {
        let _ = writeln!(log, "{phase}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    smoke_checkpoint("run");
    let global_shortcut = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = window::show_from_app(
                    app,
                    window::WindowMode::Collapsed,
                    window::WindowStateSource::Shortcut,
                );
            }
        })
        .build();
    smoke_checkpoint("plugins-configured");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            windows_ai::queue_activations(app, &args);
            let _ = window::show_from_app(
                app,
                window::WindowMode::Collapsed,
                window::WindowStateSource::SecondInstance,
            );
        }))
        .plugin(global_shortcut)
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            smoke_checkpoint("setup");
            let smoke_enabled = std::env::var("LUMEN_PACKAGED_SMOKE").as_deref() == Ok("1");
            let data_directory = if smoke_enabled {
                match std::env::var_os("LUMEN_SMOKE_APP_DATA") {
                    Some(path) => {
                        let target = std::fs::canonicalize(std::path::PathBuf::from(path))?;
                        let temporary = std::fs::canonicalize(std::env::temp_dir())?;
                        if target == temporary || !target.starts_with(&temporary) {
                            return Err(std::io::Error::other(
                                "Packaged smoke app data must be a child of the Windows temporary directory",
                            )
                            .into());
                        }
                        target
                    }
                    None => {
                        return Err(std::io::Error::other(
                            "Packaged smoke requires an isolated app-data directory",
                        )
                        .into());
                    }
                }
            } else {
                app.path().app_data_dir()?
            };
            std::fs::create_dir_all(&data_directory)?;
            let settings_path = data_directory.join("lumen.settings.json");
            app.manage(consent::PersistedConsent::new(settings_path.clone()));
            let runtime_preferences = window::RuntimePreferences::load(&settings_path);
            let initial_shortcut = runtime_preferences.shortcut();
            app.manage(runtime_preferences);
            app.manage(privacy::PrivacyRuntime::load(&settings_path));
            app.manage(activity::ActivityRuntime::load(&settings_path));
            app.manage(gateway::mcp::McpRuntime::load(
                data_directory.join("mcp-permissions.json"),
            ));
            let history_enabled = privacy::load_history_enabled(&settings_path);
            let development_sidecar = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("binaries/agentgateway-x86_64-pc-windows-msvc.exe");
            let packaged_sidecar = app.path().resource_dir()?.join("agentgateway.exe");
            let sidecar = if packaged_sidecar.is_file() {
                packaged_sidecar
            } else {
                development_sidecar
            };
            let provider_registry = gateway::registry::ProviderRegistry::load(
                data_directory.join("provider-routes.json"),
            );
            let gateway = gateway::GatewaySupervisor::new(
                sidecar,
                &data_directory.join("runtime"),
                &provider_registry.routes(),
            )?;
            let _ = gateway.start();
            smoke_checkpoint("gateway");
            app.manage(gateway);
            app.manage(provider_registry);
            app.manage(gateway::answer::AnswerRuntime::default());
            app.manage(gateway::provisioning::ProvisioningManager::new(
                data_directory.clone(),
            ));
            app.manage(gateway::LocalRuntimeSupervisor::detect(Some(
                data_directory.clone(),
            )));
            let packaged_computer_use = app.path().resource_dir()?.join("lumen-computer-use.exe");
            let staged_computer_use = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("binaries/lumen-computer-use-x86_64-pc-windows-msvc.exe");
            let source_computer_use = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../workers/computer-use-preview/worker.py");
            app.manage(computer_use::ComputerUseSupervisor::detect(
                packaged_computer_use,
                staged_computer_use,
                source_computer_use,
            ));
            let packaged_cliproxy = app.path().resource_dir()?.join("cliproxy-sidecar.exe");
            let staged_cliproxy = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("binaries/cliproxy-sidecar-x86_64-pc-windows-msvc.exe");
            let mut cliproxy = provider_switcher::ProviderSwitcherSupervisor::new(
                &packaged_cliproxy,
                &staged_cliproxy,
                &data_directory.join("cliproxy"),
            );
            let _ = cliproxy.start();
            app.manage(tokio::sync::Mutex::new(cliproxy));
            let development_worker = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("binaries/lumen-enrichment-x86_64-pc-windows-msvc.exe");
            let packaged_worker = app.path().resource_dir()?.join("lumen-enrichment.exe");
            let worker_binary = if packaged_worker.is_file() {
                packaged_worker
            } else {
                development_worker
            };
            let development_engine = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("binaries/lumen-rivet-engine-x86_64-pc-windows-msvc.exe");
            let packaged_engine = app.path().resource_dir()?.join("lumen-rivet-engine.exe");
            let engine_binary = if packaged_engine.is_file() {
                packaged_engine
            } else {
                development_engine
            };
            let enrichment = gateway::EnrichmentSupervisor::new(
                worker_binary,
                engine_binary,
                data_directory.join("enrichment"),
            )?;
            let _ = enrichment.start();
            smoke_checkpoint("enrichment");
            app.manage(enrichment);
            let packaged_vector = app.path().resource_dir()?.join("vector.dll");
            let development_vector =
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/vector.dll");
            let vector_extension = if packaged_vector.is_file() {
                packaged_vector
            } else if smoke_enabled {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "The packaged sqlite-vector resource is missing",
                )
                .into());
            } else {
                development_vector
            };
            app.manage(search::IndexRuntime::open(
                &data_directory.join("lumen-index.sqlite3"),
                &vector_extension,
                history_enabled,
            )?);
            app.manage(std::sync::Arc::new(windows_ai::WindowsAiRuntime::new(
                &data_directory,
                &app.path().resource_dir()?,
            )));
            smoke_checkpoint("windows-ai");
            windows_ai::queue_activations(app.handle(), &std::env::args().collect::<Vec<_>>());
            app.manage(window::ShortcutRegistration::default());
            if let Err(error) = window::register_initial_shortcut(app.handle(), &initial_shortcut) {
                tauri_plugin_log::log::warn!("Global shortcut unavailable: {error}");
            }

            if let Some(main_window) = app.get_webview_window("main") {
                window::apply_native_material(&main_window)?;
            }
            smoke_checkpoint("material");

            if smoke_enabled {
                smoke_checkpoint("checks");
                let report_path = data_directory.join("lumen-packaged-smoke.json");
                let smoke = (|| -> Result<serde_json::Value, String> {
                    let search = search::run_packaged_search_smoke(
                        &data_directory.join("packaged-search-smoke"),
                        &vector_extension,
                    )?;
                    let main_window = app
                        .get_webview_window("main")
                        .ok_or_else(|| "The packaged launcher window is unavailable".to_owned())?;
                    window::show_from_app(
                        app.handle(),
                        window::WindowMode::Collapsed,
                        window::WindowStateSource::Command,
                    )?;
                    let shown = main_window.is_visible().unwrap_or(false);
                    window::hide_for_close(&main_window)?;
                    let hidden = !main_window.is_visible().unwrap_or(true);
                    let diagnostics_path = data_directory.join("diagnostics-smoke.json");
                    let diagnostics_source = serde_json::json!({
                        "appVersion": env!("CARGO_PKG_VERSION"),
                        "prompt": "packaged smoke secret",
                        "location": format!("failed at {}", data_directory.display()),
                    })
                    .to_string();
                    privacy::write_sanitized_diagnostics(
                        &diagnostics_path,
                        &diagnostics_source,
                    )?;
                    let diagnostics = std::fs::read_to_string(&diagnostics_path)
                        .map_err(|_| "The packaged diagnostics export is unavailable".to_owned())?;
                    let data_path = data_directory.to_string_lossy();
                    let diagnostics_export = diagnostics.contains("[redacted]")
                        && diagnostics.contains("[local-path]")
                        && !diagnostics.contains("packaged smoke secret")
                        && !diagnostics.contains(data_path.as_ref());
                    Ok(serde_json::json!({
                        "passed": search.exact_vector && search.lexical_fallback && shown && hidden && diagnostics_export,
                        "exactVector": search.exact_vector,
                        "lexicalFallback": search.lexical_fallback,
                        "vectorVersion": search.vector_version,
                        "windowShowHide": shown && hidden,
                        "diagnosticsExport": diagnostics_export,
                    }))
                })();
                let exit_code = if smoke.as_ref().is_ok_and(|value| {
                    value
                        .get("passed")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false)
                }) {
                    0
                } else {
                    1
                };
                let report = smoke.unwrap_or_else(|error| {
                    serde_json::json!({
                        "passed": false,
                        "error": error,
                    })
                });
                let report = privacy::sanitized_diagnostics_string(report)?;
                std::fs::write(report_path, report)?;
                app.handle().exit(exit_code);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search::list_files,
            search::search_filenames,
            search::get_file_metadata,
            search::get_basic_preview,
            search::open_file,
            search::open_containing_folder,
            search::indexing::get_index_status,
            search::indexing::synchronize_index_roots,
            search::indexing::search_hybrid,
            search::indexing::search_related,
            search::indexing::get_semantic_search_status,
            search::indexing::set_indexed_file_pinned,
            search::indexing::delete_index_data,
            search::indexing::set_history_enabled,
            search::indexing::clear_search_history,
            search::indexing::get_search_history_status,
            search::indexing::get_native_diagnostics,
            privacy::set_previews_enabled,
            privacy::export_diagnostics,
            activity::get_activity_status,
            activity::set_activity_policy,
            activity::set_user_pause,
            activity::choose_activity_executable,
            gateway::answer::start_answer,
            gateway::answer::cancel_answer,
            gateway::supervisor::gateway_health,
            gateway::supervisor::restart_gateway,
            gateway::credentials::set_provider_credential,
            gateway::credentials::delete_provider_credential,
            gateway::credentials::provider_credential_status,
            gateway::registry::list_provider_registry,
            gateway::registry::set_provider_route,
            gateway::registry::test_provider_route,
            gateway::mcp::list_mcp_services,
            gateway::mcp::set_tool_permission,
            gateway::mcp::invoke_lumen_tool,
            gateway::enrichment::enrichment_health,
            gateway::enrichment::enrichment_queue_status,
            gateway::enrichment::pause_enrichment,
            gateway::enrichment::resume_enrichment,
            gateway::enrichment::restart_enrichment,
            gateway::local_runtime::local_runtime_health,
            gateway::local_runtime::set_local_runtime_mode,
            gateway::provisioning::get_provisioning_status,
            gateway::provisioning::start_provisioning,
            gateway::provisioning::cancel_provisioning,
            computer_use::computer_use_health,
            computer_use::start_computer_use,
            computer_use::respond_computer_use_approval,
            computer_use::cancel_computer_use,
            provider_switcher::supervisor::cliproxy_health,
            provider_switcher::supervisor::cliproxy_restart,
            provider_switcher::client::cliproxy_get_config,
            provider_switcher::client::cliproxy_patch_config,
            provider_switcher::client::cliproxy_list_credentials,
            provider_switcher::client::cliproxy_oauth_auth_url,
            provider_switcher::client::cliproxy_oauth_poll,
            provider_switcher::client::cliproxy_oauth_cancel,
            provider_switcher::client::cliproxy_oauth_linked,
            provider_switcher::client::cliproxy_oauth_import,
            provider_switcher::client::cliproxy_usage,
            provider_switcher::files::switch_provider,
            provider_switcher::files::remove_from_live,
            windows_ai::windows_ai_status,
            windows_ai::windows_ai_update_preferences,
            windows_ai::windows_ai_prepare,
            windows_ai::windows_ai_text,
            windows_ai::windows_ai_image,
            windows_ai::windows_ai_search_content,
            windows_ai::windows_ai_rebuild_content,
            windows_ai::windows_ai_delete_content,
            windows_ai::windows_ai_discover_agents,
            windows_ai::windows_ai_invoke_agent,
            windows_ai::windows_ai_set_registration,
            windows_ai::windows_ai_set_access_token,
            windows_ai::windows_ai_cancel,
            windows_ai::windows_ai_consume_activation,
            window::show_lumen_window,
            window::hide_lumen_window,
            window::focus_lumen_input,
            window::set_lumen_shortcut,
            window::set_monitor_behavior,
            window::set_close_behavior,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let preferences = window.state::<window::RuntimePreferences>();
                match window::close_action(preferences.close_behavior()) {
                    window::CloseAction::Hide => {
                        api.prevent_close();
                        if let Some(webview) = window
                            .app_handle()
                            .get_webview_window(window.label())
                        {
                            let _ = window::hide_for_close(&webview);
                        }
                    }
                    window::CloseAction::Exit => window.app_handle().exit(0),
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
