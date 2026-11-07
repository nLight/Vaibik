'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: settle } = require('node:timers/promises');

function event(type, details) {
    return Object.assign(new Event(type), details);
}

function device(overrides = {}) {
    return Object.assign(new EventTarget(), {
        vendorId: 0x1209, productId: 0x0003, collections: [{ usagePage: 0xff31, usage: 1 }],
        opened: false, opens: 0,
        async open() { this.opens++; this.opened = true; }
    }, overrides);
}

function report(device, value, version = 1, extension = []) {
    const data = new DataView(new ArrayBuffer(8));
    data.setUint8(0, version);
    data.setUint8(1, value);
    new Uint8Array(data.buffer).set(extension, 2);
    device.dispatchEvent(event('inputreport', { data, reportId: 0 }));
}

async function scenario(devices) {
    const { watchPtt } = await import('../ui/ptt-hid.mjs');
    const hid = Object.assign(new EventTarget(), { devices, async getDevices() { return this.devices; } });
    const calls = [];
    const listener = watchPtt(hid, {
        connection: connected => calls.push(['connection', connected]),
        button: (down, stats) => calls.push(stats ? ['button', down, stats] : ['button', down]),
        error: error => calls.push(['error', error])
    });
    return { hid, calls, listener };
}

test('USB reconnect opens the replacement and clears the previous PTT state', async () => {
    const first = device();
    const second = device();
    const { hid, calls, listener } = await scenario([first, device({ collections: [] })]);
    await listener.scan();
    report(first, 1);
    report(first, 1);
    hid.devices = [];
    hid.dispatchEvent(event('disconnect', { device: first }));
    report(first, 0);
    hid.devices = [second];
    hid.dispatchEvent(event('connect', { device: second }));
    hid.dispatchEvent(event('connect', { device: second }));
    await settle();
    report(second, 1, 2);
    report(second, 1);
    report(second, 0);
    assert.equal(first.opens, 1);
    assert.equal(second.opens, 1);
    assert.deepEqual(calls, [['connection', true], ['button', true], ['connection', false],
        ['connection', true], ['button', true], ['button', false]]);
});

test('late completion of a disconnected open does not take over the replacement', async () => {
    let finish;
    const first = device({ open() { return new Promise(resolve => { finish = resolve; }); } });
    const second = device();
    const { hid, calls, listener } = await scenario([first]);
    const started = listener.scan();
    await settle();
    hid.devices = [second];
    hid.dispatchEvent(event('disconnect', { device: first }));
    hid.dispatchEvent(event('connect', { device: second }));
    await settle();
    finish();
    await started;
    report(first, 1);
    report(second, 1);
    assert.deepEqual(calls, [['connection', true], ['button', true]]);
});

test('release metrics accompany only the corresponding PTT up and preserve legacy reports', async () => {
    const first = device();
    const { calls, listener } = await scenario([first]);
    await listener.scan();
    const timeout = [2, 88, 0x23, 0x01, 0x02, 0x01];
    report(first, 1, 1, timeout);
    report(first, 0, 1, timeout);
    report(first, 0, 1, timeout);
    report(first, 1);
    report(first, 0);
    report(first, 1);
    report(first, 0, 1, [99, 80, 5, 0, 0, 0]);
    report(first, 1);
    report(first, 0, 1, [4, 0, 5, 0, 1, 0]);
    assert.deepEqual(calls, [
        ['connection', true], ['button', true],
        ['button', false, { end: 'radioTimeout', weakestDbm: -88, silentMs: 291, usbErrors: 258 }],
        ['button', true], ['button', false], ['button', true], ['button', false], ['button', true],
        ['button', false, { end: 'usbStopped', weakestDbm: null, silentMs: 5, usbErrors: 1 }]
    ]);
});
