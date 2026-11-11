'use strict';

const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

class NativeDictation {
    #binary;
    #child;
    #next = 0;
    #pending = new Map();

    constructor(binary) { this.#binary = binary; }

    enable() {
        if (this.#child) return;
        const child = spawn(this.#binary, ['--native-dictation'], { stdio: ['pipe', 'pipe', 'ignore'] });
        this.#child = child;
        const failed = () => {
            if (this.#child !== child) return;
            this.#child = undefined;
            child.kill('SIGTERM');
            for (const pending of this.#pending.values()) {
                clearTimeout(pending.timeout);
                pending.reject(new Error('Системный мост диктовки завершился.'));
            }
            this.#pending.clear();
        };
        child.once('error', failed);
        child.once('close', failed);
        child.stdin.on('error', failed);
        createInterface({ input: child.stdout }).on('line', line => {
            let reply;
            try { reply = JSON.parse(line); } catch { return; }
            const pending = this.#pending.get(reply.id);
            if (!pending) return;
            this.#pending.delete(reply.id);
            clearTimeout(pending.timeout);
            if (reply.ok) pending.resolve(reply);
            else pending.reject(new Error(reply.error || 'Не удалось управлять встроенной диктовкой.'));
        });
    }

    #request(command, values = {}) {
        const child = this.#child;
        if (!child) return Promise.reject(new Error('Системный мост диктовки недоступен.'));
        const id = ++this.#next;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error('Встроенная диктовка не ответила вовремя.'));
                this.dispose();
            }, 5000);
            this.#pending.set(id, { resolve, reject, timeout });
            try { child.stdin.write(JSON.stringify({ id, command, ...values }) + '\n'); }
            catch (error) {
                clearTimeout(timeout);
                this.#pending.delete(id);
                reject(error);
                this.dispose();
            }
        });
    }

    async begin({ shortcut = false, claudeShortcut = false } = {}) {
        this.enable();
        const reply = await this.#request('begin', { shortcut, claudeShortcut });
        return { native: reply.native, shortcut: reply.shortcut || '', usage: reply.usage || 0,
            app: reply.app, session: reply.id };
    }

    finish(session) { return this.#request('end', { session }); }

    async checkClaude(session, abandon) {
        const reply = await this.#request(abandon ? 'claude-abandon' : 'claude-retry', { session });
        return reply.idle === true;
    }

    cancel() {
        return this.#child ? this.#request('cancel') : Promise.resolve();
    }

    dispose() {
        const child = this.#child;
        if (!child) return;
        this.#child = undefined;
        // EOF asks the native process to stop its own recording before exiting.
        child.stdin.end();
        const force = setTimeout(() => child.kill('SIGKILL'), 2000);
        force.unref();
        child.once('close', () => clearTimeout(force));
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Встроенная диктовка отменена.'));
        }
        this.#pending.clear();
    }
}

module.exports = { NativeDictation };
