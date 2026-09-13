/* ============================================================
   Выпуски и их скачивания — одним местом.

   Число «сколько скачали» спрашивают двое: downloads.js (печатает
   человеку в терминал) и discord.js (шлёт сводку в канал). Считать
   его в двух местах нельзя: разойдутся — и никто не заметит, какое
   из двух врёт. Поэтому вся работа с GitHub живёт здесь, а те двое
   только по-разному показывают одно и то же.

   Наружу отдаётся через module.exports — файл запускают только из
   Node, в окно студии он не попадает.
   ============================================================ */

const https = require('https');
const { execFileSync } = require('child_process');

const РЕПО = 'Gyros-dev/karaoke-maker';

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

function получить(url, ТОКЕН) {
  const заголовки = { 'User-Agent': 'karaoke-punch' };
  if (ТОКЕН) заголовки.Authorization = 'Bearer ' + ТОКЕН;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: заголовки }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return получить(res.headers.location, ТОКЕН).then(resolve, reject);
      }
      const куски = [];
      res.on('data', (c) => куски.push(c));
      res.on('end', () => resolve({ код: res.statusCode, тело: Buffer.concat(куски) }));
    }).on('error', reject);
  });
}

/* Файл выпуска — это либо установщик, либо служебная опись. Считаем
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

/* Всё о выпусках: список по версиям (от старых к новым), итоги
   по платформам и общее число. Беды не глотаем — бросаем с понятным
   текстом: наверху решат, печатать его или молчать. */
async function собрать(толькоВерсия) {
  const ТОКЕН = токен();
  const выпуски = [];
  /* Выпусков у нас десятки, а страница по умолчанию — тридцать штук:
     без разбивки по страницам старые молча выпали бы из счёта. */
  for (let стр = 1; стр <= 10; стр++) {
    const r = await получить(
      `https://api.github.com/repos/${РЕПО}/releases?per_page=100&page=${стр}`, ТОКЕН);
    if (r.код === 403 || r.код === 429) {
      const беда = new Error('GitHub не отвечает по пределу запросов'
        + (ТОКЕН ? '' : ' (токена нет — возьми его из GITHUB_TOKEN или git credential)'));
      беда.предел = true;
      throw беда;
    }
    if (r.код !== 200) throw new Error(`GitHub ответил ${r.код}`);
    const кусок = JSON.parse(r.тело.toString());
    выпуски.push(...кусок);
    if (кусок.length < 100) break;
  }

  const итогПоПлатформам = new Map();
  const строки = [];
  let всего = 0;
  let описи = 0;

  for (const рел of выпуски.slice().reverse()) {
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
      тег: рел.tag_name,
      дата: (рел.published_at || '').slice(0, 10),
      вВыпуске,
      поПлатформам,
      разбивка: [...поПлатформам.entries()]
        .map(([к, н]) => `${к}: ${н}`).join(', ') || '—',
    });
  }

  return { строки, итогПоПлатформам, всего, описи };
}

/* Разовый вопрос к GitHub — для тех, кому нужен не счёт, а сам
   выпуск: заметки, ссылки на файлы. Отдельной дверцей, чтобы токен
   и разбор ответа не заводились вторым местом. */
async function апи(путь) {
  const r = await получить('https://api.github.com/repos/' + РЕПО + путь, токен());
  if (r.код !== 200) throw new Error('GitHub ответил ' + r.код + ' на ' + путь);
  return JSON.parse(r.тело.toString());
}

module.exports = { собрать, ктоЭто, апи, РЕПО };
