use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

const LEGACY: &str = "KERNEL==\"hidraw*\", SUBSYSTEM==\"hidraw\", ATTRS{idVendor}==\"1209\", ATTRS{idProduct}==\"0003\", TAG+=\"uaccess\"";
const RULE_NAME: &str = "70-vibemic.rules";
const DIRECTORIES: [&str; 5] = [
    "/etc/udev/rules.d",
    "/run/udev/rules.d",
    "/usr/local/lib/udev/rules.d",
    "/usr/lib/udev/rules.d",
    "/lib/udev/rules.d",
];

pub const INSTALL_SCRIPT: &str = r#"set -eu
[ ! -L "$2" ] || exit 1
if [ -e "$2" ]; then
  [ -f "$2" ] && [ "$(cat "$2")" = "$3" ] || exit 1
else
  [ -z "$3" ] || exit 1
fi
temporary=$(mktemp "$2.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
printf '%s\n' "$1" > "$temporary"
chmod 0644 "$temporary"
mv -f "$temporary" "$2"
udevadm control --reload"#;

pub fn rule_body(contents: &str) -> String {
    contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn rule_status(expected: &str, installed: &str) -> &'static str {
    let body = rule_body(installed);
    if body == rule_body(expected) {
        "configured"
    } else if body == LEGACY {
        "outdated"
    } else {
        "overridden"
    }
}

pub const PACKAGED_RULE: &str = r#"KERNEL=="hidraw*", SUBSYSTEM=="hidraw", ATTRS{idVendor}=="1209", ATTRS{idProduct}=="0003", TAG+="uaccess"
KERNEL=="ttyACM*", SUBSYSTEM=="tty", ATTRS{idVendor}=="1209", ATTRS{idProduct}=="0002", TAG+="uaccess""#;

pub fn packaged_rule() -> String {
    rule_body(PACKAGED_RULE)
}

pub fn linux_status(rule: &str) -> String {
    for directory in DIRECTORIES {
        match fs::read_to_string(Path::new(directory).join(RULE_NAME)) {
            Ok(installed) => return rule_status(rule, &installed).to_string(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return "overridden".to_string(),
        }
    }
    "missing".to_string()
}

pub fn install(rule: &str) -> Result<String, String> {
    let status = linux_status(rule);
    if status != "missing" && status != "outdated" {
        return Ok(status);
    }
    let destination = Path::new(DIRECTORIES[0]).join(RULE_NAME);
    let existing = match fs::read_to_string(&destination) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.to_string()),
    };
    if !existing.is_empty() && rule_status(rule, &existing) != "outdated" {
        return Ok("overridden".to_string());
    }
    let output = Command::new("pkexec")
        .args(["/bin/sh", "-c", INSTALL_SCRIPT, "vibemic-usb", rule])
        .arg(&destination)
        .arg(existing.trim_end())
        .output();
    match output {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err("Для установки правила из AppImage нужен pkexec. Можно установить пакет DEB.".into())
        }
        Err(error) => Err(error.to_string()),
        Ok(output) if !output.status.success() => {
            Err("Не удалось установить правило USB. Проверьте права администратора.".into())
        }
        Ok(_) => Ok(linux_status(rule)),
    }
}

#[allow(dead_code)]
fn timeout() -> Duration {
    Duration::from_secs(120)
}