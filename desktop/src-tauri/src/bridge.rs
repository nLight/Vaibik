use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

fn helper_name() -> String {
    format!("vibemic-desktop-draft{}", if cfg!(windows) { ".exe" } else { "" })
}

fn epoch_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64() * 1000.0
}

fn spawn_helper(binary: &Path, args: &[&str]) -> std::io::Result<Child> {
    Command::new(binary)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
}

fn error_of(reply: &Value, fallback: &str) -> String {
    reply.get("error").and_then(Value::as_str).unwrap_or(fallback).to_string()
}

pub struct ExternalDraft {
    directory: PathBuf,
    target: Arc<Mutex<Option<DraftTarget>>>,
}

struct DraftTarget {
    id: String,
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<Value>,
}

impl ExternalDraft {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory, target: Arc::new(Mutex::new(None)) }
    }

    pub fn supported(&self) -> bool {
        cfg!(target_os = "macos") || cfg!(target_os = "windows")
    }

    pub fn prepare(&self) -> Result<String, String> {
        if !self.supported() {
            return Err("На этой платформе используйте терминал VibeMic или копирование.".into());
        }
        self.cancel(None);
        let id = uuid::Uuid::new_v4().to_string();
        let binary = self.directory.join("engine").join(helper_name());
        let mut child = spawn_helper(&binary, &[]).map_err(|_| "Системный мост недоступен в этой сборке.".to_string())?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("Системный мост недоступен в этой сборке.")?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().flatten() {
                let message = serde_json::from_str::<Value>(&line)
                    .unwrap_or_else(|_| json!({ "ok": false, "error": "Не удалось прочитать ответ системного моста." }));
                if tx.send(message).is_err() {
                    break;
                }
            }
        });
        let first = match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(reply) => reply,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Системный мост не ответил вовремя.".into());
            }
        };
        if !first.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error_of(&first, "Системный мост завершился."));
        }
        *self.target.lock().unwrap() = Some(DraftTarget { id: id.clone(), child, stdin, rx });
        let watchdog = self.target.clone();
        let watchdog_id = id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(320));
            let mut guard = watchdog.lock().unwrap();
            if guard.as_ref().map(|target| target.id == watchdog_id).unwrap_or(false) {
                if let Some(mut target) = guard.take() {
                    let _ = target.child.kill();
                }
            }
        });
        Ok(id)
    }

    pub fn paste(&self, id: &str, text: &str) -> Result<(), String> {
        let mut target = {
            let mut guard = self.target.lock().unwrap();
            match guard.as_ref() {
                Some(target) if target.id == id => guard.take().unwrap(),
                _ => return Err("Активное окно больше недоступно.".into()),
            }
        };
        let result = (|| -> Result<(), String> {
            let line = serde_json::to_string(text).map_err(|error| error.to_string())? + "\n";
            if let Some(mut stdin) = target.stdin.take() {
                stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).map_err(|error| error.to_string())?;
            }
            let reply = target
                .rx
                .recv_timeout(Duration::from_secs(15))
                .map_err(|_| "Системный мост не ответил вовремя.".to_string())?;
            if !reply.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                return Err(error_of(&reply, "Системный мост завершился."));
            }
            Ok(())
        })();
        let _ = target.child.kill();
        let _ = target.child.wait();
        result
    }

    pub fn cancel(&self, id: Option<&str>) {
        let mut guard = self.target.lock().unwrap();
        if let Some(target) = guard.as_ref() {
            if id.map(|value| target.id != value).unwrap_or(false) {
                return;
            }
        }
        if let Some(mut target) = guard.take() {
            let _ = target.child.kill();
        }
    }
}

pub struct ApprovalGesture {
    binary: PathBuf,
    state: Arc<Mutex<ApprovalState>>,
}

#[derive(Default)]
struct ApprovalState {
    pending: Option<ApprovalPending>,
    last_token: Option<u32>,
}

