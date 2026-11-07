#!/usr/bin/env python3
"""Request a three-second VibeMic PDM probe capture and save it as WAV."""

import argparse
import math
import struct
import sys
import wave

SAMPLE_RATE = 16_000
SECONDS = 3
PCM_BYTES = 2 * SAMPLE_RATE * SECONDS


def dbfs(level: float) -> str:
    return f"{20 * math.log10(level / 32768):.1f}" if level else "-inf"


def capture(port: str, destination: str) -> None:
    try:
        import serial
    except ImportError:
        raise SystemExit("Install pyserial: python3 -m pip install pyserial") from None

    with serial.Serial(port, 115200, timeout=15, write_timeout=3) as device:
        device.reset_input_buffer()
        print(f"Recording {SECONDS} seconds now. Speak into the microphone.", flush=True)
        device.write(b"R")
        tag = device.read(4)
        if tag == b"VERR":
            raise RuntimeError("The board reported a PDM capture error.")
        if tag != b"VMIC":
            raise RuntimeError(f"No probe response (received {tag!r}); check firmware and port.")
        pcm = device.read(PCM_BYTES)
        if len(pcm) != PCM_BYTES:
            raise RuntimeError(f"Incomplete clip: {len(pcm)} of {PCM_BYTES} bytes.")

    peak = clipped = total = squares = 0
    for (sample,) in struct.iter_unpack("<h", pcm):
        magnitude = abs(sample)
        peak = max(peak, magnitude)
        clipped += magnitude >= 32767
        total += sample
        squares += sample * sample
    count = len(pcm) // 2
    mean = total / count
    rms = math.sqrt(max(0.0, squares / count - mean * mean))
    with wave.open(destination, "wb") as output:
        output.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
        output.writeframes(pcm)
    print(f"{destination}: peak {dbfs(peak)} dBFS, AC RMS {dbfs(rms)} dBFS, "
          f"DC offset {mean:.1f} counts, {clipped} samples at full scale")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("port", help="CDC device, e.g. /dev/cu.usbmodem123")
    parser.add_argument("output", help="Path to the WAV file")
    args = parser.parse_args()
    try:
        capture(args.port, args.output)
    except (OSError, RuntimeError) as error:
        sys.exit(str(error))
