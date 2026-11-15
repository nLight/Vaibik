use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};

use crate::{audio, engine, insert, sound};

pub enum Command {
    Toggle,
    Start,
    Stop,
    CopyText(String),
    InsertText(String),
    SetInsertMode(bool),
    SetSound(bool),
}

#[derive(Clone)]
pub struct Snapshot {
    pub status: String,
    pub transcript: String,
    pub recording: bool,
    pub busy: bool,
    pub insert_mode: bool,
    pub sound: bool,
}

struct Shared {
    status: String,
    transcript: String,
    recording: bool,
    busy: bool,
    insert_mode: bool,
    sound: bool,
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
            sound: true,
        })
    })
}

fn initial_status() -> String {
    if engine::model_installed() {
        "Модель Parakeet установлена. Зажмите горячую клавишу или кнопку передатчика.".into()
    } else {
        "Модель Parakeet не установлена.".into()
    }
}

fn set_status(text: impl Into<String>) {
    shared().lock().unwrap().status = text.into();
}

fn sound_enabled() -> bool {
    shared().lock().unwrap().sound
}

fn cue(kind: &str) {
    if sound_enabled() {
        sound::play(kind);
    }
}

pub fn snapshot() -> Snapshot {
    let guard = shared().lock().unwrap();
    Snapshot {
        status: guard.status.clone(),
        transcript: guard.transcript.clone(),
        recording: guard.recording,
        busy: guard.busy,
        insert_mode: guard.insert_mode,
        sound: guard.sound,
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
                if recorder.is_some() {
                    stop_recording(&mut recorder, target_pid);
                } else {
                    begin_recording(&mut recorder, &mut target_pid);
                }
            }
            Command::Start => begin_recording(&mut recorder, &mut target_pid),
            Command::Stop => stop_recording(&mut recorder, target_pid),
            Command::CopyText(text) => {
                if !text.trim().is_empty() {
                    set_status(match insert::write_clipboard(&text) {
                        Ok(()) => "Скопировано в буфер обмена.".to_string(),
                        Err(error) => format!("Буфер обмена: {error}"),
                    });
                }
            }
            Command::InsertText(text) => {
                if !text.trim().is_empty() {
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
            Command::SetSound(value) => {
                shared().lock().unwrap().sound = value;
            }
        }
    }
}

fn begin_recording(recorder: &mut Option<audio::Recorder>, target_pid: &mut Option<i32>) {
    if shared().lock().unwrap().busy || recorder.is_some() {
        return;
    }
    *target_pid = insert::frontmost_pid();
    match audio::Recorder::start() {
        Ok(rec) => {
            *recorder = Some(rec);
            shared().lock().unwrap().recording = true;
            set_status("Идёт запись… отпустите, чтобы распознать.");
            cue("start");
        }
        Err(error) => {
            set_status(format!("Не удалось начать запись: {error}"));
            cue("error");
        }
    }
}

fn stop_recording(recorder: &mut Option<audio::Recorder>, target_pid: Option<i32>) {
    let Some(rec) = recorder.take() else { return };
    shared().lock().unwrap().recording = false;
    cue("stop");
    match rec.stop() {
        Ok(wav) => {
            shared().lock().unwrap().busy = true;
            set_status("Распознавание Parakeet…");
            let insert_mode = shared().lock().unwrap().insert_mode;
            std::thread::spawn(move || finish(wav, target_pid, insert_mode));
        }
        Err(error) => set_status(format!("Запись не удалась: {error}")),
    }
}

fn current_pid() -> Option<i32> {
    Some(std::process::id() as i32)
}

fn finish(wav: Vec<u8>, target_pid: Option<i32>, insert_mode: bool) {
    let result = engine::transcribe(&wav);
    let (transcript, status, ok) = match result {
        Ok(text) if text.is_empty() => (None, "Речь не распознана.".to_string(), false),
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
            (Some(text), message, true)
        }
        Err(error) => (None, format!("Ошибка распознавания: {error}"), false),
    };
    {
        let mut guard = shared().lock().unwrap();
        guard.busy = false;
        if let Some(text) = transcript {
            guard.transcript = text;
        }
        guard.status = status;
    }
    cue(if ok { "done" } else { "error" });
}