struct ApprovalPending {
    token: u32,
    at: f64,
    child: Child,
    stdin: Option<ChildStdin>,
    ready: Arc<AtomicBool>,
    committed: bool,
}

const APPROVAL_LIFETIME: f64 = 575.0;
const APPROVAL_MAX_EDGE_AGE: f64 = 150.0;

impl ApprovalGesture {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary, state: Arc::new(Mutex::new(ApprovalState::default())) }
    }

    pub fn edge(&self, kind: &str, token: u32, at: f64) {
        let now = epoch_ms();
        let age = now - at;
        if !at.is_finite() || age < 0.0 || age > APPROVAL_MAX_EDGE_AGE {
            return;
        }
        let mut state = self.state.lock().unwrap();
        if kind == "commit" {
            let Some(pending) = state.pending.as_mut() else { return };
            if pending.token != token || pending.committed {
                return;
            }
            if !pending.ready.load(Ordering::Relaxed) || at <= pending.at || now - pending.at > APPROVAL_LIFETIME {
                if let Some(mut pending) = state.pending.take() {
                    let _ = pending.child.kill();
                }
                return;
            }
            pending.committed = true;
            if let Some(stdin) = pending.stdin.as_mut() {
                let _ = stdin.write_all(b"commit\n");
                let _ = stdin.flush();
            }
            return;
        }
        if kind != "arm" || state.last_token == Some(token) {
            return;
        }
        if let Some(mut pending) = state.pending.take() {
            let _ = pending.child.kill();
        }
        state.last_token = Some(token);
        let Ok(mut child) = spawn_helper(&self.binary, &["--approval"]) else { return };
        let stdin = child.stdin.take();
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            return;
        };
        let ready = Arc::new(AtomicBool::new(false));
        state.pending = Some(ApprovalPending { token, at, child, stdin, ready: ready.clone(), committed: false });
        let reader_ready = ready.clone();
        let reader_state = self.state.clone();
        std::thread::spawn(move || {
            let mut line = String::new();
            let ok = BufReader::new(stdout).read_line(&mut line).is_ok() && line.trim() == "true";
            if ok {
                reader_ready.store(true, Ordering::Relaxed);
            } else {
                cancel_token(&reader_state, token);
            }
        });
        let timer_state = self.state.clone();
        let delay = (APPROVAL_LIFETIME - age).max(0.0) as u64;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay));
            cancel_token(&timer_state, token);
        });
    }

    pub fn cancel(&self) {
        let mut state = self.state.lock().unwrap();
        if let Some(mut pending) = state.pending.take() {
            let _ = pending.child.kill();
        }
    }
}

fn cancel_token(state: &Arc<Mutex<ApprovalState>>, token: u32) {
    let mut guard = state.lock().unwrap();
    if guard.pending.as_ref().map(|pending| pending.token == token).unwrap_or(false) {
        if let Some(mut pending) = guard.pending.take() {
            let _ = pending.child.kill();
        }
    }
}

pub struct NativeDictation {
    binary: PathBuf,
    inner: Arc<Mutex<Option<DictationChild>>>,
    next: AtomicU64,
}

struct DictationChild {
    child: Child,
    stdin: ChildStdin,
    pending: HashMap<u64, Sender<Value>>,
}

impl NativeDictation {
    pub fn new(binary: PathBuf) -> Self {
        Self { binary, inner: Arc::new(Mutex::new(None)), next: AtomicU64::new(0) }
    }

