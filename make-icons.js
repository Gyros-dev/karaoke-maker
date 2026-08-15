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

function resize(size, out) {
  run('magick', [SRC, '-resize', `${size}x${size}`, '-strip', out]);
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
run('magick', [SRC, '-resize', '32x32', '-strip', path.join(WEB_OUT, 'favicon.ico')]);
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

/* --- Иконка Windows --- */
// В .ico кладём набор размеров, система выберет нужный сама
run('magick', [SRC, '-define', 'icon:auto-resize=256,128,64,48,32,16',
  path.join(APP_OUT, 'icon.ico')]);
console.log('Windows: desktop/build/icon.ico');

console.log('\nГотово. Дальше: пересобрать приложение (npm run dist в desktop/)');
