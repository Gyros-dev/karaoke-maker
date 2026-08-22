#!/usr/bin/env node
/* ============================================================
   Переносит интерфейс из веб-версии в настольную.

   Веб-версия — единственный источник правды для index.html,
   style.css и app.js. Настольные отличия добавляются здесь,
   чтобы копии не расходились вручную:
     • другая политика безопасности (нужна для WebAssembly)
     • подключение движка ONNX и настольных скриптов
     • блок «Убрать вокал нейросетью» и окно прогресса

   Запуск: npm run sync
   ============================================================ */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'renderer');

/* Работает в двух раскладках: когда папка лежит внутри репозитория
   сайта (../index.html) и когда рядом с ним (../karaoke-maker/) */
const CANDIDATES = [
  path.join(__dirname, '..'),
  path.join(__dirname, '..', 'karaoke-maker'),
];
const WEB = CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'index.html')));

if (!WEB) {
  console.error('Не нашёл веб-версию. Искал в:\n  ' + CANDIDATES.join('\n  '));
  process.exit(1);
}

const CSP_WEB = /<meta http-equiv="Content-Security-Policy"[^>]*>/;
const CSP_DESKTOP =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; ' +
  'script-src \'self\' \'wasm-unsafe-eval\' blob:; worker-src \'self\' blob:; ' +
  'style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; ' +
  'media-src \'self\' blob:; connect-src \'self\' blob: data:; ' +
  'object-src \'none\'; base-uri \'none\'; form-action \'none\'">';

/* Блок удаления вокала — только в приложении.

   Модель — UVR-MDX-NET-Inst_HQ_3, ровно та, которой считает UVR5.
   Выбора «быстро или хорошо» на виду нет: число проходов на качество
   не влияет (замерено), поэтому по умолчанию один, а переключатель
   убран в свёрнутое «Ещё варианты» без обещаний. Строку #ai-eta
   заполняет desktop.js: там считается, сколько это займёт. */
const AI_BLOCK = `      <div class="bg-upload hidden" id="ai-block">
        <div class="bg-upload-text">
          <b data-i18n="ии.заголовок">🧠 Убрать вокал нейросетью</b>
          <span data-i18n="ии.текст">Локальная модель UVR-MDX-NET-Inst_HQ_3 — та же, которой считает UVR5. Всё посчитается прямо на компьютере</span>
        </div>
        <button class="btn btn-primary btn-small" id="btn-ai-run" data-i18n="ии.кнопка">Убрать вокал</button>
        <p class="ai-eta" id="ai-eta"></p>
        <details class="ai-more">
          <summary data-i18n="ии.ещё">Ещё варианты</summary>
          <div class="ai-more-body">
            <label class="btn btn-ghost btn-small export-quality" for="ai-quality"><span data-i18n="ии.качество">Качество</span>
              <select id="ai-quality">
                <option value="1" selected data-i18n="ии.один">Один проход</option>
                <option value="3" data-i18n="ии.три">Три прохода — дольше втрое</option>
              </select>
            </label>
            <p data-i18n="ии.пояснение">Мы замерили: три прохода со сдвигом дают тот же результат, что один.
              Расхождение между ними −31 дБ, остаток голоса совпадает до сотых.
              Раньше здесь стояло три прохода и обещалось лучшее качество — это
              оказалось неправдой, ждать приходилось втрое дольше ни за что.
              Выбор оставлен на случай, если на вашей записи разница всё-таки
              найдётся, но по умолчанию — один проход.</p>
          </div>
        </details>
      </div>
`;

const AI_OVERLAY = `<div class="export-overlay hidden" id="ai-overlay">
  <div class="export-box">
    <p id="ai-status" data-i18n="ии.готовим">Готовим модель…</p>
    <div class="export-bar"><div id="ai-fill"></div></div>
    <p class="export-hint" id="ai-hint" data-i18n="ии.локально">Считает на твоём компьютере, ничего не отправляется в интернет.</p>
    <button class="btn btn-ghost" id="btn-ai-cancel" data-i18n="ии.отменить">Отменить</button>
  </div>
</div>

`;

