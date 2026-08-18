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
  '.onnx': 'application/octet-stream', '.txt': 'text/plain',
};

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';

    /* Модели распознавания лежат в папке настроек, а не в приложении:
       они качаются при первом использовании. Отдаём их по тому же
       адресу, чтобы transformers.js читал их как обычные файлы. */
    let file;
    if (rel === 'models' || rel.startsWith('models/')) {
      const inside = rel.slice('models'.length).replace(/^\/+/, '');
      const root = asrRoot();
      file = path.join(root, inside);
      if (!file.startsWith(root)) return new Response('forbidden', { status: 403 });
    } else {
      file = path.join(__dirname, 'renderer', rel);
      // Не выпускаем за пределы папки интерфейса
      if (!file.startsWith(path.join(__dirname, 'renderer'))) {
        return new Response('forbidden', { status: 403 });
      }
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

/* ---------- Модели распознавания текста (Whisper) ----------
   Лежат в папке настроек, качаются при первом использовании — так же,
   как модель разделения вокала. Имена файлов те, которые ищет
   transformers.js: onnx/<часть>_quantized.onnx плюс словарь и настройки. */
const ASR_COMMON = [
  'config.json', 'generation_config.json', 'preprocessor_config.json',
  'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json',
  'added_tokens.json', 'normalizer.json', 'vocab.json', 'merges.txt',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx',
];

/* Нужны сборки «_timestamped»: обычные экспортированы без внимания
   декодера к кодировщику, а без него меток по словам не получить. */
const ASR_MODELS = {
  base: {
    id: 'whisper-base_timestamped',
    repo: 'onnx-community/whisper-base_timestamped',
    label: 'Обычная (78 МБ)',
    bytes: 82 * 1024 * 1024,
    files: ASR_COMMON,
  },
  small: {
    id: 'whisper-small_timestamped',
    repo: 'onnx-community/whisper-small_timestamped',
    label: 'Крупная, точнее (242 МБ)',
    bytes: 254 * 1024 * 1024,
    files: ASR_COMMON,
  },
};

let win = null;

function modelPath() {
  return path.join(app.getPath('userData'), 'htdemucs.onnx');
}

function asrRoot() {
  return path.join(app.getPath('userData'), 'models');
}

function asrDir(key) {
  const m = ASR_MODELS[key];
  return m ? path.join(asrRoot(), m.id) : null;
}

/* Модель готова, если на месте оба веса: словарь без них бесполезен,
   а недокачанный файл лучше считать отсутствующим */
function asrReady(key) {
  const dir = asrDir(key);
  if (!dir) return false;
  return ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']
    .every((f) => {
      const p = path.join(dir, f);
      return fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024;
    });
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
        распознаваниеВидно: !document.getElementById('asr-block').classList.contains('hidden'),
        кнопкаРаспознавания: !!document.getElementById('btn-asr-run'),
        моделейРаспознавания: document.getElementById('asr-model').options.length,
        /* Два режима разметки текста: поле пустое — распознаём с нуля,
           текст вставлен — подгоняем его под песню. Проверяем сам
           переключатель: подпись кнопки, вторая кнопка и пояснения. */
        разметкаТекста: (() => {
          const поле = document.getElementById('lyrics-input');
          const было = поле.value;
          const снимок = () => ({
            кнопка: document.getElementById('btn-asr-run').textContent,
            сНуля: !document.getElementById('btn-asr-fresh').classList.contains('hidden'),
            проПодгонку: !document.getElementById('asr-about-fit').classList.contains('hidden'),
          });
          поле.value = '';
          поле.dispatchEvent(new Event('input'));
          const пусто = снимок();
          поле.value = 'строка раз\\nстрока два';
          поле.dispatchEvent(new Event('input'));
          const сТекстом = снимок();
          поле.value = было;
          поле.dispatchEvent(new Event('input'));
          return { пусто, сТекстом };
        })(),
        подгонкаЕсть: !!(window.Align && window.Align.fit),
        мостПодключён: !!(window.desktop && window.desktop.isDesktop),
        шаговВсего: document.querySelectorAll('.step-tab').length,
        стильПрименён: !!document.getElementById('lyrics-stage').dataset.effect,
        отсчётЕсть: !!document.getElementById('st-countdown'),
        // Окно «Что нового»: в приложении показываем пункты про нейросети
        // и прячем сайтовую строку «а в приложении ещё…»
        новостейВидно: [...document.querySelectorAll('.whatsnew-list li')]
          .filter((li) => getComputedStyle(li).display !== 'none').length,
        новостиПроНейросети: [...document.querySelectorAll('.whatsnew-list li.only-desktop')]
          .every((li) => getComputedStyle(li).display !== 'none'),
        сайтоваяСтрокаСкрыта: [...document.querySelectorAll('.only-web')]
          .every((el) => getComputedStyle(el).display === 'none'),
        ошибок: window.__errors ? window.__errors.length : 0
      }))()`);
      console.log('SELFTEST', JSON.stringify(report));
      console.log('ASR', JSON.stringify(await win.webContents.executeJavaScript('window.desktop.asrStatus()')));
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
            // Чистый вокал — отдельная дорожка для распознавания текста
            const voc = res.vocal ? new Float32Array(res.vocal) : null;
            let ev = 0, badV = 0;
            if (voc) for (const v of voc) { if (!Number.isFinite(v)) badV++; ev += v*v; }
            return { ok: true,
              секунд: ((Date.now()-t0)/1000).toFixed(1),
              звукаСек: (n/SR).toFixed(0),
              сэмплов: out.length, NaN: bad,
              RMSвход: Math.sqrt(ein/n).toFixed(4),
              RMSвыход: Math.sqrt(e/out.length).toFixed(4),
              вокалСэмплов: voc ? voc.length : 0,
              вокалNaN: badV,
              RMSвокал: voc ? Math.sqrt(ev/voc.length).toFixed(4) : null };
          } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        })()`);
        console.log('E2E', JSON.stringify(e2e));
      }

      /* Полная проверка распознавания: KARAOKE_ASR_E2E=путь-к-файлу.
         Годится всё, что умеет открыть само приложение (mp3, wav, m4a…):
         декодирует его тот же decodeAudioData, что и при обычной загрузке.

         Байты передаём строкой base64: список из миллионов чисел
         страница разбирала бы дольше, чем считает нейросеть.

         KARAOKE_ASR_SEP=1 — сначала выделить чистый вокал нейросетью
         и распознавать уже его, как задумано в приложении.

         KARAOKE_ASR_ALIGN=путь-к-тексту — вместо свободного распознавания
         подогнать под песню готовый текст: главный способ работы.

         KARAOKE_ASR_WORDS / KARAOKE_ASR_DUMP — сохранить услышанные слова
         с метками в файл и брать их оттуда в следующий раз. Подгонку тогда
         можно проверять за секунду, не гоняя нейросеть по новой. */
      const asrFile = process.env.KARAOKE_ASR_E2E;
      if (asrFile && fs.existsSync(asrFile)) {
        const b64 = fs.readFileSync(asrFile).toString('base64');
        const lang = process.env.KARAOKE_ASR_LANG || 'russian';
        const key = process.env.KARAOKE_ASR_MODEL || 'base';
        const sep = process.env.KARAOKE_ASR_SEP === '1';
        const alignFile = process.env.KARAOKE_ASR_ALIGN;
        const dumpFile = process.env.KARAOKE_ASR_DUMP;
        const wordsFile = process.env.KARAOKE_ASR_WORDS;

        const lyrics = alignFile && fs.existsSync(alignFile)
          ? fs.readFileSync(alignFile, 'utf8') : null;
        const words = wordsFile && fs.existsSync(wordsFile)
          ? JSON.parse(fs.readFileSync(wordsFile, 'utf8')) : null;

        // Готовые слова нейросети не требуют — модель качать незачем
        const dl = words ? { ok: true } : await win.webContents.executeJavaScript(
          `window.desktop.asrDownload(${JSON.stringify(key)})`);
        if (!words) console.log('ASR-DOWNLOAD', JSON.stringify(dl));
        if (dl.ok) {
          const call = lyrics
            ? `window.__runFitTest(buf, ${JSON.stringify(lyrics)}, ${JSON.stringify(lang)},
                 ${JSON.stringify(key)}, опции)`
            : `window.__runAsrTest(buf, ${JSON.stringify(lang)}, ${JSON.stringify(key)}, опции)`;
          const res = await win.webContents.executeJavaScript(`(async () => {
            try {
              window.__asrDebug = ${process.env.KARAOKE_ASR_DEBUG === '1'};
              const bin = atob(${JSON.stringify(b64)});
              const raw = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
              const buf = await audio.ensureCtx().decodeAudioData(raw.buffer);
              const опции = { separate: ${sep ? 'true' : 'false'},
                words: ${words ? JSON.stringify(words) : 'null'} };
              const t0 = Date.now();
              const out = await ${call};
              return { ...out, секунд: ((Date.now() - t0) / 1000).toFixed(1) };
            } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
          })()`, true);
          if (dumpFile && res.всеСлова) {
            fs.writeFileSync(dumpFile, JSON.stringify(res.всеСлова));
            console.log('ASR-DUMP', dumpFile, res.всеСлова.length, 'слов');
          }
          delete res.всеСлова;
          console.log(lyrics ? 'FIT-E2E' : 'ASR-E2E', JSON.stringify(res));
        }
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
          // Адрес может быть относительным — достраиваем от текущего
          return get(new URL(res.headers.location, url).href, redirects + 1);
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

/* ---------- Скачивание модели распознавания ----------
   Файлов много и они разного размера, поэтому прогресс считаем по
   суммарным байтам. Отмена рвёт текущий запрос и удаляет недокачанное. */
let asrAbort = null;

function fetchTo(url, dest, onChunk) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(tmp);
    const cleanup = (err) => { file.destroy(); fs.unlink(tmp, () => reject(err)); };
    const get = (u, redirects = 0) => {
      if (redirects > 8) return cleanup(new Error('Слишком много перенаправлений'));
      const req = https.get(u, { headers: { 'User-Agent': 'benengskaya' }, timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          // HuggingFace отвечает относительным адресом — достраиваем его
          // от текущего, иначе запрос уходит в никуда и всё зависает
          return get(new URL(res.headers.location, u).href, redirects + 1);
        }
        if (res.statusCode === 404) {
          // Необязательный файл: у части моделей его просто нет
          res.resume();
          file.destroy();
          return fs.unlink(tmp, () => resolve({ skipped: true }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return cleanup(new Error('Сервер ответил ' + res.statusCode));
        }
        res.on('data', (chunk) => onChunk(chunk.length));
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          try { fs.renameSync(tmp, dest); resolve({ skipped: false }); }
          catch (e) { reject(e); }
        }));
      });
      req.on('error', cleanup);
      req.on('timeout', () => req.destroy(new Error('сервер не отвечает')));
      if (asrAbort) asrAbort.reqs.push(req);
    };
    get(url);
  });
}

