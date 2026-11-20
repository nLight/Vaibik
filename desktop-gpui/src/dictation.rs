use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::native::{self, Route, Shortcut};
use crate::{audio, engine, hid, insert, sound};

pub enum Command {
    /// Keyboard F13 or the on-screen button: local recording only.
    Toggle,
    /// Transmitter button pressed (vendor HID report).
    PttDown,
    /// Transmitter button released; the byte is the firmware's end reason.
    PttUp(u8),
    CopyText(String),
    InsertText(String),
    SetInsertMode(bool),
    SetSound(bool),
    SetNative(bool),
}

#[derive(Clone)]
pub struct Snapshot {
    pub status: String,
    pub transcript: String,
    pub recording: bool,
    pub busy: bool,
    pub insert_mode: bool,
    pub sound: bool,
    pub native: bool,
}

struct Shared {
    status: String,
    transcript: String,
    recording: bool,
    insert_mode: bool,
    sound: bool,
    native: bool,
}

static SHARED: OnceLock<Mutex<Shared>> = OnceLock::new();
static SENDER: OnceLock<Sender<Command>> = OnceLock::new();
static JOBS: OnceLock<Sender<Job>> = OnceLock::new();
static PENDING: AtomicUsize = AtomicUsize::new(0);

// Claude: if its button still looks idle after the ⌘D tap, press it once via
// Accessibility; if it is still idle after that, record locally instead.
const CLAUDE_RETRY_AFTER: Duration = Duration::from_millis(350);
const CLAUDE_ABANDON_AFTER: Duration = Duration::from_millis(600);
const END_HOST_TIMEOUT: u8 = 3;
const END_RADIO_TIMEOUT: u8 = 2;

