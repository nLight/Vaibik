import { t } from './i18n.mjs';
import { pcm16Wav } from './pcm.mjs';

const INPUT_NAME = /\bPTT Dictation Mic\b/i;
const RATE = 16000;

export function isVibeMicInput(device) {
    return INPUT_NAME.test(device.label);
}

function openMicrophone(deviceId) {
    return navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: { exact: deviceId }, channelCount: 1,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false
    } });
}

export async function openReadyInput(deviceId) {
    const context = new AudioContext();
    let stream;
    const closeInput = async () => {
        stream?.getTracks().forEach(track => track.stop());
        await context.close();
    };
    try {
        await context.audioWorklet.addModule('/capture-worklet.js');
        stream = await openMicrophone(deviceId);
        const source = context.createMediaStreamSource(stream);
        const muted = context.createGain();
        muted.gain.value = 0;
        source.connect(muted).connect(context.destination);
        await context.resume();

        let active = 0;
        let retired = false;
        return {
            get ready() { return !retired && stream.active && context.state === 'running'; },
            begin({ waitForTrigger = false } = {}) {
                if (retired) throw new Error(t('Аудиовход сейчас недоступен.'));
                const capture = collect(context, source, muted, waitForTrigger, async () => {
                    active--;
                    if (retired && !active) await closeInput();
                });
                active++;
                return capture;
            },
            async close() {
                if (retired) return;
                retired = true;
                if (!active) await closeInput();
            }
        };
    } catch (error) {
        await closeInput();
        throw error;
    }
}

export async function microphones(requestPermission = false) {
    if (!navigator.mediaDevices) throw new Error(t('Аудиовходы недоступны в этом режиме.'));
    let devices = (await navigator.mediaDevices.enumerateDevices()).filter(x => x.kind === 'audioinput');
    if (requestPermission && !devices.some(x => x.label)) {
        const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        try {
            devices = (await navigator.mediaDevices.enumerateDevices()).filter(x => x.kind === 'audioinput');
        } finally { permissionStream.getTracks().forEach(track => track.stop()); }
    }
    return devices.filter(x => x.deviceId && x.deviceId !== 'default' && x.deviceId !== 'communications');
}

export async function startCapture(deviceId, options) {
    if (!deviceId) {
        const devices = (await microphones()).filter(isVibeMicInput);
        if (devices.length !== 1) {
            throw new Error(t('Выберите микрофон на странице «Распознавание».'));
        }
        deviceId = devices[0].deviceId;
    }
    const input = await openReadyInput(deviceId);
    try { return input.begin(options); }
    finally { await input.close(); }
}

function collect(context, source, muted, waitForTrigger, releaseInput) {
    const node = new AudioWorkletNode(context, 'pcm-collector', { processorOptions: { waitForTrigger } });
    const chunks = [];
    let count = 0;
    let flushed;
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        source.disconnect(node);
        node.disconnect();
        node.port.close();
        await releaseInput();
    };
    node.port.onmessage = event => {
        if (event.data === 'finished') {
            flushed?.();
            return;
        }
        if (event.data instanceof Float32Array && count < context.sampleRate * 121) {
            chunks.push(event.data);
            count += event.data.length;
        }
    };
    source.connect(node).connect(muted);

    return {
        start: () => node.port.postMessage('start'),
        cancel: close,
        async finish() {
            try {
                await new Promise(resolve => {
                    const timer = setTimeout(resolve, 250);
                    flushed = () => { clearTimeout(timer); resolve(); };
                    node.port.postMessage('finish');
                });
            } finally { await close(); }
            return makeWav(chunks, count, context.sampleRate);
        }
    };
}

async function makeWav(chunks, count, rate) {
    if (count < rate * 0.1) throw new Error(t('Запись слишком короткая. Удерживайте кнопку во время речи.'));
    const offline = new OfflineAudioContext(1, Math.ceil(count * RATE / rate), RATE);
    const input = offline.createBuffer(1, count, rate);
    const pcm = input.getChannelData(0);
    let cursor = 0;
    let peak = 0;
    for (const chunk of chunks) {
        pcm.set(chunk, cursor);
        cursor += chunk.length;
        for (const sample of chunk) peak = Math.max(peak, Math.abs(sample));
    }
    if (peak < 0.0005) throw new Error(t('В записи тишина. Проверьте выбранный микрофон.'), { cause: 'silence' });
    const source = offline.createBufferSource();
    source.buffer = input;
    source.connect(offline.destination);
    source.start();
    const output = (await offline.startRendering()).getChannelData(0);
    const pcm16 = new Uint8Array(2 * output.length);
    const samples = new DataView(pcm16.buffer);
    for (let i = 0; i < output.length; i++) {
        samples.setInt16(2 * i, Math.round(Math.max(-1, Math.min(1, output[i])) * 32767), true);
    }
    return pcm16Wav(pcm16);
}
