const { app, BrowserWindow, Menu, ipcMain, dialog, shell, protocol, net } = require('electron');
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

/* Модель разделения — UVR-MDX-NET-Inst_HQ_3, та самая, которой
   считает UVR5. Она и лучше прежней htdemucs, и втрое легче:
   64 МБ против 172. Замерено на нашей песне против минусовки,
   сделанной настоящим UVR5: расхождение −24,9 дБ вместо −16,0,
   совпадение по амплитуде 94,3 % вместо 84,1 %. */
const MODEL_URL = 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Inst_HQ_3.onnx';
const MODEL_BYTES = 66759214;
/* Ниже этого размера файл — не модель, а огрызок: обрезанная модель
   раньше считалась готовой навсегда, разделение падало на разборе
   protobuf, и выйти из этого из интерфейса было нельзя. Точного
   совпадения не требуем: сборку могут переложить, а вот недобор
   в проценты — это уже обрезок. */
const MODEL_MIN_BYTES = Math.floor(MODEL_BYTES * 0.98);

/* Прежняя модель. Её больше не качаем и не используем, но у тех, кто
   уже пользовался приложением, она лежит на диске и занимает 172 МБ.
   Молча чужое место не освобождают — предлагаем убрать, спросив. */
const СТАРАЯ_МОДЕЛЬ = 'htdemucs.onnx';

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
  return path.join(app.getPath('userData'), 'UVR-MDX-NET-Inst_HQ_3.onnx');
}

