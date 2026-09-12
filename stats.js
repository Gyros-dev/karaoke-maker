#!/usr/bin/env node
/* ============================================================
   Сводка: кто приходит и кто забирает.

   Два числа про одно и то же дело, но разной честности.

   ПОСЕЩЕНИЯ считает GoatCounter — счётчик на странице сайта. Он
   не ставит куков, не снимает отпечаток браузера и не хранит адрес
   посетителя, поэтому «посетитель» у него — это оценка по дню, а
   не человек, которого узнают из раза в раз. В приложении счётчика
   нет вовсе (см. README, «Счётчик посещений»).

   СКАЧИВАНИЯ считает сам GitHub — их печатает downloads.js, и эта
   команда просто зовёт его следом, чтобы не держать одно и то же
   в двух местах. Число честнее посещений: человек не просто зашёл,
   а забрал программу. Оговорки — в шапке downloads.js.

   Адрес счётчика берётся из index.html: там он прописан один раз,
   и раздваивать его здесь незачем.

   Запуск:  npm run stats
            node stats.js 30        — глубина в днях (по умолчанию 30)

   Ключ к счётчику нужен только для посещений. Берётся из окружения
   (GOATCOUNTER_TOKEN) или из файла ~/.config/karaoke-punch/goatcounter.
   Завести: в панели счётчика верхнее меню (своя почта) → «API» →
   «Add token» с правом «Read statistics». Без ключа команда просто
   покажет скачивания.
   ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ГЛУБИНА = Math.min(Math.max(Number(process.argv[2]) || 30, 1), 365);
const КОРЕНЬ = __dirname;

/* ---------- Откуда считать ---------- */

/* Адрес счётчика — из разметки сайта. Если счётчик оттуда убрали,
   значит и считать нечего: так и скажем, а не станем стучаться
   в заведомо мёртвый адрес. */
function адресСчётчика() {
  const html = fs.readFileSync(path.join(КОРЕНЬ, 'index.html'), 'utf8');
  const м = /data-goatcounter="(https:\/\/[^/"]+)\/count"/.exec(html);
  return м ? м[1] : null;
}

function ключ() {
  if (process.env.GOATCOUNTER_TOKEN) return process.env.GOATCOUNTER_TOKEN.trim();
  const файл = path.join(os.homedir(), '.config', 'karaoke-punch', 'goatcounter');
  try {
    return fs.readFileSync(файл, 'utf8').trim() || null;
  } catch (e) {
    return null;
  }
}

/* ---------- Разговор со счётчиком ---------- */

/* Любая беда возвращается ответом, а не падением: команда справочная,
   и получить трассировку вместо чисел — худшее, что она может сделать.
   Ключ с кириллицей, например, роняет сам fetch: в заголовок нельзя
   положить букву старше 255. */
async function спросить(адрес, путь, токен) {
  try {
    const r = await fetch(адрес + '/api/v0' + путь, {
      headers: { Authorization: 'Bearer ' + токен, 'Content-Type': 'application/json' },
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

/* Полоска из палочек: по ней видно форму недели, а точные числа
   стоят рядом. Восемь ступеней — больше в терминале не различить. */
const СТУПЕНИ = ['·', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
function полоска(значение, макс) {
  if (!макс) return СТУПЕНИ[0];
  const доля = значение / макс;
  return СТУПЕНИ[Math.min(СТУПЕНИ.length - 1, Math.round(доля * (СТУПЕНИ.length - 1)))];
}

async function посещения() {
  const адрес = адресСчётчика();
  if (!адрес) {
    console.log('Счётчика в index.html нет — посещения считать нечем.\n');
    return;
  }
  const токен = ключ();
  if (!токен) {
    console.log('ПОСЕЩЕНИЯ САЙТА');
    console.log('  Ключа нет, поэтому числа не спрошены.');
    console.log('  Завести: ' + адрес + ' → «API» в верхнем меню → создать');
    console.log('  token с правом «Read statistics» и положить его в файл');
    console.log('  ~/.config/karaoke-punch/goatcounter (или в GOATCOUNTER_TOKEN).\n');
    return;
  }

  const за = async (дней) => {
    const о = await спросить(адрес, '/stats/total?' + отрезок(дней), токен);
    return о && !о.беда ? о : { беда: (о && о.беда) || 'пусто' };
  };

  const месяц = await за(ГЛУБИНА);
  if (месяц.беда) {
    console.log('ПОСЕЩЕНИЯ САЙТА');
    console.log('  Не вышло спросить: ' + месяц.беда + '\n');
    return;
  }
  const неделя = await за(7);
  const сутки = await за(1);

  console.log('ПОСЕЩЕНИЯ САЙТА  (' + адрес.replace('https://', '') + ')');
  console.log('  за сутки:     ' + (сутки.беда ? '—' : сутки.total));
  console.log('  за 7 дней:    ' + (неделя.беда ? '—' : неделя.total));
  console.log(`  за ${ГЛУБИНА} дней:   ` + месяц.total);

  /* По дням — только последняя неделя: месяц столбцом в терминале
     читается хуже, чем не читается вовсе. */
  const поДням = [];
  for (const с of месяц.stats || []) {
    const сумма = Array.isArray(с.hourly)
      ? с.hourly.reduce((a, b) => a + b, 0)
      : (с.daily || 0);
    поДням.push({ день: с.day, сколько: сумма });
  }
  const хвост = поДням.slice(-7);
  if (хвост.length) {
    const макс = Math.max(...хвост.map((д) => д.сколько), 0);
    console.log('  по дням:');
    for (const д of хвост) {
      console.log('    ' + д.день + '  ' + полоска(д.сколько, макс) + '  ' + д.сколько);
    }
  }

  /* Страницы. У сайта она одна, но счётчик видит и якоря, и чужие
     адреса, которыми к нам приходят, — если вдруг завелась вторая,
     это надо заметить. */
  const страницы = await спросить(адрес,
    '/stats/hits?' + отрезок(ГЛУБИНА) + '&limit=10', токен);
  if (страницы && !страницы.беда && Array.isArray(страницы.hits) && страницы.hits.length) {
    console.log('  страницы:');
    for (const h of страницы.hits.slice(0, 5)) {
      console.log('    ' + (h.path || '/') + '  ' + (h.count || 0));
    }
  }
  console.log('');
}

/* ---------- Скачивания: зовём того, кто это уже умеет ---------- */

function скачивания() {
  console.log('СКАЧИВАНИЯ УСТАНОВЩИКОВ');
  try {
    execFileSync('node', [path.join(КОРЕНЬ, 'downloads.js'), 'кратко'], { stdio: 'inherit' });
  } catch (e) {
    console.log('  downloads.js не отработал — запусти его отдельно и посмотри, почему.');
  }
}

(async () => {
  console.log('');
  await посещения();
  скачивания();
})().catch((e) => {
  console.error('Сводка не собралась: ' + ((e && e.message) || e));
  process.exit(1);
});
