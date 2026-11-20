use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::{InteractiveElement, StatefulInteractiveElement};
use gpui_kit::*;

use crate::dictation::{self, Command, Snapshot};
use crate::{audio, hid, Universal};

const ALU_0: u32 = 0xf5f4f0;
const ALU_2: u32 = 0xd9d8d2;
const ALU_EDGE: u32 = 0xb7b6ae;
const ALU_LINE: u32 = 0xc2c1ba;
const INK: u32 = 0x1b1c1e;
const INK_FAINT: u32 = 0x8d8f94;

const OLED_0: u32 = 0x08090b;
const OLED_1: u32 = 0x101216;
const OLED_2: u32 = 0x1a1d23;
const OLED_LINE: u32 = 0x262a32;
const OLED_INK: u32 = 0xeef1f4;
const OLED_DIM: u32 = 0x8a919c;
const OLED_FAINT: u32 = 0x565d68;

const SIGNAL_HOT: u32 = 0xff6a26;
const SIGNAL_DEEP: u32 = 0xcf3a00;
const GREEN: u32 = 0x2fd67b;
const RED: u32 = 0xff3b30;
const AMBER: u32 = 0xffb000;

const MIC_PATH: &str = "M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.08A7 7 0 0 0 19 11z";
const COPY_PATH: &str = "M9 9h10v10H9z M5 5h10v2H7v8H5z";
const SPEAKER_PATH: &str = "M4 9v6h4l5 4V5L8 9H4z M16 8a4 4 0 0 1 0 8v-2a2 2 0 0 0 0-4V8z";
const GEAR_PATH: &str = "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M11 2h2l.4 2.6 2.2.9 2.2-1.5 1.4 1.4-1.5 2.2.9 2.2L21 11v2l-2.6.4-.9 2.2 1.5 2.2-1.4 1.4-2.2-1.5-2.2.9L13 21h-2l-.4-2.6-2.2-.9-2.2 1.5-1.4-1.4 1.5-2.2-.9-2.2L3 13v-2l2.6-.4.9-2.2L5 6.2l1.4-1.4 2.2 1.5 2.2-.9L11 2z";
const BACK_PATH: &str = "M15 6l-6 6 6 6V6z";

fn grad(angle: f32, from: u32, to: u32) -> Background {
    linear_gradient(angle, linear_color_stop(rgb(from), 0.0), linear_color_stop(rgb(to), 1.0))
}

fn icon(path: &str, size: f32, color: u32) -> impl IntoElement {
    let doc = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"#{:06x}\"><path d=\"{}\"/></svg>",
        color, path
    );
    svg().data(doc.as_bytes()).size(px(size)).text_color(rgb(color))
}

fn led(color: u32, size: f32) -> impl IntoElement {
    div().size(px(size)).rounded(px(size)).bg(rgb(color))
}

// Transmitter battery: a small cell glyph plus "≈ 82 %", "USB" or "—" without fresh data.
fn battery_pill(battery: Option<hid::Battery>) -> impl IntoElement {
    let percent = battery.and_then(|battery| battery.percent);
    let usb = battery.map(|battery| battery.usb_power).unwrap_or(false);
    let (label, fill, color) = match (usb, percent) {
        (true, _) => ("USB".to_string(), 100.0, GREEN),
        (false, Some(percent)) => (
            format!("≈ {percent}%"),
            f32::from(percent),
            if percent <= 15 { RED } else if percent <= 30 { AMBER } else { OLED_INK },
        ),
        (false, None) => ("—".to_string(), 0.0, OLED_FAINT),
    };
    let cell = div()
        .flex()
        .items_center()
        .child(
            div()
                .w(px(20.0))
                .h(px(10.0))
                .p(px(1.5))
                .rounded(px(2.5))
                .border_1()
                .border_color(rgb(OLED_DIM))
                .child(div().h_full().w(relative(fill / 100.0)).rounded(px(1.0)).bg(rgb(color))),
        )
        .child(div().w(px(2.0)).h(px(4.0)).rounded_r(px(1.0)).bg(rgb(OLED_DIM)));
    div()
        .flex()
        .items_center()
        .gap(px(6.0))
        .rounded(px(999.0))
        .px(px(11.0))
        .py(px(5.0))
        .bg(rgba(0xffffff0a))
        .border_1()
        .border_color(rgb(OLED_LINE))
        .child(cell)
        .child(
            div()
                .text_size(px(11.5))
                .font_weight(FontWeight::BOLD)
                .whitespace_nowrap()
                .text_color(rgb(match percent {
                    Some(percent) if !usb && percent <= 15 => RED,
                    Some(_) => OLED_DIM,
                    None if usb => OLED_DIM,
                    None => OLED_FAINT,
                }))
                .child(label),
        )
}

