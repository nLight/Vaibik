import { t } from './i18n.mjs';
import { pcm16Levels, pcm16Wav } from './pcm.mjs';

// The Rust serial thread captures the clip; the webview triggers it, listens for
// stage events and turns the returned PCM into a playable WAV plus level stats.
export async function capturePdmProbe(api, { signal, stage }) {
    const unstage = api.onPdmStage(({ stage: value }) => {
        if (!signal.aborted) stage(value);
    });
    const onAbort = () => api.pdmCancel().catch(() => {});
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        signal.throwIfAborted();
        const raw = await api.pdmCapture();
        if (signal.aborted) throw new Error(t('Проверка отменена.'));
        const clip = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        const tag = new TextDecoder().decode(clip.subarray(0, 4));
        if (tag === 'VERR') throw new Error(t('Плата сообщила об ошибке PDM. Проверьте питание и проводку микрофона.'));
        if (tag !== 'VMIC') throw new Error(t('Ответ PDM Probe не распознан. Перезапустите плату и повторите проверку.'));
        const pcm = clip.subarray(4);
        return { wav: pcm16Wav(pcm), levels: pcm16Levels(pcm) };
    } catch (error) {
        if (signal.aborted) throw new Error(t('Проверка отменена.'));
        throw error;
    } finally {
        signal.removeEventListener('abort', onAbort);
        unstage();
    }
}
