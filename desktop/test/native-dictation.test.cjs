'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');

test('native dictation correlates sessions, falls back, and cleans up interrupted requests', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const children = [];
    t.mock.method(childProcess, 'spawn', (binary, args) => {
        assert.equal(binary, '/test/helper');
        assert.deepEqual(args, ['--native-dictation']);
        const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(), stdout: new PassThrough(), signals: [],
            kill(signal) { this.signals.push(signal); }
        });
        children.push(child);
        return child;
    });
    const { NativeDictation } = require('../src/native-dictation.cjs');
    const broker = new NativeDictation('/test/helper');
    const read = child => JSON.parse(child.stdin.read().toString());
    const reply = (child, value) => child.stdout.write(JSON.stringify(value) + '\n');

    broker.enable();
    broker.enable();
    assert.equal(children.length, 1);
    const child = children[0];
    const begun = broker.begin({ shortcut: true });
    const begin = read(child);
    assert.equal(begin.shortcut, true);
    child.stdout.write('unrelated output\n');
    reply(child, { id: begin.id + 99, ok: true });
    reply(child, { id: begin.id, ok: true, native: true, shortcut: 'codex', app: 'Codex' });
    assert.deepEqual(await begun, { native: true, shortcut: 'codex', usage: 0, app: 'Codex', session: begin.id });

    const ended = broker.finish(begin.id);
    const end = read(child);
    assert.equal(end.session, begin.id);
    reply(child, { id: end.id, ok: true, native: true });
    await ended;
    const claude = broker.begin({ claudeShortcut: true });
    const setup = read(child);
    assert.equal(setup.claudeShortcut, true);
    reply(child, { id: setup.id, ok: true, native: true, shortcut: 'claude', usage: 10, app: 'Claude' });
    assert.equal((await claude).usage, 10);
    const retry = broker.checkClaude(setup.id, false);
    const retryRequest = read(child);
    assert.equal(retryRequest.command, 'claude-retry');
    assert.equal(retryRequest.session, setup.id);
    reply(child, { id: retryRequest.id, ok: true, idle: true });
    assert.equal(await retry, true);
    const abandon = broker.checkClaude(setup.id, true);
    const abandonRequest = read(child);
    assert.equal(abandonRequest.command, 'claude-abandon');
    reply(child, { id: abandonRequest.id, ok: true, idle: false });
    assert.equal(await abandon, false);
    const fallback = broker.begin();
    reply(child, { id: read(child).id, ok: true, native: false, app: '' });
    assert.equal((await fallback).native, false);

    const interrupted = broker.begin();
    const rejected = assert.rejects(interrupted, /отменена/);
    broker.dispose();
    await rejected;
    assert.equal(child.stdin.writableEnded, true); // EOF lets the helper stop recording.
    t.mock.timers.tick(2000);
    assert.deepEqual(child.signals, ['SIGKILL']);

    const restarted = broker.begin();
    const timedOut = assert.rejects(restarted, /не ответила вовремя/);
    assert.equal(children.length, 2);
    t.mock.timers.tick(5000);
    await timedOut;
    assert.equal(children[1].stdin.writableEnded, true);
    children[1].emit('close');

    const failed = broker.begin();
    const exited = assert.rejects(failed, /мост диктовки завершился/);
    children[2].emit('error', new Error('spawn failed'));
    await exited;
    await assert.rejects(broker.finish(begin.id), /недоступен/);
    await broker.cancel();
});
