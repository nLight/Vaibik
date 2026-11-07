'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('the English catalog covers every message with matching placeholders', async () => {
    const { default: messages } = await import('../ui/translations.mjs');
    const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
    for (const [source, english] of Object.entries(messages)) {
        assert.ok(english.trim(), source);
        assert.doesNotMatch(english, /[А-Яа-яЁё]/, source);
        assert.deepEqual(placeholders(english), placeholders(source), source);
    }
});

test('translation preserves interpolated values and supports stored UI messages', async () => {
    const { t, setLanguage, translate } = await import('../ui/i18n.mjs');
    setLanguage('en');
    assert.equal(t`Разметка S140 v${7} · приложение 0x${'27000'}.`, 'S140 v7 layout · application at 0x27000.');
    assert.equal(t`Установить ${'Код с кириллицей'}?`, 'Install Код с кириллицей?');
    assert.equal(translate('Сервер моделей ответил 503.', 'en'), 'The model server returned 503.');
    assert.equal(translate('Session ended with code 2.', 'ru'), 'Сессия завершилась, код 2.');
    assert.equal(translate('Пользовательский текст /my/project', 'en'), 'Пользовательский текст /my/project');
    setLanguage('ru');
    assert.equal(t('Choose a microphone'), 'Выберите микрофон');
});
