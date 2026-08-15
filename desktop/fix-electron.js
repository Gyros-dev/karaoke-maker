#!/usr/bin/env node
/* ============================================================
   Чинит установку Electron, если она оборвалась.

   Установщик Electron иногда молча кладёт вместо приложения
   огрызок: архив скачан, но распаковка не доведена до конца.
   Внешне всё в порядке, а при запуске — «Electron failed to
   install correctly».

   Скрипт проверяет результат установки и, если он битый,
   распаковывает архив из кэша сам.

   Запускается после npm install; можно и руками: npm run fix
   ============================================================ */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ELECTRON = path.join(__dirname, 'node_modules', 'electron');
const DIST = path.join(ELECTRON, 'dist');
const PATH_TXT = path.join(ELECTRON, 'path.txt');

function looksBroken() {
  if (!fs.existsSync(DIST)) return true;
  const marker = process.platform === 'darwin'
    ? path.join(DIST, 'Electron.app')
    : path.join(DIST, process.platform === 'win32' ? 'electron.exe' : 'electron');
  return !fs.existsSync(marker);
}

function version() {
  return JSON.parse(fs.readFileSync(path.join(ELECTRON, 'package.json'), 'utf8')).version;
}

/* Кэш лежит либо прямо в папке, либо в подпапках с хешем */
function findCachedZip(ver) {
  const roots = [
    path.join(os.homedir(), 'Library', 'Caches', 'electron'),        // macOS
    path.join(os.homedir(), '.cache', 'electron'),                    // Linux
    path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache'), // Windows
  ].filter((p) => fs.existsSync(p));

  const wanted = `electron-v${ver}-${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}.zip`;

  for (const root of roots) {
    const direct = path.join(root, wanted);
    if (fs.existsSync(direct)) return direct;
    for (const entry of fs.readdirSync(root)) {
      const nested = path.join(root, entry, wanted);
      if (fs.existsSync(nested)) return nested;
    }
  }
  return null;
}

if (!fs.existsSync(ELECTRON)) {
  console.log('Electron ещё не установлен — пропускаю проверку');
  process.exit(0);
}

if (!looksBroken()) {
  process.exit(0);
}

console.log('Electron установлен не полностью — чиню');

const ver = version();
const zip = findCachedZip(ver);
if (!zip) {
  console.error(`Не нашёл архив electron-v${ver} в кэше.`);
  console.error('Запусти установку ещё раз: npm install');
  process.exit(1);
}

try {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -Path "${zip}" -DestinationPath "${DIST}" -Force`], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', zip, '-d', DIST], { stdio: 'inherit' });
  }

  const rel = process.platform === 'darwin'
    ? 'Electron.app/Contents/MacOS/Electron'
    : process.platform === 'win32' ? 'electron.exe' : 'electron';
  fs.writeFileSync(PATH_TXT, rel);

  if (looksBroken()) throw new Error('после распаковки файлов всё равно нет');
  console.log('Electron восстановлен из кэша');
} catch (err) {
  console.error('Починить не вышло:', err.message);
  console.error('Убери папку node_modules/electron и запусти npm install заново');
  process.exit(1);
}