/* Разметка текста нейросетью — только в приложении: модель весит
   десятки мегабайт и в браузере не потянется.

   Два режима в одной кнопке. Поле с текстом пустое — нейросеть пишет
   текст сама (черновик). Текст уже вставлен — она только расставляет
   по нему времена, и это главный способ работы. Пояснение и подпись
   кнопки переключает updateAsrMode в desktop.js, чтобы человек заранее
   видел, что произойдёт, и не затёр свой текст распознаванием.

   Сразу под заголовком — метка о готовой разметке (#asr-result). Она
   стоит первой, а не в конце блока: расчёт долгий, и его итог должен
   попадаться на глаза сразу, а не после прокрутки длинных пояснений. */
const ASR_BLOCK = `    <div class="asr-block hidden" id="asr-block">
      <div class="asr-head">
        <b data-i18n="asr.заголовок">🗣 Разметка текста нейросетью</b>
        <span class="asr-source" id="asr-source"></span>
      </div>
      <p class="asr-result hidden" id="asr-result"><b id="asr-result-head"></b><span id="asr-result-note"></span></p>
      <p class="asr-warning hidden" id="asr-about-fit" data-i18n-html="asr.подгонка">
        <b>Текст на месте — нейросеть расставит по нему времена.</b> Она послушает
        песню, найдёт, где какое слово поётся, и разложит по этим меткам ваши строки:
        буквы остаются вашими, от нейросети берётся только время. Так надёжнее, чем
        распознавать текст с нуля, — во времени модель ошибается куда реже, чем в буквах.
        Точнее выходит, если сначала убрать вокал нейросетью на первом шаге:
        тогда она слушает чистый голос, а не микс.
      </p>
      <p class="asr-warning" id="asr-about-fresh" data-i18n-html="asr.сНуля">
        <b>Текста песни нет под рукой?</b> Нейросеть напишет его сама. Честно:
        распознавание <b>пения</b> работает заметно хуже, чем распознавание речи —
        гласные тянутся, мешают бэк-вокал и музыка, рифм модель не знает, так что
        это черновик, который экономит набор текста, а не готовый результат.
        Обычный путь другой: найти текст песни, вставить его в поле ниже — и тогда
        нейросети останется только расставить времена.
      </p>
      <div class="asr-controls">
        <label class="btn btn-ghost btn-small export-quality" for="asr-lang"><span data-i18n="asr.язык">Язык</span>
          <select id="asr-lang">
            <option value="" data-i18n="asr.язык.сам">Определить сам</option>
            <option value="russian" selected data-i18n="asr.язык.ru">Русский</option>
            <option value="english" data-i18n="asr.язык.en">Английский</option>
            <option value="ukrainian" data-i18n="asr.язык.uk">Украинский</option>
            <option value="german" data-i18n="asr.язык.de">Немецкий</option>
            <option value="french" data-i18n="asr.язык.fr">Французский</option>
            <option value="spanish" data-i18n="asr.язык.es">Испанский</option>
            <option value="italian" data-i18n="asr.язык.it">Итальянский</option>
          </select>
        </label>
        <button class="btn btn-primary btn-small" id="btn-asr-run">Распознать текст</button>
        <button class="btn btn-ghost btn-small hidden" id="btn-asr-fresh"
          data-i18n="asr.сНуля.кнопка" data-i18n-title="asr.сНуля.подсказка"
          title="Нейросеть напишет текст сама и заменит им то, что в поле">Распознать с нуля</button>
      </div>
      <p class="asr-eta" id="asr-eta"></p>
      <details class="asr-more">
        <summary data-i18n="asr.ещё">Ещё варианты</summary>
        <div class="asr-more-body">
          <label class="btn btn-ghost btn-small export-quality" for="asr-model"><span data-i18n="asr.модель">Модель</span>
            <select id="asr-model"></select>
          </label>
          <p data-i18n="asr.модель.пояснение">По умолчанию стоит крупная модель — она разбирает пение лучше всех,
            что у нас есть, но считает примерно вдвое дольше обычной и весит втрое
            больше. Обычную имеет смысл взять, если ждать некогда: для подгонки
            своего текста ей чаще всего хватает, ведь от нейросети там нужны только
            времена, а не буквы.</p>
        </div>
      </details>
    </div>
`;

