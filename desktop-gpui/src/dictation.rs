use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};

use crate::{audio, engine, insert};

pub enum Command {
    Toggle,
    Copy,
    InsertNow,
    SetInsertMode(bool),
}

#[derive(Clone)]
pub struct Snapshot {
    pub status: String,
    pub transcript: String,
    pub recording: bool,
    pub busy: bool,
    pub insert_mode: bool,
}

struct Shared {
    status: String,
    transcript: String,
    recording: bool,
    busy: bool,
    insert_mode: bool,
}

static SHARED: OnceLock<Mutex<Shared>> = OnceLock::new();
static SENDER: OnceLock<Sender<Command>> = OnceLock::new();

fn shared() -> &'static Mutex<Shared> {
    SHARED.get_or_init(|| {
        Mutex::new(Shared {
            status: initial_status(),
            transcript: String::new(),
            recording: false,
            busy: false,
            insert_mode: true,
        })
    })
}

fn initial_status() -> String {
    if engine::model_installed() {
        "Модель Parakeet установлена. Зажмите горячую клавишу или нажмите «Запись».".into()
    } else {
        "Модель Parakeet не установлена.".into()
    }
}

fn set_status(text: impl Into<String>) {
    shared().lock().unwrap().status = text.into();
}

pub fn snapshot() -> Snapshot {
    let guard = shared().lock().unwrap();
    Snapshot {
        status: guard.status.clone(),
        transcript: guard.transcript.clone(),
        recording: guard.recording,
        busy: guard.busy,
        insert_mode: guard.insert_mode,
    }
}

pub fn send(command: Command) {
    if let Some(sender) = SENDER.get() {
        let _ = sender.send(command);
    }
}

pub fn start() {
    let (tx, rx) = mpsc::channel::<Command>();
    let _ = SENDER.set(tx);
    std::thread::spawn(move || controller(rx));
}

fn controller(rx: mpsc::Receiver<Command>) {
    let mut recorder: Option<audio::Recorder> = None;
    let mut target_pid: Option<i32> = None;
    while let Ok(command) = rx.recv() {
        match command {
            Command::Toggle => {
                if shared().lock().unwrap().busy {
                    continue;
                }
                if recorder.is_some() {
                    let rec = recorder.take().unwrap();
                    shared().lock().unwrap().recording = false;
                    match rec.stop() {
                        Ok(wav) => {
                            shared().lock().unwrap().busy = true;
                            set_status("Распознавание Parakeet…");
                            let insert_mode = shared().lock().unwrap().insert_mode;
                            std::thread::spawn(move || finish(wav, target_pid, insert_mode));
                        }
                        Err(error) => set_status(format!("Запись не удалась: {error}")),
                    }
                } else {
                    target_pid = insert::frontmost_pid();
                    match audio::Recorder::start() {
                        Ok(rec) => {
                            recorder = Some(rec);
                            shared().lock().unwrap().recording = true;
                            set_status("Идёт запись… отпустите, чтобы распознать.");
                        }
                        Err(error) => set_status(format!("Не удалось начать запись: {error}")),
                    }
                }
            }
            Command::Copy => {
                let text = shared().lock().unwrap().transcript.clone();
                if !text.is_empty() {
                    set_status(match insert::write_clipboard(&text) {
                        Ok(()) => "Скопировано в буфер обмена.".to_string(),
                        Err(error) => format!("Буфер обмена: {error}"),
                    });
                }
            }
            Command::InsertNow => {
                let text = shared().lock().unwrap().transcript.clone();
                if !text.is_empty() {
                    let target = insert::frontmost_pid().filter(|pid| Some(*pid) != current_pid());
                    set_status(match insert::insert(&text, target.or(target_pid)) {
                        Ok(()) => "Вставлено в активное поле.".to_string(),
                        Err(error) => format!("Вставка: {error}"),
                    });
                }
            }
            Command::SetInsertMode(value) => {
                shared().lock().unwrap().insert_mode = value;
            }
        }
    }
}

fn current_pid() -> Option<i32> {
    Some(std::process::id() as i32)
}

fn finish(wav: Vec<u8>, target_pid: Option<i32>, insert_mode: bool) {
    let result = engine::transcribe(&wav);
    let (transcript, status) = match result {
        Ok(text) if text.is_empty() => (None, "Речь не распознана.".to_string()),
        Ok(text) => {
            let mut message = match insert::write_clipboard(&text) {
                Ok(()) => "Скопировано в буфер обмена.".to_string(),
                Err(error) => format!("Буфер обмена: {error}."),
            };
            if insert_mode {
                match insert::insert(&text, target_pid) {
                    Ok(()) => message.push_str(" Вставлено в активное поле."),
                    Err(error) => message.push_str(&format!(" Вставка: {error}.")),
                }
            }
            (Some(text), message)
        }
        Err(error) => (None, format!("Ошибка распознавания: {error}")),
    };
    let mut guard = shared().lock().unwrap();
    guard.busy = false;
    if let Some(text) = transcript {
        guard.transcript = text;
    }
    guard.status = status;
}