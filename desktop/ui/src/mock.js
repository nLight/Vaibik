// Browser-only fixture mirroring the Rust `--fixture` backend, so the UI can be
// exercised end-to-end without native hardware. Never used inside Tauri.
const VERSION = '0.1.34';
const BANNER = '\x1b[?2004hCodex · тестовая сессия\r\nПроект: vibemic-demo\r\n\r\n> ';

function defaultSettings() {
    return {
        model: 'parakeet', language: 'auto', dictationMode: 'local',
        codexDictationShortcut: false, claudeDictationShortcut: false,
        uiLanguage: 'ru', microphone: '', agent: 'codex',
        project: '/Volumes/Dev/VibeMic example', autoInsert: true, output: 'terminal',
        pairCode: '', agentPaths: { codex: '', claude: '' }
    };
}

function normalizePair(value) {
    const compact = String(value).toUpperCase().replace(/[^0-9A-F]/g, '');
    if (!/^[0-9A-F]{8}$/.test(compact)) return null;
    return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function fixtureClip() {
    const samples = 3 * 16000;
    const clip = new Uint8Array(4 + samples * 2);
    clip.set([0x56, 0x4d, 0x49, 0x43], 0);
    const view = new DataView(clip.buffer);
    for (let i = 0; i < samples; i++) {
        const envelope = 0.4 + 0.6 * Math.abs(Math.sin(i / 2400));
        view.setInt16(4 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / 16000) * 8000 * envelope), true);
    }
    return clip;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createMockApi() {
    const settings = defaultSettings();
    const listeners = new Map();
    let terminalId = null;

    const emit = (event, payload) => {
        for (const callback of [...(listeners.get(event) ?? [])]) callback(payload);
    };
    const subscriber = event => callback => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(callback);
        return () => listeners.get(event)?.delete(callback);
    };
    const merge = patch => {
        for (const [key, value] of Object.entries(patch)) {
            if (key === 'agentPaths') settings.agentPaths = { ...settings.agentPaths, ...value };
            else if (key in settings) settings[key] = value;
        }
        return { ...settings, agentPaths: { ...settings.agentPaths } };
    };

    return {
        async init() {
            return {
                settings: { ...settings, agentPaths: { ...settings.agentPaths } },
                version: VERSION, platform: 'darwin', fixture: true, external: true, usbRule: null,
                models: { parakeet: { installed: true, damaged: false, downloading: false } },
                agents: { codex: { path: '/opt/vibemic-fixture/bin/codex', installing: false }, claude: { path: null, installing: false } },
                runtime: true
            };
        },
        async save(patch) { return merge(patch); },
        async chooseProject() { return merge({ project: '/Volumes/Dev/Пример проекта с длинным названием' }); },
        async exportProfile() { return true; },
        async importProfile() {
            return { model: 'parakeet', language: 'auto', agent: 'codex', output: 'terminal', autoInsert: true, dictationMode: 'local', pairCode: '8B27-3DE4' };
        },
        async applyProfile(profile) { return merge(profile); },
        async agentStatus() {
            return { codex: { path: '/opt/vibemic-fixture/bin/codex', installing: false }, claude: { path: null, installing: false } };
        },
        async openAgentDocs() {},
        async chooseAgent() { return { ...settings, agentPaths: { ...settings.agentPaths } }; },
        async installAgent() { throw new Error('В тестовом режиме установка отключена.'); },
        async modelStatus() { return { parakeet: { installed: true, damaged: false, downloading: false } }; },
        async installModel() { throw new Error('В тестовом режиме загрузка отключена.'); },
        async cancelModel() {},
        async transcribe(wave) {
            await delay(650);
            const bytes = wave instanceof Uint8Array ? wave : new Uint8Array(wave);
            return bytes[0] !== 0 ? 'Добавь проверку пустого ввода.' : 'Проверь падающий тест в parser.ts и исправь причину.';
        },
        async savePdmClip() { return true; },
        async volumes() {
            return [{ directory: '/Volumes/NICENANO', board: 'nRF52840-nicenano', model: 'nice!nano', address: 0x26000, version: 6, identity: 'fixture', hasCurrent: true }];
        },
        async pickVolume() { return null; },
        async generatePairCode() { return '8B27-3DE4'; },
        async savePairCode(value) {
            const code = normalizePair(value);
            if (!code) return { error: 'Код пары должен содержать 8 шестнадцатеричных символов.' };
            return { settings: merge({ pairCode: code }) };
        },
        async flash(directory, role) { await delay(400); return { role, backupSaved: true }; },
        async firmwareBackups() {},
        async usbAccess() { return 'configured'; },
        async startTerminal() { terminalId = 'fixture-terminal'; return terminalId; },
        async terminalReady(id) { emit('terminal:data', { id, data: BANNER }); },
        async stopTerminal(id) { terminalId = null; emit('terminal:exit', { id, exitCode: 0 }); },
        async terminalInput(id, data) {
            if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) {
                emit('terminal:data', { id, data: data.slice(6, -6) });
            }
        },
        async terminalResize() {},
        async copy() {},
        async prepareExternal() { return 'fixture-draft'; },
        async pasteExternal() {},
        async cancelExternal() {},
        async permissions() { return true; },
        async approvalEdge() {},
        async cancelApproval() {},
        async beginNativeDictation() { return { native: false }; },
        async endNativeDictation() { return { native: true }; },
        async checkClaudeDictation() { return true; },
        async cancelNativeDictation() {},
        async hidRescan() {},
        async hidSendFeature() {},
        async pdmCapture() {
            emit('pdm:stage', { stage: 'recording' });
            await delay(700);
            emit('pdm:stage', { stage: 'receiving' });
            await delay(300);
            return fixtureClip();
        },
        async pdmCancel() {},
        async uiReady() {},
        onModelProgress: subscriber('model:progress'),
        onInstallLog: subscriber('agent:log'),
        onTerminalData: subscriber('terminal:data'),
        onTerminalExit: subscriber('terminal:exit'),
        onHidReport: subscriber('hid:report'),
        onHidConnection: subscriber('hid:connection'),
        onHidFeatureError: subscriber('hid:feature-error'),
        onPdmStage: subscriber('pdm:stage')
    };
}
