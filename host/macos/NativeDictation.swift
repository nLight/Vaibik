import AppKit
import ApplicationServices
import Carbon.HIToolbox

private let claudeBundle = "com.anthropic.claudefordesktop"

// Return the HID usage that produces "d" with Command in the active layout.
// The device supports the physical D (QWERTY) and G (Colemak) positions.
private func claudeShortcutUsage() -> Int? {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
          let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData),
          let bytes = CFDataGetBytePtr(Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue()) else { return nil }
    let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
    for (key, usage) in [(kVK_ANSI_D, 0x07), (kVK_ANSI_G, 0x0a)] {
        var deadKey: UInt32 = 0
        var count = 0
        var characters = [UniChar](repeating: 0, count: 4)
        let status = UCKeyTranslate(layout, UInt16(key), UInt16(kUCKeyActionDown),
            UInt32(cmdKey >> 8), UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysMask),
            &deadKey, characters.count, &count, &characters)
        if status == noErr && count == 1 && (characters[0] == 0x64 || characters[0] == 0x44) { return usage }
    }
    // Non-Latin layouts (e.g. Russian) never translate Cmd+D to "d"; fall back to the
    // physical D position so the HID tap is still emitted instead of silently sending nothing.
    return 0x07
}

private struct NativeRecording {
    let id: Int
    let app: String
    let pid: pid_t
    let window: AXUIElement
    let title: String?
    let field: AXUIElement
    let composer: AXUIElement
    let started: TimeInterval
    let usesClaudeShortcut: Bool
    let isClaude: Bool

    static let startLabels: Set<String> = ["Dictate", "Start dictation", "Диктовать", "Начать диктовку"]
    static let claudeStartLabels = startLabels.union(["Press and hold to record", "Turn on microphone"])
    static let stopLabels: Set<String> = ["Stop dictation", "Finish dictation", "Остановить диктовку", "Завершить диктовку"]
    static let cancelLabels: Set<String> = [
        "Cancel dictation", "Отменить диктовку", "Starting dictation; click to cancel",
        "Диктовка запускается; нажмите для отмены"
    ]

    static func button(in root: AXUIElement, labels: Set<String>) -> AXUIElement? {
        enabledButton(in: root, labels: labels, includeToggles: true)
    }

    static func begin(id: Int, claudeShortcut: Bool) -> NativeRecording? {
        guard let application = NSWorkspace.shared.frontmostApplication,
              ApprovalTarget.supports(application), let bundle = application.bundleIdentifier else { return nil }
        let element = AXUIElementCreateApplication(application.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.1)
        let isClaude = bundle == claudeBundle
        // The Claude HID tap needs no Accessibility to START (parity with the Codex hold):
        // the firmware emits Cmd+D and Claude itself decides whether a composer is focused.
        // Stop/idle re-locate the button via AX, which does need the grant.
        if isClaude && claudeShortcut {
            let window = axElement(element, kAXFocusedWindowAttribute) ?? element
            let field = axElement(element, kAXFocusedUIElementAttribute) ?? element
            return NativeRecording(id: id, app: application.localizedName ?? "Claude",
                pid: application.processIdentifier, window: window,
                title: attribute(window, kAXTitleAttribute) as? String, field: field, composer: field,
                started: ProcessInfo.processInfo.systemUptime, usesClaudeShortcut: true, isClaude: true)
        }
        guard AXIsProcessTrusted(),
              let window = axElement(element, kAXFocusedWindowAttribute),
              let field = axElement(element, kAXFocusedUIElementAttribute),
              attribute(field, kAXSelectedTextRangeAttribute) != nil,
              attribute(field, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole,
              ApprovalTarget.documentContaining(field, in: window, bundle: bundle) != nil else { return nil }
        var composer = field
        if isClaude && !claudeShortcut { return nil }
        let useShortcut = isClaude
        let labels = isClaude ? claudeStartLabels : startLabels
        for _ in 0..<7 {
            if CFEqual(composer, window) || attribute(composer, kAXRoleAttribute) as? String == "AXWebArea" {
                break
            }
            if let button = button(in: composer, labels: labels) {
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier else { return nil }
                guard useShortcut || AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { return nil }
                return NativeRecording(id: id, app: application.localizedName ?? "Codex",
                    pid: application.processIdentifier, window: window,
                    title: attribute(window, kAXTitleAttribute) as? String, field: field, composer: composer,
                    started: ProcessInfo.processInfo.systemUptime, usesClaudeShortcut: useShortcut, isClaude: isClaude)
            }
            guard let parent = axElement(composer, kAXParentAttribute) else { break }
            composer = parent
        }
        return nil
    }

    // Electron recreates the composer's AX nodes, so a stored element goes stale.
    // Re-locate from the current focused field, walking up a few ancestors.
    func locateButton(_ labels: Set<String>) -> AXUIElement? {
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.1)
        guard var composer = axElement(application, kAXFocusedUIElementAttribute) else { return nil }
        for _ in 0..<7 {
            if CFEqual(composer, window) || attribute(composer, kAXRoleAttribute) as? String == "AXWebArea" {
                break
            }
            if let button = Self.button(in: composer, labels: labels) { return button }
            guard let parent = axElement(composer, kAXParentAttribute) else { break }
            composer = parent
        }
        return nil
    }

