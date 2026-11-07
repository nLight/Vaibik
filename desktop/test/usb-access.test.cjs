'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { usbRuleBody, usbRuleStatus, installUsbRule } = require('../src/usb-access.cjs');

test('USB rule detection recognizes the HID-only version and preserves custom rules', async () => {
    const current = await fs.readFile(path.join(__dirname, '../assets/70-vibemic.rules'), 'utf8');
    const legacy = current.split('\n').find(line => line.startsWith('KERNEL=="hidraw'));
    assert.equal(usbRuleStatus(current, current), 'configured');
    assert.equal(usbRuleStatus(current, legacy), 'outdated');
    assert.equal(usbRuleStatus(current, legacy.replace('uaccess', 'custom-access')), 'overridden');
});

test('rule migration checks the previous contents and replaces atomically', { skip: process.platform === 'win32' }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibemic-udev-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const destination = path.join(dir, '70-vibemic.rules');
    const reload = path.join(dir, 'udevadm');
    await fs.writeFile(reload, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const rule = usbRuleBody(await fs.readFile(path.join(__dirname, '../assets/70-vibemic.rules'), 'utf8'));
    const apply = old => promisify(execFile)('/bin/sh', ['-c', installUsbRule, 'vibemic-test', rule, destination, old],
        { env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH } });
    await apply('');
    assert.equal(await fs.readFile(destination, 'utf8'), rule + '\n');
    await fs.writeFile(destination, 'known legacy');
    await apply('known legacy');
    assert.equal(await fs.readFile(destination, 'utf8'), rule + '\n');
    await fs.writeFile(destination, 'changed elsewhere');
    await assert.rejects(apply('known legacy'));
    assert.equal(await fs.readFile(destination, 'utf8'), 'changed elsewhere');
    await fs.unlink(destination);
    await fs.symlink(path.join(dir, 'missing'), destination);
    await assert.rejects(apply(''));
    assert.equal((await fs.lstat(destination)).isSymbolicLink(), true);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['70-vibemic.rules', 'udevadm']);
});
