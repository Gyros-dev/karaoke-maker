#!/usr/bin/env node
/* ============================================================
   Сколько раз скачали приложение.

   GitHub считает каждое скачивание файла из релиза и отдаёт число
   в поле download_count. Это ЕДИНСТВЕННОЕ, что можно узнать честно:
   ни сервера, ни счётчиков в приложении у нас нет и заводить их
   мы не собираемся — вся затея в том, что файлы никуда не уходят.

   Чего это число НЕ говорит:
   * не «сколько людей» — один человек, скачавший установщик дважды
     (или обновивший приложение), считается дважды;
   * докачки автообновления сюда тоже попадают: electron-updater
     берёт latest.yml и установщик из того же релиза, поэтому у свежих
     версий Windows-установщик обычно «скачан» чаще, чем его брали
     руками с сайта;
   * роботы, зеркала и поисковики считаются наравне с людьми.

   Запуск:  node downloads.js            — по версиям и итог
            node downloads.js 1.21.0     — только эта версия
   ============================================================ */

const https = require('https');
const { execFileSync } = require('child_process');

const РЕПО = 'Gyros-dev/karaoke-maker';
const толькоВерсия = process.argv[2];

/* Токен нужен не для прав, а ради предела запросов: без него GitHub
   даёт шестьдесят обращений в час на адрес. Берём из окружения, а если
   там пусто — у самого git. На диск он при этом не попадает. */
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
  const заголовки = { 'User-Agent': 'karaoke-punch-downloads' };
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

/* Файл релиза — это либо установщик, либо служебная опись. Считаем
   отдельно: опись скачивает автообновление, человек её не видит,
   и складывать её со скачиваниями установщика значило бы врать
   в большую сторону. */
function ктоЭто(имя) {
  if (/Windows-Setup\.exe$/.test(имя)) return 'Windows';
  if (/macOS-arm64\.dmg$/.test(имя)) return 'macOS (Apple Silicon)';
  if (/macOS-x64\.dmg$/.test(имя)) return 'macOS (Intel)';
  if (/\.blockmap$/.test(имя) || /^latest.*\.yml$/.test(имя)) return null;
  return 'прочее';
}

(async () => {
  /* Релизов у нас десятки, а страница по умолчанию — тридцать штук:
     без разбивки по страницам старые выпуски молча выпали бы из счёта,
     и итог оказался бы меньше настоящего. */
  const релизы = [];
  for (let стр = 1; стр <= 10; стр++) {
    const r = await получить(
      `https://api.github.com/repos/${РЕПО}/releases?per_page=100&page=${стр}`);
    if (r.код === 403 || r.код === 429) {
      console.error('GitHub не отвечает по пределу запросов'
        + (ТОКЕН ? '' : ' (токена нет — возьми его из GITHUB_TOKEN или git credential)')
        + '. Повтори позже.');
      process.exit(2);
    }
    if (r.код !== 200) {
      console.error(`GitHub ответил ${r.код}`);
      process.exit(1);
    }
    const кусок = JSON.parse(r.тело.toString());
    релизы.push(...кусок);
    if (кусок.length < 100) break;
  }

  const итогПоПлатформам = new Map();
  let всего = 0;
  let описи = 0;
  const строки = [];

  for (const рел of релизы.slice().reverse()) {
    const версия = (рел.tag_name || '').replace(/^v/, '');
    if (толькоВерсия && версия !== толькоВерсия) continue;
    const поПлатформам = new Map();
    let вВыпуске = 0;
    for (const файл of рел.assets || []) {
      const кто = ктоЭто(файл.name);
      if (!кто) { описи += файл.download_count; continue; }
      поПлатформам.set(кто, (поПлатформам.get(кто) || 0) + файл.download_count);
      итогПоПлатформам.set(кто, (итогПоПлатформам.get(кто) || 0) + файл.download_count);
      вВыпуске += файл.download_count;
      /* В итог установщиков идут только установщики. В хранилище лежит
         ещё зеркало весов модели — его качает приложение, а не человек,
         и складывать одно с другим значило бы завысить счёт. */
      if (кто !== 'прочее') всего += файл.download_count;
    }
    if (!рел.assets || !рел.assets.length) continue;
    строки.push({
      версия: версия + (рел.prerelease ? ' (предварительный)' : ''),
      дата: (рел.published_at || '').slice(0, 10),
      вВыпуске,
      разбивка: [...поПлатформам.entries()]
        .map(([к, н]) => `${к}: ${н}`).join(', ') || '—',
    });
  }

  if (!строки.length) {
    console.log(толькоВерсия ? `Выпуска ${толькоВерсия} нет` : 'Выпусков нет');
    return;
  }

  const ш = Math.max(...строки.map((с) => с.версия.length), 7);
  console.log('Версия'.padEnd(ш) + '  Дата        Всего  Разбивка');
  for (const с of строки) {
    console.log(с.версия.padEnd(ш) + '  ' + с.дата.padEnd(10)
      + '  ' + String(с.вВыпуске).padStart(5) + '  ' + с.разбивка);
  }

  console.log('');
  console.log('Скачиваний установщиков всего: ' + всего);
  for (const [кто, н] of [...итогПоПлатформам.entries()].sort((a, b) => b[1] - a[1])) {
    if (кто === 'прочее') continue;
    console.log('  ' + кто + ': ' + н);
  }
  const прочее = итогПоПлатформам.get('прочее') || 0;
  if (прочее) {
    console.log('Прочие файлы (зеркало весов модели — их берёт приложение): ' + прочее);
  }
  console.log('Служебные файлы (описи и блок-карты, их берёт автообновление): ' + описи);
  console.log('');
  console.log('Это ЧИСЛО СКАЧИВАНИЙ, а не число людей: повторные загрузки,');
  console.log('обновления и роботы считаются наравне. Сколько человек —');
  console.log('GitHub не показывает никому, включая нас.');
})().catch((e) => {
  console.error('Не вышло: ' + ((e && e.message) || e));
  process.exit(1);
});
