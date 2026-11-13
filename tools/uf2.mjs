import { randomBytes } from 'node:crypto';

export const APP_START = { 6: 0x26000, 7: 0x27000 };
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
export const FILES = { transmitter: 'promicro-transmitter.uf2', receiver: 'promicro-receiver.uf2',
    'mic-probe': 'promicro-mic-probe.uf2', 'transmitter-v2-battery': 'promicro-transmitter-v2-battery.uf2' };

function blockOK(data) {
    return data.length >= 512 && data.readUInt32LE(0) === START_MAGIC &&
        data.readUInt32LE(4) === SECOND_MAGIC && data.readUInt32LE(508) === END_MAGIC;
}

export function validateUF2(data, address = APP_START[6]) {
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

export function normalizePairCode(value) {
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

export function generatePairCode() {
    for (;;) {
        const bytes = randomBytes(4);
        const address = bytes.toString('hex').toUpperCase();
        if (address !== PAIR_DEFAULT && !bytes.every(value => value === bytes[0])) {
            return normalizePairCode(address);
        }
    }
}

export function setPairAddress(image, code) {
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