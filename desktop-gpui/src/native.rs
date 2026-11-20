// Native dictation in Codex and Claude Desktop. The macOS helper (`--native-dictation`)
// finds the frontmost supported app and, for Claude, presses its Stop button via
// Accessibility. The board itself presses the app's dictation shortcut on request.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};

use crate::engine;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Shortcut {
    /// The helper pressed the app's own Dictate button; nothing for the board to do.
    None,
    /// Hold ⌃⌥⇧F13 for the whole press.
    Codex,
    /// Tap ⌘D (or ⌘G on layouts where G produces "d").
    Claude { command: u8 },
}

pub struct Route {
    pub app: String,
    pub shortcut: Shortcut,
    pub session: u64,
}

struct Helper {
    child: Child,
    stdin: ChildStdin,
    pending: HashMap<u64, Sender<Value>>,
}

type Shared = Arc<Mutex<Option<Helper>>>;

static HELPER: OnceLock<Shared> = OnceLock::new();
static NEXT: Mutex<u64> = Mutex::new(0);

fn shared() -> &'static Shared {
    HELPER.get_or_init(|| Arc::new(Mutex::new(None)))
}

/// Start the helper ahead of the first press so the route decision costs no process launch.
pub fn warm() {
    if !cfg!(target_os = "macos") {
        return;
    }
    let mut guard = shared().lock().unwrap();
    if guard.is_some() {
        return;
    }
    let Some(binary) = engine::helper() else { return };
    let Ok(mut child) = Command::new(binary)
        .arg("--native-dictation")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        return;
    };
    *guard = Some(Helper { child, stdin, pending: HashMap::new() });
    drop(guard);
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(reply) = serde_json::from_str::<Value>(&line) else { continue };
            let Some(id) = reply.get("id").and_then(Value::as_u64) else { continue };
            if let Some(helper) = shared().lock().unwrap().as_mut() {
                if let Some(tx) = helper.pending.remove(&id) {
                    let _ = tx.send(reply);
                }
            }
        }
        if let Some(mut helper) = shared().lock().unwrap().take() {
            let _ = helper.child.kill();
            let _ = helper.child.wait();
        }
    });
}

fn request(command: &str, values: Value, timeout: Duration) -> Result<Value, String> {
    warm();
    let id = {
        let mut next = NEXT.lock().unwrap();
        *next += 1;
        *next
    };
    let (tx, rx) = mpsc::channel();
    {
        let mut guard = shared().lock().unwrap();
        let helper = guard.as_mut().ok_or("Системный мост диктовки недоступен.")?;
        let mut message = json!({ "id": id, "command": command });
        if let Value::Object(map) = values {
            for (key, value) in map {
                message[key] = value;
            }
        }
        let line = serde_json::to_string(&message).map_err(|error| error.to_string())? + "\n";
        if helper.stdin.write_all(line.as_bytes()).and_then(|_| helper.stdin.flush()).is_err() {
            if let Some(mut helper) = guard.take() {
                let _ = helper.child.kill();
            }
            return Err("Системный мост диктовки недоступен.".into());
        }
        helper.pending.insert(id, tx);
    }
    let reply = rx.recv_timeout(timeout).map_err(|_| {
        if let Some(helper) = shared().lock().unwrap().as_mut() {
            helper.pending.remove(&id);
        }
        "Встроенная диктовка не ответила вовремя.".to_string()
    })?;
    if reply.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        Ok(reply)
    } else {
        Err(reply
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Не удалось управлять встроенной диктовкой.")
            .to_string())
    }
}

/// Decide where this press goes. `None` means record locally.
pub fn begin() -> Option<Route> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let ask = || request("begin", json!({ "shortcut": true, "claudeShortcut": true }), Duration::from_millis(800));
    let reply = match ask() {
        Ok(reply) => reply,
        // A Claude session whose Stop never landed blocks every later begin; start clean.
        Err(error) if error.starts_with("Сначала завершите") => {
            reset();
            ask().ok()?
        }
        Err(error) => {
            crate::dictation::trace(format!("мост диктовки: {error}"));
            return None;
        }
    };
    route_of(&reply)
}

fn reset() {
    if let Some(mut helper) = shared().lock().unwrap().take() {
        let _ = helper.child.kill();
        let _ = helper.child.wait();
    }
}

fn route_of(reply: &Value) -> Option<Route> {
    if !reply.get("native").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    let shortcut = match reply.get("shortcut").and_then(Value::as_str).unwrap_or("") {
        "codex" => Shortcut::Codex,
        "claude" => match reply.get("usage").and_then(Value::as_u64) {
            Some(0x07) => Shortcut::Claude { command: 3 },
            Some(0x0a) => Shortcut::Claude { command: 4 },
            _ => return None,
        },
        _ => Shortcut::None,
    };
    Some(Route {
        app: reply.get("app").and_then(Value::as_str).unwrap_or("").to_string(),
        shortcut,
        session: reply.get("id").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// Claude: true when its dictation button is still idle. Without `abandon` the helper
/// presses it once more; with `abandon` it forgets the session.
pub fn claude_idle(session: u64, abandon: bool) -> bool {
    let command = if abandon { "claude-abandon" } else { "claude-retry" };
    request(command, json!({ "session": session }), Duration::from_millis(800))
        .ok()
        .and_then(|reply| reply.get("idle").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// Stop the app's dictation (Claude). Runs off the controller: the helper polls up to 1.2 s.
pub fn finish(session: u64, cancel: bool) {
    std::thread::spawn(move || {
        let values = if cancel { json!({}) } else { json!({ "session": session }) };
        let _ = request(if cancel { "cancel" } else { "end" }, values, Duration::from_secs(3));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_follow_helper_reply() {
        let codex = route_of(&json!({ "id": 7, "ok": true, "native": true, "shortcut": "codex", "app": "Codex" })).unwrap();
        assert_eq!(codex.shortcut, Shortcut::Codex);
        assert_eq!(codex.session, 7);
        let claude = route_of(&json!({ "id": 8, "ok": true, "native": true, "shortcut": "claude", "usage": 10 })).unwrap();
        assert_eq!(claude.shortcut, Shortcut::Claude { command: 4 });
        assert!(route_of(&json!({ "id": 9, "ok": true, "native": true, "shortcut": "claude", "usage": 0 })).is_none());
        assert!(route_of(&json!({ "id": 9, "ok": true, "native": false })).is_none());
        let button = route_of(&json!({ "id": 10, "ok": true, "native": true, "shortcut": "" })).unwrap();
        assert_eq!(button.shortcut, Shortcut::None);
    }
}
