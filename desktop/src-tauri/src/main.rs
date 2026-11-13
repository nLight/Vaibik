#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod bridge;
mod commands;
mod firmware;
mod hid;
mod macos;
mod models;
mod pty;
mod serial;
mod settings;
mod state;
mod tray;
mod usb_access;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use state::AppState;
use tauri::Manager;

fn engine_tool(resources: &std::path::Path, name: &str) -> PathBuf {
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    resources.join("engine").join(format!("{name}{suffix}"))
}

fn main() {
    let fixture = std::env::args().any(|arg| arg == "--fixture");
    let context = tauri::generate_context!();
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    if !fixture {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_window(app);
        }));
    }
    builder
        .invoke_handler(commands::handlers())
        .setup(move |app| {
            let handle = app.handle().clone();
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let workspace = manifest.parent().and_then(|path| path.parent()).map(PathBuf::from).unwrap_or_default();
            let resources = if tauri::is_dev() {
                workspace.join("build").join("desktop-resources")
            } else {
                app.path().resource_dir()?.join("vibemic")
            };
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("/"));
            let scratch = std::env::temp_dir();
            let config_dir = if fixture {
                scratch.join(format!("vibemic-fixture-{}", std::process::id()))
            } else {
                app.path().app_config_dir()?
            };
            std::fs::create_dir_all(&config_dir)?;
            let config_path = config_dir.join("settings.json");
            let firmware_backups = config_dir.join("firmware-backups");
            let loaded = settings::load(&config_path, &home, fixture);
            let lang = loaded.ui_language.clone();
            let auto_dictation = loaded.dictation_mode == "auto";
            let runtime = resources.join("engine").join("nemo").join("bin").join(if cfg!(windows) { "nemo-speech.exe" } else { "nemo-speech" });
            let helper = engine_tool(&resources, "vibemic-desktop-draft");
            let hid_handle = hid::spawn(handle.clone());
            let state = Arc::new(AppState {
                fixture,
                resources: resources.clone(),
                scratch,
                config_path,
                home,
                firmware_backups,
                settings: Mutex::new(loaded),
                models: models::ModelManager::new(config_dir.join("models"), runtime),
                terminal: pty::Terminal::new(fixture),
                external: bridge::ExternalDraft::new(resources.clone()),
                approval: bridge::ApprovalGesture::new(helper.clone()),
                native_dictation: bridge::NativeDictation::new(helper),
                hid: Mutex::new(hid_handle),
                pdm_cancel: Arc::new(AtomicBool::new(false)),
                transcription: AtomicBool::new(false),
                flashing: AtomicBool::new(false),
                saving_pair: AtomicBool::new(false),
                installing: Mutex::new(HashSet::new()),
                write_lock: Mutex::new(()),
            });
            app.manage(state.clone());
            if cfg!(target_os = "macos") && !fixture && auto_dictation {
                state.native_dictation.enable();
            }
            if !fixture && cfg!(not(target_os = "linux")) {
                let _ = tray::create(&handle, &lang);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<Arc<AppState>>();
                if !state.fixture && cfg!(not(target_os = "linux")) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(context)
        .expect("failed to build VibeMic")
        .run(|app, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                tray::show_window(app);
            }
        });
}