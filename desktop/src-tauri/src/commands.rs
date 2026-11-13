use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

use crate::settings::{self, Settings};
use crate::state::AppState;
use crate::{agents, firmware, macos, serial, tray, usb_access};

type Shared = Arc<AppState>;

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

fn open_external(target: &str) -> Result<(), String> {
    let spawned = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(target).spawn()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd").args(["/C", "start", "", target]).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(target).spawn()
    };
    spawned.map(|_| ()).map_err(|error| error.to_string())
}

fn raw_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(value) => value
            .as_array()
            .map(|array| array.iter().filter_map(|item| item.as_u64().map(|byte| byte as u8)).collect())
            .ok_or_else(|| "Некорректная запись.".to_string()),
    }
}

fn persist(state: &AppState, app: &AppHandle, patch: Value) -> Result<Settings, String> {
    let _guard = state.write_lock.lock().unwrap();
    let current = state.settings.lock().unwrap().clone();
    let mut merged = serde_json::to_value(&current).map_err(|error| error.to_string())?;
    if let Value::Object(map) = patch {
        for (key, value) in map {
            merged[key] = value;
        }
    }
    let next = settings::valid_settings(&merged, &current);
    settings::persist(&state.config_path, &next, state.fixture)?;
    *state.settings.lock().unwrap() = next.clone();
    if cfg!(target_os = "macos") && !state.fixture {
        if next.dictation_mode == "auto" {
            state.native_dictation.enable();
        } else {
            state.native_dictation.dispose();
        }
    }
    tray::update(app, &next.ui_language);
    Ok(next)
}

fn agent_status(state: &AppState) -> Value {
    let installing = state.installing.lock().unwrap();
    let mut result = serde_json::Map::new();
    for id in settings::AGENT_IDS {
        let path = if state.fixture {
            if id == "codex" { Some("/opt/vibemic-fixture/bin/codex".to_string()) } else { None }
        } else {
            let override_path = match id {
                "codex" => state.settings.lock().unwrap().agent_paths.codex.clone(),
                _ => state.settings.lock().unwrap().agent_paths.claude.clone(),
            };
            agents::find_agent(id, &override_path).ok().flatten()
        };
        result.insert(id.to_string(), json!({ "path": path, "installing": installing.contains(id) }));
    }
    Value::Object(result)
}

async fn pick_folder(app: AppHandle, title: &str, default: Option<PathBuf>) -> Option<PathBuf> {
    let title = title.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file().set_title(title);
        if let Some(directory) = default {
            builder = builder.set_directory(directory);
        }
        builder.blocking_pick_folder().and_then(|path| path.into_path().ok())
    })
    .await
    .unwrap_or(None)
}

async fn pick_file(app: AppHandle, title: &str, filter: Option<(&str, &[&str])>) -> Option<PathBuf> {
    let title = title.to_string();
    let filter = filter.map(|(name, ext)| (name.to_string(), ext.iter().map(|e| e.to_string()).collect::<Vec<_>>()));
    tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file().set_title(title);
        if let Some((name, ext)) = &filter {
            let refs: Vec<&str> = ext.iter().map(String::as_str).collect();
            builder = builder.add_filter(name, &refs);
        }
        builder.blocking_pick_file().and_then(|path| path.into_path().ok())
    })
    .await
    .unwrap_or(None)
}

async fn save_file(app: AppHandle, title: &str, name: &str, filter: (&str, &[&str])) -> Option<PathBuf> {
    let title = title.to_string();
    let name = name.to_string();
    let filter_name = filter.0.to_string();
    let extensions: Vec<String> = filter.1.iter().map(|e| e.to_string()).collect();
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
        app.dialog()
            .file()
            .set_title(title)
            .set_file_name(name)
            .add_filter(&filter_name, &refs)
            .blocking_save_file()
            .and_then(|path| path.into_path().ok())
    })
    .await
    .unwrap_or(None)
}

