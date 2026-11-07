import AppKit
import ApplicationServices

private let desktopApps = ["com.openai.codex", "com.anthropic.claudefordesktop"]
private let terminalApps = [
    "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty",
    "com.superlogical.rex", "net.kovidgoyal.kitty", "com.github.wez.wezterm", "dev.warp.Warp-Stable"
]

private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

private func axElement(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else {
        return nil
    }
    return (value as! AXUIElement)
}

struct TmuxPane: Equatable {
    let id: String
    let pid: String
    let command: String
    let client: String

    private static func tmux(_ args: [String], input: Data? = nil) throws -> String {
        let environment = ProcessInfo.processInfo.environment
        let socket = environment["VIBEMIC_TMUX_SOCKET"] ?? "vibemic"
        return try runTool(environment["VIBEMIC_TMUX"] ?? "tmux", ["-L", socket] + args,
                           input: input)
    }

    static func active() throws -> TmuxPane {
        let rows = try tmux(["list-clients", "-F",
            "#{pane_id}|#{pane_pid}|#{pane_current_command}|#{client_pid}|#{pane_in_mode}|#{client_flags}"])
            .split(separator: "\n")
        guard rows.count == 1 else {
            throw BridgeError("Use one attached client on the VibeMic tmux server.")
        }
        let fields = rows[0].split(separator: "|")
        guard fields.count == 6, fields[0].first == "%", Int(fields[0].dropFirst()) != nil,
              Int(fields[1]) != nil, ["codex", "claude"].contains(String(fields[2])),
              Int(fields[3]) != nil, fields[4] == "0" else {
            throw BridgeError("The active tmux pane must be running Codex CLI or Claude Code.")
        }
        let flags = fields[5].split(separator: ",")
        guard flags.contains("focused"), !flags.contains("read-only") else {
            throw BridgeError("Focus the writable VibeMic tmux client.")
        }
        return TmuxPane(id: String(fields[0]), pid: String(fields[1]),
                        command: String(fields[2]), client: String(fields[3]))
    }

    func paste(_ text: String) throws {
        guard try Self.active() == self else { throw BridgeError("The terminal pane changed.") }
        // A single line with printable characters cannot inject Enter or terminal controls.
        let line = text.split(whereSeparator: \.isNewline).joined(separator: " ")
            .unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
        let literal = String(String.UnicodeScalarView(line))
        guard !literal.isEmpty else { return }

        let buffer = "vibemic-\(UUID().uuidString)"
        let condition = "#{&&:#{window_active},#{&&:#{pane_active},#{&&:#{!:#{pane_in_mode}},"
            + "#{&&:#{==:#{pane_pid},\(pid)},#{==:#{pane_current_command},\(command)}}}}}"
        _ = try Self.tmux(["load-buffer", "-b", buffer, "-"], input: Data(literal.utf8))
        let result: String
        do {
            result = try Self.tmux([
                "if-shell", "-F", "-t", id, condition,
                "paste-buffer -p -d -b \(buffer) -t \(id)",
                "delete-buffer -b \(buffer) ; display-message -p changed"
            ])
        } catch {
            _ = try? Self.tmux(["delete-buffer", "-b", buffer])
            throw error
        }
        if result.contains("changed") { throw BridgeError("The terminal pane changed.") }
    }
}

struct Destination {
    let pid: pid_t
    let window: AXUIElement
    let title: String?
    let field: AXUIElement
    let pane: TmuxPane?

    static func focused() throws -> Destination {
        guard let app = NSWorkspace.shared.frontmostApplication, let bundle = app.bundleIdentifier
        else { throw BridgeError("No target application is focused.") }
        let terminal = terminalApps.contains(bundle)
        guard desktopApps.contains(bundle) || terminal else {
            throw BridgeError("Focus Claude, Codex, or their tmux pane.")
        }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        guard let window = axElement(element, kAXFocusedWindowAttribute),
              let field = axElement(element, kAXFocusedUIElementAttribute) ?? (terminal ? window : nil) else {
            throw BridgeError("Focus the prompt field before holding PTT.")
        }
        if !terminal {
            let role = attribute(field, kAXRoleAttribute) as? String
            guard role == kAXTextAreaRole || role == kAXTextFieldRole else {
                throw BridgeError("Focus the prompt field before holding PTT.")
            }
        }
        return try Destination(pid: app.processIdentifier, window: window,
                               title: terminal ? nil : attribute(window, kAXTitleAttribute) as? String,
                               field: field,
                               pane: terminal ? TmuxPane.active() : nil)
    }

    func insert(_ text: String) throws {
        let current = try Self.focused()
        guard current.pid == pid, CFEqual(current.window, window),
              current.title == title, CFEqual(current.field, field), current.pane == pane else {
            throw BridgeError("Focus changed while dictating. Draft insertion was cancelled.")
        }
        if let pane {
            try pane.paste(text)
            return
        }
        var writable: DarwinBoolean = false
        if AXUIElementIsAttributeSettable(field, kAXSelectedTextAttribute as CFString, &writable)
            == .success, writable.boolValue,
           AXUIElementSetAttributeValue(field, kAXSelectedTextAttribute as CFString, text as CFString)
            == .success {
            return
        }

        let pasteboard = NSPasteboard.general
        let previous = pasteboard.pasteboardItems?.map { item in
            item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
        } ?? []
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: false) else {
            throw BridgeError("Could not create the desktop paste event.")
        }
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        let change = pasteboard.changeCount
        for event in [down, up] {
            event.flags = .maskCommand
            event.postToPid(pid)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(500)) {
            guard pasteboard.changeCount == change else { return }
            pasteboard.clearContents()
            let restored = previous.map { values in
                let item = NSPasteboardItem()
                for (type, data) in values { item.setData(data, forType: type) }
                return item
            }
            pasteboard.writeObjects(restored)
        }
    }
}
