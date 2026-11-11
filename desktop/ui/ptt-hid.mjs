import { t } from './i18n.mjs';
import { decodeBattery } from './battery.mjs';
const filter = { vendorId: 0x1209, productId: 0x0003, usagePage: 0xff31, usage: 1 };
const endings = [null, 'released', 'radioTimeout', 'hostTimeout', 'usbStopped', 'superseded'];
const wiredProduct = 'PTT Dictation Mic (USB)';

export function pttTransport(name) {
    return name?.includes(wiredProduct) ? 'usb' : 'radio';
}

export function preferredPttDevice(devices) {
    const wired = devices.filter(device => pttTransport(device.productName ?? device.name) === 'usb');
    const candidates = wired.length ? wired : devices;
    return candidates.length === 1 ? candidates[0] : undefined;
}

export function isPttDevice(device) {
    return device?.vendorId === filter.vendorId && device.productId === filter.productId &&
        device.collections?.some(item => item.usagePage === filter.usagePage && item.usage === filter.usage);
}

export function watchPtt(hid, { connection, button, approval, battery, error }) {
    let current;
    let opening;
    let press;
    let scanVersion = 0;

    function input(event) {
        if (event.currentTarget !== current || event.reportId !== 0 ||
            event.data.byteLength !== 8 || event.data.getUint8(0) !== 1) return;
        const value = event.data.getUint8(1);
        if (value === 4) {
            const status = decodeBattery(event.data);
            if (status) battery?.(status);
            return;
        }
        if (value === 2 || value === 3) {
            if (!press && event.data.getUint16(6, true) === 0) {
                approval?.(value === 2 ? 'arm' : 'commit', event.data.getUint32(2, true),
                    Math.floor(performance.timeOrigin + event.timeStamp));
            }
            return;
        }
        if (value > 1 || Boolean(value) === Boolean(press)) return;
        const down = Boolean(value);
        press = down ? {} : undefined;
        const end = !down && endings[event.data.getUint8(2)];
        const magnitude = event.data.getUint8(3);
        button(down, end ? {
            end,
            weakestDbm: magnitude > 0 && magnitude <= 127 ? -magnitude : null,
            silentMs: event.data.getUint16(4, true),
            usbErrors: event.data.getUint16(6, true)
        } : undefined);
        if (!down) rescan();
    }

    async function attach(device) {
        if (device === current || opening?.device === device || press) return;
        const attempt = { device };
        opening = attempt;
        try {
            if (!device.opened) await device.open();
            if (opening !== attempt || press) return;
            current?.removeEventListener('inputreport', input);
            current = device;
            device.addEventListener('inputreport', input);
            connection(true, pttTransport(device.productName));
        } catch (failure) {
            if (opening === attempt) throw failure;
        } finally {
            if (opening === attempt) opening = undefined;
        }
    }

    async function scan() {
        const version = ++scanVersion;
        const device = preferredPttDevice((await hid.getDevices()).filter(isPttDevice));
        if (version === scanVersion && device) await attach(device);
    }

    const rescan = () => scan().catch(error);
    hid.addEventListener('connect', rescan);
    hid.addEventListener('disconnect', ({ device }) => {
        if (opening?.device === device) opening = undefined;
        if (current === device) {
            device.removeEventListener('inputreport', input);
            current = undefined;
            press = undefined;
            connection(false);
        }
        rescan();
    });

    return {
        scan,
        async holdShortcut(kind, usage) {
            const device = current;
            const activePress = press;
            if (!activePress || !device) return null;
            const claude = kind === 'claude';
            const command = claude ? (usage === 0x07 ? 3 : usage === 0x0a ? 4 : 0) : 1;
            if (!command) return null;
            const updateHint = claude ? 'Для хоткея Claude обновите прошивку подключённой платы.'
                : 'Для хоткея Codex обновите прошивку подключённой платы.';
            if (!device.collections.some(item => item.usagePage === filter.usagePage && item.usage === filter.usage &&
                item.featureReports?.some(report => report.reportId === 0))) {
                throw new Error(t(updateHint));
            }
            try { await device.sendFeatureReport(0, Uint8Array.of(command)); }
            catch (error) {
                if (claude && current === device) throw new Error(t(updateHint), { cause: error });
                throw error;
            }
            return async () => {
                if (current === device && press === activePress) {
                    await device.sendFeatureReport(0, Uint8Array.of(0));
                }
            };
        },
        async request() {
            const devices = (await hid.requestDevice({ filters: [filter] })).filter(isPttDevice);
            const device = preferredPttDevice(devices);
            if (!device) throw new Error(t('Подключите микрофон VibeMic по USB или подключите его донгл.'));
            await attach(device);
        }
    };
}
