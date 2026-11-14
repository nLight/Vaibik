use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

const MODEL_FILE: &str = "parakeet-tdt-0.6b-v3.q8_0.gguf";
const MODEL_SIZE: u64 = 713_975_456;
const MODEL_SHA256: &str = "e3880d0aaaaf2c308ea2c35016b2b895c423eb3fda924c1b463d1c19b7f4d32e";

pub fn app_support() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("Library/Application Support/dev.vibemic.desktop")
}

pub fn model_directory() -> PathBuf {
    app_support().join("models")
}

pub fn model_file() -> PathBuf {
    model_directory().join(MODEL_FILE)
}

// The nemo-speech runtime ships inside the installed VibeMic bundle; fall back to
// the staged build tree so a dev run works without installing.
pub fn runtime() -> Result<PathBuf, String> {
    let tool = if cfg!(windows) { "nemo-speech.exe" } else { "nemo-speech" };
    let candidates = [
        PathBuf::from("/Applications/VibeMic.app/Contents/Resources/vibemic/engine/nemo/bin").join(tool),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../build/desktop-resources/engine/nemo/bin")
            .join(tool),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("Движок распознавания nemo-speech не найден.".into())
}

pub fn helper() -> Option<PathBuf> {
    let tool = if cfg!(windows) { "vibemic-desktop-draft.exe" } else { "vibemic-desktop-draft" };
    let candidates = [
        PathBuf::from("/Applications/VibeMic.app/Contents/Resources/vibemic/engine").join(tool),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../build/desktop-resources/engine").join(tool),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

pub fn model_installed() -> bool {
    let file = model_file();
    match fs::metadata(&file) {
        Ok(stat) => stat.is_file() && stat.len() == MODEL_SIZE,
        Err(_) => false,
    }
}

fn file_digest(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex::encode(digest.finalize()))
}

pub fn verify_model() -> Result<PathBuf, String> {
    let file = model_file();
    if !file.is_file() {
        return Err("Сначала установите модель распознавания Parakeet.".into());
    }
    let digest = file_digest(&file)?;
    if digest != MODEL_SHA256 {
        return Err("Файл модели повреждён. Перескачайте модель.".into());
    }
    Ok(file)
}

pub fn transcribe(wave: &[u8]) -> Result<String, String> {
    if wave.len() < 3244 || wave.len() > 4_000_000 || &wave[0..4] != b"RIFF" || &wave[8..12] != b"WAVE" {
        return Err("Запись слишком короткая или имеет неподдерживаемый формат.".into());
    }
    let model = verify_model()?;
    let runtime = runtime()?;
    let directory = std::env::temp_dir().join(format!("vibemic-gpui-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let result = (|| -> Result<String, String> {
        let input = directory.join("clip.wav");
        let output = directory.join("draft.txt");
        write_private(&input, wave)?;
        let mut child = Command::new(&runtime)
            .args([
                "transcribe",
                &input.to_string_lossy(),
                "--model",
                &model.to_string_lossy(),
                "--format",
                "text",
                "--output",
                &output.to_string_lossy(),
                "--no-warmup",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(180);
        let status = loop {
            match child.try_wait().map_err(|error| error.to_string())? {
                Some(status) => break status,
                None => {
                    if Instant::now() > deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("Распознавание заняло слишком много времени.".into());
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        };
        if !status.success() {
            return Err(format!("Движок распознавания завершился с кодом {}.", status.code().unwrap_or(-1)));
        }
        let text = fs::read_to_string(&output).map_err(|error| error.to_string())?;
        Ok(text.trim().to_string())
    })();
    let _ = fs::remove_dir_all(&directory);
    result
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())
}