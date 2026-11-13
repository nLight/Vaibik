export function pcm16Wav(pcm, rate = 16000) {
    const wav = new Uint8Array(44 + pcm.length);
    const header = new DataView(wav.buffer);
    wav.set(new TextEncoder().encode('RIFF'), 0);
    wav.set(new TextEncoder().encode('WAVEfmt '), 8);
    wav.set(new TextEncoder().encode('data'), 36);
    header.setUint32(4, wav.length - 8, true);
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 1, true);
    header.setUint32(24, rate, true);
    header.setUint32(28, rate * 2, true);
    header.setUint16(32, 2, true);
    header.setUint16(34, 16, true);
    header.setUint32(40, pcm.length, true);
    wav.set(pcm, 44);
    return wav;
}

export function pcm16Levels(pcm) {
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const count = pcm.length / 2;
    let peak = 0, total = 0, squares = 0, clipped = 0;
    for (let offset = 0; offset < pcm.length; offset += 2) {
        const sample = view.getInt16(offset, true);
        const magnitude = Math.abs(sample);
        peak = Math.max(peak, magnitude);
        total += sample;
        squares += sample * sample;
        if (magnitude >= 32767) clipped++;
    }
    const dc = total / count;
    const rms = Math.sqrt(Math.max(0, squares / count - dc * dc));
    const dbfs = value => value ? 20 * Math.log10(value / 32768) : -Infinity;
    return { peak: dbfs(peak), rms: dbfs(rms), dc, clipped };
}
