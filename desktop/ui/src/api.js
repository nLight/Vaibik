import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createMockApi } from './mock.js';

export const isTauri = '__TAURI_INTERNALS__' in window;

// Events arrive asynchronously; expose a synchronous disposer so callers can
// register/unregister without awaiting the Tauri listener handshake.
function subscriber(event) {
    return callback => {
        let unlisten = null;
        let cancelled = false;
        listen(event, message => callback(message.payload)).then(fn => {
            if (cancelled) fn();
            else unlisten = fn;
        }).catch(() => {});
        return () => { cancelled = true; if (unlisten) unlisten(); };
    };
}

function rawInvoke(command, bytes) {
    const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return invoke(command, payload);
}

function tauriApi() {
    return {
        init: () => invoke('app_init'),
        save: patch => invoke('settings_save', { patch }),
        chooseProject: () => invoke('settings_project'),
        exportProfile: () => invoke('settings_export_profile'),
        importProfile: () => invoke('settings_import_profile'),
        applyProfile: profile => invoke('settings_apply_profile', { profile }),
        agentStatus: () => invoke('agent_status_command'),
        openAgentDocs: id => invoke('agent_docs', { id }),
        chooseAgent: id => invoke('agent_choose', { id }),
        installAgent: id => invoke('agent_install', { id }),
        modelStatus: () => invoke('model_status'),
        installModel: id => invoke('model_install', { id }),
        cancelModel: id => invoke('model_cancel', { id }),
        transcribe: wave => rawInvoke('audio_transcribe', wave),
        savePdmClip: wav => rawInvoke('audio_save_pdm_clip', wav),
        volumes: () => invoke('firmware_volumes'),
        pickVolume: () => invoke('firmware_choose'),
        generatePairCode: () => invoke('firmware_generate_pair'),
        savePairCode: value => invoke('firmware_save_pair', { value }),
        flash: (directory, role, identity, confirmedCode) => invoke('firmware_flash', { directory, role, identity, confirmedCode }),
        firmwareBackups: () => invoke('firmware_backups'),
        usbAccess: () => invoke('device_linux_access'),
        startTerminal: agent => invoke('terminal_start', { agent }),
        terminalReady: id => invoke('terminal_ready', { id }),
        stopTerminal: id => invoke('terminal_stop', { id }),
        terminalInput: (id, data) => invoke('terminal_input', { id, data }),
        terminalResize: (id, cols, rows) => invoke('terminal_resize', { id, cols, rows }),
        copy: text => invoke('draft_copy', { text }),
        prepareExternal: () => invoke('draft_prepare_external'),
        pasteExternal: (id, text) => invoke('draft_paste_external', { id, text }),
        cancelExternal: id => invoke('draft_cancel_external', { id }),
        permissions: () => invoke('draft_permissions'),
        approvalEdge: (kind, token, at) => invoke('approval_edge', { kind, token, at }),
        cancelApproval: () => invoke('approval_cancel'),
        beginNativeDictation: () => invoke('dictation_begin'),
        endNativeDictation: session => invoke('dictation_end', { session }),
        checkClaudeDictation: (session, abandon) => invoke('dictation_check_claude', { session, abandon }),
        cancelNativeDictation: () => invoke('dictation_cancel'),
        hidRescan: () => invoke('hid_rescan'),
        hidSendFeature: bytes => invoke('hid_send_feature', { bytes }),
        pdmCapture: () => invoke('pdm_capture'),
        pdmCancel: () => invoke('pdm_cancel'),
        uiReady: () => invoke('ui_ready'),
        onModelProgress: subscriber('model:progress'),
        onInstallLog: subscriber('agent:log'),
        onTerminalData: subscriber('terminal:data'),
        onTerminalExit: subscriber('terminal:exit'),
        onHidReport: subscriber('hid:report'),
        onHidConnection: subscriber('hid:connection'),
        onHidFeatureError: subscriber('hid:feature-error'),
        onPdmStage: subscriber('pdm:stage')
    };
}

export const api = isTauri ? tauriApi() : createMockApi();
window.vibemic = api;
