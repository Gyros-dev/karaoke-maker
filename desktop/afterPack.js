/* ============================================================
   Подписываем собранное приложение «для себя» (ad-hoc).

   Зачем: electron-builder с identity: null оставляет заглушку от
   компоновщика — подпись формально есть, но ресурсы не запечатаны,
   и macOS на Apple Silicon объявляет приложение повреждённым
   («is damaged and can't be opened»).

   Почему не codesign --deep: он подписывает оболочку, но вложенный
   Electron Framework остаётся со своей подписью, и при запуске
   dyld ругается на разные Team ID. Подписывать нужно изнутри
   наружу, каждый двоичный файл отдельно.

   Настоящий сертификат разработчика это не заменяет: приложение
   не заверено у Apple, и при первом запуске нужно снять карантин.
   ============================================================ */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function sign(target) {
  execFileSync('codesign', [
    '--force',
    '--sign', '-',
    '--timestamp=none',
    target,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/* Собираем всё, что нужно подписать, в порядке «сначала вложенное» */
function collectTargets(appPath) {
  const targets = [];
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');

  if (fs.existsSync(frameworks)) {
    for (const entry of fs.readdirSync(frameworks)) {
      const full = path.join(frameworks, entry);

      if (entry.endsWith('.framework')) {
        // Внутренние библиотеки фреймворка идут раньше самого фреймворка
        const libs = path.join(full, 'Versions', 'A', 'Libraries');
        if (fs.existsSync(libs)) {
          for (const lib of fs.readdirSync(libs)) {
            if (lib.endsWith('.dylib')) targets.push(path.join(libs, lib));
          }
        }
        const helpers = path.join(full, 'Versions', 'A', 'Helpers');
        if (fs.existsSync(helpers)) {
          for (const h of fs.readdirSync(helpers)) targets.push(path.join(helpers, h));
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
