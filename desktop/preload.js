const { contextBridge, ipcRenderer } = require('electron');

/* Мостик между интерфейсом и «тяжёлой» частью приложения.
   Наружу отдаём только конкретные функции — доступа к Node у страницы нет. */
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,

  modelStatus: () => ipcRenderer.invoke('model-status'),
  modelBytes: () => ipcRenderer.invoke('model-bytes'),
  downloadModel: () => ipcRenderer.invoke('model-download'),
  onModelProgress: (cb) => {
    ipcRenderer.removeAllListeners('model-progress');
    ipcRenderer.on('model-progress', (_e, data) => cb(data));
  },

  // Распознавание текста песни
  asrStatus: () => ipcRenderer.invoke('asr-status'),
  asrDownload: (key) => ipcRenderer.invoke('asr-download', key),
  asrCancel: () => ipcRenderer.invoke('asr-cancel'),
  onAsrProgress: (cb) => {
    ipcRenderer.removeAllListeners('asr-progress');
    ipcRenderer.on('asr-progress', (_e, data) => cb(data));
  },

  saveFile: (name, data) => ipcRenderer.invoke('save-file', { name, data }),

  appVersion: () => ipcRenderer.invoke('app-version'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  autoUpdateSupported: () => ipcRenderer.invoke('auto-update-supported'),
  downloadUpdate: () => ipcRenderer.invoke('auto-update-download'),
  installUpdate: () => ipcRenderer.invoke('auto-update-install'),
  onAutoUpdate: (cb) => {
    ipcRenderer.removeAllListeners('auto-update');
    ipcRenderer.on('auto-update', (_e, data) => cb(data));
  },
});
