use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
use core_graphics::event::{
    CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
};

use crate::dictation::{self, Command};

const F13: i64 = 105;
const KEYCODE_FIELD: u32 = 9;
const AUTOREPEAT_FIELD: u32 = 8;

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
                if is_toggle(
                    event.get_integer_value_field(KEYCODE_FIELD),
                    event.get_integer_value_field(AUTOREPEAT_FIELD) != 0,
                    event.get_flags(),
                ) {
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

// Only a bare F13 press toggles. The board holds ⌃⌥⇧F13 to start Codex dictation, and a
// held key auto-repeats; neither may start or stop VibeMic's own recording.
fn is_toggle(keycode: i64, autorepeat: bool, flags: CGEventFlags) -> bool {
    let modifiers = CGEventFlags::CGEventFlagControl
        | CGEventFlags::CGEventFlagAlternate
        | CGEventFlags::CGEventFlagShift
        | CGEventFlags::CGEventFlagCommand;
    keycode == F13 && !autorepeat && !flags.intersects(modifiers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bare_f13_toggles() {
        assert!(is_toggle(F13, false, CGEventFlags::CGEventFlagNull));
        assert!(is_toggle(F13, false, CGEventFlags::CGEventFlagSecondaryFn));
        assert!(!is_toggle(F13, true, CGEventFlags::CGEventFlagNull));
        let codex = CGEventFlags::CGEventFlagControl
            | CGEventFlags::CGEventFlagAlternate
            | CGEventFlags::CGEventFlagShift;
        assert!(!is_toggle(F13, false, codex));
        assert!(!is_toggle(F13, false, CGEventFlags::CGEventFlagCommand));
        assert!(!is_toggle(104, false, CGEventFlags::CGEventFlagNull));
    }
}
