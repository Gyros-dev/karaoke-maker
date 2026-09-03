#!/usr/bin/env node
/* ============================================================
   Проверка выложенного релиза: всё ли на месте для обновления.

   Беда, ради которой это написано. В релиз 1.16.0 уехали три
   установщика — и ни одного файла ОПИСИ. А electron-updater смотрит
   не на установщики, а на latest.yml: нет его — обновления как бы
   и нет вовсе. Приложение на Windows честно сказало «Не удалось
   обновиться автоматически», и узнали мы об этом от человека,
   у которого оно стоит, через несколько часов после выпуска.

   Молчаливая беда: сайт при этом показывает новую версию, ссылки
   на скачивание работают, всё выглядит выпущенным.

   Запуск:  node check-release.js 1.16.0
   ============================================================ */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const РЕПО = 'Gyros-dev/karaoke-maker';
const версия = process.argv[2];
if (!версия) {
  console.error('Укажи версию: node check-release.js 1.16.0');
  process.exit(2);
}

/* Токен нужен не для прав, а ради предела запросов: без него GitHub
   даёт шестьдесят обращений в час на адрес, и проверка после выпуска —
   когда обращений уже наделано — упирается в 403. Берём из окружения,
   а если там пусто — у самого git, тем же путём, каким выкладывается
   релиз. На диск он при этом не попадает. */
function токен() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const ответ = execFileSync('git', ['credential', 'fill'],
      { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
    const m = /^password=(.*)$/m.exec(ответ);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}
const ТОКЕН = токен();

function получить(url) {
  const заголовки = { 'User-Agent': 'karaoke-punch-release-check' };
  if (ТОКЕН) заголовки.Authorization = 'Bearer ' + ТОКЕН;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: заголовки }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return получить(res.headers.location).then(resolve, reject);
      }
      const куски = [];
      res.on('data', (c) => куски.push(c));
      res.on('end', () => resolve({ код: res.statusCode, тело: Buffer.concat(куски) }));
    }).on('error', reject);
  });
}

(async () => {
  const беды = [];
  const скажи = (ок, текст) => {
    console.log((ок ? '  ✓ ' : '  ✗ ') + текст);
    if (!ок) беды.push(текст);
  };

  const r = await получить(`https://api.github.com/repos/${РЕПО}/releases/tags/v${версия}`);
  /* Предел запросов — это НЕ «релиза нет». Разница важная: на 403
     проверку надо повторить, а на 404 — бежать доделывать выпуск.
     Один раз перепутав, я уже сказал «релиза нет» про выложенный
     релиз, и это худший вид вранья — уверенный. */
  if (r.код === 403 || r.код === 429) {
    console.error('GitHub не отвечает по пределу запросов'
      + (ТОКЕН ? '' : ' (токена нет — возьми его из GITHUB_TOKEN или git credential)')
      + '. Это не значит, что с релизом что-то не так: повтори позже.');
    process.exit(2);
  }
  if (r.код !== 200) {
    console.error(`Релиза v${версия} на GitHub нет (${r.код})`);
    process.exit(1);
  }
  const релиз = JSON.parse(r.тело.toString());
  const имена = релиз.assets.map((a) => a.name);
  console.log(`Релиз v${версия}: ${имена.length} файлов`);

  /* Установщики: то, за чем приходит человек. Windows-сборка одна
     на x64 и ARM, у macOS отдельные для Apple Silicon и Intel. */
  скажи(имена.includes(`Karaoke-Punch-${версия}-Windows-Setup.exe`), 'установщик Windows');
  скажи(имена.includes(`Karaoke-Punch-${версия}-macOS-arm64.dmg`), 'образ macOS (Apple Silicon)');

  /* Опись для electron-updater. Без неё обновление не работает вовсе,
     и приложение говорит «Не удалось обновиться автоматически».
     Блок-карта — для докачки по частям; без неё обновление скачается
     целиком, это не беда, но и класть её ничего не стоит. */
  скажи(имена.includes('latest.yml'), 'latest.yml — опись для автообновления');
  скажи(имена.includes(`Karaoke-Punch-${версия}-Windows-Setup.exe.blockmap`), 'блок-карта установщика');
  скажи(!релиз.draft && !релиз.prerelease, 'релиз не черновик и не предварительный');

  if (имена.includes('latest.yml')) {
    const y = await получить(`https://github.com/${РЕПО}/releases/latest/download/latest.yml`);
    const текст = y.тело.toString();
    скажи(y.код === 200, 'latest.yml отдаётся по ссылке «latest» (её и спрашивает приложение)');
    скажи(new RegExp(`^version:\\s*${версия.replace(/\./g, '\\.')}\\s*$`, 'm').test(текст),
      `в latest.yml записана версия ${версия}`);

    /* Сверяем отпечаток описи с настоящим файлом сборки: разошлись —
       значит, к релизу приложили установщик от одной сборки, а опись
       от другой, и обновление сорвётся уже на проверке подписи. */
    const местный = path.join(__dirname, 'desktop', 'dist',
      `Karaoke-Punch-${версия}-Windows-Setup.exe`);
    if (fs.existsSync(местный)) {
      const свой = crypto.createHash('sha512').update(fs.readFileSync(местный)).digest('base64');
      const вОписи = (/^sha512:\s*(\S+)/m.exec(текст) || [])[1];
      скажи(свой === вОписи, 'отпечаток в latest.yml совпал с собранным установщиком');
    } else {
      console.log('  · установщика нет рядом — отпечаток не с чем сверить');
    }
  }

  console.log(беды.length ? `\nНе в порядке: ${беды.length}` : '\nВсё на месте.');
  process.exit(беды.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
