import { t } from './i18n.mjs';
import { decodeBattery } from './battery.mjs';

const endings = [null, 'released', 'radioTimeout', 'hostTimeout', 'usbStopped', 'superseded'];
const wiredProduct = 'PTT Dictation Mic (USB)';

export function pttTransport(name) {
    return name?.includes(wiredProduct) ? 'usb' : 'radio';
}

// The Rust HID thread owns the device; the webview only parses reports and sends
// feature commands. Report layout matches the firmware (8 bytes, report id 1).
export function watchPtt(api, { connection, button, approval, battery, error }) {
    let press;
    let connected = false;
    const disposers = [];

    function report({ data, at }) {
        if (!Array.isArray(data) || data.length !== 8 || data[0] !== 1) return;
        const view = new DataView(new Uint8Array(data).buffer);
        const value = view.getUint8(1);
        if (value === 4) {
            const status = decodeBattery(view);
            if (status) battery?.(status);
            return;
        }
        if (value === 2 || value === 3) {
            if (!press && view.getUint16(6, true) === 0) {
                approval?.(value === 2 ? 'arm' : 'commit', view.getUint32(2, true), Math.floor(at));
            }
            return;
        }
        if (value > 1 || Boolean(value) === Boolean(press)) return;
        const down = Boolean(value);
        press = down ? {} : undefined;
        const end = !down && endings[view.getUint8(2)];
        const magnitude = view.getUint8(3);
        button(down, end ? {
            end,
            weakestDbm: magnitude > 0 && magnitude <= 127 ? -magnitude : null,
            silentMs: view.getUint16(4, true),
            usbErrors: view.getUint16(6, true)
        } : undefined);
        if (!down) api.hidRescan().catch(() => {});
    }

    disposers.push(api.onHidReport(report));
    disposers.push(api.onHidConnection(({ connected: next, transport }) => {
        connected = next;
        if (!next) press = undefined;
        connection(next, transport || 'radio');
    }));
    disposers.push(api.onHidFeatureError(() => {
        error?.(new Error(t('Для хоткея обновите прошивку подключённой платы.')));
    }));

    return {
        async scan() { await api.hidRescan(); },
        async request() { await api.hidRescan(); },
        async holdShortcut(kind, usage) {
            const activePress = press;
            if (!activePress || !connected) return null;
            const claude = kind === 'claude';
            const command = claude ? (usage === 0x07 ? 3 : usage === 0x0a ? 4 : 0) : 1;
            if (!command) return null;
            await api.hidSendFeature([command]);
            return async () => {
                if (connected && press === activePress) await api.hidSendFeature([0]).catch(() => {});
            };
        },
        dispose() { for (const dispose of disposers) dispose(); }
    };
}
