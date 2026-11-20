use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use hidapi::HidApi;

use crate::dictation::{self, Command};

const VENDOR: u16 = 0x1209;
const PRODUCT: u16 = 0x0003;
const USAGE_PAGE: u16 = 0xff31;
const USAGE: u16 = 1;
const WIRED_PRODUCT: &str = "PTT Dictation Mic (USB)";
// Short reads keep feature requests (the Codex/Claude shortcut) on the press they belong to.
const READ_TIMEOUT_MS: i32 = 5;

// The transmitter reports its battery about every 5 s while idle; older data is stale.
const BATTERY_FRESH: Duration = Duration::from_secs(30);

static CONNECTION: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static BATTERY: Mutex<Option<(Battery, Instant)>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Battery {
    pub millivolts: Option<u16>,
    /// USB power is present; the voltage then says nothing about the charge.
    pub usb_power: bool,
    pub percent: Option<u8>,
}

/// The latest transmitter battery report, if it is recent.
pub fn battery() -> Option<Battery> {
    let guard = BATTERY.lock().unwrap();
    guard.filter(|(_, at)| at.elapsed() < BATTERY_FRESH).map(|(battery, _)| battery)
}

fn set_battery(value: Option<Battery>) {
    *BATTERY.lock().unwrap() = value.map(|battery| (battery, Instant::now()));
}

// Approximate 1-cell LiPo state of charge at rest (same curve as the Tauri companion).
const CURVE: [(u16, u8); 12] = [
    (3300, 0), (3500, 5), (3600, 10), (3700, 20), (3750, 30), (3800, 40),
    (3850, 50), (3900, 60), (3950, 70), (4000, 80), (4100, 90), (4200, 100),
];

fn battery_percent(millivolts: u16) -> Option<u8> {
    if !(2800..=4350).contains(&millivolts) {
        return None;
    }
    if millivolts <= CURVE[0].0 {
        return Some(0);
    }
    for pair in CURVE.windows(2) {
        let ((low, from), (high, to)) = (pair[0], pair[1]);
        if millivolts <= high {
            let share = f32::from(millivolts - low) / f32::from(high - low);
            return Some((f32::from(from) + share * f32::from(to - from)).round() as u8);
        }
    }
    Some(100)
}

fn decode_battery(data: &[u8]) -> Option<Battery> {
    if data.len() != 8 || data[0] != 1 || data[1] != 4 || data[2] > 3 || data[3] != 0 || data[6] != 0 || data[7] != 0 {
        return None;
    }
    let valid = data[2] & 1 != 0;
    let usb_power = data[2] & 2 != 0;
    let millivolts = u16::from_le_bytes([data[4], data[5]]);
    if valid {
        battery_percent(millivolts)?;
    } else if millivolts != 0 {
        return None;
    }
    Some(Battery {
        millivolts: valid.then_some(millivolts),
        usb_power,
        percent: if valid && !usb_power { battery_percent(millivolts) } else { None },
    })
}
static REQUESTS: OnceLock<Mutex<Option<Sender<Request>>>> = OnceLock::new();

struct Request {
    feature: Vec<u8>,
    reply: Sender<Result<(), String>>,
}

fn connection() -> &'static Mutex<Option<String>> {
    CONNECTION.get_or_init(|| Mutex::new(None))
}

fn requests() -> &'static Mutex<Option<Sender<Request>>> {
    REQUESTS.get_or_init(|| Mutex::new(None))
}

pub fn device_name() -> Option<String> {
    connection().lock().unwrap().clone()
}

fn set_connection(name: Option<String>) {
    *connection().lock().unwrap() = name;
}

pub fn spawn() {
    let (tx, rx) = mpsc::channel();
    *requests().lock().unwrap() = Some(tx);
    std::thread::spawn(move || run(rx));
}