pub fn render(snap: &Snapshot, window: &mut Window, this: &mut Universal, cx: &mut Context<Universal>) -> impl IntoElement {
    if this.draft.is_none() {
        let state = cx.new(|cx| {
            TextareaState::new(window, cx).placeholder("Здесь появится текст диктовки…")
        });
        this.draft = Some(state);
    }
    if snap.transcript != this.last_transcript {
        this.last_transcript = snap.transcript.clone();
        if let Some(draft) = &this.draft {
            let text = snap.transcript.clone();
            draft.update(cx, |state, cx| state.set_value(text, window, cx));
        }
    }

    let toolbar = toolbar(snap, this, cx);
    let body = if this.settings { settings(snap, this, cx) } else { overview(snap, this, cx) };

    div()
        .flex()
        .flex_col()
        .size_full()
        .bg(grad(180.0, ALU_0, ALU_2))
        .text_color(rgb(INK))
        .child(toolbar)
        .child(body)
}

fn toolbar(snap: &Snapshot, this: &mut Universal, cx: &mut Context<Universal>) -> impl IntoElement {
    let brand_mark = div()
        .size(px(22.0))
        .rounded(px(6.0))
        .bg(grad(145.0, SIGNAL_HOT, SIGNAL_DEEP))
        .flex()
        .items_center()
        .justify_center()
        .child(div().w(px(10.0)).h(px(4.0)).rounded(px(2.0)).bg(rgb(0xffffff)));

    let brand = div()
        .flex()
        .items_center()
        .gap(px(10.0))
        .child(brand_mark)
        .child(
            div()
                .text_size(px(16.0))
                .font_weight(FontWeight::EXTRA_BOLD)
                .text_color(rgb(INK))
                .child("VIBEMIC"),
        )
        .child(
            div()
                .text_size(px(10.0))
                .font_weight(FontWeight::SEMIBOLD)
                .font_family("Menlo")
                .text_color(rgb(INK_FAINT))
                .border_1()
                .border_color(rgb(ALU_LINE))
                .rounded(px(4.0))
                .px(px(5.0))
                .py(px(2.0))
                .bg(rgba(0xffffff59))
                .child("VM-01"),
        );

    let sound_dot = if snap.sound { GREEN } else { INK_FAINT };
    let sound_btn = div()
        .id("sound")
        .size(px(34.0))
        .rounded(px(9.0))
        .bg(grad(180.0, ALU_0, ALU_2))
        .border_1()
        .border_color(rgb(ALU_EDGE))
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .on_click(cx.listener(|_, _, _, _| {
            let current = dictation::snapshot().sound;
            dictation::send(Command::SetSound(!current));
        }))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(3.0))
                .child(led(sound_dot, 5.0))
                .child(icon(SPEAKER_PATH, 15.0, INK)),
        );

    let gear_btn = div()
        .id("settings")
        .size(px(34.0))
        .rounded(px(9.0))
        .bg(grad(180.0, ALU_0, ALU_2))
        .border_1()
        .border_color(rgb(ALU_EDGE))
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .on_click(cx.listener(|this, _, _, _| {
            this.settings = !this.settings;
            if this.settings {
                this.mics = audio::input_names();
            }
        }))
        .child(icon(GEAR_PATH, 16.0, INK));

    let mut bar = div()
        .flex()
        .items_center()
        .h(px(58.0))
        .px(px(18.0))
        .gap(px(8.0))
        .child(brand)
        .child(div().flex_1())
        .child(sound_btn);

    if this.settings {
        let back = div()
            .id("back")
            .h(px(34.0))
            .rounded(px(9.0))
            .px(px(12.0))
            .bg(grad(180.0, ALU_0, ALU_2))
            .border_1()
            .border_color(rgb(ALU_EDGE))
            .flex()
            .items_center()
            .gap(px(6.0))
            .cursor_pointer()
            .on_click(cx.listener(|this, _, _, _| this.settings = false))
            .child(icon(BACK_PATH, 14.0, INK))
            .child(div().text_size(px(12.0)).text_color(rgb(INK)).child("Готово"));
        bar = bar.child(back);
    } else {
        bar = bar.child(gear_btn);
    }
    bar
}

