const { contextBridge, ipcRenderer } = require('electron');

/* Мостик между интерфейсом и «тяжёлой» частью приложения.
   Наружу отдаём только конкретные функции — доступа к Node у страницы нет. */
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,

  /* Какая система под нами — 'darwin', 'win32' или 'linux'. Нужно
     подписям горячих клавиш: на Маке модификатор Cmd, на остальных Ctrl,
     а сама страница про систему ничего не знает. */
  platform: process.platform,

  modelStatus: () => ipcRenderer.invoke('model-status'),
  modelBytes: () => ipcRenderer.invoke('model-bytes'),
  downloadModel: () => ipcRenderer.invoke('model-download'),
  // Отмена скачивания: рвёт загрузку и убирает недокачанный файл
  cancelModelDownload: () => ipcRenderer.invoke('model-cancel'),
  // Убрать прежнюю модель Demucs — только по согласию человека
  removeOldModel: () => ipcRenderer.invoke('model-remove-old'),
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

  /* Язык интерфейса. Меню приложения собирается в главном процессе,
     и о выборе, который живёт в хранилище страницы, он узнаёт только
     отсюда: страница говорит язык при запуске и при каждой смене. */
  setLanguage: (lang) => ipcRenderer.invoke('set-language', lang),

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
