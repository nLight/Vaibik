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
        connection: (connected, transport) => calls.push(transport === 'usb'
            ? ['connection', connected, transport] : ['connection', connected]),
        button: (down, stats) => calls.push(stats ? ['button', down, stats] : ['button', down]),
        approval: (kind, token) => calls.push(['approval', kind, token]),
        battery: value => calls.push(['battery', value]),
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

test('battery telemetry preserves a held PTT and ignores stale and malformed reports', async () => {
    const first = device();
    const stale = device();
    const { calls, listener } = await scenario([first]);
    await listener.scan();
    report(first, 1);
    report(first, 4, 1, [1, 0, 10, 15, 0, 0]); // 3850 mV.
    report(first, 4, 1, [7, 0, 10, 15, 0, 0]);
    report(stale, 4, 1, [1, 0, 10, 15, 0, 0]);
    report(first, 0);
    assert.deepEqual(calls, [['connection', true], ['button', true],
        ['battery', { millivolts: 3850, usbPower: false, percent: 50 }], ['button', false]]);
});

test('USB takes priority after the radio press ends and unplugging restores the dongle', async () => {
    const radio = device({ productName: 'PTT Dictation Mic' });
    const wired = device({ productName: 'PTT Dictation Mic (USB)' });
    const { hid, calls, listener } = await scenario([radio]);
    await listener.scan();
    report(radio, 1);
    hid.devices = [radio, wired];
    hid.dispatchEvent(event('connect', { device: wired }));
    await settle();
    assert.equal(wired.opens, 0);
    report(radio, 0);
    await settle();
    report(radio, 1); // Stale reports from the inactive transport are ignored.
    report(wired, 1);
    hid.devices = [radio];
    hid.dispatchEvent(event('disconnect', { device: wired }));
    report(wired, 0);
    await settle();
    report(radio, 1);
    report(radio, 0);
    assert.deepEqual(calls, [
        ['connection', true], ['button', true], ['button', false],
        ['connection', true, 'usb'], ['button', true],
        ['connection', false], ['connection', true], ['button', true], ['button', false]
    ]);
});

test('startup with both interfaces attaches only the wired microphone', async () => {
    const radio = device({ productName: 'PTT Dictation Mic' });
    const wired = device({ productName: 'PTT Dictation Mic (USB)' });
    const { calls, listener } = await scenario([radio, wired]);
    await listener.scan();
    assert.equal(radio.opens, 0);
    assert.equal(wired.opens, 1);
    assert.deepEqual(calls, [['connection', true, 'usb']]);
    const { preferredPttDevice } = await import('../ui/ptt-hid.mjs');
    const electronDevice = { name: wired.productName };
    assert.equal(preferredPttDevice([{ name: radio.productName }, electronDevice]), electronDevice);
});

test('approval reports carry the same token without changing recording state', async () => {
    const first = device();
    const { calls, listener } = await scenario([first]);
    await listener.scan();
    const token = [0x78, 0x56, 0x34, 0x12, 0, 0];
    report(first, 2, 1, token);
    report(first, 3, 1, token);
    report(first, 1);
    report(first, 2, 1, token);
    report(first, 3, 1, token);
    report(first, 0);
    report(first, 2, 1, [0, 0, 0, 0, 1, 0]);
    assert.deepEqual(calls, [
        ['connection', true],
        ['approval', 'arm', 0x12345678], ['approval', 'commit', 0x12345678],
        ['button', true], ['button', false]
    ]);
});

test('a firmware shortcut is armed only during the current PTT press', async () => {
    const writes = [];
    const first = device({
        collections: [{ usagePage: 0xff31, usage: 1, featureReports: [{ reportId: 0 }] }],
        async sendFeatureReport(id, data) { writes.push([id, ...data]); }
    });
    const keyboard = device({ collections: [{ usagePage: 1, usage: 6 }] });
    const { listener } = await scenario([first, keyboard]);
    await listener.scan();
    assert.equal(keyboard.opens, 0);
    assert.equal(await listener.holdShortcut(), null);
    report(first, 1);
    const finishFirst = await listener.holdShortcut();
    report(first, 0);
    report(first, 1);
    await finishFirst();
    assert.equal(await listener.holdShortcut('claude', 0), null);
    const cancelSecond = await listener.holdShortcut('claude', 0x07);
    await cancelSecond();
    await listener.holdShortcut('claude', 0x0a);
    assert.deepEqual(writes, [[0, 1], [0, 3], [0, 0], [0, 4]]);
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