fn overview(snap: &Snapshot, this: &mut Universal, cx: &mut Context<Universal>) -> Div {
    let led_color = if snap.recording { RED } else if snap.busy { AMBER } else { GREEN };
    let status = if snap.recording {
        "ЗАПИСЬ"
    } else if snap.busy {
        "РАСПОЗНАВАНИЕ"
    } else {
        "ГОТОВ К ЗАПИСИ"
    };
    let has_text = !snap.transcript.trim().is_empty();

    let (device_label, device_led) = match hid::device_name() {
        Some(name) if name.contains("(USB)") => ("VibeMic · USB".to_string(), GREEN),
        Some(_) => ("VibeMic · радио".to_string(), GREEN),
        None => ("VibeMic не подключён".to_string(), OLED_FAINT),
    };
    let device_pill = div()
        .flex()
        .items_center()
        .gap(px(6.0))
        .rounded(px(999.0))
        .px(px(11.0))
        .py(px(5.0))
        .bg(rgba(0xffffff0a))
        .border_1()
        .border_color(rgb(OLED_LINE))
        .child(led(device_led, 7.0))
        .child(
            div()
                .text_size(px(11.5))
                .font_weight(FontWeight::BOLD)
                .text_color(rgb(OLED_DIM))
                .child(device_label),
        );

    let battery = hid::device_name().map(|_| battery_pill(hid::battery()));

    let oled_status = div()
        .flex()
        .items_center()
        .gap(px(10.0))
        .min_h(px(26.0))
        .child(led(led_color, 9.0))
        .child(
            div()
                .text_size(px(12.0))
                .font_weight(FontWeight::BOLD)
                .font_family("Menlo")
                .whitespace_nowrap()
                .text_color(rgb(OLED_INK))
                .child(status),
        )
        .child(div().flex_1())
        .children(battery)
        .child(device_pill);

    let hint = div()
        .text_size(px(11.0))
        .line_height(px(16.0))
        .text_color(rgb(OLED_FAINT))
        .child(snap.status.clone());

    let draft = this.draft.as_ref().expect("draft initialized");
    let draft_screen = div()
        .flex_1()
        .py(px(10.0))
        .child(
            Textarea::new(draft)
                .w_full()
                .h_full()
                .appearance(false)
                .bordered(false)
                .text_size(px(17.0))
                .line_height(px(26.0))
                .text_color(rgb(OLED_INK)),
        );

    let ptt_bg = if snap.recording { grad(145.0, 0xff6a5a, RED) } else { grad(145.0, SIGNAL_HOT, SIGNAL_DEEP) };
    let ptt = div()
        .id("ptt")
        .size(px(54.0))
        .rounded(px(54.0))
        .bg(ptt_bg)
        .border_1()
        .border_color(rgb(SIGNAL_DEEP))
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .on_click(cx.listener(|_, _, _, _| dictation::send(Command::Toggle)))
        .child(icon(MIC_PATH, 23.0, 0xffffff));

    let segmented = div()
        .flex()
        .items_center()
        .gap(px(2.0))
        .bg(rgb(OLED_2))
        .border_1()
        .border_color(rgb(OLED_LINE))
        .rounded(px(10.0))
        .p(px(3.0))
        .child(seg_button("seg-insert", "Вставка", snap.insert_mode, cx.listener(|_, _, _, _| {
            dictation::send(Command::SetInsertMode(true))
        })))
        .child(seg_button("seg-buffer", "Буфер", !snap.insert_mode, cx.listener(|_, _, _, _| {
            dictation::send(Command::SetInsertMode(false))
        })));

    let copy_btn = div()
        .id("copy")
        .flex()
        .items_center()
        .gap(px(6.0))
        .rounded(px(9.0))
        .px(px(11.0))
        .py(px(7.0))
        .bg(rgba(0xffffff0b))
        .border_1()
        .border_color(rgb(OLED_LINE))
        .text_size(px(12.0))
        .text_color(rgb(if has_text { OLED_DIM } else { OLED_FAINT }))
        .cursor_pointer()
        .on_click(cx.listener(|this, _, _, cx| {
            let text = this.draft_text(cx);
            dictation::send(Command::CopyText(text));
        }))
        .child(icon(COPY_PATH, 13.0, if has_text { OLED_DIM } else { OLED_FAINT }))
        .child("Копировать");

    let mut controls = div()
        .flex()
        .items_center()
        .justify_center()
        .gap(px(8.0))
        .border_t_1()
        .border_color(rgb(OLED_LINE))
        .mt(px(14.0))
        .pt(px(14.0))
        .child(ptt)
        .child(segmented)
        .child(copy_btn);

    if has_text {
        let insert_btn = div()
            .id("insert")
            .flex()
            .items_center()
            .gap(px(6.0))
            .rounded(px(9.0))
            .px(px(14.0))
            .py(px(7.0))
            .min_h(px(34.0))
            .bg(grad(150.0, SIGNAL_HOT, SIGNAL_DEEP))
            .border_1()
            .border_color(rgb(SIGNAL_DEEP))
            .text_size(px(12.5))
            .font_weight(FontWeight::BOLD)
            .text_color(rgb(0xffffff))
            .cursor_pointer()
            .on_click(cx.listener(|this, _, _, cx| {
                let text = this.draft_text(cx);
                dictation::send(Command::InsertText(text));
            }))
            .child("Вставить");
        controls = controls.child(insert_btn);
    }

    let oled = div()
        .flex()
        .flex_col()
        .flex_1()
        .rounded(px(18.0))
        .pt(px(16.0))
        .px(px(18.0))
        .pb(px(14.0))
        .bg(grad(160.0, OLED_1, OLED_0))
        .border_1()
        .border_color(rgb(0x0c0d0f))
        .text_color(rgb(OLED_INK))
        .child(oled_status)
        .children(if has_text { None } else { Some(hint) })
        .child(draft_screen)
        .child(controls);

    div()
        .flex()
        .flex_col()
        .flex_1()
        .pt(px(2.0))
        .px(px(20.0))
        .pb(px(18.0))
        .child(oled)
}

