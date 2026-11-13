// Synthesized hardware feedback: every cue is tied to a visible event.
// On by default; one top-level control mutes everything. No samples, no assets.
const STORAGE_KEY = 'vibemic.sound';

let context = null;
let master = null;
let noiseBuffer = null;
let enabled = readPreference();

function readPreference() {
    try { return localStorage.getItem(STORAGE_KEY) !== 'off'; }
    catch { return true; }
}

function ensure() {
    if (context) return context;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    master = context.createGain();
    master.gain.value = 0.9;
    master.connect(context.destination);
    const length = Math.floor(context.sampleRate * 0.4);
    noiseBuffer = context.createBuffer(1, length, context.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return context;
}

function resume() {
    const ctx = ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

function tone({ freq = 440, to = null, type = 'sine', dur = 0.12, gain = 0.2, delay = 0, curve = 'exp' }) {
    const ctx = ensure();
    if (!ctx) return;
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (to) osc.frequency[curve === 'exp' ? 'exponentialRampToValueAtTime' : 'linearRampToValueAtTime'](Math.max(1, to), start + dur);
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(amp).connect(master);
    osc.start(start);
    osc.stop(start + dur + 0.02);
}

function noise({ dur = 0.05, gain = 0.18, freq = 1800, q = 0.8, type = 'bandpass', delay = 0 }) {
    const ctx = ensure();
    if (!ctx || !noiseBuffer) return;
    const start = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, start);
    filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, start);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(filter).connect(amp).connect(master);
    src.start(start);
    src.stop(start + dur + 0.02);
}

const cues = {
    // Mechanical key travel: a low body thock plus a filtered contact click.
    press() { tone({ freq: 165, to: 92, type: 'sine', dur: 0.09, gain: 0.26 }); noise({ dur: 0.035, gain: 0.16, freq: 2600, q: 1.1 }); },
    release() { tone({ freq: 240, to: 150, type: 'sine', dur: 0.06, gain: 0.16 }); noise({ dur: 0.028, gain: 0.12, freq: 3400, q: 1.3 }); },
    // Recording armed: a quiet rising confirmation.
    start() { tone({ freq: 520, to: 784, type: 'triangle', dur: 0.14, gain: 0.14 }); },
    // Draft ready: a clean two-note chime.
    done() { tone({ freq: 659.25, type: 'triangle', dur: 0.13, gain: 0.16 }); tone({ freq: 987.77, type: 'triangle', dur: 0.18, gain: 0.15, delay: 0.1 }); },
    error() { tone({ freq: 150, to: 110, type: 'square', dur: 0.1, gain: 0.12 }); tone({ freq: 120, to: 90, type: 'square', dur: 0.12, gain: 0.1, delay: 0.12 }); },
    nav() { noise({ dur: 0.022, gain: 0.09, freq: 4200, q: 1.6 }); },
    toggle() { noise({ dur: 0.03, gain: 0.13, freq: 2200, q: 1.0 }); tone({ freq: 320, type: 'sine', dur: 0.04, gain: 0.08 }); },
    connect() { tone({ freq: 440, to: 880, type: 'sine', dur: 0.16, gain: 0.15 }); },
    disconnect() { tone({ freq: 660, to: 300, type: 'sine', dur: 0.16, gain: 0.13 }); },
    flash() { tone({ freq: 880, to: 220, type: 'sawtooth', dur: 0.3, gain: 0.1 }); noise({ dur: 0.3, gain: 0.05, freq: 900, q: 0.5, type: 'lowpass' }); },
    copy() { tone({ freq: 1046.5, type: 'sine', dur: 0.07, gain: 0.12 }); }
};

export const sound = {
    get enabled() { return enabled; },
    setEnabled(value) {
        enabled = Boolean(value);
        try { localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off'); } catch {}
        if (enabled) { resume(); cues.toggle(); }
    },
    unlock() { if (enabled) resume(); },
    play(name) {
        if (!enabled) return;
        const cue = cues[name];
        if (!cue) return;
        resume();
        try { cue(); } catch {}
    }
};
