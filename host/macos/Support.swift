import Foundation

struct BridgeError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

func runTool(_ name: String, _ arguments: [String], input: Data? = nil,
             capture: Bool = true) throws -> String {
    let process = Process()
    let output = Pipe()
    let stdin = input.map { _ in Pipe() }
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = [name] + arguments
    process.standardInput = stdin ?? FileHandle.nullDevice
    process.standardOutput = capture ? output : FileHandle.nullDevice
    try process.run()
    if let input, let writer = stdin?.fileHandleForWriting {
        try writer.write(contentsOf: input)
        try writer.close()
    }
    let data = capture ? output.fileHandleForReading.readDataToEndOfFile() : Data()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw BridgeError("\(name) exited with status \(process.terminationStatus).")
    }
    return String(decoding: data, as: UTF8.self)
}
