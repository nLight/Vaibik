'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { constants } = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');

const APP_START = { 6: 0x26000, 7: 0x27000 };
const SOFTDEVICE_START = 0x1000;
const STORAGE_START = 0xec000;
const FAMILY = 0xada52840;
const PAIR_TAG = Buffer.from('VIBEMICRF01', 'ascii');
const PAIR_DEFAULT = '619B46D2';
const PAIR_TEMPLATE = Buffer.concat([PAIR_TAG, Buffer.from(PAIR_DEFAULT + '00', 'hex')]);
const PAIR_UNSUPPORTED = 'В образе нет однозначного слота для кода пары. Переустановите VibeMic.';
const START_MAGIC = 0x0a324655;
const SECOND_MAGIC = 0x9e5d5157;
const END_MAGIC = 0x0ab16f30;
const UF2_MAX_BYTES = 2 * 1024 * 1024;
const CURRENT = 'CURRENT.UF2';
const INFO = 'INFO_UF2.TXT';
const READ_VOLUME_FILE = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
const BOARD_ID = /^nRF52840-(?:nicenano(?:-v2)?|nice_nano|supermini|promicro(?:-s140v6)?)$/i;
const FILES = { transmitter: 'promicro-transmitter.uf2', receiver: 'promicro-receiver.uf2',
    'mic-probe': 'promicro-mic-probe.uf2', 'transmitter-v2-battery': 'promicro-transmitter-v2-battery.uf2' };
const VOLUME_CHANGED = 'Диск загрузчика изменился. Обновите список плат и подтвердите прошивку заново.';
const BACKUP_INVALID = 'CURRENT.UF2 повреждён или прочитан не полностью. Проверьте подключение платы.';

function blockOK(data) {
    return data.length >= 512 && data.readUInt32LE(0) === START_MAGIC &&
        data.readUInt32LE(4) === SECOND_MAGIC && data.readUInt32LE(508) === END_MAGIC;
}

