use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};

const REVISION: &str = "541d1f99c6b0c3cd0b11a95167540bb8edefd82b";

pub struct ModelSpec {
    pub file: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

pub fn spec(id: &str) -> Result<ModelSpec, String> {
    match id {
        "parakeet" => Ok(ModelSpec {
            file: "parakeet-tdt-0.6b-v3.q8_0.gguf",
            size: 713975456,
            sha256: "e3880d0aaaaf2c308ea2c35016b2b895c423eb3fda924c1b463d1c19b7f4d32e",
        }),
        _ => Err("Неизвестная модель Parakeet.".into()),
    }
}

#[derive(Clone, Serialize)]
pub struct ModelStatus {
    pub installed: bool,
    pub damaged: bool,
    pub downloading: bool,
}

#[derive(Clone)]
struct Check {
    key: String,
    valid: bool,
}

pub struct ModelManager {
    directory: PathBuf,
    runtime: PathBuf,
    downloads: Mutex<HashMap<String, Arc<AtomicBool>>>,
    checks: Mutex<HashMap<String, Check>>,
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

impl ModelManager {
    pub fn new(directory: PathBuf, runtime: PathBuf) -> Self {
        Self { directory, runtime, downloads: Mutex::new(HashMap::new()), checks: Mutex::new(HashMap::new()) }
    }

    pub fn file(&self, id: &str) -> Result<PathBuf, String> {
        Ok(self.directory.join(spec(id)?.file))
    }

    fn integrity(&self, id: &str) -> Result<&'static str, String> {
        let model = spec(id)?;
        let file = self.file(id)?;
        let stat = match fs::metadata(&file) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok("missing"),
            Err(_) => return Ok("damaged"),
        };
        if !stat.is_file() || stat.len() != model.size {
            return Ok("damaged");
        }
        use std::os::unix::fs::MetadataExt;
        let key = format!(
            "{}:{}:{}:{}:{}",
            stat.dev(),
            stat.ino(),
            stat.len(),
            stat.mtime(),
            stat.ctime()
        );
        let cached = self.checks.lock().unwrap().get(id).filter(|check| check.key == key).cloned();
        let valid = match cached {
            Some(check) => check.valid,
            None => {
                let valid = file_digest(&file).map(|digest| digest == model.sha256).unwrap_or(false);
                self.checks.lock().unwrap().insert(id.to_string(), Check { key, valid });
                valid
            }
        };
        Ok(if valid { "verified" } else { "damaged" })
    }

    pub fn statuses(&self) -> Result<HashMap<String, ModelStatus>, String> {
        let downloading = self.downloads.lock().unwrap();
        let mut result = HashMap::new();
        for id in crate::settings::MODEL_IDS {
            let integrity = self.integrity(id)?;
            result.insert(
                id.to_string(),
                ModelStatus {
                    installed: integrity == "verified",
                    damaged: integrity == "damaged",
                    downloading: downloading.contains_key(id),
                },
            );
        }
        Ok(result)
    }

    pub fn install<F: Fn(u64, u64) + Send + Sync>(
        &self,
        id: &str,
        progress: F,
    ) -> Result<(), String> {
        let model = spec(id)?;
        let abort = Arc::new(AtomicBool::new(false));
        {
            let mut downloads = self.downloads.lock().unwrap();
            if downloads.contains_key(id) {
                return Err("Эта модель уже скачивается.".into());
            }
            downloads.insert(id.to_string(), abort.clone());
        }
        let result = self.download(id, &model, &abort, progress);
        self.downloads.lock().unwrap().remove(id);
        if abort.load(Ordering::Relaxed) {
            return Err("Загрузка отменена.".into());
        }
        result
    }

    fn download<F: Fn(u64, u64)>(
        &self,
        id: &str,
        model: &ModelSpec,
        abort: &AtomicBool,
        progress: F,
    ) -> Result<(), String> {
        fs::create_dir_all(&self.directory).map_err(|error| error.to_string())?;
        let destination = self.file(id)?;
        let temporary = destination.with_file_name(format!(
            "{}.{}.download",
            destination.file_name().unwrap().to_string_lossy(),
            uuid::Uuid::new_v4()
        ));
        let outcome = (|| -> Result<(), String> {
            let url = format!(
                "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/resolve/{REVISION}/{}",
                model.file
            );
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(30 * 60))
                .build()
                .map_err(|error| error.to_string())?;
            let mut response = client.get(&url).send().map_err(|error| error.to_string())?;
            if !response.status().is_success() {
                return Err(format!("Сервер моделей ответил {}.", response.status().as_u16()));
            }
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)
                .map_err(|error| error.to_string())?;
            let mut received: u64 = 0;
            let mut previous: i64 = -1;
            let mut digest = Sha256::new();
            let mut buffer = [0u8; 256 * 1024];
            loop {
                if abort.load(Ordering::Relaxed) {
                    return Err("Загрузка отменена.".into());
                }
                let count = response.read(&mut buffer).map_err(|error| error.to_string())?;
                if count == 0 {
                    break;
                }
                received += count as u64;
                if received > model.size {
                    return Err("Файл модели превышает ожидаемый размер.".into());
                }
                digest.update(&buffer[..count]);
                file.write_all(&buffer[..count]).map_err(|error| error.to_string())?;
                let percent = (received as f64 / model.size as f64 * 100.0).floor() as i64;
                if percent != previous {
                    previous = percent;
                    progress(received, model.size);
                }
            }
            if received != model.size || hex::encode(digest.finalize()) != model.sha256 {
                return Err("Контрольная сумма модели не совпала. Попробуйте скачать ещё раз.".into());
            }
            fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
            self.checks.lock().unwrap().remove(id);
            Ok(())
        })();
        let _ = fs::remove_file(&temporary);
        outcome
    }

    pub fn cancel(&self, id: &str) {
        if let Some(abort) = self.downloads.lock().unwrap().get(id) {
            abort.store(true, Ordering::Relaxed);
        }
    }

    pub fn verify(&self, id: &str) -> Result<PathBuf, String> {
        match self.integrity(id)? {
            "missing" => Err("Сначала установите модель распознавания.".into()),
            "damaged" => Err("Файл модели повреждён. Перескачайте модель на странице «Распознавание».".into()),
            _ => self.file(id),
        }
    }

    pub fn transcribe(&self, wave: &[u8], id: &str, scratch: &Path) -> Result<String, String> {
        if wave.len() < 3244 || wave.len() > 4_000_000 || &wave[0..4] != b"RIFF" || &wave[8..12] != b"WAVE" {
            return Err("Запись слишком короткая или имеет неподдерживаемый формат.".into());
        }
        let model = self.verify(id)?;
        let directory = scratch.join(format!("vibemic-audio-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let result = (|| -> Result<String, String> {
            let input = directory.join("clip.wav");
            let output = directory.join("draft.txt");
            write_private(&input, wave)?;
            let mut child = Command::new(&self.runtime)
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
                .map_err(|error| {
                    if error.kind() == std::io::ErrorKind::NotFound {
                        "Движок распознавания не найден в сборке приложения.".to_string()
                    } else {
                        error.to_string()
                    }
                })?;
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