    func idleClaudeButton() -> AXUIElement? {
        guard isClaude, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
              attribute(window, kAXTitleAttribute) as? String == title,
              let button = locateButton(Self.claudeStartLabels),
              attribute(button, "AXBusy") as? Bool != true,
              attribute(button, kAXValueAttribute) as? NSNumber != 1 else { return nil }
        return button
    }

    func stop(cancel: Bool) -> Bool {
        guard attribute(window, kAXTitleAttribute) as? String == title else { return false }
        if cancel, let button = Self.button(in: composer, labels: Self.cancelLabels) ?? locateButton(Self.cancelLabels) {
            return AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
        }
        let stopSet = Self.stopLabels.union(Self.cancelLabels)
        if let button = Self.button(in: composer, labels: stopSet) ?? locateButton(stopSet) {
            return AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
        }
        let idleSet = isClaude ? Self.claudeStartLabels : Self.startLabels
        return ProcessInfo.processInfo.systemUptime - started > 0.12 &&
            (Self.button(in: composer, labels: idleSet) ?? locateButton(idleSet)) != nil
    }
}

final class NativeDictation {
    private var recording: NativeRecording?
    private var primed: Set<String> = []
    private var stopTimer: Timer?
    private var stoppingID: Int?

    private func reply(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        try? FileHandle.standardOutput.write(contentsOf: data + Data([0x0a]))
    }

    private func prime() {
        guard AXIsProcessTrusted(), let application = NSWorkspace.shared.frontmostApplication,
              ApprovalTarget.supports(application) else { return }
        let identity = "\(application.processIdentifier):\(application.launchDate?.timeIntervalSince1970 ?? 0)"
        guard primed.insert(identity).inserted else { return }
        let element = AXUIElementCreateApplication(application.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.1)
        AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }

    private func stop(id: Int, cancel: Bool, shutdown: Bool = false) {
        if let previous = stoppingID {
            reply(["id": previous, "ok": false, "error": "Встроенная диктовка отменена."])
        }
        stopTimer?.invalidate()
        stoppingID = id
        let deadline = ProcessInfo.processInfo.systemUptime + 1.2
        let finish: (Timer?) -> Void = { timer in
            let stopped = self.recording?.stop(cancel: cancel) ?? true
            if stopped || ProcessInfo.processInfo.systemUptime >= deadline {
                timer?.invalidate()
                self.stopTimer = nil
                self.stoppingID = nil
                if stopped { self.recording = nil }
                self.reply(["id": id, "ok": stopped, "native": true,
                            "error": "Завершите встроенную диктовку в приложении."])
                if shutdown { exit(0) }
            }
        }
        stopTimer = Timer.scheduledTimer(withTimeInterval: 0.025, repeats: true) { finish($0) }
    }

    private func command(_ line: String) {
        guard let data = line.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = request["id"] as? Int, let command = request["command"] as? String else { return }
        switch command {
        case "begin":
            guard recording == nil else {
                reply(["id": id, "ok": false, "error": "Сначала завершите текущую диктовку."])
                return
            }
            let useClaudeShortcut = request["claudeShortcut"] as? Bool == true
            if request["shortcut"] as? Bool == true,
               let application = NSWorkspace.shared.frontmostApplication,
               application.bundleIdentifier == "com.openai.codex", ApprovalTarget.supports(application),
               NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier {
                reply(["id": id, "ok": true, "native": true, "shortcut": "codex",
                       "app": application.localizedName ?? ""])
                return
            }
            prime()
            recording = NativeRecording.begin(id: id, claudeShortcut: useClaudeShortcut)
            let claude = recording?.usesClaudeShortcut == true
            reply(["id": id, "ok": true, "native": recording != nil, "app": recording?.app ?? "",
                   "shortcut": claude ? "claude" : "", "usage": claude ? (claudeShortcutUsage() ?? 0) : 0])
        case "claude-retry", "claude-abandon":
            guard let current = recording, request["session"] as? Int == current.id else {
                reply(["id": id, "ok": false, "error": "Сессия диктовки изменилась."])
                return
            }
            let idle = current.idleClaudeButton()
            if command == "claude-retry", let button = idle {
                _ = AXUIElementPerformAction(button, kAXPressAction as CFString)
            }
            if command == "claude-abandon", idle != nil { recording = nil }
            reply(["id": id, "ok": true, "idle": idle != nil])
        case "end", "cancel":
            if command == "end", let session = request["session"] as? Int, session != recording?.id {
                reply(["id": id, "ok": false, "error": "Сессия диктовки изменилась."])
                return
            }
            stop(id: id, cancel: command == "cancel")
        default:
            reply(["id": id, "ok": false, "error": "Неизвестная команда диктовки."])
        }
    }

    static func run() {
        let controller = NativeDictation()
        let center = NSWorkspace.shared.notificationCenter
        let observer = center.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main) { _ in controller.prime() }
        controller.prime()
        signal(SIGPIPE, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination.setEventHandler { controller.stop(id: 0, cancel: true, shutdown: true) }
        termination.resume()
        DispatchQueue.global().async {
            while let line = readLine() {
                DispatchQueue.main.async { controller.command(line) }
            }
            DispatchQueue.main.async { controller.stop(id: 0, cancel: true, shutdown: true) }
        }
        RunLoop.current.run()
        center.removeObserver(observer)
        termination.cancel()
    }
}
