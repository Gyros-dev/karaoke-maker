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
/* Ниже этого размера файл — не модель, а огрызок: обрезанный
   htdemucs.onnx раньше считался готовым навсегда, разделение падало
   на разборе protobuf, и выйти из этого из интерфейса было нельзя.
   Точного совпадения не требуем: на HuggingFace могут переложить
   чуть иную сборку, а вот недобор в проценты — это уже обрезок. */
const MODEL_MIN_BYTES = Math.floor(MODEL_BYTES * 0.98);

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
   декодера к кодировщику, а без него меток по словам не получить.

   Порядок важен: первой идёт лучшая модель — она же и выбрана по
   умолчанию. Подписи говорят, чем платишь за скорость: обычная модель
   считает примерно вдвое быстрее, но слышит хуже. */
/* weights — настоящие размеры весов на HuggingFace. По ним отличаем
   целый файл от обрезанного: проверки «существует и больше мегабайта»
   хватало, чтобы недокачанные веса числились готовой моделью. */
const ASR_MODELS = {
  small: {
    id: 'whisper-small_timestamped',
    repo: 'onnx-community/whisper-small_timestamped',
    label: 'Крупная, 242 МБ — слышит лучше всех',
    bytes: 254 * 1024 * 1024,
    files: ASR_COMMON,
    weights: {
      'onnx/encoder_model_quantized.onnx': 92240498,
      'onnx/decoder_model_merged_quantized.onnx': 156795750,
    },
  },
  base: {
    id: 'whisper-base_timestamped',
    repo: 'onnx-community/whisper-base_timestamped',
    label: 'Обычная, 78 МБ — вдвое быстрее, но хуже',
    bytes: 82 * 1024 * 1024,
    files: ASR_COMMON,
    weights: {
      'onnx/encoder_model_quantized.onnx': 23159167,
      'onnx/decoder_model_merged_quantized.onnx': 53712708,
    },
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

function размерФайла(p) {
  try { return fs.statSync(p).size; } catch (e) { return null; }
}

/* Модель разделения готова, только если файл на месте и он нужной
   длины. Одного existsSync мало: обрезанный файл ничем не хуже
   целого выглядел, а на деле разделение падало на разборе protobuf. */
function modelReady() {
  const size = размерФайла(modelPath());
  return size !== null && size >= MODEL_MIN_BYTES;
}

/* ---------- Что уже скачано у модели распознавания ----------
   Размеры скачанных файлов запоминаем: сервер сообщает их в ответе,
   а потом по ним видно, цел ли файл. Без этого недокачанный файл
   пропускался как готовый и модель оставалась битой навсегда. */
function asrSizesPath(dir) { return path.join(dir, '.sizes.json'); }

function readAsrSizes(dir) {
  try { return JSON.parse(fs.readFileSync(asrSizesPath(dir), 'utf8')); }
  catch (e) { return {}; }
}

function writeAsrSizes(dir, sizes) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(asrSizesPath(dir), JSON.stringify(sizes));
  } catch (e) { /* без записи проверка просто станет мягче */ }
}

/* Файл на месте и цел. Если размер записан при скачивании — сверяем
   с ним точно. Для старых установок записи нет: веса тогда сверяем
   с ожидаемым размером, а мелочь принимаем непустой. */
function asrFileOk(dir, m, sizes, rel) {
  const size = размерФайла(path.join(dir, rel));
  if (size === null) return false;
  if (sizes[rel] != null) return size === sizes[rel];
  const ждём = m.weights[rel];
  if (ждём) return size >= Math.floor(ждём * 0.98);
  return size > 0;
}

/* Модель готова, если на месте оба веса нужной длины: словарь без них
   бесполезен, а недокачанный файл лучше считать отсутствующим.
   Заодно проверяем всё, чей размер мы знаем: битый словарь тоже
   должен перекачиваться, а не запирать человека навсегда. */
