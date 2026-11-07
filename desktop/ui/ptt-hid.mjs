import { t } from './i18n.mjs';
const filter = { vendorId: 0x1209, productId: 0x0003, usagePage: 0xff31, usage: 1 };
const endings = [null, 'released', 'radioTimeout', 'hostTimeout', 'usbStopped', 'superseded'];

function matches(device) {
    return device.vendorId === filter.vendorId && device.productId === filter.productId &&
        device.collections.some(item => item.usagePage === filter.usagePage && item.usage === filter.usage);
}

export function watchPtt(hid, { connection, button, error }) {
    let current;
    let opening;
    let down = false;
    let scanVersion = 0;

    function input(event) {
        if (event.currentTarget !== current || event.reportId !== 0 ||
            event.data.byteLength !== 8 || event.data.getUint8(0) !== 1) return;
        const value = event.data.getUint8(1);
        if (value > 1 || Boolean(value) === down) return;
        down = Boolean(value);
        const end = !down && endings[event.data.getUint8(2)];
        const magnitude = event.data.getUint8(3);
        button(down, end ? {
            end,
            weakestDbm: magnitude > 0 && magnitude <= 127 ? -magnitude : null,
            silentMs: event.data.getUint16(4, true),
            usbErrors: event.data.getUint16(6, true)
        } : undefined);
    }

    async function attach(device) {
        if (current || opening) return;
        const attempt = { device };
        opening = attempt;
        try {
            if (!device.opened) await device.open();
            if (opening !== attempt) return;
            current = device;
            device.addEventListener('inputreport', input);
            connection(true);
        } catch (failure) {
            if (opening === attempt) throw failure;
        } finally {
            if (opening === attempt) opening = undefined;
        }
    }

    async function scan() {
        const version = ++scanVersion;
        if (current || opening) return;
        const devices = (await hid.getDevices()).filter(matches);
        if (version === scanVersion && devices.length === 1) await attach(devices[0]);
    }

    const rescan = () => scan().catch(error);
    hid.addEventListener('connect', rescan);
    hid.addEventListener('disconnect', ({ device }) => {
        if (opening?.device === device) opening = undefined;
        if (current === device) {
            device.removeEventListener('inputreport', input);
            current = undefined;
            down = false;
            connection(false);
        }
        rescan();
    });

    return {
        scan,
        async request() {
            const devices = (await hid.requestDevice({ filters: [filter] })).filter(matches);
            if (devices.length !== 1) throw new Error(t('Донгл не найден. Подключите один донгл с прошивкой VibeMic.'));
            await attach(devices[0]);
        }
    };
}
