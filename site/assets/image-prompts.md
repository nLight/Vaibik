# ImageGen prompt set

Built-in ImageGen was used for all five raster deliverables. These are the normalized final authoring briefs, with the important revision instructions retained. Images are illustrative references; the deterministic wiring SVG is authoritative.

## Controller — `controller-render.png`

Use case: product-mockup. An isolated, orthographic top-down nRF52840 nice!nano-compatible black controller board on a genuinely transparent background. Use the official nice!nano v2 pinout image as the physical reference. USB-C at the top, twelve regular circular header contacts on each long edge, the extra pads next to USB separate from those headers, visible small components and a gold printed antenna at the opposite end. Realistic macro product lighting, finely detailed PCB and solder, no wires, no case, no extra connectors, no invented large labels. Geometry is reference-compatible, not a claim that every clone shares this PCB layout.

## Microphone — `microphone-render.png`

Use case: product-mockup / reference extraction. Use the official Adafruit 3492 product image to preserve the blue rounded PCB, two mounting holes, silver top-port MEMS microphone and five signal pads in the correct order: 3V, GND, SEL, CLK, DAT. Isolated top-down macro component render on a genuinely transparent background. Keep the acoustic port visible. No wires, no extra pins, no case, no unrelated parts.

## Breadboard — `breadboard-render-v2.png`

Use case: product-mockup. Isolated orthographic top-down white 400-contact half-size solderless breadboard on a genuinely transparent background. Thirty numbered signal rows, ten holes in each split into five A–E and five F–J by the middle ravine. Red and blue power rail stripes. Exactly four outer rail columns, each containing five groups of five holes (25 per column), for 100 power contacts plus 300 signal contacts. Realistic plastic, no components or wires.

Revision: preserve the original board and all thirty signal rows; correct only the four outer power columns to exactly five groups of five holes. The earlier rail-count variant was discarded and removed from the project.

## Button — `button-render.png`

Use case: product-mockup. An isolated generic breadboard-friendly 6mm four-lead normally open tactile switch, orthographic top-down, on a genuinely transparent background. Black plastic base, silver metal case, round black push plunger, four visible silver leads. Realistic macro materials and soft light. No wires, no labels, no case or decorative objects. This is a generic switch illustration; use the datasheet and meter for its contact pairs.

## Complete prototype — `prototype-scene.png`

Use case: product-mockup. A highly realistic hacker breadboard prototype on a dark charcoal workbench, exposed insulated jumper wires, no enclosure. Use the four component renders as appearance references and the exact wiring drawing as the geometry/topology reference. Wide near-orthographic camera, complete assembly visible, soft overhead light, fine PCB and solder detail.

Exactly two identical black nRF52840 controller boards. Each has a single USB-C connector at its top and a printed gold antenna at its bottom. The transmitter straddles the lower end of the 30-row breadboard, with the antenna beyond the edge and USB power connected at its top. The second controller lies separately to the right, connected to its own USB cable, with no wired connection between the boards.

Rotate the five-pin PDM board 90° clockwise: its header becomes a vertical line along the left edge and mounting holes lie at the right. Top-to-bottom pins are power, ground, SEL, clock and data. Ground SEL explicitly. Keep the acoustic port uncovered. A small momentary tactile PTT switch straddles the center channel. Red 3.3V, black common ground, yellow clock, cyan data and purple PTT wires, plausible fitted connectors and breadboard contacts. No battery, OLED, hands, tools, extra switches or circuit boards, captions, diagram overlays or watermarks.

Targeted corrections applied after review:

1. Remove the false USB connector/cable at the antenna end. Show the transmitter power cable connected only to its top USB socket, curving toward the left.
2. Counting regular circular header pads and excluding extra USB-adjacent pads: purple PTT on first left, ground on third left, yellow clock on fifth left, cyan data on sixth left, red power on fourth right.
3. Preserve the rotated microphone, five distinct pins and grounded SEL.
4. Add the missing thin black switch-ground jumper from the lower switch terminal to an exposed breadboard contact on the same ground row as the controller's third left header pad. Keep it visibly separate from the thick USB cable.
5. Reduce unreliable small row-number text; exact row coordinates are supplied by the SVG, not the raster image.

The hero intentionally retains a product-photograph treatment. It is not an electrical drawing, a manufacturing reference or evidence of a physically tested prototype.
