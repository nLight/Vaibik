use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rand::RngCore;
use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};

const SOFTDEVICE_START: u32 = 0x1000;
const STORAGE_START: u32 = 0xec000;
const FAMILY: u32 = 0xada52840;
const PAIR_TAG: &[u8] = b"VIBEMICRF01";
const PAIR_DEFAULT: &str = "619B46D2";
const PAIR_UNSUPPORTED: &str = "В образе нет однозначного слота для кода пары. Переустановите VibeMic.";
const START_MAGIC: u32 = 0x0a324655;
const SECOND_MAGIC: u32 = 0x9e5d5157;
const END_MAGIC: u32 = 0x0ab16f30;
const UF2_MAX_BYTES: usize = 2 * 1024 * 1024;
const CURRENT: &str = "CURRENT.UF2";
const INFO: &str = "INFO_UF2.TXT";
const VOLUME_CHANGED: &str = "Диск загрузчика изменился. Обновите список плат и подтвердите прошивку заново.";
const BACKUP_INVALID: &str = "CURRENT.UF2 повреждён или прочитан не полностью. Проверьте подключение платы.";

fn app_start(version: u32) -> Option<u32> {
    match version {
        6 => Some(0x26000),
        7 => Some(0x27000),
        _ => None,
    }
}

pub fn role_file(role: &str) -> Option<&'static str> {
    match role {
        "transmitter" => Some("promicro-transmitter.uf2"),
        "receiver" => Some("promicro-receiver.uf2"),
        "mic-probe" => Some("promicro-mic-probe.uf2"),
        "transmitter-v2-battery" => Some("promicro-transmitter-v2-battery.uf2"),
        _ => None,
    }
}

fn pair_template() -> Vec<u8> {
    let mut template = PAIR_TAG.to_vec();
    template.extend_from_slice(&hex::decode(format!("{PAIR_DEFAULT}00")).unwrap());
    template
}

fn rd32(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}

fn block_ok(data: &[u8]) -> bool {
    data.len() >= 512 && rd32(data, 0) == START_MAGIC && rd32(data, 4) == SECOND_MAGIC && rd32(data, 508) == END_MAGIC
}

pub fn validate_uf2(data: &[u8], address: u32) -> Result<(), String> {
    if app_start(6) != Some(address) && app_start(7) != Some(address) {
        return Err("Неизвестная разметка Pro Micro.".into());
    }
    if data.is_empty() || data.len() % 512 != 0 || data.len() > UF2_MAX_BYTES {
        return Err("Некорректный размер файла UF2.".into());
    }
    let total = (data.len() / 512) as u32;
    let mut blocks = BTreeSet::new();
    let mut ranges: Vec<(u32, u32)> = Vec::new();
    for start in (0..data.len()).step_by(512) {
        let chunk = &data[start..start + 512];
        if !block_ok(chunk) || rd32(chunk, 8) != 0x2000 || rd32(chunk, 28) != FAMILY || rd32(chunk, 24) != total {
            return Err("Ожидался образ UF2 для nRF52840.".into());
        }
        let addr = rd32(chunk, 12);
        let size = rd32(chunk, 16);
        let index = rd32(chunk, 20);
        if addr < address || addr % 256 != 0 || addr + size > STORAGE_START || size != 256 || index >= total
            || blocks.contains(&index)
        {
            return Err("Образ выходит за границы приложения Pro Micro.".into());
        }
        blocks.insert(index);
        ranges.push((addr, addr + size));
    }
    ranges.sort_by_key(|range| range.0);
    if ranges[0].0 != address || ranges.windows(2).any(|pair| pair[1].0 != pair[0].1) {
        return Err("Адреса блоков прошивки не совпадают с разметкой Pro Micro.".into());
    }
    Ok(())
}

pub fn normalize_pair_code(value: &str) -> Result<String, String> {
    let input = value.trim().to_uppercase();
    if input.is_empty() {
        return Ok(String::new());
    }
    let re = Regex::new(r"^[0-9A-F]{4}-?[0-9A-F]{4}$").unwrap();
    if !re.is_match(&input) {
        return Err("Код пары должен содержать восемь знаков 0–9 или A–F.".into());
    }
    let address = input.replace('-', "");
    if address == PAIR_DEFAULT {
        return Ok(String::new());
    }
    let bytes = hex::decode(&address).unwrap();
    if bytes.iter().all(|byte| *byte == bytes[0]) {
        return Err("Выберите код пары с разными байтами.".into());
    }
    Ok(format!("{}-{}", &address[..4], &address[4..]))
}

pub fn generate_pair_code() -> String {
    loop {
        let mut bytes = [0u8; 4];
        rand::thread_rng().fill_bytes(&mut bytes);
        let address = hex::encode(bytes).to_uppercase();
        if address != PAIR_DEFAULT && !bytes.iter().all(|byte| *byte == bytes[0]) {
            return normalize_pair_code(&address).unwrap();
        }
    }
}

