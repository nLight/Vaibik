use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use hidapi::{HidApi, HidDevice};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const VENDOR: u16 = 0x1209;
const PRODUCT: u16 = 0x0003;
const USAGE_PAGE: u16 = 0xff31;
const USAGE: u16 = 1;
const WIRED_PRODUCT: &str = "PTT Dictation Mic (USB)";

pub enum HidCommand {
    Rescan,
    Feature(Vec<u8>),
}

#[derive(Clone)]
pub struct HidHandle {
    tx: Sender<HidCommand>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    connected: bool,
    transport: &'static str,
    product_name: String,
}

#[derive(Clone, Serialize)]
struct Report {
    data: Vec<u8>,
    at: f64,
}

impl HidHandle {
    pub fn rescan(&self) {
        let _ = self.tx.send(HidCommand::Rescan);
    }

    pub fn send_feature(&self, bytes: Vec<u8>) -> Result<(), String> {
        self.tx.send(HidCommand::Feature(bytes)).map_err(|_| "USB HID недоступен.".to_string())
    }
}

pub fn transport_of(name: &str) -> &'static str {
    if name.contains(WIRED_PRODUCT) { "usb" } else { "radio" }
}

pub fn spawn(app: AppHandle) -> HidHandle {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || run(app, rx));
    HidHandle { tx }
}

fn emit_connection(app: &AppHandle, connected: bool, name: &str) {
    let _ = app.emit(
        "hid:connection",
        Connection { connected, transport: transport_of(name), product_name: name.to_string() },
    );
}

fn pick(api: &HidApi) -> Option<Vec<u8>> {
    let matches: Vec<_> = api
        .device_list()
        .filter(|device| device.vendor_id() == VENDOR && device.product_id() == PRODUCT)
        .collect();
    let has_usage = matches.iter().any(|device| device.usage_page() != 0);
    let filtered: Vec<_> = if has_usage {
        matches.into_iter().filter(|device| device.usage_page() == USAGE_PAGE && device.usage() == USAGE).collect()
    } else {
        matches
    };
    let wired: Vec<_> = filtered
        .iter()
        .filter(|device| device.product_string().map(|name| name.contains(WIRED_PRODUCT)).unwrap_or(false))
        .collect();
    let candidates = if wired.is_empty() { filtered.iter().collect::<Vec<_>>() } else { wired };
    if candidates.len() == 1 {
        Some(candidates[0].path().to_bytes().to_vec())
    } else {
        None
    }
}

fn run(app: AppHandle, rx: Receiver<HidCommand>) {
    let Ok(api) = HidApi::new() else { return };
    let mut current: Option<HidDevice> = None;
    let mut current_path: Vec<u8> = Vec::new();
    let mut current_name = String::new();
    let mut last_scan = Instant::now() - Duration::from_secs(5);
    let mut last_verify = Instant::now();
    let mut buffer = [0u8; 64];

    loop {
        loop {
            match rx.try_recv() {
                Ok(HidCommand::Rescan) => last_scan = Instant::now() - Duration::from_secs(5),
                Ok(HidCommand::Feature(bytes)) => {
                    if let Some(device) = &current {
                        let mut report = vec![0u8];
                        report.extend_from_slice(&bytes);
                        if device.send_feature_report(&report).is_err() {
                            let _ = app.emit("hid:feature-error", ());
                        }
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }

        if current.is_none() && last_scan.elapsed() >= Duration::from_secs(1) {
            last_scan = Instant::now();
            if let Some(path) = pick(&api) {
                let cpath = std::ffi::CString::new(path.clone()).unwrap_or_default();
                if let Ok(device) = api.open_path(&cpath) {
                    current_name = api
                        .device_list()
                        .find(|info| info.path().to_bytes() == path)
                        .and_then(|info| info.product_string().map(str::to_string))
                        .unwrap_or_default();
                    current_path = path;
                    current = Some(device);
                    last_verify = Instant::now();
                    emit_connection(&app, true, &current_name);
                }
            }
        }

        if let Some(device) = &current {
            if last_verify.elapsed() >= Duration::from_secs(1) {
                last_verify = Instant::now();
                let present = api.device_list().any(|info| info.path().to_bytes() == current_path);
                if !present {
                    current = None;
                    emit_connection(&app, false, "");
                    continue;
                }
            }
            match device.read_timeout(&mut buffer, 100) {
                Ok(0) => {}
                Ok(count) => {
                    let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64() * 1000.0;
                    let _ = app.emit("hid:report", Report { data: buffer[..count].to_vec(), at });
                }
                Err(_) => {
                    current = None;
                    emit_connection(&app, false, "");
                }
            }
        } else {
            std::thread::sleep(Duration::from_millis(80));
        }
    }
}