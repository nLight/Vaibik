import { t, setLanguage, staticTranslations } from './i18n.mjs';
import { isVibeMicInput, microphones, openReadyInput, pttInputs, startCapture } from '/audio.js';
import { watchPtt } from '/ptt-hid.mjs';
import { capturePdmProbe } from '/pdm-probe.mjs';

const api = window.vibemic;
const localizeStatic = staticTranslations(document);
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const iconPaths = {
    wave: '<path d="M2 12h4l3-7 4 14 3-9 2 2h4"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/><rect x="10" y="10" width="4" height="4" rx=".7"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
    sliders: '<path d="M4 6h7m4 0h5M4 12h3m4 0h9M4 18h11m4 0h1M11 3v6m-4 0v6m8 0v6"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v3"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-3 0h6"/>',
    usb: '<path d="M12 22V3m-3 4 3-4 3 4M12 18l-5-4v-3m5 5 5-4V9"/><circle cx="7" cy="9" r="2"/><rect x="15.5" y="6" width="3" height="3"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    corner: '<path d="M20 5v8a3 3 0 0 1-3 3H4m5-5-5 5 5 5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2 6m2-11v5h-5"/>',
    flash: '<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>'
};

function icons(root = document) {
    root.querySelectorAll('[data-icon]:empty').forEach(element => {
        if (iconPaths[element.dataset.icon]) {
            element.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[element.dataset.icon]}</svg>`;
        }
    });
}

const pageNames = { overview: 'Обзор', hardware: 'Платы', speech: 'Распознавание', agents: 'Агенты', settings: 'Настройки' };
const agentNames = { codex: 'Codex', claude: 'Claude Code' };
const modelNames = { parakeet: 'Parakeet TDT v3' };
const modelSizes = { parakeet: '714 МБ' };
const linkEndMessages = {
    radioTimeout: 'Связь с передатчиком прервалась.',
    hostTimeout: 'Донгл не дождался открытия аудиовхода.',
    usbStopped: 'Поток USB-аудио остановился.',
    superseded: 'Проверку прервало новое нажатие PTT.'
};
const state = {
    settings: null, models: {}, agents: {}, fixture: false, hid: false,
    page: 'overview', recording: null, processing: null, waiting: null, progress: {}, volumes: [], inputs: [], terminal: null,
    pttTransport: undefined, battery: null
};
const fixtureInputs = [
    { deviceId: 'fixture-mic', label: 'PTT Dictation Mic' },
    { deviceId: 'fixture-podcast', label: 'USB Podcast Microphone' }
];
let reviewInputs = fixtureInputs;
let ptt;
let standby;
let microphoneRefresh = 0;
let linkCheck;
let linkCheckResult;
let pdmProbe;
let pdmResult;
let pdmWav;
let flashing = false;
let savingPair = false;
let transferringProfile = false;
let nextTakeId = 0;
let drafts = [];
let selectedDraft;

function errorDetail(message) {
    return t(String(message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
}

function notify(message, error = false) {
    $('#notification-text').textContent = errorDetail(message);
    $('#notification').classList.toggle('error', error);
    $('#notification').hidden = false;
}

function bind(selector, callback, event = 'click') {
    $(selector).addEventListener(event, async value => {
        try { await callback(value); }
        catch (error) { notify(error.message || String(error), true); }
    });
}

function go(page) {
    if (state.page === 'hardware' && page !== 'hardware') {
        pdmProbe?.abort();
        clearPdmPreview();
        pdmResult = undefined;
        renderPdmProbe();
        stopLinkCheck();
        clearLinkPreview();
        linkCheckResult = undefined;
        renderLinkCheck();
    }
    state.page = page;
    $$('[data-view]').forEach(view => { view.hidden = view.dataset.view !== page; });
    $$('[data-page]').forEach(nav => {
        const selected = nav.dataset.page === page;
        nav.classList.toggle('selected', selected);
        nav.setAttribute('aria-current', selected ? 'page' : 'false');
    });
    $('#current-page').textContent = t(pageNames[page]);
    $('#scroll-area').scrollTop = 0;
    if (page === 'agents' && state.terminal) requestAnimationFrame(() => state.terminal?.fit.fit());
}

async function save(patch) {
    const language = state.settings.uiLanguage;
    const mode = state.settings.dictationMode;
    state.settings = await api.save(patch);
    if (language !== state.settings.uiLanguage) applyUiLanguage();
    if (mode !== state.settings.dictationMode) await refreshMics();
    else render();
}

function applyUiLanguage() {
    setLanguage(state.settings.uiLanguage);
    localizeStatic();
    $('#ui-language').value = state.settings.uiLanguage;
    $('#current-page').textContent = t(pageNames[state.page]);
    for (const draft of drafts) draft.status = t(draft.status);
    $('#draft-state').textContent = t($('#draft-state').textContent);
    $('#notification-text').textContent = t($('#notification-text').textContent);
    for (const [index, option] of [...$('#draft-select').options].entries()) {
        option.textContent = index === drafts.length - 1 ? t('Последняя фраза') : t('Предыдущая фраза');
    }
    updateVolumes();
    updateMicrophones();
    render();
}

function selectedInput() {
    const selected = state.settings.microphone;
    if (selected) return state.inputs.find(input => input.deviceId === selected);
    const dedicated = pttInputs(state.inputs, state.pttTransport);
    return dedicated.length === 1 ? dedicated[0] : undefined;
}

function recordingGuide(input, model) {
    if (!input) return {
        title: t('Выберите микрофон'),
        hint: state.settings.microphone ? t('Выбранный вход недоступен. Подключите его или выберите другой.')
            : t('Для пробной записи подойдёт микрофон компьютера.'),
        action: t('Настроить микрофон'), target: '#refresh-mics', showBoards: !state.hid
    };
    if (model?.installed || state.settings.dictationMode === 'auto') return null;
    if (Object.values(state.models).some(status => status.downloading)) return {
        title: t('Загружается модель'), hint: t('Пробная запись станет доступна после установки.'),
        action: t('Открыть загрузку'), target: '#local-models'
    };
    return model?.damaged ? {
        title: t('Нужна замена модели'), hint: t('Скачайте проверенную копию или выберите другую модель.'),
        action: t('Открыть модели'), target: '#local-models'
    } : {
        title: t('Установите Parakeet'), hint: t('Загрузите модель для локального распознавания речи.'),
        action: t('Открыть модели'), target: '#local-models'
    };
}

function focusControl(selector, region = selector) {
    $(selector).focus({ preventScroll: true });
    $(region).scrollIntoView({ block: 'nearest' });
}

function render() {
    if (!state.settings) return;
    const device = Boolean(state.hid);
    renderBattery();
    const deviceStatus = state.pttTransport === 'usb' ? t('Микрофон подключён по USB') : t('Донгл подключён');
    const model = state.models[state.settings.model];
    const agent = agentNames[state.settings.agent];
    const output = state.settings.output;
    $('#dictation-label').textContent = state.settings.dictationMode === 'auto'
        ? t('Автоматическая диктовка') : t('Локальное распознавание');
    const input = selectedInput();
    const status = state.recording ? 'recording' : state.processing ? 'processing' : 'idle';
    const guide = status === 'idle' ? recordingGuide(input, model) : null;
    const hero = $('.hero');
    hero.dataset.state = status;
    hero.toggleAttribute('data-guide', Boolean(guide));
    $('.guide-actions').hidden = !guide;
    $('#guide-boards').hidden = !guide?.showBoards;
    if (guide) {
        $('#guide-next').textContent = guide.action;
        $('#guide-next').dataset.target = guide.target;
    }
    $('#device-pill').classList.toggle('live', device);
    $('#device-pill').replaceChildren(Object.assign(document.createElement('span'), { className: 'dot' }),
        document.createTextNode(device ? deviceStatus : t('VibeMic не подключён')));
    $('#capture-status').textContent = { idle: guide ? t('Настройка записи') : t('Ожидание PTT'), recording: t('Идёт запись'), processing: t('Распознавание') }[status];
    $('#capture-title').textContent = { idle: guide?.title ?? t('Нажмите и говорите'),
        recording: state.recording?.native ? t`Диктовка в ${state.recording.native}` : t('Говорите'),
        processing: t('Готовим черновик') }[status];
    $('#capture-hint').textContent = { idle: guide?.hint ?? (device && input && isVibeMicInput(input)
        ? t('Удерживайте кнопку на передатчике до конца фразы.') : t('Удерживайте экранную кнопку, пока говорите.')),
        recording: state.processing ? t('Предыдущая фраза распознаётся. Отпустите PTT в конце.')
            : t('Отпустите кнопку, когда закончите фразу.'),
        processing: state.waiting ? t('Следующая фраза записана и ждёт распознавания.')
            : t('Можно диктовать следующую фразу.') }[status];
    $('#manual-ptt').hidden = Boolean(guide);
    $('#manual-ptt').disabled = Boolean(state.waiting || linkCheck || pdmProbe || !input);
    $('#ready-device').textContent = !device ? t('Подключите USB')
        : standby?.input?.ready || (state.fixture && !standby) || (state.settings.dictationMode === 'auto' && input) ? t('Готов к записи')
            : standby ? t('Подготовка аудиовхода') : t('Проверьте аудиовход');
    $('#ready-model').textContent = model?.installed ? t`${modelNames[state.settings.model]} готова`
        : model?.downloading ? t('Модель загружается') : model?.damaged ? t('Перескачайте модель') : t('Установите модель');
    const desktopOutput = state.platform === 'darwin' ? t('Активное приложение') : t('Открытый Claude или Codex');
    $('#output option[value=desktop]').textContent = desktopOutput;
    $('#ready-agent').textContent = output === 'manual' ? t('Черновик в VibeMic')
        : output === 'desktop' ? desktopOutput
        : state.terminal ? t`${agentNames[state.terminal.agent]} · сессия открыта`
            : `${agent} · ${state.agents[state.settings.agent]?.path ? t('откройте терминал') : t('установите CLI')}`;
    $('#connect-hid').textContent = device ? deviceStatus : t('Подключить VibeMic');
    $('#connect-hid').disabled = device;
    renderLinuxAccess();
    renderLinkCheck();
    renderPdmProbe();
    $('#language').value = 'auto';
    $('#dictation-mode').value = state.settings.dictationMode;
    $('#dictation-mode').disabled = Boolean(state.recording || state.processing || state.waiting);
    $('#dictation-mode option[value=auto]').disabled = state.platform !== 'darwin';
    $('#codex-shortcut-settings').hidden = state.settings.dictationMode !== 'auto';
    $('#codex-dictation-shortcut').checked = state.settings.codexDictationShortcut;
    $('#codex-dictation-shortcut').disabled = $('#dictation-mode').disabled;
    $('#claude-shortcut-settings').hidden = state.settings.dictationMode !== 'auto';
    $('#claude-dictation-shortcut').checked = state.settings.claudeDictationShortcut;
    $('#claude-dictation-shortcut').disabled = $('#dictation-mode').disabled;
    $('#claude-shortcut-hint').hidden = !state.settings.claudeDictationShortcut;
    $('#dictation-mode-hint').textContent = state.settings.dictationMode === 'auto'
        ? t('В Codex и Claude включается встроенная диктовка, если она доступна. В остальных приложениях текст распознаёт Parakeet.')
        : t('Parakeet распознаёт речь на этом компьютере и вставляет текст в выбранное место.');
    $('#agent').value = state.settings.agent;
    $('#output').value = output;
    $('#auto-insert').checked = state.settings.autoInsert;
    $('#auto-insert').disabled = output === 'manual';
    $('#external-permissions').hidden = state.platform !== 'darwin' || output !== 'desktop';
    $('#output-hint').textContent = {
        terminal: t('Черновик попадёт в активную сессию встроенного терминала.'),
        desktop: state.platform === 'darwin'
            ? t('Поставьте курсор в нужное поле ввода и удерживайте кнопку на передатчике.')
            : t('Во время записи оставьте курсор в поле ввода Claude или Codex.'),
        manual: t('Текст останется в черновике, откуда его можно скопировать.')
    }[output];
    $('#project-path').textContent = state.settings.project;
    $('#start-terminal').disabled = Boolean(state.terminal) || !state.agents[state.settings.agent]?.path;
    $('#stop-terminal').hidden = !state.terminal;
    updateProfileActions();
    updateDraft();
    updateModels();
    updateAgents();
}

function updateDraft() {
    const text = $('#draft-text').value;
    $('#draft-count').textContent = t`${text.length} симв.`;
    $('#copy-draft').disabled = !text.trim();
    $('#insert-draft').disabled = !text.trim() || !state.terminal;
}

function rememberDraftEdits() {
    const draft = drafts.find(item => item.id === selectedDraft);
    if (draft) {
        draft.text = $('#draft-text').value;
        draft.status = $('#draft-state').textContent;
    }
}

function showDraft(draft) {
    selectedDraft = draft.id;
    $('#draft-select').value = String(draft.id);
    $('#draft-text').value = draft.text;
    $('#draft-state').textContent = t(draft.status);
    updateDraft();
}

function publishDraft(take, text, status) {
    rememberDraftEdits();
    const previous = drafts.find(draft => draft.id === take.previousId);
    const latest = { id: take.id, text, status };
    drafts = previous ? [previous, latest] : [latest];
    const select = $('#draft-select');
    select.replaceChildren(...drafts.map(draft => new Option(
        draft === latest ? t('Последняя фраза') : t('Предыдущая фраза'), String(draft.id))));
    select.hidden = drafts.length < 2;
    if (previous && previous.id === selectedDraft && document.activeElement === $('#draft-text')) {
        select.value = String(selectedDraft);
        updateDraft();
    } else showDraft(latest);
}

function renderLinuxAccess() {
    const status = state.usbRule;
    $('#linux-access').hidden = !status;
    $('#install-usb-rule').hidden = !['missing', 'outdated'].includes(status);
    const text = {
        missing: t('Установите правило USB для донгла и PDM Probe, затем переподключите плату.'),
        outdated: t('Обновите правило USB для доступа к PDM Probe и переподключите плату.'),
        configured: state.hid ? t('Правило USB для VibeMic и PDM Probe установлено. VibeMic подключён.')
            : t('Правило USB для донгла и PDM Probe установлено. Переподключите нужную плату.'),
        overridden: t('Действующее правило 70-vibemic.rules отличается от правила VibeMic. Проверьте настройки udev.')
    }[status] ?? '';
    const description = $('#usb-rule-status');
    if (description.textContent !== text) description.textContent = text;
}

function buttons(card, configs) {
    const list = card.querySelector('.actions');
    list.replaceChildren(...configs.map(([label, primary, action, disabled]) => {
        const button = document.createElement('button');
        button.className = primary ? 'primary' : 'secondary';
        button.textContent = label;
        button.disabled = Boolean(disabled);
        button.addEventListener('click', async () => {
            try { await action(); } catch (error) { notify(error.message || String(error), true); }
        });
        return button;
    }));
}

function updateModels() {
    for (const id of Object.keys(modelNames)) {
        let card = $(`[data-model="${id}"]`);
        if (!card) {
            card = document.createElement('article');
            card.className = 'card model-card';
            card.dataset.model = id;
            card.innerHTML = '<span class="tag"></span><h2></h2><p></p><progress max="100" value="0" hidden></progress><div class="actions"></div>';
            $('#model-list').append(card);
        }
        const status = state.models[id] || {};
        const chosen = id === state.settings.model;
        card.classList.toggle('chosen', chosen);
        card.dataset.damaged = String(Boolean(status.damaged && !status.downloading));
        card.querySelector('h2').textContent = modelNames[id];
        card.querySelector('p').textContent = status.damaged
            ? status.downloading ? t('Проверим контрольную сумму перед заменой.')
                : t('Локальный файл не прошёл проверку. Скачайте проверенную копию.')
            : t('Локальное распознавание на 25 языках, включая русский и английский. Язык определяется автоматически.');
        card.querySelector('.tag').textContent = status.downloading ? t('ЗАГРУЗКА') : status.damaged ? t('ПОВРЕЖДЕНА')
            : status.installed ? (chosen ? t('ВЫБРАНА') : t('УСТАНОВЛЕНА')) : t(modelSizes[id]);
        const progress = card.querySelector('progress');
        progress.setAttribute('aria-label', t('Загрузка модели'));
        progress.hidden = !status.downloading;
        progress.value = state.progress[id] || 0;
        buttons(card, status.downloading
            ? [[t('Отменить'), false, () => api.cancelModel(id)]]
            : status.installed
                ? [[t('Перескачать'), false, () => downloadModel(id, false)],
                    [chosen ? t('Используется') : t('Выбрать'), !chosen, () => save({ model: id }), chosen]]
                : status.damaged ? [[t`Перескачать · ${t(modelSizes[id])}`, true, () => downloadModel(id, false)]]
                    : [[t`Скачать · ${t(modelSizes[id])}`, true, () => downloadModel(id)]]);
    }
}

function updateAgents() {
    for (const id of Object.keys(agentNames)) {
        let card = $(`[data-agent="${id}"]`);
        if (!card) {
            card = document.createElement('article');
            card.className = 'card agent-card';
            card.dataset.agent = id;
            card.innerHTML = '<span class="tag"></span><h2></h2><p class="path-text"></p><div class="actions"></div>';
            $('#agent-list').append(card);
        }
        const info = state.agents[id] || {};
        card.querySelector('h2').textContent = agentNames[id];
        card.querySelector('.tag').textContent = info.installing ? t('УСТАНОВКА') : info.path ? t('CLI НАЙДЕН') : t('НАСТРОЙКА');
        card.querySelector('p').textContent = info.path || t('Установите официальный CLI или укажите путь.');
        buttons(card, [
            [t('Указать путь'), false, async () => {
                state.settings = await api.chooseAgent(id);
                state.agents = await api.agentStatus();
                render();
            }, info.installing],
            [info.installing ? t('Устанавливается…') : info.path ? t('Инструкция') : t('Установить'), !info.path,
                info.path ? () => api.openAgentDocs(id) : () => installAgent(id), info.installing]
        ]);
    }
}

async function downloadModel(id, select = true) {
    if (state.models[id]?.downloading) return;
    state.models[id] = { ...state.models[id], downloading: true };
    state.progress[id] = 0;
    render();
    if (state.page === 'speech') $(`[data-model="${id}"]`).scrollIntoView({ block: 'nearest' });
    try {
        await api.installModel(id);
        if (select) await save({ model: id });
        notify(select ? t('Модель установлена.') : t('Модель заменена.'));
    } finally {
        state.models = await api.modelStatus();
        updateModels();
        render();
    }
}

function confirm(tag, title, body, action, details = []) {
    const dialog = $('#confirm-dialog');
    $('#confirm-tag').textContent = tag;
    $('#confirm-title').textContent = title;
    $('#confirm-body').textContent = body;
    $('#confirm-action').textContent = action;
    const preview = $('#confirm-details');
    preview.replaceChildren(...details.map(([label, value]) => {
        const row = document.createElement('div');
        row.append(Object.assign(document.createElement('dt'), { textContent: label }),
            Object.assign(document.createElement('dd'), { textContent: value }));
        return row;
    }));
    preview.hidden = !details.length;
    dialog.returnValue = 'cancel';
    dialog.showModal();
    return new Promise(resolve => dialog.addEventListener('close', () =>
        resolve(dialog.returnValue === 'accept'), { once: true }));
}

function profileImportBlocked() {
    return Boolean(state.recording || state.processing || linkCheck || pdmProbe);
}

function updateProfileActions() {
    $('#import-profile').disabled = transferringProfile || profileImportBlocked();
    $('#export-profile').disabled = transferringProfile;
}

async function transferProfile(action) {
    if (transferringProfile) return;
    transferringProfile = true;
    updateProfileActions();
    try { await action(); }
    catch (error) {
        const message = (error.message || String(error)).replace(/^Error invoking remote method 'settings:[^']+': (?:Error: )?/, '');
        notify(message, true);
    }
    finally {
        transferringProfile = false;
        updateProfileActions();
    }
}

async function importProfile() {
    const profile = await api.importProfile();
    if (!profile) return;
    const fallback = profile.output === 'desktop' && !state.external;
    const output = fallback ? 'manual' : profile.output;
    const label = (selector, value) => [...$(selector).options].find(option => option.value === value).textContent;
    const details = [
        [t('Код радиопары'), profile.pairCode || t('Стендовый адрес')],
        [t('Модель'), modelNames[profile.model]],
        [t('Режим диктовки'), label('#dictation-mode', profile.dictationMode)],
        [t('Язык'), label('#language', profile.language)],
        [t('Агент'), agentNames[profile.agent]],
        [t('Место вставки'), label('#output', output)],
        [t('Автовставка'), output !== 'manual' && profile.autoInsert ? t('Включена') : t('Выключена')]
    ];
    const body = fallback ? t('В этой сборке доступен черновик в VibeMic. Код пары сохранится для будущих прошивок.')
        : t('Эти значения заменят текущие. Код пары сохранится для будущих прошивок.');
    if (!await confirm(t('ПРОФИЛЬ'), t('Применить настройки?'), body, t('Применить профиль'), details)) return;
    if (profileImportBlocked()) throw new Error(t('Завершите запись и распознавание перед импортом.'));
    state.settings = await api.applyProfile(profile);
    $('#pair-code').value = state.settings.pairCode;
    pairingFeedback('');
    updateSelectedVolume();
    render();
    notify(t('Профиль применён.'));
}

async function installAgent(id) {
    if (!await confirm('CLI', t`Установить ${agentNames[id]}?`,
        t('VibeMic запустит официальный установщик. После установки вход в аккаунт откроется в терминале агента.'),
        t('Запустить установщик'))) return;
    state.agents[id] = { ...state.agents[id], installing: true };
    $('#install-output').textContent = '';
    $('#install-log').hidden = false;
    $('#install-log').open = true;
    render();
    try {
        await api.installAgent(id);
        await save({ agent: id });
        notify(t('CLI установлен. Откройте терминал для входа.'));
    } finally {
        state.agents = await api.agentStatus();
        render();
    }
}

function updateVolumes() {
    const selected = $('#volume').value;
    $('#volume').replaceChildren(new Option(t('Выберите диск'), ''), ...state.volumes.map(volume =>
        new Option(`${volume.model} · ${volume.directory}`, volume.directory)));
    $('#volume').value = state.volumes.some(volume => volume.directory === selected) ? selected
        : state.volumes.length === 1 ? state.volumes[0].directory : '';
    updateSelectedVolume();
}

function updateSelectedVolume() {
    $('#battery-sensor-hint').hidden = $('#board-role').value !== 'transmitter-v2-battery';
    const volume = state.volumes.find(entry => entry.directory === $('#volume').value);
    $('#flash-firmware').disabled = flashing || savingPair || Boolean(pdmProbe) || !volume;
    $('#flash-firmware').ariaBusy = String(flashing);
    $('#flash-label').textContent = flashing ? t('Подготовка и запись…') : t('Прошить плату');
    $('#volume-status').textContent = volume
        ? t`Разметка S140 v${volume.version} · приложение 0x${volume.address.toString(16)}.`
        : state.volumes.length ? t('Выберите диск загрузчика.')
            : t('Диск ещё не найден. Введите плату в режим загрузчика и обновите список.');
    renderPairing();
    renderPdmProbe();
}

function renderPairing() {
    const code = state.settings.pairCode;
    const input = $('#pair-code');
    const busy = flashing || savingPair;
    const changed = input.value.trim().toUpperCase() !== code;
    $('#active-pair-code').textContent = code || t('Стендовый адрес');
    input.disabled = busy;
    $('#generate-pair-code').disabled = busy;
    $('#copy-pair-code').disabled = !code || changed || busy;
    $('#save-pair-code').disabled = !changed || busy;
}

function pairingFeedback(text, result) {
    const status = $('#pair-code-status');
    status.textContent = text;
    status.dataset.result = result ?? '';
    status.hidden = !text;
    if (text && state.page === 'hardware' && $('#pairing-panel').open) {
        status.scrollIntoView({ block: 'nearest' });
    }
}

async function refreshVolumes() {
    state.volumes = await api.volumes();
    updateVolumes();
}

async function flash() {
    const directory = $('#volume').value;
    const role = $('#board-role').value;
    const volume = state.volumes.find(entry => entry.directory === directory);
    if (!volume || flashing || savingPair || pdmProbe) return;
    const pairCode = state.settings.pairCode;
    const label = { transmitter: t('Передатчик'), 'transmitter-v2-battery': t('Передатчик · nice!nano v2'), receiver: t('USB-донгл'), 'mic-probe': 'PDM Probe' }[role];
    const backup = volume.hasCurrent ? t('Перед записью VibeMic сохранит резервную копию.') : t('На диске отсутствует CURRENT.UF2. Резервная копия недоступна.');
    const address = role === 'mic-probe' ? t('В режиме диагностики запись идёт по USB. После проверки выберите обычный передатчик.')
        : pairCode ? t`В прошивку будет записан код пары ${pairCode}.` : t('В прошивке будет использован стендовый адрес.');
    if (!await confirm(t('ПРОШИВКА'), t`Прошить как «${label}»?`,
        t`Приложение на плате ${volume.model} будет заменено. ${address} ${backup} Во время записи оставьте кабель подключённым.`,
        t('Записать UF2'))) return;
    flashing = true;
    updateSelectedVolume();
    try {
        const { backupSaved } = await api.flash(directory, role, volume.identity, pairCode);
        const saved = backupSaved ? t('Резервная копия сохранена. ') : '';
        notify(t`${saved}Образ «${label}» передан. Дождитесь перезагрузки платы.`);
        await refreshVolumes();
    } finally {
        flashing = false;
        updateSelectedVolume();
    }
}

function setStandby(deviceId) {
    if (standby?.deviceId === deviceId && (!standby?.input || standby.input.ready)) return;
    const previous = standby;
    standby = undefined;
    previous?.input?.close().catch(() => {});
    if (!deviceId) {
        render();
        return;
    }

    const attempt = { deviceId };
    standby = attempt;
    render();
    openReadyInput(deviceId).then(input => {
        if (standby !== attempt) return input.close().catch(() => {});
        attempt.input = input;
        render();
    }, () => {
        if (standby !== attempt) return;
        standby = undefined;
        render();
    });
}

async function refreshMics(request = false) {
    const version = ++microphoneRefresh;
    const devices = state.fixture ? reviewInputs : await microphones(request);
    if (version !== microphoneRefresh) return;
    state.inputs = devices;
    updateMicrophones();
    const input = selectedInput();
    if (!state.fixture) setStandby(state.settings.dictationMode !== 'auto' && state.hid && input && isVibeMicInput(input) ? input.deviceId : undefined);
    render();
}

function updateMicrophones() {
    const devices = state.inputs;
    const selected = state.settings.microphone;
    const input = selectedInput();
    const menu = $('#microphone');
    menu.replaceChildren(new Option(t('VibeMic автоматически'), ''),
        ...devices.map((device, index) => new Option(device.label || t`Аудиовход ${index + 1}`, device.deviceId)));
    if (selected && !input) menu.add(new Option(t('Недоступный вход'), selected));
    menu.value = selected;
    $('#mic-status').textContent = input && !selected && input.label ? t`Диктовка использует ${input.label}.`
        : input ? t('VibeMic использует этот вход для диктовки.')
        : selected ? t('Выбранный вход недоступен. Подключите его или выберите другой.')
            : devices.some(device => device.label) ? t('Выберите микрофон из списка.')
                : t('Нажмите «Найти микрофоны» и разрешите доступ.');
}

function setHidConnected(connected, transport = 'radio') {
    const changed = state.hid && connected && state.pttTransport !== transport;
    state.hid = connected;
    state.pttTransport = connected ? transport : undefined;
    if (!connected || changed) {
        state.battery = null;
        api.cancelApproval().catch(() => {});
        api.cancelNativeDictation().catch(() => {});
        setStandby();
        if (!connected || linkCheck) {
            stopLinkCheck(t('Подключение VibeMic изменилось. Повторите проверку.'), 'error');
        }
        release('hardware', true);
    }
    render();
    refreshMics().catch(() => {});
}

function updateBattery(value) {
    state.battery = value ? { ...value, at: Date.now() } : null;
    renderBattery();
}

function renderBattery() {
    const element = $('#transmitter-battery');
    element.hidden = !state.hid;
    const value = state.battery;
    const stale = !value || Date.now() - value.at > 30000;
    element.dataset.low = String(!stale && value.percent !== null && value.percent <= 15);
    element.textContent = stale ? t('Батарея: —') : value.usbPower ? t('Питание USB')
        : value.percent === null ? t('Батарея: —') : t`Батарея ≈ ${value.percent}%`;
    element.title = stale ? t('Нет свежих данных батареи передатчика. Нужна прошивка с телеметрией.')
        : value.usbPower ? t('Передатчик получает питание по USB. Процент и состояние зарядки не определяются.')
            : value.percent === null ? t('Напряжение батареи недоступно. Проверьте тип платы и настройку датчика в прошивке.')
                : t`Батарея передатчика: ${value.millivolts} мВ. Процент приблизительный, по напряжению LiPo.`;
    element.setAttribute('aria-label', element.textContent + '. ' + element.title);
}

async function connectHid() {
    if (state.fixture) {
        setHidConnected(true);
        return;
    }
    if (!ptt) throw new Error(t('USB HID недоступен.'));
    await ptt.request();
}

function renderLinkCheck() {
    const toggle = $('#link-check-toggle');
    const status = $('#link-check-status');
    const text = linkCheck?.message ?? linkCheckResult?.message ?? (state.hid
        ? t('Нажмите «Начать проверку», затем говорите, удерживая PTT.') : t('Подключите микрофон по USB или подключите донгл.'));
    if (status.textContent !== t(text)) status.textContent = t(text);
    status.dataset.result = linkCheckResult?.kind ?? '';
    toggle.textContent = linkCheck ? t('Отменить') : t('Начать проверку');
    toggle.disabled = !linkCheck && (!state.hid || Boolean(state.recording) || state.processing || pdmProbe);
    const stats = linkCheckResult?.stats;
    const details = $('#link-check-stats');
    details.hidden = !stats;
    if (stats) {
        $('#link-rssi').textContent = stats.weakestDbm === null ? '—' : t`−${Math.abs(stats.weakestDbm)} дБм`;
        $('#link-silent').textContent = t`${stats.silentMs} мс`;
        $('#link-usb-errors').textContent = stats.usbErrors;
    }
}

function clearLinkPreview() {
    const audio = $('#link-check-audio');
    if (audio.hasAttribute('src')) {
        URL.revokeObjectURL(audio.src);
        audio.removeAttribute('src');
        audio.load();
    }
    audio.hidden = true;
}

function clearPdmPreview() {
    const audio = $('#pdm-audio');
    if (audio.hasAttribute('src')) {
        URL.revokeObjectURL(audio.src);
        audio.removeAttribute('src');
        audio.load();
    }
    audio.hidden = true;
    pdmWav = undefined;
}

function renderPdmProbe() {
    const blocked = Boolean(state.recording || state.processing || linkCheck || flashing || savingPair);
    const cancelling = Boolean(pdmProbe?.signal.aborted);
    $('#pdm-record').textContent = cancelling ? t('Завершаем…') : pdmProbe ? t('Отменить') : t('Записать 3 секунды');
    $('#pdm-record').disabled = cancelling || !pdmProbe && blocked;
    $('#pdm-prepare').disabled = Boolean(pdmProbe || blocked);
    $('#pdm-restore').disabled = Boolean(pdmProbe || blocked);
    $('#pdm-status').textContent = t(cancelling ? t('Отменяем проверку. Завершаем получение записи с платы…')
        : pdmResult?.message ?? t('Подключите передатчик с прошивкой PDM Probe по USB.'));
    $('#pdm-status').dataset.result = pdmResult?.kind ?? '';
    $('#pdm-levels').hidden = !pdmResult?.levels;
    $('#pdm-save').hidden = !pdmWav;
    const levels = pdmResult?.levels;
    if (levels) {
        const dbfs = value => `${Number.isFinite(value) ? value.toFixed(1) : '−∞'} dBFS`;
        $('#pdm-peak').textContent = dbfs(levels.peak);
        $('#pdm-rms').textContent = dbfs(levels.rms);
        $('#pdm-dc').textContent = t`${levels.dc.toFixed(1)} отсч.`;
        $('#pdm-clipped').textContent = String(levels.clipped);
    }
}

async function startPdmProbe() {
    if (pdmProbe || state.recording || state.processing || linkCheck || flashing || savingPair) return;
    clearPdmPreview();
    const controller = new AbortController();
    pdmProbe = controller;
    controller.signal.addEventListener('abort', () => {
        if (state.page === 'hardware') render();
    }, { once: true });
    pdmResult = { message: t('Открываем USB-порт PDM Probe…') };
    render();
    try {
        const result = await capturePdmProbe(navigator.serial, { signal: controller.signal,
            stage: value => {
                if (state.page !== 'hardware' || controller.signal.aborted) return;
                pdmResult = { message: value === 'recording' ? t('Записываем три секунды. Говорите в микрофон.') : t('Получаем запись с платы…') };
                renderPdmProbe();
            } });
        if (state.page !== 'hardware' || controller.signal.aborted) return;
        pdmWav = result.wav;
        const audio = $('#pdm-audio');
        audio.src = URL.createObjectURL(new Blob([result.wav], { type: 'audio/wav' }));
        audio.hidden = false;
        const { levels } = result;
        pdmResult = { levels, kind: levels.peak === -Infinity || levels.clipped ? 'error' : 'success',
            message: levels.peak === -Infinity ? t('Запись содержит тишину. Проверьте питание и проводку PDM.')
                : levels.clipped ? t('Есть отсчёты на пределе диапазона. Прослушайте запись и проверьте громкость.')
                    : t('Запись получена. Прослушайте её, затем восстановите обычный передатчик.') };
    } catch (error) {
        if (state.page === 'hardware') pdmResult = { message: error.message || String(error), kind: 'error' };
    } finally {
        pdmProbe = undefined;
        render();
    }
}

function choosePdmRole(role) {
    $('#board-role').value = role;
    updateSelectedVolume();
    focusControl('#board-role', '.page[data-view=hardware] article.setup');
}

function stopLinkCheck(message, kind, stats) {
    if (!linkCheck) return;
    const check = linkCheck;
    linkCheck = undefined;
    clearTimeout(check.timeout);
    check.capture?.cancel().catch(() => {});
    linkCheckResult = message ? { message, kind, stats } : undefined;
    render();
    if (stats && state.page === 'hardware') $('#link-check').scrollIntoView({ block: 'nearest' });
}

async function startLinkCheck() {
    if (linkCheck || pdmProbe || !state.hid || state.recording || state.processing) return;
    clearLinkPreview();
    linkCheckResult = undefined;
    const check = { stage: 'preparing', message: t('Открываем аудиовход VibeMic…') };
    linkCheck = check;
    render();
    check.timeout = setTimeout(() => stopLinkCheck(t('USB-вход не открылся. Проверьте доступ к микрофону.'), 'error'), 20000);
    try {
        const devices = state.fixture ? reviewInputs : await microphones();
        if (linkCheck !== check) return;
        const dedicated = pttInputs(devices, state.pttTransport);
        const input = dedicated.find(device => device.deviceId === state.settings.microphone)
            ?? (dedicated.length === 1 ? dedicated[0] : undefined);
        if (!input) throw new Error(t('Не удалось выбрать PTT Dictation Mic. Проверьте аудиовход на странице «Распознавание».'));
        const capture = await startCapture(input.deviceId, { waitForTrigger: true });
        if (linkCheck !== check) return await capture.cancel();
        check.capture = capture;
        check.stage = 'ready';
        check.message = t('Зажмите PTT на передатчике и произнесите короткую фразу.');
        clearTimeout(check.timeout);
        check.timeout = setTimeout(() => stopLinkCheck(t('Нажатие PTT не получено. Проверьте питание передатчика и кнопку.'), 'error'), 20000);
        renderLinkCheck();
    } catch (error) {
        if (linkCheck === check) stopLinkCheck(error.message, 'error');
    }
}

async function handlePtt(down, stats) {
    if (down) api.cancelApproval().catch(() => {});
    const check = linkCheck;
    if (!check) {
        if (down) return begin('hardware');
        if (state.recording?.trigger === 'hardware') state.recording.endReason = stats?.end;
        return release('hardware');
    }
    if (down && check.stage === 'ready') {
        clearTimeout(check.timeout);
        check.stage = 'recording';
        check.message = t('PTT нажат. Говорите, затем отпустите кнопку.');
        check.timeout = setTimeout(() => stopLinkCheck(t('Отпускание PTT не получено. Отпустите кнопку и повторите проверку.'), 'error'), 15000);
        check.capture.start();
        renderLinkCheck();
    } else if (!down && check.stage === 'recording') {
        clearTimeout(check.timeout);
        check.stage = 'finishing';
        const interruption = t(linkEndMessages[stats?.end]);
        check.message = interruption ? t`${interruption} Готовим запись…` : t('PTT отпущен. Готовим запись…');
        renderLinkCheck();
        try {
            const wav = await check.capture.finish();
            if (linkCheck !== check) return;
            const audio = $('#link-check-audio');
            audio.src = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
            audio.hidden = false;
            if (interruption) {
                stopLinkCheck(t`${interruption} Прослушайте сохранённую часть записи.`, 'error', stats);
            } else {
                stopLinkCheck(t('Нажатие и отпускание PTT получены. Прослушайте запись.'), 'success', stats);
            }
        } catch (error) {
            if (linkCheck === check) {
                const reason = error.cause === 'silence' ? t('В записи тишина. Проверьте питание и проводку PDM.') : error.message;
                stopLinkCheck(interruption ?? t`PTT нажат и отпущен. ${reason}`, 'error', stats);
            }
        }
    }
}

function begin(trigger) {
    if (linkCheck || pdmProbe || state.recording || state.waiting) return;
    const model = state.models[state.settings.model];
    const automatic = trigger === 'hardware' && state.settings.dictationMode === 'auto';
    if (!automatic && !model?.installed) {
        if (model?.damaged && trigger === 'manual') {
            go('speech');
            $(`[data-model="${state.settings.model}"]`).scrollIntoView({ block: 'nearest' });
        } else {
            notify(model?.damaged ? t('Перескачайте модель на странице «Распознавание».')
                : t('Сначала скачайте модель на странице «Распознавание».'), true);
        }
        return;
    }
    const selected = state.settings.microphone;
    const resolved = selected || selectedInput()?.deviceId;
    const input = standby?.input?.ready && resolved === standby.deviceId ? standby.input : null;
    const previousId = state.processing?.id;
    const take = {
        id: ++nextTakeId,
        previousId,
        model: state.settings.model,
        language: state.settings.language,
        trigger, terminal: state.settings.output === 'terminal' ? state.terminal?.id : null,
        automatic,
        insertExternal: !state.processing && trigger === 'hardware' && state.settings.output === 'desktop' && state.settings.autoInsert
    };
    take.pending = captureTake(take, selected, input);
    state.recording = take;
    take.timeout = setTimeout(() => release(trigger), 119000);
    take.pending.catch(error => {
        if (state.recording === take) {
            clearTimeout(take.timeout);
            state.recording = null;
            cancelExternalTarget(take);
            notify(error.message || String(error), true);
            render();
        }
    });
    render();
}

async function captureTake(take, selected, input) {
    if (take.automatic) {
        const route = await api.beginNativeDictation();
        if (route.native) {
            let stopShortcut;
            let localFallback = false;
            try {
                if (route.shortcut === 'codex') {
                    if (state.recording === take) stopShortcut = await ptt?.holdShortcut('codex');
                    if (!stopShortcut) throw new Error(t('Нажмите и удерживайте PTT.'));
                } else if (route.shortcut === 'claude' && state.recording === take) {
                    // An older board cannot send Cmd+D; the recorder button still works in that case.
                    stopShortcut = await ptt?.holdShortcut('claude', route.usage).catch(() => null);
                    // Give the physical shortcut time to start Claude before using its mic button.
                    if (stopShortcut) await new Promise(resolve => setTimeout(resolve, 350));
                    if (state.recording === take && await api.checkClaudeDictation(route.session, false)) {
                        await new Promise(resolve => setTimeout(resolve, 600));
                        if (state.recording === take && await api.checkClaudeDictation(route.session, true)) {
                            await stopShortcut?.();
                            localFallback = true;
                        }
                    }
                }
            } catch (error) {
                if (route.shortcut === 'claude') {
                    await stopShortcut?.().catch(() => {});
                    await api.cancelNativeDictation().catch(() => {});
                }
                throw error;
            }
            if (!localFallback) {
                clearTimeout(take.timeout);
                take.native = route.app;
                if (state.recording === take) render();
                return {
                    finish: async () => {
                        await stopShortcut?.();
                        if (route.shortcut !== 'codex') await api.endNativeDictation(route.session);
                        const interruption = linkEndMessages[take.endReason];
                        if (interruption) throw new Error(t(interruption));
                        return { native: true, app: route.app };
                    },
                    cancel: async () => {
                        try { await stopShortcut?.(); }
                        finally { if (route.shortcut !== 'codex') await api.cancelNativeDictation(); }
                    }
                };
            }
            if (state.recording !== take) throw new Error(t(linkEndMessages.hostTimeout));
        }
    }
    if (!state.models[take.model]?.installed) throw new Error(t('Сначала скачайте модель на странице «Распознавание».'));
    take.external = take.insertExternal
        ? api.prepareExternal().then(id => ({ id }), error => ({ error })) : null;
    if (state.fixture) return {
        finish: async () => {
            const wave = new Uint8Array(4000);
            wave[0] = take.previousId ? 1 : 0;
            return wave;
        },
        cancel: async () => {}
    };
    return input ? input.begin() : startCapture(selected, { transport: state.pttTransport });
}

async function release(trigger, cancel = false) {
    const take = state.recording;
    if (!take || take.trigger !== trigger) return;
    state.recording = null;
    clearTimeout(take.timeout);
    if (cancel) {
        cancelExternalTarget(take);
        render();
        await take.pending.then(capture => capture.cancel()).catch(() => {});
        return;
    }

    take.wave = take.pending.then(capture => capture.finish()).then(wave => ({ wave }), error => ({ error }));
    if (state.processing) {
        state.waiting = take;
        render();
    } else await recognizeTake(take);
}

function cancelExternalTarget(take) {
    take.external?.then(({ id }) => { if (id) api.cancelExternal(id); });
}

async function recognizeTake(take) {
    state.processing = take;
    render();
    try {
        const { wave, error: captureError } = await take.wave;
        if (captureError) throw captureError;
        if (wave.native) {
            notify(t`Диктовка завершена в ${wave.app}. Проверьте текст в приложении.`);
            return;
        }
        const text = await api.transcribe(wave, take.model, take.language);
        if (!text) throw new Error(t('Речь не распознана.'));
        const inserted = !take.previousId && state.settings.autoInsert && state.settings.output === 'terminal' &&
            take.terminal && state.terminal?.id === take.terminal && pasteDraft(text);
        let externalInserted = false;
        if (take.external && state.settings.autoInsert && state.settings.output === 'desktop') {
            const { id, error } = await take.external;
            try {
                if (error) throw error;
                await api.pasteExternal(id, text);
                externalInserted = true;
            } catch (error) {
                notify(t('Черновик сохранён в VibeMic. ') + errorDetail(error.message || error), true);
            }
        }
        const status = inserted
            ? t('Вставлено в поле ввода агента. Проверьте текст и отправьте его там.')
            : externalInserted ? t('Вставлено в открытое приложение. Проверьте и отправьте текст там.')
                : take.previousId ? t('Фраза сохранена для отдельной вставки.') : t('Готов к проверке и вставке.');
        publishDraft(take, text, status);
        if (inserted) notify(t('Черновик вставлен в терминал.'));
    } catch (error) {
        state.models = await api.modelStatus().catch(() => state.models);
        notify(error.message || String(error), true);
    } finally {
        cancelExternalTarget(take);
        const next = state.waiting;
        state.waiting = null;
        if (next) void recognizeTake(next);
        else {
            state.processing = null;
            render();
        }
    }
}

function pasteDraft(value = $('#draft-text').value) {
    const text = value.trim().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    const active = state.terminal;
    if (!active || !text || !active.view.modes.bracketedPasteMode) return false;
    active.view.paste(text);
    return true;
}

async function openTerminal() {
    const agent = state.settings.agent;
    const id = await api.startTerminal(agent);
    $('#terminal-wrap').hidden = false;
    const view = new window.Terminal({
        fontSize: 12, fontFamily: 'Menlo, Consolas, monospace', cursorBlink: true,
        theme: { background: '#111319', foreground: '#e3e3ef', cursor: '#c1b3ff' }
    });
    const fit = new window.FitAddon.FitAddon();
    view.loadAddon(fit);
    view.open($('#terminal'));
    state.terminal = { id, agent, view, fit };
    view.onData(data => api.terminalInput(id, data));
    view.onResize(({ cols, rows }) => api.terminalResize(id, cols, rows));
    fit.fit();
    view.focus();
    await api.terminalReady(id);
    render();
    $('#terminal-wrap').scrollIntoView({ block: 'nearest' });
}

function closeTerminal() {
    state.terminal?.view.dispose();
    state.terminal = null;
    $('#terminal-wrap').hidden = true;
    render();
}

icons();
$$('[data-page]').forEach(button => button.addEventListener('click', () => go(button.dataset.page)));
$$('[data-go]').forEach(button => button.addEventListener('click', () => go(button.dataset.go)));
bind('#guide-next', event => {
    go('speech');
    focusControl(event.currentTarget.dataset.target);
});
bind('#ready-output', () => {
    go('agents');
    if (state.settings.output !== 'terminal') focusControl('#output');
    else if (state.terminal) $('#terminal-wrap').scrollIntoView({ block: 'nearest' });
    else if (state.agents[state.settings.agent]?.path) focusControl('#choose-project', '#session-card');
});
bind('#dismiss', () => { $('#notification').hidden = true; });
bind('#import-profile', () => transferProfile(importProfile));
bind('#export-profile', () => transferProfile(async () => {
    if (await api.exportProfile()) notify(t('Профиль сохранён в JSON.'));
}));
bind('#draft-text', updateDraft, 'input');
bind('#draft-select', event => {
    rememberDraftEdits();
    const draft = drafts.find(item => String(item.id) === event.target.value);
    if (draft) showDraft(draft);
}, 'change');
bind('#copy-draft', async () => { await api.copy($('#draft-text').value); notify(t('Черновик скопирован.')); });
bind('#insert-draft', () => {
    if (!pasteDraft()) throw new Error(t('Агент ещё не готов принять вставку. Можно скопировать черновик.'));
    $('#draft-state').textContent = t('Вставлено в поле ввода агента.');
    go('agents');
    state.terminal?.view.focus();
});
bind('#connect-hid', connectHid);
bind('#link-check-toggle', () => linkCheck ? stopLinkCheck(t('Проверка отменена.')) : startLinkCheck());
bind('#pdm-record', () => pdmProbe ? pdmProbe.abort() : startPdmProbe());
bind('#pdm-prepare', () => choosePdmRole('mic-probe'));
bind('#pdm-restore', () => choosePdmRole('transmitter'));
bind('#pdm-save', async () => { if (pdmWav && await api.savePdmClip(pdmWav)) notify(t('Запись PDM сохранена.')); });
bind('#refresh-volumes', refreshVolumes);
bind('#volume', updateSelectedVolume, 'change');
bind('#board-role', updateSelectedVolume, 'change');
bind('#choose-volume', async () => {
    const picked = await api.pickVolume();
    if (!picked) return;
    state.volumes = [...state.volumes.filter(volume => volume.directory !== picked.directory), picked];
    updateVolumes();
    $('#volume').value = picked.directory;
    updateSelectedVolume();
});
bind('#flash-firmware', flash);
bind('#firmware-backups', () => api.firmwareBackups());
bind('#pair-code', () => { pairingFeedback(''); renderPairing(); }, 'input');
bind('#generate-pair-code', async () => {
    const input = $('#pair-code');
    input.value = await api.generatePairCode();
    pairingFeedback('');
    renderPairing();
    input.focus();
});
bind('#copy-pair-code', async () => {
    await api.copy(state.settings.pairCode);
    pairingFeedback(t('Код пары скопирован.'), 'success');
});
bind('#pairing-form', async event => {
    event.preventDefault();
    if ($('#save-pair-code').disabled) return;
    const input = $('#pair-code');
    const value = input.value;
    pairingFeedback('');
    savingPair = true;
    updateSelectedVolume();
    try {
        const saved = await api.savePairCode(value);
        if (saved.error) {
            pairingFeedback(saved.error, 'error');
            return;
        }
        state.settings = saved.settings;
        input.value = state.settings.pairCode;
        pairingFeedback(t('Настройка сохранена. Прошейте обе платы, чтобы применить её.'), 'success');
    } finally {
        savingPair = false;
        updateSelectedVolume();
    }
}, 'submit');
bind('#install-usb-rule', async () => {
    if (await confirm('LINUX', t('Разрешить USB-доступ?'),
        t('Система запросит разрешение администратора для установки правила доступа к донглу и диагностическому порту PDM Probe.'),
        t('Разрешить'))) {
        state.usbRule = await api.usbAccess();
        renderLinuxAccess();
    }
});
bind('#refresh-mics', () => refreshMics(true));
bind('#microphone', async event => {
    await save({ microphone: event.target.value });
    await refreshMics();
}, 'change');
bind('#language', event => save({ language: event.target.value }), 'change');
bind('#ui-language', event => save({ uiLanguage: event.target.value }), 'change');
bind('#dictation-mode', event => save({ dictationMode: event.target.value }), 'change');
bind('#codex-dictation-shortcut', event => save({ codexDictationShortcut: event.target.checked }), 'change');
bind('#claude-dictation-shortcut', event => save({ claudeDictationShortcut: event.target.checked }), 'change');
bind('#choose-project', async () => { state.settings = await api.chooseProject(); render(); });
bind('#agent', event => save({ agent: event.target.value }), 'change');
bind('#output', event => save({ output: event.target.value }), 'change');
bind('#external-permissions', async () => {
    const granted = await api.permissions();
    notify(granted ? t('VibeMic может вставлять текст в активное окно.')
        : t('Разрешите VibeMic доступ в настройках универсального доступа macOS.'));
});
bind('#auto-insert', event => save({ autoInsert: event.target.checked }), 'change');
bind('#start-terminal', openTerminal);
bind('#stop-terminal', async () => {
    if (!state.terminal) return;
    if (!await confirm(t('СЕССИЯ'), t('Завершить сессию агента?'),
        t('Запущенный процесс в терминале VibeMic будет остановлен.'), t('Завершить сессию'))) return;
    await api.stopTerminal(state.terminal.id);
    closeTerminal();
});

const manual = $('#manual-ptt');
manual.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    manual.setPointerCapture(event.pointerId);
    begin('manual');
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    manual.addEventListener(event, () => release('manual'));
}
manual.addEventListener('keydown', event => {
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat) begin('manual');
});
manual.addEventListener('keyup', event => {
    if ([' ', 'Enter'].includes(event.key)) {
        event.preventDefault();
        release('manual');
    }
});
manual.addEventListener('blur', () => release('manual', true));

api.onModelProgress(({ id, received, total }) => {
    state.progress[id] = Math.round(received / total * 100);
    const progress = $(`[data-model="${id}"] progress`);
    if (progress) progress.value = state.progress[id];
});
api.onInstallLog(({ line }) => {
    const log = $('#install-output');
    log.textContent = (log.textContent + line).slice(-24000);
    log.scrollTop = log.scrollHeight;
});
api.onTerminalData(({ id, data }) => {
    if (state.terminal?.id === id) state.terminal.view.write(data);
});
api.onTerminalExit(({ id, exitCode }) => {
    if (state.terminal?.id !== id) return;
    closeTerminal();
    notify(t`Сессия завершилась, код ${exitCode}.`);
});
window.addEventListener('resize', () => {
    if (state.page === 'agents') state.terminal?.fit.fit();
});

try {
    const initial = await api.init();
    Object.assign(state, initial);
    $('.version').textContent = 'VibeMic ' + initial.version;
    $('#pair-code').value = state.settings.pairCode;
    applyUiLanguage();
    $('#output option[value=desktop]').disabled = !initial.external;
    if (!initial.external && state.settings.output === 'desktop') await save({ output: 'manual' });
    render();
    await refreshVolumes();
    await refreshMics().catch(() => {});
    if (!state.fixture) navigator.mediaDevices?.addEventListener('devicechange', () => refreshMics().catch(() => {}));
    if (!initial.runtime) notify(t('Движок Parakeet отсутствует в этой сборке.'), true);
    if (!state.fixture && navigator.hid) {
        ptt = watchPtt(navigator.hid, {
            connection: setHidConnected,
            button: handlePtt,
            battery: updateBattery,
            approval: (kind, token, at) => {
                if (!linkCheck && !pdmProbe && !state.recording && !state.processing && !state.waiting) {
                    api.approvalEdge(kind, token, at).catch(() => {});
                }
            },
            error: failure => notify(failure.message || String(failure), true)
        });
        await ptt.scan();
        setInterval(renderBattery, 5000);
    }
    if (state.fixture) {
        window.fixture = {
            go, connectHid, begin, release, handlePtt,
            updateBattery,
            flash, openTerminal,
            setMicrophones(devices = fixtureInputs) {
                reviewInputs = devices;
                return refreshMics();
            },
            disconnectHid: () => setHidConnected(false),
            connectWired: () => setHidConnected(true, 'usb'),
            setUsbRule(status) {
                state.usbRule = status;
                renderLinuxAccess();
            },
            preparingInput() {
                standby = {};
                render();
            },
            useSoftDeviceV7() {
                state.volumes[0] = { ...state.volumes[0], version: 7, address: 0x27000 };
                updateVolumes();
            },
            setCurrentAvailable(hasCurrent) {
                state.volumes[0] = { ...state.volumes[0], hasCurrent };
                updateVolumes();
            },
            terminalText() {
                const buffer = state.terminal?.view.buffer.active;
                return Array.from({ length: buffer?.length || 0 },
                    (_, i) => buffer.getLine(i)?.translateToString(true)).join('\n');
            },
            setModelStatus(id, status, progress = 0) {
                state.models[id] = status;
                state.progress[id] = progress;
                render();
            },
            notify
        };
    }
} catch (error) { notify(error.message || String(error), true); }
