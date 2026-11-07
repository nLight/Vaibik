# Vaibik hardware artwork and wiring reference

The assembly drawing describes a **USB-powered bench prototype**, with no battery or enclosure. Vaibik is the project name; VibeMic is the current companion app. The raster images are generated illustrations, not photographs of a built or tested device. Build from the SVG/netlist, not from raster silkscreen or wire coordinates.

По-русски: это макет с питанием передатчика по USB, без аккумулятора и корпуса. Растровые изображения — иллюстрации, а не фотографии проверенной сборки. Подключения определяет точная SVG-схема и netlist.

## Final assets

| Asset | Purpose |
| --- | --- |
| `assets/prototype-scene.png` | Complete exposed-wire prototype and separate wireless USB receiver |
| `assets/controller-render.png` | Individual nRF52840 controller illustration, transparent background |
| `assets/microphone-render.png` | Individual five-pin PDM breakout illustration, transparent background |
| `assets/button-render.png` | Individual four-lead momentary tactile switch illustration, transparent background |
| `assets/breadboard-render-v2.png` | Individual 30-row, 400-contact breadboard illustration, transparent background |
| `assets/wiring-breadboard.svg` | Authoritative breadboard placement, pin IDs and seven jumpers |
| `assets/wiring-netlist.json` | Machine-readable contact assignments and connections |
| `assets/image-prompts.md` | Normalized final prompt set and correction notes |

All raster assets were generated with the built-in ImageGen tool. Manufacturer images were consulted as references and are not bundled as source photos. No CLI/API fallback was used.

## Verified electrical reference

With the transmitter USB connector at the top, the nice!nano v2 standard left header begins `P0.06, P0.08, GND, GND, P0.17, P0.20`. The right header begins `BAT+, GND, RST, 3.3V`. The extra pads beside USB are **not** part of this 12-contact sequence. The SVG uses this reference geometry. [Manufacturer pinout and schematic](https://nicekeyboards.com/docs/nice-nano/pinout-schematic/).

| Transmitter | Connection |
| --- | --- |
| 3.3V | PDM `3V` |
| GND | PDM `GND` and `SEL`; PTT ground terminal |
| P0.17 / D2 | PDM `CLK` |
| P0.20 / D3 | PDM `DAT` |
| P0.06 / D1 | Normally open PTT contact; button closes to GND |

The concrete microphone reference is **Adafruit PDM MEMS Microphone Breakout, product 3492**, not an I²S or analog board. Its five pads are `3V, GND, SEL, CLK, DAT`. It takes 1.8–3.3V; `SEL` low selects left-channel/rising-edge output. Its `3V` pad is not a 5V input. [Official product/photo](https://www.adafruit.com/product/3492), [official pin definitions](https://learn.adafruit.com/adafruit-pdm-microphone-breakout/pinouts).

The pin assignments match `firmware/transmitter/boards/promicro_nrf52840_nrf52840_uf2.overlay`: P0.06 has an internal pull-up and is active low; PDM uses P0.17/P0.20. `firmware/transmitter/src/capture.c` requests `PDM_CHAN_LEFT`. Target: `promicro_nrf52840/nrf52840/uf2`.

## Assembly details that affect correctness

- A–E are one contact group per numbered row; F–J are another, separated by the channel. The SVG leaves power rails unused. [SparkFun breadboard anatomy](https://learn.sparkfun.com/tutorials/how-to-use-a-breadboard/anatomy-of-a-breadboard).
- Rotate the microphone 90°: its five header pins occupy **J6–J10, five different rows**. Laying all five across one connected half-row shorts signals together. Female jumpers are another valid mounting method.
- The switch reference is a 6mm four-lead SPST-NO tactile switch, such as Adafruit 367 / Omron B3F-10xx geometry. The selected diagonal contacts avoid using two already-common terminals. The drawing shows fixed common pairs E13/F13 and E15/F15; verify the actual switch with a continuity meter. Its leads may need gentle forming to the 2.54mm breadboard grid. [Adafruit switch](https://www.adafruit.com/product/367), [Omron contact form and dimensions, PDF pages 5–6](https://cdn-shop.adafruit.com/datasheets/B3F-1000-Omron.pdf).
- The controller's lower two unused header positions overhang the breadboard edge; insulate exposed contacts. Keep its antenna away from conductive rails, wires, metal and the user's hand.
- The transmitter receives power through its own USB connector. The microphone receives regulated 3.3V from the controller. Verify that voltage on the actual clone before attaching the microphone.
- The second controller is the receiver and connects by USB to the Mac. **Only 2.4GHz radio connects transmitter and receiver.** Neither the render nor the SVG includes an inter-board cable.

## Scope and validation

The SVG and JSON are generated from the same contact map by `tools/render_wiring.py` (run with Python 3 from the repository root). Labels have solid backplates so breadboard holes do not obscure them. A connectivity check models every breadboard row, each jumper and the switch's fixed contact pairs. It confirmed five separate nets with PTT released; pressing the switch joins only PTT and GND. The SVG was rasterized and visually reviewed for wire endpoints, pin labels, power, SEL, antenna placement and the wireless receiver link.

The exact SuperMini clone revision is unknown. Check its P0.xx pin map, power behavior, board outline and USB connector before using the nice!nano v2 placement. Generated PCB component placement, tiny silkscreen, row numbering and exact raster pad locations are not manufacturing data. The scene's microphone uses direct jumper connections; the SVG gives an unambiguous breadboard-header alternative. Physical fit, microphone performance, RF range and the completed build still require bench validation.
