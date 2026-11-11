'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const REVISION = '541d1f99c6b0c3cd0b11a95167540bb8edefd82b';
const MODELS = Object.freeze({
    parakeet: Object.freeze({
        file: 'parakeet-tdt-0.6b-v3.q8_0.gguf', size: 713975456,
        sha256: 'e3880d0aaaaf2c308ea2c35016b2b895c423eb3fda924c1b463d1c19b7f4d32e'
    })
});

function spec(id) {
    if (!Object.hasOwn(MODELS, id)) throw new Error('Неизвестная модель Parakeet.');
    return MODELS[id];
}

async function hasExpectedDigest(file, model) {
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    return digest.digest('hex') === model.sha256;
}

class SpeechModels {
    #directory;
    #runtime;
    #downloads = new Map();
    #checks = new Map();

    constructor(directory, runtime) {
        this.#directory = directory;
        this.#runtime = runtime;
    }

    file(id) { return path.join(this.#directory, spec(id).file); }

    async #integrity(id) {
        const file = this.file(id);
        const model = spec(id);
        let stat;
        try { stat = await fsp.stat(file, { bigint: true }); }
        catch (error) { return error.code === 'ENOENT' ? 'missing' : 'damaged'; }
        if (!stat.isFile() || stat.size !== BigInt(model.size)) return 'damaged';

        const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        let check = this.#checks.get(id);
        if (check?.key !== key) {
            check = { key, valid: hasExpectedDigest(file, model) };
            this.#checks.set(id, check);
        }
        try { return (await check.valid) ? 'verified' : 'damaged'; }
        catch {
            if (this.#checks.get(id) === check) this.#checks.delete(id);
            return 'damaged';
        }
    }

    async statuses() {
        const entries = await Promise.all(Object.keys(MODELS).map(async id => {
            const integrity = await this.#integrity(id);
            return [id, { installed: integrity === 'verified', damaged: integrity === 'damaged',
                downloading: this.#downloads.has(id) }];
        }));
        return Object.fromEntries(entries);
    }

    async install(id, progress) {
        const model = spec(id);
        if (this.#downloads.has(id)) throw new Error('Эта модель уже скачивается.');
        const abort = new AbortController();
        this.#downloads.set(id, abort);
        const destination = this.file(id);
        const temporary = destination + `.${randomUUID()}.download`;
        try {
            await fsp.mkdir(this.#directory, { recursive: true });
            const url = `https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/resolve/${REVISION}/${model.file}`;
            const response = await fetch(url, { signal: AbortSignal.any([
                abort.signal, AbortSignal.timeout(30 * 60 * 1000)
            ]) });
            if (!response.ok || !response.body) throw new Error(`Сервер моделей ответил ${response.status}.`);
            let received = 0;
            let previous = -1;
            const digest = createHash('sha256');
            const verify = new Transform({
                transform(chunk, encoding, done) {
                    received += chunk.length;
                    if (received > model.size) return done(new Error('Файл модели превышает ожидаемый размер.'));
                    digest.update(chunk);
                    const percent = Math.floor(received / model.size * 100);
                    if (percent !== previous) {
                        previous = percent;
                        progress({ id, received, total: model.size });
                    }
                    done(null, chunk);
                }
            });
            await pipeline(Readable.fromWeb(response.body), verify,
                fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: abort.signal });
            if (received !== model.size || digest.digest('hex') !== model.sha256) {
                throw new Error('Контрольная сумма модели не совпала. Попробуйте скачать ещё раз.');
            }
            await fsp.rename(temporary, destination);
            this.#checks.delete(id);
        } catch (error) {
            if (abort.signal.aborted) throw new Error('Загрузка отменена.');
            throw error;
        } finally {
            this.#downloads.delete(id);
            await fsp.rm(temporary, { force: true }).catch(() => {});
        }
    }

    cancel(id) { this.#downloads.get(id)?.abort(); }

    async verify(id) {
        const integrity = await this.#integrity(id);
        if (integrity === 'missing') throw new Error('Сначала установите модель распознавания.');
        if (integrity === 'damaged') throw new Error('Файл модели повреждён. Перескачайте модель на странице «Распознавание».');
        return this.file(id);
    }

    async transcribe(bytes, id, language, scratch) {
        const wave = Buffer.from(bytes);
        if (wave.length < 3244 || wave.length > 4000000 ||
            wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE') {
            throw new Error('Запись слишком короткая или имеет неподдерживаемый формат.');
        }
        const model = await this.verify(id);
        const directory = await fsp.mkdtemp(path.join(scratch, 'vibemic-audio-'));
        try {
            const input = path.join(directory, 'clip.wav');
            const output = path.join(directory, 'draft.txt');
            await fsp.writeFile(input, wave, { mode: 0o600 });
            await run(this.#runtime, ['transcribe', input, '--model', model,
                '--format', 'text', '--output', output, '--no-warmup'], {
                windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024
            });
            return (await fsp.readFile(output, 'utf8')).trim();
        } catch (error) {
            if (error.code === 'ENOENT') throw new Error('Движок распознавания не найден в сборке приложения.');
            if (error.killed) throw new Error('Распознавание заняло слишком много времени.');
            throw error;
        } finally {
            await fsp.rm(directory, { recursive: true, force: true });
        }
    }
}

module.exports = { MODELS, SpeechModels };
