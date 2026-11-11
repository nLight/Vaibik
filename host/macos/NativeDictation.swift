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
    return nil
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

    static let startLabels: Set<String> = ["Dictate", "Start dictation", "Диктовать", "Начать диктовку"]
    static let claudeStartLabels = startLabels.union(["Press and hold to record", "Turn on microphone"])
    static let stopLabels: Set<String> = ["Stop dictation", "Finish dictation", "Остановить диктовку", "Завершить диктовку"]
    static let cancelLabels: Set<String> = [
        "Cancel dictation", "Отменить диктовку", "Starting dictation; click to cancel",
        "Диктовка запускается; нажмите для отмены"
    ]

    static func button(in root: AXUIElement, labels: Set<String>) -> AXUIElement? {
        var queue: [(AXUIElement, Int)] = [(root, 0)]
        var index = 0
        while index < queue.count && index < 160 {
            let (element, depth) = queue[index]
            index += 1
            let role = attribute(element, kAXRoleAttribute) as? String
            let isButton = role == kAXButtonRole || (role == kAXCheckBoxRole &&
                attribute(element, kAXSubroleAttribute) as? String == "AXToggleButton")
            if isButton && attribute(element, kAXEnabledAttribute) as? Bool != false {
                let title = attribute(element, kAXTitleAttribute) as? String ?? ""
                let description = attribute(element, kAXDescriptionAttribute) as? String ?? ""
                if labels.contains(title) || labels.contains(description) { return element }
            }
            if depth < 6 && role != "AXWebArea",
               let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
                queue.append(contentsOf: children.prefix(160 - min(queue.count, 160)).map { ($0, depth + 1) })
            }
        }
        return nil
    }

    static func begin(id: Int, claudeShortcut: Bool) -> NativeRecording? {
        guard AXIsProcessTrusted(), let application = NSWorkspace.shared.frontmostApplication,
              ApprovalTarget.supports(application), let bundle = application.bundleIdentifier else { return nil }
        let element = AXUIElementCreateApplication(application.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.1)
        guard let window = axElement(element, kAXFocusedWindowAttribute),
              let field = axElement(element, kAXFocusedUIElementAttribute),
              attribute(field, kAXSelectedTextRangeAttribute) != nil,
              attribute(field, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole,
              ApprovalTarget.documentContaining(field, in: window, bundle: bundle) != nil else { return nil }
        var composer = field
        let useShortcut = claudeShortcut && bundle == claudeBundle
        let labels = useShortcut ? claudeStartLabels : startLabels
        for _ in 0..<7 {
            if CFEqual(composer, window) || attribute(composer, kAXRoleAttribute) as? String == "AXWebArea" {
                break
            }
            if let button = button(in: composer, labels: labels) {
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier else { return nil }
                guard useShortcut || AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
                else { return nil }
                return NativeRecording(id: id, app: application.localizedName ?? "Codex",
                    pid: application.processIdentifier, window: window,
                    title: attribute(window, kAXTitleAttribute) as? String, field: field, composer: composer,
                    started: ProcessInfo.processInfo.systemUptime, usesClaudeShortcut: useShortcut)
            }
            guard let parent = axElement(composer, kAXParentAttribute) else { break }
            composer = parent
        }
        return nil
    }

    // An acknowledged USB report does not mean Claude received its shortcut.
    // Only retry or hand off to local dictation if the original recorder is still idle.
    func idleClaudeButton() -> AXUIElement? {
        guard usesClaudeShortcut, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
              attribute(window, kAXTitleAttribute) as? String == title,
              let focused = axElement(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute),
              CFEqual(focused, field),
              let button = Self.button(in: composer, labels: Self.claudeStartLabels),
              attribute(button, "AXBusy") as? Bool != true,
              attribute(button, kAXValueAttribute) as? NSNumber != 1 else { return nil }
        return button
    }

    func stop(cancel: Bool) -> Bool {
        guard attribute(window, kAXTitleAttribute) as? String == title else { return false }
        if cancel, let button = Self.button(in: composer, labels: Self.cancelLabels) {
            return AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
        }
        if let button = Self.button(in: composer, labels: Self.stopLabels.union(Self.cancelLabels)) {
            return AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
        }
        return ProcessInfo.processInfo.systemUptime - started > 0.12 &&
            Self.button(in: composer, labels: usesClaudeShortcut ? Self.claudeStartLabels : Self.startLabels) != nil
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
