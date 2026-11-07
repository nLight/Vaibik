'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readProfile, writeProfile } = require('../src/profile.cjs');

const portable = { model: 'base', language: 'ru', agent: 'claude', output: 'desktop', autoInsert: false, pairCode: '8B27-3DE4' };

async function directory(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibemic-profile-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
}

test('profile round-trips supported settings without exporting local paths or microphone IDs', async t => {
    const dir = await directory(t);
    const file = path.join(dir, 'profile.json');
    const settings = { ...portable, pairCode: portable.pairCode.toLowerCase(), microphone: 'local-device',
        project: '/local/project', agentPaths: { claude: '/local/cli' } };
    await writeProfile(file, settings, path.join(dir, 'settings.json'));
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { format: 'vibemic-profile', version: 1, settings: portable });
    assert.deepEqual(await readProfile(file), portable);
});

test('import validates the version and types and ignores machine-specific fields', async t => {
    const dir = await directory(t);
    const file = path.join(dir, 'profile.json');
    const document = { format: 'vibemic-profile', version: 1, settings: { ...portable, project: '/other/project' } };
    await fs.writeFile(file, '\uFEFF' + JSON.stringify(document));
    assert.deepEqual(await readProfile(file), portable);
    await fs.writeFile(file, JSON.stringify({ ...document, version: 2 }));
    await assert.rejects(readProfile(file), /версия профиля/);
    await fs.writeFile(file, JSON.stringify({ ...document, settings: { ...portable, model: ['base'] } }));
    await assert.rejects(readProfile(file), /неподдерживаемые настройки/);
    await fs.writeFile(file, ' '.repeat(16385));
    await assert.rejects(readProfile(file), /16 КБ/);
});

test('export protects the live config and removes temporary files when saving fails', async t => {
    const dir = await directory(t);
    const config = path.join(dir, 'settings.json');
    const alias = path.join(dir, 'alias.json');
    const blocked = path.join(dir, 'directory.json');
    await fs.writeFile(config, 'keep');
    await fs.symlink(config, alias);
    await fs.mkdir(blocked);
    await assert.rejects(writeProfile(config, portable, config), /внутреннего файла настроек/);
    await assert.rejects(writeProfile(alias, portable, config), /внутреннего файла настроек/);
    await assert.rejects(writeProfile(blocked, portable, config));
    assert.equal(await fs.readFile(config, 'utf8'), 'keep');
    assert.deepEqual((await fs.readdir(dir)).sort(), ['alias.json', 'directory.json', 'settings.json']);
});
