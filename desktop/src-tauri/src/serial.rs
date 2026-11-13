use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const VENDOR: u16 = 0x1209;
const PRODUCT: u16 = 0x0002;
const CLIP_BYTES: usize = 4 + 3 * 16000 * 2;

#[derive(Clone, Serialize)]
struct Stage {
    stage: &'static str,
}

pub fn capture(app: &AppHandle, cancel: &Arc<AtomicBool>) -> Result<Vec<u8>, String> {
    let ports = serialport::available_ports().map_err(|error| error.to_string())?;
    let port_name = ports
        .iter()
        .find_map(|port| match &port.port_type {
            serialport::SerialPortType::UsbPort(serialport::UsbPortInfo { vid, pid, .. }) if *vid == VENDOR && *pid == PRODUCT => {
                Some(port.port_name.clone())
            }
            _ => None,
        })
        .ok_or_else(|| "Подключите один передатчик с прошивкой PDM Probe и повторите проверку.".to_string())?;
    let mut port = serialport::new(&port_name, 115200)
        .timeout(Duration::from_millis(200))
        .open()
        .map_err(|error| error.to_string())?;
    port.write_data_terminal_ready(true).map_err(|error| error.to_string())?;
    if cancel.load(Ordering::Relaxed) {
        return Err("Проверка отменена.".into());
    }
    port.write_all(&[0x52]).map_err(|error| error.to_string())?;
    let _ = app.emit("pdm:stage", Stage { stage: "recording" });

    let mut clip = vec![0u8; CLIP_BYTES];
    let mut received = 0usize;
    let mut header_seen = false;
    let mut expired = false;
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut chunk = [0u8; 8192];
    while received < CLIP_BYTES {
        if cancel.load(Ordering::Relaxed) && !expired {
            expired = true;
        }
        let remaining = CLIP_BYTES - received;
        let take = remaining.min(chunk.len());
        match port.read(&mut chunk[..take]) {
            Ok(0) => {
                return Err(if expired {
                    "Проверка отменена.".into()
                } else {
                    "Запись прервалась. Проверьте подключение USB.".into()
                });
            }
            Ok(count) => {
                clip[received..received + count].copy_from_slice(&chunk[..count]);
                let previous = received;
                received += count;
                if previous < 4 && received >= 4 && !header_seen {
                    header_seen = true;
                    let tag = &clip[0..4];
                    if tag == b"VERR" {
                        return Err("Плата сообщила об ошибке PDM. Проверьте питание и проводку микрофона.".into());
                    }
                    if tag != b"VMIC" {
                        return Err("Ответ PDM Probe не распознан. Перезапустите плату и повторите проверку.".into());
                    }
                    let _ = app.emit("pdm:stage", Stage { stage: "receiving" });
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                if Instant::now() > deadline {
                    return Err("Плата не передала полную запись за 15 секунд. Перезапустите её и повторите проверку.".into());
                }
            }
            Err(_) => {
                return Err("Запись прервалась. Проверьте подключение USB.".into());
            }
        }
    }
    if let Ok(extra) = port.bytes_to_read() {
        if extra > 0 {
            return Err("Плата передала лишние данные. Перезапустите её и повторите проверку.".into());
        }
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("Проверка отменена.".into());
    }
    Ok(clip)
}