function asrReady(key) {
  const dir = asrDir(key);
  const m = ASR_MODELS[key];
  if (!dir || !m) return false;
  const sizes = readAsrSizes(dir);
  return Object.keys(m.weights).every((rel) => asrFileOk(dir, m, sizes, rel))
    && m.files.every((rel) => sizes[rel] == null || asrFileOk(dir, m, sizes, rel));
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
        /* Умолчания качества. Человек просил «только лучший результат»,
           поэтому сразу выбрано лучшее: три прохода разделения и крупная
           модель распознавания. Быстрые варианты обязаны остаться
           в списках (их не удаляли, только спрятали), а сами блоки
           «Ещё варианты» — быть свёрнутыми. */
        качество: (() => {
          const проходы = document.getElementById('ai-quality');
          const модель = document.getElementById('asr-model');
          const свёртки = [...document.querySelectorAll('.ai-more, .asr-more')];
          const быстрыйПроход = [...проходы.options].some((o) => o.value === '1');
          const обычнаяМодель = [...модель.options].some((o) => o.value === 'base');
          const свёрнуто = свёртки.length === 2 && свёртки.every((d) => !d.open);
          return {
            проходов: проходы.value,
            модель: модель.value,
            быстрыйПроход,
            обычнаяМодель,
            свёрнуто,
            // Быстрые варианты спрятаны, но не видны на экране без раскрытия
            быстрыеСкрыты: свёртки.every((d) => d.offsetHeight < 40),
            вНорме: проходы.value === '3' && модель.value === 'small'
              && быстрыйПроход && обычнаяМодель && свёрнуто,
          };
        })(),
        /* Оценка времени. Считается из длины трека, поэтому проверяем её
           на длине настоящего замера — песня 2 мин 53 с (173 с). Настоящие
           числа на этом Маке: разделение одним проходом ≈159 с, обычная
           модель по миксу 104 с, крупная по миксу 202 с, крупная по чистому
           вокалу 355 с. Вилки нарочно широкие: важно не наврать в разы. */
        оценкаВремени: (() => {
          const o = window.__оценкаВремени(173);
          const в = (v, от, до) => v >= от && v <= до;
          return {
            ...o,
            строкаРазделения: document.getElementById('ai-eta').textContent,
            строкаРаспознавания: document.getElementById('asr-eta').textContent,
            вНорме: в(o.разделениеБыстро, 100, 240)
              && в(o.разделениеЛучшее, 320, 700)
              && в(o.распознаваниеОбычная, 60, 160)
              && в(o.распознаваниеКрупная, 130, 290)
              && в(o.распознаваниеПоВокалу, 240, 480)
              && /минут/.test(o.словами)
              && o.короткое === 'меньше минуты'
              && o.пустое === 'несколько минут'
              && document.getElementById('ai-eta').textContent.length > 20
              && document.getElementById('asr-eta').textContent.length > 20,
          };
        })(),
        подгонкаЕсть: !!(window.Align && window.Align.fit),
        мостПодключён: !!(window.desktop && window.desktop.isDesktop),
        шаговВсего: document.querySelectorAll('.step-tab').length,   // четыре: песня → текст → редактор → караоке
        стильПрименён: !!document.getElementById('lyrics-stage').dataset.effect,
        отсчётЕсть: !!document.getElementById('st-countdown'),
        /* Размер строк на сцене. Пока текст влезает по ширине, обе раскладки
           («строки меняются местами» и закреплённые места) обязаны давать
           один и тот же размер — базовый. Признак ловит дефект, из-за
           которого закреплённые строки ужимались до предела: их коробка
           шире полей сцены, и подгонка по ширине срабатывала впустую. */
        размерСтрок: (() => {
          const панель = document.getElementById('step-4');
          const былаАктивна = панель.classList.contains('active');
          панель.classList.add('active');   // скрытую сцену не измерить
          const строкиБыли = state.lines;
          const свапБыл = state.style.swapLines;
          state.lines = [
            { text: 'Короткая строка', time: 0, end: 3 },
            { text: 'Ещё одна короткая', time: 3, end: 6 },
          ];
          const мера = (меняются) => {
            state.style.swapLines = меняются;
            applyStyle();
            const сцена = document.getElementById('lyrics-stage');
            const cs = getComputedStyle(сцена);
            const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
            const базовый = parseFloat(cs.getPropertyValue('--st-size')) * rem;
            const размеры = [...сцена.querySelectorAll('.stage-line')]
              .map((el) => parseFloat(getComputedStyle(el).fontSize));
            return {
              базовый: +базовый.toFixed(2),
              строк: размеры.length,
              минимум: размеры.length ? +Math.min(...размеры).toFixed(2) : null,
              максимум: размеры.length ? +Math.max(...размеры).toFixed(2) : null,
            };
          };
          const местами = мера(true);
          const закреплённые = мера(false);
          state.lines = строкиБыли;
          state.style.swapLines = свапБыл;
          applyStyle();
          if (!былаАктивна) панель.classList.remove('active');
          /* Кегль единый на всю песню, поэтому мерить надо не «равен ли он
             базовому» (он законно ужимается, если сцена узкая), а то, что
             он ОДИН для всех строк — ровно этого не хватало, когда каждая
             строка ужималась сама по себе и размер прыгал. Крупнее
             базового не делаем никогда, только ужимаем. */
          const вНорме = (м) => м.строк > 0 && м.базовый > 0
            && Math.abs(м.максимум - м.минимум) < 0.01
            && м.максимум <= м.базовый + 0.01;
          return {
            местами,
            закреплённые,
            // оба режима должны давать не только единый, но и одинаковый кегль
            совпадает: вНорме(местами) && вНорме(закреплённые)
              && Math.abs(местами.минимум - закреплённые.минимум) < 0.01,
          };
        })(),
        /* Редактор: дорожка блоками, отмена действий и полоса голоса.
           Подкладываем короткую «песню» и три строки, гоняем на них всё,
           что должно работать, и возвращаем прежнее состояние. */
        редактор: (() => {
          const былиСтроки = state.lines;
          const былБуфер = state.originalBuffer;
          const былаДлина = audio.duration;
          const былГолос = { level: voice.level, runs: voice.runs };
          const панель = document.getElementById('step-3');
          const былаАктивна = панель.classList.contains('active');
          try {
            const SR = 8000, dur = 30;
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const buf = ctx.createBuffer(1, SR * dur, SR);
            const d = buf.getChannelData(0);
            for (let i = 0; i < d.length; i++) d[i] = 0.2 * Math.sin(i / 20);
            state.originalBuffer = buf;
            audio.duration = dur;
            state.lines = [
              { text: 'Раз строка', time: 2, end: null, ручнойКонец: false, сомнительная: false },
              { text: 'Два строка', time: 10, end: null, ручнойКонец: false, сомнительная: true },
              { text: 'Три строка', time: 18, end: null, ручнойКонец: false, сомнительная: false },
            ];
            clearVoiceTrack();
            панель.classList.add('active');   // скрытую дорожку не измерить
            editor.peaks = null;
            openEditor();

            const полосБезГолоса = Object.keys(timelineLanes()).length - 1;
            const блоки = editorSpans().map((s) => +(s.end - s.start).toFixed(2));
            const слов = lineWords(state.lines[0], editorSpans()[0]).length;

            // Отмена и повтор: двигаем строку и возвращаем её на место
            selectLine(0, {});
            const было = state.lines[0].time;
            pushHistory();
            setLineTime(0, было + 1.5);
            const сдвинулось = state.lines[0].time;
            undoEdit();
            const послеОтмены = state.lines[0].time;
            redoEdit();
            const послеПовтора = state.lines[0].time;
            undoEdit();

            /* Огибающая голоса: с ней у дорожки появляется своя полоса,
               а границы притягиваются к настоящему вступлению пения */
            const n = dur * VOICE_RATE;
            const level = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
              const t = i / VOICE_RATE;
              const поют = state.lines.some((l) => t >= l.time && t <= l.time + 3);
              level[i] = voiceDbCode(поют ? -5 : -50);
            }
            voice.level = level;
            voice.runs = buildVoiceRuns(level);
            editor.peaks = null;
            openEditor();
            const полосСГолосом = Object.keys(timelineLanes()).length - 1;
            const вступление = voice.runs[0].start;
            const притянулось = snapToVoice(вступление + 0.06);

            return {
              полосБезГолоса,          // линейка, волна, строки, слова
              полосСГолосом,           // и ещё голос
              блоки,                   // длины строк в секундах, все > 0
              слов,
              отменаРаботает: сдвинулось !== было && послеОтмены === было
                && послеПовтора === сдвинулось,
              притяжениеКГолосу: Math.abs(притянулось - вступление) < 1e-6,
              кнопкиЕсть: !!(document.getElementById('tl-undo')
                && document.getElementById('tl-loop') && document.getElementById('tl-fit')),
              вНорме: полосБезГолоса === 4 && полосСГолосом === 5
                && блоки.length === 3 && блоки.every((v) => v > 0),
            };
          } finally {
            state.lines = былиСтроки;
            state.originalBuffer = былБуфер;
            audio.duration = былаДлина;
            voice.level = былГолос.level;
            voice.runs = былГолос.runs;
            editor.peaks = null;
            editor.sel = -1;
            editor.spansKey = '';
            clearHistory();
            if (!былаАктивна) панель.classList.remove('active');
          }
        })(),
        /* Режим простукивания. Проверяем не наличие кнопок, а само
           поведение: забирает ли режим экран себе и по каким правилам
           переписываются метки. Стучим не вызовами tapHit, а пробелом
           через общий обработчик — тем же путём, что и человек.

           Правила, которые обязаны держаться:
             • вход в режим ничего не стирает;
             • метки раньше места входа не трогаются;
             • строки, до которых не дошли, остаются как были;
             • «отменить последнюю» возвращает один удар;
             • Cmd+Z снимает весь заход целиком. */
        простукивание: (() => {
          const былиСтроки = state.lines;
          const былБуфер = state.originalBuffer;
          const былаДлина = audio.duration;
          const панель = document.getElementById('step-3');
          const былаАктивна = панель.classList.contains('active');
          const былConfirm = window.confirm;
          try {
            const SR = 8000, dur = 30;
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const buf = ctx.createBuffer(1, SR * dur, SR);
            state.originalBuffer = buf;
            audio.duration = dur;
            state.lines = [1, 2, 3, 4, 5].map((n) => ({
              text: 'Строка ' + n, time: n * 4, end: null,
              ручнойКонец: false, сомнительная: false,
            }));
            панель.classList.add('active');
            editor.peaks = null;
            clearHistory();
            openEditor();
            window.confirm = () => false;   // вопрос про порядок здесь не проверяем

            const времена = () => state.lines.map((l) => (l.time == null ? null : +l.time.toFixed(2)));
            const пробел = (t) => {
              audio.pause(); audio.offset = t;
              document.dispatchEvent(new KeyboardEvent('keydown',
                { code: 'Space', key: ' ', bubbles: true }));
              audio.pause();
            };
            const доЗахода = времена();

            // Заход с середины: строка №3
            startTapMode(2); audio.pause();
            const приВходе = времена();
            const скрыто = {
              сетка: document.getElementById('edit-list').offsetParent === null,
              предпросмотр: document.getElementById('edit-stage').offsetParent === null,
              панельСтроки: document.getElementById('sel-panel').offsetParent === null,
              инструменты: document.querySelector('.timeline-tools').offsetParent === null,
            };
            const видно = {
              строка: document.getElementById('tap-now').textContent,
              следующая: document.getElementById('tap-next').textContent,
              счётчик: document.getElementById('tap-count').textContent,
              дорожка: document.getElementById('timeline').offsetParent !== null,
              кнопок: document.querySelectorAll('#tap-mode .tap-actions button').length,
            };
            const блоковДоУдара = editorSpans().length;
            пробел(13.5);
            пробел(17.5);
            const послеДвухУдаров = времена();
            // Метки появляются на дорожке на глазах: блоков не убавилось
            const блоковПослеУдара = editorSpans().length;
            undoLastTap(); audio.pause();
            const послеОтменыУдара = времена();
            finishTapMode();
            const послеЗахода = времена();
            // Общая отмена снимает заход целиком
            document.dispatchEvent(new KeyboardEvent('keydown',
              { code: 'KeyZ', key: 'z', metaKey: true, bubbles: true }));
            const послеCmdZ = времена();

            const режимЗабралЭкран = скрыто.сетка && скрыто.предпросмотр
              && скрыто.панельСтроки && скрыто.инструменты && видно.дорожка
              && видно.кнопок === 2 && видно.строка === 'Строка 3'
              && видно.следующая === 'Строка 4';
            // Вход в режим не стирает ни одной метки
            const входНеСтирает = приВходе.every((v, i) => v === доЗахода[i]);
            // Ранние метки целы, недошедшие — тоже, переписано только простуканное
            const раннихНеТронули = послеЗахода[0] === доЗахода[0] && послеЗахода[1] === доЗахода[1];
            const недошедшихНеТронули = послеЗахода[4] === доЗахода[4];
            const переписалиЧтоПростучали = послеДвухУдаров[2] === 13.5 && послеДвухУдаров[3] === 17.5;
            const отменаУдара = послеОтменыУдара[3] === доЗахода[3] && послеОтменыУдара[2] === 13.5;
            const заходСнимаетсяЦеликом = послеCmdZ.every((v, i) => v === доЗахода[i]);
            return {
              доЗахода, приВходе, послеДвухУдаров, послеОтменыУдара, послеЗахода, послеCmdZ,
              видно, скрыто, блоковДоУдара, блоковПослеУдара,
              режимЗабралЭкран, входНеСтирает, раннихНеТронули, недошедшихНеТронули,
              переписалиЧтоПростучали, отменаУдара, заходСнимаетсяЦеликом,
              вНорме: режимЗабралЭкран && входНеСтирает && раннихНеТронули
                && недошедшихНеТронули && переписалиЧтоПростучали && отменаУдара
                && заходСнимаетсяЦеликом && блоковПослеУдара >= блоковДоУдара,
            };
          } finally {
            window.confirm = былConfirm;
            state.lines = былиСтроки;
            state.originalBuffer = былБуфер;
            audio.duration = былаДлина;
            editor.peaks = null;
            editor.sel = -1;
            editor.spansKey = '';
            clearHistory();
            if (!былаАктивна) панель.classList.remove('active');
          }
        })(),
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

      /* Звук: проверка считает, а не слушает. Гоняет поддельную песню
         с известным голосом через ту же цепь, что играет в колонки,
         при вокале 0 и 100. Ловит то, на что жаловались: голос слышен
         на нуле, вторая копия сигнала со сдвигом (эхо), перегруз. */
      console.log('ЗВУК', JSON.stringify(
        await win.webContents.executeJavaScript('самопроверкаЗвука()')));

      console.log('ASR', JSON.stringify(await win.webContents.executeJavaScript('window.desktop.asrStatus()')));
      const st = await win.webContents.executeJavaScript('window.desktop.modelStatus()');
      console.log('MODEL', JSON.stringify(st));

      /* Настоящее разделение на 25 секундах звука. KARAOKE_E2E=1 гоняет
         режим, выбранный в интерфейсе (по умолчанию лучший, три прохода),
         KARAOKE_E2E=быстро — быстрый: он спрятан в «Ещё вариантах», но
         обязан работать, а не просто числиться в списке. */
      if (st.ready && process.env.KARAOKE_E2E) {
        const проходов = process.env.KARAOKE_E2E === 'быстро' ? 1 : null;
        const e2e = await win.webContents.executeJavaScript(`(async () => {
          try {
            const выбор = ${проходов === null ? "Number(document.getElementById('ai-quality').value)" : проходов};
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
            const res = await window.__runSeparationTest(new Uint8Array(bytes), L, R, выбор);
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
              проходов: выбор,
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
        // По умолчанию проверяем то же, что получит человек, — крупную модель.
        // Быстрый путь: KARAOKE_ASR_MODEL=base.
        const key = process.env.KARAOKE_ASR_MODEL || 'small';
        const sep = process.env.KARAOKE_ASR_SEP === '1';
        const alignFile = process.env.KARAOKE_ASR_ALIGN;
        const dumpFile = process.env.KARAOKE_ASR_DUMP;
        const wordsFile = process.env.KARAOKE_ASR_WORDS;
        /* Огибающая голоса — то же самое, но для сцены: один раз выгрузить
           после разделения и дальше подставлять готовую, не слушая песню
           заново. Пороги проигрыша тогда подбираются за секунды. */
        const voiceDumpFile = process.env.KARAOKE_VOICE_DUMP;
        const voiceFile = process.env.KARAOKE_VOICE;

        const lyrics = alignFile && fs.existsSync(alignFile)
          ? fs.readFileSync(alignFile, 'utf8') : null;
        const words = wordsFile && fs.existsSync(wordsFile)
          ? JSON.parse(fs.readFileSync(wordsFile, 'utf8')) : null;
        const voiceText = voiceFile && fs.existsSync(voiceFile)
          ? fs.readFileSync(voiceFile, 'utf8').trim() : null;

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
              const голос = ${voiceText ? JSON.stringify(voiceText) : 'null'};
              if (голос) window.__voiceLoad(голос, buf.duration);
              const опции = { separate: ${sep ? 'true' : 'false'},
                words: ${words ? JSON.stringify(words) : 'null'} };
              const t0 = Date.now();
              const out = await ${call};
              return { ...out, огибающая: window.__voiceDump(),
                секунд: ((Date.now() - t0) / 1000).toFixed(1) };
            } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
          })()`, true);
          if (dumpFile && res.всеСлова) {
            fs.writeFileSync(dumpFile, JSON.stringify(res.всеСлова));
            console.log('ASR-DUMP', dumpFile, res.всеСлова.length, 'слов');
          }
          if (voiceDumpFile && res.огибающая) {
            fs.writeFileSync(voiceDumpFile, res.огибающая);
            console.log('VOICE-DUMP', voiceDumpFile, res.огибающая.length, 'байт base64');
          }
          delete res.всеСлова;
          delete res.огибающая;
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

/* ---------- Скачивание модели с прогрессом ----------
   Возвращает не голое обещание, а пару «обещание + отмена»: без отмены
   загрузку нечем остановить, и она доживает до конца работы приложения.

   Главное правило здесь — обещание обязано завершиться ровно один раз
   и ни одна ошибка не должна вылететь из колбэка потока. Раньше
   переименование делалось прямо в колбэке file.close без перехвата:
   стоило второй загрузке добраться до того же .part первой — и опоздавший
   падал с необработанным исключением. Electron показывал системное окно
   «A JavaScript error occurred in the main process», и приложение вставало
   намертво: окно модальное, закрыть его из программы уже нечем. */
function downloadModel(dest) {
  const tmp = dest + '.part';
  let stop = () => {};
  const promise = new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmp);
    let завершено = false;
    let resp = null;
    let req = null;
    /* Единственный выход из этой функции: и успех, и ошибка, и отмена */
    const finish = (err) => {
      if (завершено) return;
      завершено = true;
      if (!err) return resolve(dest);
      try { if (resp) resp.destroy(); } catch (e) { /* уже закрыт */ }
      try { if (req) req.destroy(); } catch (e) { /* уже закрыт */ }
      try { file.destroy(); } catch (e) { /* уже закрыт */ }
      fs.unlink(tmp, () => reject(err));
    };
    stop = () => finish(new Error('отменено'));
    // Например, кончилось место на диске: без этого обработчика ошибка
    // записи никого не будила и загрузка висела вечно
    file.on('error', finish);

    const get = (url, redirects = 0) => {
      if (завершено) return;
      if (redirects > 5) return finish(new Error('Слишком много перенаправлений'));
      req = https.get(url, { headers: { 'User-Agent': 'benengskaya' }, timeout: 30000 }, (res) => {
        if (завершено) { res.resume(); return; }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          // Адрес может быть относительным — достраиваем от текущего
          return get(new URL(res.headers.location, url).href, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return finish(new Error('Сервер ответил ' + res.statusCode));
        }
        resp = res;
        const total = parseInt(res.headers['content-length'], 10) || MODEL_BYTES;
        let done = 0;
        res.on('data', (chunk) => {
          done += chunk.length;
          send('model-progress', { done, total });
        });
        res.on('error', finish);          // обрыв связи на середине
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          try {
            // Оборванная загрузка тоже доходит до 'finish' — сверяем длину
            if (done !== total) {
              throw new Error(`модель пришла не целиком: ${done} из ${total} байт`);
            }
            fs.renameSync(tmp, dest);
            finish(null);
          } catch (e) { finish(e); }
        }));
      });
      req.on('error', finish);
      req.on('timeout', () => req.destroy(new Error('сервер не отвечает')));
    };
    get(MODEL_URL);
  });
  return { promise, cancel: () => stop() };
}