fn settings(snap: &Snapshot, this: &mut Universal, cx: &mut Context<Universal>) -> Div {
    let mut mic_buttons = div()
        .id("mic-scroll")
        .flex()
        .flex_col()
        .gap(px(6.0))
        .max_h(px(160.0))
        .overflow_y_scroll()
        .child(mic_option(
        "mic-auto",
        "VibeMic автоматически (донгл)",
        this.mic_choice.is_none(),
        cx.listener(|this, _, _, _| {
            this.mic_choice = None;
            audio::set_preferred(None);
        }),
    ));
    for (index, name) in this.mics.clone().into_iter().enumerate() {
        let selected = this.mic_choice.as_deref() == Some(name.as_str());
        let label = name.clone();
        mic_buttons = mic_buttons.child(mic_option(
            format!("mic-{index}"),
            &label,
            selected,
            cx.listener(move |this, _, _, _| {
                this.mic_choice = Some(name.clone());
                audio::set_preferred(Some(name.clone()));
            }),
        ));
    }

    let mic_card = card("Микрофон", "Источник записи для диктовки.", mic_buttons);

    let insert_card = card(
        "Место вставки",
        "Куда попадает текст.",
        div()
            .flex()
            .items_center()
            .gap(px(2.0))
            .bg(rgb(OLED_2))
            .border_1()
            .border_color(rgb(OLED_LINE))
            .rounded(px(10.0))
            .p(px(3.0))
            .child(seg_button("set-insert", "Вставка", snap.insert_mode, cx.listener(|_, _, _, _| {
                dictation::send(Command::SetInsertMode(true))
            })))
            .child(seg_button("set-buffer", "Буфер", !snap.insert_mode, cx.listener(|_, _, _, _| {
                dictation::send(Command::SetInsertMode(false))
            }))),
    );

    let sound_card = card(
        "Звук",
        "Сигналы записи.",
        div()
            .id("sound-row")
            .flex()
            .items_center()
            .gap(px(8.0))
            .rounded(px(9.0))
            .px(px(12.0))
            .py(px(8.0))
            .bg(rgb(OLED_2))
            .border_1()
            .border_color(rgb(OLED_LINE))
            .cursor_pointer()
            .on_click(cx.listener(|_, _, _, _| {
                let current = dictation::snapshot().sound;
                dictation::send(Command::SetSound(!current));
            }))
            .child(led(if snap.sound { GREEN } else { OLED_FAINT }, 8.0))
            .child(
                div()
                    .text_size(px(12.0))
                    .text_color(rgb(OLED_INK))
                    .child(if snap.sound { "Звук включён" } else { "Звук выключен" }),
            ),
    );

    let native_card = card(
        "Codex и Claude",
        "Диктовка по кнопке передатчика.",
        div()
            .id("native-row")
            .flex()
            .items_center()
            .gap(px(8.0))
            .rounded(px(9.0))
            .px(px(12.0))
            .py(px(8.0))
            .bg(rgb(OLED_2))
            .border_1()
            .border_color(rgb(OLED_LINE))
            .cursor_pointer()
            .on_click(cx.listener(|_, _, _, _| {
                let current = dictation::snapshot().native;
                dictation::send(Command::SetNative(!current));
            }))
            .child(led(if snap.native { GREEN } else { OLED_FAINT }, 8.0))
            .child(
                div()
                    .text_size(px(12.0))
                    .text_color(rgb(OLED_INK))
                    .child(if snap.native { "Их встроенная диктовка" } else { "Запись VibeMic" }),
            ),
    );

    let model_card = card(
        "Модель Parakeet",
        "Локальное распознавание речи.",
        div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .rounded(px(9.0))
            .px(px(12.0))
            .py(px(8.0))
            .bg(rgb(OLED_2))
            .border_1()
            .border_color(rgb(OLED_LINE))
            .child(led(if crate::engine::model_installed() { GREEN } else { AMBER }, 8.0))
            .child(
                div()
                    .text_size(px(12.0))
                    .text_color(rgb(OLED_INK))
                    .child(if crate::engine::model_installed() { "Модель установлена" } else { "Модель не установлена" }),
            ),
    );

    div().flex().flex_col().flex_1().child(
        div()
            .flex()
            .flex_col()
            .h_full()
            .gap(px(12.0))
            .px(px(20.0))
            .pb(px(18.0))
            .pt(px(2.0))
            .child(mic_card)
            .child(
                div()
                    .flex()
                    .gap(px(12.0))
                    .child(div().flex_1().min_w(px(0.0)).child(insert_card))
                    .child(div().flex_1().min_w(px(0.0)).child(sound_card)),
            )
            .child(
                div()
                    .flex()
                    .gap(px(12.0))
                    .child(div().flex_1().min_w(px(0.0)).child(native_card))
                    .child(div().flex_1().min_w(px(0.0)).child(model_card)),
            ),
    )
}

