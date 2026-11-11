'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');

test('approval commits only a fresh matching arm accepted by the bridge, once', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const children = [];
    t.mock.method(childProcess, 'spawn', (binary, args) => {
        assert.equal(binary, '/test/helper');
        assert.deepEqual(args, ['--approval']);
        const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(), stdout: new PassThrough(),
            killed: false, kill() { this.killed = true; }
        });
        children.push(child);
        return child;
    });
    const { ApprovalGesture } = require('../src/approval.cjs');
    const gesture = new ApprovalGesture('/test/helper');
    const edge = (kind, token) => gesture.edge(kind, token, Date.now());
    gesture.edge('arm', 7, 800); // Stale event.
    edge('commit', 7); // No first tap.
    assert.equal(children.length, 0);
    edge('arm', 7);
    t.mock.timers.tick(100);
    edge('commit', 7); // The bridge did not capture a focused approval in time.
    assert.equal(children[0].killed, true);
    assert.equal(children[0].stdin.read(), null);
    edge('arm', 7); // A retransmit cannot rearm it.
    assert.equal(children.length, 1);

    edge('arm', 8);
    children[1].stdout.write('true\n');
    t.mock.timers.tick(100);
    edge('commit', 9);
    assert.equal(children[1].stdin.read(), null);
    edge('commit', 8);
    edge('commit', 8);
    assert.equal(children[1].stdin.read().toString(), 'commit\n');

    edge('arm', 9);
    children[2].stdout.write('true\n');
    t.mock.timers.tick(600);
    edge('commit', 9);
    assert.equal(children[2].killed, true);
    assert.equal(children[2].stdin.read(), null);

    edge('arm', 10);
    children[3].stdout.write('false\n'); // No eligible control in focus.
    t.mock.timers.tick(100);
    edge('commit', 10);
    assert.equal(children[3].killed, true);
    assert.equal(children[3].stdin.read(), null);
});
