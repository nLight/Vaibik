use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::agents;

#[derive(Clone, Serialize)]
struct TerminalData {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    id: String,
    exit_code: u32,
}

struct PtyHandles {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

struct Session {
    id: String,
    buffer: Arc<Mutex<Option<Vec<u8>>>>,
    pty: Option<PtyHandles>,
}

pub struct Terminal {
    inner: Mutex<Option<Session>>,
    fixture: bool,
}

const FIXTURE_BANNER: &str = "\x1b[?2004hCodex · тестовая сессия\r\nПроект: vibemic-demo\r\n\r\n> ";

impl Terminal {
    pub fn new(fixture: bool) -> Self {
        Self { inner: Mutex::new(None), fixture }
    }

    pub fn start(&self, app: &AppHandle, agent: &str, project: &str, executable: &str) -> Result<String, String> {
        agents::agent_spec(agent)?;
        let mut guard = self.inner.lock().unwrap();
        if guard.is_some() {
            return Err("Сначала закройте активную сессию.".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        if self.fixture {
            *guard = Some(Session {
                id: id.clone(),
                buffer: Arc::new(Mutex::new(Some(FIXTURE_BANNER.as_bytes().to_vec()))),
                pty: None,
            });
            return Ok(id);
        }
        if !std::path::Path::new(project).is_dir() {
            return Err("Выберите доступную папку проекта.".into());
        }
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 100, pixel_width: 0, pixel_height: 0 })
            .map_err(|error| error.to_string())?;
        let mut command = CommandBuilder::new(executable);
        command.cwd(project);
        command.env("TERM", "xterm-256color");
        for (key, value) in agents::agent_environment() {
            command.env(key, value);
        }
        let child = pair.slave.spawn_command(command).map_err(|error| error.to_string())?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
        let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
        let child = Arc::new(Mutex::new(child));
        let buffer = Arc::new(Mutex::new(Some(Vec::new())));
        let session = Session {
            id: id.clone(),
            buffer: buffer.clone(),
            pty: Some(PtyHandles { master: pair.master, writer, child: child.clone() }),
        };
        *guard = Some(session);
        drop(guard);

        let reader_app = app.clone();
        let reader_id = id.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut chunk = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(count) => {
                        pending.extend_from_slice(&chunk[..count]);
                        let text = drain_utf8(&mut pending);
                        if text.is_empty() {
                            continue;
                        }
                        let mut buf = buffer.lock().unwrap();
                        if let Some(store) = buf.as_mut() {
                            store.extend_from_slice(text.as_bytes());
                        } else {
                            drop(buf);
                            let _ = reader_app.emit("terminal:data", TerminalData { id: reader_id.clone(), data: text });
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let exit_app = app.clone();
        let exit_id = id.clone();
        std::thread::spawn(move || {
            let status = child.lock().unwrap().wait();
            let code = status.map(|status| status.exit_code()).unwrap_or(0);
            let _ = exit_app.emit("terminal:exit", TerminalExit { id: exit_id, exit_code: code });
        });
        Ok(id)
    }

    pub fn ready(&self, app: &AppHandle, id: &str) {
        let guard = self.inner.lock().unwrap();
        let Some(session) = guard.as_ref().filter(|session| session.id == id) else { return };
        let mut buffer = session.buffer.lock().unwrap();
        if let Some(store) = buffer.take() {
            if !store.is_empty() {
                let _ = app.emit("terminal:data", TerminalData { id: id.to_string(), data: String::from_utf8_lossy(&store).to_string() });
            }
        }
    }

    pub fn stop(&self, id: &str) {
        let session = {
            let mut guard = self.inner.lock().unwrap();
            match guard.as_ref() {
                Some(session) if session.id == id => guard.take(),
                _ => None,
            }
        };
        if let Some(session) = session {
            if let Some(pty) = session.pty {
                let _ = pty.child.lock().unwrap().kill();
            }
        }
    }

    pub fn stop_active(&self) {
        let session = self.inner.lock().unwrap().take();
        if let Some(session) = session {
            if let Some(pty) = session.pty {
                let _ = pty.child.lock().unwrap().kill();
            }
        }
    }

    pub fn input(&self, app: &AppHandle, id: &str, data: &str) {
        if data.len() > 160_000 {
            return;
        }
        let mut guard = self.inner.lock().unwrap();
        let Some(session) = guard.as_mut().filter(|session| session.id == id) else { return };
        if self.fixture {
            if data.starts_with("\x1b[200~") && data.ends_with("\x1b[201~") {
                let echoed = data[6..data.len() - 6].to_string();
                let _ = app.emit("terminal:data", TerminalData { id: id.to_string(), data: echoed });
            }
            return;
        }
        if let Some(pty) = &mut session.pty {
            let _ = pty.writer.write_all(data.as_bytes());
            let _ = pty.writer.flush();
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if !(2..=500).contains(&cols) || !(2..=200).contains(&rows) {
            return;
        }
        let guard = self.inner.lock().unwrap();
        let Some(session) = guard.as_ref().filter(|session| session.id == id) else { return };
        if let Some(pty) = &session.pty {
            let _ = pty.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }
}

fn drain_utf8(pending: &mut Vec<u8>) -> String {
    let mut end = pending.len();
    while end > 0 {
        match std::str::from_utf8(&pending[..end]) {
            Ok(text) => {
                let result = text.to_string();
                pending.drain(..end);
                return result;
            }
            Err(error) => {
                if error.error_len().is_some() {
                    let valid = error.valid_up_to();
                    let result = String::from_utf8_lossy(&pending[..valid]).to_string();
                    pending.drain(..valid);
                    return result;
                }
                end = error.valid_up_to();
            }
        }
    }
    String::new()
}