const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

/* Своя схема вместо file://: позволяет отдать заголовки изоляции,
   без которых WebAssembly считает в один поток вместо восьми. */
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(__dirname, 'renderer', rel);
    // Не выпускаем за пределы папки интерфейса
    if (!file.startsWith(path.join(__dirname, 'renderer'))) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, {
        headers: {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Resource-Policy': 'same-origin',
        },
      });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });
}

const MODEL_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
const MODEL_BYTES = 180534758;

let win = null;

function modelPath() {
  return path.join(app.getPath('userData'), 'htdemucs.onnx');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0a0a0f',
    title: 'Бэнэнгская Рапсодия',
    // Явно задаём иконку окну: без этого в dev-режиме Electron показывает
    // стандартную иконку, хотя installer уже использует нашу.
    icon: process.platform === 'win32'
      ? path.join(__dirname, 'build', 'icon.ico')
      : path.join(__dirname, 'build', 'icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Экспорт видео продолжает рисовать кадры при свёрнутом приложении.
      backgroundThrottling: false,
    },
  });
  win.loadURL('app://bundle/index.html');

  // Внешние ссылки открываем в обычном браузере, а не внутри приложения
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Самопроверка интерфейса: KARAOKE_SELFTEST=1 npm start
  if (process.env.KARAOKE_SELFTEST === '1') {
    win.webContents.on('console-message', (_e, _lvl, message) => {
      console.log('[renderer]', message);
    });
    win.webContents.once('did-finish-load', async () => {
      const report = await win.webContents.executeJavaScript(`(() => ({
        аиБлокВиден: !document.getElementById('ai-block').classList.contains('hidden'),
        кнопкаЕсть: !!document.getElementById('btn-ai-run'),
        мостПодключён: !!(window.desktop && window.desktop.isDesktop),
        шаговВсего: document.querySelectorAll('.step-tab').length,
        стильПрименён: !!document.getElementById('lyrics-stage').dataset.effect,
        ошибок: window.__errors ? window.__errors.length : 0
      }))()`);
      console.log('SELFTEST', JSON.stringify(report));
      const st = await win.webContents.executeJavaScript('window.desktop.modelStatus()');
      console.log('MODEL', JSON.stringify(st));

      if (st.ready && process.env.KARAOKE_E2E === '1') {
        const e2e = await win.webContents.executeJavaScript(`(async () => {
          try {
            const SR = 44100, n = SR * 25;
            const L = new Float32Array(n), R = new Float32Array(n);
            for (let i = 0; i < n; i++) {
              const t = i / SR;
              const bass = 0.30 * Math.sin(2 * Math.PI * 82 * t);
              const chord = 0.16 * (Math.sin(2*Math.PI*262*t) + Math.sin(2*Math.PI*330*t));
              const voice = 0.24 * Math.sin(2 * Math.PI * (440 + 6*Math.sin(2*Math.PI*5*t)) * t);
              L[i] = bass + chord*0.9 + voice; R[i] = bass + chord*1.1 + voice;
            }
            const bytes = await window.desktop.modelBytes();
            const t0 = Date.now();
            const res = await window.__runSeparationTest(new Uint8Array(bytes), L, R);
            if (!res.ok) return { ok: false, error: res.error };
            const out = new Float32Array(res.left);
            let bad = 0, e = 0;
            for (const v of out) { if (!Number.isFinite(v)) bad++; e += v*v; }
            let ein = 0; for (const v of L) ein += v*v;
            return { ok: true,
              секунд: ((Date.now()-t0)/1000).toFixed(1),
              звукаСек: (n/SR).toFixed(0),
              сэмплов: out.length, NaN: bad,
              RMSвход: Math.sqrt(ein/n).toFixed(4),
              RMSвыход: Math.sqrt(e/out.length).toFixed(4) };
          } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        })()`);
        console.log('E2E', JSON.stringify(e2e));
      }
      app.quit();
    });
  }
}

app.whenReady().then(() => {
  registerAppProtocol();
  createWindow();
  setupAutoUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------- Скачивание модели с прогрессом ---------- */
function downloadModel(dest) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);
    const get = (url, redirects = 0) => {
      if (redirects > 5) return reject(new Error('Слишком много перенаправлений'));
      https.get(url, { headers: { 'User-Agent': 'benengskaya' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('Сервер ответил ' + res.statusCode));
        }
        const total = parseInt(res.headers['content-length'], 10) || MODEL_BYTES;
        let done = 0;
        res.on('data', (chunk) => {
          done += chunk.length;
          send('model-progress', { done, total });
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          fs.renameSync(tmp, dest);
          resolve(dest);
        }));
      }).on('error', (err) => {
        fs.unlink(tmp, () => reject(err));
      });
    };
    get(MODEL_URL);
  });
}