fn card(title: &str, subtitle: &str, body: impl IntoElement) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(px(10.0))
        .rounded(px(12.0))
        .bg(rgb(OLED_1))
        .border_1()
        .border_color(rgb(OLED_LINE))
        .p(px(14.0))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.0))
                .child(div().text_size(px(13.0)).font_weight(FontWeight::BOLD).text_color(rgb(OLED_INK)).child(title.to_string()))
                .child(div().text_size(px(11.0)).text_color(rgb(OLED_FAINT)).child(subtitle.to_string())),
        )
        .child(body)
}

fn mic_option(id: impl Into<ElementId>, label: &str, selected: bool, on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> impl IntoElement {
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(px(8.0))
        .rounded(px(9.0))
        .px(px(12.0))
        .py(px(8.0))
        .bg(rgb(if selected { OLED_2 } else { OLED_1 }))
        .border_1()
        .border_color(rgb(if selected { SIGNAL_DEEP } else { OLED_LINE }))
        .cursor_pointer()
        .on_click(on_click)
        .child(led(if selected { SIGNAL_HOT } else { OLED_FAINT }, 7.0))
        .child(div().text_size(px(12.0)).text_color(rgb(OLED_INK)).child(label.to_string()))
}

fn seg_button(
    id: &'static str,
    label: &'static str,
    pressed: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let mut button = div()
        .id(id)
        .rounded(px(7.0))
        .px(px(9.0))
        .py(px(6.0))
        .text_size(px(11.0))
        .cursor_pointer()
        .on_click(on_click)
        .child(label);
    if pressed {
        button = button.bg(grad(180.0, 0x2b313b, 0x20252d)).text_color(rgb(OLED_INK));
    } else {
        button = button.text_color(rgb(OLED_DIM));
    }
    button
}