#[tauri::command]
async fn app_init(app: AppHandle, state: State<'_, Shared>) -> Result<Value, String> {
    let settings = state.settings.lock().unwrap().clone();
    let usb_rule = if platform() != "linux" {
        Value::Null
    } else if state.fixture {
        json!("missing")
    } else {
        json!(usb_access::linux_status(&usb_access::packaged_rule()))
    };
    let models = if state.fixture {
        json!({ "parakeet": { "installed": true, "damaged": false, "downloading": false } })
    } else {
        serde_json::to_value(state.models.statuses()?).map_err(|error| error.to_string())?
    };
    let runtime = state.fixture || state.runtime().exists();
    Ok(json!({
        "settings": settings,
        "version": env!("CARGO_PKG_VERSION"),
        "platform": platform(),
        "fixture": state.fixture,
        "external": state.external.supported(),
        "usbRule": usb_rule,
        "models": models,
        "agents": agent_status(&state),
        "runtime": runtime,
    }))
}

#[tauri::command]
async fn settings_save(patch: Value, app: AppHandle, state: State<'_, Shared>) -> Result<Settings, String> {
    let Some(object) = patch.as_object() else {
        return Err("Некорректные настройки.".into());
    };
    let allowed = [
        "model", "language", "uiLanguage", "microphone", "agent", "autoInsert", "output",
        "dictationMode", "codexDictationShortcut", "claudeDictationShortcut",
    ];
    let filtered: serde_json::Map<String, Value> = object
        .iter()
        .filter(|(key, _)| allowed.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    persist(&state, &app, Value::Object(filtered))
}

#[tauri::command]
async fn settings_project(app: AppHandle, state: State<'_, Shared>) -> Result<Settings, String> {
    if state.fixture {
        return persist(&state, &app, json!({ "project": "/Volumes/Dev/Пример проекта с длинным названием" }));
    }
    let default = PathBuf::from(state.settings.lock().unwrap().project.clone());
    let Some(folder) = pick_folder(app.clone(), "Папка проекта", Some(default)).await else {
        return Ok(state.settings.lock().unwrap().clone());
    };
    persist(&state, &app, json!({ "project": folder.to_string_lossy() }))
}

#[tauri::command]
async fn settings_export_profile(app: AppHandle, state: State<'_, Shared>) -> Result<bool, String> {
    let destination = if state.fixture {
        Some(state.config_path.with_file_name("export-profile.json"))
    } else {
        save_file(app.clone(), "Сохранить профиль VibeMic", "VibeMic-profile.json", ("Профиль VibeMic", &["json"])).await
    };
    let Some(destination) = destination else { return Ok(false) };
    let _guard = state.write_lock.lock().unwrap();
    let settings = state.settings.lock().unwrap().clone();
    settings::write_profile(&destination, &settings, &state.config_path)
        .map_err(|_| "Не удалось сохранить файл профиля. Проверьте доступ к выбранной папке.".to_string())?;
    Ok(true)
}

#[tauri::command]
async fn settings_import_profile(app: AppHandle, state: State<'_, Shared>) -> Result<Value, String> {
    let source = if state.fixture {
        Some(state.config_path.with_file_name("import-profile.json"))
    } else {
        pick_file(app.clone(), "Открыть профиль VibeMic", Some(("Профиль VibeMic", &["json"]))).await
    };
    let Some(source) = source else { return Ok(Value::Null) };
    settings::read_profile(&source).map_err(|error| error)
}

#[tauri::command]
async fn settings_apply_profile(profile: Value, app: AppHandle, state: State<'_, Shared>) -> Result<Settings, String> {
    if state.flashing.load(Ordering::Relaxed) || state.saving_pair.load(Ordering::Relaxed) {
        return Err("Дождитесь окончания текущей операции с платой.".into());
    }
    let mut patch = settings::portable_settings(&profile)?;
    if patch.get("output").and_then(Value::as_str) == Some("desktop") && !state.external.supported() {
        patch["output"] = json!("manual");
    }
    state.saving_pair.store(true, Ordering::Relaxed);
    let result = persist(&state, &app, patch);
    state.saving_pair.store(false, Ordering::Relaxed);
    result.map_err(|_| "Не удалось применить профиль. Проверьте доступ к папке настроек.".to_string())
}

#[tauri::command]
async fn agent_status_command(state: State<'_, Shared>) -> Result<Value, String> {
    Ok(agent_status(&state))
}

#[tauri::command]
async fn agent_docs(id: String) -> Result<(), String> {
    let spec = agents::agent_spec(&id)?;
    open_external(spec.docs)
}

#[tauri::command]
async fn agent_choose(id: String, app: AppHandle, state: State<'_, Shared>) -> Result<Settings, String> {
    agents::agent_spec(&id)?;
    if state.fixture {
        return Ok(state.settings.lock().unwrap().clone());
    }
    let Some(file) = pick_file(app.clone(), "Выберите исполняемый файл CLI", None).await else {
        return Ok(state.settings.lock().unwrap().clone());
    };
    let executable = agents::find_agent(&id, &file.to_string_lossy())?
        .ok_or_else(|| "Выбранный файл не запускается.".to_string())?;
    let key = format!("agentPaths.{id}");
    let _ = key;
    let mut paths = serde_json::to_value(&state.settings.lock().unwrap().agent_paths).unwrap();
    paths[&id] = json!(executable);
    persist(&state, &app, json!({ "agentPaths": paths }))
}

#[tauri::command]
async fn agent_install(id: String, app: AppHandle, state: State<'_, Shared>) -> Result<String, String> {
    agents::agent_spec(&id)?;
    {
        let mut installing = state.installing.lock().unwrap();
        if installing.contains(&id) {
            return Err("Установщик уже запущен.".into());
        }
        installing.insert(id.clone());
    }
    let result = if state.fixture {
        Err("В тестовом режиме установка отключена.".to_string())
    } else {
        let shared = state.inner().clone();
        let log_app = app.clone();
        let log_id = id.clone();
        let install_id = id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            agents::install_agent(&install_id, &shared.scratch, move |line| {
                let _ = log_app.emit("agent:log", json!({ "id": log_id, "line": line }));
            })
        })
        .await
        .map_err(|error| error.to_string())?
    };
    state.installing.lock().unwrap().remove(&id);
    result
}

