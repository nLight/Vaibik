import { t } from './i18n.mjs';
import { pcm16Levels, pcm16Wav } from './pcm.mjs';

const bytes = 3 * 16000 * 2;

export async function capturePdmProbe(serial, { signal, stage }) {
    if (!serial) throw new Error(t('Web Serial недоступен в этой сборке.'));
    let port;
    try { port = await serial.requestPort({ filters: [{ usbVendorId: 0x1209, usbProductId: 0x0002 }] }); }
    catch (error) {
        if (error.name === 'NotFoundError') throw new Error(t('Подключите один передатчик с прошивкой PDM Probe и повторите проверку.'));
        throw error;
    }
    let reader, writer, timer;
    let opened = false;
    let expired = false;
    try {
        await port.open({ baudRate: 115200, bufferSize: 131072 });
        opened = true;
        signal.throwIfAborted();
        await port.setSignals({ dataTerminalReady: true });
        signal.throwIfAborted();
        reader = port.readable.getReader();
        writer = port.writable.getWriter();
        timer = setTimeout(() => { expired = true; reader.cancel().catch(() => {}); }, 15000);
        await writer.write(new Uint8Array([0x52]));
        stage('recording');
        const clip = new Uint8Array(4 + bytes);
        let received = 0;
        while (received < clip.length) {
            const { value, done } = await reader.read();
            if (done) throw new Error(expired ? t('Плата не передала полную запись за 15 секунд. Перезапустите её и повторите проверку.')
                : t('Запись прервалась. Проверьте подключение USB.'));
            if (value.length > clip.length - received) throw new Error(t('Плата передала лишние данные. Перезапустите её и повторите проверку.'));
            const previous = received;
            clip.set(value, received);
            received += value.length;
            if (previous < 4 && received >= 4) {
                const tag = new TextDecoder().decode(clip.subarray(0, 4));
                if (tag === 'VERR') throw new Error(t('Плата сообщила об ошибке PDM. Проверьте питание и проводку микрофона.'));
                if (tag !== 'VMIC') throw new Error(t('Ответ PDM Probe не распознан. Перезапустите плату и повторите проверку.'));
                stage('receiving');
            }
        }
        // Finish receiving before closing CDC so a cancelled clip cannot leave the device's TX FIFO blocked.
        signal.throwIfAborted();
        const pcm = clip.subarray(4);
        return { wav: pcm16Wav(pcm), levels: pcm16Levels(pcm) };
    } catch (error) {
        if (signal.aborted && !expired) throw new Error(t('Проверка отменена.'));
        throw error;
    } finally {
        clearTimeout(timer);
        if (reader) {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
        writer?.releaseLock();
        if (opened) await port.close().catch(() => {});
    }
}
