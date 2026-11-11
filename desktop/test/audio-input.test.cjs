'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

test('automatic capture follows a reconnected Vaibik and explicit inputs report a missing device', async t => {
    const { startCapture } = await import('../ui/audio.js');
    const requests = [];
    let deviceId = 'before-reconnect';
    const mediaDevices = {
        async enumerateDevices() {
            return [{ kind: 'audioinput', deviceId, label: 'PTT Dictation Mic' },
                { kind: 'audioinput', deviceId: 'other-mic', label: 'Other microphone' }];
        },
        async getUserMedia({ audio }) {
            const id = audio.deviceId.exact;
            requests.push(id);
            if (id === 'before-reconnect') deviceId = 'after-reconnect';
            if (id !== deviceId) throw Object.assign(new Error(), { name: 'OverconstrainedError', constraint: 'deviceId' });
            return { active: true, getTracks: () => [{ stop() {} }] };
        }
    };
    const connection = { connect: () => connection, disconnect() {} };
    class AudioContext {
        audioWorklet = { async addModule() {} };
        createMediaStreamSource() { return connection; }
        createGain() { return { ...connection, gain: {} }; }
        async resume() {}
        async close() {}
    }
    class AudioWorkletNode {
        port = { close() {} };
        connect() { return connection; }
        disconnect() {}
    }
    for (const [name, value] of Object.entries({ navigator: { mediaDevices }, AudioContext, AudioWorkletNode })) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { configurable: true, value });
        t.after(() => {
            if (previous) Object.defineProperty(globalThis, name, previous);
            else delete globalThis[name];
        });
    }

    const capture = await startCapture('', { transport: 'radio' });
    await capture.cancel();
    assert.deepEqual(requests, ['before-reconnect', 'after-reconnect']);
    await assert.rejects(startCapture('removed-input'), error =>
        error.message === 'Выбранный вход недоступен. Подключите его или выберите другой.' &&
        error.cause?.name === 'OverconstrainedError');
    assert.deepEqual(requests, ['before-reconnect', 'after-reconnect', 'removed-input']);
});