#[tauri::command]
async fn model_status(state: State<'_, Shared>) -> Result<Value, String> {
    if state.fixture {
        return Ok(json!({ "parakeet": { "installed": true, "damaged": false, "downloading": false } }));
    }
    serde_json::to_value(state.models.statuses()?).map_err(|error| error.to_string())
}

#[tauri::command]
async fn model_install(id: String, app: AppHandle, state: State<'_, Shared>) -> Result<(), String> {
    if state.fixture {
        return Err("В тестовом режиме загрузка отключена.".into());
    }
    let shared = state.inner().clone();
    let progress_app = app.clone();
    let progress_id = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        shared.models.install(&id, move |received, total| {
            let _ = progress_app.emit("model:progress", json!({ "id": progress_id, "received": received, "total": total }));
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn model_cancel(id: String, state: State<'_, Shared>) -> Result<(), String> {
    state.models.cancel(&id);
    Ok(())
}

#[tauri::command]
async fn audio_transcribe(request: Request<'_>, state: State<'_, Shared>) -> Result<String, String> {
    let bytes = raw_body(&request)?;
    if bytes.len() > 4_000_000 {
        return Err("Некорректная запись.".into());
    }
    if state.transcription.load(Ordering::Relaxed) {
        return Err("Предыдущая запись ещё распознаётся.".into());
    }
    state.transcription.store(true, Ordering::Relaxed);
    let result = if state.fixture {
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(Duration::from_millis(650));
            Ok(if bytes.first().copied().unwrap_or(0) != 0 {
                "Добавь проверку пустого ввода.".to_string()
            } else {
                "Проверь падающий тест в parser.ts и исправь причину.".to_string()
            })
        })
        .await
        .map_err(|error| error.to_string())?
    } else {
        let shared = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let model = shared.settings.lock().unwrap().model.clone();
            shared.models.transcribe(&bytes, &model, &shared.scratch)
        })
        .await
        .map_err(|error| error.to_string())?
    };
    state.transcription.store(false, Ordering::Relaxed);
    result
}