    pub fn enable(&self) {
        let mut guard = self.inner.lock().unwrap();
        if guard.is_some() {
            return;
        }
        let Ok(mut child) = spawn_helper(&self.binary, &["--native-dictation"]) else { return };
        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill();
            return;
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            return;
        };
        *guard = Some(DictationChild { child, stdin, pending: HashMap::new() });
        drop(guard);
        let reader_inner = self.inner.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().flatten() {
                let Ok(reply) = serde_json::from_str::<Value>(&line) else { continue };
                let Some(id) = reply.get("id").and_then(Value::as_u64) else { continue };
                let mut guard = reader_inner.lock().unwrap();
                if let Some(child) = guard.as_mut() {
                    if let Some(tx) = child.pending.remove(&id) {
                        let _ = tx.send(reply);
                    }
                }
            }
            let mut guard = reader_inner.lock().unwrap();
            if let Some(mut child) = guard.take() {
                for (_, tx) in child.pending.drain() {
                    let _ = tx.send(json!({ "ok": false, "error": "Системный мост диктовки завершился." }));
                }
                let _ = child.child.kill();
            }
        });
    }

    fn request(&self, command: &str, values: Value) -> Result<Value, String> {
        self.enable();
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel();
        {
            let mut guard = self.inner.lock().unwrap();
            let Some(child) = guard.as_mut() else {
                return Err("Системный мост диктовки недоступен.".into());
            };
            child.pending.insert(id, tx);
            let mut message = json!({ "id": id, "command": command });
            if let Value::Object(map) = values {
                for (key, value) in map {
                    message[key] = value;
                }
            }
            let line = serde_json::to_string(&message).map_err(|error| error.to_string())? + "\n";
            if child.stdin.write_all(line.as_bytes()).and_then(|_| child.stdin.flush()).is_err() {
                child.pending.remove(&id);
                drop(guard);
                self.dispose();
                return Err("Системный мост диктовки недоступен.".into());
            }
        }
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(reply) => {
                if reply.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                    Ok(reply)
                } else {
                    Err(error_of(&reply, "Не удалось управлять встроенной диктовкой."))
                }
            }
            Err(_) => {
                if let Some(child) = self.inner.lock().unwrap().as_mut() {
                    child.pending.remove(&id);
                }
                self.dispose();
                Err("Встроенная диктовка не ответила вовремя.".into())
            }
        }
    }

    pub fn begin(&self, shortcut: bool, claude_shortcut: bool) -> Result<Value, String> {
        self.enable();
        let reply = self.request("begin", json!({ "shortcut": shortcut, "claudeShortcut": claude_shortcut }))?;
        Ok(json!({
            "native": reply.get("native").and_then(Value::as_bool).unwrap_or(false),
            "shortcut": reply.get("shortcut").and_then(Value::as_str).unwrap_or(""),
            "usage": reply.get("usage").and_then(Value::as_u64).unwrap_or(0),
            "app": reply.get("app").cloned().unwrap_or(Value::Null),
            "session": reply.get("id").cloned().unwrap_or(Value::Null),
        }))
    }

    pub fn finish(&self, session: u64) -> Result<Value, String> {
        self.request("end", json!({ "session": session }))
    }

    pub fn check_claude(&self, session: u64, abandon: bool) -> Result<bool, String> {
        let command = if abandon { "claude-abandon" } else { "claude-retry" };
        let reply = self.request(command, json!({ "session": session }))?;
        Ok(reply.get("idle").and_then(Value::as_bool).unwrap_or(false))
    }

    pub fn cancel(&self) -> Result<(), String> {
        if self.inner.lock().unwrap().is_some() {
            self.request("cancel", json!({}))?;
        }
        Ok(())
    }

    pub fn dispose(&self) {
        let child = self.inner.lock().unwrap().take();
        let Some(mut child) = child else { return };
        drop(child.stdin);
        for (_, tx) in child.pending.drain() {
            let _ = tx.send(json!({ "ok": false, "error": "Встроенная диктовка отменена." }));
        }
        let mut process = child.child;
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match process.try_wait() {
                    Ok(Some(_)) | Err(_) => break,
                    Ok(None) => {
                        if Instant::now() > deadline {
                            let _ = process.kill();
                            let _ = process.wait();
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
            }
        });
    }
}