'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function receive(channel, listener) {
    ipcRenderer.on(channel, (_, value) => listener(value));
}

contextBridge.exposeInMainWorld('vibemic', {
    init: () => ipcRenderer.invoke('app:init'),
    save: patch => ipcRenderer.invoke('settings:save', patch),
    chooseProject: () => ipcRenderer.invoke('settings:project'),
    exportProfile: () => ipcRenderer.invoke('settings:export-profile'),
    importProfile: () => ipcRenderer.invoke('settings:import-profile'),
    applyProfile: profile => ipcRenderer.invoke('settings:apply-profile', profile),
    chooseAgent: agent => ipcRenderer.invoke('agent:choose', agent),
    agentStatus: () => ipcRenderer.invoke('agent:status'),
    installAgent: agent => ipcRenderer.invoke('agent:install', agent),
    openAgentDocs: agent => ipcRenderer.invoke('agent:docs', agent),
    modelStatus: () => ipcRenderer.invoke('model:status'),
    installModel: id => ipcRenderer.invoke('model:install', id),
    cancelModel: id => ipcRenderer.invoke('model:cancel', id),
    transcribe: (wave, model, language) => ipcRenderer.invoke('audio:transcribe', wave, model, language),
    savePdmClip: wave => ipcRenderer.invoke('audio:save-pdm-clip', wave),
    volumes: () => ipcRenderer.invoke('firmware:volumes'),
    pickVolume: () => ipcRenderer.invoke('firmware:choose'),
    flash: (directory, role, identity, pairCode) => ipcRenderer.invoke('firmware:flash', directory, role, identity, pairCode),
    generatePairCode: () => ipcRenderer.invoke('firmware:generate-pair'),
    savePairCode: value => ipcRenderer.invoke('firmware:save-pair', value),
    firmwareBackups: () => ipcRenderer.invoke('firmware:backups'),
    usbAccess: () => ipcRenderer.invoke('device:linux-access'),
    startTerminal: id => ipcRenderer.invoke('terminal:start', id),
    terminalReady: id => ipcRenderer.invoke('terminal:ready', id),
    stopTerminal: id => ipcRenderer.invoke('terminal:stop', id),
    terminalInput: (id, data) => ipcRenderer.send('terminal:input', id, data),
    terminalResize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
    copy: text => ipcRenderer.invoke('draft:copy', text),
    prepareExternal: () => ipcRenderer.invoke('draft:prepare-external'),
    pasteExternal: (id, text) => ipcRenderer.invoke('draft:paste-external', id, text),
    cancelExternal: id => ipcRenderer.invoke('draft:cancel-external', id),
    permissions: () => ipcRenderer.invoke('draft:permissions'),
    approvalEdge: (kind, token, at) => ipcRenderer.invoke('approval:edge', kind, token, at),
    cancelApproval: () => ipcRenderer.invoke('approval:cancel'),
    beginNativeDictation: () => ipcRenderer.invoke('dictation:begin'),
    endNativeDictation: session => ipcRenderer.invoke('dictation:end', session),
    checkClaudeDictation: (session, abandon) => ipcRenderer.invoke('dictation:check-claude', session, abandon),
    cancelNativeDictation: () => ipcRenderer.invoke('dictation:cancel'),
    onInstallLog: listener => receive('agent:log', listener),
    onModelProgress: listener => receive('model:progress', listener),
    onTerminalData: listener => receive('terminal:data', listener),
    onTerminalExit: listener => receive('terminal:exit', listener)
});
