'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const AGENTS = Object.freeze({
    codex: {
        name: 'Codex',
        docs: 'https://learn.chatgpt.com/docs/codex/cli',
        unix: 'https://chatgpt.com/codex/install.sh',
        windows: 'https://chatgpt.com/codex/install.ps1'
    },
    claude: {
        name: 'Claude Code',
        docs: 'https://code.claude.com/docs/en/setup',
        unix: 'https://claude.ai/install.sh',
        windows: 'https://claude.ai/install.ps1'
    }
});

function agentSpec(id) {
    if (!Object.hasOwn(AGENTS, id)) throw new Error('Неизвестный агент.');
    return AGENTS[id];
}

async function executable(file) {
    try {
        return (await fs.stat(file)).isFile() && await fs.access(file, process.platform === 'win32' ? 0 : 1)
            .then(() => true, () => false);
    } catch { return false; }
}

async function agentEnvironment() {
    const home = os.homedir();
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    const versions = await fs.readdir(nvm).catch(() => []);
    const bins = [
        path.join(home, '.local', 'bin'),
        path.join(home, '.cargo', 'bin'),
        ...(process.platform === 'win32'
            ? [path.join(process.env.LOCALAPPDATA || home, 'Programs', 'OpenAI', 'Codex', 'bin')]
            : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']),
        ...versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
            .map(version => path.join(nvm, version, 'bin'))
    ];
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
    return { ...process.env, [pathKey]: [process.env[pathKey], ...bins].filter(Boolean).join(path.delimiter) };
}

async function findAgent(id, override) {
    agentSpec(id);
    if (override) return (await executable(override)) ? override : null;
    const env = await agentEnvironment();
    const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
    const filename = id + (process.platform === 'win32' ? '.exe' : '');
    for (const directory of searchPath.split(path.delimiter)) {
        if (!path.isAbsolute(directory)) continue;
        const file = path.join(directory, filename);
        if (await executable(file)) return file;
    }
    return null;
}

async function installAgent(id, scratch, progress) {
    const agent = agentSpec(id);
    const win = process.platform === 'win32';
    const directory = await fs.mkdtemp(path.join(scratch, 'vibemic-installer-'));
    try {
        const response = await fetch(win ? agent.windows : agent.unix,
            { signal: AbortSignal.timeout(45000) });
        if (!response.ok) throw new Error(`Сервер ${agent.name} ответил ${response.status}.`);
        const body = await response.text();
        if (!body.trim() || body.length > 512000 || /^\s*<(!doctype|html)/i.test(body)) {
            throw new Error('Сервер вернул некорректный файл установщика.');
        }
        const file = path.join(directory, win ? 'install.ps1' : 'install.sh');
        await fs.writeFile(file, body, { mode: 0o600 });
        const env = { ...await agentEnvironment(), CODEX_NON_INTERACTIVE: '1' };
        await new Promise((resolve, reject) => {
            const child = spawn(win ? 'powershell.exe' : '/bin/bash', win
                ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]
                : [file], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
            const forward = chunk => progress(chunk.toString('utf8').slice(0, 4096));
            child.stdout.on('data', forward);
            child.stderr.on('data', forward);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('close', code => {
                clearTimeout(timer);
                if (code === 0) resolve();
                else reject(new Error(`Установщик ${agent.name} завершился с ошибкой.`));
            });
        });
        const found = await findAgent(id);
        if (!found) throw new Error('Установка завершилась. Укажите путь к CLI в настройках.');
        return found;
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

module.exports = { AGENTS, agentSpec, agentEnvironment, findAgent, installAgent };
