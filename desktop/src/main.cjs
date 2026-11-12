'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, protocol,
    session, shell, systemPreferences, Tray } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { SpeechModels, MODELS } = require('./models.cjs');
const { findBootloaders, inspectBootloader, flashFirmware, normalizePairCode, generatePairCode } = require('./firmware.cjs');
const { AGENTS, agentSpec, agentEnvironment, findAgent, installAgent } = require('./agents.cjs');
const { ExternalDraft } = require('./external-draft.cjs');
const { ApprovalGesture } = require('./approval.cjs');
const { NativeDictation } = require('./native-dictation.cjs');
const { OUTPUTS, DICTATION_MODES, portableSettings, readProfile, writeProfile } = require('./profile.cjs');
const { usbRuleBody, usbRuleStatus, installUsbRule } = require('./usb-access.cjs');
const localization = import('../ui/i18n.mjs');
const pttDevices = import('../ui/ptt-hid.mjs');
let t = source => source;
let setLanguage;

const run = promisify(execFile);
const root = path.join(__dirname, '..');
const origin = 'vibemic://app';
const fixture = !app.isPackaged && process.argv.includes('--fixture');
const resources = app.isPackaged ? path.join(process.resourcesPath, 'vibemic')
    : path.join(root, '..', 'build', 'desktop-resources');
const scratch = app.getPath('temp');
let window;
let tray;
let models;
let external;
let approval;
let nativeDictation;
let settings;
let configPath;
let writeConfig = Promise.resolve();
let terminal;
let transcription = false;
let flashing = false;
let savingPair = false;
const installing = new Set();

const defaults = () => ({
    model: 'parakeet', language: 'auto', microphone: '', agent: 'codex', dictationMode: 'local',
    uiLanguage: app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en',
    project: app.getPath('home'), autoInsert: true, output: 'terminal', agentPaths: { codex: '', claude: '' }
});

if (fixture) {
    app.setPath('userData', path.join(scratch, `vibemic-fixture-${process.pid}`));
}
const firmwareBackups = path.join(app.getPath('userData'), 'firmware-backups');

protocol.registerSchemesAsPrivileged([{
    scheme: 'vibemic', privileges: { standard: true, secure: true, supportFetchAPI: true }
}]);

function validSettings(value) {
    const initial = defaults();
    let pairCode = '';
    try { pairCode = normalizePairCode(value.pairCode ?? ''); } catch {}
    return {
        model: Object.hasOwn(MODELS, value.model) ? value.model : initial.model,
        language: 'auto',
        dictationMode: process.platform === 'darwin' && DICTATION_MODES.includes(value.dictationMode)
            ? value.dictationMode : 'local',
        codexDictationShortcut: process.platform === 'darwin' && value.codexDictationShortcut === true,
        claudeDictationShortcut: process.platform === 'darwin' && value.claudeDictationShortcut === true,
        uiLanguage: ['ru', 'en'].includes(value.uiLanguage) ? value.uiLanguage : initial.uiLanguage,
        microphone: typeof value.microphone === 'string' ? value.microphone.slice(0, 1024) : '',
        agent: Object.hasOwn(AGENTS, value.agent) ? value.agent : initial.agent,
        project: typeof value.project === 'string' && path.isAbsolute(value.project) ? value.project : initial.project,
        autoInsert: typeof value.autoInsert === 'boolean' ? value.autoInsert : initial.autoInsert,
        output: OUTPUTS.includes(value.output) ? value.output : initial.output,
        pairCode,
        agentPaths: Object.fromEntries(Object.keys(AGENTS).map(id => {
            const file = value.agentPaths?.[id];
            return [id, typeof file === 'string' && path.isAbsolute(file) ? file : ''];
        }))
    };
}

function persist(update) {
    writeConfig = writeConfig.catch(() => {}).then(async () => {
        const next = validSettings(update(settings));
        if (!fixture) {
            const temporary = configPath + '.new';
            await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
            await fs.rename(temporary, configPath);
        }
        settings = next;
        if (settings.dictationMode === 'auto') nativeDictation?.enable();
        else nativeDictation?.dispose();
        setLanguage(settings.uiLanguage);
        updateTrayMenu();
        return next;
    });
    return writeConfig;
}

