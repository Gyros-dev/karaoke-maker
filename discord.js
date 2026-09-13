#!/usr/bin/env node
/* ============================================================
   Сводка в Discord.

   То же самое, что печатает npm run stats, только раз в сутки и
   в канал. Числа берутся из тех же мест, что и в терминале:
   посещения — goatcounter.js, скачивания — releases.js. Это важнее,
   чем кажется: если бы канал считал по-своему, рано или поздно
   он разошёлся бы со сводкой, и было бы непонятно, кому верить.

   Два дела:
     node discord.js сводка          — за сутки: посещения и скачивания
     node discord.js выпуск v1.34.0  — объявить новый выпуск

   Куда слать — в DISCORD_WEBHOOK (адрес вебхука канала). Это ключ
   на запись в канал, поэтому он живёт в секретах репозитория и
   в код не попадает никогда. БЕЗ НЕГО КОМАНДА НЕ ПАДАЕТ: печатает
   то, что отправила бы, — так её и проверяют руками.

   Разницу со вчера («+3 за сутки») хранить негде: GitHub отдаёт
   только общую сумму. Поэтому прошлое число кладётся в .digest-state.json
   рядом, а в работе по расписанию этот файл переживает запуски
   в кэше GitHub Actions. Нет файла — просто не будет разницы,
   и это не беда.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const счётчик = require('./goatcounter.js');
const { собрать, апи, РЕПО } = require('./releases.js');

const ДЕЛО = process.argv[2] || 'сводка';
const ТЕГ = process.argv[3] || process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || '';
const ВЕБХУК = (process.env.DISCORD_WEBHOOK || '').trim();
const ПАМЯТЬ = path.join(__dirname, '.digest-state.json');
/* Фирменный зелёный — тот самый, что человек назвал числом: 3513454. */
const ЦВЕТ = 3513454;
const САЙТ = 'https://karaokepunch.ru';

/* ---------- Память о прошлом запуске ---------- */

function прошлое() {
  try {
    return JSON.parse(fs.readFileSync(ПАМЯТЬ, 'utf8'));
  } catch (e) {
    return null;
  }
}

function запомнить(что) {
  try {
    fs.writeFileSync(ПАМЯТЬ, JSON.stringify(что, null, 1) + '\n');
  } catch (e) {
    console.log('память не записалась: ' + ((e && e.message) || e));
  }
}

/* ---------- Отправка ---------- */

async function отправить(письмо) {
  if (!ВЕБХУК) {
    console.log('DISCORD_WEBHOOK не задан — вот что ушло бы в канал:\n');
    console.log(JSON.stringify(письмо, null, 2));
    return;
  }
  const r = await fetch(ВЕБХУК, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(письмо),
  });
  if (!r.ok) {
    const текст = await r.text().catch(() => '');
    throw new Error('Discord ответил ' + r.status + ' ' + текст.slice(0, 200));
  }
  console.log('Отправлено в канал.');
}

function знак(число) {
  return число > 0 ? '+' + число : String(число);
}

/* «1 раз», «2 раза», «5 раз». Мелочь, но сводку читают каждый день,
   и «скачан 43 раз» мозолит глаз. */
function разов(n) {
  const сто = n % 100;
  const десять = n % 10;
  if (сто >= 11 && сто <= 14) return 'раз';
  if (десять === 1) return 'раз';
  if (десять >= 2 && десять <= 4) return 'раза';
  return 'раз';
}

/* ---------- Сводка за сутки ---------- */

async function сводка() {
  const сутки = await счётчик.посещенияЗа(1);
  const неделя = await счётчик.посещенияЗа(7);
  const { строки, итогПоПлатформам, всего } = await собрать();
  const последний = строки[строки.length - 1];

  const было = прошлое();
  const разница = было && typeof было.всего === 'number' ? всего - было.всего : null;

  const посещения = сутки.беда
    ? 'счётчик молчит: ' + сутки.беда
    : `за сутки **${сутки.total}**` + (неделя.беда ? '' : ` · за неделю ${неделя.total}`);

  const поПлатформам = [...итогПоПлатформам.entries()]
    .filter(([кто]) => кто !== 'прочее')
    .sort((a, b) => b[1] - a[1])
    .map(([кто, н]) => `${кто}: ${н}`)
    .join(' · ');

  const скачивания = (разница === null ? '' : `**${знак(разница)}** за сутки · `)
    + `всего **${всего}**\n${поПлатформам}`;

  const поля = [
    { name: 'Посещения сайта', value: посещения },
    { name: 'Скачивания установщиков', value: скачивания },
  ];
  if (последний) {
    поля.push({
      name: 'Последний выпуск',
      value: `[${последний.версия}](https://github.com/${РЕПО}/releases/tag/${последний.тег})`
        + ` от ${последний.дата} · скачан ${последний.вВыпуске} ${разов(последний.вВыпуске)}`,
    });
  }

  await отправить({
    username: 'Karaoke Punch',
    embeds: [{
      title: 'Сводка за сутки',
      url: САЙТ,
      color: ЦВЕТ,
      fields: поля,
      footer: { text: new Date().toISOString().slice(0, 10) },
    }],
  });

  запомнить({ всего, когда: new Date().toISOString() });
}

/* ---------- Новый выпуск ---------- */

async function выпуск() {
  if (!ТЕГ) throw new Error('не сказано, какой выпуск объявлять (тег)');
  const рел = await апи('/releases/tags/' + encodeURIComponent(ТЕГ));
  const версия = (рел.tag_name || ТЕГ).replace(/^v/, '');

  /* Заметки к выпуску длинные, а в карточке нужен смысл, а не всё
     подряд: берём начало до первого заголовка «## Что скачивать». */
  let заметки = String(рел.body || '').split('## Что скачивать')[0].trim();
  if (заметки.length > 900) заметки = заметки.slice(0, 900).trim() + '…';

  const файлы = (рел.assets || [])
    .filter((a) => /\.(dmg|exe)$/.test(a.name))
    .map((a) => {
      const кто = /\.exe$/.test(a.name) ? 'Windows'
        : (/arm64/.test(a.name) ? 'macOS (Apple Silicon)' : 'macOS (Intel)');
      return `[${кто}](${a.browser_download_url})`;
    })
    .join(' · ');

  await отправить({
    username: 'Karaoke Punch',
    embeds: [{
      title: 'Вышла версия ' + версия,
      url: рел.html_url,
      color: ЦВЕТ,
      description: заметки || 'Заметок к выпуску нет.',
      fields: файлы ? [{ name: 'Скачать', value: файлы }] : [],
      footer: { text: САЙТ.replace('https://', '') },
    }],
  });
}

(async () => {
  if (ДЕЛО === 'выпуск') await выпуск();
  else await сводка();
})().catch((e) => {
  console.error('Не вышло: ' + ((e && e.message) || e));
  process.exit(1);
});
