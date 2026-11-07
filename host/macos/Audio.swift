import AVFoundation
import Foundation

func audioInputs() -> [AVCaptureDevice] {
    if #available(macOS 14.0, *) {
        return AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified
        ).devices
    }
    return AVCaptureDevice.devices(for: .audio)
}

final class Clip: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    static let sampleRate = 16_000
    private let samples = DispatchQueue(label: "dev.vibemic.samples")
    private let session = AVCaptureSession()
    private var pcm = Data()
    private var badFormat = false

    // Start and stop on the same capture queue, separate from the sample delegate.
    func start(device: AVCaptureDevice) throws {
        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureAudioDataOutput()
        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: Self.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ]
        output.setSampleBufferDelegate(self, queue: samples)
        guard session.canAddInput(input), session.canAddOutput(output) else {
            throw BridgeError("Cannot open the selected audio input.")
        }
        session.addInput(input)
        session.addOutput(output)
        session.startRunning()
        guard session.isRunning else { throw BridgeError("The audio input did not start.") }
    }

    func captureOutput(
        _ output: AVCaptureOutput, didOutput buffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard pcm.count < 120 * 2 * Self.sampleRate else { return }
        guard let description = CMSampleBufferGetFormatDescription(buffer),
              let format = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee,
              format.mFormatID == kAudioFormatLinearPCM,
              format.mSampleRate == Double(Self.sampleRate),
              format.mChannelsPerFrame == 1,
              format.mBitsPerChannel == 16,
              format.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0,
              format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
              let block = CMSampleBufferGetDataBuffer(buffer) else {
            badFormat = true
            return
        }

        var chunk = Data(count: CMBlockBufferGetDataLength(block))
        guard !chunk.isEmpty else { return }
        let status = chunk.withUnsafeMutableBytes { bytes in
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: bytes.count,
                                       destination: bytes.baseAddress!)
        }
        if status == noErr { pcm.append(chunk) }
    }

    func stop() throws -> Data {
        guard session.isRunning else { throw BridgeError("Recording was unavailable.") }
        session.stopRunning()
        return try samples.sync {
            if badFormat { throw BridgeError("The microphone did not provide 16 kHz mono PCM.") }
            guard pcm.count >= Self.sampleRate / 4, pcm.contains(where: { $0 != 0 }) else {
                throw BridgeError("No speech audio was captured.")
            }
            return wave(pcm)
        }
    }

    private func wave(_ pcm: Data) -> Data {
        var wav = Data("RIFF".utf8)
        func appendLE<T: FixedWidthInteger>(_ value: T) {
            var le = value.littleEndian
            withUnsafeBytes(of: &le) { wav.append(contentsOf: $0) }
        }
        appendLE(UInt32(pcm.count + 36))
        wav.append(contentsOf: "WAVEfmt ".utf8)
        appendLE(UInt32(16))
        appendLE(UInt16(1))
        appendLE(UInt16(1))
        appendLE(UInt32(Self.sampleRate))
        appendLE(UInt32(2 * Self.sampleRate))
        appendLE(UInt16(2))
        appendLE(UInt16(16))
        wav.append(contentsOf: "data".utf8)
        appendLE(UInt32(pcm.count))
        wav.append(pcm)
        return wav
    }
}