/* Идущая загрузка модели — одна на всех. Второй вызов подхватывает её,
   а не начинает вторую в тот же самый .part. */
let modelDownload = null;

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
          return fs.unlink(tmp, () => resolve({ skipped: true, bytes: 0 }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return cleanup(new Error('Сервер ответил ' + res.statusCode));
        }
        // Сколько байт обещал сервер: оборванная раздача тоже доходит
        // до 'finish', и без сверки длины огрызок сходил за целый файл
        const ждём = parseInt(res.headers['content-length'], 10) || 0;
        let получено = 0;
        res.on('data', (chunk) => { получено += chunk.length; onChunk(chunk.length); });
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          try {
            if (ждём && получено !== ждём) {
              throw new Error(`файл пришёл не целиком: ${получено} из ${ждём} байт`);
            }
            fs.renameSync(tmp, dest);
            resolve({ skipped: false, bytes: получено });
          } catch (e) { cleanup(e); }
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
  const sizes = readAsrSizes(dir);
  let done = 0;
  try {
    for (const rel of m.files) {
      if (asrAbort.cancelled) throw new Error('отменено');
      const dest = path.join(dir, rel);
      /* Пропускаем только целые файлы. Раньше хватало existsSync —
         и недокачанный файл оставался битым навсегда. */
      if (asrFileOk(dir, m, sizes, rel)) { continue; }
      const url = `https://huggingface.co/${m.repo}/resolve/main/${rel}`;
      const res = await fetchTo(url, dest, (n) => {
        done += n;
        send('asr-progress', { done, total: Math.max(total, done) });
      });
      // Запоминаем длину скачанного: по ней потом видно, цел ли файл
      if (!res.skipped) { sizes[rel] = res.bytes; writeAsrSizes(dir, sizes); }
    }
    asrAbort = null;
    /* Если после честной загрузки модель всё ещё не считается готовой,
       честнее сказать об этом, чем звать качать по кругу. */
    if (!asrReady(key)) return { ok: false, error: 'модель скачалась не целиком' };
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
  const есть = размерФайла(p);
  return {
    ready: modelReady(),
    path: p,
    bytes: MODEL_BYTES,
    // Сколько байт лежит на диске и битый ли файл — для понятных сообщений
    have: есть === null ? 0 : есть,
    broken: есть !== null && !modelReady(),
  };
});

ipcMain.handle('model-download', async () => {
  const p = modelPath();
  if (modelReady()) return { ok: true, path: p };
  /* Битый или недокачанный файл убираем сами: кнопки «скачать заново»
     в интерфейсе нет, и без этого человек оставался запертым навсегда
     — разделение падало, а перекачать модель было нечем. */
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch (e) { /* перекачаем поверх */ }
  }
  /* Два одновременных скачивания в один файл — тот самый случай, после
     которого приложение вставало намертво. Ждём уже идущее. */
  if (!modelDownload) {
    const свой = downloadModel(p);
    modelDownload = свой;
    const убрать = () => { if (modelDownload === свой) modelDownload = null; };
    свой.promise.then(убрать, убрать);
  }
  try {
    await modelDownload.promise;
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/* Отмена загрузки модели: рвёт запрос, завершает обещание и убирает
   недокачанный .part. Без неё «Отмена» в интерфейсе гасила только
   расчёт, а качать продолжало до победного. */
ipcMain.handle('model-cancel', () => {
  if (!modelDownload) return false;
  modelDownload.cancel();
  return true;
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
