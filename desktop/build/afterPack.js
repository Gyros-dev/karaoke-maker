/* ============================================================
   Доводка собранного приложения перед упаковкой.

   Два действия, и порядок важен:
     1) убрать веб-иконки — в приложении своя, из build/icon.*
     2) подписать «для себя» (ad-hoc)

   Именно в такой последовательности: подпись запечатывает состав
   пакета, и удаление файлов после неё ломает печать.

   Зачем вообще подпись: electron-builder с identity: null оставляет
   заглушку от компоновщика — подпись формально есть, но ресурсы не
   запечатаны, и macOS на Apple Silicon объявляет приложение
   повреждённым («is damaged and can't be opened»).

   Почему не codesign --deep: он подписывает оболочку, а вложенный
   Electron Framework остаётся со своей подписью, и dyld при запуске
   ругается на разные Team ID. Подписывать нужно изнутри наружу.
   ============================================================ */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/* --- 1. Веб-иконки внутри приложения не нужны --- */
function dropWebIcons(appOutDir) {
  const roots = [
    path.join(appOutDir, 'resources', 'app'),
    path.join(appOutDir, 'resources', 'app', 'renderer'),
  ];
  const names = ['icons', 'favicon.ico', 'favicon-32.png',
    'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];
  let removed = 0;
  for (const root of roots) {
    for (const name of names) {
      const target = path.join(root, name);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        removed++;
      }
    }
  }
  return removed;
}

/* --- 2. Подпись ad-hoc, изнутри наружу --- */
function sign(target) {
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', target],
    { stdio: ['ignore', 'ignore', 'pipe'] });
}

function collectTargets(appPath) {
  const targets = [];
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');

  if (fs.existsSync(frameworks)) {
    for (const entry of fs.readdirSync(frameworks)) {
      const full = path.join(frameworks, entry);

      if (entry.endsWith('.framework')) {
        // Внутренние библиотеки фреймворка идут раньше самого фреймворка
        for (const sub of ['Libraries', 'Helpers']) {
          const dir = path.join(full, 'Versions', 'A', sub);
          if (!fs.existsSync(dir)) continue;
          for (const f of fs.readdirSync(dir)) targets.push(path.join(dir, f));
        }
        targets.push(full);
      } else if (entry.endsWith('.app') || entry.endsWith('.dylib')) {
        targets.push(full);
      }
    }
  }

  // Сама оболочка — последней, чтобы запечатать уже подписанное содержимое
  targets.push(appPath);
  return targets;
}

exports.default = async function afterPack(context) {
  const removed = dropWebIcons(context.appOutDir);
  if (removed) console.log(`  • убрано веб-иконок      ${removed}`);

  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const targets = collectTargets(appPath);

  console.log(`  • подписываем ad-hoc      ${targets.length} объектов`);
  for (const target of targets) sign(target);

  // Проверяем, что подпись целая — иначе смысла в сборке нет
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log('  • подпись проверена       ok');
};