fn set_pair_address(image: &mut [u8], code: &str) -> Result<(), String> {
    let template = pair_template();
    let mut slot: Option<usize> = None;
    for start in (0..image.len()).step_by(512) {
        let payload = &image[start + 32..start + 32 + 256];
        let Some(offset) = payload.windows(PAIR_TAG.len()).position(|window| window == PAIR_TAG) else {
            continue;
        };
        let again = payload[offset + 1..].windows(PAIR_TAG.len()).any(|window| window == PAIR_TAG);
        if slot.is_some() || offset % 16 != 0 || again || payload[offset..offset + template.len()] != template[..] {
            return Err(PAIR_UNSUPPORTED.into());
        }
        slot = Some(start + 32 + offset + PAIR_TAG.len());
    }
    let Some(slot) = slot else { return Err(PAIR_UNSUPPORTED.into()) };
    let bytes = hex::decode(code.replace('-', "")).unwrap();
    image[slot..slot + 4].copy_from_slice(&bytes);
    Ok(())
}

fn volume_open(path: &Path) -> std::io::Result<fs::File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

fn current_start(directory: &Path) -> Result<Option<u32>, String> {
    let mut file = match volume_open(&directory.join(CURRENT)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut block = [0u8; 512];
    let count = file.read(&mut block).map_err(|error| error.to_string())?;
    if count != 512 || !block_ok(&block) {
        return Err(BACKUP_INVALID.into());
    }
    Ok(Some(rd32(&block, 12)))
}

#[derive(Clone)]
struct Mounted {
    key: String,
    device: u64,
}

fn mounted_directory(directory: &Path) -> Result<Mounted, String> {
    let stat = fs::metadata(directory).map_err(|_| "Выберите диск загрузчика.".to_string())?;
    if !stat.is_dir() {
        return Err("Выберите диск загрузчика.".into());
    }
    let birth = stat.created().unwrap_or(UNIX_EPOCH).duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    Ok(Mounted { key: format!("{}:{}:{}", stat.dev(), stat.ino(), birth), device: stat.dev() })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub directory: String,
    pub board: String,
    pub model: String,
    pub address: u32,
    pub version: u32,
    pub identity: String,
    pub has_current: bool,
}

struct Bootloader {
    volume: Volume,
    contents: Vec<u8>,
    start: Option<u32>,
    mounted: Mounted,
}

fn field(text: &str, name: &str) -> Option<String> {
    let re = Regex::new(&format!(r"(?mi)^{name}:\s*(.+?)\s*$")).unwrap();
    re.captures(text).map(|capture| capture[1].to_string())
}

fn read_bootloader(directory: &Path) -> Result<Bootloader, String> {
    let mounted = mounted_directory(directory)?;
    let mut info = volume_open(&directory.join(INFO)).map_err(|error| error.to_string())?;
    let mut contents = Vec::new();
    (&mut info).take(4096).read_to_end(&mut contents).map_err(|error| error.to_string())?;
    let text = String::from_utf8_lossy(&contents).to_string();
    let board = field(&text, "Board-ID").unwrap_or_default();
    let model = field(&text, "Model").unwrap_or_else(|| board.clone());
    let board_re = Regex::new(r"(?i)^nRF52840-(?:nicenano(?:-v2)?|nice_nano|supermini|promicro(?:-s140v6)?)$").unwrap();
    if !Regex::new(r"(?im)^UF2 Bootloader\b").unwrap().is_match(&text) || board.is_empty() || !board_re.is_match(&board) {
        return Err("Эта модель загрузчика не распознана как Pro Micro nRF52840.".into());
    }
    let soft_device = field(&text, "SoftDevice").unwrap_or_default();
    let start = current_start(directory)?;
    let sd_version = Regex::new(r"(?i)^S140\s+(?:version\s+)?([67])\.\d+\.\d+$")
        .unwrap()
        .captures(&soft_device)
        .map(|capture| capture[1].parse::<u32>().unwrap());
    let version = sd_version.or_else(|| {
        [6u32, 7].into_iter().find(|version| start.is_some() && app_start(*version) == start)
    });
    let address = version.and_then(app_start);
    let Some(address) = address else {
        return Err("Не удалось подтвердить разметку S140 v6 или v7.".into());
    };
    if let Some(start) = start {
        if start != SOFTDEVICE_START && start != address {
            return Err("Не удалось подтвердить разметку S140 v6 или v7.".into());
        }
    }
    if mounted_directory(directory)?.key != mounted.key {
        return Err(VOLUME_CHANGED.into());
    }
    let identity = hex::encode(Sha256::digest(
        serde_json::to_string(&serde_json::json!([mounted.key, text, start])).unwrap(),
    ));
    let volume = Volume {
        directory: directory.to_string_lossy().to_string(),
        board,
        model,
        address,
        version: version.unwrap(),
        identity,
        has_current: start.is_some(),
    };
    Ok(Bootloader { volume, contents, start, mounted })
}

pub fn inspect_bootloader(directory: &Path) -> Result<Volume, String> {
    Ok(read_bootloader(directory)?.volume)
}

fn save_current(bootloader: &Bootloader, backup_root: &Path) -> Result<(), String> {
    let volume = &bootloader.volume;
    let start = bootloader.start.unwrap_or(SOFTDEVICE_START);
    let mut file = volume_open(&Path::new(&volume.directory).join(CURRENT)).map_err(|error| error.to_string())?;
    let stat = file.metadata().map_err(|error| error.to_string())?;
    if stat.dev() != bootloader.mounted.device {
        return Err(VOLUME_CHANGED.into());
    }
    let size = stat.len();
    if !stat.is_file() || size < 512 || size > UF2_MAX_BYTES as u64 {
        return Err(BACKUP_INVALID.into());
    }
    let mut data = Vec::new();
    file.read_to_end(&mut data).map_err(|error| error.to_string())?;
    if data.len() as u64 != size || data.len() % 512 != 0 {
        return Err(BACKUP_INVALID.into());
    }
    let total = (data.len() / 512) as u32;
    if start + total * 256 > 0x100000 {
        return Err(BACKUP_INVALID.into());
    }
    let flags = rd32(&data, 8);
    let family = rd32(&data, 28);
    for index in 0..total {
        let block = &data[(index as usize) * 512..(index as usize + 1) * 512];
        if !block_ok(block) || rd32(block, 8) != flags || rd32(block, 28) != family
            || rd32(block, 12) != start + index * 256 || rd32(block, 16) != 256
            || rd32(block, 20) != index || rd32(block, 24) != total
        {
            return Err(BACKUP_INVALID.into());
        }
    }
    if read_bootloader(Path::new(&volume.directory))?.volume.identity != volume.identity {
        return Err(VOLUME_CHANGED.into());
    }
    let timestamp = chrono_like_timestamp();
    let result = (|| -> Result<(), String> {
        fs::create_dir_all(backup_root).map_err(|error| error.to_string())?;
        set_mode(backup_root, 0o700);
        let pending = mkdtemp(backup_root, ".pending-")?;
        let write = |name: &str, bytes: &[u8]| -> Result<(), String> {
            let mut handle = fs::File::create(pending.join(name)).map_err(|error| error.to_string())?;
            handle.write_all(bytes).map_err(|error| error.to_string())?;
            handle.sync_all().map_err(|error| error.to_string())?;
            set_mode(&pending.join(name), 0o600);
            Ok(())
        };
        let outcome = write(INFO, &bootloader.contents).and_then(|_| write(CURRENT, &data));
        if let Err(error) = outcome {
            let _ = fs::remove_dir_all(&pending);
            return Err(error);
        }
        let suffix = pending.file_name().unwrap().to_string_lossy().trim_start_matches(".pending-").to_string();
        let destination = backup_root.join(format!("{}-s140v{}-{}-{}", volume.board, volume.version, timestamp, suffix));
        fs::rename(&pending, destination).map_err(|error| error.to_string())?;
        Ok(())
    })();
    result.map_err(|_| "Не удалось сохранить резервную копию. Проверьте доступ к папке копий и свободное место.".to_string())
}

fn chrono_like_timestamp() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let days = now / 86400;
    let seconds = now % 86400;
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{:02}-{:02}-{:02}-000Z", seconds / 3600, seconds % 3600 / 60, seconds % 60)
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

fn mkdtemp(parent: &Path, prefix: &str) -> Result<PathBuf, String> {
    for _ in 0..64 {
        let mut bytes = [0u8; 6];
        rand::thread_rng().fill_bytes(&mut bytes);
        let candidate = parent.join(format!("{prefix}{}", hex::encode(bytes)));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Не удалось создать временную папку.".into())
}

fn folders(parent: &Path) -> Vec<PathBuf> {
    fs::read_dir(parent)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().is_dir())
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default()
}

pub fn find_bootloaders() -> Vec<Volume> {
    let candidates: Vec<PathBuf> = if cfg!(target_os = "macos") {
        folders(Path::new("/Volumes"))
    } else if cfg!(target_os = "windows") {
        ('D'..='Z').map(|letter| PathBuf::from(format!("{letter}:\\"))).collect()
    } else {
        let login = std::env::var("USER").unwrap_or_default();
        let mut all = folders(&PathBuf::from(format!("/media/{login}")));
        all.extend(folders(&PathBuf::from(format!("/run/media/{login}"))));
        all.extend(folders(Path::new("/mnt")));
        all
    };
    candidates.iter().filter_map(|candidate| inspect_bootloader(candidate).ok()).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashResult {
    pub role: String,
    pub backup_saved: bool,
}

pub fn flash_firmware(
    directory: &str,
    role: &str,
    resources: &Path,
    expected_identity: &str,
    backup_root: &Path,
    pair_code: &str,
) -> Result<FlashResult, String> {
    let dir = Path::new(directory);
    let Some(base_name) = role_file(role) else {
        return Err("Выберите плату в режиме загрузчика и её роль.".into());
    };
    if !dir.is_absolute() {
        return Err("Выберите плату в режиме загрузчика и её роль.".into());
    }
    let bootloader = read_bootloader(dir)?;
    let volume = &bootloader.volume;
    if volume.identity != expected_identity {
        return Err(VOLUME_CHANGED.into());
    }
    let name = if volume.version == 7 { base_name.replace(".uf2", "-s140v7.uf2") } else { base_name.to_string() };
    let mut image = fs::read(resources.join("firmware").join(name)).map_err(|error| error.to_string())?;
    validate_uf2(&image, volume.address)?;
    let code = normalize_pair_code(pair_code)?;
    if !code.is_empty() && role != "mic-probe" {
        set_pair_address(&mut image, &code)?;
    }
    if volume.has_current {
        save_current(&bootloader, backup_root)?;
    } else if inspect_bootloader(dir)?.identity != volume.identity {
        return Err(VOLUME_CHANGED.into());
    }
    if mounted_directory(dir)?.key != bootloader.mounted.key {
        return Err(VOLUME_CHANGED.into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join("VIBEMIC.UF2"))
        .map_err(|error| error.to_string())?;
    let outcome = (|| -> Result<(), String> {
        if file.metadata().map_err(|error| error.to_string())?.dev() != bootloader.mounted.device
            || mounted_directory(dir)?.key != bootloader.mounted.key
        {
            return Err(VOLUME_CHANGED.into());
        }
        file.write_all(&image).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if let Err(error) = outcome {
        let _ = fs::remove_file(dir.join("VIBEMIC.UF2"));
        return Err(error);
    }
    Ok(FlashResult { role: role.to_string(), backup_saved: volume.has_current })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(address: u32, index: u32, count: u32) -> Vec<u8> {
        let mut data = vec![0u8; 512];
        for (word, value) in [START_MAGIC, SECOND_MAGIC, 0x2000, address, 256, index, count, FAMILY]
            .iter()
            .enumerate()
        {
            data[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        data[508..512].copy_from_slice(&END_MAGIC.to_le_bytes());
        data
    }

    #[test]
    fn pair_code_normalization() {
        assert_eq!(normalize_pair_code("8b27-3de4").unwrap(), "8B27-3DE4");
        assert_eq!(normalize_pair_code("8B273DE4").unwrap(), "8B27-3DE4");
        assert_eq!(normalize_pair_code("").unwrap(), "");
        assert_eq!(normalize_pair_code(PAIR_DEFAULT).unwrap(), "");
        assert!(normalize_pair_code("AAAA-AAAA").is_err());
        assert!(normalize_pair_code("123").is_err());
        assert!(normalize_pair_code("GGGG-1234").is_err());
        let generated = generate_pair_code();
        assert_eq!(normalize_pair_code(&generated).unwrap(), generated);
    }

    #[test]
    fn uf2_validation() {
        let image = block(0x26000, 0, 1);
        assert!(validate_uf2(&image, 0x26000).is_ok());
        assert!(validate_uf2(&image, 0x27000).is_err());
        assert!(validate_uf2(&[], 0x26000).is_err());
        let mut wrong_family = block(0x26000, 0, 1);
        wrong_family[28..32].copy_from_slice(&0x1234u32.to_le_bytes());
        assert!(validate_uf2(&wrong_family, 0x26000).is_err());
        let mut two = block(0x26000, 0, 2);
        two.extend(block(0x26100, 1, 2));
        assert!(validate_uf2(&two, 0x26000).is_ok());
        let mut gap = block(0x26000, 0, 2);
        gap.extend(block(0x26200, 1, 2));
        assert!(validate_uf2(&gap, 0x26000).is_err());
    }

    #[test]
    fn pair_slot_patch() {
        let mut payload = vec![0u8; 256];
        payload[16..16 + pair_template().len()].copy_from_slice(&pair_template());
        let mut image = vec![0u8; 512];
        image[32..32 + 256].copy_from_slice(&payload);
        set_pair_address(&mut image, "8B27-3DE4").unwrap();
        assert_eq!(&image[32 + 16 + PAIR_TAG.len()..32 + 16 + PAIR_TAG.len() + 4], &hex::decode("8B273DE4").unwrap());
        let mut empty = vec![0u8; 512];
        assert!(set_pair_address(&mut empty, "8B27-3DE4").is_err());
    }
}