const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('buddyDesktop', Object.freeze({
  chooseDirectory: options => ipcRenderer.invoke('buddy:choose-directory', options ?? {}),
  runtime: () => ipcRenderer.invoke('buddy:runtime'),
  keepAwake: () => ipcRenderer.invoke('buddy:keep-awake'),
  setKeepAwake: enabled => { if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('Keep awake requires a boolean')); return ipcRenderer.invoke('buddy:set-keep-awake', enabled); },
  openSettings: tab => ipcRenderer.invoke('buddy:open-settings', tab ?? 'models'),
  closeSettings: () => ipcRenderer.invoke('buddy:close-settings'),
  showMainView: view => ipcRenderer.invoke('buddy:show-main-view', view),
  onNavigate: callback => { if (typeof callback !== 'function') throw new TypeError('Navigation callback must be a function'); const handler = (_event, value) => callback(value); ipcRenderer.on('buddy:navigate', handler); return () => ipcRenderer.removeListener('buddy:navigate', handler); }
}));
