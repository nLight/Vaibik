use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::bridge::{ApprovalGesture, ExternalDraft, NativeDictation};
use crate::hid::HidHandle;
use crate::models::ModelManager;
use crate::pty::Terminal;
use crate::settings::Settings;

pub struct AppState {
    pub fixture: bool,
    pub resources: PathBuf,
    pub scratch: PathBuf,
    pub config_path: PathBuf,
    pub home: PathBuf,
    pub firmware_backups: PathBuf,
    pub settings: Mutex<Settings>,
    pub models: ModelManager,
    pub terminal: Terminal,
    pub external: ExternalDraft,
    pub approval: ApprovalGesture,
    pub native_dictation: NativeDictation,
    pub hid: Mutex<HidHandle>,
    pub pdm_cancel: Arc<AtomicBool>,
    pub transcription: AtomicBool,
    pub flashing: AtomicBool,
    pub saving_pair: AtomicBool,
    pub installing: Mutex<HashSet<String>>,
    pub write_lock: Mutex<()>,
}

impl AppState {
    pub fn runtime(&self) -> PathBuf {
        let tool = if cfg!(windows) { "nemo-speech.exe" } else { "nemo-speech" };
        self.resources.join("engine").join("nemo").join("bin").join(tool)
    }

    pub fn helper(&self) -> PathBuf {
        let tool = if cfg!(windows) { "vibemic-desktop-draft.exe" } else { "vibemic-desktop-draft" };
        self.resources.join("engine").join(tool)
    }
}