function authorized(event) {
    const frame = event.senderFrame;
    return window && frame && event.sender === window.webContents && frame === event.sender.mainFrame &&
        frame.url === origin + '/index.html';
}

function handle(channel, callback) {
    ipcMain.handle(channel, async (event, ...args) => {
        try {
            if (!authorized(event)) throw new Error(t('Запрос поступил из неизвестного окна.'));
            return await callback(...args);
        } catch (error) {
            throw new Error(t(error.message || String(error)), { cause: error });
        }
    });
}

function emit(channel, data) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, data);
}

function probeMatches(device) {
    return Number.parseInt(device?.vendorId, 16) === 0x1209 && Number.parseInt(device?.productId, 16) === 0x0002;
}

const usbRuleName = '70-vibemic.rules';
const usbRuleDirectories = [
    '/etc/udev/rules.d', '/run/udev/rules.d', '/usr/local/lib/udev/rules.d', '/usr/lib/udev/rules.d', '/lib/udev/rules.d'
];

async function packagedUsbRule() {
    return usbRuleBody(await fs.readFile(path.join(root, 'assets', usbRuleName), 'utf8'));
}

async function linuxUsbRuleStatus(rule) {
    for (const directory of usbRuleDirectories) {
        try {
            const installed = await fs.readFile(path.join(directory, usbRuleName), 'utf8');
            return usbRuleStatus(rule, installed);
        } catch (error) {
            if (error.code !== 'ENOENT') return 'overridden';
        }
    }
    return 'missing';
}

async function configurePermissions() {
    const { preferredPttDevice, isPttDevice } = await pttDevices;
    const ses = session.defaultSession;
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
        (requestingOrigin === origin || requestingOrigin === origin + '/') && (permission === 'hid' || permission === 'serial' ||
            (permission === 'media' && details.mediaType !== 'video')));
    ses.setPermissionRequestHandler((wc, permission, allow, details) =>
        allow(wc === window?.webContents && details.requestingUrl?.startsWith(origin + '/') &&
            (permission === 'hid' || permission === 'serial' || (permission === 'media' &&
                details.mediaTypes?.every(type => type === 'audio')))));
    ses.setDevicePermissionHandler(details => details.origin === origin &&
        ((details.deviceType === 'hid' && Boolean(isPttDevice(details.device))) ||
            (details.deviceType === 'serial' && probeMatches(details.device))));
    ses.on('select-hid-device', (event, details, choose) => {
        event.preventDefault();
        const device = preferredPttDevice(details.deviceList.filter(isPttDevice));
        choose(details.frame === window?.webContents.mainFrame ? device?.deviceId ?? '' : '');
    });
    ses.on('select-serial-port', (event, ports, wc, choose) => {
        event.preventDefault();
        const matches = ports.filter(probeMatches);
        choose(wc === window?.webContents && matches.length === 1 ? matches[0].portId : '');
    });
}

async function agentStatus() {
    return Object.fromEntries(await Promise.all(Object.keys(AGENTS).map(async id => [
        id, { path: fixture ? (id === 'codex' ? '/opt/vibemic-fixture/bin/codex' : null)
            : await findAgent(id, settings.agentPaths[id]), installing: installing.has(id) }
    ])));
}

function stopTerminal(id) {
    if (terminal?.id !== id) return;
    const previous = terminal;
    terminal = undefined;
    previous.pty?.kill();
}

