import AppKit
import ApplicationServices
import Security

struct ApprovalTarget {
    private let pid: pid_t
    private let window: AXUIElement
    private let field: AXUIElement
    private let document: URL
    private let text: String
    private let chatGPTComposer: Bool

    private static let lifetime = 0.7
    private static let chatGPTEditorLabels: Set<String> = ["Ask ChatGPT", "Спросить ChatGPT"]
    private static let sendLabels: Set<String> = ["Send", "Отправить"]

    static func focused() -> ApprovalTarget? {
        guard let app = NSWorkspace.shared.frontmostApplication,
              let bundle = app.bundleIdentifier else { return nil }
        let pid = app.processIdentifier
        guard supports(app) else { return nil }
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, 0.15)
        guard let field = axElement(element, kAXFocusedUIElementAttribute)
                ?? axElement(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute) else { return nil }
        var fieldPID: pid_t = 0
        guard AXUIElementGetPid(field, &fieldPID) == .success, fieldPID == pid,
              let window = axElement(element, kAXFocusedWindowAttribute)
                ?? axElement(field, kAXWindowAttribute),
              attribute(field, kAXEnabledAttribute) as? Bool != false,
              attribute(field, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole else { return nil }
        let role = attribute(field, kAXRoleAttribute) as? String
        let chatGPTComposer = bundle == "com.openai.codex" &&
            (role == kAXTextAreaRole || role == kAXTextFieldRole) &&
            [kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute].contains { name in
                guard let label = attribute(field, name) as? String else { return false }
                return chatGPTEditorLabels.contains(label)
            }
        guard chatGPTComposer || attribute(field, kAXSelectedTextRangeAttribute) != nil,
              let text = attribute(field, kAXValueAttribute) as? String,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let document = documentContaining(field, in: window, bundle: bundle) else { return nil }
        return ApprovalTarget(pid: pid, window: window, field: field, document: document, text: text,
                              chatGPTComposer: chatGPTComposer)
    }

    func submit(before deadline: TimeInterval) -> Bool {
        let send = chatGPTComposer ? chatGPTSendButton(before: deadline) : nil
        guard ProcessInfo.processInfo.systemUptime < deadline,
              let current = Self.focused(), current.pid == pid, current.document == document,
              CFEqual(current.window, window), CFEqual(current.field, field), current.text == text,
              current.chatGPTComposer == chatGPTComposer,
              ProcessInfo.processInfo.systemUptime < deadline,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return false }
        if chatGPTComposer {
            guard let send else { return false }
            return AXUIElementPerformAction(send, kAXPressAction as CFString) == .success
        }
        guard let source = CGEventSource(stateID: .privateState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: false) else {
            return false
        }
        for event in [down, up] {
            event.flags = []
            event.post(tap: .cghidEventTap)
        }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
        return true
    }

    private func chatGPTSendButton(before deadline: TimeInterval) -> AXUIElement? {
        var composer = field
        for _ in 0..<7 {
            guard ProcessInfo.processInfo.systemUptime < deadline,
                  let parent = axElement(composer, kAXParentAttribute),
                  !CFEqual(parent, window),
                  attribute(parent, kAXRoleAttribute) as? String != "AXWebArea" else { return nil }
            composer = parent
            if let button = enabledButton(in: composer, labels: Self.sendLabels) { return button }
        }
        return nil
    }

    static func run() {
        let deadline = ProcessInfo.processInfo.systemUptime + lifetime
        guard AXIsProcessTrusted(), let target = focused() else {
            print("false")
            return
        }
        print("true")
        fflush(stdout)
        let commit = readLine() == "commit" && target.submit(before: deadline)
        print(commit ? "true" : "false")
    }

    static func supports(_ app: NSRunningApplication) -> Bool {
        let bundle = app.bundleIdentifier ?? ""
        let team: String
        switch bundle {
        case "com.openai.codex": team = "2DC432GLL2"
        case "com.anthropic.claudefordesktop": team = "Q6L2SF6YDW"
        default: return false
        }
        return signed(pid: app.processIdentifier, bundle: bundle, team: team)
    }

    private static func signed(pid: pid_t, bundle: String, team: String) -> Bool {
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
        let requirementText = "anchor apple generic and identifier \"\(bundle)\" and certificate leaf[subject.OU] = \"\(team)\""
        var code: SecCode?
        var requirement: SecRequirement?
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
              let code,
              SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess,
              let requirement else { return false }
        return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
    }

    static func documentContaining(_ field: AXUIElement, in window: AXUIElement, bundle: String) -> URL? {
        var element = field
        var document: URL?
        for _ in 0..<64 {
            if CFEqual(element, window) { return document }
            if attribute(element, kAXRoleAttribute) as? String == "AXWebArea" {
                // Keep submission in the app's own editor, outside nested browser views.
                guard document == nil, let url = attribute(element, kAXURLAttribute) as? URL,
                      isAgentDocument(url, bundle: bundle) else { return nil }
                document = url
            }
            guard let parent = axElement(element, kAXParentAttribute) else { return nil }
            element = parent
        }
        return nil
    }

    private static func isAgentDocument(_ url: URL, bundle: String) -> Bool {
        if bundle == "com.openai.codex" {
            return url.scheme == "app" && url.host == "-"
        }
        return (url.scheme == "app" && url.host == "localhost") ||
               (url.scheme == "https" && url.host == "claude.ai")
    }
}
