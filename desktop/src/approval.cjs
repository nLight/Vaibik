'use strict';

const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const lifetime = 575;
const maxEdgeAge = 150;

class ApprovalGesture {
    #binary;
    #pending;
    #lastToken;

    constructor(binary) { this.#binary = binary; }

    edge(kind, token, at) {
        const age = Date.now() - at;
        if (!Number.isFinite(at) || age < 0 || age > maxEdgeAge ||
            !Number.isInteger(token) || token < 0 || token > 0xffffffff) return;

        if (kind === 'commit') {
            const pending = this.#pending;
            if (pending?.token !== token || pending.committed) return;
            if (!pending.ready || at <= pending.at || Date.now() - pending.at > lifetime) {
                this.cancel();
                return;
            }
            pending.committed = true;
            pending.child.stdin.end('commit\n');
            return;
        }
        if (kind !== 'arm' || token === this.#lastToken) return;
        this.cancel();
        this.#lastToken = token;
        const child = spawn(this.#binary, ['--approval'], { stdio: ['pipe', 'pipe', 'ignore'] });
        const pending = { token, at, child, ready: false, committed: false };
        this.#pending = pending;
        pending.timer = setTimeout(() => this.cancel(), lifetime - age);
        const close = () => {
            if (this.#pending === pending) this.cancel();
        };
        child.once('error', close);
        child.once('close', close);
        child.stdin.on('error', close);
        createInterface({ input: child.stdout }).once('line', line => {
            if (line === 'true') pending.ready = true;
            else close();
        });
    }

    cancel() {
        const pending = this.#pending;
        if (!pending) return;
        this.#pending = undefined;
        clearTimeout(pending.timer);
        pending.child.kill();
    }
}

module.exports = { ApprovalGesture };
