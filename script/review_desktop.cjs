'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async (window, directory) => {
    await fs.mkdir(directory, { recursive: true });
    const exec = code => window.webContents.executeJavaScript(code, true);
    async function waitFor(code, attempts = 100) {
        for (let i = 0; i < attempts; i++) {
            if (await exec(code)) return;
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        throw new Error('UI did not reach fixture state: ' + code);
    }
    async function save(name) {
        await exec('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const page = await window.webContents.capturePage();
        if (page.isEmpty()) throw new Error('Empty screenshot: ' + name);
        await fs.writeFile(path.join(directory, name + '.png'), page.toPNG());
    }
    await waitFor('Boolean(window.fixture)');
    await exec("fixture.setMicrophones([]); fixture.setModelStatus('parakeet', { installed: false }); true");
    await waitFor("document.querySelector('#capture-title').textContent === 'Выберите микрофон'");
    await save('56-setup-new-profile');
    window.setContentSize(740, 615);
    await save('57-setup-compact');
    await exec("document.querySelector('#guide-boards').click(); true");
    await waitFor("document.querySelector('#current-page').textContent === 'Платы'");
    await exec("fixture.go('overview'); document.querySelector('#guide-next').click(); true");
    await waitFor("document.activeElement.id === 'refresh-mics'");
    await save('58-setup-microphone-permission');
    await exec("fixture.setMicrophones([{ deviceId: 'test-mic', label: 'Встроенный микрофон' }]); true");
    await exec("document.querySelector('#microphone').value = 'test-mic'; document.querySelector('#microphone').dispatchEvent(new Event('change')); true");
    await waitFor("vibemic.init().then(value => value.settings.microphone === 'test-mic')");
    await exec("fixture.go('overview'); true");
    await waitFor("document.querySelector('#capture-title').textContent === 'Установите Parakeet'");
    await save('59-setup-needs-parakeet');
    await exec("document.querySelector('#guide-next').click(); true");
    await waitFor("document.activeElement.id === 'local-models'");
    await save('60-setup-parakeet-options');
    await exec("fixture.go('overview'); fixture.setModelStatus('parakeet', { downloading: true }, 38); true");
    await waitFor("document.querySelector('#capture-title').textContent === 'Загружается модель'");
    await save('61-setup-downloading');
    await exec("document.querySelector('#guide-next').click(); true");
    await waitFor("document.activeElement.id === 'local-models' && !document.querySelector('[data-model=parakeet] progress').hidden");
    await save('61b-setup-download-progress');
    await exec("fixture.go('overview'); fixture.setModelStatus('parakeet', { installed: true }); true");
    await waitFor("!document.querySelector('#manual-ptt').hidden && document.querySelector('#capture-hint').textContent.includes('экранную кнопку')");
    await save('62-setup-trial-ready');
    await exec("document.querySelector('#ready-output').click(); true");
    await waitFor("document.activeElement.id === 'choose-project'");
    if (!await exec("document.querySelector('#start-terminal').getBoundingClientRect().bottom <= innerHeight")) {
        throw new Error('Project guidance did not reveal the terminal launch button');
    }
    await save('63-setup-project');
    await exec("fixture.go('overview'); fixture.setMicrophones([]); true");
    await waitFor("document.querySelector('#capture-hint').textContent.includes('Выбранный вход недоступен')");
    await save('64-setup-input-disconnected');
    await exec("document.querySelector('#guide-next').click(); true");
    if (!await exec("document.querySelector('#microphone').selectedOptions[0].textContent === 'Недоступный вход'")) {
        throw new Error('Lost the explicitly selected input after disconnect');
    }
    await save('65-setup-unavailable-option');
    await exec("fixture.setMicrophones(); document.querySelector('#microphone').value = ''; document.querySelector('#microphone').dispatchEvent(new Event('change')); true");
    await waitFor("vibemic.init().then(value => value.settings.microphone === '')");
    await exec("fixture.go('overview'); true");
    await waitFor("!document.querySelector('#manual-ptt').hidden");
    window.setContentSize(1140, 780);
    await save('01-overview');
    await exec("fixture.go('hardware')");
    await save('02-hardware');
    if (!await exec("document.querySelector('#flash-firmware').getBoundingClientRect().bottom < innerHeight")) {
        throw new Error('The flash button is below the default viewport');
    }
    await exec("document.querySelector('#flash-firmware').click(); true");
    await waitFor("document.querySelector('dialog').open");
    await save('03-flash-confirmation');
    await exec("document.querySelector('#confirm-action').click(); true");
    await waitFor("document.querySelector('#flash-firmware').getAttribute('aria-busy') === 'true'");
    await save('03b-flash-writing');
    await waitFor("document.querySelector('#notification-text').textContent.includes('Резервная копия сохранена')");
    await save('04-flash-result');
    await exec("fixture.notify('Диск загрузчика изменился. Обновите список плат и подтвердите прошивку заново.', true)");
    await save('04b-flash-volume-changed');
    await exec("fixture.notify('Не удалось сохранить резервную копию. Проверьте доступ к папке копий и свободное место.', true)");
    await save('04c-flash-backup-error');
    window.setContentSize(740, 615);
    await exec("document.querySelector('#dismiss').click(); fixture.setCurrentAvailable(false); document.querySelector('#flash-firmware').closest('article').scrollIntoView({ block: 'end' }); true");
    await save('04d-flash-compact');
    await exec("document.querySelector('#flash-firmware').click(); true");
    await waitFor("document.querySelector('#confirm-body').textContent.includes('Резервная копия недоступна')");
    await save('04e-flash-without-backup');
    await exec("document.querySelector('dialog').close('cancel'); fixture.setCurrentAvailable(true); true");
    window.setContentSize(1140, 780);
    await exec("document.querySelector('#dismiss').click(); fixture.go('speech')");
    await save('05-speech');
    await exec("fixture.setModelStatus('parakeet', { downloading: true }, 48)");
    await save('06-model-download');
    await exec("fixture.setModelStatus('parakeet', { installed: true }); fixture.go('agents')");
    await save('07-agents');
    await exec("document.querySelector('[data-agent=claude] .primary').click(); true");
    await waitFor("document.querySelector('dialog').open");
    await save('08-agent-confirmation');
    await exec("document.querySelector('dialog').close('cancel'); true");
    await exec("document.querySelector('#choose-project').click(); true");
    await waitFor("document.querySelector('#project-path').textContent.includes('длинным')");
    await exec('fixture.openTerminal()');
    await waitFor("document.querySelector('#terminal .xterm')");
    await save('09-terminal');
    await exec("fixture.go('hardware'); fixture.connectHid(); fixture.go('overview'); fixture.begin('manual'); true");
    await waitFor("document.querySelector('.hero').dataset.state === 'recording'");
    await save('10-recording');
    await exec("fixture.release('manual'); true");
    await waitFor("document.querySelector('.hero').dataset.state === 'processing'");
    await save('11-processing');
    await waitFor("document.querySelector('#draft-text').value.includes('parser.ts')");
    await save('12-draft');
    await exec("fixture.notify('В записи тишина. Проверьте выбранный микрофон.', true)");
    await save('13-error');
    await exec("document.querySelector('#dismiss').click(); true");
    window.setContentSize(740, 615);
    await save('14-compact');
    const overflowing = await exec("document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth");
    if (overflowing) throw new Error('Horizontal overflow on the compact layout');
    const draftVisible = await exec("document.querySelector('#copy-draft').getBoundingClientRect().bottom < innerHeight");
    if (!draftVisible) throw new Error('Draft actions are below the compact viewport');
    window.setContentSize(1140, 780);
    await exec("document.querySelector('#insert-draft').click(); true");
    await waitFor("fixture.terminalText().includes('parser.ts')");
    await save('15-terminal-draft');
    const external = await exec("!document.querySelector('#output option[value=desktop]').disabled");
    await exec(`document.querySelector('#output').value = '${external ? 'desktop' : 'manual'}';
        document.querySelector('#output').dispatchEvent(new Event('change')); true`);
    await waitFor("document.querySelector('#output-hint').textContent.includes('курсор') || document.querySelector('#output-hint').textContent.includes('скопировать')");
    await save('16-output-settings');
    if (external) {
        await exec("if (!document.querySelector('#auto-insert').checked) document.querySelector('#auto-insert').click(); fixture.go('overview'); true");
        await exec("fixture.begin('hardware'); fixture.release('hardware'); true");
        await waitFor("document.querySelector('#draft-state').textContent.includes('открытое приложение')");
        await save('17-external-draft');

        if (process.platform === 'darwin') {
            const { ipcMain } = require('electron');
            ipcMain.removeHandler('draft:prepare-external');
            ipcMain.handle('draft:prepare-external', () => {
                throw new Error('Focus the input field in the target app before holding PTT.');
            });
            try {
                for (const [language, label, warning] of [
                    ['ru', 'Активное приложение', 'Черновик сохранён в VibeMic. Перед нажатием PTT поставьте курсор в поле ввода нужного приложения.'],
                    ['en', 'Active application', 'Draft saved in VibeMic. Focus the input field in the target app before holding PTT.']
                ]) {
                    await exec(`(() => {
                        const selector = document.querySelector('#ui-language'); selector.value = '${language}';
                        selector.dispatchEvent(new Event('change')); fixture.go('agents'); return true;
                    })()`);
                    await waitFor(`document.querySelector('#output').selectedOptions[0].textContent === ${JSON.stringify(label)}`);
                    window.setContentSize(740, 615);
                    await exec("document.querySelector('#output').closest('.card').scrollIntoView({block:'center'}); true");
                    await save(`17a-active-application-${language}`);
                    await exec("fixture.go('overview'); fixture.begin('hardware'); fixture.release('hardware'); true");
                    await waitFor(`document.querySelector('#notification-text').textContent === ${JSON.stringify(warning)} &&
                        document.querySelector('#draft-text').value.length > 0 && document.querySelector('.hero').dataset.state === 'idle'`);
                    await save(`17b-external-focus-error-${language}`);
                    await exec("document.querySelector('#dismiss').click(); true");
                }
            } finally {
                ipcMain.removeHandler('draft:prepare-external');
                ipcMain.handle('draft:prepare-external', () => 'fixture-draft');
            }
            await exec("document.querySelector('#ui-language').value = 'ru'; document.querySelector('#ui-language').dispatchEvent(new Event('change')); true");
            await waitFor("document.documentElement.lang === 'ru'");
            window.setContentSize(1140, 780);
        }
    }
    await exec("fixture.go('agents'); document.querySelector('#stop-terminal').click(); true");
    await waitFor("document.querySelector('dialog').open");
    await save('18-terminal-confirmation');
    await exec("document.querySelector('dialog').close('cancel'); fixture.go('hardware'); fixture.useSoftDeviceV7()");
    await waitFor("document.querySelector('#volume-status').textContent.includes('0x27000')");
    await save('19-softdevice-v7');
    const previousDraft = await exec("document.querySelector('#draft-text').value");
    await exec("fixture.go('overview'); fixture.begin('hardware'); fixture.disconnectHid(); true");
    await waitFor("document.querySelector('.hero').dataset.state === 'idle' && !document.querySelector('#device-pill').classList.contains('live')");
    if (await exec("document.querySelector('#draft-text').value") !== previousDraft) {
        throw new Error('Disconnect replaced the existing draft');
    }
    await save('20-dongle-disconnected');
    await exec('fixture.connectHid()');
    await waitFor("document.querySelector('#device-pill').classList.contains('live')");
    await save('21-dongle-reconnected');

    await exec(`(async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0.15;
        oscillator.connect(gain);
        oscillator.start();
        await context.resume();
        const media = navigator.mediaDevices;
        const original = media.getUserMedia;
        const review = window.linkReview = { gain, context, original, track: null, allowInput: null };
        media.getUserMedia = async ({ audio }) => {
            if (audio.deviceId.exact !== 'fixture-mic') throw new Error('Opened a different input');
            if (review.holdInput) await new Promise(resolve => { review.allowInput = resolve; });
            const destination = context.createMediaStreamDestination();
            gain.connect(destination);
            review.track = destination.stream.getAudioTracks()[0];
            return destination.stream;
        };
        fixture.go('hardware');
        document.querySelector('#link-check').scrollIntoView({ block: 'nearest' });
        review.holdInput = true;
        document.querySelector('#link-check-toggle').click();
    })()`);
    await waitFor('Boolean(linkReview.allowInput)');
    await save('23-link-opening');
    await exec("document.querySelector('#link-check-toggle').click(); linkReview.holdInput = false; linkReview.allowInput(); true");
    await waitFor("linkReview.track?.readyState === 'ended'");
    await save('24-link-cancelled');
    const toggleLink = "document.querySelector('#link-check-toggle').click(); true";
    const linkReady = "document.querySelector('#link-check-status').textContent.includes('Зажмите PTT')";
    const linkError = "document.querySelector('#link-check-status').dataset.result === 'error'";
    await exec(toggleLink);
    await waitFor(linkReady);
    await save('25-link-ready');
    await new Promise(resolve => setTimeout(resolve, 1700));
    await exec('fixture.handlePtt(true); true');
    await waitFor("document.querySelector('#link-check-status').textContent.includes('PTT нажат')");
    await save('26-link-recording');
    await new Promise(resolve => setTimeout(resolve, 1100));
    await exec(`(() => {
        const original = OfflineAudioContext.prototype.startRendering;
        OfflineAudioContext.prototype.startRendering = async function () {
            OfflineAudioContext.prototype.startRendering = original;
            await new Promise(resolve => { linkReview.finishRendering = resolve; });
            return original.call(this);
        };
        fixture.handlePtt(false, { end: 'released', weakestDbm: -78, silentMs: 15, usbErrors: 1 });
        return true;
    })()`);
    await waitFor('Boolean(linkReview.finishRendering)');
    await save('27-link-finishing');
    await exec('linkReview.finishRendering(); true');
    await waitFor("document.querySelector('#link-check-status').dataset.result === 'success' && document.querySelector('#link-check-audio').readyState >= 1");
    await waitFor("!document.querySelector('#link-check-stats').hidden && document.querySelector('#link-check-stats').textContent.includes('−78 дБм')");
    const result = await exec(`({ duration: document.querySelector('#link-check-audio').duration,
        draft: document.querySelector('#draft-text').value, closed: linkReview.track.readyState === 'ended' })`);
    if (result.duration < 0.45 || result.duration > 1.5 || result.draft !== previousDraft || !result.closed) {
        throw new Error('The board check must only keep audio between PTT edges and leave the draft alone: ' + JSON.stringify(result));
    }
    if (!await exec("document.querySelector('#link-check-stats').getBoundingClientRect().bottom <= innerHeight")) {
        throw new Error('The diagnostic values are below the viewport after completing the test');
    }
    await save('28-link-playback');
    window.setContentSize(740, 600);
    await exec("document.querySelector('#link-check').scrollIntoView({block: 'nearest'}); true");
    const linkOverflow = await exec(`(() => {
        const card = document.querySelector('#link-check');
        return card.scrollWidth > card.clientWidth || document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth;
    })()`);
    if (linkOverflow) throw new Error('Board check has horizontal overflow');
    await save('29-link-compact');
    window.setContentSize(1140, 780);
    await exec(toggleLink);
    await waitFor(linkReady);
    if (!await exec("document.querySelector('#link-check-stats').hidden")) throw new Error('Previous metrics remained visible');
    await exec('fixture.handlePtt(true); true');
    await new Promise(resolve => setTimeout(resolve, 1100));
    await exec("fixture.handlePtt(false, { end: 'radioTimeout', weakestDbm: -89, silentMs: 75, usbErrors: 0 }); true");
    await waitFor("document.querySelector('#link-check-status').textContent.includes('сохранённую часть') && document.querySelector('#link-check-audio').readyState >= 1");
    await exec("document.querySelector('#link-check').scrollIntoView({ block: 'end' }); true");
    await save('29b-link-radio-interrupted');
    await exec("linkReview.gain.gain.value = 0; " + toggleLink);
    await waitFor(linkReady);
    await exec('fixture.handlePtt(true); true');
    await new Promise(resolve => setTimeout(resolve, 550));
    await exec('fixture.handlePtt(false); true');
    await waitFor(linkError);
    if (!await exec("document.querySelector('#link-check-status').textContent.includes('В записи тишина. Проверьте питание и проводку PDM.')")) {
        throw new Error('The board check did not distinguish PTT events from missing audio');
    }
    if (!await exec("document.querySelector('#link-check-stats').hidden")) throw new Error('Legacy report showed stale metrics');
    await save('30-link-no-audio');
    await exec(toggleLink);
    await waitFor(linkReady);
    await exec('fixture.handlePtt(true); fixture.disconnectHid(); true');
    await waitFor(`${linkError} && linkReview.track.readyState === 'ended'`);
    await save('31-link-unplugged');
    await exec("fixture.connectHid(); true");
    await exec(toggleLink);
    await waitFor(linkReady);
    await exec("fixture.go('overview'); true");
    await waitFor("linkReview.track.readyState === 'ended' && !document.querySelector('#manual-ptt').disabled");
    await exec("navigator.mediaDevices.getUserMedia = linkReview.original; linkReview.context.close()");

    await exec("fixture.go('hardware'); fixture.disconnectHid(); fixture.setUsbRule('missing'); document.querySelector('#linux-access').scrollIntoView({ block: 'nearest' }); true");
    await save('32-linux-usb-setup');
    await exec("document.querySelector('#install-usb-rule').click(); true");
    await waitFor("document.querySelector('#confirm-dialog').open");
    await save('33-linux-usb-confirmation');
    await exec("document.querySelector('#confirm-action').click(); true");
    await waitFor("document.querySelector('#install-usb-rule').hidden && document.querySelector('#usb-rule-status').textContent.includes('установлено')");
    await save('34-linux-usb-configured');
    await exec("fixture.connectHid(); true");
    await save('35-linux-usb-connected');
    window.setContentSize(740, 600);
    await exec("fixture.setUsbRule('overridden'); document.querySelector('#linux-access').scrollIntoView({ block: 'nearest' }); true");
    await save('36-linux-usb-override-compact');
    window.setContentSize(1140, 780);
    await exec("fixture.disconnectHid(); fixture.setUsbRule('missing'); fixture.notify('Для установки правила из AppImage нужен pkexec. Можно установить пакет DEB.', true); true");
    await save('37-linux-usb-no-pkexec');

    await exec("document.querySelector('#dismiss').click(); fixture.setUsbRule(null); fixture.go('hardware'); document.querySelector('#pairing-panel summary').click(); document.querySelector('#pairing-panel').scrollIntoView({ block: 'end' }); true");
    await save('38-pair-default');
    await exec("document.querySelector('#generate-pair-code').click(); true");
    await waitFor("document.querySelector('#pair-code').value === '8B27-3DE4' && !document.querySelector('#save-pair-code').disabled");
    if (!await exec("document.querySelector('#active-pair-code').textContent === 'Стендовый адрес'")) {
        throw new Error('Generated code must remain pending until saved');
    }
    await save('39-pair-generated');
    await exec("document.querySelector('#save-pair-code').click(); true");
    await waitFor("document.querySelector('#active-pair-code').textContent === '8B27-3DE4' && !document.querySelector('#copy-pair-code').disabled");
    await save('40-pair-saved');
    await exec("document.querySelector('#dismiss').click(); document.querySelector('#flash-firmware').click(); true");
    await waitFor("document.querySelector('#confirm-dialog').open && document.querySelector('#confirm-body').textContent.includes('код пары 8B27-3DE4')");
    await save('41-pair-flash-confirmation');
    await exec("document.querySelector('#confirm-dialog').close('cancel'); true");
    window.setContentSize(740, 615);
    await exec("document.querySelector('#pairing-panel').scrollIntoView({ block: 'end' }); true");
    await save('42-pair-compact');
    await exec("(() => { const field = document.querySelector('#pair-code'); field.value = 'ошибка'; field.dispatchEvent(new Event('input')); document.querySelector('#save-pair-code').click(); return true; })()");
    await waitFor("document.querySelector('#pair-code-status').textContent.includes('восемь знаков') && !document.querySelector('#pair-code-status').hidden");
    await save('43-pair-invalid');
    await exec("(() => { document.querySelector('#dismiss').click(); const field = document.querySelector('#pair-code'); field.value = ''; field.dispatchEvent(new Event('input')); document.querySelector('#save-pair-code').click(); return true; })()");
    await waitFor("document.querySelector('#active-pair-code').textContent === 'Стендовый адрес'");
    await save('44-pair-reset');
    window.setContentSize(1140, 780);

    await exec("fixture.setModelStatus('parakeet', { damaged: true }); fixture.go('speech'); true");
    await save('45-model-damaged');
    window.setContentSize(740, 615);
    await save('46-model-damaged-compact');
    await exec("fixture.setModelStatus('parakeet', { damaged: true, downloading: true }, 57); document.querySelector('[data-model=parakeet]').scrollIntoView({ block: 'end' }); true");
    await save('47-model-repairing');
    await exec("fixture.setModelStatus('parakeet', { damaged: true }); fixture.go('overview'); true");
    await waitFor("document.querySelector('#ready-model').textContent.includes('Перескачайте')");
    await save('48-model-damaged-overview');
    await exec("fixture.begin('manual'); true");
    await waitFor("document.querySelector('#current-page').textContent === 'Распознавание' && document.querySelector('.hero').dataset.state === 'idle'");
    await save('49-model-damaged-recording-guard');
    await exec("document.querySelector('#dismiss').click(); fixture.setModelStatus('parakeet', { installed: true }); fixture.go('speech'); true");
    await save('50-model-repaired');
    window.setContentSize(1140, 780);

    await exec("fixture.go('overview'); fixture.disconnectHid(); fixture.connectHid(); document.querySelector('#output').value='terminal'; document.querySelector('#output').dispatchEvent(new Event('change')); true");
    await waitFor("document.querySelector('#output-hint').textContent.includes('встроенного терминала')");
    await waitFor("document.querySelector('#ready-device').textContent === 'Готов к записи'");
    if (!await exec("document.querySelector('#auto-insert').checked")) {
        await exec("document.querySelector('#auto-insert').click(); true");
    }
    await waitFor('vibemic.init().then(data => data.settings.autoInsert)');
    const terminalBefore = await exec("fixture.terminalText().split('parser.ts').length");
    await exec('fixture.handlePtt(true); fixture.handlePtt(false); true');
    await waitFor("document.querySelector('.hero').dataset.state === 'processing' && !document.querySelector('#manual-ptt').disabled");
    await save('51-processing-allows-recording');
    await exec('fixture.handlePtt(true); true');
    await waitFor("document.querySelector('.hero').dataset.state === 'recording' && document.querySelector('#capture-hint').textContent.includes('Предыдущая фраза')");
    await save('52-overlapping-capture');
    await exec('fixture.handlePtt(false); true');
    await waitFor("document.querySelector('#capture-hint').textContent.includes('ждёт распознавания') && document.querySelector('#manual-ptt').disabled");
    await save('53-queued-capture');
    await exec('fixture.handlePtt(true); fixture.handlePtt(false); true');
    if (!await exec("document.querySelector('.hero').dataset.state === 'processing' && document.querySelector('#manual-ptt').disabled")) {
        throw new Error('A third take bypassed the one-item queue');
    }
    await waitFor("fixture.terminalText().split('parser.ts').length > " + terminalBefore);
    await exec("(() => { document.querySelector('#dismiss').click(); const field = document.querySelector('#draft-text'); field.focus(); field.value += ' Сохрани правку.'; field.dispatchEvent(new Event('input')); return true; })()");
    await waitFor("!document.querySelector('#draft-select').hidden && document.querySelector('.hero').dataset.state === 'idle'");
    if (!await exec("document.querySelector('#draft-text').value.includes('Сохрани правку') && !fixture.terminalText().includes('Добавь проверку')")) {
        throw new Error('An overlapping transcript replaced the draft being edited or automatically pasted');
    }
    window.setContentSize(740, 615);
    await exec("document.querySelector('.draft').scrollIntoView({ block: 'end' }); true");
    await save('54-two-drafts-preserve-edit');
    await exec("(() => { const select = document.querySelector('#draft-select'); select.selectedIndex = 1; select.dispatchEvent(new Event('change')); return true; })()");
    await waitFor("document.querySelector('#draft-text').value === 'Добавь проверку пустого ввода.'");
    await save('55-two-drafts-latest');
    await exec("(() => { const select = document.querySelector('#draft-select'); select.selectedIndex = 0; select.dispatchEvent(new Event('change')); return true; })()");
    await waitFor("document.querySelector('#draft-text').value.includes('Сохрани правку')");
    await exec("(() => { const select = document.querySelector('#draft-select'); select.selectedIndex = 1; select.dispatchEvent(new Event('change')); return true; })()");
    await exec("document.querySelector('#insert-draft').click(); true");
    await waitFor("fixture.terminalText().includes('Добавь проверку')");
    window.setContentSize(1140, 780);

    if (process.env.VIBEMIC_CAPTURE_REVIEW === '1') {
        const signal = await exec(`(async () => {
            const { openReadyInput, startCapture } = await import('/audio.js');
            const audio = new AudioContext({ sampleRate: 48000 });
            const oscillator = audio.createOscillator();
            const gain = audio.createGain();
            oscillator.connect(gain);
            oscillator.start();
            const getUserMedia = navigator.mediaDevices.getUserMedia;
            let opens = 0;
            let track;
            navigator.mediaDevices.getUserMedia = async () => {
                opens++;
                const destination = audio.createMediaStreamDestination();
                gain.connect(destination);
                track = destination.stream.getAudioTracks()[0];
                return destination.stream;
            };
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            let input;
            try {
                await audio.resume();
                const capture = await startCapture('fixture-signal');
                await sleep(1000);
                const wav = await capture.finish();

                gain.gain.value = 0;
                input = await openReadyInput('fixture-signal');
                const first = input.begin();
                const now = audio.currentTime;
                gain.gain.setValueAtTime(0.5, now + 0.045);
                gain.gain.setValueAtTime(0, now + 0.16);
                await sleep(420);
                const finishing = first.finish();
                const second = input.begin();
                await input.close();
                const prefix = new DataView((await finishing).buffer);
                let peak = 0;
                for (let offset = 44; offset < prefix.byteLength; offset += 2) {
                    peak = Math.max(peak, Math.abs(prefix.getInt16(offset, true)));
                }
                const remainedOpen = track.readyState === 'live';
                await sleep(330);
                const silence = await second.finish().then(() => false, error => error.cause === 'silence');
                return { bytes: wav.length, rate: new DataView(wav.buffer).getUint32(24, true),
                    opens, peak, silence, remainedOpen, closed: track.readyState === 'ended' };
            } finally {
                navigator.mediaDevices.getUserMedia = getUserMedia;
                await input?.close();
                await audio.close();
            }
        })()`);
        if (signal.rate !== 16000 || signal.bytes < 16000) throw new Error('Capture did not produce 16 kHz PCM');
        if (signal.opens !== 2 || signal.peak < 10000 || !signal.silence || !signal.remainedOpen || !signal.closed) {
            throw new Error('Prepared input did not preserve the first samples and isolate consecutive takes: ' + JSON.stringify(signal));
        }
        console.log('AudioWorklet produced 16 kHz PCM and kept the stream until both overlapping collectors closed.');
    }
    await exec("fixture.go('overview'); fixture.preparingInput(); true");
    await waitFor("document.querySelector('#ready-device').textContent === 'Подготовка аудиовхода'");
    await save('22-preparing-usb-input');

    const localData = require('electron').app.getPath('userData');
    const importFile = path.join(localData, 'import-profile.json');
    const previous = await exec('vibemic.init()');
    const profile = { format: 'vibemic-profile', version: 1, settings: {
        model: 'parakeet', language: 'de', agent: 'claude', output: 'desktop', autoInsert: false, pairCode: '3C7F-10E2',
        project: '/ignored/project', microphone: 'ignored-input'
    } };
    await fs.writeFile(importFile, JSON.stringify(profile));
    await exec("document.querySelector('#dismiss').click(); document.querySelector('[data-page=settings]').click(); true");
    await waitFor("document.querySelector('#current-page').textContent === 'Настройки'");
    await save('66-settings');
    window.setContentSize(740, 615);
    await save('67-settings-compact');
    await exec("document.querySelector('#export-profile').click(); true");
    await waitFor("document.querySelector('#notification-text').textContent.includes('Профиль сохранён')");
    const saved = JSON.parse(await fs.readFile(path.join(localData, 'export-profile.json'), 'utf8'));
    if (saved.format !== 'vibemic-profile' || saved.settings.project || saved.settings.microphone || saved.settings.agentPaths) {
        throw new Error('Export did not isolate portable settings');
    }
    await save('68-profile-exported');
    await exec("document.querySelector('#dismiss').click(); document.querySelector('#import-profile').click(); true");
    await waitFor("document.querySelector('#confirm-dialog').open && document.querySelector('#confirm-details').textContent.includes('3C7F-10E2')");
    await save('69-profile-review');
    await exec("document.querySelector('#confirm-dialog').close('cancel'); true");
    await waitFor("!document.querySelector('#import-profile').disabled");
    if (await exec('vibemic.init().then(data=>JSON.stringify(data.settings))') !== JSON.stringify(previous.settings)) {
        throw new Error('Canceling import changed the settings');
    }
    await exec("document.querySelector('#import-profile').click(); true");
    await waitFor("document.querySelector('#confirm-dialog').open");
    await exec("document.querySelector('#confirm-action').click(); true");
    await waitFor("document.querySelector('#notification-text').textContent === 'Профиль применён.'");
    const current = await exec('vibemic.init().then(data=>data.settings)');
    if (current.pairCode !== '3C7F-10E2' || current.language !== 'auto' || current.model !== 'parakeet' ||
        current.agent !== 'claude' || current.output !== (previous.external ? 'desktop' : 'manual') ||
        current.autoInsert || current.project !== previous.settings.project || current.microphone !== previous.settings.microphone) {
        throw new Error('Import did not apply the reviewed portable settings');
    }
    await save('70-profile-imported');
    await fs.writeFile(importFile, '{ broken JSON');
    await exec("document.querySelector('#dismiss').click(); document.querySelector('#import-profile').click(); true");
    await waitFor("document.querySelector('#notification-text').textContent === 'Файл профиля содержит некорректный JSON.'");
    await save('71-profile-invalid');
    if (await exec('vibemic.init().then(data=>JSON.stringify(data.settings))') !== JSON.stringify(current)) {
        throw new Error('An invalid profile changed the settings');
    }

    const chooseSerial = ports => {
        let selected;
        window.webContents.session.emit('select-serial-port', { preventDefault() {} }, ports,
            window.webContents, value => { selected = value; });
        return selected;
    };
    if (chooseSerial([{ portId: 'probe', vendorId: '1209', productId: '0002' }]) !== 'probe' ||
        chooseSerial([{ portId: 'other', vendorId: '2341', productId: '0002' }]) !== '' ||
        chooseSerial([{ portId: 'one', vendorId: '1209', productId: '0002' },
            { portId: 'two', vendorId: '1209', productId: '0002' }]) !== '') {
        throw new Error('Serial selection did not isolate one PDM Probe');
    }
    await exec(`(() => {
        if (!navigator.serial) throw new Error('Web Serial is unavailable at the VibeMic origin');
        const review = window.pdmReview = { mode: 'hold', closed: 0 };
        review.pcm = new Uint8Array(96000);
        const samples = new DataView(review.pcm.buffer);
        for (let i = 0; i < 48000; i++) samples.setInt16(i * 2, Math.round(8192 * Math.sin(2 * Math.PI * 440 * i / 16000)), true);
        review.finish = () => {
            const response = new Uint8Array(96004);
            response.set(new TextEncoder().encode('VMIC'));
            response.set(review.pcm, 4);
            for (let i = 0; i < response.length; i += 137) review.incoming.enqueue(response.slice(i, i + 137));
        };
        Object.defineProperty(navigator.serial, 'requestPort', { configurable: true, value: async () => {
            const readable = new ReadableStream({ start(controller) { review.incoming = controller; } });
            const writable = new WritableStream({ write(bytes) {
                if (bytes.length !== 1 || bytes[0] !== 0x52) throw new Error('Unexpected probe command');
                if (review.mode === 'error') review.incoming.enqueue(new TextEncoder().encode('VERR'));
            } });
            return { readable, writable, async open() {}, async setSignals() {}, async close() {
                if (readable.locked || writable.locked) throw new Error('Probe retained a stream lock');
                review.closed++;
            } };
        } });
        fixture.go('hardware');
        document.querySelector('#dismiss').click();
        document.querySelector('#pdm-probe-panel').open = true;
        document.querySelector('#pdm-probe-panel').scrollIntoView({block:'end'});
        return true;
    })()`);
    window.setContentSize(1140, 780);
    await save('73-pdm-probe-ready');
    await exec("document.querySelector('#pdm-prepare').click(); document.querySelector('#flash-firmware').click(); true");
    await waitFor("document.querySelector('#confirm-dialog').open && document.querySelector('#confirm-title').textContent.includes('PDM Probe')");
    if (await exec("document.querySelector('#confirm-body').textContent.includes('3C7F-10E2')")) {
        throw new Error('Probe confirmation incorrectly promised a radio pair code');
    }
    await save('74-pdm-probe-firmware-confirmation');
    await exec("document.querySelector('#confirm-dialog').close('cancel'); document.querySelector('#pdm-record').click(); document.querySelector('#pdm-probe-panel').scrollIntoView({block:'end'}); true");
    await waitFor("document.querySelector('#pdm-status').textContent.includes('Записываем три секунды')");
    await save('75-pdm-probe-recording');
    await exec('pdmReview.finish(); true');
    await waitFor("document.querySelector('#pdm-status').dataset.result === 'success' && !document.querySelector('#pdm-levels').hidden");
    window.setContentSize(740, 615);
    await exec("document.querySelector('#pdm-probe-panel').scrollIntoView({block:'end'}); true");
    await save('76-pdm-probe-result-compact');
    await exec("document.querySelector('#pdm-save').click(); true");
    await waitFor("document.querySelector('#notification-text').textContent.includes('Запись PDM сохранена')");
    const clip = await fs.readFile(path.join(localData, 'pdm-check.wav'));
    if (clip.length !== 96044 || clip.readUInt32LE(24) !== 16000 || clip.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error('Saved an invalid PDM WAV');
    }
    await save('77-pdm-probe-saved');
    await exec("document.querySelector('#dismiss').click(); pdmReview.mode='error'; document.querySelector('#pdm-record').click(); true");
    await waitFor("document.querySelector('#pdm-status').textContent.includes('ошибке PDM') && document.querySelector('#pdm-record').textContent === 'Записать 3 секунды'");
    await save('78-pdm-probe-device-error');
    await exec("pdmReview.mode='hold'; document.querySelector('#pdm-record').click(); true");
    await waitFor("document.querySelector('#pdm-status').textContent.includes('Записываем три секунды')");
    await exec("document.querySelector('#pdm-record').click(); true");
    await waitFor("document.querySelector('#pdm-status').textContent.includes('Отменяем проверку') && document.querySelector('#pdm-record').disabled");
    await save('87-pdm-probe-cancelling');
    if (await exec('pdmReview.closed !== 2')) throw new Error('Cancellation closed the serial port before draining');
    await exec('pdmReview.finish(); true');
    await waitFor("document.querySelector('#pdm-status').textContent.includes('отменена')");
    await save('79-pdm-probe-cancelled');
    await exec("document.querySelector('#pdm-record').click(); true");
    await waitFor("document.querySelector('#pdm-status').textContent.includes('Записываем три секунды')");
    await exec('pdmReview.finish(); true');
    await waitFor("document.querySelector('#pdm-status').dataset.result === 'success' && pdmReview.closed === 4");
    await save('88-pdm-probe-retry');
    await exec("document.querySelector('#pdm-record').click(); true");
    await waitFor("document.querySelector('#pdm-status').textContent.includes('Записываем три секунды')");
    await exec("fixture.go('speech'); fixture.go('hardware'); document.querySelector('#pdm-probe-panel').open = true; document.querySelector('#pdm-probe-panel').scrollIntoView({block:'end'}); true");
    await waitFor("document.querySelector('#pdm-status').textContent.includes('Отменяем проверку') && document.querySelector('#pdm-record').disabled");
    await save('89-pdm-probe-navigation-cancel');
    await exec('pdmReview.finish(); true');
    await waitFor("pdmReview.closed === 5 && !document.querySelector('#pdm-record').disabled");
    await exec("document.querySelector('#pdm-record').click(); true");
    await waitFor("document.querySelector('#pdm-status').textContent.includes('Записываем три секунды')");
    await exec("document.querySelector('#pdm-record').click(); true");
    await waitFor("document.querySelector('#pdm-status').textContent.includes('15 секунд') && pdmReview.closed === 6", 600);
    await save('90-pdm-probe-timeout');
    await exec("document.querySelector('#pdm-restore').click(); true");
    if (!await exec("document.querySelector('#board-role').value === 'transmitter'")) throw new Error('Probe could not select the regular transmitter');
    await save('80-pdm-probe-restore');
    await exec("fixture.setUsbRule('outdated'); document.querySelector('#linux-access').scrollIntoView({block:'end'}); true");
    await save('81-pdm-linux-rule-update');
    await exec("fixture.setUsbRule('missing'); true");
    await save('83-pdm-linux-rule-missing');
    await exec("document.querySelector('#install-usb-rule').click(); true");
    await waitFor("document.querySelector('#confirm-dialog').open");
    if (!await exec("document.querySelector('#confirm-body').textContent.includes('PDM Probe')")) {
        throw new Error('USB permission confirmation omitted the probe');
    }
    await save('84-pdm-linux-rule-confirmation');
    await exec("document.querySelector('#confirm-action').click(); true");
    await waitFor("document.querySelector('#usb-rule-status').textContent.includes('PDM Probe установлено')");
    await save('85-pdm-linux-rule-configured');
    await exec("fixture.disconnectHid(); document.querySelector('#linux-access').scrollIntoView({block:'end'}); true");
    await waitFor("document.querySelector('#usb-rule-status').textContent.includes('Переподключите нужную плату')");
    await save('86-pdm-linux-rule-probe-only');
    // Switching the UI language must preserve spoken language and user data.
    const beforeLocale = await exec("vibemic.init().then(value => ({ language: value.settings.language, microphone: value.settings.microphone, project: value.settings.project, pairCode: value.settings.pairCode }))");
    const literalDraft = 'Настройки — keep this user text / 日本語';
    await exec("fixture.go('overview'); document.querySelector('#draft-text').value=" + JSON.stringify(literalDraft) + "; document.querySelector('#draft-text').dispatchEvent(new Event('input')); fixture.go('settings'); true");
    for (const language of ['en', 'ru']) {
        await exec("document.querySelector('#ui-language').value=" + JSON.stringify(language) + "; document.querySelector('#ui-language').dispatchEvent(new Event('change')); true");
        await waitFor("document.documentElement.lang===" + JSON.stringify(language));
        await waitFor("vibemic.init().then(value => value.settings.uiLanguage===" + JSON.stringify(language) + ")");
        if (await exec("document.querySelector('#draft-text').value") !== literalDraft) throw new Error('Language switch rewrote user text');
        const afterLocale = await exec("vibemic.init().then(value => ({ language: value.settings.language, microphone: value.settings.microphone, project: value.settings.project, pairCode: value.settings.pairCode }))");
        if (JSON.stringify(beforeLocale) !== JSON.stringify(afterLocale)) throw new Error('UI language switch changed recording or device settings');
        window.setContentSize(1140, 780);
        await exec("fixture.go('settings'); true");
        await save('91-language-' + language);
        window.setContentSize(740, 615);
        await save('92-language-compact-' + language);

        await exec(`fixture.setMicrophones([
            { deviceId: 'fixture-mic', label: 'PTT Dictation Mic' },
            { deviceId: 'fixture-wired', label: 'PTT Dictation Mic (USB)' }
        ]); fixture.connectWired(); fixture.go('overview'); true`);
        const status = language === 'en' ? 'Microphone connected by USB' : 'Микрофон подключён по USB';
        await waitFor(`document.querySelector('#device-pill').textContent.includes(${JSON.stringify(status)})`);
        await save('93-wired-overview-' + language);
        window.setContentSize(1140, 780);
        await exec("fixture.go('hardware'); true");
        if (!await exec(`document.querySelector('#connect-hid').textContent === ${JSON.stringify(status)} &&
            !document.querySelector('#link-check-toggle').disabled`)) {
            throw new Error('The wired microphone did not enable the board check');
        }
        await save('94-wired-hardware-' + language);
        await exec("fixture.go('speech'); true");
        await waitFor("document.querySelector('#mic-status').textContent.includes('PTT Dictation Mic (USB)')");
        await save('95-wired-speech-' + language);
        await exec("fixture.disconnectHid(); fixture.setMicrophones(); fixture.connectHid(); true");
    }
    console.log('VibeMic UI review passed.');
};
