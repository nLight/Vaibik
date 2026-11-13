import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pcm16Levels, pcm16Wav } from '../ui/src/pcm.mjs';

function sine(amplitude, samples = 16000) {
    const pcm = new Uint8Array(samples * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < samples; i++) {
        view.setInt16(i * 2, Math.round(amplitude * Math.sin(2 * Math.PI * 440 * i / 16000)), true);
    }
    return pcm;
}

test('pcm levels report peak, rms, dc and clipping in dBFS', () => {
    const levels = pcm16Levels(sine(16384));
    assert.ok(Math.abs(levels.peak - -6.0206) < 0.05, `peak ${levels.peak}`);
    assert.ok(Math.abs(levels.rms - -9.0309) < 0.1, `rms ${levels.rms}`);
    assert.ok(Math.abs(levels.dc) < 1, `dc ${levels.dc}`);
    assert.equal(levels.clipped, 0);
    const hot = pcm16Levels(sine(32767));
    assert.ok(hot.clipped > 0);
    assert.ok(hot.peak > -0.01);
    const silence = pcm16Levels(new Uint8Array(3200));
    assert.equal(silence.peak, -Infinity);
    assert.equal(silence.clipped, 0);
});

test('pcm16Wav wraps samples in a canonical 16-bit mono RIFF header', () => {
    const pcm = sine(1000, 800);
    const wav = pcm16Wav(pcm, 16000);
    const view = new DataView(wav.buffer);
    const tag = (offset, length) => String.fromCharCode(...wav.subarray(offset, offset + length));
    assert.equal(wav.length, 44 + pcm.length);
    assert.equal(tag(0, 4), 'RIFF');
    assert.equal(tag(8, 4), 'WAVE');
    assert.equal(tag(12, 4), 'fmt ');
    assert.equal(tag(36, 4), 'data');
    assert.equal(view.getUint32(4, true), wav.length - 8);
    assert.equal(view.getUint32(16, true), 16);
    assert.equal(view.getUint16(20, true), 1);
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint32(24, true), 16000);
    assert.equal(view.getUint32(28, true), 32000);
    assert.equal(view.getUint16(32, true), 2);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(view.getUint32(40, true), pcm.length);
    assert.deepEqual(wav.subarray(44), pcm);
});