use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::Value;

use crate::engine;

// Minimum requirement: the transcribed text lands on the system clipboard.
pub fn write_clipboard(text: &str) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard.set_text(text.to_string()).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub fn frontmost_pid() -> Option<i32> {
    use objc2_app_kit::NSWorkspace;
    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    Some(app.processIdentifier())
}

#[cfg(not(target_os = "macos"))]
pub fn frontmost_pid() -> Option<i32> {
    None
}

#[cfg(target_os = "macos")]
pub fn activate(pid: i32) {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
        app.activateWithOptions(NSApplicationActivationOptions::empty());
    }
}

#[cfg(not(target_os = "macos"))]
pub fn activate(_pid: i32) {}

// Preferred requirement: insert into the active text area / input of the target
// app. Reuse the proven system bridge (AX selected-text for native fields,
// Cmd+V paste for web inputs). The target must be frontmost when the bridge
// starts, so activate it first.
pub fn insert(text: &str, target_pid: Option<i32>) -> Result<(), String> {
    write_clipboard(text)?;
    if let Some(pid) = target_pid {
        activate(pid);
        std::thread::sleep(Duration::from_millis(120));
    }
    let helper = engine::helper().ok_or("Системный мост вставки недоступен.")?;
    let mut child = Command::new(&helper)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let mut stdin = child.stdin.take().ok_or("Нет stdin моста.")?;
    let stdout = child.stdout.take().ok_or("Нет stdout моста.")?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|error| error.to_string())?;
    let first: Value = serde_json::from_str(line.trim()).unwrap_or(Value::Null);
    if !first.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let _ = child.kill();
        return Err(first.get("error").and_then(Value::as_str).unwrap_or("Мост не готов.").into());
    }
    let payload = serde_json::to_string(text).map_err(|error| error.to_string())? + "\n";
    stdin.write_all(payload.as_bytes()).and_then(|_| stdin.flush()).map_err(|error| error.to_string())?;
    let mut reply = String::new();
    reader.read_line(&mut reply).map_err(|error| error.to_string())?;
    let _ = child.kill();
    let _ = child.wait();
    let parsed: Value = serde_json::from_str(reply.trim()).unwrap_or(Value::Null);
    if parsed.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        Ok(())
    } else {
        Err(parsed.get("error").and_then(Value::as_str).unwrap_or("Вставка не удалась.").into())
    }
}