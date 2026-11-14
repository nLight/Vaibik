mod audio;
mod dictation;
mod engine;
mod hotkey;
mod insert;

use std::time::Duration;

use gpui_kit::*;
use gpui_kit::base::{Disableable, StyledExt};
use gpui_kit::component::button::Button;

actions!(vibemic, [Quit]);

struct Universal;

impl Render for Universal {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let snap = dictation::snapshot();
        let record_label = if snap.recording { "Стоп" } else { "Запись" };
        let transcript = if snap.transcript.is_empty() { "—".to_string() } else { snap.transcript.clone() };
        let mode_label = if snap.insert_mode { "Вставка: вкл" } else { "Вставка: выкл" };
        let insert_mode = snap.insert_mode;

        div()
            .v_flex()
            .gap_3()
            .p_4()
            .size_full()
            .child(div().text_xl().child("VibeMic Universal"))
            .child(div().text_sm().child(snap.status))
            .child(
                div()
                    .h_flex()
                    .gap_2()
                    .child(
                        Button::new("record")
                            .label(record_label)
                            .disabled(snap.busy)
                            .on_click(cx.listener(|_, _, _, _| dictation::send(dictation::Command::Toggle))),
                    )
                    .child(
                        Button::new("copy")
                            .label("Копировать")
                            .disabled(snap.transcript.is_empty())
                            .on_click(cx.listener(|_, _, _, _| dictation::send(dictation::Command::Copy))),
                    )
                    .child(
                        Button::new("insert")
                            .label("Вставить")
                            .disabled(snap.transcript.is_empty())
                            .on_click(cx.listener(|_, _, _, _| dictation::send(dictation::Command::InsertNow))),
                    )
                    .child(
                        Button::new("mode")
                            .label(mode_label)
                            .on_click(cx.listener(move |_, _, _, _| {
                                dictation::send(dictation::Command::SetInsertMode(!insert_mode))
                            })),
                    ),
            )
            .child(
                div()
                    .v_flex()
                    .gap_1()
                    .p_3()
                    .min_h_24()
                    .child(div().text_sm().child("Расшифровка"))
                    .child(div().child(transcript)),
            )
            .child(div().text_xs().child("Горячая клавиша: F13 (запись/стоп). Текст копируется в буфер и вставляется в активное поле."))
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|arg| arg == "--selftest") {
        let path = args.get(pos + 1).expect("usage: vibemic-gpui --selftest <wav>");
        selftest(path);
        return;
    }
    if let Some(pos) = args.iter().position(|arg| arg == "--record-test") {
        let secs: f32 = args.get(pos + 1).and_then(|value| value.parse().ok()).unwrap_or(3.0);
        record_test(secs);
        return;
    }
    gpui_kit::application().run(|cx| {
        gpui_kit::init(cx);
        dictation::start();
        hotkey::install();
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(140.0), px(140.0)),
                size: size(px(560.0), px(470.0)),
            })),
            titlebar: Some(TitlebarOptions {
                title: Some("VibeMic Universal".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        gpui_kit::open_window(options, cx, |_, cx| {
            let entity = cx.new(|_| Universal);
            let weak = entity.downgrade();
            cx.spawn(async move |cx| {
                loop {
                    cx.background_executor().timer(Duration::from_millis(150)).await;
                    let _ = weak.update(cx, |_, cx| cx.notify());
                }
            })
            .detach();
            entity
        })
        .expect("failed to open window");
    });
}

fn selftest(path: &str) {
    let wav = std::fs::read(path).expect("read wav");
    match engine::transcribe(&wav) {
        Ok(text) => {
            println!("TRANSCRIPT: {text}");
            match insert::write_clipboard(&text) {
                Ok(()) => println!("CLIPBOARD: ok"),
                Err(error) => println!("CLIPBOARD ERR: {error}"),
            }
            let target = insert::frontmost_pid();
            match insert::insert(&text, target) {
                Ok(()) => println!("INSERT: ok"),
                Err(error) => println!("INSERT ERR: {error}"),
            }
        }
        Err(error) => println!("TRANSCRIBE ERR: {error}"),
    }
}

fn record_test(secs: f32) {
    match audio::Recorder::start() {
        Ok(recorder) => {
            std::thread::sleep(Duration::from_secs_f32(secs));
            match recorder.stop() {
                Ok(wav) => {
                    println!("WAV bytes: {}", wav.len());
                    let _ = std::fs::write("/tmp/vm_record.wav", &wav);
                    match engine::transcribe(&wav) {
                        Ok(text) => {
                            println!("TRANSCRIPT: {text}");
                            let _ = insert::write_clipboard(&text);
                        }
                        Err(error) => println!("TRANSCRIBE ERR: {error}"),
                    }
                }
                Err(error) => println!("RECORD ERR: {error}"),
            }
        }
        Err(error) => println!("MIC ERR: {error}"),
    }
}