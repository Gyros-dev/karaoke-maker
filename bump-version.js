#!/usr/bin/env node
/* ============================================================
   Меняет номер версии сразу везде, где он нужен.

   Версий две и они независимы:
     • сайт        — три места: app.js, version.json, index.html
     • приложение  — desktop/package.json

   Запуск:
     node bump-version.js site 1.3.0      — только сайт
     node bump-version.js app 1.2.0       — только приложение
     node bump-version.js both 1.3.0 1.2.0

   Без аргументов показывает текущие версии.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, s) => fs.writeFileSync(path.join(ROOT, p), s);

function currentVersions() {
  const app = read('app.js').match(/const APP_VERSION = '([^']+)'/);
  const ver = JSON.parse(read('version.json'));
  const pkg = JSON.parse(read('desktop/package.json'));
  return {
    сайт: app ? app[1] : '?',
    versionJson: ver.version,
    приложение: pkg.version,
  };
}

function checkFormat(v) {
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    console.error(`Версия «${v}» не подходит: нужен вид 1.2.3`);
    process.exit(1);
  }
}

function bumpSite(version) {
  checkFormat(version);

  // 1. Число, с которым сверяется браузер
  let app = read('app.js');
  if (!/const APP_VERSION = '[^']+'/.test(app)) {
    throw new Error('в app.js не нашёл строку APP_VERSION');
  }
  app = app.replace(/const APP_VERSION = '[^']+'/, `const APP_VERSION = '${version}'`);
  write('app.js', app);

  // 2. Файл, который лежит на сервере — по нему сайт узнаёт об обновлении
  const ver = JSON.parse(read('version.json'));
  ver.version = version;
  ver.date = new Date().toISOString().slice(0, 10);
  write('version.json', JSON.stringify(ver, null, 2) + '\n');

  // 3. Приписки в путях: без них браузер возьмёт старые файлы из кэша
  let html = read('index.html');
  const before = html;
  html = html.replace(/(style\.css|app\.js)\?v=[\d.]+/g, `$1?v=${version}`);
  if (html === before) throw new Error('в index.html не нашёл пути с ?v=');
  write('index.html', html);

  console.log(`Сайт → ${version}`);
  console.log('  app.js, version.json, index.html обновлены');
}

function bumpApp(version) {
  checkFormat(version);
  const p = 'desktop/package.json';
  const pkg = JSON.parse(read(p));
  pkg.version = version;
  write(p, JSON.stringify(pkg, null, 2) + '\n');

  // Отмечаем в version.json — сайт показывает этот номер в блоке загрузки
  const ver = JSON.parse(read('version.json'));
  ver.desktop = version;
  write('version.json', JSON.stringify(ver, null, 2) + '\n');

  console.log(`Приложение → ${version}`);
  console.log('  desktop/package.json обновлён');
  console.log('  не забудь: ссылки на установщики в index.html ведут на конкретный тег');
}

const [what, v1, v2] = process.argv.slice(2);

if (!what) {
  const c = currentVersions();
  console.log('Текущие версии:');
  console.log(`  сайт         ${c.сайт}  (version.json: ${c.versionJson})`);
  console.log(`  приложение   ${c.приложение}`);
  if (c.сайт !== c.versionJson) {
    console.log('\n⚠️  app.js и version.json разошлись — сайт будет вечно предлагать обновиться');
  }
  console.log('\nКак менять:');
  console.log('  node bump-version.js site 1.3.0');
  console.log('  node bump-version.js app 1.2.0');
  console.log('  node bump-version.js both 1.3.0 1.2.0');
  process.exit(0);
}

try {
  if (what === 'site') bumpSite(v1);
  else if (what === 'app') bumpApp(v1);
  else if (what === 'both') { bumpSite(v1); bumpApp(v2); }
  else {
    console.error(`Не понял «${what}». Ожидаю site, app или both.`);
    process.exit(1);
  }
} catch (err) {
  console.error('Не получилось:', err.message);
  process.exit(1);
}
