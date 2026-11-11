'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FILES, validateUF2, inspectBootloader, flashFirmware,
    normalizePairCode, generatePairCode } = require('../src/firmware.cjs');

function block(address = 0x26000, index = 0, count = 1) {
    const data = Buffer.alloc(512);
    [0x0a324655, 0x9e5d5157, 0x2000, address, 256, index, count, 0xada52840]
        .forEach((value, word) => data.writeUInt32LE(value, 4 * word));
    data.writeUInt32LE(0x0ab16f30, 508);
    return data;
}

const pairTemplate = Buffer.from('564942454d494352463031619b46d200', 'hex');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibemic-uf2-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const volume = path.join(root, 'NICENANO');
    const images = path.join(root, 'firmware');
    await fs.mkdir(volume);
    await fs.mkdir(images);
    const info = path.join(volume, 'INFO_UF2.TXT');
    const report = (board, softDevice = '') => fs.writeFile(info,
        `UF2 Bootloader 0.9.2\r\nModel: nice!nano\r\nBoard-ID: ${board}\r\n${softDevice}`);
    return { root, volume, images, report, backups: path.join(root, 'backups') };
}

test('UF2 app blocks are aligned, contiguous and unique', () => {
    assert.doesNotThrow(() => validateUF2(Buffer.concat([block(0x26100, 1, 2), block(0x26000, 0, 2)])));
    assert.throws(() => validateUF2(block(0x27000)), /разметкой/);
    assert.throws(() => validateUF2(block(0xf0000)), /границы/);
    assert.throws(() => validateUF2(Buffer.concat([block(0x26000, 0, 2), block(0x26200, 1, 2)])), /разметкой/);
    assert.throws(() => validateUF2(Buffer.concat([block(0x26000, 0, 2), block(0x26100, 0, 2)])), /границы/);
    const invalidFamily = block();
    invalidFamily.writeUInt32LE(0, 28);
    assert.throws(() => validateUF2(invalidFamily), /nRF52840/);
});

test('loader verification rejects a different board or incompatible flash map', async t => {
    const { volume, report } = await fixture(t);
    const current = path.join(volume, 'CURRENT.UF2');
    await report('nRF52840-SeeedXiao', 'SoftDevice: S140 6.1.1');
    await assert.rejects(inspectBootloader(volume), /не распознана/);
    await report('nRF52840-nicenano', 'SoftDevice: S140 6.1.1');
    await fs.writeFile(current, block(0x27000));
    await assert.rejects(inspectBootloader(volume), /разметку/);
    await fs.writeFile(current, block(0x1000));
    assert.equal((await inspectBootloader(volume)).address, 0x26000);
    await report('nRF52840-nicenano', 'SoftDevice: S140 version 6.1.1\r\nDate: Jun 19 2021');
    assert.equal((await inspectBootloader(volume)).address, 0x26000);
    await report('nRF52840-nicenano-v2', 'SoftDevice: S140 6.1.1');
    assert.equal((await inspectBootloader(volume)).address, 0x26000);
    await report('nRF52840-nicenano', 'SoftDevice: S140 7.3.0');
    assert.equal((await inspectBootloader(volume)).address, 0x27000);
    await report('nRF52840-nicenano');
    await assert.rejects(inspectBootloader(volume), /разметку/);
    await fs.writeFile(current, block());
    assert.equal((await inspectBootloader(volume)).address, 0x26000);
});

test('flash selects the requested role and preserves an existing UF2 file', async t => {
    const { root, volume, images, report, backups } = await fixture(t);
    await report('nRF52840-nicenano', 'SoftDevice: S140 6.1.1');
    const tx = block();
    const rx = block();
    rx[33] = 0xff;
    await fs.writeFile(path.join(images, FILES.transmitter), tx);
    await fs.writeFile(path.join(images, FILES.receiver), rx);
    await assert.rejects(flashFirmware(volume, 'unknown', root), /роль/);
    const v6Identity = (await inspectBootloader(volume)).identity;
    assert.deepEqual(await flashFirmware(volume, 'receiver', root, v6Identity, backups),
        { role: 'receiver', backupSaved: false });
    await assert.rejects(fs.access(backups), { code: 'ENOENT' });
    const written = path.join(volume, 'VIBEMIC.UF2');
    assert.deepEqual(await fs.readFile(written), rx);
    await assert.rejects(flashFirmware(volume, 'transmitter', root, v6Identity, backups), { code: 'EEXIST' });
    assert.deepEqual(await fs.readFile(written), rx);
    await fs.unlink(written);
    const v7 = block(0x27000);
    await fs.writeFile(path.join(images, 'promicro-receiver-s140v7.uf2'), v7);
    await report('nRF52840-supermini', 'SoftDevice: S140 7.3.0');
    await flashFirmware(volume, 'receiver', root, (await inspectBootloader(volume)).identity, backups);
    assert.deepEqual(await fs.readFile(written), v7);
});

