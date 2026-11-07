import AppKit
import ApplicationServices
import Foundation

private func reply(_ result: [String: Any]) {
    guard let encoded = try? JSONSerialization.data(withJSONObject: result) else { return }
    FileHandle.standardOutput.write(encoded + Data([0x0a]))
}

do {
    guard AXIsProcessTrusted() else {
        throw BridgeError("Разрешите VibeMic доступ в System Settings → Privacy & Security → Accessibility.")
    }
    let target = try Destination.focused()
    reply(["ok": true])
    if let command = readLine() {
        let text = try JSONDecoder().decode(String.self, from: Data(command.utf8))
        if !text.isEmpty {
            try target.insert(text)
            // The clipboard fallback restores the prior clipboard on this run loop.
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.55))
        }
        reply(["ok": true])
    }
} catch {
    reply(["ok": false, "error": error.localizedDescription])
    exit(1)
}
