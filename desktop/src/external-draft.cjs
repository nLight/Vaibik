'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');

class ExternalDraft {
    #directory;
    #target;
    constructor(directory) { this.#directory = directory; }

    get supported() { return ['darwin', 'win32'].includes(process.platform); }

    async prepare() {
        if (!this.supported) throw new Error('На этой платформе используйте терминал VibeMic или копирование.');
        this.cancel();
        const id = randomUUID();
        const binary = 'vibemic-desktop-draft' + (process.platform === 'win32' ? '.exe' : '');
        const child = spawn(path.join(this.#directory, 'engine', binary), [], {
            stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
        });
        const target = { id, child, replies: [], waiting: null, timeout: null };
        this.#target = target;
        child.stdin.on('error', error => target.waiting?.reject(error));
        const lines = createInterface({ input: child.stdout });
        lines.on('line', line => {
            let message;
            try { message = JSON.parse(line); }
            catch { message = { ok: false, error: 'Не удалось прочитать ответ системного моста.' }; }
            if (target.waiting) {
                target.waiting.resolve(message);
                target.waiting = null;
            } else target.replies.push(message);
        });
        const failed = error => {
            if (target.waiting) {
                target.waiting.reject(error);
                target.waiting = null;
            }
            if (this.#target === target) this.#target = undefined;
            clearTimeout(target.timeout);
        };
        child.once('error', failed);
        child.once('close', () => failed(new Error('Системный мост завершился.')));
        target.timeout = setTimeout(() => this.cancel(id), 320000);
        const startup = setTimeout(() => this.cancel(id), 3000);
        try {
            const result = await this.#read(target);
            if (!result.ok) throw new Error(result.error);
            return id;
        } catch (error) {
            this.cancel(id);
            throw error;
        } finally { clearTimeout(startup); }
    }

    #read(target) {
        if (target.replies.length) return Promise.resolve(target.replies.shift());
        if (this.#target !== target) return Promise.reject(new Error('Активное окно больше недоступно.'));
        return new Promise((resolve, reject) => { target.waiting = { resolve, reject }; });
    }

    async paste(id, text) {
        const target = this.#target;
        if (!target || target.id !== id) throw new Error('Активное окно больше недоступно.');
        try {
            target.child.stdin.end(JSON.stringify(text) + '\n');
            const result = await this.#read(target);
            if (!result.ok) throw new Error(result.error);
        } finally { this.cancel(id); }
    }

    cancel(id) {
        const target = this.#target;
        if (!target || (id && target.id !== id)) return;
        this.#target = undefined;
        clearTimeout(target.timeout);
        target.waiting?.reject(new Error('Вставка в другое приложение отменена.'));
        target.waiting = null;
        target.child.kill();
    }
}

module.exports = { ExternalDraft };
