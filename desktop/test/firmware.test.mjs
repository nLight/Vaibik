import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUF2, normalizePairCode, generatePairCode, setPairAddress } from '../../tools/uf2.mjs';

function block(address = 0x26000, index = 0, count = 1) {
    const data = Buffer.alloc(512);
    [0x0a324655, 0x9e5d5157, 0x2000, address, 256, index, count, 0xada52840]
        .forEach((value, word) => data.writeUInt32LE(value, 4 * word));
    data.writeUInt32LE(0x0ab16f30, 508);
    return data;
}

const pairTemplate = Buffer.from('564942454d494352463031619b46d200', 'hex');

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

test('pair slot patch writes only the selected address and refuses ambiguous slots', () => {
    const image = block();
    image.set(pairTemplate, 48);
    setPairAddress(image, '00A5-1234');
    assert.deepEqual([...image.subarray(59, 63)], [0x00, 0xa5, 0x12, 0x34]);
    for (const offsets of [[], [48, 64], [49]]) {
        const bad = block();
        for (const offset of offsets) bad.set(pairTemplate, offset);
        assert.throws(() => setPairAddress(bad, '8B27-3DE4'), /слота для кода пары/);
    }
});