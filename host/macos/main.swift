import AppKit
import ApplicationServices
import AVFoundation
import Carbon.HIToolbox
import Foundation

private func transcribe(_ file: URL, directory: URL) throws -> String {
    let environment = ProcessInfo.processInfo.environment
    var args = [
        file.path, "--model", environment["VIBEMIC_MODEL"] ?? "base",
        "--device", "cpu", "--fp16", "False", "--task", "transcribe",
        "--output_format", "txt", "--output_dir", directory.path, "--verbose", "False"
    ]
    if let language = environment["VIBEMIC_LANGUAGE"] {
        args += ["--language", language]
    }
    _ = try runTool(environment["VIBEMIC_WHISPER"] ?? "whisper", args, capture: false)
    let result = directory.appendingPathComponent(file.deletingPathExtension().lastPathComponent + ".txt")
    return try String(contentsOf: result, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
}

private func withTemporaryDirectory<T>(_ body: (URL) throws -> T) throws -> T {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("vibemic-\(UUID())")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                            attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }
    return try body(directory)
}

private func log(_ message: String) {
    FileHandle.standardError.write(Data("VibeMic: \(message)\n".utf8))
}

private final class Bridge {
    private let capture = DispatchQueue(label: "dev.vibemic.capture")
    private var recording: (Clip, Destination)?
    private var releaseTimer: Timer?
    private var processing = false
    private var eventTap: CFMachPort?

    func run() throws {
        let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
            eventsOfInterest: CGEventMask(mask), callback: { _, type, event, info in
                let bridge = Unmanaged<Bridge>.fromOpaque(info!).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    DispatchQueue.main.async { bridge.resumeTap() }
                } else if event.getIntegerValueField(.keyboardEventKeycode) == kVK_F13 {
                    let mods: CGEventFlags = [.maskControl, .maskAlternate, .maskCommand]
                    if type == .keyUp || (event.flags.intersection([mods, .maskShift]) == mods
                        && event.getIntegerValueField(.keyboardEventAutorepeat) == 0) {
                        DispatchQueue.main.async { bridge.ptt(down: type == .keyDown) }
                    }
                }
                return Unmanaged.passUnretained(event)
            }, userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else { throw BridgeError("Cannot listen for PTT. Allow Input Monitoring and relaunch.") }
        eventTap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        log("Ready. Focus Claude or Codex and hold PTT.")
        CFRunLoopRun()
    }

    private func resumeTap() {
        if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
        ptt(down: false)
    }

    private func ptt(down: Bool) {
        if down {
            guard recording == nil, !processing else { return }
            do {
                let target = try Destination.focused()
                let configured = ProcessInfo.processInfo.environment["VIBEMIC_INPUT"]
                    ?? "PTT Dictation Mic"
                let devices = audioInputs().filter { $0.uniqueID == configured || $0.localizedName == configured }
                guard devices.count == 1, let input = devices.first else {
                    throw BridgeError("Connect the VibeMic input or choose its ID with VIBEMIC_INPUT.")
                }
                let clip = Clip()
                recording = (clip, target)
                releaseTimer = Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { [weak self] _ in
                    self?.ptt(down: false)
                }
                capture.async {
                    do {
                        try clip.start(device: input)
                    } catch {
                        log(error.localizedDescription)
                    }
                }
            } catch {
                log(error.localizedDescription)
            }
        } else if let (clip, target) = recording {
            recording = nil
            releaseTimer?.invalidate()
            processing = true
            capture.async {
                let result: Result<String, Error> = Result {
                    let audio = try clip.stop()
                    return try withTemporaryDirectory { directory in
                        let file = directory.appendingPathComponent("speech.wav")
                        try audio.write(to: file)
                        return try transcribe(file, directory: directory)
                    }
                }
                DispatchQueue.main.async {
                    defer { self.processing = false }
                    do {
                        let text = try result.get()
                        if !text.isEmpty { try target.insert(text) }
                    } catch {
                        log(error.localizedDescription)
                    }
                }
            }
        }
    }
}

private func authorizeMicrophone() throws {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return
    case .notDetermined:
        let signal = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .audio) { _ in signal.signal() }
        signal.wait()
        if AVCaptureDevice.authorizationStatus(for: .audio) == .authorized { return }
    default:
        break
    }
    throw BridgeError("Allow VibeMic in Privacy & Security → Microphone.")
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    switch arguments.first {
    case "--list-inputs" where arguments.count == 1:
        for input in audioInputs() { print("\(input.localizedName)\t\(input.uniqueID)") }
    case "--transcribe" where arguments.count == 2:
        print(try withTemporaryDirectory { try transcribe(URL(fileURLWithPath: arguments[1]), directory: $0) })
    case "--check-tmux" where arguments.count == 1:
        let pane = try TmuxPane.active()
        print("\(pane.command) in pane \(pane.id)")
    case "--help", "-h":
        print("Usage: vibemic-bridge [--list-inputs | --transcribe FILE | --check-tmux]")
    case nil:
        try authorizeMicrophone()
        guard CGPreflightListenEventAccess() else {
            _ = CGRequestListenEventAccess()
            throw BridgeError("Allow Input Monitoring for VibeMic or its terminal, then relaunch.")
        }
        guard AXIsProcessTrusted() else {
            throw BridgeError("Allow Accessibility for VibeMic or its terminal, then relaunch.")
        }
        let bridge = Bridge()
        try bridge.run()
    default:
        throw BridgeError("Unknown arguments. Use --help.")
    }
} catch {
    log(error.localizedDescription)
    exit(1)
}
