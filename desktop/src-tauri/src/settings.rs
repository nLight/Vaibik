use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::firmware::normalize_pair_code;

pub const DICTATION_MODES: [&str; 2] = ["local", "auto"];
pub const MODEL_IDS: [&str; 1] = ["parakeet"];
const PROFILE_FORMAT: &str = "vibemic-profile";
const PROFILE_VERSION: u64 = 1;
const PROFILE_LIMIT: u64 = 16 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub model: String,
    pub language: String,
    pub dictation_mode: String,
    pub codex_dictation_shortcut: bool,
    pub claude_dictation_shortcut: bool,
    pub ui_language: String,
    pub microphone: String,
    pub pair_code: String,
}

pub fn locale_language() -> String {
    let locale = sys_locale::get_locale().unwrap_or_else(|| "en".into()).to_lowercase();
    if locale.starts_with("ru") { "ru".into() } else { "en".into() }
}

pub fn defaults() -> Settings {
    Settings {
        model: "parakeet".into(),
        language: "auto".into(),
        dictation_mode: "local".into(),
        codex_dictation_shortcut: false,
        claude_dictation_shortcut: false,
        ui_language: locale_language(),
        microphone: String::new(),
        pair_code: String::new(),
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

pub fn valid_settings(value: &Value, initial: &Settings) -> Settings {
    let darwin = cfg!(target_os = "macos");
    let pair_code = string_field(value, "pairCode")
        .and_then(|code| normalize_pair_code(&code).ok())
        .unwrap_or_default();
    let model = string_field(value, "model").filter(|model| MODEL_IDS.contains(&model.as_str()));
    let dictation_mode = string_field(value, "dictationMode")
        .filter(|mode| darwin && DICTATION_MODES.contains(&mode.as_str()));
    let ui_language = string_field(value, "uiLanguage").filter(|lang| lang == "ru" || lang == "en");
    Settings {
        model: model.unwrap_or_else(|| initial.model.clone()),
        language: "auto".into(),
        dictation_mode: dictation_mode.unwrap_or_else(|| "local".into()),
        codex_dictation_shortcut: darwin && value.get("codexDictationShortcut").and_then(Value::as_bool).unwrap_or(false),
        claude_dictation_shortcut: darwin && value.get("claudeDictationShortcut").and_then(Value::as_bool).unwrap_or(false),
        ui_language: ui_language.unwrap_or_else(|| initial.ui_language.clone()),
        microphone: string_field(value, "microphone").map(|mic| mic.chars().take(1024).collect()).unwrap_or_default(),
        pair_code,
    }
}

pub fn load(config_path: &Path, fixture: bool) -> Settings {
    let initial = defaults();
    if fixture {
        return valid_settings(&serde_json::json!({ "uiLanguage": "ru" }), &initial);
    }
    let saved = fs::read_to_string(config_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .unwrap_or(Value::Null);
    valid_settings(&saved, &initial)
}

pub fn persist(config_path: &Path, settings: &Settings, fixture: bool) -> Result<(), String> {
    if fixture {
        return Ok(());
    }
    let temporary = config_path.with_extension("json.new");
    let contents = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())? + "\n";
    write_private(&temporary, contents.as_bytes())?;
    fs::rename(&temporary, config_path).map_err(|error| error.to_string())?;
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn portable_settings(value: &Value) -> Result<Value, String> {
    let model = value.get("model").and_then(Value::as_str).unwrap_or_default();
    let language = value.get("language").and_then(Value::as_str).unwrap_or_default();
    let dictation_mode = value.get("dictationMode").and_then(Value::as_str);
    let model_ok = MODEL_IDS.contains(&model) || model == "base" || model == "small";
    let languages = ["auto", "ru", "en", "de"];
    if !model_ok
        || !languages.contains(&language)
        || !value.get("pairCode").map(Value::is_string).unwrap_or(false)
        || dictation_mode.map(|mode| !DICTATION_MODES.contains(&mode)).unwrap_or(false)
    {
        return Err("В профиле указаны неподдерживаемые настройки.".into());
    }
    let pair_code = normalize_pair_code(value["pairCode"].as_str().unwrap())?;
    Ok(serde_json::json!({
        "model": "parakeet",
        "language": "auto",
        "dictationMode": dictation_mode.unwrap_or("local"),
        "pairCode": pair_code,
    }))
}

pub fn parse_profile(contents: &str) -> Result<Value, String> {
    let document: Value = serde_json::from_str(contents.trim_start_matches('\u{feff}'))
        .map_err(|_| "Файл профиля содержит некорректный JSON.".to_string())?;
    if document.get("format").and_then(Value::as_str) != Some(PROFILE_FORMAT) {
        return Err("Выберите файл профиля, экспортированный из VibeMic.".into());
    }
    if document.get("version").and_then(Value::as_u64) != Some(PROFILE_VERSION) {
        return Err("Эта версия профиля VibeMic пока не поддерживается.".into());
    }
    portable_settings(document.get("settings").unwrap_or(&Value::Null))
}

pub fn read_profile(file: &Path) -> Result<Value, String> {
    let stat = fs::metadata(file).map_err(|_| "Не удалось прочитать файл профиля. Проверьте доступ к файлу.".to_string())?;
    if !stat.is_file() || stat.len() > PROFILE_LIMIT {
        return Err("Выберите файл профиля размером до 16 КБ.".into());
    }
    let contents = fs::read_to_string(file)
        .map_err(|_| "Не удалось прочитать файл профиля. Проверьте доступ к файлу.".to_string())?;
    parse_profile(&contents)
}

pub fn write_profile(file: &Path, settings: &Settings, config_path: &Path) -> Result<(), String> {
    let directory = fs::canonicalize(file.parent().unwrap_or(Path::new(".")))
        .map_err(|_| "Не удалось сохранить файл профиля. Проверьте доступ к выбранной папке.".to_string())?;
    let destination = directory.join(file.file_name().unwrap_or_default());
    let config_directory = fs::canonicalize(config_path.parent().unwrap_or(Path::new(".")))
        .map_err(|error| error.to_string())?;
    let config = config_directory.join(config_path.file_name().unwrap_or_default());
    let current = fs::canonicalize(&destination).unwrap_or_else(|_| destination.clone());
    let comparable = |value: &Path| {
        if cfg!(target_os = "linux") {
            value.to_string_lossy().to_string()
        } else {
            value.to_string_lossy().to_lowercase()
        }
    };
    if comparable(&current) == comparable(&config) || comparable(&destination) == comparable(&config) {
        return Err("Сохраните профиль отдельно от внутреннего файла настроек VibeMic.".into());
    }
    let portable = portable_settings(&serde_json::to_value(settings).unwrap())?;
    let contents = serde_json::to_string_pretty(&serde_json::json!({
        "format": PROFILE_FORMAT,
        "version": PROFILE_VERSION,
        "settings": portable,
    }))
    .unwrap()
        + "\n";
    let temporary = directory.join(format!(".vibemic-{}.tmp", uuid::Uuid::new_v4()));
    let outcome = (|| -> Result<(), String> {
        use std::os::unix::fs::OpenOptionsExt;
        let mut handle = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        use std::io::Write;
        handle.write_all(contents.as_bytes()).map_err(|error| error.to_string())?;
        fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    outcome.map_err(|_| "Не удалось сохранить файл профиля. Проверьте доступ к выбранной папке.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_round_trip() {
        let settings = defaults();
        let portable = portable_settings(&serde_json::to_value(&settings).unwrap()).unwrap();
        assert_eq!(portable["model"], "parakeet");
        assert_eq!(portable["language"], "auto");
        let document = serde_json::json!({ "format": PROFILE_FORMAT, "version": 1, "settings": portable });
        let parsed = parse_profile(&document.to_string()).unwrap();
        assert_eq!(parsed["dictationMode"], "local");
        assert!(parse_profile("{}").is_err());
        assert!(parse_profile("not json").is_err());
    }

    #[test]
    fn legacy_profile_import() {
        let legacy = serde_json::json!({
            "format": PROFILE_FORMAT, "version": 1,
            "settings": {
                "model": "parakeet", "language": "auto", "agent": "codex", "output": "terminal",
                "autoInsert": true, "dictationMode": "auto", "pairCode": "8B27-3DE4"
            }
        });
        let parsed = parse_profile(&legacy.to_string()).unwrap();
        assert_eq!(parsed["dictationMode"], "auto");
        assert_eq!(parsed["pairCode"], "8B27-3DE4");
        assert!(parsed.get("output").is_none());
    }

    #[test]
    fn settings_validation() {
        let initial = defaults();
        let value = serde_json::json!({
            "model": "whisper", "output": "nowhere",
            "dictationMode": "auto", "uiLanguage": "fr", "pairCode": "8b27-3de4",
            "microphone": "mic-1", "autoInsert": false
        });
        let valid = valid_settings(&value, &initial);
        assert_eq!(valid.model, "parakeet");
        assert_eq!(valid.ui_language, initial.ui_language);
        assert_eq!(valid.pair_code, "8B27-3DE4");
        assert_eq!(valid.dictation_mode, if cfg!(target_os = "macos") { "auto" } else { "local" });
    }
}