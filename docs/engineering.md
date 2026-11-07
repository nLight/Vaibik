# Vaibik engineering notes

[Русский](engineering.ru.md) · [Setup](../README.md)

## Pinned implementation

The current Pro Micro profile uses **nRF Connect SDK 3.4.2**, **Zephyr SDK 1.0.1**, and `promicro_nrf52840/nrf52840/uf2`. The Zephyr board definition covers nice!nano and compatible nRF52840 Pro Micro boards. S140 v6 starts the application at `0x26000`; the S140 v7 overlay uses `0x27000`. The desktop flasher reads `INFO_UF2.TXT` before selecting an image. [Zephyr board](https://docs.zephyrproject.org/latest/boards/others/promicro_nrf52840/doc/index.html), [UF2 bootloader](https://github.com/adafruit/Adafruit_nRF52_Bootloader#making-your-own-uf2), [pinned NCS release](https://github.com/nrfconnect/sdk-nrf/releases/tag/v3.4.2).

TX runs PDM + ESB. RX runs ESB + native USB; the architecture does not require PDM, radio and USB on a single controller. The TX external microphone uses P0.17 clock and P0.20 data, left mono, 16 kHz. P0.06 is the active-low button with an internal pull-up. Adafruit PDM SEL is tied to ground. [PDM driver](https://github.com/nrfconnect/sdk-zephyr/blob/ncs-v3.4.2/drivers/audio/dmic_nrfx_pdm.c), [Adafruit pins](https://learn.adafruit.com/adafruit-pdm-microphone-breakout/pinouts).

Zephyr USB Device Next registers UAC2 and vendor HID in one configuration. CDC is disabled in the normal receiver. nRF52840 provides one isochronous IN endpoint plus separate interrupt/bulk endpoints; UAC2 needs one ISO IN and HID one interrupt IN. The fixed 16 kHz format supplies 32 bytes per USB SOF; an optional 48 kHz build supplies 96 bytes. The physical receiver enumerated as mono 16 kHz/16-bit on macOS. The optional 48 kHz path and macOS 12 remain bench checks; the companion app requires macOS 13+. [nRF52840 USBD](https://docs.nordicsemi.com/r/bundle/ps_nrf52840/page/usbd.html), [Apple TN3190](https://developer.apple.com/documentation/technotes/tn3190-usb-audio-device-design-considerations).

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
| 1 | 1 | One flag: DOWN=1, UP=2, AUDIO=4 |
| 2 | 2 | 5 ms audio block sequence, wraps modulo 65536 |
| 4 | 4 | First sample position; UP gives the position after the last block |
| 8 | 4 | Session ID, randomized on boot and incremented per press |
| 12 | 160 | AUDIO only: 80 signed 16-bit samples |

Multibyte fields are little-endian. DOWN/UP are 12 bytes; AUDIO is 172. A session's timeline starts with its first pre-roll block, independent of the host clock. Other flags are reserved. PCM is 256 kbit/s; 200 full audio packets per second are 275.2 kbit/s before radio headers, ACK and retries. Pre-roll is sent as a burst.

Pair codes patch a 32-bit ESB base address in the unique aligned `VIBEMICRF01` slot of a validated UF2 payload. The common prefix is `0x35`; the bench base address is `61 9b 46 d2`. The confirmation binds a code to the selected bootloader drive. Pairing selects an address and is **not encryption**. The channel is fixed in the build; change it on both ends if measuring alternatives.

## Timing and failure handling

TX continuously retains **120 ms** of microphone audio in RAM. It does not transmit that audio before PTT. Two consecutive GPIO readings, 5 ms apart, debounce a transition. DOWN precedes the pre-roll; UP follows the remaining PCM and carries its final sample position. Control packets have queue capacity reserved. Following TX_FAILED, UP can start two additional ESB transactions 12 ms apart using the same FIFO packet/PID.

RX starts playback after at least **45 ms** from HID transfer completion, **20 ms** after USB audio opens and **30 ms** of buffered audio (a completed short session can use UP). Its storage window retains up to **640 ms** while the host prepares input. Missing sample slots become silence. Radio callbacks wake a worker; USB SOF takes a ready 1 ms block without waiting for radio. Occasional one-sample insertion/removal compensates clock drift without changing USB frame size.

After the final PCM, RX waits **35 ms** before releasing HID. The time from the physical button release includes pre-roll and buffered playback. Radio silence for **250 ms**, audio not starting within **500 ms**, or USB audio stopping ends the session. A single pending next session can preserve the beginning of a rapid second press. Host tests exercise packet wrap, malformed frames, loss, reordering, duplicates and playout boundaries; physical timing/range measurements remain necessary.

## Host interfaces

Pro Micro RX uses bench VID/PID `1209:0003` and vendor HID usage page `0xff31`, usage 1. Its eight-byte input report holds version 1, PTT state and diagnostics. It does **not** type a global shortcut. The desktop companion receives PTT directly while UAC2 remains an independent microphone. The older XIAO profile uses a keyboard report with modifiers and F13. Prototype VID/PIDs are not a product allocation.

On release, report byte 2 gives the stop reason: 1 normal, 2 radio timeout, 3 input-open timeout, 4 USB audio stopped, 5 next press. Byte 3 is the minimum RSSI magnitude (0 if unavailable). Bytes 4–5 give milliseconds of PCM replaced by silence, rounded up, and bytes 6–7 give USB buffer/send errors. Counters are little-endian and saturate at 65535. Silence includes empty playout positions and is distinct from radio packet loss.

PDM Probe is a separate transmitter image with USB CDC ACM `1209:0002`. The host sends `R`, then reads `VMIC` and 48000 PCM16 samples (three seconds), or `VERR`. Cancellation drains the in-flight response before closing and discards the clip. A 15-second timeout releases a nonresponding port. This avoids leaving the board blocked on an unread CDC TX tail. Probe mode has no ESB pair address.

## Desktop checks and remaining acceptance

VibeMic 0.1.22 has English and Russian UI, selected independently from spoken language. The choice stays local, while portable profiles move pairing/model/agent/insertion preferences. Draft content, terminal output and local paths are not translated.

Automated checks use isolated profiles, synthetic audio/serial devices, real local Whisper and a test PTY. They cover PDM cancellation/retry/timeout, two queued phrases, preservation of draft edits, exact bracketed paste without Enter, and UI language persistence after restart. They do not establish acoustic quality or RF reliability. The physical dongle and prerecorded radio speech were checked separately.

Still required: live PDM + physical PTT, speech/whisper at 10–40 cm, phrase beginning/tail, 2–3 m alongside active Wi-Fi, reboot recovery and measured power. Separate-window insertion needs an end-to-end check. Native Linux AppImage/FUSE launch is pending. macOS builds are Developer ID signed; Apple notarization is pending.