#[tauri::command]
async fn audio_save_pdm_clip(request: Request<'_>, app: AppHandle, state: State<'_, Shared>) -> Result<bool, String> {
    let bytes = raw_body(&request)?;
    let sample_rate = if bytes.len() >= 28 {
        u32::from_le_bytes(bytes[24..28].try_into().unwrap())
    } else {
        0
    };
    if bytes.len() != 96044 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" || sample_rate != 16000 {
        return Err("Запись PDM имеет неподдерживаемый формат.".into());
    }
    let destination = if state.fixture {
        Some(state.config_path.with_file_name("pdm-check.wav"))
    } else {
        save_file(app.clone(), "Сохранить проверку PDM", "VibeMic-PDM.wav", ("WAV", &["wav"])).await
    };
    let Some(destination) = destination else { return Ok(false) };
    let temporary = destination.with_file_name(format!(
        ".{}.{}.tmp",
        destination.file_name().unwrap_or_default().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let outcome = (|| -> Result<(), String> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&temporary);
    outcome.map_err(|_| "Не удалось сохранить запись. Проверьте доступ к выбранной папке.".to_string())?;
    Ok(true)
}

#[tauri::command]
async fn firmware_volumes(state: State<'_, Shared>) -> Result<Vec<firmware::Volume>, String> {
    if state.fixture {
        return Ok(vec![firmware::Volume {
            directory: "/Volumes/NICENANO".into(),
            board: "nRF52840-nicenano".into(),
            model: "nice!nano".into(),
            address: 0x26000,
            version: 6,
            identity: "fixture".into(),
            has_current: true,
        }]);
    }
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || firmware::find_bootloaders())
        .await
        .map_err(|error| error.to_string())
        .map(|volumes| {
            let _ = shared;
            volumes
        })
}

#[tauri::command]
async fn firmware_choose(app: AppHandle, state: State<'_, Shared>) -> Result<Value, String> {
    if state.fixture {
        return Ok(Value::Null);
    }
    let Some(folder) = pick_folder(app.clone(), "Диск с файлом INFO_UF2.TXT", None).await else {
        return Ok(Value::Null);
    };
    let volume = firmware::inspect_bootloader(&folder)?;
    serde_json::to_value(volume).map_err(|error| error.to_string())
}

#[tauri::command]
async fn firmware_generate_pair(state: State<'_, Shared>) -> Result<String, String> {
    Ok(if state.fixture { "8B27-3DE4".to_string() } else { firmware::generate_pair_code() })
}

#[tauri::command]
async fn firmware_save_pair(value: String, app: AppHandle, state: State<'_, Shared>) -> Result<Value, String> {
    if state.flashing.load(Ordering::Relaxed) || state.saving_pair.load(Ordering::Relaxed) {
        return Err("Дождитесь окончания текущей операции с платой.".into());
    }
    let code = match firmware::normalize_pair_code(&value) {
        Ok(code) => code,
        Err(error) => return Ok(json!({ "error": error })),
    };
    state.saving_pair.store(true, Ordering::Relaxed);
    let result = persist(&state, &app, json!({ "pairCode": code }));
    state.saving_pair.store(false, Ordering::Relaxed);
    match result {
        Ok(settings) => Ok(json!({ "settings": settings })),
        Err(_) => Ok(json!({ "error": "Не удалось сохранить код пары. Проверьте доступ к папке настроек и свободное место." })),
    }
}

