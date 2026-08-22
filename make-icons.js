#!/usr/bin/env node
/* ============================================================
   Делает все иконки из одного исходника.

   Положи логотип квадратом (лучше 1024×1024) в logo.png рядом
   с этим файлом и запусти:  node make-icons.js

   Получится:
     icons/            — для сайта (вкладка браузера, ярлык на телефоне)
     desktop/build/    — icon.icns для macOS и icon.ico для Windows,
                         electron-builder подхватывает их сам
   ============================================================ */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = path.join(__dirname, 'logo.png');
const WEB_OUT = path.join(__dirname, 'icons');
const APP_OUT = path.join(__dirname, 'desktop', 'build');

if (!fs.existsSync(SRC)) {
  console.error('Не нашёл logo.png рядом с этим скриптом.');
  console.error('Положи туда квадратный логотип (лучше 1024×1024) и запусти снова.');
  process.exit(1);
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

/* --- Прозрачные углы ---

   Логотип нарисован со скруглёнными углами, но лежит на непрозрачном
   фоне: исходник сделан из JPEG, прозрачности в нём нет вовсе. Углы
   при этом белые — и на Windows это видно во всех местах, где систему
   не просят скруглить значок самой: в Проводнике, на ярлыке, в панели
   задач у иконки были светлые уголки.

   Радиус не на глаз, а измерен по самой картинке: по каждому углу
   искали, где кончается рисунок, и подгоняли окружность методом
   наименьших квадратов. Верхние углы дали 178 px, нижние 192 px
   (рисунок не идеально геометрический), отклонение от дуги ≈1 px.
   Берём 196 px на 1024 — с запасом в несколько пикселей, чтобы срезать
   и светлую кайму сглаживания: при 193 px по нижним углам оставалось
   несколько десятков светлых точек, при 196 — ни одной. Верхние углы
   при этом теряют не больше 5 px рисунка по диагонали, то есть 0,2 px
   на значке 32×32.

   Маску рисуем в размер готовой иконки, а не масштабируем вместе
   с картинкой: так углы остаются чистыми на любом размере, и белый
   фон из-под прозрачной части не подмешивается при уменьшении. */
const RADIUS = 196 / 1024;

function маска(size) {
  const r = Math.round(size * RADIUS);
  return ['(', '-size', `${size}x${size}`, 'xc:black', '-fill', 'white',
    '-draw', `roundrectangle 0,0 ${size - 1},${size - 1} ${r},${r}`,
    '-alpha', 'off', ')', '-compose', 'CopyOpacity', '-composite'];
}

function resize(size, out) {
  run('magick', [SRC, '-resize', `${size}x${size}`, ...маска(size), '-strip', out]);
}

/* --- Иконки сайта --- */
fs.mkdirSync(WEB_OUT, { recursive: true });
const WEB_SIZES = [
  [32, 'favicon-32.png'],
  [180, 'apple-touch-icon.png'], // ярлык на iPhone
  [192, 'icon-192.png'],
  [512, 'icon-512.png'],
];
for (const [size, name] of WEB_SIZES) resize(size, path.join(WEB_OUT, name));
resize(32, path.join(WEB_OUT, 'favicon.ico'));
console.log(`Сайт:    ${WEB_SIZES.length + 1} файлов в icons/`);

/* --- Водяной знак для видео ---
   Лежит рядом с интерфейсом, а не в icons/: настольная сборка папку
   icons вычищает, а знак нужен и там. */
const WM = 'watermark.png';
resize(256, path.join(__dirname, WM));
const rendererDir = path.join(__dirname, 'desktop', 'renderer');
if (fs.existsSync(rendererDir)) {
  fs.copyFileSync(path.join(__dirname, WM), path.join(rendererDir, WM));
}
console.log('Знак:    watermark.png (сайт и приложение)');

/* --- Иконка macOS --- */
fs.mkdirSync(APP_OUT, { recursive: true });
const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'iconset-')) + '.iconset';
fs.mkdirSync(iconset, { recursive: true });
// Размеры, которых ждёт iconutil: обычные и «двойные» для экранов Retina
for (const size of [16, 32, 128, 256, 512]) {
  resize(size, path.join(iconset, `icon_${size}x${size}.png`));
  resize(size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`));
}
run('iconutil', ['-c', 'icns', iconset, '-o', path.join(APP_OUT, 'icon.icns')]);
fs.rmSync(iconset, { recursive: true, force: true });
console.log('macOS:   desktop/build/icon.icns');

/* --- Иконка Windows ---
   В .ico кладём набор размеров, система выберет нужный сама. Каждый
   готовим отдельно, а не через icon:auto-resize: скругление надо
   рисовать в размер картинки, иначе на мелких значках угол выходит
   рваным, а из-под прозрачной части подмешивается белый фон. */
const icoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ico-'));
const ICO_SIZES = [256, 128, 64, 48, 32, 16];
const icoFiles = ICO_SIZES.map((size) => {
  const out = path.join(icoDir, `${size}.png`);
  resize(size, out);
  return out;
});
run('magick', [...icoFiles, path.join(APP_OUT, 'icon.ico')]);
fs.rmSync(icoDir, { recursive: true, force: true });
console.log('Windows: desktop/build/icon.ico');

console.log('\nГотово. Дальше: пересобрать приложение (npm run dist в desktop/)');