ipcMain.handle('asr-status', () => {
  const models = Object.entries(ASR_MODELS).map(([key, m]) => ({
    key, label: m.label, bytes: m.bytes, ready: asrReady(key),
  }));
  return { models, root: asrRoot() };
});

ipcMain.handle('asr-download', async (_evt, key) => {
  const m = ASR_MODELS[key];
  if (!m) return { ok: false, error: 'неизвестная модель' };
  if (asrReady(key)) return { ok: true };

  const dir = asrDir(key);
  asrAbort = { cancelled: false, reqs: [] };
  const total = m.bytes;
  let done = 0;
  try {
    for (const rel of m.files) {
      if (asrAbort.cancelled) throw new Error('отменено');
      const dest = path.join(dir, rel);
      if (fs.existsSync(dest)) { continue; }
      const url = `https://huggingface.co/${m.repo}/resolve/main/${rel}`;
      await fetchTo(url, dest, (n) => {
        done += n;
        send('asr-progress', { done, total: Math.max(total, done) });
      });
    }
    asrAbort = null;
    return { ok: true };
  } catch (err) {
    const cancelled = asrAbort && asrAbort.cancelled;
    asrAbort = null;
    return { ok: false, error: cancelled ? 'отменено' : String(err.message || err) };
  }
});

ipcMain.handle('asr-cancel', () => {
  if (!asrAbort) return false;
  asrAbort.cancelled = true;
  asrAbort.reqs.forEach((r) => { try { r.destroy(); } catch (e) { /* уже закрыт */ } });
  return true;
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
