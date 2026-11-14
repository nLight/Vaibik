use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use hidapi::HidApi;

use crate::dictation::{self, Command};

const VENDOR: u16 = 0x1209;
const PRODUCT: u16 = 0x0003;
const USAGE_PAGE: u16 = 0xff31;
const USAGE: u16 = 1;
const WIRED_PRODUCT: &str = "PTT Dictation Mic (USB)";

static CONNECTION: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn connection() -> &'static Mutex<Option<String>> {
    CONNECTION.get_or_init(|| Mutex::new(None))
}

pub fn device_name() -> Option<String> {
    connection().lock().unwrap().clone()
}

fn set_connection(name: Option<String>) {
    *connection().lock().unwrap() = name;
}

pub fn spawn() {
    std::thread::spawn(run);
}

fn pick(api: &HidApi) -> Option<Vec<u8>> {
    let matches: Vec<_> = api
        .device_list()
        .filter(|device| device.vendor_id() == VENDOR && device.product_id() == PRODUCT)
        .collect();
    let has_usage = matches.iter().any(|device| device.usage_page() != 0);
    let filtered: Vec<_> = if has_usage {
        matches
            .into_iter()
            .filter(|device| device.usage_page() == USAGE_PAGE && device.usage() == USAGE)
            .collect()
    } else {
        matches
    };
    let wired: Vec<_> = filtered
        .iter()
        .filter(|device| {
            device
                .product_string()
                .map(|name| name.contains(WIRED_PRODUCT))
                .unwrap_or(false)
        })
        .collect();
    let candidates = if wired.is_empty() { filtered.iter().collect::<Vec<_>>() } else { wired };
    if candidates.len() == 1 {
        Some(candidates[0].path().to_bytes().to_vec())
    } else {
        None
    }
}

fn run() {
    let Ok(mut api) = HidApi::new() else { return };
    let mut current: Option<hidapi::HidDevice> = None;
    let mut current_path: Vec<u8> = Vec::new();
    let mut last_scan = Instant::now() - Duration::from_secs(5);
    let mut last_verify = Instant::now();
    let mut pressed = false;
    let mut buffer = [0u8; 64];

    loop {
        if current.is_none() && last_scan.elapsed() >= Duration::from_secs(1) {
            last_scan = Instant::now();
            let _ = api.refresh_devices();
            if let Some(path) = pick(&api) {
                let cpath = std::ffi::CString::new(path.clone()).unwrap_or_default();
                if let Ok(device) = api.open_path(&cpath) {
                    let name = api
                        .device_list()
                        .find(|info| info.path().to_bytes() == path)
                        .and_then(|info| info.product_string().map(str::to_string))
                        .unwrap_or_default();
                    current_path = path;
                    current = Some(device);
                    last_verify = Instant::now();
                    pressed = false;
                    set_connection(Some(name));
                }
            }
        }

        if let Some(device) = &current {
            if last_verify.elapsed() >= Duration::from_secs(1) {
                last_verify = Instant::now();
                let _ = api.refresh_devices();
                let present = api.device_list().any(|info| info.path().to_bytes() == current_path);
                if !present {
                    current = None;
                    pressed = false;
                    set_connection(None);
                    continue;
                }
            }
            match device.read_timeout(&mut buffer, 100) {
                Ok(0) => {}
                Ok(count) => {
                    if let Some(command) = report_command(&buffer[..count], &mut pressed) {
                        dictation::send(command);
                    }
                }
                Err(_) => {
                    current = None;
                    pressed = false;
                    set_connection(None);
                }
            }
        } else {
            std::thread::sleep(Duration::from_millis(80));
        }
    }
}

fn report_command(data: &[u8], pressed: &mut bool) -> Option<Command> {
    if data.len() != 8 || data[0] != 1 {
        return None;
    }
    let value = data[1];
    if value > 1 {
        return None;
    }
    let down = value == 1;
    if down == *pressed {
        return None;
    }
    *pressed = down;
    Some(if down { Command::Start } else { Command::Stop })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ptt_edges_map_to_start_stop() {
        let mut pressed = false;
        assert!(matches!(report_command(&[1, 1, 0, 0, 0, 0, 0, 0], &mut pressed), Some(Command::Start)));
        assert!(report_command(&[1, 1, 0, 0, 0, 0, 0, 0], &mut pressed).is_none());
        assert!(matches!(report_command(&[1, 0, 1, 0, 0, 0, 0, 0], &mut pressed), Some(Command::Stop)));
        assert!(report_command(&[1, 0, 1, 0, 0, 0, 0, 0], &mut pressed).is_none());
    }

    #[test]
    fn non_button_reports_ignored() {
        let mut pressed = false;
        assert!(report_command(&[1, 4, 0, 0, 0, 0, 0, 0], &mut pressed).is_none());
        assert!(report_command(&[1, 2, 0, 0, 0, 0, 0, 0], &mut pressed).is_none());
        assert!(report_command(&[1, 1, 0, 0], &mut pressed).is_none());
        assert!(report_command(&[2, 1, 0, 0, 0, 0, 0, 0], &mut pressed).is_none());
        assert!(!pressed);
    }
}