'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MODELS } = require('./models.cjs');
const { AGENTS } = require('./agents.cjs');
const { normalizePairCode } = require('./firmware.cjs');

const LANGUAGES = Object.freeze(['auto', 'ru', 'en', 'de']);
const OUTPUTS = Object.freeze(['terminal', 'desktop', 'manual']);
const DICTATION_MODES = Object.freeze(['local', 'auto']);
const format = 'vibemic-profile';
const version = 1;
const limit = 16 * 1024;

function portableSettings(value) {
    if (!value || typeof value.model !== 'string' ||
        (!Object.hasOwn(MODELS, value.model) && !['base', 'small'].includes(value.model)) ||
        typeof value.agent !== 'string' || !Object.hasOwn(AGENTS, value.agent) ||
        !LANGUAGES.includes(value.language) || !OUTPUTS.includes(value.output) ||
        typeof value.autoInsert !== 'boolean' || typeof value.pairCode !== 'string' ||
        (value.dictationMode !== undefined && !DICTATION_MODES.includes(value.dictationMode))) {
        throw new Error('В профиле указаны неподдерживаемые настройки.');
    }
    const { agent, output, autoInsert } = value;
    return { model: 'parakeet', language: 'auto', agent, output, autoInsert,
        dictationMode: value.dictationMode ?? 'local', pairCode: normalizePairCode(value.pairCode) };
}

function parseProfile(contents) {
    let document;
    try { document = JSON.parse(contents.replace(/^\uFEFF/, '')); }
    catch { throw new Error('Файл профиля содержит некорректный JSON.'); }
    if (document?.format !== format) throw new Error('Выберите файл профиля, экспортированный из VibeMic.');
    if (document.version !== version) throw new Error('Эта версия профиля VibeMic пока не поддерживается.');
    return portableSettings(document.settings);
}

async function readProfile(file) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > limit) throw new Error('Выберите файл профиля размером до 16 КБ.');
        const data = Buffer.alloc(limit + 1);
        let size = 0;
        while (size < data.length) {
            const { bytesRead } = await handle.read(data, size, data.length - size, size);
            if (!bytesRead) break;
            size += bytesRead;
        }
        if (size > limit) throw new Error('Выберите файл профиля размером до 16 КБ.');
        return parseProfile(data.toString('utf8', 0, size));
    } finally { await handle.close(); }
}

async function writeProfile(file, settings, configPath) {
    const directory = await fs.realpath(path.dirname(file));
    const destination = path.join(directory, path.basename(file));
    const config = path.join(await fs.realpath(path.dirname(configPath)), path.basename(configPath));
    const currentFile = await fs.realpath(destination).catch(error => {
        if (error.code === 'ENOENT') return destination;
        throw error;
    });
    const comparable = value => process.platform === 'linux' ? value : value.toLowerCase();
    if ([currentFile, destination].some(value => comparable(value) === comparable(config))) {
        throw new Error('Сохраните профиль отдельно от внутреннего файла настроек VibeMic.');
    }
    const contents = JSON.stringify({ format, version, settings: portableSettings(settings) }, null, 2) + '\n';
    const temporary = path.join(directory, `.vibemic-${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

module.exports = { LANGUAGES, OUTPUTS, DICTATION_MODES, portableSettings, readProfile, writeProfile };
