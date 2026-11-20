mod audio;
mod dictation;
mod engine;
mod faceplate;
mod hid;
mod hotkey;
mod insert;
mod native;
mod sound;

use std::time::Duration;

use gpui_kit::component::input::TextareaState;
use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::*;

actions!(vibemic, [Quit]);

struct Universal {
    draft: Option<Entity<TextareaState>>,
    last_transcript: String,
    settings: bool,
    mics: Vec<String>,
    mic_choice: Option<String>,
}

impl Universal {
    fn draft_text(&self, cx: &App) -> String {
        self.draft
            .as_ref()
            .map(|draft| draft.read(cx).value().to_string())
            .unwrap_or_default()
    }
}

impl Render for Universal {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let snap = dictation::snapshot();
        faceplate::render(&snap, window, self, cx)
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
        Theme::global_mut(cx).mode = ThemeMode::Dark;
        dictation::start();
        hotkey::install();
        hid::spawn();
        std::thread::spawn(|| {
            let _ = engine::ensure_server();
        });
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(140.0), px(140.0)),
                size: size(px(560.0), px(600.0)),
            })),
            titlebar: Some(TitlebarOptions {
                title: Some("VibeMic".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        gpui_kit::open_window(options, cx, |_, cx| {
            let entity = cx.new(|_| Universal {
                draft: None,
                last_transcript: String::new(),
                settings: false,
                mics: Vec::new(),
                mic_choice: None,
            });
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