/// Ask the connected board to hold (1), tap (3 = ⌘D, 4 = ⌘G) or release (0) a dictation
/// shortcut. The firmware only accepts a shortcut while its PTT key is down.
pub fn send_feature(command: u8) -> Result<(), String> {
    let (reply, result) = mpsc::channel();
    let sender = requests().lock().unwrap().clone().ok_or("USB HID недоступен.")?;
    sender
        .send(Request { feature: vec![command], reply })
        .map_err(|_| "USB HID недоступен.".to_string())?;
    result
        .recv_timeout(Duration::from_millis(500))
        .unwrap_or_else(|_| Err("Плата не ответила на команду хоткея.".into()))
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

fn run(rx: Receiver<Request>) {
    let Ok(mut api) = HidApi::new() else { return };
    // hidapi seizes macOS devices by default, which silently locks out any other VibeMic
    // companion (and leaves this one deaf if it starts second).
    #[cfg(target_os = "macos")]
    api.set_open_exclusive(false);
    let mut current: Option<hidapi::HidDevice> = None;
    let mut current_path: Vec<u8> = Vec::new();
    let mut last_scan = Instant::now() - Duration::from_secs(5);
    let mut last_verify = Instant::now();
    let mut pressed = false;
    let mut buffer = [0u8; 64];

    loop {
        loop {
            match rx.try_recv() {
                Ok(request) => {
                    let result = match &current {
                        Some(device) => {
                            let mut report = vec![0u8];
                            report.extend_from_slice(&request.feature);
                            device
                                .send_feature_report(&report)
                                .map_err(|_| "Плата отклонила хоткей диктовки.".to_string())
                        }
                        None => Err("VibeMic не подключён.".into()),
                    };
                    let _ = request.reply.send(result);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }

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
                    set_battery(None);
                    dictation::trace(format!("HID: подключено «{name}»"));
                    set_connection(Some(name));
                }
            }
        }

        let mut lost = false;
        if let Some(device) = &current {
            if last_verify.elapsed() >= Duration::from_secs(1) {
                last_verify = Instant::now();
                let _ = api.refresh_devices();
                lost = !api.device_list().any(|info| info.path().to_bytes() == current_path);
            }
            if !lost {
                match device.read_timeout(&mut buffer, READ_TIMEOUT_MS) {
                    Ok(0) => {}
                    Ok(count) => {
                        if let Some(battery) = decode_battery(&buffer[..count]) {
                            set_battery(Some(battery));
                        }
                        if let Some(command) = report_command(&buffer[..count], &mut pressed) {
                            dictation::send(command);
                        }
                    }
                    Err(_) => lost = true,
                }
            }
        } else {
            std::thread::sleep(Duration::from_millis(20));
        }
        if lost {
            dictation::trace("HID: устройство потеряно");
            current = None;
            set_connection(None);
            set_battery(None);
            if std::mem::take(&mut pressed) {
                // The release report can no longer arrive; end the take instead of recording forever.
                dictation::send(Command::PttUp(0));
            }
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
    Some(if down { Command::PttDown } else { Command::PttUp(data[2]) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ptt_edges_map_to_down_up() {
        let mut pressed = false;
        assert!(matches!(report_command(&[1, 1, 0, 0, 0, 0, 0, 0], &mut pressed), Some(Command::PttDown)));
        assert!(report_command(&[1, 1, 0, 0, 0, 0, 0, 0], &mut pressed).is_none());
        assert!(matches!(report_command(&[1, 0, 3, 0, 0, 0, 0, 0], &mut pressed), Some(Command::PttUp(3))));
        assert!(report_command(&[1, 0, 1, 0, 0, 0, 0, 0], &mut pressed).is_none());
    }

    #[test]
    fn battery_reports_decode_like_the_companion() {
        let report = |flags: u8, mv: u16| {
            let [low, high] = mv.to_le_bytes();
            [1, 4, flags, 0, low, high, 0, 0]
        };
        assert_eq!(
            decode_battery(&report(1, 3850)),
            Some(Battery { millivolts: Some(3850), usb_power: false, percent: Some(50) })
        );
        assert_eq!(decode_battery(&report(1, 3725)).unwrap().percent, Some(25));
        assert_eq!(
            decode_battery(&report(3, 4150)),
            Some(Battery { millivolts: Some(4150), usb_power: true, percent: None })
        );
        assert_eq!(
            decode_battery(&report(2, 0)),
            Some(Battery { millivolts: None, usb_power: true, percent: None })
        );
        assert!(decode_battery(&report(1, 2000)).is_none());
        assert!(decode_battery(&report(0, 3900)).is_none());
        assert!(decode_battery(&[1, 1, 0, 0, 0, 0, 0, 0]).is_none());
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
