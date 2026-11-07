'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function serialFixture(response) {
    let incoming;
    const calls = [];
    const port = {
        readable: new ReadableStream({ start(controller) { incoming = controller; } }),
        writable: new WritableStream({ write(value) {
            assert.deepEqual([...value], [0x52]);
            response?.(incoming);
        } }),
        async open(options) { calls.push(['open', options.baudRate]); },
        async setSignals(signals) { calls.push(['dtr', signals.dataTerminalReady]); },
        async close() {
            assert.equal(port.readable.locked, false);
            assert.equal(port.writable.locked, false);
            calls.push(['close']);
        }
    };
    return { calls, serial: { async requestPort(options) {
        assert.deepEqual(options.filters, [{ usbVendorId: 0x1209, usbProductId: 0x0002 }]);
        return port;
    } } };
}

test('probe preserves fragmented PCM and reports levels using the common WAV encoder', async () => {
    const { capturePdmProbe } = await import('../ui/pdm-probe.mjs');
    const pcm = new Uint8Array(96000);
    const view = new DataView(pcm.buffer);
    for (let index = 0; index < 48000; index++) view.setInt16(index * 2, index % 2 ? 2000 : 0, true);
    const response = new Uint8Array(96004);
    response.set(new TextEncoder().encode('VMIC'));
    response.set(pcm, 4);
    const { calls, serial } = serialFixture(incoming => {
        for (let index = 0; index < response.length; index += 53) incoming.enqueue(response.slice(index, index + 53));
    });
    const stages = [];
    const result = await capturePdmProbe(serial, { signal: new AbortController().signal, stage: value => stages.push(value) });
    assert.equal(result.wav.length, 96044);
    assert.deepEqual(result.wav.subarray(44), pcm);
    assert.equal(new DataView(result.wav.buffer).getUint32(24, true), 16000);
    assert.deepEqual(stages, ['recording', 'receiving']);
    assert.equal(result.levels.dc, 1000);
    assert.equal(result.levels.clipped, 0);
    assert.ok(Math.abs(result.levels.rms - 20 * Math.log10(1000 / 32768)) < 1e-10);
    assert.deepEqual(calls, [['open', 115200], ['dtr', true], ['close']]);
});

test('probe errors and incomplete clips close the port and release both stream locks', async () => {
    const { capturePdmProbe } = await import('../ui/pdm-probe.mjs');
    for (const [tag, message] of [['VERR', /ошибке PDM/], ['VMIC', /прервалась/], ['oops', /не распознан/]]) {
        const { calls, serial } = serialFixture(incoming => {
            incoming.enqueue(new TextEncoder().encode(tag));
            incoming.close();
        });
        await assert.rejects(capturePdmProbe(serial, { signal: new AbortController().signal, stage() {} }), message);
        assert.deepEqual(calls.at(-1), ['close']);
    }
});

test('cancellation drains the device response before reopening for a fresh clip', async () => {
    const { capturePdmProbe } = await import('../ui/pdm-probe.mjs');
    const controller = new AbortController();
    let pending = new Uint8Array(0);
    let requests = 0;
    let closed = 0;
    const serial = { async requestPort() {
        let resume;
        let cancelled = false;
        const readable = new ReadableStream({
            async pull(incoming) {
                if (!pending.length) await new Promise(resolve => { resume = resolve; });
                if (cancelled) return;
                incoming.enqueue(pending.slice(0, 137));
                pending = pending.slice(137);
            },
            cancel() {
                cancelled = true;
                resume?.();
            }
        });
        const writable = new WritableStream({ write(command) {
            assert.deepEqual([...command], [0x52]);
            assert.equal(pending.length, 0, 'the previous response still occupies the device FIFO');
            requests++;
            pending = new Uint8Array(96004);
            pending.set(new TextEncoder().encode('VMIC'));
            const view = new DataView(pending.buffer);
            for (let index = 4; index < pending.length; index += 2) view.setInt16(index, requests * 1000, true);
            resume?.();
        } });
        return { readable, writable, async open() {}, async setSignals() {}, async close() {
            assert.equal(readable.locked, false);
            assert.equal(writable.locked, false);
            closed++;
        } };
    } };
    await assert.rejects(capturePdmProbe(serial, { signal: controller.signal,
        stage() { controller.abort(); } }), /отменена/);
    assert.equal(closed, 1);
    assert.equal(pending.length, 0, 'cancelling closed the port before the device finished sending');
    const result = await capturePdmProbe(serial, { signal: new AbortController().signal, stage() {} });
    assert.equal(result.levels.dc, 2000);
    assert.equal(result.wav.length, 96044);
    assert.equal(closed, 2);
    assert.equal(pending.length, 0);
});

test('an unresponsive probe remains bounded when cancellation is draining', async context => {
    const { capturePdmProbe } = await import('../ui/pdm-probe.mjs');
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    const { calls, serial } = serialFixture();
    let recording;
    const started = new Promise(resolve => { recording = resolve; });
    const capture = capturePdmProbe(serial, { signal: controller.signal, stage() {
        controller.abort();
        recording();
    } });
    await started;
    context.mock.timers.tick(15000);
    await assert.rejects(capture, /15 секунд.*Перезапустите/);
    assert.deepEqual(calls.at(-1), ['close']);
});

test('PCM levels distinguish silence, DC and both clipping endpoints', async () => {
    const { pcm16Levels } = await import('../ui/pcm.mjs');
    assert.deepEqual(pcm16Levels(new Uint8Array(4)), { peak: -Infinity, rms: -Infinity, dc: 0, clipped: 0 });
    const pcm = new Uint8Array(4);
    new DataView(pcm.buffer).setInt16(0, -32768, true);
    new DataView(pcm.buffer).setInt16(2, 32767, true);
    assert.equal(pcm16Levels(pcm).clipped, 2);
});