ipcMain.handle('model-bytes', () => {
  const p = modelPath();
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  // Отдаём копию именно как ArrayBuffer, иначе на той стороне будет Buffer
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle('model-status', () => {
  const p = modelPath();
  return { ready: fs.existsSync(p), path: p, bytes: MODEL_BYTES };
});

ipcMain.handle('model-download', async () => {
  const p = modelPath();
  if (fs.existsSync(p)) return { ok: true, path: p };
  try {
    await downloadModel(p);
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* ---------- Проверка обновлений ----------
   Спрашиваем у GitHub последний релиз и сравниваем версии.
   Автоустановку не делаем: на macOS она требует подписи разработчика,
   которой у сборок нет, поэтому честно ведём на страницу загрузки. */
const RELEASES_API = 'https://api.github.com/repos/Gyros-dev/karaoke-maker/releases/latest';

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(RELEASES_API, {
      headers: { 'User-Agent': 'benengskaya', Accept: 'application/vnd.github+json' },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('GitHub ответил ' + res.statusCode));
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('нет ответа')); });
    req.on('error', reject);
  });
}

ipcMain.handle('check-update', async () => {
  try {
    const rel = await fetchLatestRelease();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    if (!latest) return { ok: false };
    const current = app.getVersion();
    if (compareVersions(latest, current) <= 0) return { ok: true, hasUpdate: false, current };
    // Ищем файл под текущую систему
    const assets = rel.assets || [];
    const wanted = process.platform === 'darwin' ? '.dmg' : '.exe';
    const asset = assets.find((a) => (a.name || '').toLowerCase().endsWith(wanted));
    return {
      ok: true,
      hasUpdate: true,
      current,
      latest,
      notes: (rel.body || '').slice(0, 400),
      url: (asset && asset.browser_download_url) || rel.html_url,
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('open-external', (_evt, url) => {
  // Открываем только релизы своего проекта
  if (/^https:\/\/(github\.com\/Gyros-dev\/karaoke-maker|objects\.githubusercontent\.com)\//.test(url)) {
    shell.openExternal(url);
    return true;
  }
  return false;
});

ipcMain.handle('app-version', () => app.getVersion());

/* ---------- Автообновление (только Windows) ----------
   На macOS механизм Electron требует подписи разработчика: без неё
   обновление скачается и молча не установится. Поэтому там остаётся
   уведомление со ссылкой, а полный цикл делаем под Windows. */
let updater = null;

function setupAutoUpdate() {
  if (process.platform !== 'win32') return;
  try {
    updater = require('electron-updater').autoUpdater;
  } catch (e) {
    console.error('[update]', e.message);
    return;
  }
  updater.autoDownload = false;          // спрашиваем, прежде чем качать
  updater.autoInstallOnAppQuit = true;

  updater.on('update-available', (info) => {
    send('auto-update', { stage: 'available', version: info.version });
  });
  updater.on('download-progress', (p) => {
    send('auto-update', { stage: 'progress', percent: Math.round(p.percent) });
  });
  updater.on('update-downloaded', (info) => {
    send('auto-update', { stage: 'ready', version: info.version });
  });
  updater.on('error', (err) => {
    send('auto-update', { stage: 'error', error: String(err && err.message || err) });
  });

  // Первая проверка чуть погодя, дальше раз в шесть часов
  setTimeout(() => updater.checkForUpdates().catch(() => {}), 8000);
  setInterval(() => updater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

ipcMain.handle('auto-update-supported', () => process.platform === 'win32' && !!updater);
ipcMain.handle('auto-update-download', async () => {
  if (!updater) return { ok: false };
  try {
    await updater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
ipcMain.handle('auto-update-install', () => {
  if (!updater) return false;
  // Закрываем приложение и ставим скачанное обновление
  setImmediate(() => updater.quitAndInstall(false, true));
  return true;
});

ipcMain.handle('save-file', async (_evt, { name, data }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: name });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, Buffer.from(data));
  return { ok: true, path: filePath };
});
