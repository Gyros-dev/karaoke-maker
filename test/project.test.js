/* ============================================================
   Быстрые проверки самого хозяйства: версии, ключи перевода, ссылки.

   Всё это уже ломалось по-настоящему. Номер версии живёт в пяти местах,
   и однажды app.js разошёлся с version.json — сайт вечно предлагал
   обновиться. Ключ, которого нет в словаре, показывает по-русски сам
   себя («ред.началоСлова» вместо подписи). Ссылки на установщики
   ведут на КОНКРЕТНЫЙ тег, и забыть их при выпуске проще простого.

   Всё это видно из файлов, без окна и без звука, — значит, и проверять
   это надо здесь, за миллисекунды, а не разделом самопроверки.
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const КОРЕНЬ = path.join(__dirname, '..');
const читать = (п) => fs.readFileSync(path.join(КОРЕНЬ, п), 'utf8');

const html = читать('index.html');
const version = JSON.parse(читать('version.json'));

/* Словари достаём из самого i18n.js: он писан для окна, поэтому
   выполняем его в песочнице с поддельными window и document. */
function словари() {
  const окно = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
  const пусто = {
    documentElement: {
      lang: 'ru', dataset: { newsVersion: '' },
      getAttribute: () => null, setAttribute() {}, classList: { toggle() {} },
    },
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} } }),
    dispatchEvent() {}, title: '', body: null,
  };
  const песочница = {
    window: окно, self: окно, document: пусто, localStorage: { getItem: () => null, setItem() {} },
    navigator: { language: 'ru' }, console,
    CustomEvent: class { constructor(тип, о) { this.type = тип; Object.assign(this, о); } },
  };
  песочница.globalThis = песочница;
  vm.createContext(песочница);
  vm.runInContext(читать('i18n.js'), песочница, { filename: 'i18n.js' });
  return песочница.window.I18N;
}
const I18N = словари();

test('версии сходятся во всех пяти местах', () => {
  const вApp = /const APP_VERSION = '([^']+)'/.exec(читать('app.js'))[1];
  assert.strictEqual(вApp, version.version, 'app.js и version.json разошлись');
  assert.strictEqual(JSON.parse(читать('package.json')).version, version.version);
  assert.strictEqual(JSON.parse(читать('desktop/package.json')).version, version.desktop);
  // Приписки ?v= в index.html — от того же номера, иначе браузер
  // возьмёт из кэша прошлый app.js
  const приписки = [...html.matchAll(/(?:style\.css|app\.js|timing\.js|i18n\.js|fft\.js|tempo\.js)\?v=([\d.]+)/g)]
    .map((m) => m[1]);
  assert.ok(приписки.length >= 5, 'не нашёл приписок ?v=');
  assert.deepStrictEqual([...new Set(приписки)], [version.version]);
});

test('ссылки на установщики ведут на нынешний выпуск', () => {
  const ссылки = [...html.matchAll(/releases\/download\/v([\d.]+)\/Karaoke-Punch-([\d.]+)-/g)];
  assert.ok(ссылки.length >= 2, 'ссылок на установщики не нашлось');
  for (const [, тег, имя] of ссылки) {
    assert.strictEqual(тег, version.desktop, 'тег в ссылке отстал');
    assert.strictEqual(имя, version.desktop, 'номер в имени файла отстал');
  }
});

test('у каждого ключа разметки есть перевод', () => {
  const ключи = new Set();
  for (const m of html.matchAll(/data-i18n(?:-html|-title|-placeholder|-aria|-mod-title)?="([^"]+)"/g)) {
    ключи.add(m[1]);
  }
  assert.ok(ключи.size > 100, 'ключей подозрительно мало: ' + ключи.size);
  const нет = [...ключи].filter((к) => !(к in I18N.EN) && !(к in I18N.СТРОКИ));
  assert.deepStrictEqual(нет, [], 'ключи без перевода: ' + нет.join(', '));
});