function старуюМодельНайти() {
  const p = path.join(app.getPath('userData'), СТАРАЯ_МОДЕЛЬ);
  const size = размерФайла(p);
  return size !== null && size > 1024 * 1024 ? { path: p, bytes: size } : null;
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

/* ---------- Настоящие ошибки страницы ----------
   Самопроверка читала window.__errors, которого в проекте нет вовсе:
   признак «ошибок: 0» ничего не значил. Копим ошибки здесь, в главном
   процессе, — страницу для этого править не надо, всё видно снаружи. */
const ошибкиСтраницы = [];

function запомнитьОшибку(текст) {
  // Больше сотни держать незачем: важно, что они вообще есть
  if (ошибкиСтраницы.length < 100) ошибкиСтраницы.push(String(текст).slice(0, 300));
}

function следитьЗаОшибками(wc) {
  wc.on('console-message', (e, level, message) => {
    // Electron 38 отдаёт объект, прежние версии — отдельные аргументы
    const уровень = e && e.level !== undefined ? e.level : level;
    const текст = e && e.message !== undefined ? e.message : message;
    // Необработанные исключения и отказы обещаний приходят сюда же
    if (уровень === 'error' || уровень === 3) запомнитьОшибку(текст);
  });
  wc.on('preload-error', (_e, файл, err) => {
    запомнитьОшибку('мостик не загрузился (' + файл + '): ' + (err && err.message || err));
  });
  wc.on('render-process-gone', (_e, детали) => {
    запомнитьОшибку('страница упала: ' + (детали && детали.reason));
  });
  wc.on('did-fail-load', (_e, код, описание, адрес) => {
    // -3 — прерванная навигация, это не ошибка
    if (код !== -3) запомнитьОшибку(`не загрузилось (${код} ${описание}): ${адрес}`);
  });
}

/* ---------- Меню приложения ----------

   Стандартное меню Electron на Windows и Linux рисуется полосой прямо
   над интерфейсом — по-английски и с пунктами, которых у нас нет.
   На macOS оно уходит в системную строку, поэтому беда всплыла только
   на Windows. Дело не только в виде:

     • Ctrl+R и Ctrl+Shift+R («Reload») перезагружают страницу —
       рефлекторное нажатие посреди пятнадцатиминутного разделения
       вокала убивает расчёт;
     • одиночный Alt открывает полосу меню, а у нас Alt — модификатор
       крупного шага в редакторе и отключения магнита при перетаскивании;
     • Ctrl+Shift+I открывает инструменты разработчика.

   Поэтому от меню оставлена одна «Правка». Совсем убрать его нельзя:
   копирование и вставка в поля ввода завязаны на ускорители меню, а без
   вставки некуда девать текст песни. «Вид» и «Окно» убраны целиком —
   вместе с ними ушли перезагрузка и инструменты разработчика. Сами
   ускорители «Правки» те же, что были в стандартном меню, так что
   в редакторе ничего не поменялось.

   На Windows и Linux полоса ещё и прячется (setMenuBarVisibility ниже):
   ускорители при этом работают, а Alt полосу не открывает. */
/* Язык интерфейса. Главный процесс сам его не выбирает: выбор живёт
   в хранилище страницы, и она сообщает его через 'set-language'.
   До первого сообщения держим русский — прежнее поведение. */
let языкМеню = 'ru';

function собратьМеню() {
  /* По-английски своих подписей у пунктов не ставим: у ролей Electron
     уже есть родные — Undo, Cut, Select All, — и они точнее любых
     наших. Набор пунктов при этом остаётся тем же самым: роль
     editMenu целиком мы не берём, она тащит лишнее. */
  const рус = языкМеню === 'ru';
  const подпись = (текст) => (рус ? { label: текст } : {});
  const правка = {
    label: рус ? 'Правка' : 'Edit',
    submenu: [
      { role: 'undo', ...подпись('Отменить') },
      { role: 'redo', ...подпись('Повторить') },
      { type: 'separator' },
      { role: 'cut', ...подпись('Вырезать') },
      { role: 'copy', ...подпись('Копировать') },
      { role: 'paste', ...подпись('Вставить') },
      { role: 'selectAll', ...подпись('Выделить всё') },
    ],
  };
  // На macOS первым пунктом обязана быть строка приложения: в ней живут
  // «Скрыть» и «Выйти» (Cmd+Q), без неё их нечем вызвать.
  const пункты = process.platform === 'darwin'
    ? [{ role: 'appMenu' }, правка]
    : [правка];
  return Menu.buildFromTemplate(пункты);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0a0a0f',
    title: 'Karaoke Punch',
    /* Полосы меню над интерфейсом быть не должно. autoHideMenuBar здесь
       не годится: с ним полосу открывает одиночный Alt, а Alt у нас —
       рабочая клавиша редактора. */
    autoHideMenuBar: false,
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
  /* На Windows и Linux меню живёт полосой в самом окне — прячем её.
     Ускорители «Правки» (копировать, вставить) при этом остаются
     рабочими, а показать полосу нечем: одиночный Alt её не открывает.
     На macOS меню в системной строке, прятать нечего. */
  if (process.platform !== 'darwin') win.setMenuBarVisibility(false);
  следитьЗаОшибками(win.webContents);
  win.loadURL('app://bundle/index.html');

  // Внешние ссылки открываем в обычном браузере, а не внутри приложения
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Самопроверка интерфейса: KARAOKE_SELFTEST=1 npm start
  if (process.env.KARAOKE_SELFTEST === '1') {
    win.webContents.on('console-message', (e, _lvl, message) => {
      // В Electron 38 всё лежит в объекте события, старые аргументы устарели
      console.log('[renderer]', e && e.message !== undefined ? e.message : message);
    });
    /* Самопроверка обязана ЗАВЕРШИТЬСЯ в любом случае. Если проверочный
       код падает — скажем, после перекладки интерфейса пропал узел,
       который он читает, — обещание не разрешается, до app.quit() дело
       не доходит, и проверка висит вечно вместо честного провала.
       Такое зависание хуже провала: его легко принять за долгий расчёт. */
    win.webContents.once('did-finish-load', async () => {
      try {
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
        /* Умолчания качества. Разделение — один проход: лишние проходы
           на качество не влияют, это замерено, и три прохода означали
           лишь тройное ожидание. Распознавание — крупная модель, она
           и правда слышит лучше. Оба редких варианта обязаны остаться
           в списках (их не удаляли, только спрятали), а сами блоки
           «Ещё варианты» — быть свёрнутыми. */
        качество: (() => {
          const проходы = document.getElementById('ai-quality');
          const модель = document.getElementById('asr-model');
          const свёртки = [...document.querySelectorAll('.ai-more, .asr-more')];
          const многопроходный = [...проходы.options].some((o) => o.value === '3');
          const обычнаяМодель = [...модель.options].some((o) => o.value === 'base');
          const свёрнуто = свёртки.length === 2 && свёртки.every((d) => !d.open);
          return {
            проходов: проходы.value,
            модель: модель.value,
            многопроходный,
            обычнаяМодель,
            свёрнуто,
            // Редкие варианты спрятаны и не видны на экране без раскрытия
            быстрыеСкрыты: свёртки.every((d) => d.offsetHeight < 40),
            вНорме: проходы.value === '1' && модель.value === 'small'
              && многопроходный && обычнаяМодель && свёрнуто,
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
              && /(минут|minute)/.test(o.словами)
              && o.короткое === t('время.меньшеМинуты')
              && o.пустое === t('время.несколькоМинут')
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
            /* Кегль теперь готовым числом лежит в --st-fs. Раньше читали
               --st-size (доля от rem), и с переходом на единый кегль
               признак замолчал: базовый всегда выходил null, «совпадает»
               всегда false — при любом состоянии программы. */
            const базовый = parseFloat(cs.getPropertyValue('--st-fs'));
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
              /* Полос стало на одну больше: под линейкой появилась полоса
                 отрезков, где играет оригинал. Без голоса — линейка,
                 отрезки, волна, строки, слова; с голосом добавляется его
                 огибающая. */
              вНорме: полосБезГолоса === 5 && полосСГолосом === 6
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
        /* Правка слов — зеркало панели строки: выбор слова щелчком,
           снятие выбора при смене строки, числовые поля (верное/неверное
           значение), клавиши той же грамматики (стрелки/скобки, Shift
           мельче, Alt крупнее — но у слова, не у строки), магнит на
           границе слова (без него/с ним — числа должны разойтись),
           кольцо слова и «распределить» по слогам (Align.spread).
           Своя короткая «песня» с голосом, кончающимся ровно на 5.01 с —
           туда и должен притянуть магнит. */
        правкаСлов: (() => {
          const былиСтроки = state.lines;
          const былБуфер = state.originalBuffer;
          const былаДлина = audio.duration;
          const былГолос = { level: voice.level, runs: voice.runs };
          const панель = document.getElementById('step-3');
          const былаАктивна = панель.classList.contains('active');
          const былSnap = editor.snap;
          try {
            const SR = 8000, dur = 20;
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const buf = ctx.createBuffer(1, SR * dur, SR);
            const d = buf.getChannelData(0);
            for (let i = 0; i < d.length; i++) d[i] = 0.2 * Math.sin(i / 20);
            state.originalBuffer = buf;
            audio.duration = dur;
            state.lines = [
              { text: 'Раз два три четыре', time: 2, end: null, ручнойКонец: false, сомнительная: false },
              { text: 'Пять шесть семь', time: 10, end: null, ручнойКонец: false, сомнительная: false },
            ];
            clearVoiceTrack();
            панель.classList.add('active');
            editor.peaks = null;
            clearHistory();
            openEditor();

            // Голос: звучит 2–5.01 и 10–13 — конец первого отрезка это
            // и есть точка, к которой должен притянуть магнит
            const n = Math.floor(dur * VOICE_RATE);
            const level = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
              const t = i / VOICE_RATE;
              const поют = (t >= 2 && t <= 5.01) || (t >= 10 && t <= 13);
              level[i] = voiceDbCode(поют ? -5 : -50);
            }
            voice.level = level;
            voice.runs = buildVoiceRuns(level);
            editor.peaks = null;
            openEditor();

            const sp0 = () => spanOfRow(0);
            const слова0 = () => lineWords(sp0().line, sp0());

            // Выбор слова и снятие выбора при смене строки
            selectLine(0, {});
            editor.wordSel = 1;   // «два»
            updateWordInfo();
            const выборЕсть = editor.wordSel === 1 && !!selectedWord();
            selectLine(1, {});
            const снялсяПриСмене = editor.wordSel === -1;
            selectLine(0, {});
            editor.wordSel = 1;
            updateWordInfo();

            // Поле «начало»: отрицательное отклоняется и красит поле,
            // число не трогается; верное — применяется, сосед подтягивается
            const было1 = слова0()[1].start;
            const fStart = document.getElementById('sel-word-start');
            fStart.value = '-3';
            fStart.dispatchEvent(new Event('change', { bubbles: true }));
            const плохоеОтклонено = fStart.classList.contains('bad') && слова0()[1].start === было1;
            fStart.value = '3.5';
            fStart.dispatchEvent(new Event('change', { bubbles: true }));
            const w1 = слова0();
            const полеПрименилось = !fStart.classList.contains('bad')
              && Math.abs(w1[1].start - 3.5) < 1e-6 && w1[0].end === w1[1].start;
            fStart.blur();

            // Клавиши: у выбранного слова, не у строки; Shift мельче, Alt крупнее
            const строкаДо = state.lines[0].time;
            const нажать = (code, opts) => document.dispatchEvent(
              new KeyboardEvent('keydown', Object.assign({ code, bubbles: true }, opts)));
            нажать('ArrowRight');
            const послеШага = слова0()[1].start;
            нажать('ArrowRight', { shiftKey: true });
            const послеМельче = слова0()[1].start;
            нажать('ArrowLeft', { altKey: true });
            const послеКрупнее = слова0()[1].start;
            const клавишиРаботают = Math.abs(послеШага - (3.5 + NUDGE_STEP)) < 1e-6
              && Math.abs(послеМельче - (послеШага + NUDGE_FINE)) < 1e-6
              && Math.abs(послеКрупнее - (послеМельче - NUDGE_COARSE)) < 1e-6
              && state.lines[0].time === строкаДо;

            // Магнит на границе слова «три»/«четыре»: конец голоса читаем
            // настоящий (buildVoiceRuns округляет его до своего шага, поэтому
            // не 5.01 ровно), а все четыре слова перед проверкой расставляем
            // в заведомо известные, широкие границы — иначе они унаследовали
            // бы место от правки полем и клавишами чуть выше, и цель могла
            // оказаться за пределами допустимого диапазона
            const голосКонец = voice.runs[0].end;
            const словаДоМагнита = ensureWords(state.lines[0], sp0());
            словаДоМагнита[0].time = 2; словаДоМагнита[0].end = 3;
            словаДоМагнита[1].time = 3; словаДоМагнита[1].end = 4;
            словаДоМагнита[2].time = 4; словаДоМагнита[2].end = 8;
            словаДоМагнита[3].time = 8; словаДоМагнита[3].end = 9;
            clearHistory();
            const цельМагнита = голосКонец - 0.15;   // рядом, но не вплотную

            editor.snap = false;
            beginDrag({ kind: 'word-edge', row: 0, k: 3 }, 8);
            applyDrag(цельМагнита);
            endDrag();
            const безМагнита = +слова0()[3].start.toFixed(3);
            undoEdit();
            editor.snap = true;
            beginDrag({ kind: 'word-edge', row: 0, k: 3 }, 8);
            applyDrag(цельМагнита);
            endDrag();
            const сМагнитом = слова0()[3].start;
            const магнитРаботает = Math.abs(безМагнита - цельМагнита) <= 0.02
              && Math.abs(сМагнитом - голосКонец) < 1e-6;

            // Кольцо слова: границы считаются от самого слова, с разгоном
            // и хвостом короче, чем у строки
            editor.wordSel = 2;
            updateWordInfo();
            const словоДляКольца = selectedWord();
            editor.loopScope = 'word';
            const кольцоB = loopBounds();
            const кольцоСлова = !!(словоДляКольца && кольцоB
              && Math.abs(кольцоB.from - Math.max(0, словоДляКольца.words[2].start - 0.4)) < 1e-6
              && Math.abs(кольцоB.to - Math.min(dur, словоДляКольца.words[2].end + 0.3)) < 1e-6);

            // «Распределить»: то же самое Align.spread, что и в подгонке
            // текста — доступно только там, где Align загружен
            const alignДоступен = typeof Align !== 'undefined' && typeof Align.spread === 'function';
            let распределилось = false;
            let кнопкаРаспределитьВидна = false;
            if (alignДоступен) {
              editor.wordSel = -1;
              распределитьСлова(0);
              const sp = sp0();
              const w = lineWords(sp.line, sp);
              распределилось = hasWords(state.lines[0]) && w.length === 4
                && Math.abs(w[0].start - sp.start) < 1e-6
                && w.every((x, i) => i === 0 || Math.abs(x.start - w[i - 1].end) < 1e-6);
              updateSelInfo();
              кнопкаРаспределитьВидна = !document.getElementById('btn-sel-words-spread').classList.contains('hidden');
            }

            return {
              выборЕсть,
              снялсяПриСмене,
              плохоеОтклонено,
              полеПрименилось,
              клавишиРаботают,
              безМагнита,
              сМагнитом,
              магнитРаботает,
              кольцоСлова,
              alignДоступен,
              распределилось,
              кнопкаРаспределитьВидна,
              вНорме: выборЕсть && снялсяПриСмене && плохоеОтклонено && полеПрименилось
                && клавишиРаботают && магнитРаботает && кольцоСлова
                && (!alignДоступен || (распределилось && кнопкаРаспределитьВидна)),
            };
          } finally {
            state.lines = былиСтроки;
            state.originalBuffer = былБуфер;
            audio.duration = былаДлина;
            voice.level = былГолос.level;
            voice.runs = былГолос.runs;
            editor.peaks = null;
            editor.sel = -1;
            editor.wordSel = -1;
            editor.spansKey = '';
            editor.snap = былSnap;
            editor.loop = false;
            clearHistory();
            if (!былаАктивна) панель.classList.remove('active');
          }
        })(),
        /* Время в полях инспектора. Раньше поля показывали голые секунды,
           и одно и то же место песни читалось на дорожке как «3:10»,
           а в поле как «190». Проверяем ровно эту беду: что показано
           минутами и что набранное понимается в обоих видах —
           и «1:27,44», и просто «87.44». Плохое (буквы, минус) обязано
           отклоняться, не трогая разметку. */
        времяВПолях: (() => {
          const былиСтроки = state.lines;
          const былБуфер = state.originalBuffer;
          const былаДлина = audio.duration;
          const панель = document.getElementById('step-3');
          const былаАктивна = панель.classList.contains('active');
          try {
            const SR = 8000, dur = 240;
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            state.originalBuffer = ctx.createBuffer(1, SR * dur, SR);
            audio.duration = dur;
            state.lines = [
              { text: 'Первая строка', time: 100, end: null, ручнойКонец: false, сомнительная: false },
              { text: 'Вторая строка', time: 190, end: null, ручнойКонец: false, сомнительная: false },
            ];
            панель.classList.add('active');
            editor.peaks = null;
            clearVoiceTrack();
            clearHistory();
            openEditor();
            selectLine(1, {});

            const поле = document.getElementById('sel-start');
            const показано = поле.value;
            const набрать = (v) => {
              поле.value = v;
              поле.dispatchEvent(new Event('change', { bubbles: true }));
              return { поле: поле.value, время: +state.lines[1].time.toFixed(3),
                плохо: поле.classList.contains('bad') };
            };
            const минутами = набрать('3:05,500');
            const секундами = набрать('150.25');
            const буквы = набрать('нет');
            const минус = набрать('-1');
            // В сетке строк и в часах — тот же вид, только сотые
            const вСетке = document.querySelector('#edit-list .ts').textContent;
            const часы = document.getElementById('edit-total').textContent;
            return {
              показано, минутами, секундами, буквы, минус, вСетке, часы,
              вНорме: /^\\d+:\\d\\d[.,]\\d\\d\\d$/.test(показано)
                && Math.abs(минутами.время - 185.5) < 1e-6 && !минутами.плохо
                && Math.abs(секундами.время - 150.25) < 1e-6 && !секундами.плохо
                // Плохое не применилось: время осталось от прошлой удачной правки
                && буквы.плохо && Math.abs(буквы.время - 150.25) < 1e-6
                && минус.плохо && Math.abs(минус.время - 150.25) < 1e-6
                && /^\\d+:\\d\\d[.,]\\d\\d$/.test(вСетке)
                && /^\\d+:\\d\\d[.,]\\d\\d$/.test(часы),
            };
          } finally {
            state.lines = былиСтроки;
            state.originalBuffer = былБуфер;
            audio.duration = былаДлина;
            editor.peaks = null;
            editor.sel = -1;
            editor.wordSel = -1;
            editor.spansKey = '';
            clearHistory();
            if (!былаАктивна) панель.classList.remove('active');
          }
        })(),
        /* Дописанные строки. Беда: человек вспоминает про забытый куплет,
           дописывает его в текст — и на дорожке этих строк нет вовсе,
           потому что времени у них нет. Проверяем, что место им находится
           между размеченными соседями, что они помечены «на глазок»
           и что строку, которую просто ещё не простучали, никто не трогает. */
        новыеСтроки: (() => {
          const былаДлина = audio.duration;
          try {
            audio.duration = 60;
            const строки = [
              { text: 'раз', time: 10, end: null },
              { text: 'вставка А', time: null, end: null },
              { text: 'вставка Б', time: null, end: null },
              { text: 'два', time: 16, end: null },
              { text: 'не простукана', time: null, end: null },
              { text: 'три', time: 20, end: null },
              { text: 'хвост', time: null, end: null },
            ];
            // Дописаны только вставки и хвост; «не простукана» — старая строка
            расставитьНовыеСтроки(строки, new Set([1, 2, 6]));
            const времена = строки.map((l) => (l.time == null ? null : +l.time.toFixed(2)));
            return {
              времена,
              глазок: строки.map((l) => !!l.сомнительная),
              вНорме: времена[1] === 12 && времена[2] === 14
                // Промежуток 10…16 поделён на три равные части
                && времена[4] === null   // не простуканную не выдумываем
                && времена[6] > 20 && времена[6] <= 60
                && строки[1].сомнительная && строки[2].сомнительная && строки[6].сомнительная
                && !строки[0].сомнительная,
            };
          } finally {
            audio.duration = былаДлина;
          }
        })(),
        /* Черновик файлом и строка «что в памяти». Проверяем круг целиком:
           собрали проект → потеряли работу → открыли черновик → всё на
           месте. Файл берём не с диска — тем же JSON, каким он уходит
           в download. */
        черновик: (() => {
          const былиСтроки = state.lines;
          const былаДлина = audio.duration;
          const былоИмя = state.fileName;
          const былТекст = document.getElementById('lyrics-input').value;
          const былПроект = localStorage.getItem('karaoke-project');
          try {
            audio.duration = 60;
            state.fileName = 'проба.mp3';
            state.lines = [
              { text: 'раз', time: 5, end: null, ручнойКонец: false, сомнительная: false },
              { text: 'два', time: 9, end: null, ручнойКонец: false, сомнительная: false },
            ];
            document.getElementById('lyrics-input').value = 'раз\\nдва';
            state.origSpans = [{ start: 1, end: 2 }];
            const проект = собратьПроект();

            // Работа потеряна: текст другой, времён нет
            state.lines = [{ text: 'чужое', time: null, end: null }];
            document.getElementById('lyrics-input').value = 'чужое';
            применитьЧерновик(проект);

            const времена = state.lines.map((l) => l.time);
            const п = сведенияОПамяти();
            обновитьПамять();
            const чип = document.getElementById('proj-chip');
            return {
              времена,
              текст: document.getElementById('lyrics-input').value,
              отрезков: отрезкиОригинала().length,
              память: п,
              чипВиден: !чип.classList.contains('hidden'),
              чипИмя: document.getElementById('proj-name').textContent,
              вНорме: времена.length === 2 && времена[0] === 5 && времена[1] === 9
                && document.getElementById('lyrics-input').value === 'раз\\nдва'
                && отрезкиОригинала().length === 1
                && п.имя === 'проба.mp3' && п.всего === 2 && п.размечено === 2
                && !чип.classList.contains('hidden'),
            };
          } finally {
            state.lines = былиСтроки;
            state.fileName = былоИмя;
            audio.duration = былаДлина;
            state.origSpans = [];
            document.getElementById('lyrics-input').value = былТекст;
            if (былПроект != null) localStorage.setItem('karaoke-project', былПроект);
            else localStorage.removeItem('karaoke-project');
            обновитьПамять();
          }
        })(),
        /* «Слушать только это». Отдельной дорожки голоса у студии нет:
           голос — это разница песни и минусовки, поэтому в режиме
           «только голос» минусовка идёт в противофазе. Проверяем сами
           усиления и то, что соло не переживает уход из редактора. */
        соло: (() => {
          const былоСоло = editor.solo;
          /* Какие панели были открыты: goToStep ниже переключит шаг,
             а следующие признаки меряют, что видно на экране, — оставить
             открытым чужой шаг значит соврать им */
          const былиАктивны = [...document.querySelectorAll('.step-panel.active')];
          try {
            const есть = (код) => усиленияСоло(код, true);
            const моно = усиленияСоло('voice', false);
            editor.solo = 'orig';
            goToStep(4);
            const послеУхода = editor.solo;
            return {
              оригинал: есть('orig'), минус: есть('inst'), голос: есть('voice'),
              безМинусовки: моно, послеУхода,
              вНорме: есть('orig').вокал === 1 && есть('orig').минусовка === 0
                && есть('inst').вокал === 0 && есть('inst').минусовка === 1
                && есть('voice').вокал === 1 && есть('voice').минусовка === -1
                && моно === null && послеУхода === null,
            };
          } finally {
            editor.solo = былоСоло;
            document.querySelectorAll('.step-panel').forEach((p) => p.classList.remove('active'));
            былиАктивны.forEach((p) => p.classList.add('active'));
          }
        })(),
        /* Пауза между словами. Раньше конец слова был обязан равняться
           началу следующего: перетаскивание сваривало соседей, и паузу
           выразить было нечем. Проверяем оба поведения сразу — обычное
           перетаскивание стыка по-прежнему сваривает, с Cmd/Ctrl края
           расходятся, — а заодно то, ради чего это делалось: заливка
           караоке в паузе стоит, и расширенный LRC несёт лишнюю метку
           на конце слова. */
        паузаМеждуСловами: (() => {
          const былиСтроки = state.lines;
          const былБуфер = state.originalBuffer;
          const былаДлина = audio.duration;
          const былSnap = editor.snap;
          const былКрай = editor.одинКрай;
          const панель = document.getElementById('step-3');
          const былаАктивна = панель.classList.contains('active');
          try {
            const SR = 8000, dur = 20;
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            state.originalBuffer = ctx.createBuffer(1, SR * dur, SR);
            audio.duration = dur;
            state.lines = [
              { text: 'Раз два три четыре', time: 2, end: null, ручнойКонец: false, сомнительная: false },
              { text: 'Пять шесть семь', time: 12, end: null, ручнойКонец: false, сомнительная: false },
            ];
            панель.classList.add('active');
            clearVoiceTrack();
            editor.peaks = null;
            editor.snap = false;   // здесь мерим руками, магнит только помешает
            clearHistory();
            openEditor();
            selectLine(0, {});

            const слова = () => {
              const sp = spanOfRow(0);
              return lineWords(sp.line, sp).map((w) => ({
                t: w.text.trim(), s: +w.start.toFixed(3), e: +w.end.toFixed(3),
              }));
            };
            const было = слова();
            const стыкБыл = Math.abs(было[1].e - было[2].s) < 1e-9;

            // Обычное перетаскивание стыка: как и раньше, сваривает соседей
            editor.одинКрай = false;
            beginDrag({ kind: 'word-edge', row: 0, k: 2 }, было[2].s);
            applyDrag(было[2].s + 0.4);
            endDrag();
            const послеСтыка = слова();
            const сваркаЖива = Math.abs(послеСтыка[1].e - послеСтыка[2].s) < 1e-9
              && Math.abs(послеСтыка[2].s - (было[2].s + 0.4)) < 1e-6;

            // С модификатором: влево уезжает конец левого слова, правое стоит
            editor.одинКрай = true;
            const доРазвода = слова();
            beginDrag({ kind: 'word-edge', row: 0, k: 2 }, доРазвода[2].s);
            applyDrag(доРазвода[2].s - 0.6);
            endDrag();
            editor.одинКрай = false;
            const сПаузой = слова();
            const пауза = +(сПаузой[2].s - сПаузой[1].e).toFixed(3);
            const правоеНеТронули = Math.abs(сПаузой[2].s - доРазвода[2].s) < 1e-9;

            // Разведённые края ловятся по отдельности — иначе паузу не поправить
            const L = timelineLanes();
            const y = L.words.y + Math.round(L.words.h / 2);
            const хит = (t) => {
              const h = timelineHit(tToX(t), y);
              return h ? h.kind + ':' + h.k : null;
            };
            const ручки = { конец: хит(сПаузой[1].e), начало: хит(сПаузой[2].s) };

            // Заливка караоке: в паузе прежнее слово уже спето, следующее ещё нет
            const sp = spanOfRow(0);
            const ws = lineWords(sp.line, sp);
            const вПаузе = wordProgress(ws, (ws[1].end + ws[2].start) / 2);
            const заливкаСтоит = вПаузе[1] === 1 && вПаузе[2] === 0;

            // Расширенный LRC: лишняя метка на конце слова — это и есть пауза
            const метки = ws.map((w, k) => {
              const след = ws[k + 1];
              return след && след.start - w.end > СТЫК ? 1 : 0;
            }).reduce((a, b) => a + b, 0);

            // Отмена возвращает сваренный стык
            undoEdit();
            const послеОтмены = слова();
            const отменаВернула = Math.abs(послеОтмены[1].e - послеОтмены[2].s) < 1e-9;

            return {
              стыкБыл, сваркаЖива, пауза, правоеНеТронули, ручки,
              заливкаСтоит, метокПаузы: метки, отменаВернула,
              вНорме: стыкБыл && сваркаЖива
                && Math.abs(пауза - 0.6) < 1e-6 && правоеНеТронули
                && ручки.конец === 'word-end:1' && ручки.начало === 'word-start:2'
                && заливкаСтоит && метки === 1 && отменаВернула,
            };
          } finally {
            state.lines = былиСтроки;
            state.originalBuffer = былБуфер;
            audio.duration = былаДлина;
            editor.snap = былSnap;
            editor.одинКрай = былКрай;
            editor.peaks = null;
            editor.sel = -1;
            editor.wordSel = -1;
            editor.spansKey = '';
            clearHistory();
            if (!былаАктивна) панель.classList.remove('active');
          }
        })(),
        /* Уровни дорожек в наушниках: ползунок у оригинала и у минусовки.
           Своей дорожки у голоса нет, он берётся вычитанием, поэтому
           «оригинал O, минусовка M» — это песня с усилением O и минусовка
           с усилением M−O. Проверяем сами числа, связку с галкой «слышу
           оригинал» (два органа управления об одном и том же обязаны
           ходить вместе) и то, что принудительный оригинал (кольцо,
           простукивание, прослушивание строки) не даёт увести голос
           ниже записи. */
        уровниДорожек: (() => {
          const былиУровни = { ...editor.mix };
          const былаГалка = editor.hearVocal;
          const панель = document.getElementById('step-3');
          const былаАктивна = панель.classList.contains('active');
          try {
            панель.classList.add('active');
            const у = (o, i, форс) => усиленияНаушников({ orig: o, inst: i }, true, !!форс);
            const моно = усиленияНаушников({ orig: 0, inst: 1 }, false, false);

            // Галка и ползунок ходят вместе
            editor.mix = { orig: 1, inst: 1 };
            editor.hearVocal = true;
            поставитьУровень('orig', 0.5);
            const галкаСнялась = editor.hearVocal === false;
            const переключательСнялся = document.getElementById('sel-vocal').checked === false;
            const пер = document.getElementById('sel-vocal');
            пер.checked = true;
            пер.dispatchEvent(new Event('change', { bubbles: true }));
            const галкаВернулаПолзунок = editor.mix.orig === 1 && editor.hearVocal === true;

            return {
              какЗаписано: у(1, 1), чистыйМинус: у(0, 1), музыкаТише: у(1, 0.4),
              подФорсом: у(0.3, 1, true), моно,
              галкаСнялась, переключательСнялся, галкаВернулаПолзунок,
              вНорме: у(1, 1).вокал === 1 && у(1, 1).минусовка === 0
                && у(0, 1).вокал === 0 && у(0, 1).минусовка === 1
                && у(1, 0.4).вокал === 1 && Math.abs(у(1, 0.4).минусовка + 0.6) < 1e-9
                // Принудительный оригинал: голос не тише записи
                && у(0.3, 1, true).вокал === 1 && у(0.3, 1, true).минусовка === 0
                // Моно: делить нечего, звучит песня как есть
                && моно.вокал === 1 && моно.минусовка === 0
                && галкаСнялась && переключательСнялся && галкаВернулаПолзунок,
            };
          } finally {
            editor.mix = былиУровни;
            editor.hearVocal = былаГалка;
            const пер = document.getElementById('sel-vocal');
            if (пер) пер.checked = былаГалка;
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
              /* Панель управления редактора: после перекладки под
                 монтажную она называется .transport. Узел ищем мягко —
                 признак не должен ронять всю самопроверку из-за того,
                 что разметку переименовали. */
              инструменты: (() => {
                const el = document.querySelector('.transport');
                return el ? el.offsetParent === null : null;
              })(),
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

        /* Переключение языка. Проверяем не наличие кнопок, а итог:
           при английском в ключевых местах стоят английские надписи,
           при русском — русские, и в видимой части студии не остаётся
           букв чужого алфавита. Текст песни и содержимое поля сюда
           не входят — это данные человека, их не переводят.
           Язык в конце возвращаем каким был. */
        язык: (() => {
          const былЯзык = I18N.язык();
          const КИР = /[А-Яа-яЁё]/;
          const ключевые = () => ({
            шаг3: document.querySelector('.step-tab[data-step="3"]').textContent.trim(),
            вокал: document.getElementById('btn-ai-run').textContent,
            разметка: document.getElementById('btn-asr-run').textContent,
            оценкаРазделения: document.getElementById('ai-eta').textContent,
            оценкаРазметки: document.getElementById('asr-eta').textContent,
            /* Подпись, собранная кодом: заголовки полос дорожки строит
               renderTimelineHeads. Раньше здесь стояла подпись выбранной
               строки, но она стала номером («№2» против «#2») — по ней
               уже не видно, залип перевод или нет. */
            дорожка: document.querySelector('#tl-heads .tl-head-row span').textContent,
            минусовка: document.getElementById('btn-inst-add').textContent,
            подсказкаОтмены: document.getElementById('tl-undo').title,
            поле: document.getElementById('lyrics-input').placeholder,
          });
          /* Сколько надписей набора не того алфавита, какого ждём:
             при английском кириллицы быть не должно вовсе, при русском
             она обязана быть в каждой — иначе перевод где-то залип. */
          const чужих = (о, ждёмКириллицу) => Object.values(о)
            .filter((v) => КИР.test(String(v)) !== ждёмКириллицу).length;
          const следы = [];
          const чужаяАзбукаВСтудии = (ждёмКириллицу) => {
            const w = document.createTreeWalker(
              document.getElementById('studio'), NodeFilter.SHOW_TEXT);
            let n, счёт = 0;
            while ((n = w.nextNode())) {
              const t = n.nodeValue.trim();
              if (!t) continue;
              const p = n.parentElement;
              if (p.closest('script,style')) continue;
              // Текст песни и всё, что набрал человек, не переводится
              // Имя песни в чипе памяти и в заметке над зоной загрузки —
              // тоже данные человека: это имя его файла
              if (p.closest('#edit-list, #lyrics-stage, #edit-stage, #tap-mode, #word-tap, #proj-chip, #mem-note')) continue;
              if (КИР.test(t) && !ждёмКириллицу) {
                счёт++;
                следы.push((p.id || p.className || p.tagName) + ': ' + t.slice(0, 60));
              }
            }
            return счёт;
          };
          I18N.установить('en');
          const en = ключевые();
          const langEn = document.documentElement.lang;
          const кириллицыПриАнглийском = чужаяАзбукаВСтудии(false);
          I18N.установить('ru');
          const ru = ключевые();
          const langRu = document.documentElement.lang;
          I18N.установить(былЯзык);
          return {
            en, ru, langEn, langRu, кириллицыПриАнглийском, следы,
            вернулиЯзык: I18N.язык() === былЯзык,
            /* Переключатель ровно один и живёт в шапке. Раньше их было
               два — второй стоял в ряду шагов студии, и на экране они
               попадались на глаза оба сразу. */
            переключателей: document.querySelectorAll('.lang-switch').length,
            вШапке: !!document.querySelector('.site-header .lang-switch'),
            вНорме: langEn === 'en' && langRu === 'ru'
              && I18N.язык() === былЯзык
              && document.querySelectorAll('.lang-switch').length === 1
              && !!document.querySelector('.site-header .lang-switch')
              && кириллицыПриАнглийском === 0
              // При английском ни в одном ключевом месте нет кириллицы…
              && чужих(en, false) === 0
              // …а при русском она есть везде, то есть перевод не залип
              && чужих(ru, true) === 0
              && en.шаг3.includes('Editor') && ru.шаг3.includes('Редактор')
              && en.вокал === 'Remove vocals' && ru.вокал === 'Убрать вокал'
              && en.разметка === 'Transcribe the lyrics'
              && ru.разметка === 'Распознать текст'
              && en.минусовка === 'Choose' && ru.минусовка === 'Выбрать'
              /* Ни одна ключевая надпись не осталась той же самой:
                 так ловится ключ, который есть в разметке, но которому
                 забыли положить перевод, — он молча отдавал бы русский. */
              && Object.keys(en).every((k) => en[k] !== ru[k]),
          };
        })(),
        /* Номер версии в окне «Что нового» и на кнопке в подвале.
           Он живёт в разметке (data-news-version у <html>), а не
           в словаре: раньше номер был вшит в перевод и отстал —
           по-английски окно объявляло 1.8.4, когда в разметке стояла
           уже 1.9.0. Проверяем, что оба языка называют одно число
           и что подстановка раскрылась. */
        номерВерсии: (() => {
          const версия = document.documentElement.dataset.newsVersion;
          const снять = () => ({
            заголовок: document.getElementById('whatsnew-title').textContent,
            подвал: document.getElementById('btn-whatsnew').textContent,
          });
          const былЯзык = I18N.язык();
          I18N.установить('ru');
          const ru = снять();
          I18N.установить('en');
          const en = снять();
          I18N.установить(былЯзык);
          const везде = [ru.заголовок, ru.подвал, en.заголовок, en.подвал];
          return {
            версия, ru, en,
            вНорме: !!версия && везде.every((s) => s.includes(версия) && !/[{}]/.test(s)),
          };
        })(),
        /* Логотип в шапке и в подвале. Приложению нужна своя копия
           картинки: папка icons/ в сборку не едет, и без копии рядом
           с интерфейсом вместо логотипа оставался запасной значок. */
        логотип: (() => {
          const шапка = document.getElementById('logo-img');
          const подвал = document.getElementById('logo-img-footer');
          const запасной = document.getElementById('logo-fallback');
          const виден = (img) => !!img && img.complete && img.naturalWidth > 0
            && !img.classList.contains('hidden');
          return {
            путь: шапка ? шапка.getAttribute('src') : null,
            размер: шапка ? шапка.naturalWidth : 0,
            запаснойСкрыт: !!запасной && запасной.classList.contains('hidden'),
            вНорме: виден(шапка) && виден(подвал)
              && !!запасной && запасной.classList.contains('hidden'),
          };
        })(),
        /* Раздел «Для компьютера» в приложении удалён — приложение уже
           стоит. Проверяем после переключения языка: перевод абзацев
           кладётся через innerHTML и приносит ссылки на раздел обратно,
           поэтому разворачивать их приходится каждый раз заново.
           В меню шапки пункта не должно быть совсем: ключ перевода
           висел на самой ссылке и вместе с ней пропадал. */
        разделДляКомпьютера: (() => {
          const ссылок = document.querySelectorAll('a[href="#desktop"]').length;
          const вМеню = !!document.querySelector('.site-nav a[href="#desktop"]');
          return { ссылок, вМеню, разделЕсть: !!document.getElementById('desktop'),
            вНорме: ссылок === 0 && !вМеню && !document.getElementById('desktop') };
        })(),
        /* Модификатор в подписях: на Маке Cmd, на Windows и Linux Ctrl.
           Проверяем и текст под дорожкой, и подсказку кнопки отмены —
           они наполняются разными путями (span и data-mod-title). */
        модификатор: (() => {
          const ждём = ${JSON.stringify(process.platform === 'darwin' ? 'Cmd' : 'Ctrl')};
          const подпись = document.querySelector('.timeline-keys .mod-key');
          const кнопка = document.getElementById('tl-undo');
          const пустых = [...document.querySelectorAll('.mod-key')]
            .filter((el) => el.textContent !== ждём).length;
          return {
            ждём,
            вЛегенде: подпись ? подпись.textContent : null,
            вПодсказке: кнопка ? кнопка.title : null,
            неЗаполнено: пустых,
            вНорме: пустых === 0 && !!кнопка && кнопка.title.includes(ждём + '+Z'),
          };
        })(),
        /* Тема оформления: переключатель собрался, атрибут на <html>
           меняется по клику, выбор переживает перезагрузку (localStorage),
           и — самое важное — рамка выделения на дорожке (--sel-ring)
           у тем правда разного цвета, а не только имя атрибута другое. */
        тема: (() => {
          const T = window.THEME;
          if (!T) return { естьМодуль: false, вНорме: false };
          const studio = document.querySelector('.studio');
          const кольцо = () => (studio ? getComputedStyle(studio).getPropertyValue('--sel-ring').trim() : null);
          const кнопокВПереключателе = document.querySelectorAll('.theme-switch .theme-btn').length;
          const исходная = T.тема();
          const кольцоФирменная = (исходная === 'signature') ? кольцо() : (() => { T.установить('signature'); return кольцо(); })();
          T.установить('neutral');
          const атрибутНейтральная = document.documentElement.dataset.theme;
          const кольцоНейтральная = кольцо();
          const сохранилась = (() => {
            try { return localStorage.getItem('karaoke-theme') === 'neutral'; } catch (e) { return false; }
          })();
          T.установить('signature');
          const атрибутФирменная = document.documentElement.dataset.theme;
          const кольцоСноваФирменная = кольцо();
          T.установить(исходная);   // вернуть тему как было до самопроверки
          return {
            кнопокВПереключателе,
            атрибутНейтральная,
            атрибутФирменная,
            кольцоФирменная,
            кольцоНейтральная,
            сохранилась,
            вНорме: кнопокВПереключателе === 2
              && атрибутНейтральная === 'neutral' && атрибутФирменная === 'signature'
              && !!кольцоФирменная && !!кольцоНейтральная && кольцоФирменная !== кольцоНейтральная
              && кольцоСноваФирменная === кольцоФирменная && сохранилась,
          };
        })()
      }))()`);
      /* Ошибки считаем снаружи: страница их нигде не копит, а window.__errors,
         который тут читался раньше, в проекте не создаётся вовсе — признак
         всегда показывал ноль, что бы на странице ни падало. */
      report.ошибок = ошибкиСтраницы.length;
      report.ошибки = ошибкиСтраницы.slice(0, 5);

      /* Меню: в нём не должно остаться ни перезагрузки, ни инструментов
         разработчика — Ctrl+R посреди разделения вокала убивает расчёт.
         А копирование и вставка обязаны остаться: без них некуда девать
         текст песни. Проверяем по ролям, а не по подписям. */
      report.меню = (() => {
        const меню = Menu.getApplicationMenu();
        const роли = [];
        const собрать = (m) => (m ? m.items : []).forEach((i) => {
          if (i.role) роли.push(String(i.role).toLowerCase());
          if (i.submenu) собрать(i.submenu);
        });
        собрать(меню);
        const опасные = ['reload', 'forcereload', 'toggledevtools'];
        return {
          разделы: (меню ? меню.items : []).map((i) => i.label),
          вставкаЕсть: роли.includes('paste') && роли.includes('copy'),
          перезагрузкиНет: !роли.some((r) => опасные.includes(r)),
          полосаСпрятана: process.platform === 'darwin' || !win.isMenuBarVisible(),
        };
      })();
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
         режим, выбранный в интерфейсе (по умолчанию один проход),
         KARAOKE_E2E=быстро — тоже один проход, но заданный явно, минуя
         интерфейс: так проверяется сам расчёт, а не выпадающий список. */
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
      } catch (e) {
        console.log('SELFTEST-ОШИБКА', String((e && e.message) || e));
      } finally {
        app.quit();
      }
    });
  }
}

/* ---------- Переезд со старого имени ----------
   Программа называлась «Бэнэнгская Рапсодия», и папка настроек звалась
   по видимому имени. После переименования в Karaoke Punch приложение
   стало бы смотреть в новую, пустую папку — а в старой остаются
   скачанные модели (больше 400 МБ) и всё хранилище с сохранёнными
   проектами. То есть человек после обновления обнаружил бы, что его
   разметка пропала, а нейросети качаются заново.

   Поэтому один раз, до первого обращения к папке, переносим старую
   целиком. Если новая уже есть — не трогаем ничего: значит, переезд
   был или человек начал с нового имени. */
function перенестиСтаруюПапку() {
  try {
    const новая = app.getPath('userData');
    if (fs.existsSync(новая)) return;
    const старая = path.join(app.getPath('appData'), 'Бэнэнгская Рапсодия');
    if (!fs.existsSync(старая)) return;
    fs.renameSync(старая, новая);
    console.log('Папка настроек перенесена со старого имени');
  } catch (e) {
    /* Не вышло — не беда: приложение просто начнёт с чистой папки
       и предложит скачать модели. Ронять запуск из-за этого нельзя. */
  }
}
перенестиСтаруюПапку();

/* Вторая копия на одной папке настроек только вредит: проекты живут
   в localStorage профиля, и копии затирают правки друг друга — у той,
   что запустилась второй, сохранение может тихо не доехать. Поэтому
   вместо новой копии показываем уже открытое окно. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    registerAppProtocol();
    Menu.setApplicationMenu(собратьМеню());
    createWindow();
    setupAutoUpdate();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

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
      req = https.get(url, { headers: { 'User-Agent': 'karaoke-punch' }, timeout: 30000 }, (res) => {
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
    let завершено = false;
    let resp = null;
    let req = null;
    /* Единственный выход из функции. Отмена рвала запрос через
       req.destroy() без аргумента, а такой вызов события 'error'
       не порождает: уборка не случалась никогда — обещание висело
       вечно, а .part оставался на диске (до 90 МБ на файле весов). */
    const finish = (err, res) => {
      if (завершено) return;
      завершено = true;
      if (!err) return resolve(res);
      try { if (resp) resp.destroy(); } catch (e) { /* уже закрыт */ }
      try { if (req) req.destroy(); } catch (e) { /* уже закрыт */ }
      try { file.destroy(); } catch (e) { /* уже закрыт */ }
      fs.unlink(tmp, () => reject(err));
    };
    // Например, кончилось место на диске
    file.on('error', finish);
    const get = (u, redirects = 0) => {
      if (завершено) return;
      if (redirects > 8) return finish(new Error('Слишком много перенаправлений'));
      req = https.get(u, { headers: { 'User-Agent': 'karaoke-punch' }, timeout: 30000 }, (res) => {
        if (завершено) { res.resume(); return; }
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
          return fs.unlink(tmp, () => finish(null, { skipped: true, bytes: 0 }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return finish(new Error('Сервер ответил ' + res.statusCode));
        }
        resp = res;
        // Сколько байт обещал сервер: оборванная раздача тоже доходит
        // до 'finish', и без сверки длины огрызок сходил за целый файл
        const ждём = parseInt(res.headers['content-length'], 10) || 0;
        let получено = 0;
        res.on('data', (chunk) => { получено += chunk.length; onChunk(chunk.length); });
        res.on('error', finish);        // обрыв связи на середине
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          /* Всё, что тут падает, падает в колбэке потока: без перехвата
             это необработанное исключение в главном процессе */
          try {
            if (ждём && получено !== ждём) {
              throw new Error(`файл пришёл не целиком: ${получено} из ${ждём} байт`);
            }
            fs.renameSync(tmp, dest);
            finish(null, { skipped: false, bytes: получено });
          } catch (e) { finish(e); }
        }));
      });
      req.on('error', finish);
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
      if (asrFileOk(dir, m, sizes, rel)) {
        /* Уже скачанное идёт в зачёт полосы: без этого второй заход
           считал от нуля при полном total, и после отмены на середине
           полоса доходила до шестидесяти процентов и там заканчивалась */
        done += размерФайла(dest) || 0;
        send('asr-progress', { done, total: Math.max(total, done) });
        continue;
      }
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
  /* Рвём с ошибкой, а не пустым destroy(): без аргумента событие 'error'
     не приходит, и загрузка «отменялась» только на словах — обещание
     висело вечно, а недокачанное оставалось на диске. */
  asrAbort.reqs.forEach((r) => {
    try { r.destroy(new Error('отменено')); } catch (e) { /* уже закрыт */ }
  });
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
    // Прежняя htdemucs, если она осталась с давних версий
    старая: старуюМодельНайти(),
  };
});

/* Убрать прежнюю модель. Зовётся только после согласия человека:
   решать за него, что удалить с его диска, мы не вправе. */
ipcMain.handle('model-remove-old', () => {
  const ст = старуюМодельНайти();
  if (!ст) return { ok: true, освобождено: 0 };
  try {
    fs.unlinkSync(ст.path);
    return { ok: true, освобождено: ст.bytes };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
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
      headers: { 'User-Agent': 'karaoke-punch', Accept: 'application/vnd.github+json' },
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

/* Страница сообщила язык — пересобираем меню. Иначе на английском
   интерфейсе в системной строке осталась бы русская «Правка». */
ipcMain.handle('set-language', (_evt, lang) => {
  const новый = lang === 'en' ? 'en' : 'ru';
  if (новый === языкМеню) return true;
  языкМеню = новый;
  Menu.setApplicationMenu(собратьМеню());
  return true;
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
