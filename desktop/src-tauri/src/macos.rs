#[cfg(target_os = "macos")]
pub fn accessibility_trusted(prompt: bool) -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef) -> bool;
    }

    let key = CFString::new("AXTrustedCheckOptionPrompt");
    let value = if prompt { CFBoolean::true_value() } else { CFBoolean::false_value() };
    let options = CFDictionary::from_CFType_pairs(&[(key, value)]);
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) }
}

#[cfg(not(target_os = "macos"))]
pub fn accessibility_trusted(_prompt: bool) -> bool {
    true
}

// AppKit re-lays the titlebar on resize, focus and fullscreen transitions and
// leaves the window buttons at stale heights, so keep them centered on the
// faceplate toolbar (.toolbar height in ui/styles.css) ourselves.
#[cfg(target_os = "macos")]
pub fn align_traffic_lights(window: &tauri::Window) {
    const TOOLBAR_HEIGHT: f64 = 58.0;
    use objc2_app_kit::{NSWindow, NSWindowButton};
    use objc2_foundation::NSPoint;

    let Ok(handle) = window.ns_window() else { return };
    let Some(ns_window) = (unsafe { (handle as *const NSWindow).as_ref() }) else { return };
    unsafe {
        let buttons: Vec<_> = [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ]
        .into_iter()
        .filter_map(|button| ns_window.standardWindowButton(button))
        .collect();
        let Some(container) = buttons.first().and_then(|b| b.superview()).and_then(|v| v.superview()) else { return };
        let mut frame = container.frame();
        frame.size.height = TOOLBAR_HEIGHT;
        frame.origin.y = ns_window.frame().size.height - TOOLBAR_HEIGHT;
        container.setFrame(frame);
        for button in &buttons {
            let button_frame = button.frame();
            button.setFrameOrigin(NSPoint::new(
                button_frame.origin.x,
                (TOOLBAR_HEIGHT - button_frame.size.height) / 2.0,
            ));
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn align_traffic_lights(_window: &tauri::Window) {}