function validateUF2(data, address = APP_START[6]) {
    if (!Object.values(APP_START).includes(address)) throw new Error('Неизвестная разметка Pro Micro.');
    if (!data.length || data.length % 512 !== 0 || data.length > UF2_MAX_BYTES) {
        throw new Error('Некорректный размер файла UF2.');
    }
    const total = data.length / 512;
    const blocks = new Set();
    const ranges = [];
    for (let start = 0; start < data.length; start += 512) {
        const chunk = data.subarray(start, start + 512);
        if (!blockOK(chunk) || chunk.readUInt32LE(8) !== 0x2000 ||
            chunk.readUInt32LE(28) !== FAMILY || chunk.readUInt32LE(24) !== total) {
            throw new Error('Ожидался образ UF2 для nRF52840.');
        }
        const addr = chunk.readUInt32LE(12);
        const size = chunk.readUInt32LE(16);
        const index = chunk.readUInt32LE(20);
        if (addr < address || addr % 256 !== 0 || addr + size > STORAGE_START ||
            size !== 256 || index >= total || blocks.has(index)) {
            throw new Error('Образ выходит за границы приложения Pro Micro.');
        }
        blocks.add(index);
        ranges.push([addr, addr + size]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges[0][0] !== address || ranges.some((range, index) =>
        index > 0 && range[0] !== ranges[index - 1][1])) {
        throw new Error('Адреса блоков прошивки не совпадают с разметкой Pro Micro.');
    }
}

function normalizePairCode(value) {
    const input = typeof value === 'string' ? value.trim().toUpperCase() : null;
    if (input === '') return '';
    if (!input || !/^[0-9A-F]{4}-?[0-9A-F]{4}$/.test(input)) {
        throw new Error('Код пары должен содержать восемь знаков 0–9 или A–F.');
    }
    const address = input.replace('-', '');
    if (address === PAIR_DEFAULT) return '';
    if (/^([0-9A-F]{2})\1{3}$/.test(address)) throw new Error('Выберите код пары с разными байтами.');
    return address.slice(0, 4) + '-' + address.slice(4);
}

function generatePairCode() {
    for (;;) {
        const bytes = randomBytes(4);
        const address = bytes.toString('hex').toUpperCase();
        if (address !== PAIR_DEFAULT && !bytes.every(value => value === bytes[0])) {
            return normalizePairCode(address);
        }
    }
}

function setPairAddress(image, code) {
    let slot;
    for (let start = 0; start < image.length; start += 512) {
        const payload = image.subarray(start + 32, start + 32 + 256);
        const offset = payload.indexOf(PAIR_TAG);
        if (offset < 0) continue;
        if (slot !== undefined || offset % 16 !== 0 || payload.indexOf(PAIR_TAG, offset + 1) !== -1 ||
            !payload.subarray(offset, offset + PAIR_TEMPLATE.length).equals(PAIR_TEMPLATE)) {
            throw new Error(PAIR_UNSUPPORTED);
        }
        slot = start + 32 + offset + PAIR_TAG.length;
    }
    if (slot === undefined) throw new Error(PAIR_UNSUPPORTED);
    image.set(Buffer.from(code.replace('-', ''), 'hex'), slot);
}

async function currentStart(directory) {
    try {
        const file = await fs.open(path.join(directory, CURRENT), READ_VOLUME_FILE);
        try {
            const block = Buffer.alloc(512);
            const { bytesRead } = await file.read(block, 0, block.length, 0);
            if (bytesRead === block.length && blockOK(block)) return block.readUInt32LE(12);
            throw new Error(BACKUP_INVALID);
        } finally {
            await file.close();
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    return null;
}

async function mountedDirectory(directory) {
    const stat = await fs.stat(directory, { bigint: true });
    if (!stat.isDirectory()) throw new Error('Выберите диск загрузчика.');
    return { key: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`, device: stat.dev };
}

async function readBootloader(directory) {
    const mounted = await mountedDirectory(directory);
    const info = await fs.open(path.join(directory, INFO), READ_VOLUME_FILE);
    let contents;
    try {
        const text = Buffer.alloc(4096);
        const { bytesRead } = await info.read(text, 0, text.length, 0);
        contents = text.subarray(0, bytesRead);
    } finally {
        await info.close();
    }
    const text = contents.toString('utf8');
    const board = text.match(/^Board-ID:\s*(.+?)\s*$/mi)?.[1];
    const model = text.match(/^Model:\s*(.+?)\s*$/mi)?.[1] || board;
    if (!/^UF2 Bootloader\b/im.test(text) || !board || !BOARD_ID.test(board)) {
        throw new Error('Эта модель загрузчика не распознана как Pro Micro nRF52840.');
    }
    const softDevice = text.match(/^SoftDevice:\s*(.+?)\s*$/mi)?.[1] || '';
    const start = await currentStart(directory);
    const version = softDevice ? softDevice.match(/^S140\s+(?:version\s+)?([67])\.\d+\.\d+$/i)?.[1]
        : Object.keys(APP_START).find(version => APP_START[version] === start);
    const address = APP_START[version];
    // Adafruit CURRENT.UF2 can include the SoftDevice starting at the end of the MBR.
    if (!address || (start !== null && start !== SOFTDEVICE_START && start !== address)) {
        throw new Error('Не удалось подтвердить разметку S140 v6 или v7.');
    }
    if ((await mountedDirectory(directory)).key !== mounted.key) throw new Error(VOLUME_CHANGED);
    const identity = createHash('sha256').update(JSON.stringify([mounted.key, text, start])).digest('hex');
    const volume = { directory, board, model, address, version: Number(version), identity, hasCurrent: start !== null };
    return { volume, contents, start, mounted };
}

async function inspectBootloader(directory) {
    return (await readBootloader(directory)).volume;
}

async function saveCurrent(bootloader, backupRoot) {
    const { volume, contents, start, mounted } = bootloader;
    const file = await fs.open(path.join(volume.directory, CURRENT), READ_VOLUME_FILE);
    let data;
    try {
        const stat = await file.stat({ bigint: true });
        if (stat.dev !== mounted.device) throw new Error(VOLUME_CHANGED);
        if (!stat.isFile() || stat.size < 512n || stat.size > BigInt(UF2_MAX_BYTES)) throw new Error(BACKUP_INVALID);
        data = await file.readFile();
        if (BigInt(data.length) !== stat.size || data.length % 512 !== 0) throw new Error(BACKUP_INVALID);
    } finally {
        await file.close();
    }
    // The readback may include SoftDevice and use a board-specific family ID.
    const total = data.length / 512;
    if (start + total * 256 > 0x100000) throw new Error(BACKUP_INVALID);
    const flags = data.readUInt32LE(8);
    const family = data.readUInt32LE(28);
    for (let index = 0; index < total; index++) {
        const block = data.subarray(index * 512, (index + 1) * 512);
        if (!blockOK(block) || block.readUInt32LE(8) !== flags || block.readUInt32LE(28) !== family ||
            block.readUInt32LE(12) !== start + index * 256 || block.readUInt32LE(16) !== 256 ||
            block.readUInt32LE(20) !== index || block.readUInt32LE(24) !== total) throw new Error(BACKUP_INVALID);
    }
    if ((await readBootloader(volume.directory)).volume.identity !== volume.identity) throw new Error(VOLUME_CHANGED);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let pending;
    try {
        await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
        pending = await fs.mkdtemp(path.join(backupRoot, '.pending-'));
        await fs.writeFile(path.join(pending, INFO), contents, { mode: 0o600, flush: true });
        await fs.writeFile(path.join(pending, CURRENT), data, { mode: 0o600, flush: true });
        const suffix = path.basename(pending).slice('.pending-'.length);
        const destination = path.join(backupRoot, `${volume.board}-s140v${volume.version}-${timestamp}-${suffix}`);
        await fs.rename(pending, destination);
    } catch (error) {
        if (pending) await fs.rm(pending, { recursive: true, force: true }).catch(() => {});
        throw new Error('Не удалось сохранить резервную копию. Проверьте доступ к папке копий и свободное место.', { cause: error });
    }
}

async function folders(parent) {
    const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
    return entries.filter(entry => entry.isDirectory()).map(entry => path.join(parent, entry.name));
}

async function findBootloaders() {
    let candidates;
    if (process.platform === 'darwin') {
        candidates = await folders('/Volumes');
    } else if (process.platform === 'win32') {
        candidates = [...'DEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => `${letter}:\\`);
    } else {
        const login = os.userInfo().username;
        candidates = (await Promise.all([
            folders(`/media/${login}`), folders(`/run/media/${login}`), folders('/mnt')
        ])).flat();
    }
    const matches = await Promise.all(candidates.map(candidate =>
        inspectBootloader(candidate).catch(() => null)));
    return matches.filter(Boolean);
}

async function flashFirmware(directory, role, resources, expectedIdentity, backupRoot, pairCode = '') {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || !Object.hasOwn(FILES, role)) {
        throw new Error('Выберите плату в режиме загрузчика и её роль.');
    }
    const bootloader = await readBootloader(directory);
    const { mounted, volume: { address, version, identity, hasCurrent } } = bootloader;
    if (identity !== expectedIdentity) throw new Error(VOLUME_CHANGED);
    const name = version === 7 ? FILES[role].replace('.uf2', '-s140v7.uf2') : FILES[role];
    const image = await fs.readFile(path.join(resources, 'firmware', name));
    validateUF2(image, address);
    const code = normalizePairCode(pairCode);
    if (code && role !== 'mic-probe') setPairAddress(image, code);
    if (hasCurrent) await saveCurrent(bootloader, backupRoot);
    else if ((await inspectBootloader(directory)).identity !== identity) throw new Error(VOLUME_CHANGED);
    if ((await mountedDirectory(directory)).key !== mounted.key) throw new Error(VOLUME_CHANGED);
    // An exclusive file creation prevents replacing unrelated files on the volume.
    const file = await fs.open(path.join(directory, 'VIBEMIC.UF2'),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0));
    try {
        if ((await file.stat({ bigint: true })).dev !== mounted.device ||
            (await mountedDirectory(directory)).key !== mounted.key) throw new Error(VOLUME_CHANGED);
        await file.writeFile(image);
    } finally {
        await file.close();
    }
    return { role, backupSaved: hasCurrent };
}

module.exports = { FILES, validateUF2, inspectBootloader, findBootloaders, flashFirmware,
    normalizePairCode, generatePairCode };
