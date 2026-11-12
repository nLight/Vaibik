import AppKit
import ApplicationServices

private let terminalApps = [
    "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty",
    "com.superlogical.rex", "net.kovidgoyal.kitty", "com.github.wez.wezterm", "dev.warp.Warp-Stable"
]

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func axElement(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else {
        return nil
    }
    return (value as! AXUIElement)
}

func enabledButton(in root: AXUIElement, labels: Set<String>, includeToggles: Bool = false) -> AXUIElement? {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var index = 0
    let limit = 160
    while index < queue.count {
        let (element, depth) = queue[index]
        index += 1
        let role = attribute(element, kAXRoleAttribute) as? String
        let isButton = role == kAXButtonRole || (includeToggles && role == kAXCheckBoxRole &&
            attribute(element, kAXSubroleAttribute) as? String == "AXToggleButton")
        if isButton && attribute(element, kAXEnabledAttribute) as? Bool != false {
            let title = attribute(element, kAXTitleAttribute) as? String ?? ""
            let description = attribute(element, kAXDescriptionAttribute) as? String ?? ""
            if labels.contains(title) || labels.contains(description) { return element }
        }
        if depth < 6 && role != "AXWebArea" && queue.count < limit,
           let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
            queue.append(contentsOf: children.prefix(limit - queue.count).map { ($0, depth + 1) })
        }
    }
    return nil
}

private func literalInput(_ text: String) -> String {
    // A focused editor can be a terminal, where pasted line breaks may submit commands.
    let line = text.split(whereSeparator: \.isNewline).joined(separator: " ")
    let printable = line.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
    return String(String.UnicodeScalarView(printable))
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
        let literal = literalInput(text)
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
        let focusError = BridgeError("Focus the input field in the target app before holding PTT.")
        guard let app = NSWorkspace.shared.frontmostApplication,
              app.bundleIdentifier != "dev.vibemic.desktop",
              app.processIdentifier != getppid() else { throw focusError }
        let terminal = terminalApps.contains(app.bundleIdentifier ?? "")
        let element = AXUIElementCreateApplication(app.processIdentifier)
        // Electron exposes its editor after assistive technology requests the web tree.
        if attribute(element, "AXManualAccessibility") as? Bool != true,
           AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString,
                                       kCFBooleanTrue) == .success {
            // Electron debounces this request for two seconds on recent macOS.
            let deadline = ProcessInfo.processInfo.systemUptime + 2.5
            while ProcessInfo.processInfo.systemUptime < deadline {
                if let field = axElement(element, kAXFocusedUIElementAttribute),
                   attribute(field, kAXSelectedTextRangeAttribute) != nil {
                    break
                }
                Thread.sleep(forTimeInterval: 0.025)
            }
        }
        let focusedField = axElement(element, kAXFocusedUIElementAttribute)
            ?? axElement(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute)
        guard let window = axElement(element, kAXFocusedWindowAttribute)
                ?? focusedField.flatMap({ axElement($0, kAXWindowAttribute) }),
              let field = focusedField ?? (terminal ? window : nil) else { throw focusError }
        var fieldPID: pid_t = 0
        guard AXUIElementGetPid(field, &fieldPID) == .success,
              fieldPID == app.processIdentifier,
              attribute(field, kAXEnabledAttribute) as? Bool != false else { throw focusError }
        if attribute(field, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole {
            throw BridgeError("Protected input. Focus a regular text field.")
        }
        let pane = terminal ? try? TmuxPane.active() : nil
        return Destination(pid: app.processIdentifier, window: window,
                           title: pane == nil ? attribute(window, kAXTitleAttribute) as? String : nil,
                           field: field, pane: pane)
    }

    private func checkFocus() throws {
        guard let current = try? Self.focused(), current.pid == pid, CFEqual(current.window, window),
              current.title == title, CFEqual(current.field, field), current.pane == pane else {
            throw BridgeError("Focus changed while dictating. Draft insertion was cancelled.")
        }
    }

    private func isWebEditor() -> Bool {
        var element = field
        for _ in 0..<32 {
            if attribute(element, kAXRoleAttribute) as? String == "AXWebArea" {
                return true
            }
            guard !CFEqual(element, window),
                  let parent = axElement(element, kAXParentAttribute) else { return false }
            element = parent
        }
        return true
    }

    func insert(_ text: String) throws {
        try checkFocus()
        if let pane {
            try pane.paste(text)
            return
        }
        let literal = literalInput(text)
        guard !literal.isEmpty else { return }
        var writable: DarwinBoolean = false
        if !isWebEditor(),
           AXUIElementIsAttributeSettable(field, kAXSelectedTextAttribute as CFString, &writable)
            == .success, writable.boolValue,
           AXUIElementSetAttributeValue(field, kAXSelectedTextAttribute as CFString, literal as CFString)
            == .success {
            return
        }
        // Paste through the editor so web inputs also update their application state.
        let pasteboard = NSPasteboard.general
        let previous = pasteboard.pasteboardItems?.map { item in
            item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
        } ?? []
        guard let source = CGEventSource(stateID: .privateState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else {
            throw BridgeError("Could not create the desktop paste event.")
        }
        try checkFocus()
        pasteboard.clearContents()
        pasteboard.setString(literal, forType: .string)
        let change = pasteboard.changeCount
        for event in [down, up] {
            event.flags = .maskCommand
            event.post(tap: .cghidEventTap)
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
