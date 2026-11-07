'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MODELS, SpeechModels } = require('../src/models.cjs');

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibemic-model-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return { directory, models: new SpeechModels(directory, '') };
}

test('startup distinguishes a missing, truncated, and same-size damaged model', async t => {
    const { models } = await fixture(t);
    const missing = { installed: false, damaged: false, downloading: false };
    const damaged = { installed: false, damaged: true, downloading: false };
    assert.deepEqual((await models.statuses()).base, missing);
    await assert.rejects(models.verify('base'), /Сначала установите/);

    const file = models.file('base');
    await fs.writeFile(file, 'incomplete');
    assert.deepEqual((await models.statuses()).base, damaged);
    await fs.truncate(file, MODELS.base.size);
    assert.deepEqual((await models.statuses()).base, damaged);
    await assert.rejects(models.verify('base'), /повреждён/);
});

test('a failed replacement leaves the previous model file and removes the temporary download', async t => {
    const { directory, models } = await fixture(t);
    const file = models.file('base');
    const existing = Buffer.from('existing local model');
    await fs.writeFile(file, existing);
    t.mock.method(globalThis, 'fetch', async () => new Response('incomplete replacement'));

    await assert.rejects(models.install('base', () => {}), /Контрольная сумма/);
    assert.deepEqual(await fs.readFile(file), existing);
    assert.deepEqual(await fs.readdir(directory), [MODELS.base.file]);
    assert.equal((await models.statuses()).base.downloading, false);
});