const ASR_OVERLAY = `<div class="export-overlay hidden" id="asr-overlay">
  <div class="export-box">
    <p id="asr-status" data-i18n="asr.готовим">Готовим модель…</p>
    <div class="export-bar"><div id="asr-fill"></div></div>
    <p class="export-hint" id="asr-hint" data-i18n="asr.локально">Считает на твоём компьютере, ничего не отправляется в интернет.</p>
    <button class="btn btn-ghost" id="btn-asr-cancel" data-i18n="asr.отменить">Отменить</button>
  </div>
</div>

`;

function patchHtml(src) {
  let s = src;

  // 1. Политика безопасности: WebAssembly и рабочие потоки
  if (!CSP_WEB.test(s)) throw new Error('не нашёл строку с политикой безопасности');
  s = s.replace(CSP_WEB, CSP_DESKTOP);

  // 2. Иконки сайта в приложении не нужны — у окна своя иконка
  s = s.replace(/^.*<link rel="(icon|apple-touch-icon)"[^>]*>\n/gm, '');
  s = s.replace(/^.*<meta name="theme-color"[^>]*>\n/gm, '');
  s = s.replace(/^.*<img class="logo-img"[^>]*>\n/gm, '');
  s = s.replace('<span class="logo-icon hidden" id="logo-fallback">', '<span class="logo-icon" id="logo-fallback">');

  // 3. Версии в путях к файлам не нужны — тут нет кэша браузера
  s = s.replace(/(href|src)="(style\.css|app\.js|i18n\.js)\?v=[^"]*"/g, '$1="$2"');

  // 4. Блок удаления вокала — после блока своей минусовки
  const anchor = '        <input type="file" id="inst-input" accept="audio/*" hidden>\n      </div>\n';
  if (!s.includes(anchor)) throw new Error('не нашёл блок «Своя минусовка»');
  s = s.replace(anchor, anchor + AI_BLOCK);

  // 5. Блок распознавания текста — перед полем текста песни
  const textAnchor = '    <textarea id="lyrics-input"';
  if (!s.includes(textAnchor)) throw new Error('не нашёл поле текста песни');
  s = s.replace(textAnchor, ASR_BLOCK + textAnchor);

  // 6. Окна прогресса и подключение скриптов
  const scriptTag = '<script src="app.js"></script>';
  if (!s.includes(scriptTag)) throw new Error('не нашёл подключение app.js');
  s = s.replace(scriptTag,
    AI_OVERLAY +
    ASR_OVERLAY +
    '<script src="ort/ort.min.js"></script>\n' +
    scriptTag +
    '\n<script src="align.js"></script>' +
    '\n<script src="desktop.js"></script>' +
    '\n<script src="speedtest.js"></script>');

  return s;
}

