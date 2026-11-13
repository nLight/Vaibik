use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub struct AgentSpec {
    pub name: &'static str,
    pub docs: &'static str,
    pub unix: &'static str,
    pub windows: &'static str,
}

pub fn agent_spec(id: &str) -> Result<AgentSpec, String> {
    match id {
        "codex" => Ok(AgentSpec {
            name: "Codex",
            docs: "https://learn.chatgpt.com/docs/codex/cli",
            unix: "https://chatgpt.com/codex/install.sh",
            windows: "https://chatgpt.com/codex/install.ps1",
        }),
        "claude" => Ok(AgentSpec {
            name: "Claude Code",
            docs: "https://code.claude.com/docs/en/setup",
            unix: "https://claude.ai/install.sh",
            windows: "https://claude.ai/install.ps1",
        }),
        _ => Err("Неизвестный агент.".into()),
    }
}

fn executable(file: &Path) -> bool {
    let Ok(stat) = fs::metadata(file) else { return false };
    if !stat.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        stat.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn agent_environment() -> Vec<(String, String)> {
    let home = dirs_home();
    let mut bins: Vec<PathBuf> = vec![
        home.join(".local/bin"),
        home.join(".cargo/bin"),
    ];
    if cfg!(target_os = "windows") {
        let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| home.to_string_lossy().to_string());
        bins.push(PathBuf::from(local).join("Programs/OpenAI/Codex/bin"));
    } else {
        bins.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]);
    }
    let nvm = home.join(".nvm/versions/node");
    let mut versions: Vec<String> = fs::read_dir(&nvm)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().is_dir())
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    versions.sort_by(|a, b| version_cmp(b, a));
    bins.extend(versions.into_iter().map(|version| nvm.join(version).join("bin")));
    let path_key = std::env::vars()
        .find(|(key, _)| key.eq_ignore_ascii_case("path"))
        .map(|(key, _)| key)
        .unwrap_or_else(|| "PATH".into());
    let current = std::env::var(&path_key).unwrap_or_default();
    let separator = if cfg!(windows) { ";" } else { ":" };
    let mut joined = current;
    for bin in bins {
        if !joined.is_empty() {
            joined.push_str(separator);
        }
        joined.push_str(&bin.to_string_lossy());
    }
    let mut env: Vec<(String, String)> = std::env::vars().collect();
    env.retain(|(key, _)| !key.eq_ignore_ascii_case("path"));
    env.push((path_key, joined));
    env
}

fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |value: &str| -> Vec<u64> {
        value
            .trim_start_matches('v')
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    parse(a).cmp(&parse(b))
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}

pub fn find_agent(id: &str, override_path: &str) -> Result<Option<String>, String> {
    agent_spec(id)?;
    if !override_path.is_empty() {
        return Ok(if executable(Path::new(override_path)) { Some(override_path.to_string()) } else { None });
    }
    let env = agent_environment();
    let search_path = env
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("path"))
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    let filename = format!("{id}{}", if cfg!(windows) { ".exe" } else { "" });
    let separator = if cfg!(windows) { ';' } else { ':' };
    for directory in search_path.split(separator) {
        let dir = Path::new(directory);
        if !dir.is_absolute() {
            continue;
        }
        let file = dir.join(&filename);
        if executable(&file) {
            return Ok(Some(file.to_string_lossy().to_string()));
        }
    }
    Ok(None)
}

pub fn install_agent<F: Fn(String) + Send + Sync + 'static>(id: &str, scratch: &Path, progress: F) -> Result<String, String> {
    let agent = agent_spec(id)?;
    let win = cfg!(target_os = "windows");
    let directory = scratch.join(format!("vibemic-installer-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let result = (|| -> Result<String, String> {
        let url = if win { agent.windows } else { agent.unix };
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|error| error.to_string())?;
        let response = client.get(url).send().map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("Сервер {} ответил {}.", agent.name, response.status().as_u16()));
        }
        let body = response.text().map_err(|error| error.to_string())?;
        let trimmed = body.trim_start().to_lowercase();
        if body.trim().is_empty() || body.len() > 512000 || trimmed.starts_with("<!doctype") || trimmed.starts_with("<html") {
            return Err("Сервер вернул некорректный файл установщика.".into());
        }
        let file = directory.join(if win { "install.ps1" } else { "install.sh" });
        fs::write(&file, &body).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&file, fs::Permissions::from_mode(0o600));
        }
        let mut command = if win {
            let mut cmd = Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
            cmd.arg(&file);
            cmd
        } else {
            let mut cmd = Command::new("/bin/bash");
            cmd.arg(&file);
            cmd
        };
        command.env_clear();
        for (key, value) in agent_environment() {
            command.env(key, value);
        }
        command.env("CODEX_NON_INTERACTIVE", "1");
        command.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let progress = std::sync::Arc::new(progress);
        let mut readers = Vec::new();
        if let Some(stdout) = child.stdout.take() {
            let progress = progress.clone();
            readers.push(std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().flatten() {
                    progress(format!("{line}\n"));
                }
            }));
        }
        if let Some(stderr) = child.stderr.take() {
            let progress = progress.clone();
            readers.push(std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().flatten() {
                    progress(format!("{line}\n"));
                }
            }));
        }
        let deadline = Instant::now() + Duration::from_secs(10 * 60);
        let status = loop {
            match child.try_wait().map_err(|error| error.to_string())? {
                Some(status) => break status,
                None => {
                    if Instant::now() > deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!("Установщик {} завершился с ошибкой.", agent.name));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        };
        for reader in readers {
            let _ = reader.join();
        }
        if !status.success() {
            return Err(format!("Установщик {} завершился с ошибкой.", agent.name));
        }
        find_agent(id, "")?.ok_or_else(|| "Установка завершилась. Укажите путь к CLI в настройках.".to_string())
    })();
    let _ = fs::remove_dir_all(&directory);
    result
}