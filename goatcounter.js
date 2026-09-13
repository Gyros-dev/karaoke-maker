/* ============================================================
   Счётчик посещений — разговор с ним одним местом.

   Спрашивают двое: stats.js (печатает сводку в терминал) и discord.js
   (шлёт её в канал). Как и со скачиваниями, число должно считаться
   в одном месте, иначе два похожих разойдутся и никто не заметит,
   какое из них врёт.

   Про сам счётчик — README, раздел «Счётчик посещений».
   ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');

const КОРЕНЬ = __dirname;

/* Адрес счётчика — из разметки сайта. Если счётчик оттуда убрали,
   значит и считать нечего: так и скажем, а не станем стучаться
   в заведомо мёртвый адрес. */
function адрес() {
  try {
    const html = fs.readFileSync(path.join(КОРЕНЬ, 'index.html'), 'utf8');
    const м = /data-goatcounter="(https:\/\/[^/"]+)\/count"/.exec(html);
    return м ? м[1] : null;
  } catch (e) {
    return null;
  }
}

/* Ключ: из окружения (так его даёт GitHub Actions) или из файла рядом
   с настройками. В репозиторий он не кладётся никогда. */
function ключ() {
  if (process.env.GOATCOUNTER_TOKEN) return process.env.GOATCOUNTER_TOKEN.trim();
  const файл = path.join(os.homedir(), '.config', 'karaoke-punch', 'goatcounter');
  try {
    return fs.readFileSync(файл, 'utf8').trim() || null;
  } catch (e) {
    return null;
  }
}

/* Границы отрезка. Счётчик просит время, округлённое до часа,
   и понимает только UTC. */
function отрезок(днейНазад) {
  const конец = new Date();
  конец.setUTCMinutes(0, 0, 0);
  const начало = new Date(конец);
  начало.setUTCDate(начало.getUTCDate() - днейНазад);
  начало.setUTCHours(0, 0, 0, 0);
  return `start=${начало.toISOString()}&end=${конец.toISOString()}`;
}

/* Любая беда возвращается ответом, а не падением: и сводка в терминале,
   и сводка в канале — дело справочное, ронять их из-за счётчика нельзя.
   Ключ с кириллицей, например, роняет сам fetch: в заголовок нельзя
   положить букву старше 255. */
async function спросить(путь) {
  const где = адрес();
  const токен = ключ();
  if (!где) return { беда: 'счётчика нет в index.html' };
  if (!токен) return { нетКлюча: true, беда: 'ключа нет' };
  try {
    const r = await fetch(где + '/api/v0' + путь, {
      headers: { Authorization: 'Bearer ' + токен },
    });
    if (r.status === 401 || r.status === 403) {
      return { беда: 'ключ не подошёл (нужен token с правом «Read statistics»)' };
    }
    if (!r.ok) return { беда: 'счётчик ответил ' + r.status + ' на ' + путь };
    return await r.json();
  } catch (e) {
    const текст = (e && e.message) || String(e);
    if (/ByteString|character at index/.test(текст)) {
      return { беда: 'ключ никуда не годится: в нём есть буквы вне латиницы' };
    }
    return { беда: 'до счётчика не достучаться (' + текст + ')' };
  }
}

/* Сколько посетителей за столько-то последних дней. */
function посещенияЗа(дней) {
  return спросить('/stats/total?' + отрезок(дней));
}

function страницы(дней, сколько) {
  return спросить('/stats/hits?' + отрезок(дней) + '&limit=' + (сколько || 10));
}

module.exports = { адрес, ключ, отрезок, спросить, посещенияЗа, страницы };