test('probe firmware uses the selected flash map without applying the radio pair code', async t => {
    const { volume, images, report, root, backups } = await fixture(t);
    for (const [version, address, suffix] of [[6, 0x26000, ''], [7, 0x27000, '-s140v7']]) {
        await report('nRF52840-nicenano', `SoftDevice: S140 ${version}.1.1`);
        const image = block(address);
        await fs.writeFile(path.join(images, `promicro-mic-probe${suffix}.uf2`), image);
        const { identity } = await inspectBootloader(volume);
        await flashFirmware(volume, 'mic-probe', root, identity, backups, '8B27-3DE4');
        assert.deepEqual(await fs.readFile(path.join(volume, 'VIBEMIC.UF2')), image);
        await fs.unlink(path.join(volume, 'VIBEMIC.UF2'));
    }
});

test('flash rejects a replacement volume at the path that was confirmed', async t => {
    const { root, volume, images, report, backups } = await fixture(t);
    const info = 'SoftDevice: S140 6.1.1';
    const written = path.join(volume, 'VIBEMIC.UF2');
    await report('nRF52840-nicenano', info);
    await fs.writeFile(path.join(images, FILES.receiver), block());
    const confirmed = (await inspectBootloader(volume)).identity;

    await report('nRF52840-nicenano', `${info}\r\nDate: another loader build`);
    await assert.rejects(flashFirmware(volume, 'receiver', root, confirmed, backups), /Диск загрузчика изменился/);
    await assert.rejects(fs.access(written), { code: 'ENOENT' });

    await fs.rename(volume, path.join(root, 'previous-volume'));
    await fs.mkdir(volume);
    await report('nRF52840-nicenano', info);
    await assert.rejects(flashFirmware(volume, 'receiver', root, confirmed, backups), /Диск загрузчика изменился/);
    await assert.rejects(fs.access(written), { code: 'ENOENT' });
});

test('flash preserves each board-specific readback and its loader report', async t => {
    const { root, volume, images, report, backups } = await fixture(t);
    await report('nRF52840-nicenano', 'SoftDevice: S140 6.1.1');
    const current = path.join(volume, 'CURRENT.UF2');
    const readback = Buffer.concat([block(0x1000, 0, 2), block(0x1100, 1, 2)]);
    readback.writeUInt32LE(0x239a00b3, 28);
    readback.writeUInt32LE(0x239a00b3, 512 + 28);
    await fs.writeFile(current, readback);
    await fs.writeFile(path.join(images, FILES.receiver), block());
    const inspected = await inspectBootloader(volume);
    assert.equal(inspected.hasCurrent, true);
    assert.deepEqual(await flashFirmware(volume, 'receiver', root, inspected.identity, backups),
        { role: 'receiver', backupSaved: true });
    const [first] = await fs.readdir(backups);
    assert.deepEqual(await fs.readFile(path.join(backups, first, 'CURRENT.UF2')), readback);
    assert.deepEqual(await fs.readFile(path.join(backups, first, 'INFO_UF2.TXT')),
        await fs.readFile(path.join(volume, 'INFO_UF2.TXT')));

    await fs.unlink(path.join(volume, 'VIBEMIC.UF2'));
    readback[32] = 0x3a;
    await fs.writeFile(current, readback);
    await flashFirmware(volume, 'receiver', root, inspected.identity, backups);
    const entries = await fs.readdir(backups);
    assert.equal(entries.length, 2);
    const firstImage = await fs.readFile(path.join(backups, first, 'CURRENT.UF2'));
    assert.equal(firstImage[32], 0);
    assert.deepEqual(await fs.readFile(path.join(backups, entries.find(entry => entry !== first), 'CURRENT.UF2')), readback);
});

