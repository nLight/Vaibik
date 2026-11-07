# Vaibik

[Русский](README.ru.md) · [Build guide & wiring](https://nlight.github.io/Vaibik/) · [Downloads](https://github.com/nLight/Vaibik/releases)

Wireless push-to-talk for dictating prompts to **Claude Code and Codex**. Hold the button, speak, release, and review the transcript. Send the prompt yourself with Enter. The prototype has one PTT button.

**Vaibik** is the project name. Its desktop companion is currently named **VibeMic**; firmware names, USB identity and settings retain that name for compatibility. Superwhisper is not required: the companion runs Whisper locally.

![Vaibik breadboard prototype illustration](site/assets/prototype-scene.png)

*Component-by-component illustration, not a photo of an assembled unit. Use the exact [wiring diagram](site/assets/wiring-breadboard.svg) for connections.*

## What works, what still needs a bench

Verified on two nRF52840 boards: USB Audio + HID enumeration and prerecorded speech through the proprietary radio pair. Desktop checks cover local Whisper, draft insertion into an isolated embedded terminal, flashing, backup, pairing profiles and simulated audio/PDM failure recovery.

Still pending: live external PDM with the physical button, speech/whisper at 10–40 cm, 2–3 metre reliability near Wi-Fi, battery life, and a full reboot/reconnect acceptance run. Insertion into separate Claude/Codex desktop windows is implemented but its end-to-end test is deferred. These are prototype builds.

## Hardware

- Two **Pro Micro nRF52840** boards: nice!nano or a compatible SuperMini with native USB and an Adafruit UF2 bootloader using S140 v6/v7. The target is `promicro_nrf52840/nrf52840/uf2`.
- One **Adafruit PDM microphone breakout 3492** (3.3 V), normally open momentary button, breadboard and jumper wires.
- USB data cables. Power the transmitter by USB for the first bench; the receiver plugs directly into the computer.

An ATmega32U4 Pro Micro is a different board. Match `P0.xx` labels to your exact SuperMini schematic; physical clone pinouts are not assumed.

| Transmitter | Connect to |
| --- | --- |
| `3.3V` | Microphone `3V` |
| `GND` | Microphone `GND` and `SEL` |
| `P0.17` / D2 | Microphone `CLK` |
| `P0.20` / D3 | Microphone `DAT` |
| `P0.06` / D1 | Button, with its other contact to `GND` |

D1–D3 refer to nice!nano, face up, USB at the top. Use the regulated **3.3 V** output. Put the five microphone pins in **five separate breadboard rows**. On a four-leg tactile button, use opposite diagonal contacts. Keep the antenna clear. The receiver has no signal wire to the transmitter.

[Exact diagram](site/assets/wiring-breadboard.svg) · [Netlist](site/assets/wiring-netlist.json) · [nice!nano pinout](https://nicekeyboards.com/docs/nice-nano/pinout-schematic/) · [Adafruit pinout](https://learn.adafruit.com/adafruit-pdm-microphone-breakout/pinouts)

## Install and use

Download from [Releases](https://github.com/nLight/Vaibik/releases). macOS requires **13+** (Apple Silicon or Intel); Linux packages target **x64 with AVX2**. Windows work is deferred.

The macOS beta is Developer ID signed; **Apple notarization is pending**. The Linux DEB and extracted AppImage were exercised in Debian x64; native AppImage/FUSE launch remains unverified. Speech models download on first use and then run locally. Claude/Codex keep their own account and network requirements.

1. Open VibeMic. Choose **Settings → Interface language** for English or Russian. This changes the interface independently of the transcription language. You can try the on-screen PTT button with an existing microphone before building hardware.
2. Open **Hardware**, generate and save a radio pair code. Put one board into UF2 (usually double Reset), select **Dongle**, and flash. Repeat for **Transmitter** using the same code. The app chooses S140 v6/v7 from the bootloader report and backs up `CURRENT.UF2` when provided. Keep keyboard source/configuration backups separately.
3. Run the hardware button/audio check. For microphone-only diagnosis, select **PDM Probe**, flash the transmitter and record three seconds over USB. Restore the normal transmitter firmware afterwards. Probe mode does not use the radio pair code.
4. In **Transcription**, allow microphone access, select **PTT Dictation Mic**, download Base or Small, and choose the spoken language. Keep another microphone selected explicitly in Zoom/Meet.
5. In **Agents**, select a project and installed Claude Code or Codex CLI, then sign in through the embedded terminal. Wait for the agent prompt. Hold PTT, speak and release. Review the draft; the app never sends Enter automatically.

The separate-window destination on macOS requires Accessibility access. Its acceptance test is pending; the draft remains available if insertion fails or focus changes. The embedded terminal uses bracketed paste. A second phrase can be recorded while the first transcribes; it stays a separate draft for review and manual insertion.

On Linux the DEB installs the USB udev rule. Reconnect the board afterwards. AppImage users can use **Hardware → Allow USB** with `pkexec`. The app reports missing/outdated rules and supports the dongle HID and probe CDC devices.

Settings export/import transfers pairing, model, spoken language, agent and insertion preferences. Interface language, microphone IDs, project paths and CLI paths remain local.

## Firmware and protocol

- **nRF Connect SDK 3.4.2**, Zephyr SDK **1.0.1**, native Nordic ESB; no Wi-Fi router, Bluetooth HFP or macOS radio driver.
- ESB DPL at **2 Mbps**, fixed paired address, ACK/retries, **172-byte** configured payload maximum.
- **16 kHz / signed 16-bit LE / mono PCM**; 80 samples per 5 ms packet, sequence, sample timestamp and session ID.
- **120 ms pre-roll**. Receiver buffering starts at 30 ms; missing audio becomes silence. USB callbacks never wait for radio.
- Receiver exposes class-compliant **UAC2 audio + vendor HID PTT state**. The companion consumes HID directly; this Pro Micro build does not emit a global keyboard shortcut. USB audio stays enumerated and sends silence between takes.
- Pair codes select a radio address; **PCM is not encrypted**. Prototype USB VID/PIDs are for bench use, not a product allocation.

The older XIAO Sense/USB-keyboard path is documented separately in [legacy XIAO notes](docs/legacy-xiao.md); do not flash its images onto Pro Micro boards. Official SDK examples and implementation details are linked in [engineering notes](docs/engineering.md).

## Build

Install the pinned Nordic SDK/toolchain and run firmware builds inside its environment:

```sh
VIBEMIC_NCS_WORKSPACE=/path/to/ncs ./script/build_firmware.sh
npm --prefix desktop ci
node desktop/node_modules/electron/install.js
./script/build_and_run.sh
```

The default firmware script produces the six UF2 images (TX, RX and PDM Probe for S140 v6/v7) consumed by desktop packaging. Use `./script/build_firmware.sh --mic-probe` to rebuild only probe images.

Desktop builds need Node.js 22+, npm, CMake and a C/C++ toolchain; macOS also needs Xcode Command Line Tools. `script/prepare_desktop.mjs` builds the pinned, checksum-verified whisper.cpp source and bundles the firmware.

```sh
# macOS: local ad-hoc DMGs, or Developer ID signed DMGs
./script/package_macos.sh both
./script/package_macos.sh --signed both

# Linux x64, from Docker on a supported host
mkdir -p build/source-release/linux
docker run --rm --platform linux/amd64 \
  -v "$PWD:/source:ro" -v "$PWD/build/source-release/linux:/output" \
  node:22-bookworm bash /source/script/container_linux.sh
```

Signed DMGs go to `build/source-release/macos-signed/`. A distribution build additionally needs your own exact `notarytool` profile name:

```sh
VIBEMIC_MAC_NOTARY_PROFILE=your-profile-name ./script/package_macos.sh --distribution both
```

The script verifies bundle versions, architectures, executable signatures and all six bundled UF2 files. It checks Apple acceptance, stapling and Gatekeeper in distribution mode. Never commit signing keys, models or firmware backups.

```sh
npm --prefix desktop test
./tools/test-host.sh
VIBEMIC_REVIEW_DIRECTORY="$PWD/build/ui-review" ./script/build_and_run.sh --fixture
```

The fixture uses isolated sample data and exercises UI states without flashing physical boards. For acoustic checks, `tools/capture_mic.py` records WAV from PDM Probe (requires `pyserial`).

## Layout

```text
firmware/common/       packet codec, ESB configuration, playout buffer
firmware/transmitter/  PDM, GPIO, pre-roll, ESB TX, USB PDM Probe
firmware/receiver/     ESB RX, USB Audio + HID, connection watchdog
host/                  native desktop insertion helpers and legacy bridge
desktop/              Electron companion, EN/RU UI, tests
script/                firmware, packaging and isolated UI review
site/                  buildless bilingual GitHub Pages site and assembly assets
```

The Pages workflow publishes only `site/`. Asset provenance and official references are documented in [hardware sources](site/hardware-sources.md).
