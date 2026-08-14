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

const WEB = path.join(__dirname, '..', 'karaoke-maker');
const OUT = path.join(__dirname, 'renderer');

if (!fs.existsSync(path.join(WEB, 'index.html'))) {
  console.error('Не нашёл веб-версию в', WEB);
  process.exit(1);
}

const CSP_WEB = /<meta http-equiv="Content-Security-Policy"[^>]*>/;
const CSP_DESKTOP =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; ' +
  'script-src \'self\' \'wasm-unsafe-eval\' blob:; worker-src \'self\' blob:; ' +
  'style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; ' +
  'media-src \'self\' blob:; connect-src \'self\' blob: data:; ' +
  'object-src \'none\'; base-uri \'none\'; form-action \'none\'">';

const AI_BLOCK = `      <div class="bg-upload hidden" id="ai-block">
        <div class="bg-upload-text">
          <b>🧠 Убрать вокал нейросетью</b>
          <span>Качество как у UVR5: модель HTDemucs посчитает минусовку прямо на этом компьютере, ничего не отправляя в интернет</span>
        </div>
        <button class="btn btn-primary btn-small" id="btn-ai-run">Убрать вокал</button>
      </div>
`;

const AI_OVERLAY = `<div class="export-overlay hidden" id="ai-overlay">
  <div class="export-box">
    <p id="ai-status">Готовим модель…</p>
    <div class="export-bar"><div id="ai-fill"></div></div>
    <p class="export-hint" id="ai-hint">Считает на твоём компьютере, ничего не отправляется в интернет.</p>
    <button class="btn btn-ghost" id="btn-ai-cancel">Отменить</button>
  </div>
</div>

`;

function patchHtml(src) {
  let s = src;

  // 1. Политика безопасности: WebAssembly и рабочие потоки
  if (!CSP_WEB.test(s)) throw new Error('не нашёл строку с политикой безопасности');
  s = s.replace(CSP_WEB, CSP_DESKTOP);

  // 2. Версии в путях к файлам не нужны — тут нет кэша браузера
  s = s.replace(/(href|src)="(style\.css|app\.js)\?v=[^"]*"/g, '$1="$2"');

  // 3. Блок удаления вокала — после блока своей минусовки
  const anchor = '        <input type="file" id="inst-input" accept="audio/*" hidden>\n      </div>\n';
  if (!s.includes(anchor)) throw new Error('не нашёл блок «Своя минусовка»');
  s = s.replace(anchor, anchor + AI_BLOCK);

  // 4. Окно прогресса и подключение скриптов
  const scriptTag = '<script src="app.js"></script>';
  if (!s.includes(scriptTag)) throw new Error('не нашёл подключение app.js');
  s = s.replace(scriptTag,
    AI_OVERLAY +
    '<script src="ort/ort.min.js"></script>\n' +
    scriptTag +
    '\n<script src="desktop.js"></script>' +
    '\n<script src="speedtest.js"></script>');

  return s;
}

function patchCss(src) {
  // Полоса прогресса нейросети красится так же, как полоса экспорта
  return src.replace(
    /#export-fill \{/,
    '#export-fill, #ai-fill {');
}

try {
  const html = patchHtml(fs.readFileSync(path.join(WEB, 'index.html'), 'utf8'));
  const css = patchCss(fs.readFileSync(path.join(WEB, 'style.css'), 'utf8'));
  const js = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');

  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  fs.writeFileSync(path.join(OUT, 'style.css'), css);
  fs.writeFileSync(path.join(OUT, 'app.js'), js);

  // DSP-модуль общий, но в воркере экспортируется иначе
  const dsp = fs.readFileSync(path.join(__dirname, 'renderer', 'dsp.js'), 'utf8');
  if (!dsp.includes('self.DSP')) throw new Error('renderer/dsp.js потерял экспорт для воркера');

  console.log('Интерфейс перенесён из веб-версии:');
  console.log('  index.html — политика безопасности, блок нейросети, скрипты');
  console.log('  style.css  — полоса прогресса нейросети');
  console.log('  app.js     — без изменений');
} catch (err) {
  console.error('Не получилось:', err.message);
  process.exit(1);
}