const ASR_CSS = `
/* --- Распознавание текста песни (только в приложении) --- */
.asr-block {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-card);
  padding: 1rem 1.2rem;
  margin-bottom: 0.9rem;
}
.asr-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.6rem;
  margin-bottom: 0.5rem;
}
.asr-source { color: #34d399; font-size: 0.85rem; font-weight: 600; }
.asr-warning {
  color: var(--text-dim);
  font-size: 0.85rem;
  line-height: 1.5;
  margin-bottom: 0.8rem;
}
.asr-warning b { color: var(--text); }
.asr-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; }

/* --- Метка о готовой разметке (только в приложении) ---
   Расчёт долгий, а по его окончании на экране не оставалось никакого
   следа: окно с итогом закрыли — и непонятно, получилось или нет.
   Метка остаётся в блоке разметки, переживает переход на другой шаг
   и обратно и меняется только тогда, когда разметку делают заново. */
.asr-result {
  flex-basis: 100%;
  width: 100%;
  margin: 0 0 0.8rem;
  padding: 0.5rem 0.7rem;
  border: 1px solid rgba(52, 211, 153, 0.3);
  border-left-width: 3px;
  border-radius: 8px;
  background: rgba(16, 185, 129, 0.07);
  color: var(--text-dim);
  font-size: 0.85rem;
  line-height: 1.5;
}
.asr-result b { color: #34d399; font-weight: 600; }

/* --- Оценка времени и спрятанные быстрые варианты (только в приложении) ---

   По умолчанию нейросети считают лучшим качеством, а оно небыстрое,
   поэтому под каждым блоком идёт строка с ожидаемым временем. Быстрые
   варианты остаются рабочими, но убраны в свёрнутое «Ещё варианты»:
   они хуже, и предлагать их первым делом незачем.

   Обе строки живут внутри флекс-рядов (.bg-upload и .asr-block), поэтому
   flex-basis: 100% — чтобы они переносились на свою строку целиком. */
.ai-eta, .asr-eta {
  flex-basis: 100%;
  width: 100%;
  margin: 0.7rem 0 0;
  color: var(--text-dim);
  font-size: 0.85rem;
  line-height: 1.5;
}
.ai-eta b, .asr-eta b { color: #34d399; font-weight: 700; }
.ai-more, .asr-more { flex-basis: 100%; width: 100%; margin-top: 0.6rem; }
.ai-more > summary, .asr-more > summary {
  display: inline-block;
  list-style: none;
  cursor: pointer;
  color: var(--text-dim);
  font-size: 0.85rem;
  user-select: none;
}
.ai-more > summary::-webkit-details-marker,
.asr-more > summary::-webkit-details-marker { display: none; }
.ai-more > summary::before, .asr-more > summary::before { content: '▸ '; }
.ai-more[open] > summary::before, .asr-more[open] > summary::before { content: '▾ '; }
.ai-more > summary:hover, .asr-more > summary:hover { color: var(--text); }
.ai-more-body, .asr-more-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.7rem;
}
.ai-more-body p, .asr-more-body p {
  flex-basis: 100%;
  margin: 0;
  color: var(--text-dim);
  font-size: 0.82rem;
  line-height: 1.5;
}
`;

function patchCss(src) {
  // Полосы прогресса нейросетей красятся так же, как полоса экспорта
  return src.replace(
    /#export-fill \{/,
    '#export-fill, #ai-fill, #asr-fill {') + ASR_CSS;
}

try {
  const html = patchHtml(fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'));
  const css = patchCss(fs.readFileSync(path.join(WEB, 'style.css'), 'utf8'));
  const js = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  // Словарь перевода общий с сайтом, настольных отличий у него нет
  const i18n = fs.readFileSync(path.join(WEB, 'i18n.js'), 'utf8');

  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  fs.writeFileSync(path.join(OUT, 'style.css'), css);
  fs.writeFileSync(path.join(OUT, 'app.js'), js);
  fs.writeFileSync(path.join(OUT, 'i18n.js'), i18n);

  /* Фирменные шрифты. Их подключает style.css относительным путём
     fonts/…, и без этих файлов приложение молча рисовало бы имя
     запасным шрифтом. Лицензия OFL требует носить свой текст вместе
     со шрифтом, поэтому OFL.txt переносится наравне с woff2. */
  const FONT_DIR = path.join(WEB, 'fonts');
  const FONT_OUT = path.join(OUT, 'fonts');
  const FONT_FILES = ['bungee.woff2', 'bungee-shade.woff2', 'OFL.txt'];
  fs.mkdirSync(FONT_OUT, { recursive: true });
  for (const name of FONT_FILES) {
    const from = path.join(FONT_DIR, name);
    if (!fs.existsSync(from)) throw new Error(`нет файла шрифта fonts/${name}`);
    fs.copyFileSync(from, path.join(FONT_OUT, name));
  }

  // DSP-модуль общий, но в воркере экспортируется иначе
  const dsp = fs.readFileSync(path.join(__dirname, 'renderer', 'dsp.js'), 'utf8');
  if (!dsp.includes('self.DSP')) throw new Error('renderer/dsp.js потерял экспорт для воркера');

  console.log('Интерфейс перенесён из веб-версии:');
  console.log('  index.html — политика безопасности, блок нейросети, скрипты');
  console.log('  style.css  — полоса прогресса нейросети');
  console.log('  app.js     — без изменений');
  console.log('  i18n.js    — без изменений');
  console.log('  fonts/     — Bungee, Bungee Shade и лицензия OFL');
} catch (err) {
  console.error('Не получилось:', err.message);
  process.exit(1);
}
