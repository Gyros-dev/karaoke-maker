const { app, BrowserWindow, Menu, ipcMain, dialog, shell, protocol, net, screen } = require('electron');
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
  /* Окно открывается развёрнутым во весь рабочий стол. Студия — рабочее
     место: все четыре шага делят между собой высоту окна, и на окне
     в 1180×900 редактор жил в тесноте, хотя монитор стоял пустой.
     Это ОБЫЧНОЕ развёрнутое окно, а не полноэкранный режим macOS:
     тот прячет системную строку и уводит приложение на свой рабочий
     стол, а выходить из него надо руками.

     Размер всё равно задаём — по рабочей области экрана: maximize()
     на Windows отрабатывает не всегда (например, пока окно скрыто),
     и тогда окно останется этого размера, а не крошечного. */
  const рабочая = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.max(900, рабочая.width),
    height: Math.max(640, рабочая.height),
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
  /* Разворачиваем ПОСЛЕ создания: на Windows maximize() у ещё не
     показанного окна иногда не срабатывает, поэтому зовём его и здесь,
     и один раз при показе — повторный вызов у уже развёрнутого окна
     ничего не делает. На macOS maximize() растягивает окно по рабочей
     области, не уводя его в полноэкранный режим. */
  win.maximize();
  win.once('ready-to-show', () => { if (!win.isMaximized()) win.maximize(); });
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
      /* ---------- Изоляция разделов ----------

         Беда, которую это лечит. Все полсотни разделов идут подряд
         по одному окну, над одним состоянием студии, и уборку за
         собой каждый делал сам: у одних был finally, у других нет,
         и ничто не мешало следующему автору забыть. Забыл — и
         следующий раздел мерил чужой мусор: студию «с песней»,
         открытый чужой шаг, чужой язык.

         Хуже того, мусор переживал ЗАПУСК. Правка разметки сама
         сохраняет черновик в localStorage, а возврат поля текста
         черновик НЕ убирает: собратьПроект нарочно бережёт прежний
         текст, когда поле пустое (иначе первая же правка стирала бы
         работу). Раздел «разметкаТекста» вписывал туда свои две
         строки, «простукивание» — свои пять времён, и второй прогон
         на той же папке профиля поднимался «с песней»: кнопка
         читалась как «Подогнать мой текст» вместо «Распознать текст»,
         и раздел «язык» краснел на ровном месте. Признак, который
         врёт через раз, приучает не верить красному, — а это самая
         дорогая беда, какая тут бывает.

         Теперь изоляция не зависит от дисциплины автора: __раздел
         снимает общее состояние ДО раздела и возвращает ПОСЛЕ — что
         бы раздел ни делал и чем бы ни кончил. Свой finally внутри
         раздела остаётся полезным (он возвращает состояние сразу, до
         сверки в самом разделе), но забыть его больше не смертельно.

         Исключение раздела тоже больше не уносит всю проверку: оно
         ловится здесь и превращается в честный `вНорме: false` с
         текстом сбоя, а счёт настоящих ошибок страницы не трогается. */
      await win.webContents.executeJavaScript(`(() => {
        /* Объекты состояния студии, которые разделы правят «на время».
           Копия поверхностная плюс один уровень вглубь для простых
           объектов и коротких списков: иначе правка вида
           editor.mix.orig = 0 пережила бы раздел. Огибающую голоса и
           звуковые буферы не копируем вовсе — это мегабайты на каждый
           раздел, проверка стала бы вдвое дольше; разделы и так
           подставляют свои, а не правят чужие изнутри. */
        const ОБЪЕКТЫ = [state, editor, audio, voice, тон, скраб];
        // Окна поверх студии: раздел мог открыть чужое и не закрыть
        const ОКНА = ['whatsnew', 'key-overlay', 'export-overlay',
          'ai-overlay', 'asr-overlay', 'update-bar'];

        const простой = (v) => !!v && typeof v === 'object'
          && (v.constructor === Object || (Array.isArray(v) && v.length <= 64));

        const снятьОбъект = (о) => {
          const поля = [];
          for (const ключ of Object.keys(о)) {
            const v = о[ключ];
            if (typeof v === 'function') continue;
            поля.push([ключ, v, простой(v)
              ? (Array.isArray(v) ? v.slice() : Object.assign({}, v)) : null]);
          }
          return поля;
        };

        const вернутьОбъект = (о, поля) => {
          for (const [ключ, было, нутро] of поля) {
            if (о[ключ] !== было) о[ключ] = было;
            if (!нутро) continue;
            if (Array.isArray(нутро)) {
              if (было.length !== нутро.length
                || нутро.some((v, i) => было[i] !== v)) {
                было.length = 0;
                for (const v of нутро) было.push(v);
              }
            } else {
              for (const к of Object.keys(было)) if (!(к in нутро)) delete было[к];
              for (const к of Object.keys(нутро)) {
                if (было[к] !== нутро[к]) было[к] = нутро[к];
              }
            }
          }
        };

        const снятьХранилище = () => {
          const к = {};
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const кл = localStorage.key(i);
              к[кл] = localStorage.getItem(кл);
            }
          } catch (e) { return null; }
          return к;
        };

        const вернутьХранилище = (было) => {
          if (!было) return;
          try {
            for (let i = localStorage.length - 1; i >= 0; i--) {
              const кл = localStorage.key(i);
              if (!(кл in было)) localStorage.removeItem(кл);
            }
            for (const кл of Object.keys(было)) {
              if (localStorage.getItem(кл) !== было[кл]) {
                localStorage.setItem(кл, было[кл]);
              }
            }
          } catch (e) { /* переполнено — проверку из-за этого не роняем */ }
        };

        const снятьЭкран = () => ({
          поле: document.getElementById('lyrics-input').value,
          шаги: [...document.querySelectorAll('.step-panel')]
            .map((p) => p.classList.contains('active')),
          вкладки: [...document.querySelectorAll('.step-tab')]
            .map((t) => t.classList.contains('active')),
          тело: document.body.className,
          корень: document.documentElement.className,
          окна: ОКНА.map((id) => {
            const el = document.getElementById(id);
            return el ? el.classList.contains('hidden') : null;
          }),
        });

        const вернутьЭкран = (с) => {
          const поле = document.getElementById('lyrics-input');
          if (поле.value !== с.поле) {
            поле.value = с.поле;
            /* Подпись главной кнопки разметки («Распознать текст»
               против «Подогнать мой текст») ставит обработчик поля,
               а не разметка: без события она осталась бы от чужого
               текста — ровно то, на чём падал раздел «язык». */
            поле.dispatchEvent(new Event('input'));
          }
          document.querySelectorAll('.step-panel')
            .forEach((p, i) => p.classList.toggle('active', !!с.шаги[i]));
          document.querySelectorAll('.step-tab').forEach((t, i) => {
            t.classList.toggle('active', !!с.вкладки[i]);
            // Доступность вкладок считается от maxStep, а он уже вернулся
            t.disabled = +t.dataset.step > state.maxStep;
          });
          if (document.body.className !== с.тело) document.body.className = с.тело;
          if (document.documentElement.className !== с.корень) {
            document.documentElement.className = с.корень;
          }
          ОКНА.forEach((id, i) => {
            const el = document.getElementById(id);
            if (el && с.окна[i] !== null) el.classList.toggle('hidden', с.окна[i]);
          });
        };

        const снять = () => ({
          язык: I18N.язык(),
          тема: window.THEME ? window.THEME.тема() : null,
          confirm: window.confirm,
          alert: window.alert,
          prompt: window.prompt,
          объекты: ОБЪЕКТЫ.map(снятьОбъект),
          экран: снятьЭкран(),
          хранилище: снятьХранилище(),
        });

        const вернуть = (с) => {
          /* Заход простукивания и разметка слов забирают экран себе.
             Закрываем их тем же путём, каким закрывает студия: снять
             один флаг мало — на экране осталась бы чужая панель. */
          try { if (tap.active) finishTapMode(); } catch (e) { /* уже закрыт */ }
          try { if (wordTap.active) finishWordTap(false); } catch (e) { /* уже */ }
          window.confirm = с.confirm;
          window.alert = с.alert;
          window.prompt = с.prompt;
          ОБЪЕКТЫ.forEach((о, i) => вернутьОбъект(о, с.объекты[i]));
          /* Кэши отрисовки — единственное, что НЕ возвращаем, а гасим.
             Это слепки «что уже нарисовано»: вернуть им прежнее
             значение значило бы сказать редактору, что на холсте лежит
             картинка, которой там давно нет, — и следующая отрисовка
             честно ничего не сделала бы. Гашение хуже не сделает:
             оно просто заставляет посчитать заново. */
          editor.peaks = null;
          editor.spans = null;
          editor.spansKey = '';
          editor.stageKey = '';
          editor.stageDrawn = null;
          editor.кадрПоказан = null;
          вернутьЭкран(с.экран);
          /* Язык — после состояния: смена языка перерисовывает
             пол-студии, и рисовать её надо уже по вернувшимся
             строкам, а не по чужим. */
          if (I18N.язык() !== с.язык) I18N.установить(с.язык);
          if (window.THEME && с.тема && window.THEME.тема() !== с.тема) {
            window.THEME.установить(с.тема);
          }
          /* Хранилище последним: всё, что выше, могло по дороге
             сохранить черновик — правка разметки делает это сама. */
          вернутьХранилище(с.хранилище);
        };

        window.__раздел = (имя, тело) => {
          const с = снять();
          const прибрать = () => {
            try { вернуть(с); } catch (e) {
              console.error('уборка после раздела ' + имя + ': '
                + ((e && e.message) || e));
            }
          };
          const сбой = (e) => ({
            разделСорвался: имя,
            ошибка: String((e && e.message) || e),
            вНорме: false,
          });
          try {
            const итог = тело();
            // Разделы бывают и с await внутри — тогда уборка идёт по хвосту
            if (итог && typeof итог.then === 'function') {
              return итог.then(
                (v) => { прибрать(); return v; },
                (e) => { прибрать(); return сбой(e); });
            }
            прибрать();
            return итог;
          } catch (e) {
            прибрать();
            return сбой(e);
          }
        };
        return true;
      })()`);
      const report = await win.webContents.executeJavaScript(`(() => ({
        аиБлокВиден: !document.getElementById('ai-block').classList.contains('hidden'),
        кнопкаЕсть: !!document.getElementById('btn-ai-run'),
        распознаваниеВидно: !document.getElementById('asr-block').classList.contains('hidden'),
        кнопкаРаспознавания: !!document.getElementById('btn-asr-run'),
        моделейРаспознавания: document.getElementById('asr-model').options.length,
        /* Два режима разметки текста: поле пустое — распознаём с нуля,
           текст вставлен — подгоняем его под песню. Проверяем сам
           переключатель: подпись кнопки, вторая кнопка и пояснения. */
        разметкаТекста: __раздел('разметкаТекста', () => {
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
        }),
        /* Умолчания качества. Разделение — один проход: лишние проходы
           на качество не влияют, это замерено, и три прохода означали
           лишь тройное ожидание. Распознавание — крупная модель, она
           и правда слышит лучше. Оба редких варианта обязаны остаться
           в списках (их не удаляли, только спрятали), а сами блоки
           «Ещё варианты» — быть свёрнутыми. */
        качество: __раздел('качество', () => {
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
        }),
        /* Оценка времени. Считается из длины трека, поэтому проверяем её
           на длине настоящего замера — песня 2 мин 53 с (173 с). Настоящие
           числа на этом Маке: разделение одним проходом ≈159 с, обычная
           модель по миксу 104 с, крупная по миксу 202 с, крупная по чистому
           вокалу 355 с. Вилки нарочно широкие: важно не наврать в разы. */
        оценкаВремени: __раздел('оценкаВремени', () => {
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
        }),
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
        размерСтрок: __раздел('размерСтрок', () => {
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
        }),
        /* Редактор: дорожка блоками, отмена действий и полоса голоса.
           Подкладываем короткую «песню» и три строки, гоняем на них всё,
           что должно работать, и возвращаем прежнее состояние. */
        редактор: __раздел('редактор', () => {
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
        }),
        /* Правка слов — зеркало панели строки: выбор слова щелчком,
           снятие выбора при смене строки, числовые поля (верное/неверное
           значение), клавиши той же грамматики (стрелки/скобки, Shift
           мельче, Alt крупнее — но у слова, не у строки), магнит на
           границе слова (без него/с ним — числа должны разойтись),
           кольцо слова и «распределить» по слогам (Align.spread).
           Своя короткая «песня» с голосом, кончающимся ровно на 5.01 с —
           туда и должен притянуть магнит. */
        правкаСлов: __раздел('правкаСлов', () => {
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
        }),
        /* Время в полях инспектора. Раньше поля показывали голые секунды,
           и одно и то же место песни читалось на дорожке как «3:10»,
           а в поле как «190». Проверяем ровно эту беду: что показано
           минутами и что набранное понимается в обоих видах —
           и «1:27,44», и просто «87.44». Плохое (буквы, минус) обязано
           отклоняться, не трогая разметку. */
        времяВПолях: __раздел('времяВПолях', () => {
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
        }),
        /* Дописанные строки. Беда: человек вспоминает про забытый куплет,
           дописывает его в текст — и на дорожке этих строк нет вовсе,
           потому что времени у них нет. Проверяем, что место им находится
           между размеченными соседями, что они помечены «на глазок»
           и что строку, которую просто ещё не простучали, никто не трогает. */
        новыеСтроки: __раздел('новыеСтроки', () => {
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
        }),
        /* Черновик файлом и строка «что в памяти». Проверяем круг целиком:
           собрали проект → потеряли работу → открыли черновик → всё на
           месте. Файл берём не с диска — тем же JSON, каким он уходит
           в download. */
        черновик: __раздел('черновик', () => {
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
        }),
        /* «Слушать только это». Отдельной дорожки голоса у студии нет:
           голос — это разница песни и минусовки, поэтому в режиме
           «только голос» минусовка идёт в противофазе. Проверяем сами
           усиления и то, что соло не переживает уход из редактора. */
        соло: __раздел('соло', () => {
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
        }),
        /* Пауза между словами. Раньше конец слова был обязан равняться
           началу следующего: перетаскивание сваривало соседей, и паузу
           выразить было нечем. Проверяем оба поведения сразу — обычное
           перетаскивание стыка по-прежнему сваривает, с Cmd/Ctrl края
           расходятся, — а заодно то, ради чего это делалось: заливка
           караоке в паузе стоит, и расширенный LRC несёт лишнюю метку
           на конце слова. */
        паузаМеждуСловами: __раздел('паузаМеждуСловами', () => {
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
        }),
        /* Края КРАЙНИХ слов строки. Жалоба была прямая: «не могу
           подвинуть начало слова, время тоже не выставить» — человек
           выбрал первое слово, а поле «начало» недоступно и ручки
           у левого края нет. Правило «первое слово начинается вместе
           со строкой» — тот же сварной шов, что и между словами: пауза
           ПЕРЕД первым словом законна, певец вступает не сразу.
           Проверяем, что начало первого слова двигается мышью, полем
           и клавишами, что строка при этом стоит, что пауза видна
           в lineWords числами, заливка в ней стоит, в расширенном LRC
           метки строки и слова расходятся, подведение вплотную снова
           даёт стык, а отмена возвращает как было. И отдельно — конец
           ПОСЛЕДНЕГО слова: пока его не трогали, автоматика тянет его
           до конца строки (распев), а выставленный руками уважается. */
        краяКрайнихСлов: __раздел('краяКрайнихСлов', () => {
          const былиСтроки = state.lines;
          const былБуфер = state.originalBuffer;
          const былаДлина = audio.duration;
          const былSnap = editor.snap;
          const былКрай = editor.одинКрай;
          const былМасштаб = editor.pxPerSec;
          const былаПрокрутка = editor.scrollT;
          // Поля и клавиши сами сохраняют черновик — возвращаем как было
          const былПроект = localStorage.getItem('karaoke-project');
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
            editor.одинКрай = false;
            clearHistory();
            openEditor();
            editor.pxPerSec = 40;
            editor.scrollT = 0;
            selectLine(0, {});

            const слова = () => {
              const sp = spanOfRow(0);
              return lineWords(sp.line, sp).map((w) => ({
                t: w.text.trim(), s: +w.start.toFixed(3), e: +w.end.toFixed(3),
              }));
            };
            const начало = () => spanOfRow(0).start;
            const равно = (a, b) => Math.abs(a - b) < 1e-6;

            const было = слова();
            // Пока не трогали, первое слово начинается вместе со строкой
            const стыкБыл = равно(было[0].s, начало());

            // Ручка у левого края первого слова ловится
            const L = timelineLanes();
            const y = L.words.y + Math.round(L.words.h / 2);
            const хит = (t) => {
              const h = timelineHit(tToX(t), y);
              return h ? h.kind + ':' + h.k : null;
            };
            const ручкаНачала = хит(было[0].s);

            // Мышью: начало первого слова уезжает вправо, строка стоит
            beginDrag({ kind: 'word-start', row: 0, k: 0 }, было[0].s);
            applyDrag(было[0].s + 0.5);
            endDrag();
            const мышью = слова();
            const паузаМышью = +(мышью[0].s - начало()).toFixed(3);
            const строкаНаМесте = state.lines[0].time === 2;

            // Заливка караоке: в паузе первое слово ещё не начато
            const sp0 = spanOfRow(0);
            const ws0 = lineWords(sp0.line, sp0);
            const заливкаСтоит = wordProgress(ws0, (sp0.start + ws0[0].start) / 2)[0] === 0;

            /* Расширенный LRC: метка строки стоит на её начале, метка
               первого слова — позже, вот пауза и выражена. */
            const меткаСтроки = fmtLrcTime(sp0.start);
            const меткаСлова = fmtLrcTime(ws0[0].start);

            // Поле «начало» доступно и применяется числом
            editor.wordSel = 0;
            updateWordInfo();
            const полеН = document.getElementById('sel-word-start');
            const полеДоступно = !полеН.disabled;
            полеН.value = '2.650';
            применитьПолеСлова('start');
            const полем = слова()[0].s;

            // Клавиши — те же, что у остальных слов
            nudgeSelected('start', -0.1);
            const клавишей = слова()[0].s;

            /* Правее собственного конца минус MIN_SPAN край не пускают:
               слово короче восьмидесяти миллисекунд не бывает. Конец
               первого слова тут 2,8 — значит, дальше 2,72 не уедет. */
            полеН.value = '5';
            применитьПолеСлова('start');
            const упорВСвойКонец = слова()[0].s;

            // Вплотную к началу строки — снова стык
            полеН.value = '2';
            применитьПолеСлова('start');
            const сноваСтык = стыкли(слова()[0].s, начало());

            // Отмена возвращает предыдущее положение края
            undoEdit();
            const послеОтмены = слова()[0].s;

            /* Конец последнего слова. Хвост распева есть только там, где
               конец строки дальше последней метки, — заводим его ручным
               концом строки (в браузере голосовой дорожки нет). */
            const п = state.lines[0].words.length - 1;
            state.lines[0].end = 7.5;
            state.lines[0].ручнойКонец = true;
            editor.spansKey = '';
            const сыройКонец = state.lines[0].words[п].end;
            const распевТянет = слова()[п].e;              // 7,5 — до конца строки
            const ручкаКонца = хит(распевТянет);

            editor.wordSel = п;
            updateWordInfo();
            const полеК = document.getElementById('sel-word-end');
            const конецДоступен = !полеК.disabled;
            полеК.value = '6.500';
            применитьПолеСлова('end');
            const ручнойКонец = слова()[п].e;              // 6,5 — уважили человека
            const признакВстал = !!state.lines[0].words[п].ручнойКонец;
            const хвостУСтроки = spanOfRow(0).end;         // 7,5 — строка длиннее слова

            // Вплотную к концу строки — признак снимается, распев возвращается
            полеК.value = '7.5';
            применитьПолеСлова('end');
            const признакСнялся = !state.lines[0].words[п].ручнойКонец;
            const сноваРаспев = слова()[п].e;

            return {
              стыкБыл, ручкаНачала, паузаМышью, строкаНаМесте, заливкаСтоит,
              меткаСтроки, меткаСлова, полеДоступно, полем, клавишей,
              упорВСвойКонец, сноваСтык, послеОтмены,
              сыройКонец, распевТянет, ручкаКонца, конецДоступен,
              ручнойКонец, признакВстал, хвостУСтроки, признакСнялся, сноваРаспев,
              вНорме: стыкБыл && ручкаНачала === 'word-start:0'
                && равно(паузаМышью, 0.5) && строкаНаМесте && заливкаСтоит
                && меткаСтроки !== меткаСлова
                && полеДоступно && равно(полем, 2.65) && равно(клавишей, 2.55)
                && равно(упорВСвойКонец, 2.72)
                && сноваСтык && равно(послеОтмены, 2.72)
                // Распев: сырая метка 6 с, а показано 7,5 — до конца строки
                && равно(сыройКонец, 6) && равно(распевТянет, 7.5)
                && ручкаКонца === 'word-end:' + п && конецДоступен
                // Выставленный руками конец уважается, хвост остаётся строке
                && равно(ручнойКонец, 6.5) && признакВстал && равно(хвостУСтроки, 7.5)
                && признакСнялся && равно(сноваРаспев, 7.5),
            };
          } finally {
            state.lines = былиСтроки;
            state.originalBuffer = былБуфер;
            audio.duration = былаДлина;
            editor.snap = былSnap;
            editor.одинКрай = былКрай;
            editor.pxPerSec = былМасштаб;
            editor.scrollT = былаПрокрутка;
            editor.peaks = null;
            editor.sel = -1;
            editor.wordSel = -1;
            editor.spansKey = '';
            clearHistory();
            if (былПроект != null) localStorage.setItem('karaoke-project', былПроект);
            else localStorage.removeItem('karaoke-project');
            if (!былаАктивна) панель.classList.remove('active');
          }
        }),
        /* Выделение диапазона и пропорциональное растяжение. Беды две:
           уехал один куплет — а кнопки сдвига двигали ВСЮ разметку,
           то есть портили верный остаток песни; и разметка «плывёт» —
           первая строка куплета стоит верно, последняя опаздывает.
           Проверяем протяжку по линейке, сдвиг только выделенного,
           растяжение (числом — что середина встала пропорционально),
           что ручные концы и метки слов поехали вместе, что соседние
           строки не тронуты, что край упирается в соседа и что отмена
           возвращает и времена строк, и метки слов. */
        диапазон: __раздел('диапазон', () => {
          const былиСтроки = state.lines;
          const былБуфер = state.originalBuffer;
          const былаДлина = audio.duration;
          const былSnap = editor.snap;
          const былМасштаб = editor.pxPerSec;
          const былаПрокрутка = editor.scrollT;
          /* Раздел двигает разметку, а сдвиг сам собой сохраняет черновик
             в localStorage — то есть проверка оставила бы после себя свои
             строки, и следующий запуск на той же папке профиля увидел бы
             студию «с песней». Черновик возвращаем как было. */
          const былПроект = localStorage.getItem('karaoke-project');
          const панель = document.getElementById('step-3');
          const былаАктивна = панель.classList.contains('active');
          try {
            const SR = 8000, dur = 40;
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            state.originalBuffer = ctx.createBuffer(1, SR * dur, SR);
            audio.duration = dur;
            const св = () => ([
              { text: 'ноль', time: 1, end: null, ручнойКонец: false, сомнительная: false },
              { text: 'раз', time: 5, end: null, ручнойКонец: false, сомнительная: false,
                words: [{ text: 'раз', time: 5, end: 5.5 }] },
              { text: 'два', time: 7, end: 7.8, ручнойКонец: true, сомнительная: false },
              { text: 'три', time: 9, end: null, ручнойКонец: false, сомнительная: false },
              { text: 'четыре', time: 20, end: null, ручнойКонец: false, сомнительная: false },
            ]);
            state.lines = св();
            панель.classList.add('active');
            clearVoiceTrack();
            editor.peaks = null;
            editor.snap = false;   // здесь мерим руками, магнит только помешает
            editor.range = null;
            clearHistory();
            openEditor();
            editor.pxPerSec = 40;
            editor.scrollT = 0;
            selectLine(1, {});

            const т = () => state.lines.map((l) => +l.time.toFixed(3));
            const слово = () => ({
              t: +state.lines[1].words[0].time.toFixed(3),
              e: +state.lines[1].words[0].end.toFixed(3),
            });
            const ручной = () => +state.lines[2].end.toFixed(3);

            // Протяжка по линейке: в выделение попадают строки, начало
            // которых внутри протянутого времени (5, 7, 9 — не 1 и не 20)
            beginRangeDrag({ kind: 'range-new' }, 4);
            applyRangeDrag(10);
            endRangeDrag();
            const выделено = строкиДиапазона();

            // Ручки полосы ловятся на линейке — за них и растягивают
            const L = timelineLanes();
            const yЛин = L.ruler.y + Math.round(L.ruler.h / 2);
            const гр = границыДиапазона();
            const хит = (x) => {
              const h = timelineHit(x, yЛин);
              return h ? h.kind : null;
            };
            const ручки = {
              лев: хит(tToX(гр.a)), прав: хит(tToX(гр.b)),
              середина: хит(tToX((гр.a + гр.b) / 2)),
            };

            // Кнопка сдвига: пока есть выделение — двигает только его
            document.querySelector('#shift-all [data-shift="1"]').click();
            const послеСдвига = т();
            const сдвигСлова = слово();
            const сдвигРучного = ручной();
            undoEdit();
            const послеОтменыСдвига = т();

            /* Пропорциональное растяжение: якорь — левый край (метка
               первой строки, 5 с), правый край ведём с 9 на 13, значит
               k = 2. Середина (7 с) обязана встать ровно на 9 с. */
            beginRangeDrag({ kind: 'range-end' }, 9);
            applyRangeDrag(13);
            endRangeDrag();
            const растянуто = т();
            const растСлово = слово();
            const растРучной = ручной();
            undoEdit();
            const послеОтменыРастяжения = т();
            const словоВернулось = слово();
            const ручнойВернулся = ручной();

            /* Край упирается в соседнюю строку: тянем далеко за неё —
               последняя выделенная встаёт вплотную к 20 с, но не дальше */
            beginRangeDrag({ kind: 'range-end' }, 9);
            applyRangeDrag(60);
            endRangeDrag();
            const упор = т();
            undoEdit();

            // Esc снимает выделение
            снятьДиапазон();
            const послеEsc = editor.range;

            const равно = (a, b) => Math.abs(a - b) < 1e-6;
            return {
              выделено, ручки, послеСдвига, сдвигСлова, сдвигРучного,
              растянуто, растСлово, растРучной, упор,
              послеОтменыРастяжения, словоВернулось, ручнойВернулся,
              послеEsc,
              вНорме: выделено.length === 3 && выделено[0] === 1 && выделено[2] === 3
                && ручки.лев === 'range-start' && ручки.прав === 'range-end'
                && ручки.середина === 'range-move'
                // Сдвиг: выделенные на +1, соседи стоят
                && равно(послеСдвига[0], 1) && равно(послеСдвига[4], 20)
                && равно(послеСдвига[1], 6) && равно(послеСдвига[2], 8)
                && равно(послеСдвига[3], 10)
                && равно(сдвигСлова.t, 6) && равно(сдвигСлова.e, 6.5)
                && равно(сдвигРучного, 8.8)
                && равно(послеОтменыСдвига[1], 5) && равно(послеОтменыСдвига[3], 9)
                // Растяжение: 5 стоит якорем, 9 уехало на 13, середина 7 → 9
                && равно(растянуто[1], 5) && равно(растянуто[2], 9)
                && равно(растянуто[3], 13)
                && равно(растянуто[0], 1) && равно(растянуто[4], 20)
                // Метки слов и ручные концы растянулись вместе со строками
                && равно(растСлово.t, 5) && равно(растСлово.e, 6)
                && равно(растРучной, 10.6)
                // Отмена вернула и времена строк, и метки слов
                && равно(послеОтменыРастяжения[1], 5) && равно(послеОтменыРастяжения[2], 7)
                && равно(послеОтменыРастяжения[3], 9)
                && равно(словоВернулось.t, 5) && равно(словоВернулось.e, 5.5)
                && равно(ручнойВернулся, 7.8)
                // Упор в соседа: дальше 20 с выделение не пускают
                && упор[3] > 15 && упор[3] <= 19.95 && равно(упор[4], 20)
                && послеEsc === null,
            };
          } finally {
            state.lines = былиСтроки;
            state.originalBuffer = былБуфер;
            audio.duration = былаДлина;
            editor.snap = былSnap;
            editor.pxPerSec = былМасштаб;
            editor.scrollT = былаПрокрутка;
            editor.range = null;
            editor.peaks = null;
            editor.sel = -1;
            editor.wordSel = -1;
            editor.spansKey = '';
            clearHistory();
            if (былПроект != null) localStorage.setItem('karaoke-project', былПроект);
            else localStorage.removeItem('karaoke-project');
            if (!былаАктивна) панель.classList.remove('active');
          }
        }),
        /* Уровни дорожек в наушниках: ползунок у оригинала и у минусовки.
           Своей дорожки у голоса нет, он берётся вычитанием, поэтому
           «оригинал O, минусовка M» — это песня с усилением O и минусовка
           с усилением M−O. Проверяем сами числа, связку с галкой «слышу
           оригинал» (два органа управления об одном и том же обязаны
           ходить вместе) и то, что принудительный оригинал (кольцо,
           простукивание, прослушивание строки) не даёт увести голос
           ниже записи. */
        уровниДорожек: __раздел('уровниДорожек', () => {
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
        }),
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
        простукивание: __раздел('простукивание', () => {
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
        }),
        /* Заход с середины, а дальше лежат метки ПОЗЖЕ простуканного —
           та самая ветка «дальше метки идут вспять, стереть их?».

           Свой раздел ей нужен потому, что в разделе «простукивание»
           выше её не задеть ни разу: там заход всегда кончается там,
           где следующая метка позже последней простуканной, и вопрос
           не задаётся вовсе. Из-за этого в ветке спокойно жило падение:
           локальная переменная звалась «t» — той же буквой, что функция
           перевода, — перекрывала её, confirm валился с «t is not
           a function» и уносил с собой ВЕСЬ finishTapMode: до сетки
           строк, дорожки и saveProject дело не доходило, весь заход
           пропадал после перезагрузки. Самопроверка этого не видела.

           Меряем числами, а не наличием кода:
             • вопрос и правда задан (и текст его собрался переводом —
               с прежним багом до него не доходило);
             • исключения не было;
             • ответ «нет» оставляет чужие метки целыми;
             • ответ «да» стирает их с той строки и дальше;
             • в обоих случаях простуканное лежит в localStorage —
               то есть saveProject отработал, а не оборвался на полпути.

           Строки размечены на 4, 8, 12, 16, 20 с. Заходим с третьей
           и бьём на 25-й секунде: следующая размеченная (четвёртая,
           16 с) оказывается РАНЬШЕ — ровно тот случай. */
        простукиваниеВспять: __раздел('простукиваниеВспять', () => {
          const былиСтроки = state.lines;
          const былБуфер = state.originalBuffer;
          const былаДлина = audio.duration;
          const былиПики = editor.peaks;
          const панель = document.getElementById('step-3');
          const былаАктивна = панель.classList.contains('active');
          const былConfirm = window.confirm;
          const былПроект = localStorage.getItem('karaoke-project');
          const былоПоле = document.getElementById('lyrics-input').value;
          try {
            const SR = 8000, dur = 40;
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            state.originalBuffer = ctx.createBuffer(1, SR * dur, SR);
            audio.duration = dur;
            панель.classList.add('active');

            let спросили = 0;
            let вопрос = '';
            let ответ = false;
            window.confirm = (текст) => { спросили++; вопрос = String(текст); return ответ; };

            const времена = () => state.lines.map((l) => (l.time == null ? null : +l.time.toFixed(2)));
            const изХранилища = () => {
              let п = null;
              try { п = JSON.parse(localStorage.getItem('karaoke-project')); } catch (e) { п = null; }
              return п && Array.isArray(п.times)
                ? п.times.map((v) => (v == null ? null : +(+v).toFixed(2))) : null;
            };

            const заход = (ответить) => {
              state.lines = [1, 2, 3, 4, 5].map((n) => ({
                text: 'Строка ' + n, time: n * 4, end: null,
                ручнойКонец: false, сомнительная: false,
              }));
              document.getElementById('lyrics-input').value =
                state.lines.map((l) => l.text).join('\\n');
              editor.peaks = null;
              editor.sel = -1;
              editor.spansKey = '';
              clearHistory();
              openEditor();
              localStorage.removeItem('karaoke-project');
              спросили = 0; вопрос = ''; ответ = ответить;
              let упало = null;
              startTapMode(2);          // заход со «Строки 3»
              audio.pause();
              // Удар ПОЗЖЕ метки следующей строки: у неё 16 с, бьём на 25-й
              audio.offset = 25;
              document.dispatchEvent(new KeyboardEvent('keydown',
                { code: 'Space', key: ' ', bubbles: true }));
              audio.pause();
              try { finishTapMode(); } catch (e) { упало = String((e && e.message) || e); }
              return {
                спросили, вопрос, упало,
                времена: времена(), вХранилище: изХранилища(),
                режимЗакрыт: tap.active === false,
              };
            };

            const нет = заход(false);
            const да = заход(true);

            const одинаково = (a, b) => Array.isArray(a) && Array.isArray(b)
              && a.length === b.length && a.every((v, i) => v === b[i]);
            // Вопрос собран переводом и назвал ту самую строку (k + 1 = 4)
            const вопросНастоящий = нет.вопрос.includes('4') && !/[{}]/.test(нет.вопрос)
              && нет.вопрос.length > 20;

            return {
              нет, да, вопросНастоящий,
              вНорме:
                // Вопрос задан ровно один раз в каждом заходе, без падения
                нет.спросили === 1 && да.спросили === 1
                && нет.упало === null && да.упало === null
                && вопросНастоящий
                && нет.режимЗакрыт && да.режимЗакрыт
                // Простучали строку 3 — она встала на 25 с в обоих заходах
                && нет.времена[2] === 25 && да.времена[2] === 25
                // Ранние метки не трогает ни один ответ
                && нет.времена[0] === 4 && нет.времена[1] === 8
                && да.времена[0] === 4 && да.времена[1] === 8
                // «Нет» — чужие метки целы
                && нет.времена[3] === 16 && нет.времена[4] === 20
                // «Да» — стёрты с четвёртой строки и дальше
                && да.времена[3] === null && да.времена[4] === null
                // И то и другое уехало в хранилище: saveProject отработал
                && одинаково(нет.вХранилище, нет.времена)
                && одинаково(да.вХранилище, да.времена),
            };
          } finally {
            window.confirm = былConfirm;
            if (tap.active) finishTapMode();
            state.lines = былиСтроки;
            state.originalBuffer = былБуфер;
            audio.duration = былаДлина;
            editor.peaks = былиПики;
            editor.sel = -1;
            editor.spansKey = '';
            clearHistory();
            document.getElementById('lyrics-input').value = былоПоле;
            if (былПроект != null) localStorage.setItem('karaoke-project', былПроект);
            else localStorage.removeItem('karaoke-project');
            if (!былаАктивна) панель.classList.remove('active');
          }
        }),
        /* Клавиши редактора под открытым окном.

           Беда с живой машины: человек открывает «Как пользоваться»
           поверх студии и читает, а общий обработчик клавиш редактора
           продолжает работать под окном. Стрелки двигают начало
           выбранной строки на 0,1 с за нажатие, ↑/↓ меняют выбор
           и снимают выделение диапазона, G включает сетку долей,
           L и S — кольцо и магнит, Delete убирает отрезок оригинала,
           Esc гасит кольцо. Разметка портится молча.

           Проверяем ЧИСЛАМИ и на всех трёх устройствах окон сразу:
           руководство (класс на body), «Что нового» (свой класс)
           и окно ожидания (.export-overlay — их четыре, берём окно
           тональности). Под каждым нажимаем весь набор клавиш и
           смотрим, что ни одно число не шелохнулось. А следом, уже
           без окна, — что те же клавиши по-прежнему работают: иначе
           «ничего не поменялось» доказывало бы только сломанный
           обработчик. */
        клавишиПодОкном: __раздел('клавишиПодОкном', () => {
          const былиСтроки = state.lines;
          const былБуфер = state.originalBuffer;
          const былаДлина = audio.duration;
          const былиПики = editor.peaks;
          const былаСетка = state.сетка;
          const былSnap = editor.snap;
          const былоКольцо = editor.loop;
          const былВыбор = editor.sel;
          const былПроект = localStorage.getItem('karaoke-project');
          const панель = document.getElementById('step-3');
          const былаАктивна = панель.classList.contains('active');
          const былаСправка = document.body.classList.contains('guide-open');
          const новости = document.getElementById('whatsnew');
          const былиНовостиСкрыты = новости.classList.contains('hidden');
          const окноТона = document.getElementById('key-overlay');
          const былоОкноСкрыто = окноТона.classList.contains('hidden');
          // Escape закрывает «Что нового», а закрытие метит хранилище
          const былиНовостиВидены = localStorage.getItem('karaoke-news-version');
          try {
            const SR = 8000, dur = 30;
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            state.originalBuffer = ctx.createBuffer(1, SR * dur, SR);
            audio.duration = dur;
            панель.classList.add('active');
            editor.peaks = null;

            const набор = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown',
              'KeyG', 'KeyL', 'KeyS', 'Delete', 'Escape'];
            const нажать = (code) => document.dispatchEvent(
              new KeyboardEvent('keydown', { code, key: code, bubbles: true }));

            const снимок = () => ({
              время: +state.lines[1].time.toFixed(3),
              выбор: editor.sel,
              сетка: !!state.сетка.вкл,
              магнит: !!editor.snap,
              кольцо: !!editor.loop,
            });
            const такойЖе = (a, b) => a.время === b.время && a.выбор === b.выбор
              && a.сетка === b.сетка && a.магнит === b.магнит && a.кольцо === b.кольцо;

            const подготовить = () => {
              state.lines = [1, 2, 3].map((n) => ({
                text: 'Строка ' + n, time: n * 5, end: null,
                ручнойКонец: false, сомнительная: false,
              }));
              state.сетка = { вкл: false, bpm: 120, фаза: 0, свой: true };
              editor.snap = false;
              /* Кольцо ставим полем, а не setLoop: тот заводит
                 воспроизведение, а нам нужно только число, которое
                 клавиша L обязана НЕ трогать. */
              editor.loop = true;
              editor.loopScope = 'line';
              editor.sel = 1;
              editor.wordSel = -1;
              editor.origSel = -1;
              editor.range = null;
              editor.spansKey = '';
              clearHistory();
            };

            /* Под окном: жмём набор и сверяем снимок ПОСЛЕ КАЖДОЙ клавиши,
               а не только в конце. Иначе пары гасили бы друг друга:
               ← отменяет →, ↑ отменяет ↓, — и сломанный обработчик
               выглядел бы молчащим. */
            const подОкном = (имя, открыть, закрыть) => {
              подготовить();
              const до = снимок();
              открыть();
              const виделиОкно = окноПоверхСтудии();
              const сбои = [];
              набор.forEach((code) => {
                нажать(code);
                if (!такойЖе(до, снимок())) сбои.push(code);
              });
              const после = снимок();
              закрыть();
              return { имя, виделиОкно, до, после, сбои, молчали: сбои.length === 0 };
            };

            const справка = подОкном('руководство',
              () => document.body.classList.add('guide-open'),
              () => document.body.classList.remove('guide-open'));
            const чтоНового = подОкном('что нового',
              () => новости.classList.remove('hidden'),
              () => новости.classList.add('hidden'));
            const ожидание = подОкном('окно ожидания',
              () => окноТона.classList.remove('hidden'),
              () => окноТона.classList.add('hidden'));

            /* А без окна те же клавиши обязаны работать: иначе проверка
               выше доказывала бы только сломанный обработчик */
            подготовить();
            const доБезОкна = снимок();
            const небылоОкна = окноПоверхСтудии() === false;
            нажать('ArrowRight');
            const сдвинули = +(state.lines[1].time - доБезОкна.время).toFixed(3);
            нажать('KeyG');
            const сеткаВключилась = !!state.сетка.вкл;
            нажать('KeyS');
            const магнитВключился = !!editor.snap;
            нажать('ArrowDown');
            const выборУехал = editor.sel !== доБезОкна.выбор;

            return {
              справка, чтоНового, ожидание,
              небылоОкна, сдвинули, сеткаВключилась, магнитВключился, выборУехал,
              вНорме: справка.виделиОкно && чтоНового.виделиОкно && ожидание.виделиОкно
                && справка.молчали && чтоНового.молчали && ожидание.молчали
                // Без окна клавиши на месте: 0,1 с за нажатие, G, S, ↓
                && небылоОкна && сдвинули === 0.1
                && сеткаВключилась && магнитВключился && выборУехал,
            };
          } finally {
            document.body.classList.toggle('guide-open', былаСправка);
            новости.classList.toggle('hidden', былиНовостиСкрыты);
            окноТона.classList.toggle('hidden', былоОкноСкрыто);
            state.lines = былиСтроки;
            state.originalBuffer = былБуфер;
            state.сетка = былаСетка;
            audio.duration = былаДлина;
            audio.pause();
            editor.peaks = былиПики;
            editor.snap = былSnap;
            editor.loop = былоКольцо;
            editor.sel = былВыбор;
            editor.wordSel = -1;
            editor.origSel = -1;
            editor.range = null;
            editor.spansKey = '';
            clearHistory();
            обновитьСетку(true);
            if (былПроект != null) localStorage.setItem('karaoke-project', былПроект);
            else localStorage.removeItem('karaoke-project');
            if (былиНовостиВидены != null) localStorage.setItem('karaoke-news-version', былиНовостиВидены);
            else localStorage.removeItem('karaoke-news-version');
            if (!былаАктивна) панель.classList.remove('active');
          }
        }),

        /* Стёртый текст строки.

           Беда: стёр в сетке строк весь текст (или оставил одни
           пробелы) — поле пустое, а state.lines[i].text остался
           прежним, и на сцене поётся старое. Отказ был совсем молчаливым:
           прежний текст возвращался в поле только при следующей
           перерисовке, когда-нибудь.

           Решено НЕ принимать пустую строку (строка везёт на себе время,
           конец и метки слов, а Cmd+A и Backspace — движение на два
           пальца), но показывать отказ сразу, как из поля ушли.
           Меряем: текст в state цел, в поле он вернулся, а обычная
           правка по-прежнему проходит. */
        стёртаяСтрока: __раздел('стёртаяСтрока', () => {
          const былиСтроки = state.lines;
          const былоПоле = document.getElementById('lyrics-input').value;
          const былПроект = localStorage.getItem('karaoke-project');
          const панель = document.getElementById('step-3');
          const былаАктивна = панель.classList.contains('active');
          try {
            панель.classList.add('active');
            state.lines = [1, 2].map((n) => ({
              text: 'Строка ' + n, time: n * 5, end: null,
              ручнойКонец: false, сомнительная: false,
            }));
            editor.sel = -1;
            editor.spansKey = '';
            renderEditList();
            const поле = document.querySelector('#edit-list .edit-text[data-text-i="0"]');
            if (!поле) return { естьПоле: false, вНорме: false };

            const набрать = (текст) => {
              поле.textContent = текст;
              поле.dispatchEvent(new Event('input', { bubbles: true }));
            };
            const уйти = () => поле.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

            // 1. Обычная правка проходит как раньше
            набрать('Новый текст');
            const обычная = { вState: state.lines[0].text };
            уйти();
            обычная.вПоле = поле.textContent;

            // 2. Стёрли всё — в state прежнее, а после ухода оно и в поле
            набрать('');
            const пустая = { вState: state.lines[0].text, вПолеДоУхода: поле.textContent };
            уйти();
            пустая.вПолеПослеУхода = поле.textContent;

            // 3. Одни пробелы — то же самое: строка не пустеет
            набрать('   ');
            const пробелы = { вState: state.lines[0].text };
            уйти();
            пробелы.вПолеПослеУхода = поле.textContent;

            // 4. Строк не убавилось: пустое поле не значит «удалить»
            const строкВКонце = state.lines.length;

            return {
              естьПоле: true, обычная, пустая, пробелы, строкВКонце,
              вНорме: обычная.вState === 'Новый текст' && обычная.вПоле === 'Новый текст'
                && пустая.вState === 'Новый текст' && пустая.вПолеДоУхода === ''
                && пустая.вПолеПослеУхода === 'Новый текст'
                && пробелы.вState === 'Новый текст'
                && пробелы.вПолеПослеУхода === 'Новый текст'
                && строкВКонце === 2,
            };
          } finally {
            state.lines = былиСтроки;
            document.getElementById('lyrics-input').value = былоПоле;
            editor.sel = -1;
            editor.spansKey = '';
            renderEditList();
            if (былПроект != null) localStorage.setItem('karaoke-project', былПроект);
            else localStorage.removeItem('karaoke-project');
            if (!былаАктивна) панель.classList.remove('active');
          }
        }),

        /* Сверхдлинное слово на сцене караоке.

           Беда с живой машины: строка из трёхсот знаков без пробелов
           не переносилась и обрезалась — у сцены overflow-x: hidden,
           и на экране оставалась четверть слова. У .stage-line стоит
           white-space: nowrap, а класс .wrap меняет его на normal —
           но рвать сплошное слово браузеру всё равно негде, пока ему
           не разрешишь (overflow-wrap: anywhere).

           Меряем числами, а не наличием правила: насколько содержимое
           строки вылезает за её же коробку (scrollWidth − clientWidth)
           и на сколько рядов она разложилась. И тут же — что обычная
           длинная строка с пробелами переносится по-прежнему, короткая
           живёт в один ряд, а единый кегль не сломался. */
        длинноеСлово: __раздел('длинноеСлово', () => {
          const панель = document.getElementById('step-4');
          const былаАктивна = панель.classList.contains('active');
          const былиСтроки = state.lines;
          const былСвап = state.style.swapLines;
          try {
            панель.classList.add('active');   // скрытую сцену не измерить
            state.style.swapLines = false;
            const сцена = document.getElementById('lyrics-stage');
            /* Испытуемую строку ставим ВТОРОЙ: до начала песни сцена
               показывает строку, которой очередь петь, а не первую
               попавшуюся, и меряли бы мы соседку. */
            const мера = (текст) => {
              state.lines = [
                { text: 'Первая строка', time: 0, end: 3 },
                { text: текст, time: 3, end: 6 },
              ];
              applyStyle();
              const строки = [...сцена.querySelectorAll('.stage-line')];
              const наша = строки.find((el) => el.dataset.text === текст);
              if (!наша) return { найдена: false, тексты: строки.map((el) => String(el.dataset.text).slice(0, 14)) };
              const кегли = строки.map((el) => +parseFloat(getComputedStyle(el).fontSize).toFixed(2));
              const межстрочный = parseFloat(getComputedStyle(наша).lineHeight);
              return {
                найдена: true, строк: строки.length,
                ширинаСцены: Math.round(сцена.clientWidth),
                // Насколько содержимое вылезает за коробку самой строки
                вылезло: Math.max(0, наша.scrollWidth - наша.clientWidth),
                рядов: межстрочный > 0
                  ? Math.round(наша.getBoundingClientRect().height / межстрочный) : 0,
                переносов: строки.filter((el) => el.classList.contains('wrap')).length,
                кегль: Math.max(...кегли),
                кегльОдин: Math.max(...кегли) - Math.min(...кегли) < 0.01,
              };
            };
            const длинное = мера('я'.repeat(300));
            const сПробелами = мера('слово '.repeat(50).trim());
            const короткая = мера('Короткая строка');
            const цело = (м) => !!м && м.найдена && м.ширинаСцены > 0
              && м.вылезло === 0 && м.кегльОдин;
            return {
              длинное, сПробелами, короткая,
              вНорме: цело(длинное) && цело(сПробелами) && цело(короткая)
                // Слово без пробелов разложилось на ряды, а не уехало за край
                && длинное.рядов >= 2 && длинное.переносов >= 1
                // Обычная длинная строка переносится как раньше
                && сПробелами.рядов >= 2 && сПробелами.переносов >= 1
                // Короткая живёт в один ряд и переносить её незачем
                && короткая.рядов === 1 && короткая.переносов === 0,
            };
          } finally {
            state.lines = былиСтроки;
            state.style.swapLines = былСвап;
            applyStyle();
            if (!былаАктивна) панель.classList.remove('active');
          }
        }),

        /* «Сбросить слова» и дорожка.

           Беда: resetWords звал сетку строк, инспектор и предпросмотр,
           но не дорожку — а метки слов на ней нарисованы своими
           штрихами, вместе с разведёнными краями и паузами. Стёртое
           продолжало показываться, пока что-нибудь постороннее не
           перерисует дорожку.

           Проверяем не «позвали ли функцию», а САМИ ПИКСЕЛИ дорожки:
           снимаем отпечаток холста до сброса, сразу после и ещё раз
           после лишней отрисовки. Дорожка обязана поменяться на сбросе
           и НЕ поменяться от лишней отрисовки — то есть к концу сброса
           она уже показывает нынешнее положение дел. */
        сбросСлов: __раздел('сбросСлов', () => {
          const былиСтроки = state.lines;
          const былБуфер = state.originalBuffer;
          const былаДлина = audio.duration;
          const былиПики = editor.peaks;
          const былПроект = localStorage.getItem('karaoke-project');
          const панель = document.getElementById('step-3');
          const былаАктивна = панель.classList.contains('active');
          try {
            const SR = 8000, dur = 20;
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            state.originalBuffer = ctx.createBuffer(1, SR * dur, SR);
            audio.duration = dur;
            панель.classList.add('active');
            state.lines = [
              {
                text: 'раз два три', time: 2, end: 6,
                ручнойКонец: true, сомнительная: false,
                words: [
                  { text: 'раз', time: 2, end: 3 },
                  { text: 'два', time: 3.4, end: 4.2 },
                  { text: 'три', time: 4.8, end: 6 },
                ],
              },
              {
                text: 'четыре пять', time: 9, end: 13,
                ручнойКонец: true, сомнительная: false,
              },
            ];
            editor.peaks = null;
            editor.sel = 0;
            editor.wordSel = -1;
            editor.spansKey = '';
            clearHistory();
            openEditor();
            editor.sel = 0;
            editor.spansKey = '';
            resizeTimeline();
            drawTimeline();

            const холст = document.getElementById('timeline');
            const отпечаток = () => {
              const g = холст.getContext('2d');
              const d = g.getImageData(0, 0, холст.width, холст.height).data;
              let h = 5381;
              for (let i = 0; i < d.length; i += 4) {
                h = (((h * 33) >>> 0) ^ d[i] ^ (d[i + 1] << 3) ^ (d[i + 2] << 6)) >>> 0;
              }
              return h;
            };

            const размерХолста = холст.width * холст.height;
            const доСброса = отпечаток();
            drawTimeline();
            const доСброса2 = отпечаток();
            const словБыло = state.lines[0].words.length;
            resetWords(0);
            const сразуПослеСброса = отпечаток();
            // Лишняя отрисовка ничего не меняет — значит, сброс уже перерисовал
            drawTimeline();
            const послеЛишней = отпечаток();

            return {
              размерХолста, словБыло, доСброса2, устойчива: доСброса === доСброса2,
              словСтало: state.lines[0].words ? state.lines[0].words.length : 0,
              доСброса, сразуПослеСброса, послеЛишней,
              вНорме: размерХолста > 0 && словБыло === 3 && !state.lines[0].words
                && доСброса !== сразуПослеСброса
                && сразуПослеСброса === послеЛишней,
            };
          } finally {
            state.lines = былиСтроки;
            state.originalBuffer = былБуфер;
            audio.duration = былаДлина;
            editor.peaks = былиПики;
            editor.sel = -1;
            editor.wordSel = -1;
            editor.spansKey = '';
            clearHistory();
            if (былПроект != null) localStorage.setItem('karaoke-project', былПроект);
            else localStorage.removeItem('karaoke-project');
            if (!былаАктивна) панель.classList.remove('active');
          }
        }),

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
        язык: __раздел('язык', () => {
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

          /* ---- Устройство переключателя: выпадающий список ----
             Раньше здесь считались кнопки («их две»). Переключатель стал
             выпадающим списком, как у темы, и такой счёт не сказал бы
             ничего. Проверяем то, ради чего он стоит: одна кнопка со
             значком-глобусом, по пункту на язык с непустым названием,
             галка у нынешнего; список открывается нажатием, стрелка
             ведёт по пунктам, Esc и щелчок мимо закрывают; и главное —
             выбор ПУНКТОМ применяется: меняет язык документа и ложится
             в хранилище, то есть переживает перезагрузку.

             Гнездо по-прежнему ровно одно и в шапке — это не про
             устройство, а про место: второй такой же переключатель
             стоял когда-то в ряду шагов, и на экране они попадались
             на глаза оба сразу. */
          const кнопкаЯз = () => document.querySelector('.lang-switch .pick-btn');
          const пунктыЯз = () => [...document.querySelectorAll('.lang-switch .pick-item')];
          const открытЯз = () => кнопкаЯз().getAttribute('aria-expanded') === 'true';
          const кнопокЯз = document.querySelectorAll('.lang-switch .pick-btn').length;
          const названияЯз = пунктыЯз().map((п) => п.textContent.trim());
          const подсказкиЯз = пунктыЯз().map((п) => п.title);
          const отмеченЯз = (пунктыЯз().find((п) => п.getAttribute('aria-checked') === 'true') || {}).dataset;
          const отмеченНынешний = !!отмеченЯз && отмеченЯз.lang === I18N.язык();
          const значокГлобус = !!кнопкаЯз().querySelector('use[href="#i-globe"]');
          const былЗакрытЯз = !открытЯз();
          кнопкаЯз().click();
          const открылсяЯз = открытЯз();
          const фокусНаВыбранномЯз = document.activeElement
            === пунктыЯз().find((п) => п.dataset.lang === I18N.язык());
          document.activeElement.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
          const стрелкаВедётЯз = document.activeElement.classList.contains('pick-item')
            && document.activeElement.dataset.lang !== I18N.язык();
          document.activeElement.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          const закрылсяПоEscЯз = !открытЯз();
          кнопкаЯз().click();
          document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          const закрылсяМимоЯз = !открытЯз();
          кнопкаЯз().click();
          const пунктЯз = пунктыЯз().find((п) => п.dataset.lang === 'en');
          if (пунктЯз) пунктЯз.click();
          const пунктПрименилсяЯз = I18N.язык() === 'en'
            && document.documentElement.lang === 'en';
          const сохранилсяЯз = (() => {
            try { return localStorage.getItem('karaoke-lang') === 'en'; } catch (e) { return false; }
          })();
          /* Названия языков — самоназвания и НЕ переводятся: «Русский»
             и «English» стоят одинаково при любом языке студии.
             Переключатель нужен ровно тому, кто нынешнего языка
             не читает, — переведённые названия ему ничего не сказали бы.
             Поэтому здесь признак обратный обычному: не «надписи
             разошлись», а «надписи совпали». Подсказки при этом
             переводятся, и вот они разойтись обязаны. */
          const названияПоАнглийски = пунктыЯз().map((п) => п.textContent.trim());
          const подсказкиПоАнглийски = пунктыЯз().map((п) => п.title);
          const самоназвания = названияЯз.join('|') === названияПоАнглийски.join('|');

          I18N.установить(былЯзык);
          return {
            en, ru, langEn, langRu, кириллицыПриАнглийском, следы,
            вернулиЯзык: I18N.язык() === былЯзык,
            переключателей: document.querySelectorAll('.lang-switch').length,
            вШапке: !!document.querySelector('.site-header .lang-switch'),
            кнопокЯз, названияЯз, названияПоАнглийски, подсказкиЯз,
            подсказкиПоАнглийски, самоназвания, отмеченНынешний, значокГлобус,
            былЗакрытЯз, открылсяЯз, фокусНаВыбранномЯз, стрелкаВедётЯз,
            закрылсяПоEscЯз, закрылсяМимоЯз, пунктПрименилсяЯз, сохранилсяЯз,
            вНорме: langEn === 'en' && langRu === 'ru'
              && I18N.язык() === былЯзык
              && document.querySelectorAll('.lang-switch').length === 1
              && !!document.querySelector('.site-header .lang-switch')
              && кнопокЯз === 1 && названияЯз.length === I18N.ЯЗЫКИ.length
              && названияЯз.every((н) => н.length > 2) && отмеченНынешний
              && значокГлобус
              && былЗакрытЯз && открылсяЯз && фокусНаВыбранномЯз
              && стрелкаВедётЯз && закрылсяПоEscЯз && закрылсяМимоЯз
              && пунктПрименилсяЯз && сохранилсяЯз
              && самоназвания
              /* …а подсказки пунктов переводятся: они объясняют
                 действие, а не называют язык */
              && подсказкиПоАнглийски.every((п, i) => п && п !== подсказкиЯз[i])
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
        }),
        /* Номер версии в окне «Что нового» и на кнопке в подвале.
           Он живёт в разметке (data-news-version у <html>), а не
           в словаре: раньше номер был вшит в перевод и отстал —
           по-английски окно объявляло 1.8.4, когда в разметке стояла
           уже 1.9.0. Проверяем, что оба языка называют одно число
           и что подстановка раскрылась. */
        номерВерсии: __раздел('номерВерсии', () => {
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
        }),
        /* Логотип в шапке и в подвале. Приложению нужна своя копия
           картинки: папка icons/ в сборку не едет, и без копии рядом
           с интерфейсом вместо логотипа оставался запасной значок. */
        логотип: __раздел('логотип', () => {
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
        }),
        /* Раздел «Для компьютера» в приложении удалён — приложение уже
           стоит. Проверяем после переключения языка: перевод абзацев
           кладётся через innerHTML и приносит ссылки на раздел обратно,
           поэтому разворачивать их приходится каждый раз заново.
           В меню шапки пункта не должно быть совсем: ключ перевода
           висел на самой ссылке и вместе с ней пропадал. */
        разделДляКомпьютера: __раздел('разделДляКомпьютера', () => {
          const ссылок = document.querySelectorAll('a[href="#desktop"]').length;
          const вМеню = !!document.querySelector('.site-nav a[href="#desktop"]');
          return { ссылок, вМеню, разделЕсть: !!document.getElementById('desktop'),
            вНорме: ссылок === 0 && !вМеню && !document.getElementById('desktop') };
        }),
        /* Модификатор в подписях: на Маке Cmd, на Windows и Linux Ctrl.
           Проверяем и текст под дорожкой, и подсказку кнопки отмены —
           они наполняются разными путями (span и data-mod-title). */
        модификатор: __раздел('модификатор', () => {
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
        }),
        /* Тема оформления: переключатель собрался, атрибут на <html>
           меняется по клику, выбор переживает перезагрузку (localStorage),
           и — самое важное — рамка выделения на дорожке (--sel-ring)
           у тем правда разного цвета, а не только имя атрибута другое. */
        /* Темы. Их три, и переключатель у них теперь выпадающий:
           одна кнопка со значком нынешней темы и список из трёх
           с названиями. Раздел раньше просто считал кнопки в обойме
           («кнопокВПереключателе: 2») — от нового устройства такой
           счёт не сказал бы ничего, поэтому проверяем по существу:

             • переключатель собран как список: одна кнопка, три пункта
               с непустыми названиями, у выбранного стоит отметка;
             • список открывается нажатием, закрывается по Esc и по
               щелчку мимо — без этого он остался бы висеть на экране;
             • ВЫБОР ПРИМЕНЯЕТСЯ: щелчок по пункту меняет атрибут
               на <html> и переживает перезагрузку (ключ в хранилище);
             • у всех трёх тем РАЗНЫЕ цвета, а не только имя атрибута,
               и разные не в одном месте: и рамка выделения (CSS),
               и грунт канваса дорожки (edTheme — там CSS не читается,
               цвета кэшируются кодом, и они однажды отставали). */
        тема: __раздел('тема', () => {
          const T = window.THEME;
          if (!T) return { естьМодуль: false, вНорме: false };
          const studio = document.querySelector('.studio');
          const кольцо = () => getComputedStyle(studio).getPropertyValue('--sel-ring').trim();
          const кнопка = () => document.querySelector('.theme-switch .theme-btn');
          const пункты = () => [...document.querySelectorAll('.theme-switch .theme-item')];
          const открыт = () => кнопка().getAttribute('aria-expanded') === 'true';
          const исходная = T.тема();

          // ---- устройство переключателя ----
          const кнопок = document.querySelectorAll('.theme-switch .theme-btn').length;
          const названия = пункты().map((п) => п.textContent.trim());
          const отмечен = (пункты().find((п) => п.getAttribute('aria-checked') === 'true') || {}).dataset;
          const отмеченаНынешняя = !!отмечен && отмечен.theme === исходная;

          // ---- открыть, походить стрелкой, закрыть по Esc ----
          const былЗакрыт = !открыт();
          кнопка().click();
          const открылся = открыт();
          const фокусНаВыбранной = document.activeElement
            === пункты().find((п) => п.dataset.theme === исходная);
          document.activeElement.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
          const стрелкаВедёт = document.activeElement.classList.contains('theme-item')
            && document.activeElement.dataset.theme !== исходная;
          document.activeElement.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          const закрылсяПоEsc = !открыт();

          // ---- открыть и закрыть щелчком мимо ----
          кнопка().click();
          document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          const закрылсяМимо = !открыт();

          // ---- цвета всех трёх тем: рамка выделения и грунт канваса ----
          const цвета = {};
          T.ТЕМЫ.forEach((код) => {
            T.установить(код);
            цвета[код] = { кольцо: кольцо(), грунт: edTheme.ground, атрибут: document.documentElement.dataset.theme };
          });
          const кодов = T.ТЕМЫ.length;
          const атрибутыСвои = T.ТЕМЫ.every((код) => цвета[код].атрибут === код);
          const колец = new Set(T.ТЕМЫ.map((к) => цвета[к].кольцо)).size;
          const грунтов = new Set(T.ТЕМЫ.map((к) => цвета[к].грунт)).size;

          // ---- выбор пунктом списка применяется и переживает перезагрузку ----
          T.установить(T.ТЕМЫ[0]);
          кнопка().click();
          const пункт = пункты().find((п) => п.dataset.theme === 'steel');
          if (пункт) пункт.click();
          const пунктПрименился = document.documentElement.dataset.theme === 'steel'
            && T.тема() === 'steel';
          const сохранилась = (() => {
            try { return localStorage.getItem('karaoke-theme') === 'steel'; } catch (e) { return false; }
          })();
          // Значок на кнопке пошёл за темой, иначе он врал бы про выбранное
          const значокПошёлЗаТемой = кнопка().dataset.theme === 'steel';

          T.установить(исходная);   // вернуть тему как было до самопроверки
          return {
            кнопок, названия, отмеченаНынешняя,
            былЗакрыт, открылся, фокусНаВыбранной, стрелкаВедёт, закрылсяПоEsc, закрылсяМимо,
            цвета, пунктПрименился, сохранилась, значокПошёлЗаТемой,
            вНорме: кнопок === 1 && названия.length === кодов
              && названия.every((н) => н.length > 2) && отмеченаНынешняя
              && былЗакрыт && открылся && фокусНаВыбранной && стрелкаВедёт
              && закрылсяПоEsc && закрылсяМимо
              && атрибутыСвои && колец === кодов && грунтов === кодов
              && пунктПрименился && сохранилась && значокПошёлЗаТемой,
          };
        }),

        /* Минусовка нейросети не пережила перезапуск.

           Беда, на которую наступил человек: проект помнит огибающую
           голоса, но не звуковые дорожки. После перезапуска синяя
           полоса «голос» на дорожке на месте — а звучит встроенное
           приглушение, и вокал в нём слышен. Человек идёт в караоке,
           слышит оригинал и решает, что сломалась студия.

           Проверяем таблицу истинности целиком: предупреждение стоит
           РОВНО при «огибающая есть, минусовка встроенная» и молчит
           во всех трёх остальных случаях — в том числе когда вокал
           убрали в этом сеансе (тогда минусовка своя) и когда своя
           минусовка загружена файлом. Плюс тот же путь целиком:
           огибающая приезжает из памяти проекта через restoreVoiceTrack,
           как при открытии файла песни, — предупреждение появляется;
           загрузили свою минусовку — пропадает. */
        минусовкаПотеряна: __раздел('минусовкаПотеряна', () => {
          const узел = document.getElementById('voice-lost');
          const былиРуны = voice.runs;
          const былУровень = voice.level;
          const былаСвоя = state.customInst;
          const былоИмя = state.instName;
          try {
            if (!узел) return { узлаНет: true, вНорме: false };
            const снять = () => ({
              видно: !узел.classList.contains('hidden'),
              признак: потерянаМинусовкаНейросети(),
            });
            const поставить = (голос, своя) => {
              voice.runs = голос ? [{ start: 1, end: 2 }] : null;
              voice.level = голос ? new Uint8Array(4000) : null;
              state.customInst = своя;
              state.instName = своя ? 'минус.wav' : null;
              updateInstUI();
              return снять();
            };
            const нетГолоса = поставить(false, false);
            const голосБезСвоей = поставить(true, false);   // ← вот она, беда
            const голосИСвоя = поставить(true, true);       // убрал вокал в этом сеансе
            const свояБезГолоса = поставить(false, true);

            /* Тот же путь целиком: огибающая приезжает из памяти
               проекта (её кладёт туда saveProject, а достаёт при
               открытии файла песни restoreVoiceTrack), минусовка при
               этом посчитана встроенным приглушением. */
            поставить(false, false);
            const уровень = new Uint8Array(4000);          // 40 секунд по 100 отсчётов
            for (let i = 500; i < 1500; i++) уровень[i] = 200;   // где-то тут поют
            restoreVoiceTrack(voiceToText(уровень), 40);
            const изПамяти = { ...снять(), кусков: (voice.runs || []).length };
            // …а теперь человек загрузил свою минусовку файлом
            state.customInst = true;
            state.instName = 'минус.wav';
            updateInstUI();
            const послеСвоей = снять();

            const текст = узел.textContent.trim();
            const былЯзык = I18N.язык();
            I18N.установить(былЯзык === 'ru' ? 'en' : 'ru');
            const текстИначе = узел.textContent.trim();
            I18N.установить(былЯзык);

            return {
              нетГолоса, голосБезСвоей, голосИСвоя, свояБезГолоса,
              изПамяти, послеСвоей,
              длинаТекста: текст.length,
              вПервомШаге: !!узел.closest('#step-1'),
              вНорме: голосБезСвоей.видно && голосБезСвоей.признак
                && !нетГолоса.видно && !голосИСвоя.видно && !свояБезГолоса.видно
                && изПамяти.кусков > 0 && изПамяти.видно && !послеСвоей.видно
                && текст.length > 40 && текстИначе.length > 40 && текст !== текстИначе
                && !!узел.closest('#step-1'),
            };
          } finally {
            /* Своё возвращаем руками и перерисовываем: обёртка вернёт
               поля, но не позовёт updateInstUI — и предупреждение
               осталось бы висеть у соседнего раздела. */
            voice.runs = былиРуны;
            voice.level = былУровень;
            state.customInst = былаСвоя;
            state.instName = былоИмя;
            updateInstUI();
          }
        }),

        /* Разделитель просмотра и инспектора. То же, что и у разделителя
           окон и дорожки, только вбок: тянут мышью — инспектор шире,
           а просмотр рядом ровно на столько же уже; стрелки делают то же
           с клавиатуры; доля попадает в хранилище и оттуда её читает
           прочитатьДолюИнспектора, то есть выбор переживает перезагрузку;
           двойной щелчок возвращает умолчание. И граница не даёт
           инспектору съесть окна: снизу у него свой предел. */
        разделительИнспектора: __раздел('разделительИнспектора', () => {
          const былаДоля = доляИнспектора;
          const былиСтроки = state.lines;
          const былБуфер = state.originalBuffer;
          const былаДлина = audio.duration;
          const панель = document.getElementById('step-3');
          const былаАктивна = панель.classList.contains('active');
          try {
            const SR = 8000, dur = 30;
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            state.originalBuffer = ctx.createBuffer(1, SR * dur, SR);
            audio.duration = dur;
            state.lines = [1, 2, 3].map((n) => ({
              text: 'Строка ' + n, time: n * 5, end: null,
              ручнойКонец: false, сомнительная: false,
            }));
            document.querySelectorAll('.step-panel.active')
              .forEach((п) => п.classList.remove('active'));
            панель.classList.add('active');
            editor.peaks = null;
            доляИнспектора = ДОЛЯ_ИНСПЕКТОРА;
            openEditor();

            const узел = document.getElementById('ed-vsplitter');
            const инспектор = document.getElementById('sel-panel');
            const просмотр = document.querySelector('.ed-viewer');
            if (!узел) return { разделителяНет: true, вНорме: false };
            const снимок = () => ({ и: инспектор.offsetWidth, п: просмотр.offsetWidth });

            const до = снимок();
            const r = узел.getBoundingClientRect();
            const тянуть = (на) => {
              узел.dispatchEvent(new PointerEvent('pointerdown',
                { bubbles: true, pointerId: 1, clientX: r.left + 4 }));
              узел.dispatchEvent(new PointerEvent('pointermove',
                { bubbles: true, pointerId: 1, clientX: r.left + 4 - на }));
              узел.dispatchEvent(new PointerEvent('pointerup',
                { bubbles: true, pointerId: 1, clientX: r.left + 4 - на }));
            };
            тянуть(60);                       // влево: инспектор шире
            const шире = снимок();
            const сохранилась = (() => {
              try { return Math.abs(parseFloat(localStorage.getItem('karaoke-insp'))
                - доляИнспектора) < 0.01; } catch (e) { return false; }
            })();
            const переживётПерезагрузку = Math.abs(прочитатьДолюИнспектора() - доляИнспектора) < 0.01;
            тянуть(-60);                      // вправо: обратно
            const уже = снимок();

            узел.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
            const стрелкой = снимок();

            // Тянем далеко влево: окнам рядом всё равно остаётся своё
            тянуть(4000);
            const доУпора = снимок();

            узел.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            const послеДвойного = снимок();

            return {
              до, шире, уже, стрелкой, доУпора, послеДвойного,
              сохранилась, переживётПерезагрузку,
              вНорме: шире.и > до.и && шире.п < до.п
                && уже.и < шире.и && стрелкой.и > уже.и
                && сохранилась && переживётПерезагрузку
                && доУпора.и <= МАКС_ИНСПЕКТОРА
                && доУпора.п >= 120
                && Math.abs(послеДвойного.и - до.и) <= 1,
            };
          } finally {
            доляИнспектора = былаДоля;
            state.lines = былиСтроки;
            state.originalBuffer = былБуфер;
            audio.duration = былаДлина;
            editor.peaks = null;
            editor.sel = -1;
            editor.spansKey = '';
            if (!былаАктивна) панель.classList.remove('active');
            resizeTimeline();
          }
        }),

        /* Разделитель окон и дорожки. Проверяем не наличие полоски,
           а то, ради чего она стоит: тянут мышью — высота дорожки
           меняется, окна ужимаются ровно на столько же; стрелки делают
           то же с клавиатуры; доля попадает в хранилище и оттуда её
           читает прочитатьДолю, то есть выбор переживает перезагрузку;
           двойной щелчок возвращает умолчание. И граница не даёт
           дорожке съесть окна целиком: снизу у окон есть предел. */
        разделитель: __раздел('разделитель', () => {
          const былаДоля = доляДорожки;
          const былиСтроки = state.lines;
          const былБуфер = state.originalBuffer;
          const былаДлина = audio.duration;
          const панель = document.getElementById('step-3');
          const былаАктивна = панель.classList.contains('active');
          try {
            const SR = 8000, dur = 30;
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            state.originalBuffer = ctx.createBuffer(1, SR * dur, SR);
            audio.duration = dur;
            state.lines = [1, 2, 3].map((n) => ({
              text: 'Строка ' + n, time: n * 5, end: null,
              ручнойКонец: false, сомнительная: false,
            }));
            // Чужие шаги гасим: активными их бывает сразу несколько,
            // и тогда высоту студии они делят между собой (см. выше)
            document.querySelectorAll('.step-panel.active')
              .forEach((п) => п.classList.remove('active'));
            панель.classList.add('active');
            editor.peaks = null;
            доляДорожки = ДОЛЯ_ДОРОЖКИ;
            openEditor();

            const узел = document.getElementById('ed-splitter');
            const дорожка = document.querySelector('.timeline-wrap');
            const окна = document.querySelector('.editor-grid');
            if (!узел) return { разделителяНет: true, вНорме: false };
            const снимок = () => ({ д: дорожка.offsetHeight, о: окна.offsetHeight });

            const до = снимок();
            const r = узел.getBoundingClientRect();
            const тянуть = (на) => {
              узел.dispatchEvent(new PointerEvent('pointerdown',
                { bubbles: true, pointerId: 1, clientY: r.top + 4 }));
              узел.dispatchEvent(new PointerEvent('pointermove',
                { bubbles: true, pointerId: 1, clientY: r.top + 4 - на }));
              узел.dispatchEvent(new PointerEvent('pointerup',
                { bubbles: true, pointerId: 1, clientY: r.top + 4 - на }));
            };
            тянуть(40);                       // вверх: дорожка выше
            const вверх = снимок();
            const сохранилась = (() => {
              try { return Math.abs(parseFloat(localStorage.getItem('karaoke-split'))
                - доляДорожки) < 0.01; } catch (e) { return false; }
            })();
            const переживётПерезагрузку = Math.abs(прочитатьДолю() - доляДорожки) < 0.01;
            тянуть(-40);                      // вниз: обратно
            const вниз = снимок();

            узел.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
            const стрелкой = снимок();

            // Тянем далеко вверх: окнам всё равно остаётся своё
            тянуть(4000);
            const доУпора = снимок();

            узел.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            const послеДвойного = снимок();

            const сумма = (с) => с.д + с.о;
            return {
              до, вверх, вниз, стрелкой, доУпора, послеДвойного,
              сохранилась, переживётПерезагрузку,
              вНорме: вверх.д > до.д && вверх.о < до.о
                // Сумма не меняется: что взяла дорожка, то отдали окна
                && сумма(вверх) === сумма(до) && сумма(доУпора) === сумма(до)
                && вниз.д < вверх.д && стрелкой.д > вниз.д
                && сохранилась && переживётПерезагрузку
                && доУпора.о >= МИН_ОКОН && доУпора.д <= МАКС_ДОРОЖКИ
                && Math.abs(послеДвойного.д - до.д) <= 1,
            };
          } finally {
            доляДорожки = былаДоля;
            state.lines = былиСтроки;
            state.originalBuffer = былБуфер;
            audio.duration = былаДлина;
            editor.peaks = null;
            editor.sel = -1;
            editor.spansKey = '';
            if (!былаАктивна) панель.classList.remove('active');
            resizeTimeline();
          }
        })
      }))()`);
      /* Подсказки кнопок студии. Разом три вещи, которые ломались порознь.

         Первое: у КАЖДОЙ кнопки внутри #studio есть подсказка, и на
         обоих языках. Кнопок там семь десятков, половина — только со
         значком, и по разметке на глаз их не пересчитаешь: раздел
         обходит живую страницу и требует непустую подсказку у всех.
         Заодно требует, чтобы русская и английская РАЗЛИЧАЛИСЬ — забытый
         ключ в словаре виден только так: подсказка есть, но русская.

         Второе: подсказка своя, а не системная. Пока указатель на
         кнопке, title с неё СНЯТ (лежит в data-tip) — иначе поверх
         нашей через секунду вылезала бы системная; после щелчка
         атрибут обязан вернуться на место, иначе кнопка навсегда
         останется без подсказки для тех, кто читает её с экрана.

         Третье: место справки. Она стоит под дорожкой, перед кнопками
         шага, и развёрнутая НЕ выталкивает редактор за низ подложки
         студии — раньше выталкивала, и кнопки «← Текст» / «Караоке →»
         уезжали за край окна.

         Язык, открытость справки и активный шаг возвращаются в finally. */
      report.подсказки = await win.webContents.executeJavaScript(`__раздел('подсказки', async () => {
        const былЯзык = I18N.язык();
        const панели = [...document.querySelectorAll('.step-panel')];
        const былиАктивны = панели.map((п) => п.classList.contains('active'));
        const справка = document.getElementById('editor-hint');
        const былаОткрыта = справка.open;
        try {
          /* Своя подсказка вместо системной. Проверяем ПЕРВЫМ делом и
             дав странице отстояться: смена языка уходит в главный
             процесс пересобирать меню приложения, а пересборка меню
             роняет фокус окна — подсказка честно прячется, и проверка
             ловила бы не подсказку, а этот побочный эффект. */
          await new Promise((r) => setTimeout(r, 200));
          const кнопка = document.getElementById('tl-snap');
          кнопка.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
          const снялСразу = !кнопка.hasAttribute('title') && !!кнопка.dataset.tip;
          await new Promise((r) => setTimeout(r, 300));
          const всплывашка = document.querySelector('.tip');
          const видна = !!всплывашка && !всплывашка.classList.contains('hidden');
          const текст = видна ? всплывашка.textContent.trim() : '';
          const титулСнят = !кнопка.hasAttribute('title');
          const совпалСКнопкой = !!текст && текст === (кнопка.dataset.tip || '').trim();
          document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 40));
          const титулВернулся = кнопка.getAttribute('title') === текст;

          const собрать = () => {
            const м = {};
            document.querySelectorAll('#studio button').forEach((b, i) => {
              // Пока подсказка висит, title лежит в data-tip — берём оба
              м[b.id || ('кнопка' + i)] =
                (b.getAttribute('title') || b.dataset.tip || '').trim();
            });
            return м;
          };
          I18N.установить('ru');
          const ru = собрать();
          I18N.установить('en');
          const en = собрать();
          const имена = Object.keys(ru);
          const безПодсказки = имена.filter((k) => !ru[k] || !en[k]);
          const неПеревелись = имена.filter((k) => ru[k] && ru[k] === en[k]);
          I18N.установить('ru');

          /* Справка после дорожки и легенды, перед кнопками шага */
          const шаг = document.getElementById('step-3');
          const дети = [...шаг.children];
          const где = (s) => дети.indexOf(шаг.querySelector(':scope > ' + s));
          const поПорядку = где('.timeline-wrap') < дети.indexOf(справка)
            && где('.timeline-legend') < дети.indexOf(справка)
            && дети.indexOf(справка) < где('.panel-actions');

          /* Развёрнутая справка не выходит за низ подложки студии */
          панели.forEach((п) => п.classList.remove('active'));
          шаг.classList.add('active');
          справка.open = true;
          await new Promise((r) => setTimeout(r, 80));
          const низСтудии = document.querySelector('.studio').getBoundingClientRect().bottom;
          const низКнопок = шаг.querySelector(':scope > .panel-actions')
            .getBoundingClientRect().bottom;
          const выступ = Math.round(низКнопок - низСтудии);
          const своя = getComputedStyle(справка).overflowY === 'auto';
          const вШаге = Math.round(справка.getBoundingClientRect().height)
            <= Math.round(шаг.getBoundingClientRect().height);
          справка.open = false;
          await new Promise((r) => setTimeout(r, 80));
          const свёрнутая = Math.round(справка.getBoundingClientRect().height);

          return {
            кнопок: имена.length,
            безПодсказки, неПеревелись,
            снялСразу,
            видна, текст: текст.slice(0, 40), титулСнят, совпалСКнопкой, титулВернулся,
            поПорядку, выступ, своя, вШаге, свёрнутая,
            вНорме: имена.length > 40
              && безПодсказки.length === 0 && неПеревелись.length === 0
              && видна && титулСнят && совпалСКнопкой && титулВернулся
              && поПорядку && выступ <= 0 && своя && вШаге && свёрнутая < 48,
          };
        } finally {
          I18N.установить(былЯзык);
          справка.open = былаОткрыта;
          панели.forEach((п, i) => п.classList.toggle('active', былиАктивны[i]));
        }
      })`);

      /* Ползунок уровня у полосы дорожки — фейдер монтажной программы:
         желобок с внутренней тенью и крупная круглая ручка со скосом.

         Беда, ради которой раздел и заведён, — не в рисунке, а в весе
         селектора: правила «.tl-gain» однажды не применялись вовсе,
         потому что общее «input[type="range"]» весило больше. Поэтому
         проверять наличие правила в файле бессмысленно — надо знать,
         КАКОЕ из них выиграло на живой странице.

         Двумя способами, потому что одного не хватает.
           • Само поле ввода: его высоту getComputedStyle отдаёт
             честно. У нас 16 px, у общего правила 6 — если наш блок
             проиграл, это видно сразу.
           • Ручка: она псевдоэлемент, и Chrome вычисленных стилей
             для неё не отдаёт (возвращает стиль самого поля). Значит,
             каскад разбираем сами — по ЖИВЫМ таблицам стилей окна,
             а не по тексту файла: собираем все правила про ручку,
             чья основа подходит нашему полю, и складываем их в том
             порядке, в каком их сложил бы браузер. */
      report.ползунокУровня = await win.webContents.executeJavaScript(`__раздел('ползунокУровня', async () => {
        const былиСтроки = state.lines;
        const былБуфер = state.originalBuffer;
        const былМинус = state.instrumentalBuffer;
        const былаДлина = audio.duration;
        const панель = document.getElementById('step-3');
        const былаАктивна = панель.classList.contains('active');
        try {
          const SR = 8000, dur = 30;
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const buf = ctx.createBuffer(1, SR * dur, SR);
          state.originalBuffer = buf;
          state.instrumentalBuffer = buf;   // без минусовки ползунок выключен
          audio.duration = dur;
          state.lines = [
            { text: 'Раз строка', time: 2, end: null, ручнойКонец: false, сомнительная: false },
            { text: 'Два строка', time: 10, end: null, ручнойКонец: false, сомнительная: false },
          ];
          /* Чужие шаги гасим, а не просто включаем свой: активными
             они бывают сразу несколько (раздел включает свой и
             оставляет прежний), и тогда шаги делят высоту студии
             между собой — дорожка выходит втрое ниже настоящей,
             а ряды заголовков полос мерить бессмысленно. */
          document.querySelectorAll('.step-panel.active')
            .forEach((п) => п.classList.remove('active'));
          панель.classList.add('active');
          editor.peaks = null;
          openEditor();

          const ползунок = document.querySelector('input.tl-gain');
          if (!ползунок) return { ползункаНет: true, вНорме: false };
          const высотаПоля = Math.round(parseFloat(getComputedStyle(ползунок).height));

          /* Вес селектора: сколько в нём идентификаторов, классов
             (со скобками и псевдоклассами наравне) и тегов. Ровно
             по этому «.tl-gain» (0,1,0) и проигрывал общему
             «input[type="range"]» (0,1,1). */
          const вес = (сел) => {
            const и = (сел.match(/#[\\w-]+/g) || []).length;
            const к = (сел.match(/\\.[\\w-]+|\\[[^\\]]*\\]|:(?!:)[\\w-]+/g) || []).length;
            const т = (сел.match(/(^|[\\s>+~])[a-zA-Z][\\w-]*/g) || []).length;
            return и * 10000 + к * 100 + т;
          };
          const каскад = (эл, псевдо, свойства) => {
            const подходящие = [];
            let n = 0;
            for (const лист of document.styleSheets) {
              let правила;
              try { правила = лист.cssRules; } catch (e) { continue; }
              for (const п of правила) {
                n++;
                if (!п.selectorText || п.selectorText.indexOf(псевдо) < 0) continue;
                for (const кусок of п.selectorText.split(',')) {
                  const сел = кусок.trim();
                  if (сел.slice(-псевдо.length) !== псевдо) continue;
                  const база = сел.slice(0, -псевдо.length).trim();
                  let своё = false;
                  try { своё = !!база && эл.matches(база); } catch (e) { своё = false; }
                  if (своё) подходящие.push({ вес: вес(база), n, style: п.style, сел });
                }
              }
            }
            // Порядок браузера: сперва вес, при равном — кто позже в файле
            подходящие.sort((a, b) => (a.вес - b.вес) || (a.n - b.n));
            const итог = { правил: подходящие.length, победитель: '' };
            свойства.forEach((имя) => { итог[имя] = ''; });
            подходящие.forEach((п) => {
              свойства.forEach((имя) => {
                const v = п.style.getPropertyValue(имя);
                if (v) { итог[имя] = v.trim(); итог.победитель = п.сел; }
              });
            });
            return итог;
          };
          const свойства = ['width', 'height', 'background-image', 'box-shadow'];
          const ручка = каскад(ползунок, '::-webkit-slider-thumb', свойства);
          const желобок = каскад(ползунок, '::-webkit-slider-runnable-track',
            ['height', 'box-shadow']);

          /* Ветка Firefox (::-moz-range-thumb) каскадом здесь не
             проверяется и проверена быть не может: Chrome чужой
             псевдоэлемент не понимает и выбрасывает правило ещё при
             разборе — в document.styleSheets его просто нет. Поэтому
             про неё спрашиваем сам файл стилей: если ветку однажды
             удалят или забудут поправить вместе с webkit'овой, ползунок
             в Firefox молча вернётся к общему правилу, а заметить это
             в приложении на Chromium нечем. */
          const текстСтилей = await fetch('style.css').then((r) => r.text()).catch(() => '');
          const веткаFirefox = /input\\[type="range"\\]\\.tl-gain::-moz-range-thumb\\s*{[^}]*}/
            .exec(текстСтилей);
          const ручкаFF = веткаFirefox ? веткаFirefox[0].replace(/\\s+/g, ' ') : '';

          const размер = (v) => Math.round(parseFloat(v) || 0);
          /* Ручка обязана помещаться в самый низкий ряд, где она есть:
             ряды заголовков полос бывают от 18 px, и ручка в 20 px
             обрезалась бы рамкой колонки. */
          const ряды = [...document.querySelectorAll('.tl-head-row')]
            .filter((р) => р.querySelector('input.tl-gain'))
            .map((р) => Math.round(р.getBoundingClientRect().height));
          const самыйНизкий = ряды.length ? Math.min(...ряды) : 0;

          return {
            высотаПоля, ручка, ручкаFF, желобок, ряды,
            вНорме: высотаПоля === 16                       // выиграл наш блок, не общий
              && ручка.правил >= 2                          // общее правило тоже нашлось
              && ручка.победитель.indexOf('.tl-gain') >= 0  // и проиграло нашему
              && размер(ручка.width) === 14 && размер(ручка.height) === 14
              // Скос — градиент поверх цвета акцента; у общего правила его нет
              && ручка['background-image'].indexOf('gradient') >= 0
              // Ветка Firefox на месте и того же размера
              && ручкаFF.indexOf('14px') >= 0 && ручкаFF.indexOf('gradient') >= 0
              // Желобок с внутренней тенью, а не волосяная черта
              && размер(желобок.height) === 6
              && желобок['box-shadow'].indexOf('inset') >= 0
              && самыйНизкий >= 18 && размер(ручка.height) <= самыйНизкий,
          };
        } finally {
          state.lines = былиСтроки;
          state.originalBuffer = былБуфер;
          state.instrumentalBuffer = былМинус;
          audio.duration = былаДлина;
          editor.peaks = null;
          editor.sel = -1;
          editor.spansKey = '';
          if (!былаАктивна) панель.classList.remove('active');
        }
      })`);

      /* ---------- Высота дорожки на настоящих размерах окна ----------

         Жалоба была про ноутбук: «дорожка мелкая». Мерить её в
         развёрнутом окне (а самопроверка идёт именно в нём) значило бы
         мерить не то место, поэтому странице подставляется ровно
         1440×900, потом 1280×800 — те два размера, на которых студию
         и смотрят.

         Размер подставляем эмуляцией устройства, а не setContentSize:
         настоящее окно система обрезает по рабочей области (на этом
         маке 900 превращались в 838), и числа зависели бы от того, у
         кого какой монитор и где стоит панель задач. Эмуляция даёт
         ровно запрошенное на любой машине.

         На каждом размере проверяем три вещи:
           • дорожка выросла против прежних 122 px (жёсткие 16/18/38/30/20
             плюс коэффициент 0,8 на низком экране) и не расползлась
             выше МАКС_ДОРОЖКИ;
           • полосы поделили высоту целиком: сумма равна высоте канваса,
             и колонка заголовков ей ровня — иначе подписи разъезжаются
             с полосами;
           • ВСЕ ЧЕТЫРЕ ШАГА влезают в подложку студии целиком, а список
             строк остаётся прокручиваемым.

         Размер окна возвращаем в любом случае: развёрнутым оно и было. */
      report.высотаДорожки = await (async () => {
        const ПРЕЖНЯЯ = 122;   // столько полосы занимали до правки
        const замер = async (w, h) => {
          win.webContents.enableDeviceEmulation({
            screenPosition: 'desktop',
            screenSize: { width: w, height: h },
            viewSize: { width: w, height: h },
            viewPosition: { x: 0, y: 0 },
            deviceScaleFactor: 0,
            scale: 1,
          });
          await new Promise((r) => setTimeout(r, 350));
          return win.webContents.executeJavaScript(`__раздел('дорожка', () => {
            const былиСтроки = state.lines;
            const былБуфер = state.originalBuffer;
            const былМинус = state.instrumentalBuffer;
            const былаДлина = audio.duration;
            const панели = [...document.querySelectorAll('.step-panel')];
            const былиАктивны = панели.map((п) => п.classList.contains('active'));
            try {
              const SR = 8000, dur = 60;
              const ctx = new (window.AudioContext || window.webkitAudioContext)();
              const buf = ctx.createBuffer(1, SR * dur, SR);
              state.originalBuffer = buf;
              state.instrumentalBuffer = buf;
              audio.duration = dur;
              state.lines = [];
              for (let n = 0; n < 14; n++) {
                state.lines.push({ text: 'Строка номер ' + (n + 1), time: 2 + n * 4,
                  end: null, ручнойКонец: false, сомнительная: false });
              }
              панели.forEach((п) => п.classList.remove('active'));
              document.getElementById('step-3').classList.add('active');
              editor.peaks = null;
              openEditor();

              /* Меряем ДО обхода шагов: обход оставляет открытым
                 четвёртый, а у спрятанного шага все размеры нулевые. */
              const L = timelineLanes();
              const канвас = document.getElementById('timeline');
              const колонка = document.getElementById('tl-heads');
              const рядов = [...колонка.querySelectorAll('.tl-head-row')]
                .reduce((с, р) => с + Math.round(р.getBoundingClientRect().height), 0);
              const высотаКанваса = Math.round(канвас.getBoundingClientRect().height);
              const дорожка = document.querySelector('.timeline-wrap').offsetHeight;
              const окна = document.querySelector('.editor-grid').offsetHeight;
              const список = document.querySelector('.ed-lines .edit-list');
              const прокручивается = getComputedStyle(список).overflowY === 'auto';

              /* Все четыре шага целиком в подложке студии: показываем
                 каждый и смотрим, не вылез ли он за её низ. */
              const низСтудии = document.querySelector('.studio').getBoundingClientRect().bottom;
              const выступы = {};
              [1, 2, 3, 4].forEach((n) => {
                панели.forEach((п) => п.classList.remove('active'));
                const п = document.getElementById('step-' + n);
                п.classList.add('active');
                if (n === 3) resizeTimeline();
                выступы['шаг' + n] = Math.round(
                  п.getBoundingClientRect().bottom - низСтудии);
              });
              const самыйДлинный = Math.max(...Object.values(выступы));

              return {
                окно: [innerWidth, innerHeight],
                полос: L.total,
                высотаКанваса, колонка: рядов, дорожка, окна,
                полосы: Object.keys(L).filter((к) => к !== 'total')
                  .map((к) => к + ':' + L[к].h).join(' '),
                выступы, прокручивается,
                вНорме: L.total > ${ПРЕЖНЯЯ} * 1.25 && L.total <= МАКС_ДОРОЖКИ
                  && L.total === высотаКанваса && рядов === L.total
                  && окна >= МИН_ОКОН
                  && самыйДлинный <= 0 && прокручивается,
              };
            } finally {
              state.lines = былиСтроки;
              state.originalBuffer = былБуфер;
              state.instrumentalBuffer = былМинус;
              audio.duration = былаДлина;
              editor.peaks = null;
              editor.sel = -1;
              editor.spansKey = '';
              панели.forEach((п, i) => п.classList.toggle('active', былиАктивны[i]));
            }
          })`);
        };
        const на1440 = await замер(1440, 900);
        const на1280 = await замер(1280, 800);
        win.webContents.disableDeviceEmulation();
        await new Promise((r) => setTimeout(r, 350));
        await win.webContents.executeJavaScript(
          'document.getElementById("step-3").classList.contains("active") '
          + '? (resizeTimeline(), true) : true');
        // Размер обязан быть тем, который просили: иначе числа не о том
        const размерТот = на1440.окно[1] === 900 && на1280.окно[1] === 800
          && на1440.окно[0] === 1440 && на1280.окно[0] === 1280;
        return {
          было: ПРЕЖНЯЯ,
          'на1440x900': на1440,
          'на1280x800': на1280,
          размерТот,
          вНорме: размерТот && !!на1440.вНорме && !!на1280.вНорме,
        };
      })();

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

      /* Слышимая перемотка («скраб»): звук под указателем, пока его
         тащат. Беда, которую лечит: указатель переставлялся молча —
         человек вёл мышь и не слышал, где он, место в песне искали
         глазами по волне, отпускали, слушали, поправляли.

         Опасность здесь одна и она известна заранее: ЩЕЛЧКИ. Кусочек
         звука, начатый и оборванный как есть, даёт разрыв волны, и ухо
         слышит его громче музыки. Поэтому проверка не смотрит на
         кнопку, а СЧИТАЕТ: собирает два кусочка встык тем же кодом,
         каким они играют в колонки, отрисовывает в OfflineAudioContext
         и меряет наибольший скачок между соседними отсчётами на входе,
         на стыке и на выходе. Он обязан быть не больше того, что в этом
         же звуке есть и так. Синус берётся во весь голос и кусочки
         режутся ровно по его пику: без затухания кусочек начинался бы
         скачком на 0,8 — то есть проверка покраснела бы сразу.

         Заодно проверяется всё остальное, что обещано: во время
         обычного воспроизведения скраб молчит, выключатель выключает,
         узлы не копятся (порог не пускает второй кусочек, а доигравший
         убирает себя сам), и звучит скраб тем же, чем звучит песня —
         уровнями дорожек, а не всегда оригиналом.

         Живой путь гоняется на OfflineAudioContext, подставленном
         вместо audio.ctx: только так видно, что кусочек и правда
         доиграл и прибрал за собой. Всё подменённое возвращается
         в finally — следующие проверки мерят экран и хранилище. */
      report.скраб = await win.webContents.executeJavaScript(`__раздел('скраб', async () => {
        const былБуфер = state.originalBuffer;
        const былМинус = state.instrumentalBuffer;
        const былКонтекст = audio.ctx;
        const былаИграет = audio.playing;
        const былиУровни = { ...editor.mix };
        const былоСоло = editor.solo;
        const былаГалка = editor.hearVocal;
        const былоКольцо = editor.loop;
        const былВыключатель = editor.слышнаяПеремотка;
        const былиПики = editor.peaks;
        const былПроект = localStorage.getItem('karaoke-project');
        const панель = document.getElementById('step-3');
        const былаАктивна = панель.classList.contains('active');
        try {
          const SR = 44100;
          const ЧАСТОТА = 220;
          /* Четверть периода от целой секунды — самый пик синуса.
             Кусочек, взятый отсюда, без затухания начался бы скачком
             сразу на 0,8: ровно та беда, ради которой сделан конверт. */
          const четверть = 1 / (4 * ЧАСТОТА);
          const синус = (ctx, сек) => {
            const b = ctx.createBuffer(1, Math.round(SR * сек), SR);
            const d = b.getChannelData(0);
            for (let i = 0; i < d.length; i++) {
              d[i] = 0.8 * Math.sin(2 * Math.PI * ЧАСТОТА * i / SR);
            }
            return b;
          };

          панель.classList.add('active');
          editor.peaks = null;          // дорожку в этой проверке не рисуем
          editor.mix = { orig: 1, inst: 1 };
          editor.solo = null;
          editor.hearVocal = true;
          editor.loop = false;
          editor.слышнаяПеремотка = true;
          audio.playing = false;

          /* ---- Щелчки: два кусочка встык, отрисованные начисто ---- */
          const офф = new OfflineAudioContext(1, Math.round(SR * 0.25), SR);
          state.originalBuffer = синус(офф, 3);
          state.instrumentalBuffer = null;
          const усил = усиленияСейчас(нуженОригинал());
          const перв = собратьКусочекСкраба(офф, офф.destination, 1 + четверть, 0.02, усил);
          const втор = собратьКусочекСкраба(офф, офф.destination, 1.5 + четверть, перв.конец, усил);
          const рен = await офф.startRendering();
          const о = рен.getChannelData(0);
          const с = (t) => Math.round(t * SR);
          const скачок = (от, до) => {
            let m = 0;
            for (let k = Math.max(1, с(от)); k < Math.min(о.length, с(до)); k++) {
              const v = Math.abs(о[k] - о[k - 1]);
              if (v > m) m = v;
            }
            return +m.toFixed(4);
          };
          const пик = (от, до) => {
            let m = 0;
            for (let k = Math.max(0, с(от)); k < Math.min(о.length, с(до)); k++) {
              if (Math.abs(о[k]) > m) m = Math.abs(о[k]);
            }
            return +m.toFixed(4);
          };
          const кр = 0.004;   // пара миллисекунд с краёв, чтобы не срезать стык
          const скачокНаСтыке = Math.max(
            скачок(0.02 - кр, 0.02 + СКРАБ_ФЕЙД + кр),
            скачок(перв.конец - СКРАБ_ФЕЙД - кр, перв.конец + СКРАБ_ФЕЙД + кр),
            скачок(втор.конец - СКРАБ_ФЕЙД - кр, втор.конец + кр));
          // Для сравнения — что в этом же звуке творится вдали от краёв
          const скачокВЗвуке = скачок(0.02 + 0.015, перв.конец - 0.015);
          const звукЕсть = пик(0.02 + 0.015, перв.конец - 0.015);
          const тишинаДо = пик(0, 0.02 - кр);
          const тишинаПосле = пик(втор.конец + кр, 0.25);
          // Кусочки идут встык, а не внахлёст: наложения двух сигналов не бывает
          const встык = Math.abs((втор.конец - перв.конец) - СКРАБ_ЗЕРНО) < 1e-6;

          /* ---- Живой путь: порог движений и уборка узлов ---- */
          const офф2 = new OfflineAudioContext(1, Math.round(SR * 0.4), SR);
          state.originalBuffer = синус(офф2, 3);
          audio.ctx = офф2;
          скраб.куски.clear();
          скраб.конец = 0;
          let запущено = 0;
          // Тридцать движений мыши подряд — кусочек обязан пойти один
          for (let i = 0; i < 30; i++) if (скрабнуть(1 + i * 0.01)) запущено++;
          const живыхПослеСерии = скраб.живые;
          await офф2.startRendering();
          await new Promise((r) => setTimeout(r, 80));
          const живыхПослеИгры = скраб.живые;   // доигравший прибрал за собой

          /* ---- Когда скраб обязан молчать ---- */
          const офф3 = new OfflineAudioContext(1, Math.round(SR * 0.4), SR);
          state.originalBuffer = синус(офф3, 3);
          audio.ctx = офф3;
          скраб.куски.clear();
          скраб.конец = 0;

          audio.playing = true;
          const воВремяИгры = скрабнуть(1.2);   // и так слышно
          audio.playing = false;

          const кнопка = document.getElementById('tl-scrub');
          кнопка.click();                        // выключаем тем же путём, что человек
          скраб.конец = 0;
          const послеВыключения = скрабнуть(1.2);
          const кнопкаПогасла = !кнопка.classList.contains('on');
          кнопка.click();
          скраб.конец = 0;
          const послеВключения = скрабнуть(1.2);
          const кнопкаГорит = кнопка.classList.contains('on');
          скраб.куски.clear();
          скраб.конец = 0;

          панель.classList.remove('active');
          const внеРедактора = скрабнуть(1.2);   // монитор живёт только в редакторе
          панель.classList.add('active');

          /* ---- Звучит тем же, чем звучит песня ---- */
          const офф4 = new OfflineAudioContext(1, Math.round(SR * 0.2), SR);
          state.originalBuffer = синус(офф4, 3);
          state.instrumentalBuffer = синус(офф4, 3);
          editor.hearVocal = false;              // слушают один минус
          editor.mix = { orig: 0, inst: 1 };
          const уровниМинус = усиленияСейчас(нуженОригинал());
          const кМинус = собратьКусочекСкраба(офф4, офф4.destination, 1, 0.02, уровниМинус);
          const минусИсточник = кМинус.источники.length === 1
            && кМинус.источники[0].buffer === state.instrumentalBuffer;
          editor.solo = 'voice';                 // соло старше уровней
          const уровниСоло = усиленияСейчас(нуженОригинал());
          editor.solo = null;
          скраб.куски.clear();
          скраб.конец = 0;

          return {
            скачокНаСтыке, скачокВЗвуке, звукЕсть, тишинаДо, тишинаПосле, встык,
            зерноМс: +(СКРАБ_ЗЕРНО * 1000).toFixed(1),
            фейдМс: +(СКРАБ_ФЕЙД * 1000).toFixed(1),
            движений: 30, запущено, живыхПослеСерии, живыхПослеИгры,
            воВремяИгры: воВремяИгры === null,
            послеВыключения: послеВыключения === null,
            кнопкаПогасла, кнопкаГорит,
            послеВключения: послеВключения !== null,
            внеРедактора: внеРедактора === null,
            уровниМинус, уровниСоло, минусИсточник,
            вНорме: звукЕсть > 0.5                 // кусочек и правда звучит
              && тишинаДо < 1e-4 && тишинаПосле < 1e-4   // и только там, где велено
              && встык
              // Щелчков нет: переход не круче того, что в звуке и так есть
              && скачокНаСтыке <= скачокВЗвуке * 1.5
              // Узлы не копятся: тридцать движений — один кусочек
              && запущено === 1 && живыхПослеСерии <= СКРАБ_МАКС
              && живыхПослеИгры === 0
              && воВремяИгры === null && внеРедактора === null
              && послеВыключения === null && кнопкаПогасла
              && послеВключения !== null && кнопкаГорит
              // Слушают минус — скраб минусом и звучит
              && уровниМинус.вокал === 0 && уровниМинус.минусовка === 1
              && минусИсточник
              && уровниСоло.вокал === 1 && уровниСоло.минусовка === -1,
          };
        } finally {
          state.originalBuffer = былБуфер;
          state.instrumentalBuffer = былМинус;
          audio.ctx = былКонтекст;
          audio.playing = былаИграет;
          editor.mix = былиУровни;
          editor.solo = былоСоло;
          editor.hearVocal = былаГалка;
          editor.loop = былоКольцо;
          editor.peaks = былиПики;
          setScrub(былВыключатель);
          скраб.куски.clear();
          скраб.конец = 0;
          if (былПроект != null) localStorage.setItem('karaoke-project', былПроект);
          else localStorage.removeItem('karaoke-project');
          if (!былаАктивна) панель.classList.remove('active');
        }
      })`);

      /* Витрина сайта в приложении. Беда, которую это лечит:
         приложение показывало всю рекламную часть сайта — шапочное
         меню, кнопку «Открыть студию», геройский экран, карточки
         возможностей, вопросы и подвал. Человек прочитал это один раз,
         когда скачивал программу, а получал при каждом запуске, и до
         рабочего места приходилось прокручивать страницу.

         Проверяем три вещи разом. Первое: витрины не видно, заголовок
         «Студия» снят, а сама студия занимает окно целиком и страница
         не прокручивается. Второе: «Что нового» из подвала не пропала —
         она переехала в шапку (иначе список изменений стал бы
         недостижим). Третье, самое важное: ссылка «Как пользоваться»
         ведёт на раздел #how, который теперь спрятан, — значит, она
         обязана ОТКРЫВАТЬ его окном поверх студии, а Esc — закрывать.

         Окно в самопроверке не показано, поэтому меряем не пиксели
         экрана, а вычисленные стили и высоту студии относительно окна.
         Открытое руководство закрываем в finally. */
      report.витрина = await win.webContents.executeJavaScript(`__раздел('витрина', async () => {
        const былоОткрыто = document.body.classList.contains('guide-open');
        try {
          const вид = (сел) => {
            const el = document.querySelector(сел);
            return el ? getComputedStyle(el).display : 'нет';
          };
          const спрятаны = ['.hero', '.features', '.faq', '.site-footer', '.site-nav', '.how']
            .map((с) => [с, вид(с)]);
          const заголовокСнят = вид('.studio > h2') === 'none';
          const студия = document.querySelector('.studio').getBoundingClientRect();
          const шапка = document.querySelector('.site-header').getBoundingClientRect();
          // Студия занимает всё, что осталось от окна под шапкой
          const воВсёОкно = Math.abs(студия.height - (window.innerHeight - шапка.height)) <= 2;
          const прокрутка = document.documentElement.scrollHeight - window.innerHeight;
          // «Что нового» переехала из подвала в шапку — иначе была бы недостижима
          const новости = document.getElementById('btn-whatsnew');
          const новостиВШапке = !!(новости && новости.closest('.site-header'));
          const новостиВидны = !!новости && getComputedStyle(новости).display !== 'none';

          /* «Как пользоваться»: раздел спрятан, значит ссылка обязана
             открывать его окном, а не вести в никуда */
          document.querySelector('.steps-help').click();
          await new Promise((r) => setTimeout(r, 60));
          const руководствоОткрылось = document.body.classList.contains('guide-open')
            && вид('.how') !== 'none';
          const крестикВиден = вид('#how-close') !== 'none';
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await new Promise((r) => setTimeout(r, 60));
          const руководствоЗакрылось = !document.body.classList.contains('guide-open')
            && вид('.how') === 'none';

          return {
            спрятаны, заголовокСнят, воВсёОкно, прокрутка,
            высотаСтудии: Math.round(студия.height),
            высотаОкна: window.innerHeight,
            новостиВШапке, новостиВидны,
            руководствоОткрылось, крестикВиден, руководствоЗакрылось,
            вНорме: спрятаны.every(([, d]) => d === 'none')
              && заголовокСнят && воВсёОкно && прокрутка <= 0
              && новостиВШапке && новостиВидны
              && руководствоОткрылось && крестикВиден && руководствоЗакрылось,
          };
        } finally {
          document.body.classList.toggle('guide-open', былоОткрыто);
        }
      })`);

      /* Поиск по строкам. Беда: в песне сорок-шестьдесят строк, и нужную
         ищут глазами долго. Опасность у фильтра ровно одна и известна
         заранее: он не должен ПЕРЕНУМЕРОВАТЬ песню и не должен сломать
         всё, что живёт по номерам строк, — выбор, клавиши, прокрутку за
         воспроизведением и правку текста. Поэтому проверяем не «поле
         есть», а именно это: номера у оставшихся рядов настоящие,
         editor.sel по-прежнему указывает на ту же строку, поле текста
         правится, а Esc и пустое поле возвращают весь список.

         Строки подставляем свои, в finally возвращаем прежние. */
      report.поискСтрок = await win.webContents.executeJavaScript(`__раздел('поискСтрок', async () => {
        const былиСтроки = state.lines;
        const былВыбор = editor.sel;
        const былПоиск = editor.поиск;
        const былПроект = localStorage.getItem('karaoke-project');
        const панель = document.getElementById('step-3');
        const былаАктивна = панель.classList.contains('active');
        try {
          панель.classList.add('active');
          state.lines = [
            { text: 'Ёлка в лесу', time: 1, end: 2 },
            { text: 'Синее море', time: 3, end: 4 },
            { text: 'ЕЛКА большая', time: 5, end: 6 },
            { text: 'Белый снег', time: 7, end: 8 },
            { text: 'Ёлки-палки', time: 9, end: 10 },
          ];
          editor.sel = 2;
          // Список строим заново: строки мы только что подменили
          поставитьПоиск('');
          renderEditList();
          const всегоДо = document.querySelectorAll('.edit-row').length;

          // Регистр и «ё» не важны: набрано «елк», найтись обязаны три
          поставитьПоиск('елк');
          const ряды = [...document.querySelectorAll('.edit-row')];
          const номера = ряды.map((r) => r.querySelector('.num').textContent);
          const строки = ряды.map((r) => +r.dataset.row);
          // Номера настоящие: у третьей строки песни в списке стоит «3»
          const номераНастоящие = номера.join(',') === '1,3,5'
            && строки.join(',') === '0,2,4';
          // Выбор не сбился, и выбранная строка помечена в отфильтрованном списке
          const выборЦел = editor.sel === 2;
          const выбраннаяВидна = !!document.querySelector('.edit-row.selected-row[data-row="2"]');
          // Текст правится: поле осталось редактируемым
          const текстПравится = ряды.every((r) => r.querySelector('.edit-text').isContentEditable);
          // Прокрутка за воспроизведением не спотыкается о спрятанный ряд
          let прокруткаЖива = true;
          try { scrollEditListTo(1); scrollEditListTo(2); } catch (e) { прокруткаЖива = false; }
          // Клавиши работают: ↓ переводит выбор на следующую строку песни
          moveSelection(1);
          const клавишиРаботают = editor.sel === 3;
          editor.sel = 2;

          // Ничего не нашлось — вместо пустоты надпись
          поставитьПоиск('щщщ');
          const пустоНайдено = document.querySelectorAll('.edit-row').length;
          const надписьВидна = !document.getElementById('line-search-none')
            .classList.contains('hidden');

          // Esc очищает поле и возвращает все строки
          document.getElementById('line-search').value = 'елк';
          поставитьПоиск('елк');
          document.getElementById('line-search').dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await new Promise((r) => setTimeout(r, 40));
          const послеEsc = document.querySelectorAll('.edit-row').length;
          const полеПусто = document.getElementById('line-search').value === '';

          return {
            всегоДо, номера, строки, номераНастоящие, выборЦел, выбраннаяВидна,
            текстПравится, прокруткаЖива, клавишиРаботают,
            пустоНайдено, надписьВидна, послеEsc, полеПусто,
            вНорме: всегоДо === 5 && ряды.length === 3 && номераНастоящие
              && выборЦел && выбраннаяВидна && текстПравится && прокруткаЖива
              && клавишиРаботают && пустоНайдено === 0 && надписьВидна
              && послеEsc === 5 && полеПусто,
          };
        } finally {
          поставитьПоиск('');
          document.getElementById('line-search').value = былПоиск;
          state.lines = былиСтроки;
          editor.sel = былВыбор;
          renderEditList();
          if (былПроект != null) localStorage.setItem('karaoke-project', былПроект);
          else localStorage.removeItem('karaoke-project');
          if (!былаАктивна) панель.classList.remove('active');
        }
      })`);

      /* Скиммирование: звук под курсором при ПРОСТОМ НАВЕДЕНИИ, без
         нажатия, — так место в записи ищут в монтажных программах.
         Движок тот же, что у слышимой перемотки, и выключатель тот же.

         Опасность известна заранее: наведение сыплет событиями заметно
         чаще перетаскивания. Поэтому проверка считает: сотня движений
         подряд обязана дать РОВНО ОДИН кусочек (защёлка по часам плюс
         порог самого скраба), указатель воспроизведения при этом не
         должен сдвинуться ни на йоту, во время обычного воспроизведения
         скиммирование обязано молчать, выключенная слышимая перемотка —
         выключать и его, а контекста, которого ещё нет, наведение не
         должно поднимать вовсе.

         Контекст подменяем на OfflineAudioContext, всё подменённое
         возвращаем в finally. */
      report.скиммирование = await win.webContents.executeJavaScript(`__раздел('скиммирование', async () => {
        const былБуфер = state.originalBuffer;
        const былМинус = state.instrumentalBuffer;
        const былКонтекст = audio.ctx;
        const былаИграет = audio.playing;
        const былоСмещение = audio.offset;
        const былВыключатель = editor.слышнаяПеремотка;
        const былиПики = editor.peaks;
        const былоСоло = editor.solo;
        const панель = document.getElementById('step-3');
        const былаАктивна = панель.classList.contains('active');
        try {
          const SR = 44100;
          const синус = (ctx, сек) => {
            const b = ctx.createBuffer(1, Math.round(SR * сек), SR);
            const d = b.getChannelData(0);
            for (let i = 0; i < d.length; i++) d[i] = 0.8 * Math.sin(2 * Math.PI * 220 * i / SR);
            return b;
          };
          панель.classList.add('active');
          editor.peaks = null;
          editor.solo = null;
          editor.слышнаяПеремотка = true;
          audio.playing = false;
          audio.offset = 7.25;

          /* Контекста ещё нет — наведение его не поднимает: звук должен
             начинаться с действия человека, а не с проезда мышью */
          audio.ctx = null;
          скраб.куски.clear();
          скраб.конец = 0;
          const безКонтекста = скиммировать(1.2);

          const офф = new OfflineAudioContext(1, Math.round(SR * 0.5), SR);
          state.originalBuffer = синус(офф, 3);
          state.instrumentalBuffer = null;
          audio.ctx = офф;
          скраб.куски.clear();
          скраб.конец = 0;

          // Сотня движений мыши подряд — кусочек обязан пойти один
          let запущено = 0;
          for (let i = 0; i < 100; i++) if (скиммировать(1 + i * 0.005)) запущено++;
          const живых = скраб.живые;
          const указательНеПоехал = audio.offset === 7.25;

          // Играет обычным ходом — скиммирование молчит: и так слышно
          скраб.куски.clear();
          скраб.конец = 0;
          audio.playing = true;
          const воВремяИгры = скиммировать(2.2);
          audio.playing = false;

          /* Выключатель у скиммирования и слышимой перемотки один:
             плодить второй орган управления об одном и том же нельзя */
          const кнопка = document.getElementById('tl-scrub');
          кнопка.click();
          скраб.конец = 0;
          const послеВыключения = скиммировать(2.3);
          кнопка.click();
          скраб.конец = 0;
          await new Promise((r) => setTimeout(r, 60));
          const послеВключения = скиммировать(2.4);

          скраб.куски.clear();
          скраб.конец = 0;
          return {
            безКонтекста: безКонтекста === null,
            движений: 100, запущено, живых,
            указательНеПоехал,
            паузаМс: СКИММ_ПАУЗА,
            воВремяИгры: воВремяИгры === null,
            послеВыключения: послеВыключения === null,
            послеВключения: послеВключения !== null,
            вНорме: безКонтекста === null && запущено === 1 && живых <= СКРАБ_МАКС
              && указательНеПоехал && воВремяИгры === null
              && послеВыключения === null && послеВключения !== null,
          };
        } finally {
          state.originalBuffer = былБуфер;
          state.instrumentalBuffer = былМинус;
          audio.ctx = былКонтекст;
          audio.playing = былаИграет;
          audio.offset = былоСмещение;
          editor.peaks = былиПики;
          editor.solo = былоСоло;
          setScrub(былВыключатель);
          скраб.куски.clear();
          скраб.конец = 0;
          if (!былаАктивна) панель.classList.remove('active');
        }
      })`);

      /* Сворачивание разделов инспектора и его плотность.

         Беда: столбец на ноутбуке не помещался в окно целиком
         и прокручивался, а числа в нём сверяют глазами. Лечится
         с двух сторон, и проверяются обе.

         Первая — сворачивание разделов: смысл его в том, что та же
         информация занимает вдвое меньшую высоту, поэтому проверяем
         именно ВЫСОТУ. И память: что свёрнуто, должно пережить
         перезагрузку — то есть лежать в localStorage и
         восстанавливаться ИНСПЕКТОР.применить(), а не только жить
         в открытом окне.

         Вторая — пустой раздел «Слово». Пока слово не выбрано, он
         показывал «не выбрано» и четыре пустых поля: место занимал
         всегда, а говорил только когда выбор есть. Теперь его нет
         вовсе, и это тоже проверяется высотой — без выбора инспектор
         обязан быть заметно ниже, чем с выбранным словом.

         Раскрытость разделов, признак пустоты и ключ хранилища
         возвращаем в finally. */
      report.инспектор = await win.webContents.executeJavaScript(`__раздел('инспектор', async () => {
        const слово = document.getElementById('insp-word');
        const строка = document.getElementById('insp-line');
        const панельСлова = document.getElementById('word-panel');
        const былоСлово = слово.open;
        const былаСтрока = строка.open;
        const былаПустота = панельСлова.classList.contains('empty');
        const былоХранилище = localStorage.getItem('karaoke-inspector');
        const панель = document.getElementById('step-3');
        const былаАктивна = панель.classList.contains('active');
        const тело = () => Math.round(
          document.querySelector('#sel-panel .ed-pane-body').scrollHeight);
        try {
          панель.classList.add('active');
          слово.open = true;
          строка.open = true;

          /* Слово не выбрано — раздела «Слово» нет вовсе. Признак тот
             же, которым он и так приглушался (класс empty у #word-panel,
             его ставит updateWordInfo), поэтому подставляем именно его,
             а не выдумываем второй. */
          панельСлова.classList.add('empty');
          await new Promise((r) => setTimeout(r, 60));
          const высотаБезВыбора = тело();
          const словоСпрятано = getComputedStyle(слово).display === 'none';
          // Черты над «Строкой» быть не должно: вешать её не на что
          const чертаНадСтрокой = getComputedStyle(строка).borderTopWidth;

          панельСлова.classList.remove('empty');
          await new Promise((r) => setTimeout(r, 60));
          const высотаОткрытых = тело();

          // Сворачиваем «Слово» — и оно обязано записаться в хранилище
          слово.open = false;
          await new Promise((r) => setTimeout(r, 60));
          const высотаБезСлова = тело();
          const записалось = (() => {
            try { return JSON.parse(localStorage.getItem('karaoke-inspector'))['insp-word'] === false; }
            catch (e) { return false; }
          })();

          /* Перезагрузку изображаем честно: ставим оба раздела как при
             первом открытии страницы и просим ИНСПЕКТОР применить
             сохранённое — ровно это он делает при запуске */
          слово.open = true;
          строка.open = true;
          ИНСПЕКТОР.применить();
          const пережило = слово.open === false && строка.open === true;

          // Треугольник у заголовка есть, и он поворачивается
          const до = getComputedStyle(строка.querySelector('summary'), '::before').transform;
          строка.open = false;
          await new Promise((r) => setTimeout(r, 220));
          const после = getComputedStyle(строка.querySelector('summary'), '::before').transform;
          const высотаБезОбоих = тело();

          return {
            высотаБезВыбора, высотаОткрытых, высотаБезСлова, высотаБезОбоих,
            словоСпрятано, чертаНадСтрокой,
            записалось, пережило, треугольникДо: до, треугольникПосле: после,
            вНорме: высотаОткрытых > 0
              && высотаБезСлова < высотаОткрытых
              && высотаБезОбоих * 2 <= высотаОткрытых   // вдвое меньшей высотой
              // Без выбранного слова инспектор заметно ниже: пустой
              // раздел «Слово» занимал полторы сотни пикселей, и они
              // обязаны вернуться разделу «Строка»
              && словоСпрятано && высотаОткрытых - высотаБезВыбора >= 100
              && чертаНадСтрокой === '0px'
              && записалось && пережило && до !== после,
          };
        } finally {
          if (былоХранилище != null) localStorage.setItem('karaoke-inspector', былоХранилище);
          else localStorage.removeItem('karaoke-inspector');
          слово.open = былоСлово;
          строка.open = былаСтрока;
          панельСлова.classList.toggle('empty', былаПустота);
          if (!былаАктивна) панель.classList.remove('active');
        }
      })`);

      /* Зелёного в чужих темах не осталось.

         Беда была ровно такая: главную кнопку шага, подсветку активного
         шага с его кружком и текущую строку списка перекрасили адресно
         и только для стальной темы, а нейтральная осталась с зелёным —
         хотя акцент у неё свой, жёлтый. Мест таких на деле было не
         четыре, а полтора десятка, и адресный список их всех рано или
         поздно отстал бы снова. Теперь цвет берётся из переменных,
         а этот раздел стережёт итог.

         Смотрим ВЫЧИСЛЕННЫЙ цвет, а не текст CSS: только он говорит,
         что именно увидит человек. Две тонкости.

         Первая: у .step-tab стоит transition: all — сразу после смены
         темы вычисленный цвет ещё едет от прежнего, и прочитать его
         значило бы прочитать предыдущую тему. Поэтому ждём дольше
         перехода.

         Вторая: «зелёный» определяем числами, а не сравнением строк:
         зелёная составляющая заметно выше красной и синей. Так признак
         не привязан к тому, какой именно зелёный там стоял. */
      report.темаБезЗелёного = await win.webContents.executeJavaScript(`__раздел('темаБезЗелёного', async () => {
        const T = window.THEME;
        if (!T) return { естьМодуль: false, вНорме: false };
        const исходная = T.тема();
        const строки = document.getElementById('edit-list');
        const своя = !строки.children.length;
        try {
          /* Текущая строка списка — её подсветка и есть одно из мест.
             Если списка нет (песню не открывали), подставляем один ряд:
             красит его CSS, а не разметка, и для замера этого хватает. */
          if (своя) {
            const ряд = document.createElement('li');
            ряд.className = 'edit-row current-row';
            строки.appendChild(ряд);
          } else {
            строки.children[0].classList.add('current-row');
          }
          const ряд = строки.querySelector('.current-row');
          const кнопка = document.querySelector('#studio .btn-primary');
          const шаг = document.querySelector('.step-tab.active');
          const кружок = шаг && шаг.querySelector('span');

          /* Зелёный ли это. Числа берём из любого цветового написания —
             rgb(), rgba() и градиента: нам нужна первая тройка. */
          const зелёный = (цвет) => {
            const m = String(цвет).match(/(\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/);
            if (!m) return false;
            const r = +m[1], g = +m[2], b = +m[3];
            return g > r + 18 && g > b + 18;
          };
          const снять = () => {
            const c = (эл, св) => (эл ? getComputedStyle(эл)[св] : '');
            return {
              кнопка: c(кнопка, 'backgroundImage'),
              кнопкаТень: c(кнопка, 'boxShadow'),
              шагФон: c(шаг, 'backgroundColor'),
              шагРамка: c(шаг, 'borderTopColor'),
              кружок: c(кружок, 'backgroundImage'),
              строка: c(ряд, 'backgroundColor'),
            };
          };

          const цвета = {};
          for (const код of T.ТЕМЫ) {
            T.установить(код);
            // Дольше перехода (transition: all 0.15s у .step-tab)
            await new Promise((r) => setTimeout(r, 320));
            const снимок = снять();
            цвета[код] = {
              зелёного: Object.keys(снимок).filter((к) => зелёный(снимок[к])),
              шагФон: снимок.шагФон,
              строка: снимок.строка,
              кнопкаТень: снимок.кнопкаТень.slice(0, 30),
            };
          }
          T.установить(исходная);
          await new Promise((r) => setTimeout(r, 320));

          /* Фирменная тема зелёная нарочно — там зелёный и обязан быть
             во всех шести местах сразу. В двух других его нет ни в одном. */
          const фирменнаяЗелёная = цвета.signature.зелёного.length === 6;
          const чужихЗелёных = цвета.neutral.зелёного.length + цвета.steel.зелёного.length;
          return {
            цвета, фирменнаяЗелёная, чужихЗелёных,
            вНорме: фирменнаяЗелёная && чужихЗелёных === 0
              && T.тема() === исходная,
          };
        } finally {
          if (своя) {
            const ряд = строки.querySelector('.current-row');
            if (ряд) ряд.remove();
          } else {
            строки.children[0].classList.remove('current-row');
          }
          if (T.тема() !== исходная) T.установить(исходная);
        }
      })`);

      /* Сетка долей: оценка темпа и притягивание к долям.

         Опасность здесь названа заранее автором задачи: НЕВЕРНО
         ОПРЕДЕЛЁННЫЙ ТЕМП. Он хуже, чем никакого: тащит границы туда,
         где их быть не должно, и портит уже проверенную руками
         разметку. Поэтому проверка не смотрит на кнопку, а СЧИТАЕТ:
         собирает заведомый ритм — щелчки ровно через известный
         промежуток — и требует от оценки именно этот темп и именно
         эту фазу.

         Частоту берём 22 000: при ней кадр огибающей ровно 1/200 с,
         и щелчки 120 и 60 ударов в минуту ложатся ровно в кадры. Это
         нарочно: так удвоение и половинение НЕ РАЗЛИЧИМЫ в принципе,
         и признак «двойственный» обязан это признать, а не выбрать
         одно из двух молча. У 60 ударов такого соперника нет (120 их
         не объясняет вовсе) — там признак обязан молчать.

         Дальше — само притягивание: выключенная сетка не притягивает
         вовсе, включённая притягивает, а доля проигрывает и строке,
         и указателю (она самая слабая порода точек). И сохранение:
         поправленный руками темп обязан пережить проект.

         Всё тронутое возвращается в finally, включая ключ
         karaoke-project: следующие разделы мерят экран и хранилище. */
      report.сеткаДолей = await win.webContents.executeJavaScript(`__раздел('сеткаДолей', async () => {
        const былиСтроки = state.lines;
        const былБуфер = state.originalBuffer;
        const былМинус = state.instrumentalBuffer;
        const былаДлина = audio.duration;
        const былаИграет = audio.playing;
        const былоСмещение = audio.offset;
        const былаСетка = state.сетка;
        const былТемп = editor.темпАвто;
        const былИсточник = editor.темпИсточник;
        const былSnap = editor.snap;
        const былаБезМагнита = editor.безМагнита;
        const былМасштаб = editor.pxPerSec;
        const былаПрокрутка = editor.scrollT;
        const былиПики = editor.peaks;
        const былПроект = localStorage.getItem('karaoke-project');
        const панель = document.getElementById('step-3');
        const былаАктивна = панель.classList.contains('active');
        try {
          панель.classList.add('active');
          editor.peaks = null;   // дорожку в этой проверке не рисуем
          const SR = 22000;      // кадр огибающей ровно 1/200 с
          const СЕК = 40;
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          /* Щелчок — затухающий синус в 20 мс: у него резкое начало,
             то самое, которое ловит поток начал */
          const щелчки = (период, фаза) => {
            const b = ctx.createBuffer(1, Math.round(SR * СЕК), SR);
            const d = b.getChannelData(0);
            const длина = Math.round(0.02 * SR);
            for (let t = фаза; t < СЕК; t += период) {
              const s0 = Math.round(t * SR);
              for (let j = 0; j < длина && s0 + j < d.length; j++) {
                d[s0 + j] += 0.8 * Math.exp(-j / (0.004 * SR))
                  * Math.sin(2 * Math.PI * 1500 * j / SR);
              }
            }
            return b;
          };

          const темп120 = оценитьТемп(щелчки(0.5, 0.1));
          const темп60 = оценитьТемп(щелчки(1.0, 0.2));
          const темп90 = оценитьТемп(щелчки(60 / 90, 0.33));
          const тишина = оценитьТемп(ctx.createBuffer(1, Math.round(SR * 20), SR));

          /* ---- Честна ли шкала уверенности ----

             Уверенность обязана быть мерой, а не украшением: высоко на
             чётком ритме, средне на настоящей музыке, низко на шуме и
             ничего на тишине. Настоящей музыки у самопроверки нет,
             зато есть два синтетических края — и они же сторожат
             главное в счётчике темпа.

             ПЕРЕКЛИЧКА — материал, на котором прежний счётчик по
             громкости слеп, а спектральный поток видит всё. Две шумовые
             полосы (400–700 и 900–1200 Гц) меняются местами каждые
             0,6 с плавным перекрёстным переходом равной мощности.
             Общая громкость при этом гуляет случайно и про долю не
             говорит ничего — ровно как на плотном сведении; меняется
             только СПЕКТР. Обе полосы лежат внутри одной полосы
             прежнего трёхполосного разбора, так что и он тут беспомощен.

             Замерено: спектральный поток даёт 100,0 удара при истинных
             ста, фазу 0,110 при истинных 0,1 и уверенность 100 %.
             Верни широкополосную огибающую — выйдет 103,1 и 6 %;
             убери логарифмическое сжатие полос — фаза уедет на 0,140.
             Оба признака внизу от этого краснеют.

             Частоты и фазы берёт свой генератор псевдослучайных чисел
             (Лемера): нужен один и тот же материал от прогона к
             прогону, иначе пороги плавали бы. */
          const перекличка = () => {
            const ЧС = 11025, СК = 30, ПЕР = 0.6, N = 24, ПЕРЕХОД = 0.03;
            let сем = 20250830 % 2147483647;
            const рнд = () => (сем = (сем * 16807) % 2147483647) / 2147483647;
            const n = Math.round(ЧС * СК);
            const b = ctx.createBuffer(1, n, ЧС);
            const d = b.getChannelData(0);
            const набор = (низ, верх) => {
              const a = [];
              for (let i = 0; i < N; i++) a.push([низ + рнд() * (верх - низ), рнд() * 2 * Math.PI]);
              return a;
            };
            const A = набор(400, 700);
            const B = набор(900, 1200);
            const ша = new Float32Array(n);
            const шб = new Float32Array(n);
            for (const fp of A) { const w = 2 * Math.PI * fp[0] / ЧС; for (let i = 0; i < n; i++) ша[i] += Math.sin(w * i + fp[1]); }
            for (const fp of B) { const w = 2 * Math.PI * fp[0] / ЧС; for (let i = 0; i < n; i++) шб[i] += Math.sin(w * i + fp[1]); }
            const к = 0.35 / Math.sqrt(N / 2);
            for (let i = 0; i < n; i++) {
              const t = i / ЧС;
              const ф = (t - 0.1) / ПЕР;
              const ц = Math.floor(ф);
              const см = Math.min(1, (ф - ц) * ПЕР / ПЕРЕХОД);
              const a = ((ц % 2 + 2) % 2 === 0) ? см : 1 - см;
              d[i] = к * (Math.sqrt(a) * ша[i] + Math.sqrt(1 - a) * шб[i]);
            }
            return b;
          };
          // Белый шум: ритма в нём нет вовсе, и уверенность обязана это признать
          const белыйШум = () => {
            let сем = 4242424 % 2147483647;
            const b = ctx.createBuffer(1, Math.round(SR * 30), SR);
            const d = b.getChannelData(0);
            for (let i = 0; i < d.length; i++) {
              d[i] = ((сем = (сем * 16807) % 2147483647) / 2147483647) * 0.6 - 0.3;
            }
            return b;
          };
          const темпПерекличка = оценитьТемп(перекличка());
          const темпШум = оценитьТемп(белыйШум());

          /* ---- Притягивание к долям ---- */
          state.originalBuffer = ctx.createBuffer(1, SR * 30, SR);
          state.instrumentalBuffer = null;
          audio.duration = 30;
          audio.playing = false;
          audio.offset = 0;
          editor.pxPerSec = 40;
          editor.scrollT = 0;
          editor.snap = true;
          editor.безМагнита = false;
          editor.sel = -1;
          editor.wordSel = -1;
          editor.range = null;
          clearVoiceTrack();
          state.lines = [];      // строки добавим отдельно, когда дойдём до них
          editor.spansKey = '';

          // Доли при 120 ударах стоят через 0,5 с: 7,5 — ровно доля
          const вид = () => (editor.snapped ? editor.snapped.вид : null);
          state.сетка = { вкл: false, bpm: 120, фаза: 0, свой: false };
          const безСетки = +примагнитить(7.49).toFixed(4);
          const безСеткиВид = вид();

          state.сетка = { вкл: true, bpm: 120, фаза: 0, свой: false };
          const сСеткой = +примагнитить(7.49).toFixed(4);
          const сСеткойВид = вид();

          // Смещение первой доли сдвигает всю сетку
          state.сетка = { вкл: true, bpm: 120, фаза: 0.12, свой: true };
          const соСмещением = +примагнитить(7.61).toFixed(4);
          state.сетка = { вкл: true, bpm: 120, фаза: 0, свой: false };

          /* Доля — самая слабая порода: на равном расстоянии её
             обязаны перебить и строка, и указатель */
          state.lines = [{ text: 'раз', time: 7.5, end: null, ручнойКонец: false }];
          editor.spansKey = '';
          примагнитить(7.49);
          const противСтроки = вид();
          state.lines = [];
          editor.spansKey = '';
          audio.offset = 7.5;
          примагнитить(7.49);
          const противУказателя = вид();
          audio.offset = 0;

          /* ---- Выключатель ---- */
          state.сетка = { вкл: false, bpm: 120, фаза: 0, свой: false };
          обновитьСетку();
          const кнопка = document.getElementById('tl-grid');
          кнопка.click();
          const кнопкаВключила = state.сетка.вкл === true && кнопка.classList.contains('on');
          кнопка.click();
          const кнопкаВыключила = state.сетка.вкл === false && !кнопка.classList.contains('on');

          /* ---- Правка руками и сохранение ---- */
          const поле = document.getElementById('beat-bpm');
          поле.value = '137,5';
          поле.dispatchEvent(new Event('input'));
          поле.dispatchEvent(new Event('change'));
          const послеПоля = { bpm: state.сетка.bpm, свой: state.сетка.свой };
          state.сетка.вкл = true;
          state.сетка.фаза = 0.23;
          saveProject();
          const сохранено = сеткаИзПроекта(JSON.parse(localStorage.getItem('karaoke-project')));
          // Пересчёт темпа поправленное руками не перебивает
          editor.темпАвто = null;
          editor.темпИсточник = null;
          /* Счёт уехал в рабочий поток, поэтому ждём его здесь. Без
             ожидания ответ прилетел бы уже ПОСЛЕ раздела и переписал
             бы состояние живой студии — а раздел обязан за собой
             прибирать. */
          await посчитатьТемп();
          const послеПересчёта = { bpm: state.сетка.bpm, свой: state.сетка.свой };
          // Старый проект без ключа: умолчания, ничего не ломается
          const старый = сеткаИзПроекта({ lyrics: '' });

          /* ---- Включатель без темпа переживает перезагрузку ----
             Беда: признак «вкл» читался ТОЛЬКО внутри ветки с годным
             bpm. Включил сетку на записи, где темп не определился, —
             и после перезагрузки кнопка сама выключалась. */
          const безТемпа = сеткаИзПроекта({ grid: { on: true, bpm: null, manual: false, phase: 0 } });
          const сНегоднымТемпом = сеткаИзПроекта({ grid: { on: true, bpm: 9999, manual: true, phase: 0.4 } });
          const выключенная = сеткаИзПроекта({ grid: { on: false, bpm: 120, manual: true, phase: 0 } });

          /* ---- Поле темпа не залипает на отвергнутом числе ----
             Беда: набрал 9999, нажал Enter — поле краснеет (верно),
             а следом, не уводя фокус, двойным щелчком просишь вернуть
             найденное автоматом. Темп применяется, сетка рисуется
             по нему — а в поле по-прежнему красное 9999. Причина:
             применитьПолеСетки при отказе выходит, не сняв пометку
             «набирают», а обновитьСетку пока она стоит поле не трогает. */
          editor.темпАвто = { bpm: 128, фаза: 0.05, уверенность: 0.9, двойственный: false };
          editor.темпИсточник = 'оригинал';
          state.сетка = { вкл: true, bpm: 120, фаза: 0, свой: false };
          обновитьСетку(true);
          поле.focus();
          поле.value = '9999';
          поле.dispatchEvent(new Event('input'));
          поле.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          const послеОтказа = {
            вПоле: поле.value,
            красное: поле.classList.contains('bad'),
            bpm: state.сетка.bpm,
            набирают: поле.dataset.набирают === '1',
          };
          // Двойной щелчок по тому же полю — вернуть найденное автоматом
          поле.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          const послеСброса = {
            вПоле: поле.value,
            красное: поле.classList.contains('bad'),
            bpm: state.сетка.bpm,
            набирают: поле.dataset.набирают === '1',
          };
          // Число в поле и число, по которому рисуется сетка, — одно и то же
          const полеСовпадаетСДелом = Math.abs(
            (Number(String(послеСброса.вПоле).replace(',', '.')) || 0) - state.сетка.bpm) < 0.06;
          поле.blur();

          const бл = (a, b, окно) => Math.abs(a - b) <= окно;
          return {
            темп120, темп60, темп90, тишина: тишина === null,
            темпПерекличка, темпШум,
            безСетки, безСеткиВид, сСеткой, сСеткойВид, соСмещением,
            противСтроки, противУказателя,
            кнопкаВключила, кнопкаВыключила,
            послеПоля, сохранено, послеПересчёта, старый,
            безТемпа, сНегоднымТемпом, выключенная,
            послеОтказа, послеСброса, полеСовпадаетСДелом,
            вНорме: !!темп120 && !!темп60 && !!темп90
              // Темп угадан числом, а не «примерно»
              && бл(темп120.bpm, 120, 0.5) && бл(темп120.фаза, 0.1, 0.02)
              && бл(темп60.bpm, 60, 0.5) && бл(темп60.фаза, 0.2, 0.02)
              && бл(темп90.bpm, 90, 0.5) && бл(темп90.фаза, 0.33, 0.02)
              /* Ровные щелчки 120 одинаково хорошо объясняются
                 шестьюдесятью — признак обязан это признать */
              && темп120.двойственный === true && темп120.уверенность < 0.75
              // А у 60 такого соперника нет: 120 их не объясняет вовсе
              && темп60.двойственный === false && темп60.уверенность > 0.75
              && темп90.двойственный === false && темп90.уверенность > 0.8
              && тишина === null
              /* ШКАЛА УВЕРЕННОСТИ ЧЕСТНА. Перекличка спектра: темп и
                 фаза угаданы числом, уверенность под потолком (замерено
                 100,0 удара, фаза 0,110, уверенность 1,0). По
                 широкополосной огибающей тут выходит 103,1 и 0,06, без
                 логарифмического сжатия полос фаза уезжает на 0,140 —
                 любая из этих поломок красит признак. */
              && !!темпПерекличка
              && бл(темпПерекличка.bpm, 100, 0.5)
              && бл(темпПерекличка.фаза, 0.1, 0.02)
              && темпПерекличка.уверенность > 0.9
              // Белый шум: ритма нет, и шкала обязана это сказать (замерено 0,08)
              && !!темпШум && темпШум.уверенность < 0.25
              // Чёткий ритм заметно увереннее шума — иначе шкала ни о чём
              && темп90.уверенность > 3 * темпШум.уверенность
              // Выключенная сетка не делает ровно ничего
              && безСетки === 7.49 && безСеткиВид === null
              && сСеткой === 7.5 && сСеткойВид === 'доля'
              && соСмещением === 7.62
              // Доля проигрывает более важным целям
              && противСтроки === 'строка' && противУказателя === 'указатель'
              && кнопкаВключила && кнопкаВыключила
              // Поправленное руками переживает и сохранение, и пересчёт
              && послеПоля.bpm === 137.5 && послеПоля.свой === true
              && сохранено.bpm === 137.5 && сохранено.свой === true
              && сохранено.вкл === true && бл(сохранено.фаза, 0.23, 1e-9)
              && послеПересчёта.bpm === 137.5 && послеПересчёта.свой === true
              // Проект постарше про сетку не знает — и это ничего не ломает
              && старый.вкл === false && старый.bpm === null
              /* Включатель живёт отдельно от темпа: без темпа и с негодным
                 темпом он всё равно возвращается включённым, а выключенный
                 остаётся выключенным. Само число при этом не принимается. */
              && безТемпа.вкл === true && безТемпа.bpm === null
              && сНегоднымТемпом.вкл === true && сНегоднымТемпом.bpm === null
              && выключенная.вкл === false && выключенная.bpm === 120
              // Негодное число отвергнуто: поле краснеет, темп не тронут
              && послеОтказа.вПоле === '9999' && послеОтказа.красное === true
              && послеОтказа.bpm === 120 && послеОтказа.набирают === true
              /* А двойной щелчок ставит найденное автоматом — и поле
                 показывает именно его, без красной рамки и без залипшей
                 пометки «набирают» */
              && послеСброса.bpm === 128 && послеСброса.красное === false
              && послеСброса.набирают === false && полеСовпадаетСДелом
              && послеСброса.вПоле !== '9999',
          };
        } finally {
          state.lines = былиСтроки;
          state.originalBuffer = былБуфер;
          state.instrumentalBuffer = былМинус;
          state.сетка = былаСетка;
          audio.duration = былаДлина;
          audio.playing = былаИграет;
          audio.offset = былоСмещение;
          editor.темпАвто = былТемп;
          editor.темпИсточник = былИсточник;
          editor.snap = былSnap;
          editor.безМагнита = былаБезМагнита;
          editor.pxPerSec = былМасштаб;
          editor.scrollT = былаПрокрутка;
          editor.peaks = былиПики;
          editor.snapped = null;
          editor.sel = -1;
          editor.wordSel = -1;
          editor.spansKey = '';
          обновитьСетку();
          if (былПроект != null) localStorage.setItem('karaoke-project', былПроект);
          else localStorage.removeItem('karaoke-project');
          if (!былаАктивна) панель.classList.remove('active');
        }
      })`);


      /* Смена тональности: движок, кэш и вся арифметика вокруг него.

         Слуха у проверки нет, поэтому всё меряется числами.

         • ДЛИНА. Сдвинутый буфер обязан совпасть с исходным ОТСЧЁТ
           В ОТСЧЁТ — и оригинал, и минусовка. На времени держится вся
           разметка студии: строки, слова, огибающая голоса, сетка
           долей, отрезки оригинала. Уедь длина хоть на отсчёт — уедет
           всё, и заметит это только тот, кто запоёт мимо.

         • ВЫСОТА. Синус 220 Гц, поднятый на октаву, обязан читаться
           как 440, опущенный — как 110, а на ±2 полутона — как 246,9
           и 196,0. Частоту меряем автокорреляцией, тем же приёмом,
           каким оценитьТемп меряет темп, только вершину берём ПЕРВУЮ
           выше порога, а не самую высокую: у чистого тона лаг в два
           периода совпадает не хуже одного, и «самая высокая»
           промахивалась бы ровно на октаву.

         • СТЕРЕОКАРТИНА. Каналы обязаны править одинаково: минусовка
           сделана вычитанием середины, и рассогласованная правка
           вернула бы в неё вокал. Меряем корреляцию каналов до и после
           — разойтись она может не больше чем на 0,05.

         • ТИШИНА остаётся тишиной: в молчащем куске после сдвига не
           должно завестись звона.

         • НОЛЬ ПОЛУТОНОВ ничего не портит: возвращается ТОТ ЖЕ САМЫЙ
           буфер (сравнение по ссылке), а прогнанный через движок
           силой расходится с исходником неслышимо — число рядом.

         • КЭШ. Второй запрос той же тональности не считает заново:
           счётчик настоящих расчётов не двигается, а время — почти ноль.
           И смена песни этот кэш обнуляет.

         Всё тронутое возвращается в finally: следующие разделы мерят
         экран и звук. */
      report.тональность = await win.webContents.executeJavaScript(`__раздел('тональность', async () => {
        const былБуфер = state.originalBuffer;
        const былМинус = state.instrumentalBuffer;
        const былиЧистые = тон.чистые;
        const былКэш = new Map(тон.кэш);
        const былПорядок = тон.порядок.slice();
        const былиПолутона = тон.полутонов;
        const былоРасчётов = тон.расчётов;
        try {
          const SR = 44100;
          const N = Math.round(SR * 1.5);
          const пустой = new OfflineAudioContext(2, 1, SR);
          const стерео = (лев, прав) => {
            const b = пустой.createBuffer(2, N, SR);
            const L = b.getChannelData(0), R = b.getChannelData(1);
            for (let i = 0; i < N; i++) { L[i] = лев(i); R[i] = прав(i); }
            return b;
          };
          const синус = (f, a) => (i) => a * Math.sin(2 * Math.PI * f * i / SR);
          // Тон с обертонами: так звучит голос, и так вокодеру труднее
          const гарм = (f, a, ф) => (i) => {
            let s = 0;
            for (let h = 1; h <= 6; h++) s += (1 / h) * Math.sin(2 * Math.PI * f * h * i / SR + ф * h);
            return a * s;
          };
          const сумма = (...фф) => (i) => { let s = 0; for (const f of фф) s += f(i); return s; };

          const частота = (x) => {
            let ср = 0;
            for (let i = 0; i < x.length; i++) ср += x[i];
            ср /= x.length;
            let дисп = 0;
            const y = new Float64Array(x.length);
            for (let i = 0; i < x.length; i++) { y[i] = x[i] - ср; дисп += y[i] * y[i]; }
            дисп /= x.length;
            if (!(дисп > 1e-12)) return null;
            const лагМин = Math.max(2, Math.floor(SR / 2000));
            const лагМакс = Math.min(x.length - 2, Math.floor(SR / 50));
            const ак = new Float64Array(лагМакс + 2);
            for (let l = лагМин - 1; l <= лагМакс + 1; l++) {
              let s = 0;
              const n = y.length - l;
              for (let i = 0; i < n; i++) s += y[i] * y[i + l];
              ак[l] = (s / n) / дисп;
            }
            let макс = 0;
            for (let l = лагМин; l <= лагМакс; l++) if (ак[l] > макс) макс = ак[l];
            let л = -1;
            for (let l = лагМин; l <= лагМакс; l++) {
              if (ак[l] >= 0.85 * макс && ак[l] >= ак[l - 1] && ак[l] >= ак[l + 1]) { л = l; break; }
            }
            if (л < 0) return null;
            const a = ак[л - 1], b = ак[л], c = ак[л + 1];
            const зн = a - 2 * b + c;
            const δ = зн < 0 ? 0.5 * (a - c) / зн : 0;
            return SR / (л + δ);
          };
          const корр = (a, b) => {
            let xy = 0, xx = 0, yy = 0;
            for (let i = 4000; i < a.length - 4000; i++) { xy += a[i] * b[i]; xx += a[i] * a[i]; yy += b[i] * b[i]; }
            return xy / (Math.sqrt(xx * yy) || 1e-9);
          };
          const уровни = (x) => {
            let p = 0, s = 0;
            for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; s += x[i] * x[i]; }
            return { пик: +p.toFixed(4), скз: +Math.sqrt(s / x.length).toFixed(5) };
          };
          const дБ = (было, стало) => +(20 * Math.log10((стало || 1e-12) / (было || 1e-12))).toFixed(2);
          const отн = (стало, ждём) => +Math.abs(стало / ждём - 1).toFixed(5);

          /* Студия НЕ ПОДСТАВИТ буфер не той длины — сдвинутьБуфер
             ловит это и бросает. Признак обязан от такого краснеть,
             а не валить всю самопроверку: ловим сбой здесь и
             показываем его числом, как и всё остальное. */
          const сбои = [];
          const поставить = async (n) => {
            try { return await установитьТональность(n); }
            catch (e) { сбои.push(n + ': ' + ((e && e.message) || e)); return { ok: false, мс: 0 }; }
          };
          const движком = async (buf, n) => {
            try { return await сдвинутьБуфер(buf, n, null); }
            catch (e) { сбои.push('движок ' + n + ': ' + ((e && e.message) || e)); return null; }
          };

          /* ---- Длина и высота: обе дорожки ----
             Оригинал — 220 Гц, минусовка — 330: так видно, что сдвинуты
             обе и каждая на свои полутона, а не одна и та же дважды. */
          const тон220 = стерео(синус(220, 0.5), синус(220, 0.5));
          const тон330 = стерео(синус(330, 0.4), синус(330, 0.4));
          state.originalBuffer = тон220;
          state.instrumentalBuffer = тон330;
          сменилсяЗвук();
          const высоты = [];
          for (const n of [2, -2, 5, -5]) {
            const итог = await поставить(n);
            const о = state.originalBuffer, м = state.instrumentalBuffer;
            const ждёмО = 220 * Math.pow(2, n / 12);
            const ждёмМ = 330 * Math.pow(2, n / 12);
            const сталоО = частота(о.getChannelData(0));
            const сталоМ = частота(м.getChannelData(0));
            высоты.push({
              полутонов: n,
              длинаО: о.length, длинаМ: м.length,
              длиныЦелы: о.length === тон220.length && м.length === тон330.length,
              ждёмО: +ждёмО.toFixed(2), сталоО: +сталоО.toFixed(2), ошибкаО: отн(сталоО, ждёмО),
              ждёмМ: +ждёмМ.toFixed(2), сталоМ: +сталоМ.toFixed(2), ошибкаМ: отн(сталоМ, ждёмМ),
              мс: итог.мс,
            });
            await поставить(0);
          }

          /* ---- Октава: 220 Гц обязаны стать 440 и 110 ----
             Через сам движок, мимо установитьТональность: предел ±7
             полутонов — решение студии о том, что предлагать человеку
             (дальше плохо звучит любой алгоритм), а не граница
             возможностей вокодера. Октава — самая наглядная проверка
             того, что сдвиг и правда СДВИГ: ошибись он в разы или
             в знаке, это видно сразу. */
          const октавы = [];
          for (const n of [12, -12]) {
            const b = await движком(тон220, n);
            if (!b) { октавы.push({ полутонов: n, сбой: true, длинаЦела: false, ошибка: 1 }); continue; }
            const ждём = 220 * Math.pow(2, n / 12);
            const стало = частота(b.getChannelData(0));
            октавы.push({
              полутонов: n, длина: b.length, длинаЦела: b.length === тон220.length,
              ждём: +ждём.toFixed(2), стало: +стало.toFixed(2), ошибка: отн(стало, ждём),
            });
          }

          /* ---- Стереокартина и громкость ----
             Середина — аккорд с обертонами (то, что поют), по краям —
             разные партии: если каналы начнут править по отдельности,
             их сходство поедет сразу. */
          const центр = сумма(гарм(196, 0.12, 0.3), гарм(247, 0.10, 1.1), гарм(294, 0.09, 2.0));
          const муз = стерео(
            сумма(центр, гарм(98, 0.10, 0.7), гарм(392, 0.05, 1.7)),
            сумма(центр, гарм(110, 0.10, 2.3), гарм(440, 0.05, 0.4)),
          );
          state.originalBuffer = муз;
          state.instrumentalBuffer = null;   // моно-случай: минусовки нет
          сменилсяЗвук();
          const коррДо = +корр(муз.getChannelData(0), муз.getChannelData(1)).toFixed(3);
          const уровниДо = уровни(муз.getChannelData(0));
          const картина = [];
          for (const n of [2, -5]) {
            await поставить(n);
            const b = state.originalBuffer;
            const после = +корр(b.getChannelData(0), b.getChannelData(1)).toFixed(3);
            const у = уровни(b.getChannelData(0));
            картина.push({
              полутонов: n,
              корр: после,
              расхождение: +Math.abs(после - коррДо).toFixed(3),
              скз: у.скз, пик: у.пик,
              громкостьДб: дБ(уровниДо.скз, у.скз),
            });
            await поставить(0);
          }

          /* ---- Связанность каналов, впритык ----
             Корреляция — мера грубая: рассинхронь каналы на седьмую
             часть поправки, и она сдвинется всего на сотые. Поэтому
             рядом стоит проверка в упор: подаём звук, у которого
             каналы СОВПАДАЮТ (чистая середина, сторона ровно ноль).
             Если фазовая правка у левого и правого одна и та же,
             сторона обязана остаться нулём и после сдвига. Любое
             расхождение вылезает в неё сразу — а именно из середины
             и вычитается минусовка, так что течь в сторону означала бы
             вернувшийся в минусовку вокал. */
          const серединой = стерео(центр, центр);
          state.originalBuffer = серединой;
          state.instrumentalBuffer = null;
          сменилсяЗвук();
          await поставить(2);
          const сб = state.originalBuffer;
          const сL = сб.getChannelData(0), сR = сб.getChannelData(1);
          let сторона = 0, середина = 0;
          for (let i = 0; i < сL.length; i++) {
            const s = сL[i] - сR[i], m = (сL[i] + сR[i]) / 2;
            сторона += s * s; середина += m * m;
          }
          const сторонаДб = +(20 * Math.log10(
            Math.sqrt(сторона / сL.length) / (Math.sqrt(середина / сL.length) || 1e-12) || 1e-12)).toFixed(1);
          await поставить(0);

          /* ---- Тишина остаётся тишиной ----
             Полсекунды тона, секунда молчания, полсекунды тона.
             В молчании после сдвига не должно завестись ни звона,
             ни хвоста: окно вокодера — 46 мс, отступ берём куда шире. */
          const пауза = стерео(
            (i) => (i < SR * 0.5 || i > SR * 1.0 ? 0.5 * Math.sin(2 * Math.PI * 440 * i / SR) : 0),
            (i) => (i < SR * 0.5 || i > SR * 1.0 ? 0.5 * Math.sin(2 * Math.PI * 440 * i / SR) : 0),
          );
          state.originalBuffer = пауза;
          state.instrumentalBuffer = null;
          сменилсяЗвук();
          await поставить(3);
          const молч = state.originalBuffer.getChannelData(0);
          let пикВТишине = 0;
          for (let i = Math.round(SR * 0.65); i < Math.round(SR * 0.9); i++) {
            пикВТишине = Math.max(пикВТишине, Math.abs(молч[i]));
          }
          пикВТишине = +пикВТишине.toExponential(2);

          /* ---- Ноль полутонов ничего не портит ---- */
          state.originalBuffer = тон220;
          state.instrumentalBuffer = тон330;
          сменилсяЗвук();
          await поставить(3);
          const уехали = state.originalBuffer !== тон220;
          await поставить(0);
          const тотЖеБуфер = state.originalBuffer === тон220 && state.instrumentalBuffer === тон330;
          // И честный прогон через движок: расхождение обязано быть неслышимым
          const черезДвижок = await движком(тон220, 0);
          let наНуле = 1;
          if (черезДвижок && черезДвижок.length === тон220.length) {
            const исх = тон220.getChannelData(0), нов = черезДвижок.getChannelData(0);
            наНуле = 0;
            for (let i = 0; i < исх.length; i++) наНуле = Math.max(наНуле, Math.abs(нов[i] - исх[i]));
          }
          наНуле = +наНуле.toExponential(2);

          /* ---- Кэш ---- */
          const расчётовДо = тон.расчётов;
          const первый = await поставить(4);
          await поставить(0);
          const t0 = performance.now();
          const второй = await поставить(4);
          const мсВторой = Math.round(performance.now() - t0);
          const расчётовСтало = тон.расчётов - расчётовДо;
          const размерКэша = тон.кэш.size;
          // Предел ±7 полутонов: за него не пускаем
          const предел = (await поставить(20)).полутонов;
          await поставить(0);
          // Смена песни кэш обнуляет
          сменилсяЗвук();
          const послеСмены = { кэша: тон.кэш.size, полутонов: тон.полутонов };

          const хорошо = (м) => м.длиныЦелы && м.ошибкаО <= 0.01 && м.ошибкаМ <= 0.01;
          return {
            высоты, октавы, коррДо, картина, сторонаДб, пикВТишине, сбои,
            уехали, тотЖеБуфер, наНуле,
            кэш: {
              первыйМс: первый.мс, первыйИзКэша: первый.изКэша,
              второйМс: мсВторой, второйИзКэша: второй.изКэша,
              расчётовСтало, размерКэша, предел, послеСмены,
            },
            вНорме:
              // Ни один сдвиг не сорвался — в том числе на длине
              сбои.length === 0
              // Длина отсчёт в отсчёт и высота с точностью до процента
              && высоты.length === 4 && высоты.every(хорошо)
              // Октава вверх и вниз — ровно вдвое, с точностью до процента
              && октавы.length === 2
              && октавы.every((о) => о.длинаЦела && о.ошибка <= 0.01)
              // Каналы правятся одинаково — стереокартина цела
              && картина.length === 2
              && картина.every((к) => к.расхождение <= 0.05)
              /* Чистая середина остаётся чистой серединой: сторона
                 ниже −60 дБ — это уже не слышно ничем */
              && сторонаДб <= -60
              // И громкость на месте: сдвиг не делает песню тише
              && картина.every((к) => Math.abs(к.громкостьДб) <= 1.5)
              // В молчании ничего не завелось
              && пикВТишине <= 1e-4
              // Ноль — это ровно те же буферы, а не «пересчитанные в ноль»
              && уехали && тотЖеБуфер && наНуле <= 1e-4
              // Кэш: посчитали один раз, второй запрос мгновенный
              && расчётовСтало === 1 && первый.изКэша === false
              && второй.изКэша === true && мсВторой <= 50 && первый.мс > мсВторой
              && размерКэша <= 4 && предел === 7
              && послеСмены.кэша === 0 && послеСмены.полутонов === 0,
          };
        } finally {
          тон.кэш.clear();
          for (const [k, v] of былКэш) тон.кэш.set(k, v);
          тон.порядок = былПорядок;
          тон.полутонов = былиПолутона;
          тон.расчётов = былоРасчётов;
          тон.чистые = былиЧистые;
          state.originalBuffer = былБуфер;
          state.instrumentalBuffer = былМинус;
        }
      })`);

      /* ============================================================
         ТОНАЛЬНОСТЬ В СТУДИИ: орган управления, отмена, сохранение

         Раздел выше проверяет сам сдвиг числами. Здесь — всё, что
         вокруг него, и ровно те места, где такое ломается молча:

         • ЭКСПОРТ. Минусовка .wav и запись видео берут буферы из
           состояния. Возьми там кто-нибудь «исходный, нетронутый» —
           и в файле окажется не то, что человек пел, а узнается это
           уже на YouTube. Поэтому меряется ЧАСТОТА того, что и правда
           отрендерилось: минусовка записана на 330 Гц, после +2
           полутонов обязана читаться как 370,4.
         • ОТМЕНА. Полминуты счёта раньше нечем было прервать. Жмём
           настоящую кнопку в окне ожидания и смотрим, что прежние
           буферы, прежнее число полутонов и снятый признак занятости
           на месте, отменённого в кэше не завелось, а следующий
           расчёт заводится (поток-то терминировали).
         • ПОЗИЦИЯ. Буферы подменяются, источники перезапускаются —
           место в песне обязано остаться тем же. Играло — играет,
           стояло — стоит.
         • ОТКРЫТИЕ. Тональность переживает проект и черновик числом,
           но при открытии НЕ считается: студия не имеет права молча
           замирать на полминуты. Считается на шаге «Караоке» — это
           тоже проверяется, счётчиком настоящих расчётов.
         • НЕЙРОСЕТЬ. После удаления вокала минусовка другая, и кэш
           прежних тональностей про неё врёт. Подменяем буфер ровно
           так, как это делает desktop.js, и смотрим на кэш.

         Живой контекст подменён офлайнным (как в разделах «звук» и
         «скраб»): время в нём стоит, поэтому позиция плеера меряется
         точно, а колонки во время самопроверки молчат.

         Всё тронутое возвращается в finally: буферы, кэш, состояние,
         karaoke-project и активный шаг. */
      report.тональностьВСтудии = await win.webContents.executeJavaScript(`__раздел('тональностьВСтудии', async () => {
        const былБуфер = state.originalBuffer;
        const былМинус = state.instrumentalBuffer;
        const былиЧистые = тон.чистые;
        const былКэш = new Map(тон.кэш);
        const былПорядок = тон.порядок.slice();
        const былиПолутона = тон.полутонов;
        const былВыбран = тон.выбран;
        const былаПамять = тон.изПамяти;
        const былоРасчётов = тон.расчётов;
        const былиОтрезки = state.origSpans;
        const былоИмя = state.fileName;
        const былиСтроки = state.lines;
        const былСтиль = JSON.parse(JSON.stringify(state.style));
        const былЭк = Object.assign({}, state.eq);
        const былаСетка = state.сетка;
        const былФон = state.bgImage;
        const былВокал = state.vocalMix;
        const былМаксШаг = state.maxStep;
        const былТекст = document.getElementById('lyrics-input').value;
        const былПроект = localStorage.getItem('karaoke-project');
        const былКонтекст = audio.ctx;
        const былаИграет = audio.playing;
        const былОтступ = audio.offset;
        const былоПредупреждение = audio._warnedBlocked;
        const шаги = Array.from(document.querySelectorAll('.step-tab'));
        const былШаг = (шаги.findIndex((т) => т.classList.contains('active')) + 1) || 1;
        try {
          const SR = 44100;
          const N = Math.round(SR * 4);
          /* Контекст без звука и без хода времени. Тот же приём, что
             в разделах «звук» и «скраб»: только так позиция плеера
             меряется числом, а не «примерно». */
          const офф = new OfflineAudioContext(2, N, SR);
          audio.ctx = офф;
          audio._warnedBlocked = true;   // окна «браузер глушит звук» здесь не ждём

          const стерео = (f, a, отсчётов) => {
            const дл = отсчётов || N;
            const b = офф.createBuffer(2, дл, SR);
            for (let c = 0; c < 2; c++) {
              const д = b.getChannelData(c);
              for (let i = 0; i < дл; i++) д[i] = a * Math.sin(2 * Math.PI * f * i / SR);
            }
            return b;
          };

          /* Частота автокорреляцией — тем же способом, что в разделе
             движка: вершина берётся первая выше порога, иначе промах
             ровно на октаву. */
          const частота = (x, от, до) => {
            const y = new Float64Array(до - от);
            let ср = 0;
            for (let i = от; i < до; i++) ср += x[i];
            ср /= (до - от);
            let дисп = 0;
            for (let i = от; i < до; i++) { y[i - от] = x[i] - ср; дисп += y[i - от] * y[i - от]; }
            дисп /= y.length;
            if (!(дисп > 1e-12)) return null;
            const лагМин = Math.max(2, Math.floor(SR / 2000));
            const лагМакс = Math.min(y.length - 2, Math.floor(SR / 50));
            const ак = new Float64Array(лагМакс + 2);
            for (let l = лагМин - 1; l <= лагМакс + 1; l++) {
              let s = 0;
              const n = y.length - l;
              for (let i = 0; i < n; i++) s += y[i] * y[i + l];
              ак[l] = (s / n) / дисп;
            }
            let макс = 0;
            for (let l = лагМин; l <= лагМакс; l++) if (ак[l] > макс) макс = ак[l];
            let л = -1;
            for (let l = лагМин; l <= лагМакс; l++) {
              if (ак[l] >= 0.85 * макс && ак[l] >= ак[l - 1] && ак[l] >= ак[l + 1]) { л = l; break; }
            }
            if (л < 0) return null;
            const a = ак[л - 1], b = ак[л], c = ак[л + 1];
            const зн = a - 2 * b + c;
            return +(SR / (л + (зн < 0 ? 0.5 * (a - c) / зн : 0))).toFixed(2);
          };
          const отн = (стало, ждём) => (стало == null ? 1 : +Math.abs(стало / ждём - 1).toFixed(4));
          const пауза = (мс) => new Promise((г) => setTimeout(г, мс));
          const дождаться = (усл, мс) => new Promise((готово) => {
            const край = Date.now() + мс;
            const id = setInterval(() => {
              if (усл() || Date.now() > край) { clearInterval(id); готово(усл()); }
            }, 20);
          });
          const окноВидно = () => !document.getElementById('key-overlay').classList.contains('hidden');

          /* Песня и минусовка на РАЗНЫХ частотах: так видно, какая
             из них куда уехала, и одну не спутать с другой. */
          const песня = стерео(220, 0.5);
          const минус = стерео(330, 0.4);
          state.fileName = 'тест-тональности.wav';
          state.lines = [];
          state.origSpans = [];
          state.vocalMix = 0;             // караоке по умолчанию: слышна минусовка
          state.eq = { low: 0, mid: 0, high: 0 };
          audio.playing = false;
          audio.offset = 0;
          state.originalBuffer = песня;
          state.instrumentalBuffer = минус;
          сменилсяЗвук();
          const чистО = тон.чистые.orig, чистМ = тон.чистые.inst;
          const ждёмО = +(220 * Math.pow(2, 2 / 12)).toFixed(2);
          const ждёмМ = +(330 * Math.pow(2, 2 / 12)).toFixed(2);

          /* ---- 1. Выбор меняет ЗВУЧАЩИЕ буферы, исходные целы ---- */
          await применитьТон(2);
          const выбор = {
            звучитДругое: state.originalBuffer !== чистО && state.instrumentalBuffer !== чистМ,
            исходныеЦелы: тон.чистые.orig === чистО && тон.чистые.inst === чистМ
              && отн(частота(чистМ.getChannelData(0), 4000, N - 4000), 330) <= 0.01,
            полутонов: тон.полутонов,
            выбран: тон.выбран,
            ждёмО, сталоО: частота(state.originalBuffer.getChannelData(0), 4000, N - 4000),
            ждёмМ, сталоМ: частота(state.instrumentalBuffer.getChannelData(0), 4000, N - 4000),
          };
          выбор.ошибкаО = отн(выбор.сталоО, ждёмО);
          выбор.ошибкаМ = отн(выбор.сталоМ, ждёмМ);

          /* ---- 2. Минусовка .wav ----
             С отрезком оригинала: тогда собратьМинусовку идёт длинным
             путём — офлайнный рендер с расписанием, — а не отдаёт буфер
             как есть. Меряем ХВОСТ, снаружи отрезка: там обязана быть
             чистая минусовка в выбранной тональности. */
          state.origSpans = [{ start: 0.5, end: 1.2 }];
          const минусовка = await собратьМинусовку();
          const экспортWav = {
            длинаЦела: минусовка.length === минус.length,
            исходная: 330, ждём: ждёмМ,
            стало: частота(минусовка.getChannelData(0), Math.round(SR * 2), Math.round(SR * 3.8)),
            байт: bufferToWav(минусовка).size,
          };
          экспортWav.ошибка = отн(экспортWav.стало, ждёмМ);

          /* ---- 3. Звук видео ----
             exportVideo собирает ту же смесь (собратьМикс) и вешает
             на неё буферы прямо из состояния. Повторяем эту цепь
             в офлайнном контексте и меряем, что из неё выходит:
             ползунок вокала в караоке на нуле — значит, минусовка. */
          state.origSpans = [];
          const кино = new OfflineAudioContext(2, N, SR);
          const смесь = собратьМикс(кино);
          смесь.output.connect(кино.destination);
          const усил = усиленияМикса(state.vocalMix, !!state.instrumentalBuffer, false);
          смесь.vocalGain.gain.value = усил.вокал;
          смесь.instGain.gain.value = усил.минусовка;
          const и1 = кино.createBufferSource(); и1.buffer = state.originalBuffer;
          и1.connect(смесь.vocalGain); и1.start();
          const и2 = кино.createBufferSource(); и2.buffer = state.instrumentalBuffer;
          и2.connect(смесь.instGain); и2.start();
          const кадр = await кино.startRendering();
          const звукВидео = {
            исходная: 330, ждём: ждёмМ,
            стало: частота(кадр.getChannelData(0), Math.round(SR * 1), Math.round(SR * 3)),
          };
          звукВидео.ошибка = отн(звукВидео.стало, ждёмМ);

          /* ---- 4. «Проверить звук» ----
             Он меряет state.originalBuffer и играет через audio.play(),
             то есть обязан слушать ровно сдвинутый буфер. */
          const проверкаЗвука = {
            берётСдвинутый: state.originalBuffer === тон.кэш.get(2).orig,
            уровень: +bufferLevel(state.originalBuffer, 1).toFixed(3),
          };

          /* ---- 5. Позиция после смены тональности ---- */
          audio.play(2.0);
          const местоДо = audio.position();
          await применитьТон(-3);        // считается заново, не из кэша
          const позиция = {
            игралоИграет: audio.playing === true,
            местоДо: +местоДо.toFixed(3),
            местоПосле: +audio.position().toFixed(3),
          };
          позиция.уехало = +Math.abs(позиция.местоПосле - позиция.местоДо).toFixed(3);
          audio.pause();
          audio.offset = 1.5;
          await применитьТон(2);         // это уже из кэша, мгновенно
          позиция.стоялоСтоит = audio.playing === false;
          позиция.отступПосле = +audio.offset.toFixed(3);
          позиция.уехалоСтоя = +Math.abs(audio.offset - 1.5).toFixed(3);

          /* ---- 6. Отмена на середине счёта ----
             Через настоящую кнопку в окне ожидания. Песня тут нарочно
             длиннее: на четырёх секундах счёт кончается раньше, чем
             успеешь нажать, и проверять было бы нечего. */
          audio.stop();
          audio.playing = false;
          const длиннаяО = стерео(220, 0.5, Math.round(SR * 14));
          const длиннаяМ = стерео(330, 0.4, Math.round(SR * 14));
          state.originalBuffer = длиннаяО;
          state.instrumentalBuffer = длиннаяМ;
          сменилсяЗвук();
          const доПолутонов = тон.полутонов;
          const доРасчётов = тон.расчётов;
          const обещание = применитьТон(6);          // шестёрки в кэше нет
          await пауза(60);
          const отмена = { окноПоявилось: окноВидно(), былЗанят: тон.занят === true };
          document.getElementById('btn-key-cancel').click();
          const итогОтмены = await обещание;
          Object.assign(отмена, {
            вернулосьОтменено: !!итогОтмены && итогОтмены.ok === false
              && итогОтмены.причина === 'отменено',
            окноУбрано: !окноВидно(),
            буферыЦелы: state.originalBuffer === длиннаяО && state.instrumentalBuffer === длиннаяМ,
            полутонов: тон.полутонов, ждали: доПолутонов,
            выборВернулся: тон.выбран === доПолутонов,
            занятСнят: тон.занят === false,
            вКэшеНеЗавелось: !тон.кэш.has(6),
            неСчиталось: тон.расчётов === доРасчётов,
          });
          // Возвращаемся к короткой песне и считаем ещё раз: поток
          // терминирован, и следующий расчёт обязан завести новый
          audio.stop();
          state.originalBuffer = песня;
          state.instrumentalBuffer = минус;
          сменилсяЗвук();
          const послеОтмены = await применитьТон(2);
          отмена.послеОтменыСчитает = !!послеОтмены && послеОтмены.ok === true
            && тон.полутонов === 2;

          /* ---- 7. Проект и черновик ----
             Собираем проект, «перезапускаем студию» (выбор в ноль)
             и открываем черновик тем же самым кодом. Считать при этом
             НЕЛЬЗЯ: счётчик расчётов обязан остаться на месте. */
          const проект = JSON.parse(JSON.stringify(собратьПроект()));
          const звучалоДо = тон.полутонов;
          const расчётовДоОткрытия = тон.расчётов;
          тон.выбран = 0;                       // как будто студию только запустили
          применитьЧерновик(проект);
          const память = {
            вПроекте: проект.key,
            изЧерновика: тон.выбран,
            изПроекта: тонИзПроекта(проект),
            расчётовПриОткрытии: тон.расчётов - расчётовДоОткрытия,
            занятПриОткрытии: тон.занят,
            помечено: тон.изПамяти,
            звучитПриОткрытии: тон.полутонов,
            звучалоДо,
          };

          /* ---- 7б. Черновик с нулевой тональностью поверх ненулевой ----
             Беда: звучит +2, открывают черновик, в котором тональность 0.
             тон.выбран становился нулём и чип прятался (выбран равен
             звучащему по его мнению), а тон.полутонов оставался прежним —
             из колонок до самого шага «Караоке» шла чужая высота, и
             размечали под неё. Возврат в ноль считать нечего: ноль —
             это нетронутый исходник, он всё время лежит в тон.чистые.
             Значит, он обязан случиться прямо при открытии, мгновенно
             и без окна ожидания. */
          const нулевой = JSON.parse(JSON.stringify(проект));
          нулевой.key = 0;
          const расчётовДоНуля = тон.расчётов;
          const звучалоПередНулём = тон.полутонов;
          применитьЧерновик(нулевой);
          const черновикВНоль = {
            звучалоПередНулём,
            звучит: тон.полутонов,
            выбран: тон.выбран,
            посчитали: тон.расчётов - расчётовДоНуля,
            занят: тон.занят,
            окноНеПоявилось: !окноВидно(),
            // Звучит именно нетронутый исходник, а не сдвинутая копия
            исходникВернулся: state.originalBuffer === чистО,
          };
          // Возвращаем +2 обратно: следующие проверки считают от него
          await применитьТон(2);

          /* ---- 8. Считается на шаге «Караоке» ----
             Тональность выбрана, но ещё не звучит — ровно то состояние,
             в котором студия оказывается после открытия проекта. Приход
             на шаг обязан это досчитать, показав окно с полосой. */
          тон.выбран = 5;                       // пятёрки в кэше нет
          тон.изПамяти = true;                  // как после открытия проекта
          const расчётовДоШага = тон.расчётов;
          goToStep(4);
          const приходСтрелкой = { запустилось: тон.занят };
          const приход = { окноПоявилось: окноВидно() };
          await дождаться(() => !тон.занят && тон.полутонов === 5, 60000);
          Object.assign(приход, {
            посчиталось: тон.расчётов - расчётовДоШага,
            полутонов: тон.полутонов,
            окноУбрано: !окноВидно(),
            буферСдвинут: state.originalBuffer !== чистО,
            запустилось: приходСтрелкой.запустилось,
          });

          /* А вот выбранное СТРЕЛКАМИ и не применённое сам никто
             не считает: человек нарочно не нажал «Применить», и
             внезапной паузы при возврате на шаг быть не должно. */
          goToStep(3);
          сдвинутьВыборТона(1);                 // шестёрки в кэше нет — только выбор
          const расчётовДоВозврата = тон.расчётов;
          goToStep(4);
          приход.стрелкаНеСчитает = тон.занят === false
            && тон.расчётов === расчётовДоВозврата && !окноВидно();
          тон.выбран = тон.полутонов;
          обновитьТон();

          /* ---- 9. Кэш после удаления вокала нейросетью ----
             Подменяем минусовку ровно так, как это делает desktop.js:
             audio.stop(), новый буфер в state, сменилсяЗвук(). */
          const кэшаДо = тон.кэш.size;
          audio.stop();
          state.instrumentalBuffer = стерео(440, 0.3);
          сменилсяЗвук();
          const нейросеть = {
            кэшаДо, кэшаПосле: тон.кэш.size,
            полутонов: тон.полутонов, выбран: тон.выбран,
            оригиналВернулся: state.originalBuffer === чистО,
            минусНовая: частота(state.instrumentalBuffer.getChannelData(0), 4000, N - 4000),
          };

          return {
            выбор, экспортWav, звукВидео, проверкаЗвука, позиция, отмена,
            память, черновикВНоль, приход, нейросеть,
            вНорме:
              // 1. Звучит сдвинутое, исходное не тронуто
              выбор.звучитДругое && выбор.исходныеЦелы
              && выбор.полутонов === 2 && выбор.выбран === 2
              && выбор.ошибкаО <= 0.01 && выбор.ошибкаМ <= 0.01
              // 2. Минусовка .wav звучит в выбранной тональности
              && экспортWav.длинаЦела && экспортWav.ошибка <= 0.01 && экспортWav.байт > 44
              // 3. И звук видео тоже
              && звукВидео.ошибка <= 0.01
              // 4. «Проверить звук» слушает сдвинутое
              && проверкаЗвука.берётСдвинутый && проверкаЗвука.уровень > 0.1
              // 5. Место в песне не уехало: играло — играет, стояло — стоит
              && позиция.игралоИграет && позиция.уехало <= 0.1
              && позиция.стоялоСтоит && позиция.уехалоСтоя <= 0.05
              // 6. Отмена: окно было, счёт прерван, всё прежнее на месте
              && отмена.окноПоявилось && отмена.былЗанят && отмена.вернулосьОтменено
              && отмена.окноУбрано && отмена.буферыЦелы
              && отмена.полутонов === отмена.ждали && отмена.выборВернулся
              && отмена.занятСнят && отмена.вКэшеНеЗавелось && отмена.неСчиталось
              && отмена.послеОтменыСчитает
              // 7. Тональность переживает проект и черновик и НЕ считается при открытии
              && память.вПроекте === 2 && память.изЧерновика === 2 && память.изПроекта === 2
              && память.расчётовПриОткрытии === 0 && память.занятПриОткрытии === false
              && память.помечено === true
              && память.звучитПриОткрытии === память.звучалоДо
              /* 7б. Черновик с нулём возвращает звук в ноль СРАЗУ,
                 не считая ничего и не показывая окна ожидания */
              && черновикВНоль.звучалоПередНулём === 2
              && черновикВНоль.звучит === 0 && черновикВНоль.выбран === 0
              && черновикВНоль.посчитали === 0 && черновикВНоль.занят === false
              && черновикВНоль.окноНеПоявилось && черновикВНоль.исходникВернулся
              // 8. Считается на шаге «Караоке», под окном с полосой
              && приход.окноПоявилось && приход.запустилось && приход.посчиталось === 1
              && приход.полутонов === 5 && приход.окноУбрано && приход.буферСдвинут
              && приход.стрелкаНеСчитает
              // 9. Нейросеть обнуляет и кэш, и тональность, и выбор
              && нейросеть.кэшаДо > 0 && нейросеть.кэшаПосле === 0
              && нейросеть.полутонов === 0 && нейросеть.выбран === 0
              && нейросеть.оригиналВернулся,
          };
        } finally {
          отменитьТональность();
          тон.кэш.clear();
          for (const [k, v] of былКэш) тон.кэш.set(k, v);
          тон.порядок = былПорядок;
          тон.полутонов = былиПолутона;
          тон.выбран = былВыбран;
          тон.изПамяти = былаПамять;
          тон.расчётов = былоРасчётов;
          тон.чистые = былиЧистые;
          тон.занят = false;
          document.getElementById('key-overlay').classList.add('hidden');
          audio.stop();
          audio.ctx = былКонтекст;
          audio.playing = былаИграет;
          audio.offset = былОтступ;
          audio._warnedBlocked = былоПредупреждение;
          state.originalBuffer = былБуфер;
          state.instrumentalBuffer = былМинус;
          state.origSpans = былиОтрезки;
          state.fileName = былоИмя;
          state.lines = былиСтроки;
          state.style = былСтиль;
          state.eq = былЭк;
          state.сетка = былаСетка;
          state.vocalMix = былВокал;
          setBgImage(былФон || null);
          document.getElementById('lyrics-input').value = былТекст;
          if (былПроект === null) localStorage.removeItem('karaoke-project');
          else localStorage.setItem('karaoke-project', былПроект);
          updateStyleUI();
          updateEqUI();
          applyStyle();
          обновитьСетку();
          обновитьПамять();
          goToStep(былШаг);
          state.maxStep = былМаксШаг;
        }
      })`);

      /* Подложка под текстом и точки отсчёта. Обе беды пришли с живой
         машины, снимками экрана:

         • подложка была постоянной высоты вокруг середины между местами
           строк, а места ездят ползунками «Место первой» и «Место
           второй»: развели на 46 % и 67 % — и вторая строка повисла
           на голой картинке;
         • точки отсчёта ставились «чуть выше той строки, что вот-вот
           зазвучит», и при тех же разведённых ползунках ложились ровно
           на строку, которую поют сейчас.

         Поэтому признак не смотрит на вид, а МЕРЯЕТ: сравнивает границы
         подложки с коробками строк, а коробку точек — с ними же, числами,
         в процентах высоты поверхности. И делает это на обеих раскладках
         («закреплённые места» и «строки меняются местами») и на обеих
         поверхностях, которые обязаны совпадать: живая сцена (DOM)
         и кадр видео (канвас).

         Здесь же — пять нот в значке проигрыша (и то, что они влезают
         в узкий кадр, не переносясь), новая настройка «высота подложки»
         (переживает проект, у проекта постарше берётся умолчание)
         и умолчание слышимой перемотки: выключена.

         Всё тронутое возвращается в finally, включая karaoke-project. */
      report.подложкаИОтсчёт = await win.webContents.executeJavaScript(`__раздел('подложкаИОтсчёт', () => {
        const былиСтроки = state.lines;
        const былСтиль = JSON.parse(JSON.stringify(state.style));
        const былФон = state.bgImage;
        const былоСмещение = audio.offset;
        const былаИграет = audio.playing;
        const былБуфер = state.originalBuffer;
        const былПроект = localStorage.getItem('karaoke-project');
        const панель = document.getElementById('step-4');
        const былаАктивна = панель.classList.contains('active');
        try {
          панель.classList.add('active');   // скрытую сцену не измерить
          clearVoiceTrack();
          audio.playing = false;
          state.originalBuffer = null;
          state.bgImage = null;
          /* Строки нарочно те же, что на снимке от человека: первая
             допевается к 6-й секунде, до второй пауза в 6 секунд
             (коротка для нот, но отсчёт в ней идёт), а перед третьей
             настоящий проигрыш в 14 секунд. */
          state.lines = [
            { text: 'Щас расскажу вам случай из моей жизни', time: 2, end: 6, ручнойКонец: true, words: null },
            { text: 'Дело было в пятницу под вечер', time: 12, end: 16, ручнойКонец: true, words: null },
            { text: 'И тут началось самое интересное', time: 30, end: 34, ручнойКонец: true, words: null },
          ];
          // Ползунки разведены нарочно — ровно как на снимке
          state.style = Object.assign({}, state.style, {
            posCurrent: 46, posNext: 67, swapLines: false,
            countdown: true, scrim: 100, scrimSize: 100, valign: 'center',
          });
          applyStyle();

          const сцена = document.getElementById('lyrics-stage');
          /* Одна мера живой сцены: коробки строк, коробка точек и границы
             подложки — все в процентах ВНУТРЕННЕЙ высоты сцены, от той же
             границы, от которой отсчитываются top:…% у строк и точек. */
          const мераСцены = (pos, местами) => {
            state.style.swapLines = !!местами;
            applyStyle();
            audio.offset = pos;
            renderStage();
            const H = сцена.clientHeight;
            const sr = сцена.getBoundingClientRect();
            const верх0 = sr.top + (parseFloat(getComputedStyle(сцена).borderTopWidth) || 0);
            const проц = (y) => +(((y - верх0) / H) * 100).toFixed(2);
            const идёт = сцена.classList.contains('counting');
            const ноты = сцена.querySelector('.break-line');
            const строки = [...сцена.querySelectorAll('.stage-line')]
              .filter((el) => !(идёт && el === ноты))
              .map((el) => {
                const r = el.getBoundingClientRect();
                return {
                  текст: el.dataset.text,
                  род: el.classList.contains('current') ? 'cur'
                    : el.classList.contains('near') ? 'near' : 'off',
                  верх: проц(r.top), низ: проц(r.bottom),
                };
              });
            let точки = null;
            const т = сцена.querySelector('.stage-count');
            if (идёт && т) {
              const r = т.getBoundingClientRect();
              точки = { верх: проц(r.top), низ: проц(r.bottom) };
            }
            const fit = fitStageLines(сцена);
            return {
              pos, местами: !!местами, идёт, строки, точки,
              полоса: scrimBand(state.style, scrimGeom(fit, H)),
              кегль: +fit.size.toFixed(2),
              нотыВидны: !!(ноты && !идёт),
              нотыТекст: ноты ? ноты.dataset.text : null,
            };
          };

          /* Тот же замер по кадру видео: раскладку кадр кладёт в
             drawVideoFrame.последнийКадр — теми же числами, какими
             и рисует. */
          const мераКадра = (W, pos, местами) => {
            state.style.swapLines = !!местами;
            const c = document.createElement('canvas');
            c.width = W;
            c.height = Math.round(W * 9 / 16);
            drawVideoFrame(c.getContext('2d'), c.width, c.height, null, pos, null);
            const L = drawVideoFrame.последнийКадр;
            const проц = (y) => +((y / c.height) * 100).toFixed(2);
            const нотыТекст = BREAK_TEXT_FRAME;
            return {
              W, pos, местами: !!местами,
              ширинаТекста: +(c.width * (1 - (state.style.pad / 100) * 2)).toFixed(1),
              строки: L.items.map((it) => ({
                текст: it.text, род: it.kind, ряды: it.rows, кегль: +it.size.toFixed(2),
                ширина: +(it.ширина || 0).toFixed(1),
                верх: проц(it.cy - it.height / 2), низ: проц(it.cy + it.height / 2),
              })),
              точки: L.отсчёт ? { верх: проц(L.отсчёт.верх), низ: проц(L.отсчёт.низ) } : null,
              полоса: L.подложка,
              ноты: L.items.filter((it) => it.text === нотыТекст)
                .map((it) => +(it.ширина || 0).toFixed(1)),
            };
          };

          /* Подложка обязана накрыть ПЛАТО (полной силой) коробки строк,
             а не задеть их краем спада.

             На закреплённых местах строк ровно две, и накрыты обязаны
             быть обе — это и есть беда со снимка. В раскладке «строки
             меняются местами» их на экране до девяти, и накрывать
             столбец целиком означало бы затемнить весь кадр, ради
             отказа от чего подложка и заведена: там спрашиваем
             с текущей и следующей — тех, ради которых она нужна. */
          const важные = (м) => (м.местами
            ? м.строки.filter((s) => s.род === 'cur' || s.род === 'near')
            : м.строки);
          const накрывает = (м) => {
            const в = важные(м);
            if (!м.полоса || !м.полоса.плато || !в.length) return false;
            // На закреплённых местах спрашиваем плато, в столбце — спад
            const г = м.местами ? м.полоса.спад : м.полоса.плато;
            return г.верх <= Math.min(...в.map((s) => s.верх)) + 0.01
              && г.низ >= Math.max(...в.map((s) => s.низ)) - 0.01;
          };

          // Точки не пересекаются ни с одной коробкой строки
          const неНалезает = (м) => !м.точки || м.строки.every(
            (s) => м.точки.низ <= s.верх + 0.01 || м.точки.верх >= s.низ - 0.01);

          /* Четыре положения: поют первую; первая допета, до второй
             шесть секунд (тут и шёл отсчёт по словам); идёт проигрыш;
             проигрыш кончается, пошёл отсчёт. */
          const мгновения = [4, 10, 25, 28];
          const сцены = [];
          for (const местами of [false, true]) {
            for (const pos of мгновения) сцены.push(мераСцены(pos, местами));
          }
          const кадры = [];
          for (const местами of [false, true]) {
            for (const pos of мгновения) {
              кадры.push(мераКадра(1280, pos, местами));
              кадры.push(мераКадра(480, pos, местами));   // узкий кадр
            }
          }
          state.style.swapLines = false;
          applyStyle();

          const сОтсчётом = сцены.filter((м) => м.точки).length;
          const кадрыСОтсчётом = кадры.filter((м) => м.точки).length;
          /* Отсчёт обязан быть виден там, ради чего всё затевалось:
             на закреплённых местах, в обоих положениях с паузой.
             Без этого проверка «точки не налезают» была бы пустой. */
          const отсчётНаМестах = сцены.filter((м) => !м.местами && м.точки).length;
          const отсчётВКадре = кадры.filter((м) => !м.местами && м.точки).length;

          /* Ноты: пять штук и на экране, и в кадре, и ни в одном кадре
             они не шире отведённой ширины — то есть не переносятся
             и за края не выходят. */
          const нотНаЭкране = BREAK_TEXT.split('♪').length - 1;
          const нотВКадре = BREAK_TEXT_FRAME.split('♪').length - 1;
          const нотыВлезают = кадры.every(
            (м) => м.ноты.every((w) => w <= м.ширинаТекста));
          const нотыОдинРяд = кадры.every((м) => м.строки
            .filter((s) => s.текст === BREAK_TEXT_FRAME).every((s) => s.ряды === 1));

          /* Сцена и кадр обязаны считать подложку ОДИНАКОВО: обе 16:9,
             кегль в обеих — одна и та же доля ширины. Допуск — полпроцента
             высоты: замер глифов на разных кеглях слегка расходится. */
          const парой = сцены.map((с) => {
            const к = кадры.find((f) => f.pos === с.pos && f.местами === с.местами && f.W === 1280);
            return {
              pos: с.pos, местами: с.местами,
              сцена: с.полоса.плато, кадр: к.полоса.плато,
              расхождение: +Math.max(
                Math.abs(с.полоса.плато.верх - к.полоса.плато.верх),
                Math.abs(с.полоса.плато.низ - к.полоса.плато.низ)).toFixed(2),
            };
          });
          const совпадают = парой.every((p) => p.расхождение <= 0.5);

          /* Высота подложки: ползунок множит полосу, настройка живёт
             в проекте, а проект постарше берёт умолчание */
          const узкая = (() => {
            state.style.scrimSize = 60;
            applyStyle();
            const м = мераСцены(4, false);
            state.style.scrimSize = 100;
            applyStyle();
            return м.полоса.плато;
          })();
          const широкая = (() => {
            state.style.scrimSize = 200;
            applyStyle();
            const м = мераСцены(4, false);
            state.style.scrimSize = 100;
            applyStyle();
            return м.полоса.плато;
          })();
          state.style.scrimSize = 150;
          saveProject();
          const изПроекта = styleFromSaved(JSON.parse(localStorage.getItem('karaoke-project'))).scrimSize;
          const уСтарого = styleFromSaved({ style: { scrim: 100 }, styleGen: 1 }).scrimSize;
          state.style.scrimSize = 100;
          applyStyle();

          // Слышимая перемотка выключена по умолчанию — включается кнопкой
          const кнопкаСкраба = document.getElementById('tl-scrub');
          const скиммированиеВыключено = editor.слышнаяПеремотка === false
            && !кнопкаСкраба.classList.contains('on');

          return {
            сцены, кадры, парой, узкая, широкая,
            нотНаЭкране, нотВКадре, нотыВлезают, нотыОдинРяд,
            сОтсчётом, кадрыСОтсчётом, отсчётНаМестах, отсчётВКадре,
            подложкаНакрываетВезде: сцены.every(накрывает) && кадры.every(накрывает),
            точкиНеНалезают: сцены.every(неНалезает) && кадры.every(неНалезает),
            совпадают,
            высотаПоЛинейке: узкая.низ - узкая.верх < широкая.низ - широкая.верх,
            изПроекта, уСтарого,
            скиммированиеВыключено,
            вНорме: сцены.every(накрывает) && кадры.every(накрывает)
              && сцены.every(неНалезает) && кадры.every(неНалезает)
              // Отсчёт правда шёл: без него проверка «не налезает» пуста
              && отсчётНаМестах === 2 && отсчётВКадре === 4
              && нотНаЭкране === 5 && нотВКадре === 5
              && нотыВлезают && нотыОдинРяд
              && совпадают
              && (узкая.низ - узкая.верх) < (широкая.низ - широкая.верх)
              && изПроекта === 150 && уСтарого === 100
              && скиммированиеВыключено,
          };
        } finally {
          state.lines = былиСтроки;
          state.style = былСтиль;
          state.bgImage = былФон;
          state.originalBuffer = былБуфер;
          audio.offset = былоСмещение;
          audio.playing = былаИграет;
          applyStyle();
          updateStyleUI();
          if (былПроект != null) localStorage.setItem('karaoke-project', былПроект);
          else localStorage.removeItem('karaoke-project');
          if (!былаАктивна) панель.classList.remove('active');
        }
      })`);

      /* Лишняя работа на каждом кадре редактора.

         Редактор — самый плотный экран студии, и дорожка на нём и правда
         перерисовывается каждый кадр: под движущийся указатель. Всё
         остальное на кадр попадать не должно. Раньше попадало: на паузе
         холст перерисовывался тем же самым рисунком, сцена караоке
         с ЧЕТВЁРТОГО шага пересчитывалась, пока человек сидит в
         редакторе, а каждое движение мыши при перетаскивании собирало
         предпросмотр заново — вместе с подгонкой кегля и прокруткой
         сетки строк к текущей строке. Та прокрутка и была «событием
         scroll едва ли не каждый кадр», из-за которого подсказки
         у кнопок не доживали до своих 180 мс.

         Меряем числами, а не на глаз:
         • стоим на паузе — ни одной отрисовки холста и ни одной правки
           узлов внутри студии;
         • играем — отрисовка ровно раз в кадр (указатель обязан ехать
           плавно), а сетка строк всплывает не чаще смены строки;
         • тащим границу под музыку — то же самое: отрисовка раз в кадр
           и считанные прокрутки сетки, а не по одной на кадр;
         • повторный вызов обновления при неизменных данных не переписывает
           ни одного узла.

         Всё тронутое возвращается в finally, включая karaoke-project. */
      report.кадрыРедактора = await win.webContents.executeJavaScript(`__раздел('кадрыРедактора', async () => {
        const былиСтроки = state.lines;
        const былБуфер = state.originalBuffer;
        const былаДлина = audio.duration;
        const былаПозиция = audio.position;
        const былаИграет = audio.playing;
        const былиПики = editor.peaks;
        const былВыбор = editor.sel;
        const былПроект = localStorage.getItem('karaoke-project');
        const исхТрансформ = CanvasRenderingContext2D.prototype.setTransform;
        const исхПрокрутка = window.scrollEditListTo;
        const активная = [...document.querySelectorAll('.step-panel')]
          .find((p) => p.classList.contains('active'));
        let наблюдатель = null;
        let вернутьЗаписи = null;   // снимает подмену textContent/value, см. ниже
        try {
          /* Песня на три минуты и полсотни строк — как настоящая:
             на короткой разметке сетка строк не прокручивалась бы вовсе */
          const SR = 8000, dur = 180;
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          state.originalBuffer = ctx.createBuffer(1, SR * dur, SR);
          audio.duration = dur;
          state.lines = Array.from({ length: 60 }, (_, i) => ({
            text: 'Строка номер ' + (i + 1) + ' с каким-то текстом песни',
            time: 1 + i * 2.9, end: null, ручнойКонец: false, сомнительная: false,
          }));
          editor.peaks = null;
          audio.playing = false;
          clearHistory();
          goToStep(3);

          const кадры = (n) => new Promise((готово) => {
            let k = 0;
            const шаг = () => { if (++k >= n) готово(); else requestAnimationFrame(шаг); };
            requestAnimationFrame(шаг);
          });
          await кадры(10);   // дать раскладке улечься
          /* Заход в редактор поднимает счёт темпа в рабочем потоке, и его
             ответ ОДИН раз переписывает поля сетки. Дожидаемся его здесь:
             иначе он попал бы в счёт правок «на паузе» и признак краснел
             бы на ровном месте — не из-за лишней работы на кадр, а из-за
             разовой, которая просто не успела закончиться. */
          if (editor.темпЖдём) await editor.темпЖдём.обещание;
          await кадры(3);

          /* Счётчики. Настоящие отрисовки холста считаем по setTransform:
             drawTimeline зовёт его ровно один раз за отрисовку, а вызов,
             отложенный до кадра, выходит раньше. */
          let отрисовок = 0;
          CanvasRenderingContext2D.prototype.setTransform = function () {
            if (this.canvas && this.canvas.id === 'timeline') отрисовок++;
            return исхТрансформ.apply(this, arguments);
          };
          let прокрутокЗвали = 0;
          let прокрутокСдвинуло = 0;
          window.scrollEditListTo = function () {
            прокрутокЗвали++;
            const l = document.getElementById('edit-list');
            const до = l ? l.scrollTop : 0;
            const r = исхПрокрутка.apply(this, arguments);
            if (l && l.scrollTop !== до) прокрутокСдвинуло++;
            return r;
          };
          /* «Переписал узел» считаем ДВУМЯ приборами сразу.

             MutationObserver ловит пересборку: узлы снесли и собрали
             заново. Но одного его мало: браузер умеет не заводить записи,
             когда в textContent кладут ту же самую строку, а у поля ввода
             value и вовсе не отражается в разметке. Поэтому вторым
             прибором считаем сами записи — подменяем присвоение
             textContent и value и смотрим, сколько раз в них написали. */
          let правок = 0;
          let записей = 0;
          наблюдатель = new MutationObserver((з) => { правок += з.length; });
          const текстОпис = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
          const полеОпис = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          let считаемЗаписи = false;
          Object.defineProperty(Node.prototype, 'textContent', {
            ...текстОпис,
            set(v) { if (считаемЗаписи) записей++; return текстОпис.set.call(this, v); },
          });
          Object.defineProperty(HTMLInputElement.prototype, 'value', {
            ...полеОпис,
            set(v) { if (считаемЗаписи) записей++; return полеОпис.set.call(this, v); },
          });
          вернутьЗаписи = () => {
            считаемЗаписи = false;
            Object.defineProperty(Node.prototype, 'textContent', текстОпис);
            Object.defineProperty(HTMLInputElement.prototype, 'value', полеОпис);
          };
          const следить = () => {
            правок = 0; записей = 0; считаемЗаписи = true;
            наблюдатель.observe(document.getElementById('studio'), {
              subtree: true, childList: true, characterData: true, attributes: true,
            });
          };
          const хватит = () => {
            считаемЗаписи = false;
            наблюдатель.takeRecords(); наблюдатель.disconnect();
            return правок + записей;
          };

          /* ---- 1. Песня стоит: студия не должна делать ничего ---- */
          отрисовок = 0; прокрутокЗвали = 0;
          следить();
          await кадры(120);
          const правокНаПаузе = хватит();
          const отрисовокНаПаузе = отрисовок;

          /* ---- 2. Играем: указатель едет, сетка всплывает ---- */
          const t0 = performance.now();
          audio.playing = true;
          audio.position = () => 40 + (performance.now() - t0) / 1000;
          const списокДо = document.getElementById('edit-list').scrollTop;
          отрисовок = 0; прокрутокЗвали = 0; прокрутокСдвинуло = 0;
          let кадровИгры = 0;
          const указатели = [];
          await new Promise((готово) => {
            const шаг = () => {
              кадровИгры++;
              if (кадровИгры % 40 === 0) указатели.push(+audio.position().toFixed(3));
              if (кадровИгры >= 240) { готово(); return; }
              requestAnimationFrame(шаг);
            };
            requestAnimationFrame(шаг);
          });
          const отрисовокЗаИгру = отрисовок;
          const прокрутокЗаИгру = прокрутокЗвали;
          const списокПосле = document.getElementById('edit-list').scrollTop;
          const сеткаВсплыла = списокПосле !== списокДо;
          // Текущая строка правда всплыла: её ряд стоит внутри окна списка
          const текущаяВидна = (() => {
            const l = document.getElementById('edit-list');
            const ряд = l.querySelector('.edit-row.current-row');
            if (!ряд) return false;
            const о = l.getBoundingClientRect();
            const р = ряд.getBoundingClientRect();
            return р.top >= о.top - 1 && р.bottom <= о.bottom + 1;
          })();

          /* ---- 3. Тащим границу строки под музыку ---- */
          const tlRect = tl.getBoundingClientRect();
          const L = timelineLanes();
          const yСтрок = L.lines.y + Math.round(L.lines.h / 2);
          editor.scrollT = 30;
          drawTimeline();
          const xСтарт = tToX(state.lines[11].time) + 6;
          const хит = timelineHit(xСтарт, yСтрок);
          let тащим = true;
          let фаза = 0;
          const шагТяги = () => {
            if (!тащим) return;
            фаза++;
            tl.dispatchEvent(new PointerEvent('pointermove', {
              clientX: tlRect.left + xСтарт + Math.sin(фаза / 8) * 20,
              clientY: tlRect.top + yСтрок, bubbles: true, pointerId: 1,
            }));
            requestAnimationFrame(шагТяги);
          };
          tl.dispatchEvent(new PointerEvent('pointerdown', {
            clientX: tlRect.left + xСтарт, clientY: tlRect.top + yСтрок,
            bubbles: true, pointerId: 1, button: 0,
          }));
          отрисовок = 0; прокрутокЗвали = 0;
          requestAnimationFrame(шагТяги);
          let кадровТяги = 0;
          await new Promise((готово) => {
            const шаг = () => {
              if (++кадровТяги >= 240) { готово(); return; }
              requestAnimationFrame(шаг);
            };
            requestAnimationFrame(шаг);
          });
          тащим = false;
          const отрисовокЗаТягу = отрисовок;
          const прокрутокЗаТягу = прокрутокЗвали;
          tl.dispatchEvent(new PointerEvent('pointerup', {
            clientX: tlRect.left + xСтарт, clientY: tlRect.top + yСтрок,
            bubbles: true, pointerId: 1,
          }));
          audio.playing = false;
          audio.position = былаПозиция;
          await кадры(5);

          /* ---- 4. Повторный вызов при неизменных данных не трогает узлы ---- */
          selectLine(11, {});
          renderEditList();
          renderEditStage();
          refreshTimes();
          await кадры(3);
          следить();
          renderEditStage();
          const правокОтПредпросмотра = хватит();
          следить();
          refreshTimes();
          const правокОтВремён = хватит();
          следить();
          updateSelInfo();
          updateWordInfo();
          const правокОтПанелей = хватит();

          const указательЕдет = указатели.length >= 5
            && указатели.every((v, i) => i === 0 || v > указатели[i - 1]);

          return {
            отрисовокНаПаузе, правокНаПаузе,
            кадровИгры, отрисовокЗаИгру, прокрутокЗаИгру, прокрутокСдвинуло,
            сеткаВсплыла, текущаяВидна,
            кадровТяги, отрисовокЗаТягу, прокрутокЗаТягу,
            тянулиЗа: хит ? хит.kind : null,
            правокОтПредпросмотра, правокОтВремён, правокОтПанелей,
            указатели, указательЕдет,
            вНорме:
              // Стоим — ничего не рисуем и ничего не переписываем
              отрисовокНаПаузе === 0 && правокНаПаузе === 0
              /* Играем — ровно по отрисовке на кадр: меньше значит,
                 что указатель дёргается, больше — что холст рисуется
                 дважды. Вилка на кадр-другой: счётчик кадров и цикл
                 студии — два разных обещания. */
              && отрисовокЗаИгру >= кадровИгры - 3
              && отрисовокЗаИгру <= кадровИгры + 3
              // Сетка строк всплывает, но не дёргается на каждом кадре
              && прокрутокЗаИгру <= 8 && прокрутокСдвинуло >= 1
              && сеткаВсплыла && текущаяВидна
              // Тянем границу под музыку — то же самое
              && хит && хит.kind === 'line-start'
              && отрисовокЗаТягу >= кадровТяги - 3
              && отрисовокЗаТягу <= кадровТяги + 3
              && прокрутокЗаТягу <= 8
              // Повтор при неизменных данных не переписывает узлы
              && правокОтПредпросмотра === 0
              && правокОтВремён === 0
              && правокОтПанелей === 0
              && указательЕдет,
          };
        } finally {
          if (наблюдатель) наблюдатель.disconnect();
          if (вернутьЗаписи) вернутьЗаписи();
          CanvasRenderingContext2D.prototype.setTransform = исхТрансформ;
          window.scrollEditListTo = исхПрокрутка;
          editor.drag = null;
          editor.dragTip = null;
          audio.playing = былаИграет;
          audio.position = былаПозиция;
          state.lines = былиСтроки;
          state.originalBuffer = былБуфер;
          audio.duration = былаДлина;
          editor.peaks = былиПики;
          editor.sel = былВыбор;
          clearHistory();
          if (былПроект != null) localStorage.setItem('karaoke-project', былПроект);
          else localStorage.removeItem('karaoke-project');
          if (активная) {
            document.querySelectorAll('.step-panel')
              .forEach((p) => p.classList.toggle('active', p === активная));
          }
        }
      })`, true);

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