test('flash stops before writing if readback is incomplete or its backup cannot be saved', async t => {
    const { root, volume, images, report, backups } = await fixture(t);
    await report('nRF52840-nicenano', 'SoftDevice: S140 6.1.1');
    await fs.writeFile(path.join(images, FILES.receiver), block());
    const current = path.join(volume, 'CURRENT.UF2');
    const written = path.join(volume, 'VIBEMIC.UF2');
    await fs.writeFile(current, block(0x26000, 0, 2));
    const confirmed = (await inspectBootloader(volume)).identity;
    await assert.rejects(flashFirmware(volume, 'receiver', root, confirmed, backups), /прочитан не полностью/);
    await assert.rejects(fs.access(written), { code: 'ENOENT' });
    await assert.rejects(fs.access(backups), { code: 'ENOENT' });

    await fs.writeFile(current, block());
    await fs.writeFile(backups, 'A file occupies the backup path.');
    await assert.rejects(flashFirmware(volume, 'receiver', root, confirmed, backups), /сохранить резервную копию/);
    await assert.rejects(fs.access(written), { code: 'ENOENT' });
});

test('pair codes normalize the default, pasted addresses and generated codes', () => {
    assert.equal(normalizePairCode('  8b273de4\n'), '8B27-3DE4');
    assert.equal(normalizePairCode('619b-46d2'), '');
    assert.equal(normalizePairCode(''), '');
    assert.throws(() => normalizePairCode('8B-273DE4'), /восемь знаков/);
    assert.throws(() => normalizePairCode('0000-0000'), /разными байтами/);
    const generated = generatePairCode();
    assert.match(generated, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
    assert.equal(normalizePairCode(generated), generated);
});

test('both flash maps and roles write only the selected pair address', async t => {
    const { root, volume, images, report, backups } = await fixture(t);
    for (const [version, address, suffix] of [[6, 0x26000, ''], [7, 0x27000, '-s140v7']]) {
        await report('nRF52840-nicenano', `SoftDevice: S140 ${version}.1.1`);
        const { identity } = await inspectBootloader(volume);
        for (const role of ['transmitter', 'receiver']) {
            const image = block(address);
            const file = path.join(images, `promicro-${role}${suffix}.uf2`);
            const written = path.join(volume, 'VIBEMIC.UF2');
            image.set(pairTemplate, 48);
            await fs.writeFile(file, image);
            await flashFirmware(volume, role, root, identity, backups, '00A5-1234');
            const expected = Buffer.from(image);
            expected.set([0x00, 0xa5, 0x12, 0x34], 59);
            assert.deepEqual(await fs.readFile(written), expected);
            assert.deepEqual(await fs.readFile(file), image);
            await fs.unlink(written);
        }
    }
});

test('custom pairing refuses absent, ambiguous or misplaced slots before writing', async t => {
    const { root, volume, images, report, backups } = await fixture(t);
    await report('nRF52840-nicenano', 'SoftDevice: S140 6.1.1');
    await fs.writeFile(path.join(volume, 'CURRENT.UF2'), block());
    const { identity } = await inspectBootloader(volume);
    for (const offsets of [[], [48, 64], [49], [288]]) {
        const image = block();
        for (const offset of offsets) image.set(pairTemplate, offset);
        await fs.writeFile(path.join(images, FILES.receiver), image);
        await assert.rejects(flashFirmware(volume, 'receiver', root, identity, backups, '8B27-3DE4'), /слота для кода пары/);
        await assert.rejects(fs.access(path.join(volume, 'VIBEMIC.UF2')), { code: 'ENOENT' });
        await assert.rejects(fs.access(backups), { code: 'ENOENT' });
    }
});

test('nice!nano v2 battery firmware is an explicit role with both flash maps', async t => {
    const { volume, images, report, backups } = await fixture(t);
    for (const [version, start] of [[6, 0x26000], [7, 0x27000]]) {
        await report('nRF52840-nicenano', `SoftDevice: S140 ${version}.0.0`);
        const image = block(start);
        pairTemplate.copy(image, 64);
        const name = FILES['transmitter-v2-battery'].replace('.uf2', version === 7 ? '-s140v7.uf2' : '.uf2');
        await fs.writeFile(path.join(images, name), image);
        const loader = await inspectBootloader(volume);
        await flashFirmware(volume, 'transmitter-v2-battery', path.dirname(images), loader.identity, backups, '8B27-3DE4');
        const written = await fs.readFile(path.join(volume, 'VIBEMIC.UF2'));
        assert.equal(written.readUInt32LE(12), start);
        assert.ok(written.includes(Buffer.from('8B273DE4', 'hex')));
        await fs.unlink(path.join(volume, 'VIBEMIC.UF2'));
    }
});