#[tauri::command]
async fn firmware_flash(
    directory: String,
    role: String,
    identity: String,
    confirmed_code: String,
    state: State<'_, Shared>,
) -> Result<firmware::FlashResult, String> {
    if state.flashing.load(Ordering::Relaxed) || state.saving_pair.load(Ordering::Relaxed) {
        return Err("Дождитесь окончания текущей операции с платой.".into());
    }
    if confirmed_code != state.settings.lock().unwrap().pair_code {
        return Err("Код пары изменился. Подтвердите прошивку заново.".into());
    }
    state.flashing.store(true, Ordering::Relaxed);
    let result = if state.fixture {
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(Duration::from_millis(400));
            Ok(firmware::FlashResult { role, backup_saved: true })
        })
        .await
        .map_err(|error| error.to_string())?
    } else {
        let shared = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            firmware::flash_firmware(
                &directory,
                &role,
                &shared.resources,
                &identity,
                &shared.firmware_backups,
                &confirmed_code,
            )
        })
        .await
        .map_err(|error| error.to_string())?
    };
    state.flashing.store(false, Ordering::Relaxed);
    result
}

#[tauri::command]
async fn firmware_backups(state: State<'_, Shared>) -> Result<(), String> {
    if state.fixture {
        return Ok(());
    }
    std::fs::create_dir_all(&state.firmware_backups).map_err(|error| error.to_string())?;
    open_external(&state.firmware_backups.to_string_lossy())
        .map_err(|_| "Не удалось открыть папку резервных копий.".to_string())
}

#[tauri::command]
async fn device_linux_access(state: State<'_, Shared>) -> Result<Value, String> {
    if state.fixture {
        return Ok(json!("configured"));
    }
    if platform() != "linux" {
        return Ok(Value::Null);
    }
    let rule = usb_access::packaged_rule();
    let status = usb_access::install(&rule)?;
    Ok(json!(status))
}

#[tauri::command]
async fn terminal_start(agent: String, app: AppHandle, state: State<'_, Shared>) -> Result<String, String> {
    agents::agent_spec(&agent)?;
    let (project, override_path) = {
        let settings = state.settings.lock().unwrap();
        let override_path = if agent == "codex" { settings.agent_paths.codex.clone() } else { settings.agent_paths.claude.clone() };
        (settings.project.clone(), override_path)
    };
    let executable = if state.fixture {
        "fixture".to_string()
    } else {
        agents::find_agent(&agent, &override_path)?
            .ok_or_else(|| "Сначала установите CLI или укажите путь к нему.".to_string())?
    };
    let shared = state.inner().clone();
    let start_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || shared.terminal.start(&start_app, &agent, &project, &executable))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn terminal_ready(id: String, app: AppHandle, state: State<'_, Shared>) -> Result<(), String> {
    state.terminal.ready(&app, &id);
    Ok(())
}

#[tauri::command]
async fn terminal_stop(id: String, state: State<'_, Shared>) -> Result<(), String> {
    state.terminal.stop(&id);
    Ok(())
}

#[tauri::command]
async fn terminal_input(id: String, data: String, app: AppHandle, state: State<'_, Shared>) -> Result<(), String> {
    state.terminal.input(&app, &id, &data);
    Ok(())
}

#[tauri::command]
async fn terminal_resize(id: String, cols: u16, rows: u16, state: State<'_, Shared>) -> Result<(), String> {
    state.terminal.resize(&id, cols, rows);
    Ok(())
}

