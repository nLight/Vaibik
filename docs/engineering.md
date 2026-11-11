# Vaibik engineering notes

[Русский](engineering.ru.md) · [Setup](../README.md)

## Pinned implementation

The current Pro Micro profile uses **nRF Connect SDK 3.4.2**, **Zephyr SDK 1.0.1**, and `promicro_nrf52840/nrf52840/uf2`. The Zephyr board definition covers nice!nano and compatible nRF52840 Pro Micro boards. S140 v6 starts the application at `0x26000`; the S140 v7 overlay uses `0x27000`. The desktop flasher reads `INFO_UF2.TXT` before selecting an image. [Zephyr board](https://docs.zephyrproject.org/latest/boards/others/promicro_nrf52840/doc/index.html), [UF2 bootloader](https://github.com/adafruit/Adafruit_nRF52_Bootloader#making-your-own-uf2), [pinned NCS release](https://github.com/nrfconnect/sdk-nrf/releases/tag/v3.4.2).

TX runs PDM + ESB. RX runs ESB + native USB; the architecture does not require PDM, radio and USB on a single controller. The TX external microphone uses P0.17 clock and P0.20 data, left mono, 16 kHz. P0.06 is the active-low button with an internal pull-up. Adafruit PDM SEL is tied to ground. [PDM driver](https://github.com/nrfconnect/sdk-zephyr/blob/ncs-v3.4.2/drivers/audio/dmic_nrfx_pdm.c), [Adafruit pins](https://learn.adafruit.com/adafruit-pdm-microphone-breakout/pinouts).

Zephyr USB Device Next registers UAC2 and vendor HID in one configuration. CDC is disabled in the normal receiver. nRF52840 provides one isochronous IN endpoint plus separate interrupt/bulk endpoints; UAC2 needs one ISO IN and HID one interrupt IN. The fixed 16 kHz format supplies 32 bytes per USB SOF; an optional 48 kHz build supplies 96 bytes. The physical receiver enumerated as mono 16 kHz/16-bit on macOS. The optional 48 kHz path and macOS 12 remain bench checks; the companion app requires macOS 13.3+. [nRF52840 USBD](https://docs.nordicsemi.com/r/bundle/ps_nrf52840/page/usbd.html), [Apple TN3190](https://developer.apple.com/documentation/technotes/tn3190-usb-audio-device-design-considerations).

## Official starting points

| Purpose | Official example |
| --- | --- |
| Microphone capture | [Zephyr DMIC](https://github.com/nrfconnect/sdk-zephyr/tree/ncs-v3.4.2/samples/drivers/audio/dmic) |
| ESB transmit / receive | [Nordic PTX](https://github.com/nrfconnect/sdk-nrf/tree/v3.4.2/samples/esb/esb_ptx), [Nordic PRX](https://github.com/nrfconnect/sdk-nrf/tree/v3.4.2/samples/esb/esb_prx) |
| USB audio input | [Zephyr UAC2 implicit feedback](https://github.com/nrfconnect/sdk-zephyr/tree/ncs-v3.4.2/samples/subsys/usb/uac2_implicit_feedback) |
| HID keyboard, legacy XIAO path | [Zephyr HID keyboard](https://github.com/nrfconnect/sdk-zephyr/tree/ncs-v3.4.2/samples/subsys/usb/hid-keyboard) |
| Composite class registration | [Zephyr USB initialization](https://github.com/nrfconnect/sdk-zephyr/blob/ncs-v3.4.2/samples/subsys/usb/common/sample_usbd_init.c) |

Examples demonstrate SDK APIs; the board overlays, packet protocol and combined implementation are this project's code.

## Radio packet format

ESB uses DPL, 2 Mbps, CRC16, automatic ACK and up to two ESB retries on channel 76 (2476 MHz). Both sides configure a **172-byte** maximum. ESB supports a configured maximum above the default 32 bytes; this is verified in the pinned [Kconfig](https://github.com/nrfconnect/sdk-nrf/blob/v3.4.2/subsys/esb/Kconfig) and [implementation](https://github.com/nrfconnect/sdk-nrf/blob/v3.4.2/subsys/esb/esb.c). Do not treat 172 as an arbitrary USB or network MTU.

| Offset | Bytes | Field |
| --- | --- | --- |
| 0 | 1 | Protocol version, currently 1 |
| 1 | 1 | One flag: DOWN=1, UP=2, AUDIO=4, APPROVAL_ARM=64, APPROVAL_COMMIT=128 |
| 2 | 2 | 5 ms audio block sequence, wraps modulo 65536 |
| 4 | 4 | First sample position; UP gives the position after the last block |
| 8 | 4 | Session or gesture ID, randomized on boot and incremented on DOWN or APPROVAL_ARM |
| 12 | 160 | AUDIO only: 80 signed 16-bit samples |

Multibyte fields are little-endian. Control packets are 12 bytes and AUDIO is 172. Both approval packets use sequence and timestamp zero and share the same gesture ID. A session's timeline starts with its first pre-roll block, independent of the host clock. Other flags are reserved. PCM is 256 kbit/s; 200 full audio packets per second are 275.2 kbit/s before radio headers, ACK and retries. Pre-roll is sent as a burst.

Pair codes patch a 32-bit ESB base address in the unique aligned `VIBEMICRF01` slot of a validated UF2 payload. The common prefix is `0x35`; the bench base address is `61 9b 46 d2`. The confirmation binds a code to the selected bootloader drive. Pairing selects an address and is **not encryption**. The channel is fixed in the build; change it on both ends if measuring alternatives.

## Timing and failure handling

Before writing to pre-roll, TX processes each 5 ms PCM block with a fixed-point RMS compressor. The threshold is −32 dBFS, the ratio is 2:1 above the threshold, and makeup gain is up to 12 dB. The block peak limits the gain ramp to a −2 dBFS sample ceiling. Gain recovers with a time constant of about 80 ms. Both outputs use the same processed PCM, with no extra buffered block. PDM Probe reads capture directly for raw measurements.

TX retains **120 ms** of pre-roll before PTT. Two consecutive GPIO readings, 5 ms apart, debounce a transition. Pro Micro waits **125 ms** to distinguish a hold from a tap and retains audio from that interval too. DOWN precedes the buffered audio. UP follows the remaining PCM and carries its final sample position. Control packets have queue capacity reserved. Following TX_FAILED, UP can start two additional ESB transactions 12 ms apart using the same FIFO packet/PID.

A tap lasts 25–125 ms after debouncing, with up to 350 ms between the first release and the second press. The first release arms a gesture and the second release commits it. A hold clears the gesture and starts an audio session. RX consumes the matching commit once, within 525 ms of arming. Approval packets that cannot reach HID immediately are dropped.

RX starts playback after at least **45 ms** from HID transfer completion, **20 ms** after USB audio opens and **30 ms** of buffered audio (a completed short session can use UP). Its storage window retains up to **2.56 seconds** while the host prepares input. Missing sample slots become silence. Radio callbacks wake a worker; USB SOF takes a ready 1 ms block without waiting for radio. Occasional one-sample insertion/removal compensates clock drift without changing USB frame size.

After the final PCM, RX waits **35 ms** before releasing HID. The time from the physical button release includes pre-roll and buffered playback. While PTT is held, delayed or interrupted USB audio pauses playback and retains the most recent PCM when the buffer fills. The HID shortcut stays down until PTT release or **250 ms** without radio audio packets. A single pending next session can preserve the beginning of a rapid second press.

## Host interfaces

The Pro Micro transmitter and dongle share the UAC2, HID and audio session code. When the transmitter's USB host configures HID, the transmitter feeds its local PDM blocks to that code and appears as **PTT Dictation Mic (USB)**. VBUS events enable and disable the battery-powered USB device, while HID configuration distinguishes a host from a power-only supply. A press keeps its original output. Deconfiguration discards any queued wired take and prevents a double tap from spanning the two transports. The companion's automatic input follows the active HID device and prefers the wired one when both are connected. [Zephyr USB device support](https://docs.zephyrproject.org/latest/services/connectivity/usb/device_next/usb_device.html)

Pro Micro RX uses bench VID/PID `1209:0003` and vendor HID usage page `0xff31`, usage 1. Its eight-byte input report holds version 1, PTT state and diagnostics. During a PTT hold, the companion can request a shortcut via a feature report. A separate HID keyboard holds **Control + Option + Shift + F13** for Codex or taps **Command+D** for Claude. The companion uses the current macOS layout to choose between the physical D and G positions for Claude. UAC2 remains an independent microphone. Prototype VID/PIDs are not a product allocation.

On release, report byte 2 gives the stop reason: 1 normal, 2 radio timeout, 3 input-open timeout, 4 USB audio stopped, 5 next press. Byte 3 is the minimum RSSI magnitude (0 if unavailable). Bytes 4–5 give milliseconds of PCM replaced by silence, rounded up, and bytes 6–7 give USB buffer/send errors. Counters are little-endian and saturate at 65535. Silence includes empty playout positions and is distinct from radio packet loss.

HID report byte 1 is 0 for UP, 1 for DOWN, 2 for gesture arm, and 3 for gesture commit. Gesture reports carry the ID in bytes 2–5 and zero in bytes 6–7. On macOS the bridge captures the focused nonempty editor in a signed Codex or Claude desktop app. It checks the same window, app web document, editor and text again before sending one Enter key down/up pair. Transcription and insertion must finish before the gesture can submit the draft. The packet constants retain their original `APPROVAL` names for wire compatibility.

PDM Probe is a separate transmitter image with USB CDC ACM `1209:0002`. The host sends `R`, then reads `VMIC` and 48000 PCM16 samples (three seconds), or `VERR`. Cancellation drains the in-flight response before closing and discards the clip. A 15-second timeout releases a nonresponding port. This avoids leaving the board blocked on an unread CDC TX tail. Probe mode has no ESB pair address.

## Desktop checks and remaining acceptance

VibeMic 0.1.22 has English and Russian UI, selected independently from spoken language. The choice stays local, while portable profiles move pairing/model/agent/insertion preferences. Draft content, terminal output and local paths are not translated.

Automated checks use isolated profiles, synthetic audio/serial devices, local Parakeet and a test PTY. They cover PDM cancellation/retry/timeout, two queued phrases, preservation of draft edits, exact bracketed paste without Enter, and UI language persistence after restart. They do not establish acoustic quality or RF reliability. The physical dongle and prerecorded radio speech were checked separately.

Physical PTT with live speech was checked in Codex and Claude Desktop. Both completed built-in dictation on release. Karabiner EventViewer confirmed the dongle's Command+D for Claude. Still required: speech and whisper at 10–40 cm, phrase beginning and tail, 2–3 m alongside active Wi-Fi, reboot recovery, and measured power. Native Linux AppImage/FUSE launch and Apple notarization are pending.

## Parakeet and native dictation

The local engine is NVIDIA NeMo-Speech.cpp v0.3.0. Official release archives and the Parakeet TDT 0.6B v3 Q8 model are pinned by SHA-256. Model revision: `541d1f99c6b0c3cd0b11a95167540bb8edefd82b`; size: 713975456 bytes. Runtime minimum macOS is 13.3; Apple Silicon uses Metal and Intel uses CPU. Transcription writes temporary 16 kHz mono WAV and reads an explicit UTF-8 text output; temporary recordings are removed after completion. Old profiles migrate from Base/Small to Parakeet and automatic language detection. Existing Whisper model files are preserved.

Automatic mode keeps a native bridge running so it can prime Electron accessibility when a signed Codex/Claude app gains focus. At PTT DOWN it examines only the focused editor's nearby composer controls in the app's own top-level web document. Exact Dictate/Stop dictation labels are supported; generic Stop and Send are excluded. The bridge owns a session ID, stops only the captured composer, and performs bounded cleanup on cancel, disconnect or EOF. If no supported start control is found, VibeMic records and transcribes locally. Its idle audio input is closed in automatic mode so another app can open the PTT stream without losing pre-roll. The on-screen button always uses local recognition. Native dictation uses the other app's audio selection and data processing.

## Battery telemetry

`VM_BATTERY_STATUS` has a 12-byte zeroed control header plus LE16 millivolts, one flag byte and one zero reserved byte. Flag 1 means valid voltage; flag 2 means USB power present. Invalid voltage is encoded as zero without flag 1. The receiver handles telemetry before the audio state machine and forwards it only when PTT/gesture traffic is idle. Vendor HID state 4 carries flags at byte 2, zero at byte 3, millivolts at bytes 4–5 and zeros at bytes 6–7. Old firmware ignores the new radio packet or produces no battery report; the app shows unknown rather than inferring a percentage.

`VIBEMIC_BATTERY_NONE` is the default. `nicenano-v2-battery.conf` explicitly enables VDDH/5, matching [ZMK's nice!nano v2 definition](https://github.com/zmkfirmware/zmk/blob/v0.3.0/app/boards/arm/nice_nano/nice_nano_v2.dts). The optional `VIBEMIC_BATTERY_DIVIDER` uses AIN2 and the 806 kΩ + 2 MΩ ratio from [nice!nano v1](https://github.com/zmkfirmware/zmk/blob/v0.3.0/app/boards/arm/nice_nano/nice_nano.dts). A low-priority work item samples every five seconds; audio and interrupt callbacks never read the ADC. Zephyr 4.4 uses `NRF_SAADC_VDDHDIV5` input encoding, rather than the raw Nordic HAL enum. The app maps a single-cell LiPo voltage curve to an approximate percentage, suppresses SOC on USB and expires telemetry after 30 seconds. Actual charge status and remaining runtime need a fuel-gauge IC or calibration; neither is inferred here. Hardware battery calibration remains a bench check.