function registerHandlers() {
    const profileFilters = () => [{ name: t('Профиль VibeMic'), extensions: ['json'] }];
    handle('app:init', async () => ({ settings, version: app.getVersion(), platform: process.platform, fixture, external: external.supported,
        usbRule: process.platform !== 'linux' ? null : fixture ? 'missing' : await linuxUsbRuleStatus(await packagedUsbRule()),
        models: fixture ? { parakeet: { installed: true } } : await models.statuses(),
        agents: await agentStatus(), runtime: fixture || await fs.access(runtime()).then(() => true, () => false) }));
    handle('settings:save', async patch => {
        if (!patch || typeof patch !== 'object') throw new Error(t('Некорректные настройки.'));
        const allowed = ['model', 'language', 'uiLanguage', 'microphone', 'agent', 'autoInsert', 'output',
            'dictationMode', 'codexDictationShortcut', 'claudeDictationShortcut'];
        return persist(current => ({ ...current, ...Object.fromEntries(Object.entries(patch)
            .filter(([key]) => allowed.includes(key))) }));
    });
    handle('settings:project', async () => {
        if (fixture) return persist(current => ({ ...current, project: '/Volumes/Dev/Пример проекта с длинным названием' }));
        const answer = await dialog.showOpenDialog(window, {
            title: t('Папка проекта'), defaultPath: settings.project, properties: ['openDirectory']
        });
        return answer.canceled ? settings : persist(current => ({ ...current, project: answer.filePaths[0] }));
    });
    handle('settings:export-profile', async () => {
        const answer = fixture ? { filePath: path.join(app.getPath('userData'), 'export-profile.json') }
            : await dialog.showSaveDialog(window, { title: t('Сохранить профиль VibeMic'),
                defaultPath: 'VibeMic-profile.json', filters: profileFilters(),
                properties: ['showOverwriteConfirmation'] });
        if (answer.canceled || !answer.filePath) return false;
        await writeConfig.catch(() => {});
        try { await writeProfile(answer.filePath, settings, configPath); }
        catch (error) {
            if (error.code) throw new Error(t('Не удалось сохранить файл профиля. Проверьте доступ к выбранной папке.'));
            throw error;
        }
        return true;
    });
    handle('settings:import-profile', async () => {
        const answer = fixture ? { filePaths: [path.join(app.getPath('userData'), 'import-profile.json')] }
            : await dialog.showOpenDialog(window, { title: t('Открыть профиль VibeMic'),
                properties: ['openFile'], filters: profileFilters() });
        if (answer.canceled || !answer.filePaths[0]) return null;
        try { return await readProfile(answer.filePaths[0]); }
        catch (error) {
            if (error.code) throw new Error(t('Не удалось прочитать файл профиля. Проверьте доступ к файлу.'));
            throw error;
        }
    });
    handle('settings:apply-profile', async profile => {
        if (flashing || savingPair) throw new Error(t('Дождитесь окончания текущей операции с платой.'));
        const patch = portableSettings(profile);
        if (patch.output === 'desktop' && !external.supported) patch.output = 'manual';
        savingPair = true;
        try { return await persist(current => ({ ...current, ...patch })); }
        catch { throw new Error(t('Не удалось применить профиль. Проверьте доступ к папке настроек.')); }
        finally { savingPair = false; }
    });
    handle('agent:status', agentStatus);
    handle('agent:docs', id => shell.openExternal(agentSpec(id).docs));
    handle('agent:choose', async id => {
        agentSpec(id);
        if (fixture) return settings;
        const answer = await dialog.showOpenDialog(window, { title: t('Выберите исполняемый файл CLI'),
            properties: ['openFile'] });
        if (answer.canceled) return settings;
        const executable = await findAgent(id, answer.filePaths[0]);
        if (!executable) throw new Error(t('Выбранный файл не запускается.'));
        return persist(current => ({ ...current, agentPaths: { ...current.agentPaths, [id]: executable } }));
    });
    handle('agent:install', async id => {
        agentSpec(id);
        if (installing.has(id)) throw new Error(t('Установщик уже запущен.'));
        installing.add(id);
        try {
            if (fixture) throw new Error(t('В тестовом режиме установка отключена.'));
            return await installAgent(id, scratch, line => emit('agent:log', { id, line }));
        } finally { installing.delete(id); }
    });
    handle('model:status', () => fixture
        ? { parakeet: { installed: true } } : models.statuses());
    handle('model:install', id => {
        if (fixture) throw new Error(t('В тестовом режиме загрузка отключена.'));
        return models.install(id, value => emit('model:progress', value));
    });
    handle('model:cancel', id => models.cancel(id));
    handle('audio:transcribe', async (wave, model = settings.model, language = settings.language) => {
        if (!(wave instanceof Uint8Array) || wave.byteLength > 4000000) {
            throw new Error(t('Некорректная запись.'));
        }
        if (transcription) throw new Error(t('Предыдущая запись ещё распознаётся.'));
        transcription = true;
        try {
            if (fixture) {
                await new Promise(resolve => setTimeout(resolve, 650));
                return wave[0] ? 'Добавь проверку пустого ввода.' : 'Проверь падающий тест в parser.ts и исправь причину.';
            }
            return await models.transcribe(wave, model, language, scratch);
        } finally { transcription = false; }
    });
    handle('audio:save-pdm-clip', async wave => {
        const bytes = Buffer.from(wave);
        if (bytes.length !== 96044 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
            bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(24) !== 16000) {
            throw new Error(t('Запись PDM имеет неподдерживаемый формат.'));
        }
        const answer = fixture ? { filePath: path.join(app.getPath('userData'), 'pdm-check.wav') }
            : await dialog.showSaveDialog(window, { title: t('Сохранить проверку PDM'), defaultPath: 'VibeMic-PDM.wav',
                filters: [{ name: 'WAV', extensions: ['wav'] }], properties: ['showOverwriteConfirmation'] });
        if (answer.canceled || !answer.filePath) return false;
        const temporary = answer.filePath + `.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
            await fs.rename(temporary, answer.filePath);
        } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
        return true;
    });
    handle('firmware:volumes', () => fixture ? [{
        directory: '/Volumes/NICENANO', board: 'nRF52840-nicenano', model: 'nice!nano', address: 0x26000, version: 6,
        hasCurrent: true
    }] : findBootloaders());
    handle('firmware:choose', async () => {
        if (fixture) return null;
        const answer = await dialog.showOpenDialog(window, {
            title: t('Диск с файлом INFO_UF2.TXT'), properties: ['openDirectory']
        });
        return answer.canceled ? null : inspectBootloader(answer.filePaths[0]);
    });
    handle('firmware:generate-pair', () => fixture ? '8B27-3DE4' : generatePairCode());
    handle('firmware:save-pair', async value => {
        if (flashing || savingPair) throw new Error(t('Дождитесь окончания текущей операции с платой.'));
        let pairCode;
        try { pairCode = normalizePairCode(value); }
        catch (error) { return { error: t(error.message) }; }
        savingPair = true;
        try {
            return { settings: await persist(current => ({ ...current, pairCode })) };
        } catch {
            return { error: t('Не удалось сохранить код пары. Проверьте доступ к папке настроек и свободное место.') };
        } finally { savingPair = false; }
    });
    handle('firmware:flash', async (directory, role, identity, confirmedCode) => {
        if (flashing || savingPair) throw new Error(t('Дождитесь окончания текущей операции с платой.'));
        if (confirmedCode !== settings.pairCode) throw new Error(t('Код пары изменился. Подтвердите прошивку заново.'));
        flashing = true;
        try {
            if (fixture) {
                await new Promise(resolve => setTimeout(resolve, 400));
                return { role, backupSaved: true };
            }
            return await flashFirmware(directory, role, resources, identity, firmwareBackups, confirmedCode);
        } finally { flashing = false; }
    });
    handle('firmware:backups', async () => {
        if (fixture) return;
        await fs.mkdir(firmwareBackups, { recursive: true, mode: 0o700 });
        const error = await shell.openPath(firmwareBackups);
        if (error) throw new Error(t('Не удалось открыть папку резервных копий.'));
    });
    handle('device:linux-access', async () => {
        if (fixture) return 'configured';
        if (process.platform !== 'linux') return null;
        const rule = await packagedUsbRule();
        const status = await linuxUsbRuleStatus(rule);
        if (!['missing', 'outdated'].includes(status)) return status;
        const destination = path.join(usbRuleDirectories[0], usbRuleName);
        const existing = await fs.readFile(destination, 'utf8').catch(error => {
            if (error.code === 'ENOENT') return '';
            throw error;
        });
        if (existing && usbRuleStatus(rule, existing) !== 'outdated') return 'overridden';
        try {
            await run('pkexec', ['/bin/sh', '-c', installUsbRule, 'vibemic-usb', rule, destination, existing.trimEnd()], { timeout: 120000 });
        } catch (error) {
            if (error.code === 'ENOENT') throw new Error(t('Для установки правила из AppImage нужен pkexec. Можно установить пакет DEB.'));
            throw error;
        }
        return linuxUsbRuleStatus(rule);
    });
    handle('terminal:start', async agent => {
        agentSpec(agent);
        if (terminal) throw new Error(t('Сначала закройте активную сессию.'));
        const id = randomUUID();
        if (fixture) {
            terminal = { id, buffered: ['\x1b[?2004hCodex · тестовая сессия\r\nПроект: vibemic-demo\r\n\r\n> '] };
            return id;
        }
        const executable = await findAgent(agent, settings.agentPaths[agent]);
        if (!executable) throw new Error(t('Сначала установите CLI или укажите путь к нему.'));
        if (!(await fs.stat(settings.project).catch(() => null))?.isDirectory()) {
            throw new Error(t('Выберите доступную папку проекта.'));
        }
        if (terminal) throw new Error(t('Сессия уже запущена.'));
        const pty = require('node-pty').spawn(executable, [], {
            name: 'xterm-256color', cols: 100, rows: 24, cwd: settings.project,
            env: await agentEnvironment()
        });
        const active = { id, pty, buffered: [] };
        terminal = active;
        pty.onData(data => {
            if (active.buffered) active.buffered.push(data);
            else emit('terminal:data', { id, data });
        });
        pty.onExit(({ exitCode }) => {
            if (terminal?.id === id) terminal = undefined;
            emit('terminal:exit', { id, exitCode });
        });
        return id;
    });
    handle('terminal:ready', id => {
        if (terminal?.id !== id || !terminal.buffered) return;
        emit('terminal:data', { id, data: terminal.buffered.join('') });
        terminal.buffered = undefined;
    });
    handle('terminal:stop', stopTerminal);
    ipcMain.on('terminal:input', (event, id, data) => {
        if (!authorized(event) || terminal?.id !== id || typeof data !== 'string' || data.length > 160000) return;
        if (fixture && data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) {
            emit('terminal:data', { id, data: data.slice(6, -6) });
        } else {
            terminal.pty?.write(data);
        }
    });
    ipcMain.on('terminal:resize', (event, id, cols, rows) => {
        if (!authorized(event) || terminal?.id !== id || !Number.isInteger(cols) || !Number.isInteger(rows)
            || cols < 2 || cols > 500 || rows < 2 || rows > 200) return;
        terminal.pty?.resize(cols, rows);
    });
    handle('draft:copy', async text => {
        if (typeof text !== 'string' || text.length > 160000) throw new Error(t('Некорректный черновик.'));
        if (!fixture) await clipboard.writeText(text);
    });
    handle('draft:prepare-external', () => fixture ? 'fixture-draft' : external.prepare());
    handle('draft:paste-external', async (id, text) => {
        if (typeof id !== 'string' || typeof text !== 'string' || text.length > 160000) {
            throw new Error(t('Некорректный черновик.'));
        }
        if (!fixture) await external.paste(id, text);
    });
    handle('draft:cancel-external', id => {
        if (typeof id === 'string') external.cancel(id);
    });
    handle('draft:permissions', () => fixture || process.platform !== 'darwin' ||
        systemPreferences.isTrustedAccessibilityClient(true));
    handle('approval:edge', (kind, token, at) => approval?.edge(kind, token, at));
    handle('approval:cancel', () => approval?.cancel());
    handle('dictation:begin', () => fixture || !nativeDictation || settings.dictationMode !== 'auto'
        ? { native: false } : nativeDictation.begin({
            shortcut: settings.codexDictationShortcut, claudeShortcut: settings.claudeDictationShortcut
        }));
    handle('dictation:end', session => {
        if (!Number.isSafeInteger(session) || session <= 0) throw new Error(t('Сессия диктовки изменилась.'));
        return fixture ? { native: true } : nativeDictation?.finish(session);
    });
    handle('dictation:check-claude', (session, abandon) => {
        if (!Number.isSafeInteger(session) || session <= 0) throw new Error(t('Сессия диктовки изменилась.'));
        return nativeDictation?.checkClaude(session, abandon === true);
    });
    handle('dictation:cancel', () => nativeDictation?.cancel());
}

function runtime() {
    return path.join(resources, 'engine', 'nemo', 'bin', process.platform === 'win32' ? 'nemo-speech.exe' : 'nemo-speech');
}

function createWindow() {
    window = new BrowserWindow({
        width: 680, height: 528, minWidth: 520, minHeight: 450, backgroundColor: '#000000',
        ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } } : {}),
        title: 'VibeMic', show: false, autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
            nodeIntegration: false, sandbox: true, backgroundThrottling: false,
            spellcheck: false, autoplayPolicy: 'no-user-gesture-required' }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.once('ready-to-show', () => window.show());
    window.on('close', event => {
        if (!app.quitting && !fixture && process.platform !== 'linux') {
            event.preventDefault();
            window.hide();
        }
    });
    window.loadURL(origin + '/index.html');
}

function updateTrayMenu() {
    if (!tray) return;
    const show = () => { window?.show(); window?.focus(); };
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: t('Открыть VibeMic'), click: show },
        { label: t('Выйти из VibeMic'), click: () => app.quit() }
    ]));
}

function createTray() {
    if (fixture || process.platform === 'linux') return;
    const image = nativeImage.createFromPath(path.join(root, 'assets', 'icon.png')).resize({ width: 18 });
    tray = new Tray(image);
    tray.setToolTip('VibeMic');
    tray.on('click', () => { window?.show(); window?.focus(); });
    updateTrayMenu();
}

const single = fixture || app.requestSingleInstanceLock();
if (!single) app.quit();
else app.whenReady().then(async () => {
    ({ t, setLanguage } = await localization);
    const data = app.getPath('userData');
    await fs.mkdir(data, { recursive: true });
    configPath = path.join(data, 'settings.json');
    const saved = await fs.readFile(configPath, 'utf8').then(JSON.parse).catch(() => ({}));
    settings = validSettings(fixture ? { project: '/Volumes/Dev/VibeMic example', uiLanguage: 'ru' } : saved || {});
    setLanguage(settings.uiLanguage);
    models = new SpeechModels(path.join(data, 'models'), runtime());
    external = new ExternalDraft(resources);
    if (!fixture && process.platform === 'darwin') {
        approval = new ApprovalGesture(path.join(resources, 'engine', 'vibemic-desktop-draft'));
        nativeDictation = new NativeDictation(path.join(resources, 'engine', 'vibemic-desktop-draft'));
        if (settings.dictationMode === 'auto') nativeDictation.enable();
    }
    const extra = {
        '/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
        '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
        '/xterm-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js'
    };
    protocol.handle('vibemic', request => {
        const url = new URL(request.url);
        const allowed = ['/index.html', '/styles.css', '/renderer.js', '/audio.js', '/capture-worklet.js', '/ptt-hid.mjs',
            '/pcm.mjs', '/pdm-probe.mjs', '/battery.mjs', '/i18n.mjs', '/translations.mjs'];
        const resource = extra[url.pathname] || (allowed.includes(url.pathname) ? 'ui' + url.pathname : null);
        if (url.host !== 'app' || !resource) return new Response('', { status: 404 });
        return net.fetch(pathToFileURL(path.join(root, resource)).href);
    });
    await configurePermissions();
    registerHandlers();
    createWindow();
    createTray();
    if (fixture && process.env.VIBEMIC_REVIEW_DIRECTORY) {
        const review = require(path.join(root, '..', 'script', 'review_desktop.cjs'));
        await review(window, process.env.VIBEMIC_REVIEW_DIRECTORY);
        app.quit();
    }
    app.on('activate', () => window?.show());
    app.on('second-instance', () => { window?.show(); window?.focus(); });
}).catch(error => {
    console.error(error);
    app.exit(1);
});
app.on('before-quit', () => {
    app.quitting = true;
    if (terminal) stopTerminal(terminal.id);
    external?.cancel();
    approval?.cancel();
    nativeDictation?.dispose();
});
app.on('window-all-closed', () => { if (fixture || process.platform === 'linux') app.quit(); });