#[tauri::command]
async fn draft_copy(text: String, app: AppHandle, state: State<'_, Shared>) -> Result<(), String> {
    if text.len() > 160_000 {
        return Err("Некорректный черновик.".into());
    }
    if !state.fixture {
        app.clipboard().write_text(text).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn draft_prepare_external(state: State<'_, Shared>) -> Result<String, String> {
    if state.fixture {
        return Ok("fixture-draft".into());
    }
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || shared.external.prepare())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn draft_paste_external(id: String, text: String, state: State<'_, Shared>) -> Result<(), String> {
    if text.len() > 160_000 {
        return Err("Некорректный черновик.".into());
    }
    if state.fixture {
        return Ok(());
    }
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || shared.external.paste(&id, &text))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn draft_cancel_external(id: String, state: State<'_, Shared>) -> Result<(), String> {
    state.external.cancel(Some(&id));
    Ok(())
}

#[tauri::command]
async fn draft_permissions(state: State<'_, Shared>) -> Result<bool, String> {
    Ok(state.fixture || platform() != "darwin" || macos::accessibility_trusted(true))
}

#[tauri::command]
async fn approval_edge(kind: String, token: u32, at: f64, state: State<'_, Shared>) -> Result<(), String> {
    state.approval.edge(&kind, token, at);
    Ok(())
}

#[tauri::command]
async fn approval_cancel(state: State<'_, Shared>) -> Result<(), String> {
    state.approval.cancel();
    Ok(())
}

#[tauri::command]
async fn dictation_begin(state: State<'_, Shared>) -> Result<Value, String> {
    let mode = state.settings.lock().unwrap().dictation_mode.clone();
    let (codex, claude) = {
        let settings = state.settings.lock().unwrap();
        (settings.codex_dictation_shortcut, settings.claude_dictation_shortcut)
    };
    if state.fixture || platform() != "darwin" || mode != "auto" {
        return Ok(json!({ "native": false }));
    }
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || shared.native_dictation.begin(codex, claude))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn dictation_end(session: u64, state: State<'_, Shared>) -> Result<Value, String> {
    if session == 0 {
        return Err("Сессия диктовки изменилась.".into());
    }
    if state.fixture || platform() != "darwin" {
        return Ok(json!({ "native": true }));
    }
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || shared.native_dictation.finish(session))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn dictation_check_claude(session: u64, abandon: bool, state: State<'_, Shared>) -> Result<bool, String> {
    if session == 0 {
        return Err("Сессия диктовки изменилась.".into());
    }
    if state.fixture || platform() != "darwin" {
        return Ok(true);
    }
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || shared.native_dictation.check_claude(session, abandon))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn dictation_cancel(state: State<'_, Shared>) -> Result<(), String> {
    if state.fixture || platform() != "darwin" {
        return Ok(());
    }
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || shared.native_dictation.cancel())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn hid_rescan(state: State<'_, Shared>) -> Result<(), String> {
    state.hid.lock().unwrap().rescan();
    Ok(())
}

#[tauri::command]
async fn hid_send_feature(bytes: Vec<u8>, state: State<'_, Shared>) -> Result<(), String> {
    state.hid.lock().unwrap().send_feature(bytes)
}

#[tauri::command]
async fn pdm_capture(app: AppHandle, state: State<'_, Shared>) -> Result<Response, String> {
    state.pdm_cancel.store(false, Ordering::Relaxed);
    let shared = state.inner().clone();
    let capture_app = app.clone();
    let clip = tauri::async_runtime::spawn_blocking(move || serial::capture(&capture_app, &shared.pdm_cancel))
        .await
        .map_err(|error| error.to_string())??;
    Ok(Response::new(clip))
}

#[tauri::command]
async fn pdm_cancel(state: State<'_, Shared>) -> Result<(), String> {
    state.pdm_cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn ui_ready(app: AppHandle) -> Result<(), String> {
    tray::show_window(&app);
    Ok(())
}

pub fn handlers() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        app_init,
        settings_save,
        settings_project,
        settings_export_profile,
        settings_import_profile,
        settings_apply_profile,
        agent_status_command,
        agent_docs,
        agent_choose,
        agent_install,
        model_status,
        model_install,
        model_cancel,
        audio_transcribe,
        audio_save_pdm_clip,
        firmware_volumes,
        firmware_choose,
        firmware_generate_pair,
        firmware_save_pair,
        firmware_flash,
        firmware_backups,
        device_linux_access,
        terminal_start,
        terminal_ready,
        terminal_stop,
        terminal_input,
        terminal_resize,
        draft_copy,
        draft_prepare_external,
        draft_paste_external,
        draft_cancel_external,
        draft_permissions,
        approval_edge,
        approval_cancel,
        dictation_begin,
        dictation_end,
        dictation_check_claude,
        dictation_cancel,
        hid_rescan,
        hid_send_feature,
        pdm_capture,
        pdm_cancel,
        ui_ready
    ]
}