test('ключи, которые зовёт код, лежат в СТРОКАХ', () => {
  /* Разница не косметическая: t('ключ') ищет в СТРОКАХ, и ключ,
     положенный в EN, по-русски покажет сам себя. */
  const код = читать('app.js') + читать('desktop/renderer/desktop.js');
  const ключи = new Set();
  for (const m of код.matchAll(/\bt\('([^']+)'/g)) ключи.add(m[1]);
  /* Ключи, собираемые из кусков (t('магнит.' + вид)), в коде видны
     обрывком до плюса — их пропускаем: проверить их отсюда нечем. */
  const нет = [...ключи]
    .filter((к) => !к.endsWith('.') && !к.includes('{'))
    .filter((к) => !(к in I18N.СТРОКИ));
  assert.deepStrictEqual(нет, [], 'зовутся кодом, но не в СТРОКАХ: ' + нет.join(', '));
});

test('в СТРОКАХ обе стороны — и русская, и английская', () => {
  /* Сторона — либо строка, либо набор форм числа ({one, few, many}):
     «Разметка 2 строк потеряется» склоняется, и это тоже перевод. */
  const годная = (v) => typeof v === 'string'
    || (v && typeof v === 'object' && ['one', 'few', 'many', 'other']
      .some((ф) => typeof v[ф] === 'string'));
  const кривые = Object.entries(I18N.СТРОКИ)
    .filter(([, v]) => !v || !годная(v.ru) || !годная(v.en))
    .map(([к]) => к);
  assert.deepStrictEqual(кривые, []);
});

test('все наши скрипты разбираются', () => {
  const файлы = ['app.js', 'timing.js', 'i18n.js', 'fft.js', 'tempo.js', 'pitch-worker.js',
    'mp4-muxer.js', 'webm-muxer.js',
    'bump-version.js', 'check-release.js', 'downloads.js',
    'desktop/main.js', 'desktop/preload.js', 'desktop/sync-renderer.js',
    'desktop/renderer/align.js', 'desktop/renderer/desktop.js'];
  for (const f of файлы) {
    assert.doesNotThrow(() => new vm.Script(читать(f), { filename: f }), f + ' не разбирается');
  }
});

test('ключи работ в GitHub Actions — латиницей', () => {
  /* Ключ работы (и ключ шага) GitHub разбирает как опознаватель:
     латиница, цифры, «_» и «-», первым — буква или «_». Кириллица
     делает негодным ВЕСЬ файл: запуск падает до первого шага, работ
     в отчёте нет вовсе, только красный крест и «Invalid workflow
     file». Так и вышло с работой «быстрые-проверки» — проверки
     молчали, а казалось, что они идут. По-русски работу подписывают
     в name, там запрета нет. */
  const годный = /^[A-Za-z_][A-Za-z0-9_-]{0,98}$/;
  const папка = path.join(КОРЕНЬ, '.github', 'workflows');
  const файлы = fs.readdirSync(папка).filter((и) => /\.ya?ml$/.test(и));
  assert.ok(файлы.length, 'рабочих файлов не нашлось вовсе');
  for (const имя of файлы) {
    const строки = fs.readFileSync(path.join(папка, имя), 'utf8').split('\n');
    let вРаботах = false;
    for (const строка of строки) {
      if (/^jobs:/.test(строка)) { вРаботах = true; continue; }
      if (вРаботах && /^\S/.test(строка)) вРаботах = false;
      /* Ключ работы — единственное, что стоит на двух пробелах
         внутри jobs:; всё остальное у неё лежит глубже. */
      const работа = вРаботах && строка.match(/^ {2}([^\s#][^:]*):\s*$/);
      if (работа) {
        assert.match(работа[1], годный, `${имя}: ключ работы «${работа[1]}» GitHub не примет`);
      }
      const шаг = строка.match(/^\s+id:\s*(\S+)\s*$/);
      if (шаг) assert.match(шаг[1], годный, `${имя}: ключ шага «${шаг[1]}» GitHub не примет`);
    }
  }
});