fn shared() -> &'static Mutex<Shared> {
    SHARED.get_or_init(|| {
        Mutex::new(Shared {
            status: initial_status(),
            transcript: String::new(),
            recording: false,
            insert_mode: true,
            sound: true,
            native: initial_native(),
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

// Follow the companion's saved choice; with no saved settings, use the app's own dictation.
fn initial_native() -> bool {
    let path = engine::app_support().join("settings.json");
    let Ok(text) = std::fs::read_to_string(path) else { return true };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { return true };
    ["codexDictationShortcut", "claudeDictationShortcut"]
        .iter()
        .any(|key| value.get(*key).and_then(serde_json::Value::as_bool).unwrap_or(false))
}

fn set_status(text: impl Into<String>) {
    shared().lock().unwrap().status = text.into();
}

fn set_recording(value: bool) {
    shared().lock().unwrap().recording = value;
}

fn cue(kind: &str) {
    if shared().lock().unwrap().sound {
        sound::play(kind);
    }
}

pub fn snapshot() -> Snapshot {
    let guard = shared().lock().unwrap();
    Snapshot {
        status: guard.status.clone(),
        transcript: guard.transcript.clone(),
        recording: guard.recording,
        busy: PENDING.load(Ordering::SeqCst) > 0,
        insert_mode: guard.insert_mode,
        sound: guard.sound,
        native: guard.native,
    }
}

static STARTED: OnceLock<Instant> = OnceLock::new();

/// Diagnostic trace on stderr with milliseconds since launch.
pub fn trace(message: impl AsRef<str>) {
    let started = STARTED.get_or_init(Instant::now);
    eprintln!("[{:>8} ms] {}", started.elapsed().as_millis(), message.as_ref());
}

pub fn send(command: Command) {
    if let Some(sender) = SENDER.get() {
        let _ = sender.send(command);
    }
}

pub fn start() {
    trace("VibeMic GPUI запущен");
    let (tx, rx) = mpsc::channel::<Command>();
    let _ = SENDER.set(tx);
    let (jobs_tx, jobs_rx) = mpsc::channel::<Job>();
    let _ = JOBS.set(jobs_tx);
    // One recognizer job at a time, in press order, so a new press never waits on the last one.
    std::thread::spawn(move || {
        while let Ok(job) = jobs_rx.recv() {
            finish(job);
            PENDING.fetch_sub(1, Ordering::SeqCst);
        }
    });
    if shared().lock().unwrap().native {
        std::thread::spawn(native::warm);
    }
    std::thread::spawn(move || controller(rx));
}

enum Take {
    Local { recorder: audio::Recorder, target_pid: Option<i32>, hardware: bool },
    Native { route: Route, check: Option<(Instant, bool)> },
}

fn controller(rx: mpsc::Receiver<Command>) {
    let mut take: Option<Take> = None;
    loop {
        let deadline = match &take {
            Some(Take::Native { check: Some((at, _)), .. }) => Some(*at),
            _ => None,
        };
        let command = match deadline {
            Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(command) => Some(command),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            },
            None => match rx.recv() {
                Ok(command) => Some(command),
                Err(_) => return,
            },
        };
        let Some(command) = command else {
            check_claude(&mut take);
            continue;
        };
        match &command {
            Command::Toggle => trace("F13: переключение записи"),
            Command::PttUp(reason) => trace(format!("PTT: отпущено, причина {reason}")),
            _ => {}
        }
        match command {
            Command::Toggle => match take {
                Some(Take::Local { .. }) => stop_local(&mut take),
                Some(Take::Native { .. }) => {}
                None => begin_local(&mut take, false),
            },
            Command::PttDown => {
                trace(format!("PTT: нажато (занято: {})", take.is_some()));
                if take.is_none() {
                    begin_hardware(&mut take);
                }
            }
            Command::PttUp(reason) => match take {
                Some(Take::Local { hardware: true, .. }) => stop_local(&mut take),
                Some(Take::Native { .. }) => stop_native(&mut take, reason),
                _ => {}
            },
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
                    set_status(match insert::insert(&text, target) {
                        Ok(()) => "Вставлено в активное поле.".to_string(),
                        Err(error) => format!("Вставка: {error}"),
                    });
                }
            }
            Command::SetInsertMode(value) => shared().lock().unwrap().insert_mode = value,
            Command::SetSound(value) => shared().lock().unwrap().sound = value,
            Command::SetNative(value) => {
                shared().lock().unwrap().native = value;
                if value {
                    std::thread::spawn(native::warm);
                }
            }
        }
    }
}

fn begin_hardware(take: &mut Option<Take>) {
    if shared().lock().unwrap().native {
        let asked = Instant::now();
        let route = native::begin();
        trace(match &route {
            Some(route) => format!("маршрут: {} {:?} ({} ms)", route.app, route.shortcut, asked.elapsed().as_millis()),
            None => format!("маршрут: своя запись ({} ms)", asked.elapsed().as_millis()),
        });
        if let Some(route) = route {
            if let Some(native_take) = start_native(route) {
                *take = Some(native_take);
                return;
            }
        }
    }
    begin_local(take, true);
}

fn start_native(route: Route) -> Option<Take> {
    let app = if route.app.is_empty() { "приложении".to_string() } else { route.app.clone() };
    let check = match route.shortcut {
        Shortcut::Codex => {
            let sent = hid::send_feature(1);
            trace(format!("хоткей Codex: {sent:?}"));
            sent.ok()?;
            None
        }
        Shortcut::Claude { command } => {
            let sent = hid::send_feature(command);
            trace(format!("хоткей Claude ({command}): {sent:?}"));
            if sent.is_err() {
                native::finish(route.session, true);
                return None;
            }
            Some((Instant::now() + CLAUDE_RETRY_AFTER, false))
        }
        Shortcut::None => None,
    };
    set_recording(true);
    set_status(format!("Диктовка в {app}… отпустите кнопку, чтобы закончить."));
    cue("start");
    Some(Take::Native { route, check })
}

fn check_claude(take: &mut Option<Take>) {
    let Some(Take::Native { route, check }) = take else { return };
    let Some((_, abandon)) = *check else { return };
    let idle = native::claude_idle(route.session, abandon);
    trace(format!("Claude: кнопка диктовки {} (abandon={abandon})", if idle { "простаивает" } else { "активна" }));
    if !idle {
        *check = None;
    } else if !abandon {
        *check = Some((Instant::now() + CLAUDE_ABANDON_AFTER, true));
    } else {
        // Claude never started (no focused composer): record here so the phrase still lands.
        let _ = hid::send_feature(0);
        *take = None;
        set_recording(false);
        begin_local(take, true);
        if take.is_some() {
            set_status("Claude не включил диктовку — записываю сам.");
        }
    }
}

fn stop_native(take: &mut Option<Take>, reason: u8) {
    let Some(Take::Native { route, .. }) = take.take() else { return };
    set_recording(false);
    cue("stop");
    if route.shortcut != Shortcut::Codex {
        native::finish(route.session, false);
    }
    let app = if route.app.is_empty() { "приложение".to_string() } else { route.app };
    set_status(match reason {
        END_HOST_TIMEOUT => format!("{app} не открыл микрофон VibeMic — выберите его входом в настройках {app}."),
        END_RADIO_TIMEOUT => "Связь с передатчиком прервалась — фраза могла обрезаться.".to_string(),
        _ => format!("Готово: {app} распознаёт сам."),
    });
}

fn begin_local(take: &mut Option<Take>, hardware: bool) {
    let target_pid = insert::frontmost_pid();
    let opened = Instant::now();
    let started = audio::Recorder::start();
    trace(match &started {
        Ok(recorder) => format!("своя запись: {} ({} ms)", recorder.device(), opened.elapsed().as_millis()),
        Err(error) => format!("своя запись не началась: {error}"),
    });
    match started {
        Ok(recorder) => {
            *take = Some(Take::Local { recorder, target_pid, hardware });
            set_recording(true);
            set_status("Идёт запись… отпустите, чтобы распознать.");
            cue("start");
        }
        Err(error) => {
            set_status(format!("Не удалось начать запись: {error}"));
            cue("error");
        }
    }
}

fn stop_local(take: &mut Option<Take>) {
    let Some(Take::Local { recorder, target_pid, .. }) = take.take() else { return };
    set_recording(false);
    cue("stop");
    let stopped = recorder.stop();
    trace(match &stopped {
        Ok(wav) => format!("запись остановлена: {:.2} с", wav.len().saturating_sub(44) as f32 / 32000.0),
        Err(error) => format!("запись не удалась: {error}"),
    });
    match stopped {
        Ok(wav) => {
            let insert_mode = shared().lock().unwrap().insert_mode;
            let Some(jobs) = JOBS.get() else { return };
            PENDING.fetch_add(1, Ordering::SeqCst);
            set_status("Распознавание Parakeet…");
            if jobs.send(Job { wav, target_pid, insert_mode }).is_err() {
                PENDING.fetch_sub(1, Ordering::SeqCst);
            }
        }
        Err(error) => set_status(format!("Запись не удалась: {error}")),
    }
}

fn current_pid() -> Option<i32> {
    Some(std::process::id() as i32)
}

struct Job {
    wav: Vec<u8>,
    target_pid: Option<i32>,
    insert_mode: bool,
}

fn finish(job: Job) {
    let result = engine::transcribe(&job.wav);
    trace(match &result {
        Ok(text) => format!("распознано: {} символов", text.chars().count()),
        Err(error) => format!("ошибка распознавания: {error}"),
    });
    let (transcript, status, ok) = match result {
        Ok(text) if text.is_empty() => (None, "Речь не распознана.".to_string(), false),
        Ok(text) => {
            let mut message = match insert::write_clipboard(&text) {
                Ok(()) => "Скопировано в буфер обмена.".to_string(),
                Err(error) => format!("Буфер обмена: {error}."),
            };
            if job.insert_mode {
                match insert::insert(&text, job.target_pid) {
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
        if let Some(text) = transcript {
            guard.transcript = text;
        }
        // Keep the live recording hint while a newer take is still being recorded.
        if !guard.recording {
            guard.status = status;
        }
    }
    cue(if ok { "done" } else { "error" });
}
