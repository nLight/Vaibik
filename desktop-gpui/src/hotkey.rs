use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
use core_graphics::event::{
    CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
};

use crate::dictation::{self, Command};

const F13: i64 = 105;
const KEYCODE_FIELD: u32 = 9;

// Global F13 push-to-talk toggle. A listen-only event tap keeps the target app
// frontmost while dictating, so the transcribed text inserts into its active field.
pub fn install() {
    std::thread::spawn(|| {
        let tap = match CGEventTap::new(
            CGEventTapLocation::Session,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![CGEventType::KeyDown],
            |_proxy, _etype, event| {
                if event.get_integer_value_field(KEYCODE_FIELD) == F13 {
                    dictation::send(Command::Toggle);
                }
                None
            },
        ) {
            Ok(tap) => tap,
            Err(_) => {
                eprintln!("VibeMic: горячая клавиша недоступна (разрешите мониторинг ввода).");
                return;
            }
        };
        tap.enable();
        if let Ok(source) = tap.mach_port.create_runloop_source(0) {
            let runloop = CFRunLoop::get_current();
            runloop.add_source(&source, unsafe { kCFRunLoopCommonModes });
            CFRunLoop::run_current();
        }
        drop(tap);
    });
}