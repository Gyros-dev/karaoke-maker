/* ============================================================
   Караоке Студия — вся обработка звука происходит в браузере
   ============================================================ */

const $ = (id) => document.getElementById(id);

/* Версия студии — сверяется с version.json, чтобы предупредить,
   что браузер показывает устаревшую копию из кэша */
const APP_VERSION = '1.8.4';

/* ---------- Модификатор в подписях горячих клавиш ----------
   Сами клавиши код ловит одинаково (metaKey || ctrlKey), а вот подписи
   обязаны совпадать с клавиатурой: на Маке это Cmd, на Windows и Linux —
   Ctrl. В приложении систему называет мостик (preload.js), на сайте
   приходится верить браузеру. */
const НА_МАКЕ = (() => {
  const своя = window.desktop && window.desktop.platform;
  if (своя) return своя === 'darwin';
  const данные = navigator.userAgentData;
  if (данные && данные.platform) return /mac/i.test(данные.platform);
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
})();
const МОД = НА_МАКЕ ? 'Cmd' : 'Ctrl';

/* Расставляет модификатор по странице. В тексте под него оставлены
   пустые <span class="mod-key">, в подсказках кнопок — data-mod-title,
   где «%s» стоит на месте модификатора (в title разметку не положишь). */
function расставитьМодификаторы(корень = document) {
  корень.querySelectorAll('.mod-key').forEach((el) => { el.textContent = МОД; });
  корень.querySelectorAll('[data-mod-title]').forEach((el) => {
    el.title = el.dataset.modTitle.split('%s').join(МОД);
  });
}

/* ---------- Состояние ---------- */
const state = {
  fileName: null,
  originalBuffer: null,     // AudioBuffer исходной песни
  instrumentalBuffer: null, // AudioBuffer с приглушённым вокалом (null для моно)
  lines: [],                // [{ text, time|null, end:number|null }]
  origSpans: [],            // отрезки, где вместо минусовки звучит оригинал
  vocalMix: 0,              // 0..1 — громкость вокала в караоке
  bgImage: null,            // dataURL картинки-фона для караоке
  eq: { low: 0, mid: 0, high: 0 }, // эквалайзер, дБ (−12…+12)
  customInst: false,        // минусовка загружена файлом, а не посчитана
  instName: null,
  style: null,              // оформление текста, задаётся в defaultStyle()
  maxStep: 1,
};

function defaultStyle() {
  return {
    font: 'system',
    /* Размер — проценты от ЗАПОЛНЯЮЩЕГО кегля, при котором самая
       длинная строка встаёт во всю ширину сцены. Поэтому умолчание
       100% и есть «максимально крупно»: больше — уже с переносом
       строк на два ряда. */
    size: 100,
    weight: 600,
    effect: 'fill',     // fill | highlight | none
    inactive: '#9a9ab0',
    active: '#f2f2f7',
    accent: '#f97316',
    outlineColor: '#000000',
    outline: 0,         // px
    bgMode: 'default',  // default | color
    bgColor: '#16161f',
    letter: 0,          // px
    line: 13,           // ×0.1 — межстрочный интервал
    lines: 7,           // сколько строк видно
    pad: 0,             // поля по краям сцены, % — 0 растягивает текст во всю ширину
    swapLines: false,   // строки поднимаются вверх по мере пения
    posCurrent: 40,     // где стоит первая строка, % от верха (когда не меняются местами)
    posNext: 60,        // где стоит вторая строка
    anim: 'fade',       // fade | slide | none
    valign: 'center',   // flex-start | center | flex-end
    dim: 45,            // прозрачность неактивных строк, % (размер не меняется)
    blur: 0,            // лёгкое размытие неактивных строк, px
    scrim: 100,         // подложка-градиент под текстом поверх картинки, %
    countdown: true,    // отсчёт из трёх точек перед вступлением строки
  };
}
state.style = defaultStyle();

/* ---------- Перенос старых проектов ----------
   Беда, которую это лечит: настройка, записанная в проект автосохранением,
   навсегда перебивала новое умолчание. Человек галку не трогал — она просто
   была умолчанием и молча уехала в проект, — а после обновления студии
   старое значение продолжало применяться, и новое умолчание не доходило
   ни до кого.

   Поэтому проект хранит поколение оформления. Меняем какое-нибудь
   УМОЛЧАНИЕ — поднимаем STYLE_GEN и дописываем сюда запись: какие ключи
   и с каким прежним умолчанием надо забыть у проектов старее этого
   поколения. Забываем только значения, в точности равные прежнему
   умолчанию: их человек не выбирал. Всё, что он менял осознанно (цвета,
   шрифт, размеры, места строк), не равно умолчанию и переезжает как есть. */
const STYLE_GEN = 5;
const STYLE_MIGRATIONS = [
  // Поколение 1: «Строки меняются местами» перестала быть умолчанием
  { поколение: 1, прежниеУмолчания: { swapLines: true } },
  /* Поколение 2: размер по умолчанию стал максимальным. Прежние 100%
     были умолчанием, а не выбором человека, — и после починки ползунка
     оставили бы текст вдвое мельче, чем задумано. */
  { поколение: 2, прежниеУмолчания: { size: 100 } },
  /* Поколение 3: поля по краям по умолчанию нулевые — текст занимает
     всю ширину сцены. Прежние 8% никто не выбирал, это было умолчание. */
  { поколение: 3, прежниеУмолчания: { pad: 8 } },
  /* Поколение 4: размер стал долей заполняющего кегля, а не долей
     базового. Прежнее умолчание 220% в новом счёте означало бы текст
     вдвое шире сцены — забываем его. */
  { поколение: 4, прежниеУмолчания: { size: 220 } },
  /* Поколение 5: подложка под текстом по умолчанию во всю силу.
     Прежние 70% никто не выбирал — это было умолчание, а на светлых
     картинках текст с ним читался хуже, чем должен. */
  { поколение: 5, прежниеУмолчания: { scrim: 70 } },
];

/* Оформление из сохранённого проекта: сначала перенос, потом умолчания */
function styleFromSaved(saved) {
  const style = { ...(saved && saved.style) };
  const gen = +(saved && saved.styleGen) || 0;
  for (const m of STYLE_MIGRATIONS) {
    if (gen >= m.поколение) continue;   // это поколение проект уже пережил
    for (const [key, было] of Object.entries(m.прежниеУмолчания)) {
      if (style[key] === было) delete style[key];
    }
  }
  return { ...defaultStyle(), ...style };
}

/* Шрифты: только системные, чтобы сайт остался автономным */
const FONTS = {
  system: { label: 'Системный', css: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif' },
  impact: { label: 'Плакатный (Impact)', css: 'Impact, "Haettenschweiler", "Arial Narrow Bold", sans-serif' },
  arial: { label: 'Гротеск (Arial)', css: 'Arial, "Helvetica Neue", Helvetica, sans-serif' },
  verdana: { label: 'Широкий (Verdana)', css: 'Verdana, Geneva, sans-serif' },
  trebuchet: { label: 'Мягкий (Trebuchet)', css: '"Trebuchet MS", "Lucida Grande", sans-serif' },
  georgia: { label: 'Книжный (Georgia)', css: 'Georgia, "Times New Roman", serif' },
  courier: { label: 'Печатная машинка', css: '"Courier New", Courier, monospace' },
};

/* ---------- Где нужен оригинал с вокалом ----------

   В редакторе разметка ставится на слух по голосу: без вокала человек
   размечает вслепую, поэтому там по умолчанию звучит оригинал, а не
   минусовка. Гасится переключателем «слышу оригинал» в панели выбранной
   строки. Простукивание, разметка слов и кольцо требуют вокала всегда.

   Уходя с редактора, флаг сам возвращается в исходное: он считается
   заново при каждом запуске звука и при каждой смене шага. */
function редакторОткрыт() {
  const p = $('step-3');
  return !!p && p.classList.contains('active');
}

function нуженОригинал() {
  if (tap.active || wordTap.active) return true;
  if (!редакторОткрыт()) return false;
  return editor.loop || editor.hearVocal;
}

/* ---------- Сборка звуковой смеси ----------

   Одна и та же цепь звучит в трёх местах: в плеере, в записи видео
   и в самопроверке. Держим её здесь в одном экземпляре — иначе видео
   и проверка расходятся с тем, что человек слышит.

   Оригинал и минусовка идут каждый через своё усиление, дальше общий
   эквалайзер и лимитер. */
function собратьМикс(ctx) {
  const vocalGain = ctx.createGain();
  const instGain = ctx.createGain();
  const eqChain = buildEqChain(ctx);
  const limiter = makeLimiter(ctx);
  vocalGain.connect(eqChain.input);
  instGain.connect(eqChain.input);
  eqChain.output.connect(limiter);
  return { vocalGain, instGain, eqChain, output: limiter };
}

/* Громкости по положению ползунка. Правило одно на все три места:
   минусовки нет или нужен оригинал — звучит песня целиком; иначе
   крест-накрест, и на нуле от песни не остаётся ничего. */
function усиленияМикса(vocalMix, hasInst, forceVocal) {
  const v = forceVocal || !hasInst ? 1 : vocalMix;
  return { вокал: v, минусовка: hasInst ? 1 - v : 0 };
}

/* ---------- Отрезки, где звучит оригинал ----------

   Человек размечает на дорожке куски, в которых вместо минусовки
   должна звучать сама песня со словами: во вступлении «Кирпичей»
   поёт оригинал, а дальше поёт он сам. Нейросеть тут ни при чём —
   обе дорожки уже есть, отрезок только выбирает, какая играет.

   Источник переключается не перекоммутацией узлов, а расписанием на
   тех же двух усилениях, что и ползунок вокала. Поэтому одно и то же
   расписание годится и живому плееру, и OfflineAudioContext в
   экспорте: считает его одна функция — расхождению взяться неоткуда.

   ПРАВИЛО ГРОМКОСТИ. Внутри отрезка оригинал звучит целиком, как бы
   ни стоял ползунок «Вокал»: отрезок для того и ставится, чтобы
   услышать оригинальные слова. Снаружи ползунок работает как раньше.

   ПОЧЕМУ НЕ ЩЁЛКАЕТ. Оригинал ≈ минусовка + вокал, а усиления в
   перекрёстном затухании всё время дают в сумме единицу: вокал идёт
   вне→1, минусовка одновременно (1−вне)→0. Значит музыкальная часть
   на переходе не меняется вовсе, а голос вводится ровным линейным
   нарастанием за 50 мс. Скачку между соседними отсчётами взяться
   неоткуда — это проверяется числами в самопроверке. */
const ОТРЕЗОК_ФЕЙД = 0.05;   // перекрёстное затухание на границе, с
const ОТРЕЗОК_МИН = 0.2;     // короче отрезок не делаем

/* Отрезки в порядок: выкинуть вырожденные, отсортировать, слить
   наложенные и слишком близкие. Меньше двух затуханий между соседями
   не оставляем — иначе на стыке вышел бы дребезг вместо перехода. */
function нормОтрезки(spans, длина) {
  const предел = длина > 0 ? длина : Infinity;
  const годные = [];
  for (const s of spans || []) {
    const a = Math.max(0, Math.min(+s.start, +s.end));
    const b = Math.min(предел, Math.max(+s.start, +s.end));
    if (!Number.isFinite(a) || !Number.isFinite(b) || b - a < 0.01) continue;
    годные.push({ start: a, end: b });
  }
  годные.sort((p, q) => p.start - q.start);
  const итог = [];
  for (const s of годные) {
    const пред = итог[итог.length - 1];
    if (пред && s.start - пред.end < ОТРЕЗОК_ФЕЙД * 2) пред.end = Math.max(пред.end, s.end);
    else итог.push(s);
  }
  return итог;
}

/* Отрезки текущего проекта — всегда уже приведённые в порядок */
function отрезкиОригинала() {
  return state.origSpans || [];
}

/* Доля оригинала в момент t: 1 внутри отрезка, 0 снаружи, линейно
   между — это и есть перекрёстное затухание. Затухание лежит СНАРУЖИ
   отрезка (вход [start−f, start], выход [end, end+f]), поэтому всё,
   что человек отметил, звучит оригиналом целиком и без огрызков. */
function доляОригинала(t, spans) {
  const f = ОТРЕЗОК_ФЕЙД;
  for (const s of spans) {
    if (t <= s.start - f || t >= s.end + f) continue;
    if (t >= s.start && t <= s.end) return 1;
    if (t < s.start) return (t - (s.start - f)) / f;
    return 1 - (t - s.end) / f;
  }
  return 0;
}

/* Переломы расписания: начало и конец каждого затухания. Начало песни
   обрезаем нулём — до неё звука нет, а точки обязаны идти по возрастанию. */
function точкиОтрезков(spans) {
  const pts = [];
  for (const s of spans) {
    pts.push(Math.max(0, s.start - ОТРЕЗОК_ФЕЙД), s.start, s.end, s.end + ОТРЕЗОК_ФЕЙД);
  }
  return pts;
}

/* Расписание переключения источника на усилениях смеси.
   t0 — момент контекста, в который звучит нулевая секунда песни.
   Годится и живому контексту (t0 = audio.startedAt), и офлайнному
   (t0 = 0), и записи видео (t0 = момент запуска источников). */
function расписатьОтрезки(ctx, vGain, iGain, база, spans, t0) {
  const сейчас = ctx.currentTime;
  const от = сейчас - t0;   // какая секунда песни звучит прямо сейчас
  const пары = [
    [vGain.gain, база.вокал, 1],
    [iGain.gain, база.минусовка, 0],
  ];
  const знач = (доля, вне, внутри) => вне + (внутри - вне) * доля;
  for (const [param, вне, внутри] of пары) {
    param.cancelScheduledValues(сейчас);
    param.setValueAtTime(знач(доляОригинала(от, spans), вне, внутри), сейчас);
  }
  for (const t of точкиОтрезков(spans)) {
    if (t <= от) continue;
    const доля = доляОригинала(t, spans);
    for (const [param, вне, внутри] of пары) {
      param.linearRampToValueAtTime(знач(доля, вне, внутри), t0 + t);
    }
  }
}

/* ---------- Аудио-движок ---------- */
const audio = {
  ctx: null,
  sources: [],
  vocalGain: null,
  instGain: null,
  startedAt: 0,
  offset: 0,
  playing: false,
  forceVocal: false, // звучит оригинал с вокалом, а не минусовка
  stopAt: null,      // авто-пауза на этой секунде (прослушивание строки)
  onEnded: null,

  ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    // 'suspended' и сафариевский 'interrupted' — будим в обоих случаях
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    return this.ctx;
  },

  /* Если через полсекунды после запуска контекст так и не заиграл —
     браузер блокирует звук, говорим об этом прямо */
  checkAudible() {
    setTimeout(() => {
      if (this.playing && this.ctx && this.ctx.state !== 'running' && !this._warnedBlocked) {
        this._warnedBlocked = true;
        alert('Браузер блокирует звук на этом сайте.\n\n' +
          'Проверь:\n' +
          '• не заглушена ли вкладка (правый клик по вкладке → «Включить звук»);\n' +
          '• в Brave — нажми на значок льва и отключи Shields для этого сайта ' +
          '(строгая защита от фингерпринтинга глушит Web Audio);\n' +
          '• в Safari — Настройки → Веб-сайты → Автовоспроизведение: разреши для этого сайта.');
      }
    }, 600);
  },

  get duration() {
    return state.originalBuffer ? state.originalBuffer.duration : 0;
  },

  position() {
    if (!this.playing) return this.offset;
    return Math.min(this.ctx.currentTime - this.startedAt, this.duration);
  },

  /* Проиграть отрывок [from, to) с вокалом — чтобы услышать слова строки.
     Флаг ставим после play(): тот его сбрасывает, чтобы «принудительный
     вокал» не оставался включённым от прошлого прослушивания. */
  playSegment(from, to) {
    this.play(from);
    this.forceVocal = true;
    this.applyMix();
    this.stopAt = to;
  },

  endSegment() {
    this.pause();
    this.stopAt = null;
    this.restoreVocal();
  },

  /* Вернуть громкость вокала к той, что положена сейчас: после
     прослушивания отрывка, разметки слов или ухода с шага. Один вход
     вместо разбросанных по коду «forceVocal = false» — из-за них флаг
     раньше залипал и ползунок вокала в караоке будто не действовал. */
  restoreVocal() {
    const want = нуженОригинал();
    if (this.forceVocal === want) return;
    this.forceVocal = want;
    this.applyMix();
  },

  play(fromOffset) {
    this.stopSources();
    this.stopAt = null;
    // Громкость вокала при каждом запуске считаем заново: в редакторе
    // положен оригинал, в караоке — то, что выставлено ползунком
    this.forceVocal = нуженОригинал();
    const ctx = this.ensureCtx();
    this.offset = Math.max(0, Math.min(fromOffset ?? this.offset, this.duration));
    // Позиция у самого конца — начинаем сначала, иначе тишина
    if (this.offset >= this.duration - 0.05) this.offset = 0;

    const смесь = собратьМикс(ctx);
    this.vocalGain = смесь.vocalGain;
    this.instGain = смесь.instGain;
    this.eqChain = смесь.eqChain;
    const fade = ctx.createGain();
    смесь.output.connect(fade);
    fade.connect(ctx.destination);

    const orig = ctx.createBufferSource();
    orig.buffer = state.originalBuffer;
    orig.connect(this.vocalGain);
    this.sources = [orig];

    if (state.instrumentalBuffer) {
      const inst = ctx.createBufferSource();
      inst.buffer = state.instrumentalBuffer;
      inst.connect(this.instGain);
      this.sources.push(inst);
    }

    const t = ctx.currentTime + 0.03;
    // Убираем щелчок/искажение на самом старте трека от резкого скачка уровня.
    fade.gain.setValueAtTime(0, t);
    fade.gain.linearRampToValueAtTime(1, t + 0.012);
    this.sources.forEach((s) => s.start(t, this.offset));
    this.startedAt = t - this.offset;
    this.playing = true;
    /* Громкости расставляем ПОСЛЕ startedAt: расписание отрезков
       считается от него, и без него оригинал заиграл бы не там */
    this.applyMix();
    this.checkAudible();

    orig.onended = () => {
      if (!this.playing) return;
      this.playing = false;
      this.offset = 0;
      if (this.onEnded) this.onEnded();
    };
  },

  pause() {
    if (!this.playing) return;
    this.offset = this.position();
    this.stopSources();
    this.playing = false;
  },

  stop() {
    this.stopSources();
    this.playing = false;
    this.offset = 0;
  },

  stopSources() {
    this.sources.forEach((s) => {
      s.onended = null;
      try { s.stop(); } catch (e) { /* уже остановлен */ }
      try { s.disconnect(); } catch (e) { /* не подключен */ }
    });
    this.sources = [];
    // Отключаем старую цепочку от выхода, чтобы не копить узлы
    [this.vocalGain, this.instGain].forEach((g) => {
      if (g) { try { g.disconnect(); } catch (e) { /* ок */ } }
    });
  },

  /* Громкости смеси. Пока играем — не голыми значениями, а расписанием:
     на размеченных отрезках источник переключается на оригинал. Ползунок
     вокала можно двигать прямо во время игры, расписание пересчитается
     от текущей секунды. */
  applyMix() {
    if (!this.vocalGain) return;
    const база = усиленияМикса(state.vocalMix, !!state.instrumentalBuffer, this.forceVocal);
    if (!this.playing) {
      this.vocalGain.gain.cancelScheduledValues(0);
      this.instGain.gain.cancelScheduledValues(0);
      this.vocalGain.gain.value = база.вокал;
      this.instGain.gain.value = база.минусовка;
      return;
    }
    расписатьОтрезки(this.ctx, this.vocalGain, this.instGain, база,
      отрезкиОригинала(), this.startedAt);
  },
};

/* ---------- Приглушение вокала ----------
   Голос почти всегда стоит ровно в центре стерео-картины, то есть сидит
   в общей части каналов — в «середине» (L + R)/2. Её и вычитаем из обоих
   каналов, но не целиком, а только в той полосе, где живёт голос: ниже
   ВОКАЛ_НИЗ стоят бочка и бас, выше ВОКАЛ_ВЕРХ — воздух тарелок, вокала
   там почти нет, а музыки много.

   Всё остальное остаётся ровно таким, каким было в песне: и боковая
   часть (то, чем каналы различаются), и низ, и верх. Поэтому минусовка
   сохраняет стерео-картину и звучит песней без голоса.

   Раньше здесь отдавали наружу саму разность каналов (L − R), причём
   одну и ту же в оба уха. Голос она убирает не лучше (замерено: −21,4 дБ
   против −22,5 дБ у нынешнего способа), но вместе с ним пропадает всё,
   что стояло по центру, — бочка, малый барабан, бас, солирующий
   инструмент, — а от песни остаются края стерео-картины и хвосты
   реверберации, в том числе вокальной. На слух это ровно то, на что
   жаловались: «эхо», «пустой и искажённый звук» и «голос всё равно
   слышно» — слышно как раз его эхо, потому что заглушить было нечем. */
const ВОКАЛ_НИЗ = 170;    // ниже — бочка и бас, центр там не трогаем
const ВОКАЛ_ВЕРХ = 12000; // выше — воздух тарелок, голоса там нет

async function makeInstrumental(buffer) {
  if (buffer.numberOfChannels < 2) return null;

  /* Фильтр стартует с нулевого состояния и первые доли секунды даёт
     выброс — на слух это «странный» звук в самом начале трека.
     Поэтому даём ему разогнаться на зеркальной копии начала записи,
     а потом отрезаем этот разгон. */
  const PREROLL = Math.min(Math.round(buffer.sampleRate * 0.5), buffer.length);
  const padded = new OfflineAudioContext(2, 1, buffer.sampleRate)
    .createBuffer(2, buffer.length + PREROLL, buffer.sampleRate);
  for (let c = 0; c < 2; c++) {
    const from = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
    const to = padded.getChannelData(c);
    // Копия начала записи, плавно нарастающая от нуля: фильтр успевает
    // выйти на режим, а сам разгон не начинается со скачка
    for (let i = 0; i < PREROLL; i++) {
      // Косинусное нарастание: мягче линейного, меньше раскачивает фильтр
      to[i] = from[i] * (0.5 - 0.5 * Math.cos((Math.PI * i) / PREROLL));
    }
    to.set(from, PREROLL);
  }

  const ctx = new OfflineAudioContext(2, padded.length, buffer.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = padded;

  const split = ctx.createChannelSplitter(2);
  src.connect(split);

  // Середина — общая часть каналов, (L + R)/2. В ней и сидит голос.
  const mid = ctx.createGain();
  const ml = ctx.createGain(); ml.gain.value = 0.5;
  const mr = ctx.createGain(); mr.gain.value = 0.5;
  split.connect(ml, 0); split.connect(mr, 1);
  ml.connect(mid); mr.connect(mid);

  /* Из середины оставляем только вокальную полосу — это и есть «то, что
     поёт по центру». Без резонанса на частотах среза: по умолчанию
     фильтр их подчёркивает и долго звенит, из-за чего звук грязнится.
     По одному звену на край: чем круче срез, тем сильнее он сдвигает
     фазу, а вычитать надо сигнал, совпадающий с песней по фазе. */
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = ВОКАЛ_НИЗ;
  highpass.Q.value = 0.707;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = Math.min(ВОКАЛ_ВЕРХ, buffer.sampleRate / 2 - 1000);
  lowpass.Q.value = 0.707;
  mid.connect(highpass); highpass.connect(lowpass);

  // Вычитаем её из обоих каналов: центр в этой полосе гаснет,
  // всё прочее проходит нетронутым
  const минус = ctx.createGain();
  минус.gain.value = -1;
  lowpass.connect(минус);

  const merge = ctx.createChannelMerger(2);
  split.connect(merge, 0, 0); минус.connect(merge, 0, 0);
  split.connect(merge, 1, 1); минус.connect(merge, 0, 1);
  merge.connect(ctx.destination);

  src.start();
  const rendered = await ctx.startRendering();

  // Отрезаем разгон фильтра
  const trimmed = ctx.createBuffer(2, buffer.length, buffer.sampleRate);
  for (let c = 0; c < 2; c++) {
    trimmed.copyToChannel(
      rendered.getChannelData(c).subarray(PREROLL, PREROLL + buffer.length), c);
  }
  return normalizeInstrumental(trimmed);
}

/* После вычитания голоса пики могут вылезать далеко за 1.0 — на выходе
   это слышно как хрип и треск. Здесь мы только сторожим пик и, если
   модель разделения предписывает свой коэффициент компенсации,
   применяем его.

   Чего мы тут больше НЕ делаем: не подгоняем СКЗ минусовки под СКЗ
   оригинала. Это было принципиально неверно. Из микса убран голос,
   значит энергия обязана упасть — а «подтягивание» назад просто делало
   громче всё, что осталось, включая недобитый вокал: минусовке
   возвращалась ровно та энергия, которую мы старались убрать. UVR так
   не делает, там применяется только фиксированный коэффициент модели. */
function normalizeInstrumental(inst, compensate) {
  const peakOf = (buf) => {
    let p = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > p) p = a;
      }
    }
    return p || 1e-6;
  };

  let gain = compensate > 0 ? compensate : 1;
  const peak = peakOf(inst);
  if (peak * gain > 0.95) gain = 0.95 / peak;

  if (Math.abs(gain - 1) > 0.01) {
    for (let c = 0; c < inst.numberOfChannels; c++) {
      const d = inst.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= gain;
    }
  }
  return inst;
}

/* ---------- Самопроверка звука ----------

   Ловит ровно ту беду, на которую жаловались: «вокал на нуле всё равно
   слышен», «появилось эхо», «звук искажается». Слуха у проверки нет,
   поэтому она считает.

   Собираем короткую поддельную песню, в которой голос известен по
   отсчётам: шум в вокальной полосе, одинаковый в обоих каналах (то
   есть строго по центру), плюс своя музыка в каждом канале. Гоняем её
   через ту же цепь, что играет в колонки, при вокале 0 и 100 и смотрим:

     • сколько голоса осталось на выходе — проекция выхода на сам голос.
       При нуле его должно почти не быть, при сотне — весь;
     • совпадает ли выход при нуле с минусовкой, а при сотне с песней.
       Если играют обе дорожки разом, совпадения не будет;
     • нет ли второй копии сигнала со сдвигом — это и есть эхо;
     • уровни: пик и среднеквадратичный. */
async function самопроверкаЗвука() {
  const SR = 44100;
  const N = Math.round(SR * 1.5);

  // Свой генератор псевдослучайных чисел: проверка должна давать
  // одни и те же числа от запуска к запуску
  let seed = 20260819;
  const шум = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 1073741824 - 1;
  };
  /* Шум в полосе [низ, верх]: две по-разному сглаженные копии одного
     шума, вычтенные друг из друга. Шум взят намеренно — у него острый
     пик автокорреляции, поэтому по нему видно любую вторую копию. */
  const вПолосе = (низ, верх, скз) => {
    const x = new Float32Array(N);
    for (let i = 0; i < N; i++) x[i] = шум();
    // Два звена подряд: край полосы получается круче, и «голос»
    // не растекается за неё — иначе проверка мерила бы не то
    const сгладить = (вход, f) => {
      const a = Math.exp((-2 * Math.PI * f) / SR);
      const y = new Float32Array(N);
      let p = 0;
      for (let i = 0; i < N; i++) { p = a * p + (1 - a) * вход[i]; y[i] = p; }
      return y;
    };
    const дважды = (f) => сгладить(сгладить(x, f), f);
    const в = дважды(верх), н = дважды(низ);
    const y = new Float32Array(N);
    let s = 0;
    for (let i = 0; i < N; i++) { y[i] = в[i] - н[i]; s += y[i] * y[i]; }
    const k = скз / (Math.sqrt(s / N) || 1e-9);
    for (let i = 0; i < N; i++) y[i] *= k;
    return y;
  };

  const голос = вПолосе(300, 3000, 0.12);
  const музL = вПолосе(60, 16000, 0.15);
  const музR = вПолосе(60, 16000, 0.15);

  const песня = new OfflineAudioContext(2, N, SR).createBuffer(2, N, SR);
  const L = песня.getChannelData(0), R = песня.getChannelData(1);
  for (let i = 0; i < N; i++) { L[i] = музL[i] + голос[i]; R[i] = музR[i] + голос[i]; }

  const минус = await makeInstrumental(песня);
  if (!минус) return { вНорме: false, беда: 'минусовка не собралась' };

  // Прогон через ту же цепь, что звучит в колонки
  const прогон = async (vocalMix) => {
    const ctx = new OfflineAudioContext(2, N, SR);
    const смесь = собратьМикс(ctx);
    смесь.output.connect(ctx.destination);
    const g = усиленияМикса(vocalMix, true, false);
    смесь.vocalGain.gain.value = g.вокал;
    смесь.instGain.gain.value = g.минусовка;
    const a = ctx.createBufferSource(); a.buffer = песня; a.connect(смесь.vocalGain);
    const b = ctx.createBufferSource(); b.buffer = минус; b.connect(смесь.instGain);
    a.start(); b.start();
    return ctx.startRendering();
  };

  const моно = (buf) => {
    const l = buf.getChannelData(0), r = buf.getChannelData(1);
    const m = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) m[i] = (l[i] + r[i]) / 2;
    return m;
  };
  const дб = (x) => +(20 * Math.log10(Math.abs(x) || 1e-9)).toFixed(1);
  // Сколько «эталона» сидит в сигнале: коэффициент при нём
  const доля = (сигнал, эталон) => {
    let num = 0, den = 0;
    for (let i = 0; i < эталон.length; i++) { num += сигнал[i] * эталон[i]; den += эталон[i] * эталон[i]; }
    return num / (den || 1e-9);
  };
  const корр = (a, b, лаг, шаг = 1) => {
    let xy = 0, xx = 0, yy = 0;
    for (let i = 2000; i < a.length - 2000; i += шаг) {
      const x = a[i], y = b[i + лаг] || 0;
      xy += x * y; xx += x * x; yy += y * y;
    }
    return xy / (Math.sqrt(xx * yy) || 1e-9);
  };
  /* Лимитер на выходе смотрит немного вперёд и задерживает звук
     примерно на 6 мс — это не эхо, а ровный сдвиг всей дорожки.
     Поэтому сначала находим сдвиг, а уже потом сравниваем. */
  const лучшийЛаг = (a, b, макс) => {
    let л = 0, m = -2;
    for (let лаг = -макс; лаг <= макс; лаг += 2) {
      const r = Math.abs(корр(a, b, лаг, 8));
      if (r > m) { m = r; л = лаг; }
    }
    let итог = { лаг: л, r: корр(a, b, л) };
    for (let лаг = л - 3; лаг <= л + 3; лаг++) {
      const r = корр(a, b, лаг);
      if (Math.abs(r) > Math.abs(итог.r)) итог = { лаг, r };
    }
    return итог;
  };
  const уровни = (buf) => {
    const d = buf.getChannelData(0);
    let p = 0, s = 0;
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a; s += d[i] * d[i]; }
    return { пик: +p.toFixed(3), скз: +Math.sqrt(s / d.length).toFixed(4) };
  };

  const ноль = await прогон(0);
  const сотня = await прогон(1);
  const мНоль = моно(ноль), мСотня = моно(сотня);
  const мМинус = моно(минус), мПесня = моно(песня);

  const сдвигМакс = Math.round(SR * 0.02);
  const пНоль = лучшийЛаг(мНоль, мМинус, сдвигМакс);
  const пСотня = лучшийЛаг(мСотня, мПесня, сдвигМакс);
  const сМинусовкой = +пНоль.r.toFixed(3);
  const сПесней = +пСотня.r.toFixed(3);

  // Голос ищем в выходе с той же поправкой на задержку лимитера
  const сдвинуть = (x, лаг) => {
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i - лаг] || 0;
    return y;
  };
  const остатокВокала0 = дб(доля(сдвинуть(мНоль, пНоль.лаг), голос));
  const остатокВокала100 = дб(доля(сдвинуть(мСотня, пСотня.лаг), голос));

  /* Эхо — вторая копия сигнала, отставшая от первой. Ищем самое
     сильное совпадение выхода с минусовкой при сдвиге хотя бы на 2 мс
     от основного: оно обязано быть заметно слабее основного. */
  const шаг = Math.round(SR * 0.002);
  let эхо = 0, эхоЛаг = 0;
  // Сдвиги перебираем по одному отсчёту: у шума пик совпадения узкий,
  // по редкой сетке вторая копия просто не попалась бы
  for (let d = шаг; d <= шаг * 25; d++) {
    for (const знак of [1, -1]) {
      const r = Math.abs(корр(мНоль, мМинус, пНоль.лаг + знак * d, 16));
      if (r > эхо) { эхо = r; эхоЛаг = знак * d; }
    }
  }
  эхо = +эхо.toFixed(3);

  const уровни0 = уровни(ноль), уровни100 = уровни(сотня);

  /* Отрезки оригинала и магнит проверяются здесь же: снаружи, из
     самопроверки приложения, вызывается ровно одна считающая функция —
     эта. Заводить вторую точку входа значило бы править desktop/main.js. */
  const отрезки = await проверкаОтрезков(песня, минус, SR, N);
  const магнит = проверкаМагнита();

  return {
    остатокВокала0, остатокВокала100,
    сМинусовкой, сПесней,
    задержкаМс: +((пНоль.лаг / SR) * 1000).toFixed(1),
    эхо, эхоМс: +((эхоЛаг / SR) * 1000).toFixed(1),
    уровни0, уровни100,
    минусовкаСтерео: +корр(минус.getChannelData(0), минус.getChannelData(1), 0).toFixed(3),
    подавлениеДб: +(остатокВокала0 - остатокВокала100).toFixed(1),
    отрезки, магнит,
    вНорме:
      остатокВокала0 <= -12                        // на нуле голоса почти нет
      && остатокВокала100 >= -3                    // на сотне он весь на месте
      && остатокВокала100 - остатокВокала0 >= 12   // ползунок и правда глушит
      && сМинусовкой >= 0.98      // на нуле звучит ровно минусовка
      && сПесней >= 0.98          // на сотне — ровно песня
      && эхо < 0.25               // второй копии со сдвигом нет (целое даёт 0,11)
      && уровни0.пик <= 1 && уровни100.пик <= 1
      && отрезки.вНорме && магнит.вНорме,
  };
}

/* ---------- Самопроверка отрезков оригинала ----------

   Проверяет ровно то, что обещано человеку:

     • внутри отрезка звучит оригинал, снаружи — минусовка. Меряем
       корреляцией выхода с той и с другой дорожкой по кускам,
       заведомо лежащим внутри и снаружи;

     • на границах не щёлкает: наибольший скачок между соседними
       отсчётами на переходе не больше того, что бывает в этом же
       звуке вдали от границ. Иначе переход был бы слышнее музыки;

     • живой звук и выгруженный файл говорят одно и то же. Цепи у них
       разные (в живой стоят эквалайзер и лимитер), поэтому сравниваем
       не отсчёты, а долю оригинала по окнам в 20 мс — и требуем, чтобы
       ни в одном окне источник не разошёлся.

   Долю оригинала достаём проекцией: (выход − минусовка) на
   (оригинал − минусовка). Для живой цепи опоры берём тоже из неё —
   те же прогоны без отрезков при вокале 0 и 1, иначе окраска
   эквалайзера и лимитера села бы в число вместо переключения. */
async function проверкаОтрезков(исхПесня, исхМинус, SR, N) {
  const отрезки = [{ start: 0.4, end: 0.9 }];
  const дл = N / SR;

  /* Обе дорожки берём вполовину тише. Лимитер на выходе живой цепи —
     штука нелинейная, и на громком сигнале он сжимает по-разному в
     разных прогонах. Тогда сравнение мерило бы работу лимитера, а не
     переключение источника, ради которого проверка и затеяна.
     На тихом сигнале лимитер не срабатывает вовсе и цепь линейна. */
  const тише = (buf) => {
    const c = new OfflineAudioContext(2, N, SR).createBuffer(2, N, SR);
    for (let ch = 0; ch < 2; ch++) {
      const из = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
      const в = c.getChannelData(ch);
      for (let k = 0; k < Math.min(N, из.length); k++) в[k] = из[k] * 0.4;
    }
    return c;
  };
  const песня = тише(исхПесня);
  const минус = тише(исхМинус);

  // Живая цепь — та же, что играет в колонки
  const живой = async (спаны, vocalMix) => {
    const ctx = new OfflineAudioContext(2, N, SR);
    const см = собратьМикс(ctx);
    см.output.connect(ctx.destination);
    const o = ctx.createBufferSource(); o.buffer = песня; o.connect(см.vocalGain);
    const i = ctx.createBufferSource(); i.buffer = минус; i.connect(см.instGain);
    расписатьОтрезки(ctx, см.vocalGain, см.instGain,
      усиленияМикса(vocalMix, true, false), спаны, 0);
    o.start(); i.start();
    return ctx.startRendering();
  };

  // Выгрузка — та самая функция, что отдаёт человеку файл
  const было = {
    o: state.originalBuffer, i: state.instrumentalBuffer, s: state.origSpans,
  };
  let файл;
  try {
    state.originalBuffer = песня;
    state.instrumentalBuffer = минус;
    state.origSpans = отрезки;
    файл = await собратьМинусовку();
  } finally {
    state.originalBuffer = было.o;
    state.instrumentalBuffer = было.i;
    state.origSpans = было.s;
  }

  const жив = await живой(отрезки, 0);
  const опораМинус = await живой([], 0);
  const опораОригинал = await живой([], 1);

  const мон = (b) => {
    const l = b.getChannelData(0), r = b.getChannelData(1);
    const m = new Float32Array(l.length);
    for (let k = 0; k < l.length; k++) m[k] = (l[k] + r[k]) / 2;
    return m;
  };
  const корр = (a, b, лаг, от, до) => {
    let xy = 0, xx = 0, yy = 0;
    for (let k = от; k < до; k++) {
      const x = a[k], y = b[k + лаг] || 0;
      xy += x * y; xx += x * x; yy += y * y;
    }
    return xy / (Math.sqrt(xx * yy) || 1e-9);
  };
  const с = (t) => Math.round(t * SR);
  const мЖив = мон(жив), мФайл = мон(файл);
  const мПесня = мон(песня), мМинус = мон(минус);

  // Лимитер живой цепи задерживает звук — сначала находим сдвиг
  let лаг = 0, лучш = -2;
  const макс = Math.round(SR * 0.02);
  for (let g = -макс; g <= макс; g++) {
    const r = корр(мЖив, мМинус, g, с(1.0), с(дл - 0.05));
    if (r > лучш) { лучш = r; лаг = g; }
  }

  const живВнутриСПесней = +корр(мЖив, мПесня, лаг, с(0.5), с(0.85)).toFixed(3);
  const живВнутриСМинусовкой = +корр(мЖив, мМинус, лаг, с(0.5), с(0.85)).toFixed(3);
  const живСнаружиСМинусовкой = +корр(мЖив, мМинус, лаг, с(1.0), с(дл - 0.05)).toFixed(3);
  const живСнаружиСПесней = +корр(мЖив, мПесня, лаг, с(1.0), с(дл - 0.05)).toFixed(3);
  const файлВнутриСПесней = +корр(мФайл, мПесня, 0, с(0.5), с(0.85)).toFixed(3);
  const файлСнаружиСМинусовкой = +корр(мФайл, мМинус, 0, с(1.0), с(дл - 0.05)).toFixed(3);

  // Щелчки: наибольший скачок между соседними отсчётами
  const скачок = (buf, от, до) => {
    const d = buf.getChannelData(0);
    let m = 0;
    for (let k = Math.max(1, с(от)); k < Math.min(d.length, с(до)); k++) {
      const v = Math.abs(d[k] - d[k - 1]);
      if (v > m) m = v;
    }
    return +m.toFixed(4);
  };
  /* Границу меряем ровно по затуханию плюс пара миллисекунд с краёв,
     а не по широкому окну: в широком наибольшим оказался бы обычный
     шум песни, и проверка сравнивала бы шум сам с собой. */
  const кр = 0.01;
  const вход = [отрезки[0].start - ОТРЕЗОК_ФЕЙД - кр, отрезки[0].start + кр];
  const выход = [отрезки[0].end - кр, отрезки[0].end + ОТРЕЗОК_ФЕЙД + кр];
  const наГранице = Math.max(
    скачок(жив, вход[0], вход[1]), скачок(жив, выход[0], выход[1]),
    скачок(файл, вход[0], вход[1]), скачок(файл, выход[0], выход[1]));
  // Для сравнения — что в этом же звуке творится вдали от границ
  const вЗвуке = Math.max(
    скачок(жив, 1.05, дл - 0.05), скачок(файл, 1.05, дл - 0.05));

  /* Доля оригинала по окнам 20 мс. Живой выход перед этим сдвигаем
     обратно на задержку лимитера, иначе переход уехал бы на 6 мс. */
  const сдвинуть = (x, л) => {
    const y = new Float32Array(x.length);
    for (let k = 0; k < x.length; k++) y[k] = x[k - л] || 0;
    return y;
  };
  const профиль = (x, а, б) => {
    const шаг = Math.round(SR * 0.02);
    const n = Math.floor(x.length / шаг);
    const p = new Float32Array(n);
    for (let w = 0; w < n; w++) {
      let num = 0, den = 0;
      for (let k = w * шаг; k < (w + 1) * шаг; k++) {
        const d = б[k] - а[k];
        num += (x[k] - а[k]) * d; den += d * d;
      }
      p[w] = den > 1e-9 ? num / den : 0;
    }
    return p;
  };
  /* Сдвигаем ВСЕ три живых сигнала одинаково: и выход, и обе опоры
     задержаны лимитером на один и тот же срок, а профиль — проекция
     выхода на разность опор, и разъехавшийся сдвиг всё бы испортил */
  const пЖив = профиль(сдвинуть(мЖив, лаг),
    сдвинуть(мон(опораМинус), лаг), сдвинуть(мон(опораОригинал), лаг));
  const пФайл = профиль(мФайл, мМинус, мПесня);
  let расхождение = 0, разныйИсточник = 0;
  // Первые окна пропускаем: там разгоняется лимитер, а не отрезок
  for (let w = 5; w < пЖив.length - 1; w++) {
    расхождение = Math.max(расхождение, Math.abs(пЖив[w] - пФайл[w]));
    if ((пЖив[w] > 0.5) !== (пФайл[w] > 0.5)) разныйИсточник++;
  }
  // И насколько выгруженный файл повторяет то, что задумано расписанием
  let поРасчёту = 0;
  const шагОкна = Math.round(SR * 0.02);
  for (let w = 0; w < пФайл.length - 1; w++) {
    /* Расчётную долю усредняем по тому же окну, а не берём в его
       середине: затухание короче окна, и точка в середине давала бы
       расхождение там, где на деле всё сходится */
    let ср = 0;
    for (let k = w * шагОкна; k < (w + 1) * шагОкна; k++) ср += доляОригинала(k / SR, отрезки);
    поРасчёту = Math.max(поРасчёту, Math.abs(пФайл[w] - ср / шагОкна));
  }

  return {
    отрезок: отрезки[0],
    живВнутриСПесней, живВнутриСМинусовкой,
    живСнаружиСМинусовкой, живСнаружиСПесней,
    файлВнутриСПесней, файлСнаружиСМинусовкой,
    задержкаЖивойЦепиМс: +((-лаг / SR) * 1000).toFixed(2),
    скачокНаГранице: наГранице,
    скачокВЗвуке: вЗвуке,
    файлПротивРасчёта: +поРасчёту.toFixed(3),
    живойПротивФайлаМакс: +расхождение.toFixed(3),
    оконСРазнымИсточником: разныйИсточник,
    вНорме:
      живВнутриСПесней >= 0.98            // внутри отрезка звучит оригинал
      && живВнутриСМинусовкой <= 0.9      // и это не минусовка
      && живСнаружиСМинусовкой >= 0.98    // снаружи — ровно минусовка
      && живСнаружиСПесней <= 0.9
      && файлВнутриСПесней >= 0.98        // в файле то же самое
      && файлСнаружиСМинусовкой >= 0.98
      && наГранице <= вЗвуке              // переход не громче того, что и так есть
      && поРасчёту <= 0.02                // файл повторяет расписание
      && разныйИсточник === 0,            // живой звук и файл не разошлись
  };
}

/* ---------- Самопроверка магнита ----------

   Считает, а не смотрит: подставляет заведомую разметку и спрашивает
   примагнитить(), куда встанет граница. Проверяет каждую породу точек,
   что своя строка и свой отрезок целью не считаются, что зажатый Alt
   и общий выключатель магнит отменяют — и что порог задан в пикселях:
   на впятеро более крупном масштабе то же расстояние в секундах уже
   не притягивает. */
function проверкаМагнита() {
  const было = {
    lines: state.lines, spans: state.origSpans, buf: state.originalBuffer,
    off: audio.offset, play: audio.playing,
    px: editor.pxPerSec, scroll: editor.scrollT, snap: editor.snap,
    без: editor.безМагнита, key: editor.spansKey, snapped: editor.snapped,
    runs: voice.runs, level: voice.level,
  };
  try {
    // Песня 12 секунд: длина нужна, чтобы магнит знал её край
    state.originalBuffer = new OfflineAudioContext(1, 1, 8000)
      .createBuffer(1, 8000 * 12, 8000);
    audio.playing = false;
    editor.pxPerSec = 40;     // порог 12 px — это 0,3 с
    editor.scrollT = 0;
    editor.snap = true;
    editor.безМагнита = false;
    voice.runs = null;
    voice.level = null;

    const строки = () => [2, 4, 6, 8, 10].map((t, i) => ({
      text: 'Строка ' + (i + 1), time: t, end: null,
      ручнойКонец: false, сомнительная: false,
    }));
    const настроить = (о) => {
      state.lines = о.строки === false ? [] : строки();
      state.origSpans = о.отрезки || [];
      voice.runs = о.голос || null;
      voice.level = о.голос ? new Uint8Array(1200) : null;
      audio.offset = о.указатель == null ? 4 : о.указатель;
      editor.spansKey = '';
    };
    const проба = (t, что) => {
      const r = примагнитить(t, что);
      return { стало: +r.toFixed(4), вид: editor.snapped ? editor.snapped.вид : null };
    };

    настроить({});
    const кСтроке = проба(6.12);                       // ждём 6,0
    const свояСтрокаНеЦель = проба(6.12, { кромеСтроки: 2 });

    настроить({ указатель: 7.5 });
    const кУказателю = проба(7.42);                    // ждём 7,5

    настроить({ строки: false, отрезки: [{ start: 1, end: 3 }] });
    const кОтрезку = проба(1.12);                      // ждём 1,0
    const свойОтрезокНеЦель = проба(1.12, { кроме: 0 });

    настроить({ строки: false, голос: [{ start: 8.4, end: 9.2 }] });
    const кГолосу = проба(8.55);                       // ждём 8,4
    const кКонцуПения = проба(9.05);                   // ждём 9,2

    настроить({ строки: false });
    const кНачалуПесни = проба(0.11);                  // ждём 0
    const кКонцуПесни = проба(11.93);                  // ждём 12

    настроить({});
    editor.безМагнита = true;
    const сAlt = проба(6.12);                          // ждём 6,12 как есть
    editor.безМагнита = false;
    editor.snap = false;
    const выключен = проба(6.12);
    editor.snap = true;

    // Порог в пикселях: 0,25 с — это 10 px при масштабе 40 и 50 px при 200
    const мелко = проба(6.25);
    editor.pxPerSec = 200;
    const крупно = проба(6.25);
    editor.pxPerSec = 40;

    const о = {
      кСтроке, кУказателю, кОтрезку, кГолосу, кКонцуПения,
      кНачалуПесни, кКонцуПесни,
      свояСтрокаНеЦель, свойОтрезокНеЦель, сAlt, выключен,
      порогПри40: мелко, порогПри200: крупно,
    };
    о.вНорме =
      кСтроке.стало === 6 && кСтроке.вид === 'строка'
      && кУказателю.стало === 7.5 && кУказателю.вид === 'указатель'
      && кОтрезку.стало === 1 && кОтрезку.вид === 'оригинал'
      && кГолосу.стало === 8.4 && кГолосу.вид === 'голос'
      && кКонцуПения.стало === 9.2 && кКонцуПения.вид === 'голос'
      && кНачалуПесни.стало === 0 && кНачалуПесни.вид === 'край'
      && кКонцуПесни.стало === 12 && кКонцуПесни.вид === 'край'
      && свояСтрокаНеЦель.стало !== 6
      && свойОтрезокНеЦель.стало === 1.12
      && сAlt.стало === 6.12 && сAlt.вид === null
      && выключен.стало === 6.12
      && мелко.стало === 6 && крупно.стало === 6.25;
    return о;
  } finally {
    state.lines = было.lines;
    state.origSpans = было.spans;
    state.originalBuffer = было.buf;
    audio.offset = было.off;
    audio.playing = было.play;
    editor.pxPerSec = было.px;
    editor.scrollT = было.scroll;
    editor.snap = было.snap;
    editor.безМагнита = было.без;
    editor.spansKey = было.key;
    editor.snapped = было.snapped;
    voice.runs = было.runs;
    voice.level = было.level;
  }
}

/* Трёхполосный эквалайзер: низкие/средние/высокие.
   Возвращает вход, выход и функцию применения текущих настроек. */
function buildEqChain(ctx) {
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 200;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 1000;
  mid.Q.value = 0.8;
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 4000;
  low.connect(mid);
  mid.connect(high);
  const apply = () => {
    low.gain.value = state.eq.low;
    mid.gain.value = state.eq.mid;
    high.gain.value = state.eq.high;
  };
  apply();
  return { input: low, output: high, apply };
}

/* Страховочный лимитер, чтобы смесь «оригинал + минус» не клиппила */
function makeLimiter(ctx) {
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -3;
  lim.knee.value = 3;
  lim.ratio.value = 20;
  lim.attack.value = 0.002;
  lim.release.value = 0.15;
  return lim;
}

/* ---------- Утилиты ---------- */
function fmtTime(sec) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtLrcTime(sec) {
  const cs = Math.round(sec * 100); // сотые доли, без двойного округления
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const f = cs % 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ============================================================
   Голос: где он звучит на самом деле

   Настольная версия отделяет чистый вокал нейросетью — по этой дорожке
   прямо видно, где поют, а где нет. Держать её целиком незачем: сцене
   хватает огибающей громкости, сто отсчётов в секунду по байту на
   отсчёт. Три минуты песни укладываются в семнадцать килобайт — столько
   не жалко сохранить и вместе с проектом, чтобы после перезагрузки
   караоке не поехало.

   Отсюда сцена узнаёт три вещи: настоящий конец строки (пока тянется
   распев, строка не спета), настоящее вступление голоса и настоящие
   проигрыши.

   Дорожки может и не быть — на сайте её нет никогда, а в приложении
   она появляется только после удаления вокала нейросетью. Тогда всё
   считается по временам слов, как раньше.
   ============================================================ */

const VOICE_RATE = 100;      // отсчётов огибающей в секунду
const VOICE_DB_RANGE = 60;   // тише этого от опоры — уже тишина

/* Пороги речевой активности — в децибелах от опорной громкости дорожки.
   Порога два, а не один, чтобы на границе не дребезжало: голос
   «включается» на VOICE_ON_DB и «выключается», только упав ниже
   VOICE_OFF_DB. Цифры подобраны на живом пении, см. README. */
const VOICE_ON_DB = -25;
const VOICE_OFF_DB = -35;
const VOICE_MIN_RUN = 0.18;  // короче — это не пение, а призвук
const VOICE_MIN_GAP = 0.30;  // короче — вдох между словами, а не тишина

const voice = { level: null, runs: null };

function voiceReady() { return !!(voice.runs && voice.runs.length); }

/* Громкость в децибелах от опоры, ужатая в байт: 255 — опорный уровень,
   0 — тишина на VOICE_DB_RANGE децибел ниже неё */
function voiceDbCode(db) {
  return Math.max(0, Math.min(255,
    Math.round((db + VOICE_DB_RANGE) * (255 / VOICE_DB_RANGE))));
}

/* Огибающая: среднеквадратичная громкость в окне 20 мс с шагом 10 мс */
function buildVoiceLevel(samples, sampleRate) {
  const hop = Math.max(1, Math.round(sampleRate / VOICE_RATE));
  const n = Math.floor(samples.length / hop);
  if (n < 2) return null;
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const from = i * hop;
    const to = Math.min(samples.length, from + hop * 2);
    let sum = 0;
    for (let j = from; j < to; j++) sum += samples[j] * samples[j];
    rms[i] = Math.sqrt(sum / Math.max(1, to - from));
  }
  /* Опора — 95-й процентиль громкости: на него не влияют ни редкие
     всплески, ни длинные куски тишины, поэтому пороги ниже получаются
     одинаково осмысленными и для тихой записи, и для громкой. */
  const sorted = Float32Array.from(rms).sort();
  const ref = sorted[Math.floor(n * 0.95)] || 1e-6;
  const level = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    level[i] = voiceDbCode(20 * Math.log10(Math.max(1e-9, rms[i]) / ref));
  }
  return level;
}

/* Куски пения: порог с гистерезисом, потом склейка вдохов и отсев щелчков */
function buildVoiceRuns(level) {
  if (!level || !level.length) return null;
  const on = voiceDbCode(VOICE_ON_DB);
  const off = voiceDbCode(VOICE_OFF_DB);
  const raw = [];
  let from = -1;
  for (let i = 0; i < level.length; i++) {
    if (from < 0) {
      if (level[i] >= on) {
        // Начало отматываем назад до нижнего порога: атака звука тише
        // вершины, а строка должна начинаться с первого призвука
        let s = i;
        while (s > 0 && level[s - 1] >= off) s--;
        from = s;
      }
    } else if (level[i] < off) {
      raw.push([from, i]);
      from = -1;
    }
  }
  if (from >= 0) raw.push([from, level.length]);

  const merged = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && (r[0] - last[1]) / VOICE_RATE < VOICE_MIN_GAP) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  return merged
    .filter((r) => (r[1] - r[0]) / VOICE_RATE >= VOICE_MIN_RUN)
    .map((r) => ({ start: r[0] / VOICE_RATE, end: r[1] / VOICE_RATE }));
}

function clearVoiceTrack() {
  voice.level = null;
  voice.runs = null;
}

/* Вызывает настольная часть после разделения — с чистым вокалом на руках */
function setVoiceTrack(samples, sampleRate) {
  try {
    voice.level = buildVoiceLevel(samples, sampleRate);
    voice.runs = buildVoiceRuns(voice.level);
  } catch (e) {
    clearVoiceTrack();
  }
  saveProject();
}

/* Огибающая в текст и обратно — чтобы уместилась в localStorage */
function voiceToText(level) {
  let s = '';
  const CHUNK = 0x8000;   // длинные списки аргументов ломают apply
  for (let i = 0; i < level.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, level.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function restoreVoiceTrack(text, duration) {
  clearVoiceTrack();
  try {
    const bin = atob(text);
    const level = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) level[i] = bin.charCodeAt(i);
    // Огибающая от другой песни (или обрезанной) только всё испортит
    if (Math.abs(level.length / VOICE_RATE - duration) > 2) return;
    voice.level = level;
    voice.runs = buildVoiceRuns(level);
  } catch (e) {
    clearVoiceTrack();
  }
}

/* ---------- Что спрашивает у огибающей сцена ---------- */

// Последний кусок пения, начавшийся не позже t (или -1)
function voiceRunIndex(t) {
  const runs = voice.runs;
  let lo = 0;
  let hi = runs.length - 1;
  let best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (runs[m].start <= t) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best;
}

/* Докуда тянется пение, идущее в момент t. Если в этот момент тихо,
   но голос вступает в ближайшие look секунд — берём его. null — рядом
   с t голоса нет. */
function voiceEndFrom(t, look) {
  if (!voiceReady()) return null;
  const runs = voice.runs;
  const i = voiceRunIndex(t);
  if (i >= 0 && t < runs[i].end) return runs[i].end;
  const j = i + 1;
  if (j < runs.length && runs[j].start - t <= look) return runs[j].end;
  return null;
}

// Ближайшее к t вступление голоса в окне [lo, hi]
function voiceOnsetNear(t, lo, hi) {
  if (!voiceReady()) return null;
  let best = null;
  for (let i = Math.max(0, voiceRunIndex(lo)); i < voice.runs.length; i++) {
    const s = voice.runs[i].start;
    if (s > hi) break;
    if (s < lo) continue;
    if (best == null || Math.abs(s - t) < Math.abs(best - t)) best = s;
  }
  return best;
}

/* ---------- Сохранение проекта (текст, разметка, фон) ---------- */
function saveProject() {
  /* Пока строки ещё не разобраны (например, сразу после загрузки файла),
     не затираем уже сохранённую разметку этой же песни.

     «Та же песня» — это совпадение имени ИЛИ ещё не открытый файл.
     Беда, которую лечит вторая половина условия: после перезагрузки
     страницы state.fileName пуст, песню ещё не выбрали, — и раньше вся
     сохранённая работа считалась чужой. Первая же правка текста стирала
     разметку, фон, огибающую голоса и эквалайзер: времена [5,13,21,29]
     превращались в [], фон в null, эквалайзер в нули. */
  const prev = loadProject();
  const keepPrev = !!prev && (!state.fileName || prev.name === state.fileName);
  const data = {
    // Имя песни тоже не теряем: без него проект перестанет узнавать сам себя
    name: state.fileName || (keepPrev ? prev.name : null),
    lyrics: $('lyrics-input').value || (keepPrev && prev.lyrics) || '',
    times: state.lines.length ? state.lines.map((l) => l.time)
      : (keepPrev && prev.times) || [],
    ends: state.lines.length ? state.lines.map((l) => l.end ?? null)
      : (keepPrev && prev.ends) || [],
    // Концы, выставленные руками: только они переживают пересчёт разметки
    handEnds: state.lines.length ? state.lines.map((l) => !!l.ручнойКонец)
      : (keepPrev && prev.handEnds) || [],
    // Ручная разметка слов: [{text, time, end}] или null для строк без неё
    words: state.lines.length ? state.lines.map((l) => l.words || null)
      : (keepPrev && prev.words) || [],
    // Строки, чьё время нейросеть подобрала на глазок при подгонке текста
    guess: state.lines.length ? state.lines.map((l) => !!l.сомнительная)
      : (keepPrev && prev.guess) || [],
    /* Отрезки, где вместо минусовки звучит оригинал. Умолчание — пустой
       список, так что переносить между поколениями оформления (STYLE_GEN)
       тут нечего: старый проект просто приходит без отрезков.

       Условие такое же, как у времён: пока строки в памяти не разобраны,
       проект ещё не открыт — и стирать чужую разметку нельзя. А когда
       открыт, пустой список означает «человек убрал все отрезки», и это
       обязано сохраниться, а не подмениться прежними. */
    origSpans: state.lines.length ? отрезкиОригинала().map((s) => ({ ...s }))
      : (keepPrev && prev.origSpans) || [],
    bg: state.bgImage,
    // Огибающая голоса: по ней сцена знает конец строки и проигрыши
    voice: voice.level ? voiceToText(voice.level) : ((keepPrev && prev.voice) || null),
    eq: { ...state.eq },
    style: { ...state.style },
    // Поколение оформления: по нему при загрузке видно, какие умолчания
    // проект ещё не переживал (см. styleFromSaved)
    styleGen: STYLE_GEN,
  };
  try {
    localStorage.setItem('karaoke-project', JSON.stringify(data));
  } catch (e) {
    // Скорее всего не влезла картинка — сохраняем хотя бы текст и разметку
    try {
      delete data.bg;
      delete data.voice;
      localStorage.setItem('karaoke-project', JSON.stringify(data));
    } catch (e2) { /* localStorage недоступен */ }
  }
}

function loadProject() {
  try {
    return JSON.parse(localStorage.getItem('karaoke-project'));
  } catch (e) { return null; }
}

/* ---------- Навигация по шагам ----------
   Шагов четыре: песня → текст → редактор → караоке. Простукивание
   отдельным шагом больше не живёт, оно стало режимом внутри редактора. */
function goToStep(n) {
  // Караоке готово — редактор тоже становится доступен
  state.maxStep = Math.max(state.maxStep, n === 3 ? 4 : n);
  document.querySelectorAll('.step-tab').forEach((tab) => {
    const step = +tab.dataset.step;
    tab.classList.toggle('active', step === n);
    tab.disabled = step > state.maxStep;
  });
  document.querySelectorAll('.step-panel').forEach((p) => p.classList.remove('active'));
  $(`step-${n}`).classList.add('active');

  // Заход простукивания и разметка слов живут только в редакторе
  if (tap.active) finishTapMode();
  if (wordTap.active) finishWordTap(false);
  // Кольцо живёт только в редакторе: на других шагах оно бы дёргало плеер
  if (n !== 3 && editor.loop) setLoop(false);
  if (n !== 3 && n !== 4) { audio.pause(); updatePlayerUI(); }
  if (n === 3) openEditor();
  if (n === 4) renderStage();
  // Рабочий шаг занимает окно целиком — подводим его под шапку,
  // иначе половина работы окажется за краем экрана
  scrollStudioIntoView();
  // Громкость вокала считаем заново: в редакторе звучит оригинал,
  // в караоке — то, что выставлено ползунком. Иначе флаг залипал.
  audio.restoreVocal();
}

document.querySelectorAll('.step-tab').forEach((tab) => {
  tab.addEventListener('click', () => goToStep(+tab.dataset.step));
});

/* Высота липкой шапки — в переменную: от неё считается высота студии,
   чтобы рабочий шаг помещался в окно целиком (см. .studio в style.css) */
function measureHeader() {
  const шапка = document.querySelector('.site-header');
  const h = шапка ? Math.round(шапка.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--header-h', `${h}px`);
}
measureHeader();
window.addEventListener('resize', measureHeader);

/* Студия высотой в окно: если страница стоит не на ней, работы не видно */
function scrollStudioIntoView() {
  const studio = $('studio');
  if (!studio) return;
  const шапка = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 0;
  const r = studio.getBoundingClientRect();
  if (r.top < шапка - 1 || r.bottom > window.innerHeight + 1) {
    window.scrollTo({ top: window.scrollY + r.top - шапка - 8, behavior: 'smooth' });
  }
}

/* ============================================================
   Шаг 1 — загрузка файла
   ============================================================ */
const dropzone = $('dropzone');
const fileInput = $('file-input');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter') fileInput.click(); });
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

async function handleFile(file) {
  /* Другая песня поверх готовой разметки.
     Беда, которую это лечит: state.lines оставались от прежней песни.
     Строки на 25-й и 40-й секунде переезжали в трек длиной 20 секунд,
     а saveProject записывал их уже под новым именем — разметка прежней
     песни пропадала навсегда, и никто ни о чём не спрашивал.
     Теперь спрашиваем и начинаем новую песню с чистой разметкой. */
  const prev = loadProject();
  const прежняя = state.fileName || (prev && prev.name) || null;
  const другая = !!прежняя && прежняя !== file.name;
  if (другая) {
    const своих = state.lines.filter((l) => l.time != null).length;
    const вПроекте = prev && Array.isArray(prev.times)
      ? prev.times.filter((t) => t != null).length : 0;
    const размечено = своих || (prev && prev.name === прежняя ? вПроекте : 0);
    if (размечено) {
      const ок = confirm(
        `Сейчас в студии песня «${прежняя}», размечено строк: ${размечено}.\n`
        + 'Студия помнит одну песню за раз — если открыть другую, вернуть '
        + 'разметку прежней будет нельзя.\n\n'
        + `Открыть «${file.name}»?`);
      if (!ок) {
        fileInput.value = '';
        return;
      }
    }
    // Времена прежней песни новой не годятся: строки стоят не на своих местах
    state.lines = [];
    state.origSpans = [];   // и отрезки оригинала — они тоже про прежнюю песню
    editor.sel = -1;
    editor.peaks = null;
    clearHistory();
  }

  dropzone.classList.add('hidden');
  $('track-info').classList.add('hidden');
  $('processing').classList.remove('hidden');
  $('processing-text').textContent = 'Читаем файл…';

  try {
    const data = await file.arrayBuffer();
    $('processing-text').textContent = 'Декодируем аудио…';
    const ctx = audio.ensureCtx();
    const buffer = await ctx.decodeAudioData(data);

    $('processing-text').textContent = 'Приглушаем вокал…';
    const instrumental = await makeInstrumental(buffer);
    state.customInst = false;
    state.instName = null;
    $('inst-input').value = '';
    updateInstUI();

    audio.stop();
    state.fileName = file.name;
    state.originalBuffer = buffer;
    state.instrumentalBuffer = instrumental;
    editor.peaks = null; // волна пересчитается для нового трека
    clearVoiceTrack();   // чужая огибающая новой песне не годится

    $('track-name').textContent = file.name.replace(/\.[^.]+$/, '');
    $('track-meta').textContent =
      `${fmtTime(buffer.duration)} · ${buffer.numberOfChannels === 1 ? 'моно' : 'стерео'} · ${(buffer.sampleRate / 1000).toFixed(1)} кГц`;
    $('mono-warning').classList.toggle('hidden', !!instrumental);
    $('processing').classList.add('hidden');
    $('track-info').classList.remove('hidden');

    // Восстанавливаем сохранённый проект для этой песни
    const saved = loadProject();
    if (saved && saved.name === file.name) {
      if (saved.lyrics) $('lyrics-input').value = saved.lyrics;
      if (saved.bg) setBgImage(saved.bg);
      // Отрезки оригинала: длину знаем только сейчас — по ней и обрезаем
      state.origSpans = нормОтрезки(saved.origSpans, buffer.duration);
      // Огибающая голоса от прошлого разделения этой же песни
      if (saved.voice) restoreVoiceTrack(saved.voice, buffer.duration);
      if (saved.eq) {
        state.eq = { low: +saved.eq.low || 0, mid: +saved.eq.mid || 0, high: +saved.eq.high || 0 };
        updateEqUI();
      }
      if (saved.style) {
        state.style = styleFromSaved(saved);
        updateStyleUI();
        applyStyle();
      }
    }
  } catch (err) {
    $('processing').classList.add('hidden');
    dropzone.classList.remove('hidden');
    alert('Не удалось прочитать этот файл как аудио. Попробуй другой формат (MP3, WAV, OGG).');
  }
}

/* ---------- Своя минусовка (например, из UVR5) ----------
   Готовый файл без вокала звучит куда лучше вычитания центра,
   поэтому если он загружен — используем его. */
function updateInstUI() {
  const custom = state.customInst;
  $('inst-status').classList.toggle('hidden', !custom);
  $('inst-status').textContent = custom ? `✓ ${state.instName}` : '';
  $('btn-inst-remove').classList.toggle('hidden', !custom);
  $('btn-inst-add').textContent = custom ? 'Заменить' : 'Выбрать';
}

async function handleInstFile(file) {
  if (!state.originalBuffer) {
    alert('Сначала загрузи саму песню.');
    return;
  }
  try {
    const data = await file.arrayBuffer();
    const buffer = await audio.ensureCtx().decodeAudioData(data);
    const diff = Math.abs(buffer.duration - state.originalBuffer.duration);
    if (diff > 1.5) {
      const ok = confirm(
        `Длительность минусовки (${fmtTime(buffer.duration)}) отличается от песни ` +
        `(${fmtTime(state.originalBuffer.duration)}) на ${diff.toFixed(1)} с. ` +
        'Текст может разъехаться. Всё равно использовать?');
      if (!ok) return;
    }
    audio.stop();
    state.instrumentalBuffer = buffer;
    state.customInst = true;
    state.instName = file.name;
    $('mono-warning').classList.add('hidden');
    updateInstUI();
  } catch (e) {
    alert('Не удалось прочитать этот файл как аудио. Попробуй MP3, WAV или OGG.');
  }
}

$('btn-inst-add').addEventListener('click', () => $('inst-input').click());
$('inst-input').addEventListener('change', () => {
  const file = $('inst-input').files[0];
  if (file) handleInstFile(file);
});
$('btn-inst-remove').addEventListener('click', async () => {
  $('inst-input').value = '';
  state.customInst = false;
  state.instName = null;
  audio.stop();
  // Возвращаемся к встроенному приглушению вокала
  state.instrumentalBuffer = state.originalBuffer
    ? await makeInstrumental(state.originalBuffer)
    : null;
  $('mono-warning').classList.toggle('hidden', !!state.instrumentalBuffer);
  updateInstUI();
});

/* ---------- Картинка-фон для караоке ---------- */

/* Ужимаем картинку до разумного размера, чтобы она
   помещалась в localStorage и не тормозила отрисовку */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const maxSide = 1280;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

function setBgImage(dataUrl) {
  state.bgImage = dataUrl || null;
  const stage = $('lyrics-stage');
  const preview = $('bg-preview');
  if (dataUrl) {
    stage.classList.add('has-bg');
    // Затемнения всего кадра нет — читаемость даёт подложка под текстом
    if (state.style.bgMode !== 'color') {
      stage.style.backgroundImage = `url("${dataUrl}")`;
    }
    stage.style.setProperty('--st-scrim', scrimCss(state.style));
    preview.src = dataUrl;
    preview.classList.remove('hidden');
    $('btn-bg-remove').classList.remove('hidden');
    $('btn-bg-add').textContent = 'Заменить';
  } else {
    stage.classList.remove('has-bg');
    stage.style.backgroundImage = '';
    preview.removeAttribute('src');
    preview.classList.add('hidden');
    $('btn-bg-remove').classList.add('hidden');
    $('btn-bg-add').textContent = 'Выбрать';
  }
  saveProject();
}

$('btn-bg-add').addEventListener('click', () => $('bg-input').click());
$('btn-bg-remove').addEventListener('click', () => { $('bg-input').value = ''; setBgImage(null); });
$('bg-input').addEventListener('change', async () => {
  const file = $('bg-input').files[0];
  if (!file) return;
  try {
    setBgImage(await shrinkImage(file));
  } catch (e) {
    alert('Не удалось открыть эту картинку. Попробуй JPG или PNG.');
  }
});

$('btn-change-track').addEventListener('click', () => {
  $('track-info').classList.add('hidden');
  dropzone.classList.remove('hidden');
  fileInput.value = '';
});

$('btn-to-lyrics').addEventListener('click', () => goToStep(2));

/* ============================================================
   Шаг 2 — текст
   ============================================================ */
$('btn-back-1').addEventListener('click', () => goToStep(1));

/* ---------- Правка текста поверх готовой разметки ----------
   Две беды, которые это лечит.

   1. Добавил или удалил строку — вся разметка исчезала молча.
      Времена переносились, только если число строк совпало до единицы;
      иначе все они разом становились null, метки слов стирались, стек
      отмены очищался, а saveProject тут же записывал потерю.
   2. Переставил куплеты — времена молча оставались на своих местах
      по номеру, и «три» начинало петься на месте «раз».

   Лечится одним и тем же: строки сводятся ПО ТЕКСТУ, а не по номеру.
   Сначала наибольшей общей подпоследовательностью — она сохраняет
   порядок, поэтому вставку и удаление переживают все соседи. Что не
   сошлось по порядку, сводится по совпадению текста: переставленный
   куплет уносит свои времена с собой. И только если строку сопоставить
   не с чем, её время теряется — но об этом спрашивают, а не молчат. */
function alignByText(oldLines, texts) {
  const n = oldLines.length;
  const m = texts.length;
  const pairs = new Array(m).fill(-1);   // новая строка → номер старой
  if (!n || !m) return pairs;

  // Наибольшая общая подпоследовательность. На очень длинных текстах
  // таблица вышла бы великовата — там обходимся сведением по тексту.
  if (n * m <= 200000) {
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = oldLines[i].text === texts[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (oldLines[i].text === texts[j]) { pairs[j] = i; i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else j++;
    }
  }

  // Остатки — по совпадению текста, уже без оглядки на порядок
  const занято = new Set(pairs.filter((k) => k >= 0));
  const свободные = new Map();
  oldLines.forEach((l, k) => {
    if (занято.has(k)) return;
    if (!свободные.has(l.text)) свободные.set(l.text, []);
    свободные.get(l.text).push(k);
  });
  for (let j = 0; j < m; j++) {
    if (pairs[j] >= 0) continue;
    const q = свободные.get(texts[j]);
    if (q && q.length) pairs[j] = q.shift();
  }
  return pairs;
}

/* Строки прежнего проекта из хранилища — в том же виде, что state.lines.
   Нужны после перезагрузки страницы: в памяти строк ещё нет, а вся
   работа лежит в проекте. */
function linesFromProject(saved) {
  if (!saved) return [];
  const texts = String(saved.lyrics || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const по = (arr) => (Array.isArray(arr) && arr.length === texts.length ? arr : null);
  const times = по(saved.times);
  const ends = по(saved.ends);
  const hands = по(saved.handEnds);
  const guess = по(saved.guess);
  const words = по(saved.words);
  return texts.map((text, i) => {
    const l = {
      text,
      time: times ? times[i] : null,
      end: ends ? ends[i] : null,
      ручнойКонец: !!(hands && hands[i]),
      сомнительная: !!(guess && guess[i]),
    };
    const w = words ? words[i] : null;
    if (w && w.length) l.words = w.map((x) => ({ ...x }));
    return l;
  });
}

/* Сколько строк — «1 строка», «2 строки», «5 строк» */
function поРусски(n, одна, две, много) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return много;
  if (b > 1 && b < 5) return две;
  if (b === 1) return одна;
  return много;
}

$('btn-to-editor').addEventListener('click', () => {
  const raw = $('lyrics-input').value;
  const texts = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!texts.length) {
    alert('Сначала вставь текст песни — хотя бы пару строк.');
    return;
  }

  // Текст не менялся — разметку и трогать незачем
  const sameText = state.lines.length === texts.length &&
    state.lines.every((l, i) => l.text === texts[i]);
  if (!sameText) {
    /* Откуда брать прежнюю разметку: из памяти, а после перезагрузки
       страницы — из проекта. Проект считаем своим и тогда, когда песня
       ещё не открыта: имени файла в этот момент попросту нет. */
    const saved = loadProject();
    const mine = saved && (!state.fileName || saved.name === state.fileName) ? saved : null;
    const было = state.lines.length ? state.lines : linesFromProject(mine);
    const pairs = alignByText(было, texts);

    // Строки, которым не нашлось места в новом тексте: их время пропадёт
    const спасены = new Set(pairs.filter((k) => k >= 0));
    const пропали = было.filter((l, k) => l.time != null && !спасены.has(k));
    if (пропали.length) {
      const n = пропали.length;
      const слово = поРусски(n, 'строки', 'строк', 'строк');
      const примеры = пропали.slice(0, 3).map((l) => `• ${l.text}`).join('\n');
      const ок = confirm(
        `Разметка ${n} ${слово} потеряется — в новом тексте таких строк нет:\n\n`
        + примеры + (n > 3 ? `\n…и ещё ${n - 3}` : '')
        + '\n\nПрименить новый текст? Отменить правку можно будет в редакторе кнопкой «↶ отменить».');
      if (!ок) return;
    }

    /* Снимок прежней разметки — чтобы правку текста можно было отменить.
       Раньше стек отмены на этом месте очищался, и возвращать было нечего. */
    if (state.lines.length) pushHistory();

    state.lines = texts.map((text, j) => {
      const src = pairs[j] >= 0 ? было[pairs[j]] : null;
      const line = {
        text,
        time: src ? src.time : null,
        end: src && src.end != null ? src.end : null,
      };
      /* Конец считается поставленным руками, только если так и записано.
         В проектах постарше пометки нет — там концы пришли от распознавания,
         и пересчитать их заново будет только лучше. */
      line.ручнойКонец = !!(src && src.ручнойКонец);
      // Метки слов годятся, пока число слов в строке то же самое:
      // поправленную орфографию переживают, переписанную строку — нет
      const chunks = splitWords(text);
      if (src && src.words && src.words.length === chunks.length) {
        line.words = src.words.map((x, k) => ({ ...x, text: chunks[k] }));
      }
      // Пометка «время подобрано на глазок» переживает перезагрузку
      if (src && src.сомнительная) line.сомнительная = true;
      return line;
    });
    // Снимок уже лежит в стеке — редактору незачем его выбрасывать
    editor.histLines = state.lines.length;
  }

  applyRecognized(state.lines);
  saveProject();
  updateWordExportBtn();
  goToStep(3);
});

/* Настольная версия умеет размечать текст песни нейросетью и кладёт
   рядом с текстом времена строк и слов. Забираем их для тех строк,
   текст которых пользователь не переписал, и больше к ним не возвращаемся:
   ручные правки важнее машинных догадок.

   Пометка «сомнительная» приходит от подгонки своего текста: так помечены
   строки, которых нейросеть почти не расслышала, — их время подобрано
   на глазок, и человеку стоит их проверить. */
function applyRecognized(lines) {
  const src = window.__asrLines;
  if (!src || !src.length) return;
  lines.forEach((line, i) => {
    const r = src[i];
    if (!r || r.text !== line.text) return;
    line.time = r.time;
    line.end = r.end;
    line.ручнойКонец = false;
    line.сомнительная = !!r.сомнительная;
    if (r.words && r.words.length) line.words = r.words.map((w) => ({ ...w }));
  });
  window.__asrLines = null;
}

/* ============================================================
   Времена строк: прослушивание, сдвиги, пересчёт подписей

   Общая арифметика разметки. Ею пользуются и редактор, и режим
   простукивания, и дорожка — поэтому она лежит отдельно от них.
   ============================================================ */

/* Прослушать одну строку: от её начала до начала следующей */
function playLine(i) {
  const line = state.lines[i];
  if (!line || line.time == null) return;
  const next = state.lines
    .slice(i + 1)
    .find((l) => l.time != null);
  const to = next ? next.time : Math.min(line.time + 8, audio.duration);
  audio.playSegment(line.time, to);
}

/* Метки слов заданы абсолютным временем, поэтому при сдвиге строки
   их надо двигать вместе с ней — иначе разметка «съедет» */
function shiftWords(line, delta) {
  if (!delta || !line || !line.words) return;
  line.words = line.words.map((w) => ({
    ...w,
    time: w.time + delta,
    end: w.end != null ? w.end + delta : w.end,
  }));
}

/* Сдвиг одной строки с сохранением порядка: не раньше предыдущей
   и не позже следующей */
function setLineTime(i, t) {
  const line = state.lines[i];
  const prev = i > 0 && state.lines[i - 1].time != null ? state.lines[i - 1].time + 0.05 : 0;
  const next = i < state.lines.length - 1 && state.lines[i + 1].time != null
    ? state.lines[i + 1].time - 0.05
    : audio.duration;
  const was = line.time;
  line.time = Math.min(Math.max(t, prev), Math.max(prev, next));
  // Метку поправили руками — сомнений в ней больше нет
  line.сомнительная = false;
  if (was != null) shiftWords(line, line.time - was);
}

function nudgeLine(i, delta) {
  const line = state.lines[i];
  if (!line || line.time == null) return;
  setLineTime(i, line.time + delta);
  refreshTimes();
  saveProject();
}

function setLineEnd(i, t) {
  const line = state.lines[i];
  if (!line || line.time == null) return;
  const next = state.lines.slice(i + 1).find((l) => l.time != null);
  const max = next ? next.time - 0.05 : audio.duration;
  line.end = Math.min(Math.max(t, line.time + 0.05), max);
  // Дальше этот конец не пересчитывается: человек сказал своё слово
  line.ручнойКонец = true;
}

function nudgeLineEnd(i, delta) {
  const line = state.lines[i];
  if (!line || line.time == null) return;
  // Считаем от того конца, который человек видит на сцене
  setLineEnd(i, lineEnd(syncedLines(), syncedLines().indexOf(line)) + delta);
  refreshTimes();
  saveProject();
  editor.stageKey = '';
}

function shiftAllLines(delta) {
  state.lines.forEach((l) => {
    if (l.time != null) {
      const was = l.time;
      l.time = Math.min(Math.max(l.time + delta, 0), audio.duration);
      shiftWords(l, l.time - was);
    }
  });
  refreshTimes();
  saveProject();
}

/* Обновить отображение таймингов в списке редактора.
   Список не пересобираем: там правят текст, и пересборка узлов
   выбила бы курсор из поля. Меняем только подписи времени. */
function refreshTimes() {
  editor.spansKey = '';   // времена поехали — раскладку дорожки пересчитать
  const synced = syncedLines();
  document.querySelectorAll('#edit-list .ts[data-ts-i]').forEach((el) => {
    const line = state.lines[+el.dataset.tsI];
    if (line) el.textContent = line.time == null ? '–:––' : fmtTime(line.time);
  });
  document.querySelectorAll('#edit-list .end-ts[data-end-ts-i]').forEach((el) => {
    const line = state.lines[+el.dataset.endTsI];
    if (!line) return;
    el.classList.toggle('empty', !line.ручнойКонец);
    el.textContent = line.time == null
      ? '–:––' : `до ${fmtTime(lineEnd(synced, synced.indexOf(line)))}`;
  });
  document.querySelectorAll('#edit-list .dur-ts[data-dur-i]').forEach((el) => {
    const line = state.lines[+el.dataset.durI];
    if (!line) return;
    const i = synced.indexOf(line);
    el.textContent = line.time == null
      ? '' : `${(lineEnd(synced, i) - lineStart(synced, i)).toFixed(1)} с`;
  });
  updateSelInfo();
}

/* ============================================================
   Шаг 4 — караоке-плеер
   ============================================================ */
const player = { raf: null, stageKey: '' };

function syncedLines() {
  return state.lines.filter((l) => l.time != null);
}

function currentLineIndex(pos) {
  const lines = syncedLines();
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (pos >= lineStart(lines, i)) idx = i; else break;
  }
  return idx;
}

/* ============================================================
   Размах строки: где она начинается и где кончается

   Раньше конец строки был выдуман: если до следующей строки больше
   шести секунд, строка объявлялась спетой ровно за четыре, а всё
   остальное — проигрышем. На распеве вроде «пропада-да-да-да-даю»
   подсветка обрывалась на полуслове, а коротких проигрышей набегало
   столько, что петь было сумбурно.

   Теперь конец берётся из настоящих источников, в таком порядке:
   1) конец, выставленный руками в редакторе, — он главнее всего;
   2) конец последнего слова строки (разметка слов или распознавание);
   3) следующая строка, если она идёт сразу за этой;
   4) и только когда не известно ничего — привычная длина строки
      в этой песне.
   И поверх всего: если на этом месте голос ещё звучит, строка тянется,
   пока он не смолкнет. Про голос знает огибающая вокальной дорожки.
   ============================================================ */

/* Порог проигрыша. Пауза короче — просто вдох между строками, ноты на
   ней только сбивают: для таких пауз есть отсчёт из трёх точек. Ноты
   ставим лишь на настоящие инструментальные куски. Восемь секунд — то,
   что получилось на живой песне: см. README, раздел про проигрыши. */
const BREAK_MIN = 8;
const SING_DUR = 4;        // длина строки, когда не известно вообще ничего
const SNAP_WINDOW = 0.7;   // насколько строка вправе подтянуться к голосу
const SNAP_WINDOW_WEAK = 1.5;  // столько же для строки со знаком «≈»
const VOICE_TAIL_MAX = 4;  // насколько голос вправе продлить строку
const VOICE_HOLD = 0.35;   // пауза, в которую голос ещё считается звучащим

/* Начало строки подтягиваем к настоящему вступлению голоса: расчётное
   время бывает раньше, чем певец открыл рот, и подсветка убегает вперёд.
   Окно намеренно узкое — строка поправляется, но никуда не уезжает.
   Строке со знаком «≈» окно шире: подгонка сама призналась, что её время
   подобрано на глазок, и ошибаться она там может куда сильнее. */
function lineStart(lines, index) {
  const line = lines[index];
  const t = line.time;
  if (!voiceReady()) return t;
  const prev = index > 0 ? lines[index - 1].time : -Infinity;
  const next = index + 1 < lines.length ? lines[index + 1].time : Infinity;
  /* Окно не шире половины расстояния до соседей: иначе две соседние
     строки могли бы подтянуться к одному и тому же вступлению
     и налезть друг на друга. */
  const w = Math.min(line.сомнительная ? SNAP_WINDOW_WEAK : SNAP_WINDOW,
    (t - prev) * 0.45, (next - t) * 0.45);
  if (!(w > 0.05)) return t;
  const onset = voiceOnsetNear(t, t - w, t + w);
  return onset == null ? t : onset;
}

/* Привычная длина строки в этой песне — на случай, когда о строке
   не известно ничего: ни слов, ни голоса, а следующая строка далеко.
   Медиана лучше среднего: её не портит одна затянутая строка. */
function typicalLineDur(lines) {
  const gaps = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const g = lines[i + 1].time - lines[i].time;
    if (g > 0.5 && g <= BREAK_MIN) gaps.push(g);
  }
  if (!gaps.length) return SING_DUR;
  gaps.sort((a, b) => a - b);
  return Math.max(2, Math.min(8, gaps[gaps.length >> 1]));
}

/* Возвращает { start, core, end }:
   core — докуда строка спета по словам, end — докуда её тянет голос.
   Разница между ними достаётся последнему слову: на распеве тянется
   именно оно, а не вся строка разом. */
function lineSpan(lines, index) {
  const line = lines[index];
  const start = lineStart(lines, index);
  const next = index + 1 < lines.length ? lineStart(lines, index + 1) : null;
  const limit = next != null ? next - 0.02 : (audio.duration || start + SING_DUR);
  const fit = (t) => Math.max(start + 0.05, Math.min(t, Math.max(start + 0.05, limit)));

  /* Конец, выставленный руками в редакторе, важнее любой автоматики.
     Именно руками: конец, пришедший от распознавания, — это всего лишь
     конец последнего слова, и продлевать его голосом не только можно,
     но и нужно, иначе распев так и будет обрываться. */
  if (line.ручнойКонец && line.end != null) {
    const e = fit(line.end);
    return { start, core: e, end: e };
  }

  let core;
  if (line.words && line.words.length) {
    const last = line.words[line.words.length - 1];
    const natEnd = last.end != null ? last.end : last.time + 0.3;
    // Слова размечены абсолютным временем: если строка подтянулась
    // к голосу, её конец едет вместе с началом
    core = fit(natEnd + (start - line.time));
  } else if (next != null && next - start <= BREAK_MIN) {
    core = limit;                                  // строки идут подряд
  } else {
    core = fit(start + typicalLineDur(lines));
  }

  // Голос ещё звучит — строка не спета, тянем её до конца пения
  let end = core;
  const heard = voiceEndFrom(core, VOICE_HOLD);
  if (heard != null) end = fit(Math.max(core, Math.min(heard, core + VOICE_TAIL_MAX)));
  return { start, core, end };
}

function lineEnd(lines, index) {
  return lineSpan(lines, index).end;
}

function stagePhase(pos) {
  const lines = syncedLines();
  if (!lines.length) return { mode: 'empty', cur: -1 };
  const cur = currentLineIndex(pos);

  if (cur === -1) {
    // Вступление до первой строки
    const first = lineStart(lines, 0);
    if (first >= BREAK_MIN) return { mode: 'break', cur, start: 0, until: first };
    return { mode: 'intro', cur, next: first };
  }

  const sp = lineSpan(lines, cur);
  const next = cur + 1 < lines.length ? lineStart(lines, cur + 1) : null;
  /* Ноты — только там, где голоса нет достаточно долго. Пауза покороче
     остаётся за текущей строкой: она просто стоит допетая, а о вступлении
     следующей предупреждает отсчёт. */
  if (next != null && next - sp.end >= BREAK_MIN && pos >= sp.end) {
    return { mode: 'break', cur, start: sp.end, until: next };
  }
  return { mode: 'line', cur, start: sp.start, core: sp.core, end: sp.end, next };
}

/* ---------- Отсчёт перед вступлением строки ----------
   Три точки гаснут по одной за COUNT_LEAD секунд до начала строки.
   Показываем только там, где перед строкой действительно есть пауза:
   после проигрыша, перед самым первым куплетом и в паузе между строками,
   которая для нот проигрыша коротка, а для певца всё же ощутима. */
const COUNT_LEAD = 3;      // за сколько секунд начинается отсчёт
const COUNT_MIN_GAP = 2.2; // короче этой паузы отсчёт только мешает
const COUNT_DOTS = 3;

function countdownState(pos, ph) {
  if (!state.style.countdown) return null;
  const lines = syncedLines();
  if (!lines.length) return null;

  let next = null;
  let from = null;
  if (ph.mode === 'break') { next = ph.until; from = ph.start; }
  else if (ph.mode === 'intro') { next = ph.next != null ? ph.next : lines[0].time; from = 0; }
  // Строка допета, следующая ещё не началась — та самая короткая пауза
  else if (ph.mode === 'line' && ph.next != null && pos >= ph.end) {
    next = ph.next;
    from = ph.end;
  } else return null;
  if (next == null || next - from < COUNT_MIN_GAP) return null;

  const left = next - pos;
  if (left < 0 || left > COUNT_LEAD) return null;
  const step = COUNT_LEAD / COUNT_DOTS;
  return {
    left,
    lit: Math.min(COUNT_DOTS, Math.ceil(left / step)),   // сколько точек ещё горит
    // Доля текущей точки: 1 в начале её секунды, 0 в конце — для сжатия
    frac: Math.min(1, Math.max(0, (left % step) / step || (left > 0 ? 1 : 0))),
  };
}

/* Подложка под текстом: вместо затемнения всего кадра — мягкая полоса
   там, где стоят строки. Одни и те же остановки идут и в CSS, и в видео. */
function scrimStops(s) {
  const k = (s.scrim || 0) / 100;
  if (k <= 0) return null;
  let mid;
  let half;
  if (!s.swapLines) {
    const a = Math.min(s.posCurrent, s.posNext);
    const b = Math.max(s.posCurrent, s.posNext);
    mid = (a + b) / 2;
    half = (b - a) / 2 + 14;
  } else if (s.valign === 'flex-start') { mid = 26; half = 30; }
  else if (s.valign === 'flex-end') { mid = 74; half = 30; }
  else { mid = 50; half = 32; }

  const clamp = (v) => Math.max(0, Math.min(100, v)) / 100;
  return [
    [mid - half - 16, 0], [mid - half, 0.42], [mid - half * 0.45, 0.86],
    [mid + half * 0.45, 0.86], [mid + half, 0.42], [mid + half + 16, 0],
  ].map(([at, a]) => ({ at: clamp(at), alpha: +(a * k).toFixed(3) }));
}

function scrimCss(s) {
  const stops = scrimStops(s);
  if (!stops) return 'none';
  const parts = stops.map((p) => `rgba(8, 8, 12, ${p.alpha}) ${(p.at * 100).toFixed(1)}%`);
  return `linear-gradient(to bottom, ${parts.join(', ')})`;
}

/* Системная настройка «меньше движения» — гасит все анимации студии */
const reduceMotion = window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

/* ---------- Слова внутри строки ----------
   Если слова размечены вручную или распознаванием, берём их метки.
   Иначе делим время строки между словами пропорционально длине:
   длинное слово поётся дольше короткого. Это грубее точной разметки,
   но подсветка идёт по словам, а не ползёт сквозь них. */
function splitWords(text) {
  // Пробелы приклеиваем к предыдущему слову, чтобы подсветка шла сплошняком
  const parts = text.match(/\S+\s*/g);
  return parts ? parts : [];
}

function lineWords(line, span) {
  const start = span.start;
  const end = span.end;
  const core = span.core != null ? span.core : end;

  if (line.words && line.words.length) {
    const arr = line.words;
    const last = arr[arr.length - 1];
    const natEnd = last.end != null ? last.end : last.time + 0.3;
    /* Метки слов заданы абсолютным временем. Строку могло подтянуть
       к настоящему вступлению голоса — тогда метки едут за ней ровно
       на ту же величину, иначе подсветка бежала бы впереди певца.
       И только если сдвинутая строка налезает на следующую, она ужимается.
       Без голосовой дорожки сдвиг нулевой, ужимать нечего, и метки
       остаются ровно теми, что размечены. */
    const delta = start - line.time;
    const shifted = natEnd + delta;
    const k = shifted > start ? Math.min(1, (core - start) / (shifted - start)) : 1;
    const at = (t) => start + (t + delta - start) * k;
    return arr.map((w, i) => ({
      text: w.text,
      start: at(w.time),
      end: i === arr.length - 1
        // Последнее слово тянется, пока звучит голос: это и есть распев
        ? Math.max(at(natEnd), end)
        : at(w.end != null ? w.end : arr[i + 1].time),
    }));
  }

  const chunks = splitWords(line.text);
  if (!chunks.length) return [];
  // Вес слова — число букв без пробелов, минимум единица
  const weights = chunks.map((c) => Math.max(1, c.trim().length));
  const total = weights.reduce((a, b) => a + b, 0);
  const width = Math.max(0.05, core - start);
  const out = [];
  let acc = start;
  for (let i = 0; i < chunks.length; i++) {
    const dur = width * (weights[i] / total);
    out.push({ text: chunks[i], start: acc, end: acc + dur });
    acc += dur;
  }
  // Хвост распева достаётся последнему слову, а не всей строке разом
  out[out.length - 1].end = Math.max(out[out.length - 1].end, end);
  return out;
}

/* Сколько слова уже спето: целые слова закрашены полностью,
   текущее доезжает плавно внутри себя */
function wordProgress(words, pos) {
  const done = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (pos >= w.end) done.push(1);
    else if (pos <= w.start) done.push(0);
    else done.push((pos - w.start) / Math.max(0.03, w.end - w.start));
  }
  return done;
}

/* Строка собирается из слов: каждое слово — отдельный элемент,
   чтобы подсветка переключалась на границах слов */
function buildLineEl(text, cls) {
  const div = document.createElement('div');
  div.className = 'stage-line' + (cls ? ' ' + cls : '');
  // Текст помним на самом узле: по нему решается, переносить ли строку
  div.dataset.text = text;
  for (const chunk of splitWords(text)) {
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = chunk;
    div.appendChild(span);
  }
  if (!div.children.length) div.textContent = text;
  return div;
}

function applyWordFill(el, line, span, pos) {
  const words = lineWords(line, span);
  const done = wordProgress(words, pos);
  const spans = el.querySelectorAll('.w');
  for (let i = 0; i < spans.length; i++) {
    const p = done[i] != null ? done[i] : 0;
    spans[i].style.setProperty('--wfill', `${(p * 100).toFixed(1)}%`);
    spans[i].classList.toggle('sung', p >= 0.5);
  }
}

const BREAK_TEXT = '♪ ♪ ♪';
/* В кадре видео нет разрядки из CSS, поэтому там ноты разводим пробелами —
   чтобы выглядели так же, как на экране */
const BREAK_TEXT_FRAME = '♪   ♪   ♪';

/* ---------- Сборка сцены с переиспользованием строк ----------
   Раньше сцена собиралась заново на каждой строке, поэтому смена строк
   выглядела рывком: браузеру нечего было плавно менять. Теперь элементы
   живут между кадрами, а меняются только классы — и переход прозрачности
   и цвета проигрывается настоящим CSS-переходом. */
function syncStageLines(stage, items) {
  const old = new Map();
  Array.from(stage.children).forEach((el) => {
    if (el.classList.contains('stage-count')) return; // отсчёт живёт отдельно
    const key = el.dataset ? el.dataset.key : null;
    if (key != null) old.set(key, el);
    else el.remove();
  });

  const out = [];
  for (const it of items) {
    let el = old.get(it.key);
    if (el && el.dataset.text !== it.text) { old.delete(it.key); el.remove(); el = null; }
    let fresh = false;
    if (el) {
      old.delete(it.key);
    } else {
      el = buildLineEl(it.text, '');
      el.dataset.key = it.key;
      el.dataset.text = it.text;
      fresh = true;
    }
    const wasCurrent = el.classList.contains('current');
    el.className = 'stage-line' + (it.cls ? ` ${it.cls}` : '') + (fresh ? ' enter' : '');
    // Строка перестала быть активной — снимаем с неё закраску слов,
    // иначе при перемотке назад мелькнёт старая доля
    if (wasCurrent && !el.classList.contains('current')) {
      el.querySelectorAll('.w').forEach((s) => s.style.removeProperty('--wfill'));
    }
    if (it.top != null) {
      // Своё место запоминаем: fitStageLines двигает строку от него,
      // когда перенесённая на два ряда строка иначе налезла бы на соседку
      el.dataset.top = it.top;
      el.style.top = `${it.top}%`;
    } else {
      delete el.dataset.top;
      el.style.removeProperty('top');
    }
    if (it.index != null) el.dataset.index = it.index;
    out.push(el);
  }
  old.forEach((el) => el.remove());

  // Расставляем по порядку, не трогая те, что уже стоят где надо:
  // перенос узла в DOM сбрасывает переходы и анимации
  out.forEach((el, i) => {
    if (stage.children[i] !== el) stage.insertBefore(el, stage.children[i] || null);
  });
  return out;
}

/* Точки отсчёта — отдельный слой поверх сцены, чтобы не сбивать
   раскладку строк. Место считаем один раз при перерисовке. */
function ensureCountdownEl(stage) {
  let el = stage.querySelector('.stage-count');
  if (!el) {
    el = document.createElement('div');
    el.className = 'stage-count';
    for (let i = 0; i < COUNT_DOTS; i++) el.appendChild(document.createElement('i'));
    stage.appendChild(el);
  } else if (stage.lastElementChild !== el) {
    // Держим последним, поверх строк. Лишний перенос узла сбрасывал бы
    // его переход прозрачности, поэтому двигаем только когда правда надо.
    stage.appendChild(el);
  }
  return el;
}

function placeCountdown(stage) {
  const el = stage.querySelector('.stage-count');
  if (!el) return;
  // Отсчёт стоит там, где ноты проигрыша, а если их нет — над строкой,
  // которая вот-вот зазвучит
  const anchor = stage.querySelector('.break-line') || stage.querySelector('.stage-line.near');
  if (!anchor) { el.style.top = '50%'; return; }
  const sr = stage.getBoundingClientRect();
  const r = anchor.getBoundingClientRect();
  if (!sr.height || !r.height) { el.style.top = '50%'; return; }
  const y = anchor.classList.contains('break-line')
    ? r.top - sr.top + r.height / 2
    : r.top - sr.top - Math.max(12, r.height * 0.35);
  el.style.top = `${((y / sr.height) * 100).toFixed(2)}%`;
}

function updateCountdown(stage, cd) {
  const el = stage.querySelector('.stage-count');
  if (!el) return;
  stage.classList.toggle('counting', !!cd);
  if (!cd) return;
  const dots = el.children;
  for (let i = 0; i < dots.length; i++) {
    // Гаснут справа налево: последняя точка уходит перед самым вступлением
    const alive = i < cd.lit;
    dots[i].classList.toggle('off', !alive);
    dots[i].style.setProperty('--cd-p',
      alive && i === cd.lit - 1 && !reduceMotion.matches ? cd.frac.toFixed(3) : '1');
  }
}

/* ---------- Единый кегль на всю песню ----------
   Кегль один на всю песню: строки не прыгают в размере от строки
   к строке. Считается он одинаково для трёх поверхностей — сцены
   караоке, предпросмотра редактора и кадра видео, — поэтому все
   трое выглядят одинаково по пропорциям.

   Отсчёт идёт от ширины ТОЙ поверхности, где рисуем: кегль при
   «Размер 100%» равен ширине поверхности, делённой на FIT_FRAME_COLS.
   Сцена шириной 800 px и кадр шириной 1280 px дают разные кегли
   в пикселях, но одну и ту же долю картинки.

   Беда, которую это лечит: раньше кегль считался в кадровых единицах
   (кадр 1280 px, база 40 px), а потом домножался на (ширина сцены /
   база) / 32 — база сокращалась, и выбранный человеком размер из
   формулы исчезал совсем. Ползунок «Размер» выше 100% не делал ничего:
   100%, 160% и 220% давали один и тот же кегль (18,4 / 18,65 / 18,65 px).

   Ползунок «Размер» отсчитывается от ЗАПОЛНЯЮЩЕГО кегля: 100% — самый
   крупный кегль, при котором каждая строка ещё умещается в один ряд.
   Поэтому по умолчанию текст занимает сцену целиком, а ползунок живой
   во всём диапазоне: ниже 100% текст мельче, выше — крупнее, а строки,
   переставшие влезать в ряд, переносятся на два и больше, как принято
   в нынешних караоке-плеерах.

   Прежняя беда была именно здесь: подгонка держала строку у края и не
   давала расти дальше. Ползунок выше 160% снова ничего не делал —
   для человека это тот же дефект, что и раньше.

   Ширину строк меряем холстом: коробки строк в DOM врут (у закреплённой
   строки коробка шире полей сцены), а холст даёт ровно ширину текста
   тем же шрифтом — холст и DOM сходятся до сотых долей пикселя, если
   мерить одним и тем же кеглем. Ширина считается в долях кегля —
   «сколько кеглей в ширину занимает строка», — но от кегля она всё же
   зависит (см. stageMetrics), поэтому кегль ищется повторным
   приближением в stageFit. */
const FIT_FRAME_COLS = 32;   // опорная ширина поверхности в базовых кеглях
const FIT_MEASURE = 40;      // с какого кегля начинаем приближение
const FIT_MAX_UNITS = 3.2;   // потолок заполняющего кегля: песне из двух слов
const FIT_MIN_UNITS = 0.55;  // пол: ниже строка не ужимается, а переносится
const FIT_SAFE = 0.99;       // запас на неточность замера: строка не липнет к краю

const stageMetricsCache = { key: null, кегли: new Map(), ctx: null };

function fitCanvasCtx() {
  if (!stageMetricsCache.ctx) {
    stageMetricsCache.ctx = document.createElement('canvas').getContext('2d');
  }
  return stageMetricsCache.ctx;
}

/* Ширины строк в долях кегля: строка с em = 12,5 при кегле 40 px займёт
   500 px. Разрядка сюда не входит — она задаётся в пикселях и от кегля
   не зависит, поэтому её добавляют отдельно, по числу букв.

   Мерить надо ТЕМ кеглем, которым строка будет нарисована. Ширина буквы
   не строго пропорциональна кеглю: на мелких кеглях браузер округляет
   ширины глифов вверх, и та же строка занимает заметно больше кеглей,
   чем на крупных. Замер одной и той же строки системным шрифтом:

     кегль, px    10     12   14,7     18     30     40     80
     ширина, em  26,24  25,61  24,85  24,16  23,38  23,17  22,66

   Разница между 14,7 и 40 — 7,3%. Раньше мерили только кеглем 40 px
   и считали ширину пропорциональной, поэтому в предпросмотре редактора
   (самая мелкая из трёх поверхностей) строка выходила на те же 7%
   шире расчёта и вылезала за правый край окна. */
function stageMetrics(кегль) {
  const s = state.style;
  const texts = syncedLines().map((l) => l.text);
  const key = [s.font, s.weight, texts.length, texts.join(' ')].join('|');
  if (stageMetricsCache.key !== key) {
    stageMetricsCache.key = key;
    stageMetricsCache.кегли.clear();
  }
  /* Кегль округляем вниз до половины пикселя: на замере это почти
     не сказывается (и в безопасную сторону — ширина чуть с запасом),
     зато замеров получается немного, а кадр видео зовёт подгонку
     на каждом кадре. */
  const px = Math.max(4, Math.min(400, Math.floor((+кегль || FIT_MEASURE) * 2) / 2));
  const готовое = stageMetricsCache.кегли.get(px);
  if (готовое) return готовое;

  const g = fitCanvasCtx();
  const family = (FONTS[s.font] || FONTS.system).css;
  g.font = `${s.weight} ${px}px ${family}`;
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  const list = texts.map((t) => ({
    text: t,
    em: g.measureText(t).width / px,
    chars: t.length,
  }));

  // Память не копим без края: за сеанс кеглей набегает много (ползунок размера)
  if (stageMetricsCache.кегли.size > 32) stageMetricsCache.кегли.clear();
  stageMetricsCache.кегли.set(px, list);
  return list;
}

/* Единый кегль для одной поверхности.
   unit  — базовый кегль поверхности: её ширина / FIT_FRAME_COLS;
   avail — сколько ширины отдано тексту (поверхность минус поля по краям).

   Возвращает готовый кегль в пикселях, набор строк, которые надо
   переносить, и на сколько рядов растянется самая длинная из них. */
function stageFit(unit, avail) {
  const s = state.style;
  const доля = Math.max(0.2, (+s.size || 100) / 100);
  const ls = +s.letter || 0;
  const room = Math.max(0, avail) * FIT_SAFE;

  /* Заполняющий кегль — самый крупный, при котором каждая строка ещё
     умещается в один ряд. Это и есть «Размер 100%».

     Ищем его повторным приближением: померили — посчитали кегль —
     померили этим же кеглем ещё раз. Одного захода мало, потому что
     ширина строки в долях кегля сама зависит от кегля (см. stageMetrics),
     и на мелкой поверхности первый ответ занижен процентов на семь.
     Сходится за два-три шага: ширина меняется куда медленнее кегля. */
  const заполняющий = (lines) => {
    let f = Infinity;
    for (const l of lines) {
      if (l.em <= 0) continue;
      const m = (room - ls * l.chars) / (l.em * unit);
      if (m < f) f = m;
    }
    if (!isFinite(f)) f = 1;
    return Math.min(FIT_MAX_UNITS, Math.max(FIT_MIN_UNITS, f));
  };

  let fill = заполняющий(stageMetrics(FIT_MEASURE));
  for (let шаг = 0; шаг < 3; шаг++) {
    const снова = заполняющий(stageMetrics(unit * fill));
    const сошлось = Math.abs(снова - fill) * unit < 0.05;
    fill = снова;
    if (сошлось) break;
  }

  const m = fill * доля;
  const size = Math.max(1, unit * m);

  /* Что в один ряд уже не влезло — переносим, как в нынешних караоке.
     Ширины берём померенные тем самым кеглем, которым и нарисуем:
     иначе на мелкой поверхности строка «влезала» по расчёту и вылезала
     на деле. */
  const wrap = new Set();
  let rows = 1;
  for (const l of stageMetrics(size)) {
    const w = l.em * size + ls * l.chars;
    if (w > avail + 0.5) {
      wrap.add(l.text);
      rows = Math.max(rows, Math.ceil(w / Math.max(1, avail)));
    }
  }
  return { size, m, fill, rows, wrap };
}

/* Места двух закреплённых строк, в пикселях от верха поверхности.
   Строка, перенесённая на несколько рядов, выше обычной, и на своих
   местах две такие налезли бы друг на друга — поэтому места
   раздвигаются вокруг общей середины. Считается одинаково для сцены,
   предпросмотра и кадра видео, поэтому все трое кладут строки туда же. */
function slotPositions(fit, H) {
  const s = state.style;
  const rowH = fit.size * ((+s.line || 13) / 10);
  const half = (fit.rows * rowH) / 2;
  let a = H * (s.posCurrent / 100);
  let b = H * (s.posNext / 100);
  if (Math.abs(b - a) < half * 2) {
    const середина = (a + b) / 2;
    const знак = b >= a ? 1 : -1;
    a = середина - знак * half * 1.05;
    b = середина + знак * half * 1.05;
  }
  const вКрая = (v) => Math.min(Math.max(v, half), Math.max(half, H - half));
  return { a: вКрая(a), b: вКрая(b), rowH, half };
}

/* Единый кегль для сцены на экране. Считаем по ширине самой сцены:
   караоке меряется по караоке, предпросмотр редактора — по себе.
   Готовый кегль кладём в --st-fs, поштучных размеров у строк нет. */
function fitStageLines(container) {
  if (!container) return null;
  const box = container.clientWidth;
  if (box <= 0) return null;   // шаг сейчас скрыт — мерить нечего
  const cs = getComputedStyle(container);
  const avail = box - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const fit = stageFit(box / FIT_FRAME_COLS, avail);
  const межстрочный = (+state.style.line || 13) / 10;
  container.style.setProperty('--st-fs', `${fit.size.toFixed(2)}px`);
  /* Высота ряда — та же доля кегля, что в видео: перенесённая строка
     занимает на экране ровно столько же рядов и той же высоты. */
  container.style.setProperty('--st-lh', межстрочный.toFixed(2));
  /* Просвет между строками в режиме прокрутки. В em его задавать нельзя:
     em у сцены считается от её собственного шрифта, а не от кегля строк. */
  const gap = Math.max(0, (межстрочный - 1) * fit.size);
  container.style.setProperty('--st-gap', `${gap.toFixed(1)}px`);
  container.querySelectorAll('.stage-line').forEach((el) => {
    el.style.fontSize = '';  // размер задаёт --st-fs, а не отдельная строка
    const text = el.dataset.text != null ? el.dataset.text : el.textContent;
    el.classList.toggle('wrap', fit.wrap.has(text));
  });
  placeSlotLines(container, fit);
  return fit;
}

/* Расставляем закреплённые строки по их местам с поправкой на перенос */
function placeSlotLines(container, fit) {
  const s = state.style;
  const H = container.clientHeight;
  const строки = container.querySelectorAll('.stage-line[data-top]');
  if (!строки.length) return;
  if (s.swapLines || !H) {
    строки.forEach((el) => { el.style.top = `${el.dataset.top}%`; });
    return;
  }
  const p = slotPositions(fit, H);
  строки.forEach((el) => {
    const своё = +el.dataset.top;
    const y = своё === s.posCurrent ? p.a : (своё === s.posNext ? p.b : H * своё / 100);
    el.style.top = `${((y / H) * 100).toFixed(2)}%`;
  });
}

/* Две строки на закреплённых местах. Активна та, чья очередь петь,
   вторая показывает, что будет дальше. Местами они не меняются. */
function fixedSlotItems(lines, ph) {
  const s = state.style;
  const cur = ph.cur;
  const activeSlot = cur < 0 ? 0 : cur % 2;   // 0 — первое место, 1 — второе
  const nextIndex = cur < 0 ? 0 : cur + 1;
  const items = [];
  /* Проигрыш занимает целое место, а не рисуется поверх строки.
     Место выбираем так, чтобы следующая строка осталась на виду:
     ноты встают туда, где её нет. Строку с этого места убираем —
     из-за неё ноты и налезали на текст. */
  const nextSlot = cur < 0 ? 0 : 1 - activeSlot;
  const breakSlot = 1 - nextSlot;

  for (const slot of [0, 1]) {
    if (ph.mode === 'break' && slot === breakSlot) continue;
    let index;
    let active = false;
    if (cur < 0) {
      // До первой строки показываем только начало
      index = slot === 0 ? 0 : 1;
    } else if (slot === activeSlot) {
      index = cur;
      active = ph.mode !== 'break';
    } else {
      index = nextIndex;
    }
    if (index >= lines.length) continue;

    let cls = 'slot';
    if (active) cls += ' current';
    else if (index === nextIndex) cls += ' near';
    items.push({
      key: `slot${slot}`, text: lines[index].text, cls, index,
      top: slot === 0 ? s.posCurrent : s.posNext,
    });
  }

  if (ph.mode === 'break') {
    items.push({
      key: 'break', text: BREAK_TEXT, cls: 'slot current break-line',
      top: breakSlot === 0 ? s.posCurrent : s.posNext,
    });
  }
  return items;
}

function scrollingItems(lines, ph) {
  const cur = ph.cur;
  const items = [];
  if (ph.mode === 'break' && cur === -1) {
    items.push({ key: 'break', text: BREAK_TEXT, cls: 'current break-line' });
  }

  // Окно строк вокруг текущей: сколько показывать — из настроек
  const total = state.style.lines;
  const before = Math.min(2, Math.floor((total - 1) / 2));
  const from = Math.max(0, cur - before);
  const to = Math.min(lines.length, from + total);
  for (let i = from; i < to; i++) {
    let cls = '';
    if (i === cur && ph.mode === 'line') cls = 'current';
    else if (i === cur + 1) cls = 'near';
    // Песня ещё не дошла до первой строки — подсвечиваем её как ближайшую
    else if (i === 0 && cur === -1 && ph.mode !== 'break') cls = 'near';
    items.push({ key: `l${i}`, text: lines[i].text, cls, index: i });
    if (i === cur && ph.mode === 'break') {
      items.push({ key: 'break', text: BREAK_TEXT, cls: 'current break-line' });
    }
  }
  return items;
}

function renderStage() {
  const stage = $('lyrics-stage');
  const lines = syncedLines();
  if (!lines.length) {
    stage.innerHTML = '<p class="stage-empty">Нет синхронизированных строк</p>';
    return;
  }
  if (stage.querySelector('.stage-empty')) stage.innerHTML = '';
  const pos = audio.position();
  const ph = stagePhase(pos);
  player.stageKey = state.style.swapLines
    ? `${ph.mode}:${ph.cur}`
    : `${ph.mode}:${ph.cur}:${ph.cur % 2}`;

  /* Режим закреплённых мест: две строки стоят каждая на своём месте
     и не съезжают вверх. Чётные строки живут на первом месте, нечётные
     на втором — как в обычном караоке, где строки чередуются. */
  syncStageLines(stage, state.style.swapLines
    ? scrollingItems(lines, ph)
    : fixedSlotItems(lines, ph));
  fitStageLines(stage);
  ensureCountdownEl(stage);
  placeCountdown(stage);
  updateCountdown(stage, countdownState(pos, ph));
}

function updateStageFill() {
  const lines = syncedLines();
  if (!lines.length) return;
  const pos = audio.position();
  const ph = stagePhase(pos);
  // В режиме закреплённых мест перерисовываем и при смене активного места
  const key = state.style.swapLines
    ? `${ph.mode}:${ph.cur}`
    : `${ph.mode}:${ph.cur}:${ph.cur % 2}`;
  if (key !== player.stageKey) renderStage();
  const stage = $('lyrics-stage');
  updateCountdown(stage, countdownState(pos, ph));
  const el = stage.querySelector(
    ph.mode === 'break' ? '.break-line' : '.stage-line.current');
  if (!el) return;

  if (ph.mode === 'break') {
    // Ноты — три «слова»: закрашиваем их по ходу проигрыша
    const start = ph.start;
    const end = ph.until;
    const p = end > start ? Math.min(1, Math.max(0, (pos - start) / (end - start))) : 1;
    const spans = el.querySelectorAll('.w');
    for (let i = 0; i < spans.length; i++) {
      const share = Math.min(1, Math.max(0, p * spans.length - i));
      spans[i].style.setProperty('--wfill', `${(share * 100).toFixed(1)}%`);
      spans[i].classList.toggle('sung', share >= 0.5);
    }
    return;
  }
  applyWordFill(el, lines[ph.cur], ph, pos);
}

/* Пишем в DOM только при реальном изменении: обновление текста кнопки
   60 раз в секунду «съедает» клики в Safari (узел пересоздаётся
   между нажатием и отпусканием мыши) */
function setText(id, text) {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

function updatePlayerUI() {
  setText('btn-play', audio.playing ? '⏸' : '▶');
  setText('time-current', fmtTime(audio.position()));
  setText('time-total', fmtTime(audio.duration));
  if (!seekDragging && audio.duration) {
    const v = String(Math.round((audio.position() / audio.duration) * 1000));
    const seek = $('seek');
    if (seek.value !== v) seek.value = v;
  }
}

function tickPlayer() {
  updatePlayerUI();
  updateStageFill();

  // Конец прослушиваемого отрывка — пауза
  if (audio.playing && audio.stopAt != null && audio.position() >= audio.stopAt) {
    audio.endSegment();
    // Отрывок доиграл до конца строки — разметку слов закрываем с сохранением
    if (wordTap.active) finishWordTap(true);
    updatePlayerUI();
  }
  if (wordTap.active) highlightWordTap();

  // Обновление редактора
  if ($('step-3').classList.contains('active') && editor.peaks) {
    setText('edit-time', fmtTime(audio.position()));
    setText('btn-edit-play', audio.playing ? '⏸' : '▶');
    tickLoop();
    // В режиме простукивания предпросмотр убран с глаз — считать его незачем
    if (tap.active) setText('tap-time', fmtTime(audio.position()));
    else updateEditStage();
    followPlayhead();
    drawTimeline();
  }

  player.raf = requestAnimationFrame(tickPlayer);
}

$('btn-play').addEventListener('click', () => {
  if (audio.playing) audio.pause();
  else {
    audio.play();
    audio.onEnded = () => updatePlayerUI();
  }
  updatePlayerUI();
});

let seekDragging = false;
$('seek').addEventListener('input', () => { seekDragging = true; });
$('seek').addEventListener('change', () => {
  const pos = ($('seek').value / 1000) * audio.duration;
  seekDragging = false;
  if (audio.playing) audio.play(pos);
  else audio.offset = pos;
  updatePlayerUI();
  renderStage();
});

$('vocal-mix').addEventListener('input', () => {
  state.vocalMix = $('vocal-mix').value / 100;
  $('vocal-mix-value').textContent = `${$('vocal-mix').value}%`;
  audio.applyMix();
});

/* ---------- Оформление текста ---------- */

/* Раскладываем настройки в CSS-переменные обеих сцен */
function applyStyle() {
  const s = state.style;
  const stages = [$('lyrics-stage'), $('edit-stage')];
  stages.forEach((stage) => {
    if (!stage) return;
    /* Кегль здесь не задаётся: его считает fitStageLines по ширине самой
       сцены (см. --st-fs). Так ползунок размера работает одинаково
       и на широком, и на узком экране, и никакой отдельной поправки
       «на узкое окно» больше не нужно. */
    stage.style.setProperty('--st-font', (FONTS[s.font] || FONTS.system).css);
    stage.style.setProperty('--st-weight', s.weight);
    stage.style.setProperty('--st-inactive', s.inactive);
    stage.style.setProperty('--st-active', s.active);
    stage.style.setProperty('--st-effect', s.accent);
    stage.style.setProperty('--st-outline-c', s.outlineColor);
    stage.style.setProperty('--st-outline', `${s.outline}px`);
    stage.style.setProperty('--st-ls', `${s.letter}px`);
    // Просвет между строками ставит fitStageLines: он считается от кегля,
    // а кегль известен только после замера ширины сцены
    // Неактивные строки глушим прозрачностью и (по желанию) размытием.
    // Размер строк при этом НЕ меняется — иначе текст «прыгает».
    const dim = Math.max(0, Math.min(100, s.dim)) / 100;
    stage.style.setProperty('--st-dim', dim.toFixed(2));
    stage.style.setProperty('--st-near', Math.min(0.95, dim + 0.3).toFixed(2));
    stage.style.setProperty('--st-blur', `${s.blur}px`);
    stage.style.paddingLeft = `${s.pad}%`;
    stage.style.paddingRight = `${s.pad}%`;
    stage.style.justifyContent = s.valign;
    stage.dataset.effect = s.effect;
    stage.dataset.slots = s.swapLines ? 'off' : 'on';
    stage.dataset.anim = s.anim;
  });

  // Фон сцены плеера: либо картинка/градиент как раньше, либо сплошной цвет
  const stage = $('lyrics-stage');
  // Подложка-градиент под текстом вместо затемнения всего кадра
  stage.style.setProperty('--st-scrim', scrimCss(s));
  if (s.bgMode === 'color') {
    stage.style.backgroundColor = s.bgColor;
    stage.style.backgroundImage = 'none';
  } else {
    stage.style.backgroundColor = '';
    stage.style.backgroundImage = state.bgImage ? `url("${state.bgImage}")` : '';
  }

  renderStage();
  renderEditStage();
}

function updateStyleUI() {
  const s = state.style;
  $('st-font').value = s.font;
  $('st-size').value = s.size;
  $('st-size-val').textContent = `${s.size}%`;
  $('st-weight').value = s.weight;
  $('st-weight-val').textContent = s.weight;
  $('st-col-inactive').value = s.inactive;
  $('st-col-active').value = s.active;
  $('st-col-effect').value = s.accent;
  $('st-col-outline').value = s.outlineColor;
  $('st-outline').value = s.outline;
  $('st-outline-val').textContent = s.outline;
  $('st-col-bg').value = s.bgColor;
  $('st-letter').value = s.letter;
  $('st-letter-val').textContent = s.letter;
  $('st-line').value = s.line;
  $('st-line-val').textContent = (s.line / 10).toFixed(1).replace('.', ',');
  $('st-pad').value = s.pad;
  $('st-pad-val').textContent = `${s.pad}%`;
  $('st-swap').checked = s.swapLines;
  $('st-pos-cur').value = s.posCurrent;
  $('st-pos-cur-val').textContent = `${s.posCurrent}%`;
  $('st-pos-next').value = s.posNext;
  $('st-pos-next-val').textContent = `${s.posNext}%`;
  // Места строк нужны только когда они закреплены, а «строк видно» —
  // только когда они, наоборот, едут вверх. Лишнее убираем с глаз.
  $('row-pos-cur').classList.toggle('hidden', s.swapLines);
  $('row-pos-next').classList.toggle('hidden', s.swapLines);
  $('row-lines').classList.toggle('hidden', !s.swapLines);
  $('st-lines').value = s.lines;
  $('st-lines-val').textContent = s.lines;
  $('st-dim').value = s.dim;
  $('st-dim-val').textContent = `${s.dim}%`;
  $('st-blur').value = s.blur;
  $('st-blur-val').textContent = s.blur;
  $('st-scrim').value = s.scrim;
  $('st-scrim-val').textContent = `${s.scrim}%`;
  $('st-countdown').checked = s.countdown;
  [['st-effect', s.effect], ['st-bg-mode', s.bgMode], ['st-anim', s.anim], ['st-valign', s.valign]]
    .forEach(([id, val]) => {
      $(id).querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', b.dataset.v === val);
      });
    });
}

function setStyle(key, value) {
  state.style[key] = value;
  updateStyleUI();
  applyStyle();
  saveProject();
}

// Список шрифтов
Object.entries(FONTS).forEach(([key, f]) => {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = f.label;
  opt.style.fontFamily = f.css;
  $('st-font').appendChild(opt);
});

$('st-font').addEventListener('change', () => setStyle('font', $('st-font').value));
[['st-size', 'size'], ['st-weight', 'weight'], ['st-outline', 'outline'],
 ['st-letter', 'letter'], ['st-line', 'line'], ['st-lines', 'lines'], ['st-pad', 'pad'],
 ['st-pos-cur', 'posCurrent'], ['st-pos-next', 'posNext'],
 ['st-dim', 'dim'], ['st-blur', 'blur'], ['st-scrim', 'scrim']]
  .forEach(([id, key]) => {
    $(id).addEventListener('input', () => setStyle(key, +$(id).value));
  });
[['st-col-inactive', 'inactive'], ['st-col-active', 'active'], ['st-col-effect', 'accent'],
 ['st-col-outline', 'outlineColor'], ['st-col-bg', 'bgColor']]
  .forEach(([id, key]) => {
    $(id).addEventListener('input', () => setStyle(key, $(id).value));
  });
[['st-effect', 'effect'], ['st-bg-mode', 'bgMode'], ['st-anim', 'anim'], ['st-valign', 'valign']]
  .forEach(([id, key]) => {
    $(id).addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (btn) setStyle(key, btn.dataset.v);
    });
  });
$('st-swap').addEventListener('change', () => setStyle('swapLines', $('st-swap').checked));
$('st-countdown').addEventListener('change', () => setStyle('countdown', $('st-countdown').checked));

$('st-reset').addEventListener('click', () => {
  state.style = defaultStyle();
  updateStyleUI();
  applyStyle();
  saveProject();
});

/* --- Закладки левой колонки ---
   Настроек два десятка, и списком они не читаются: пока доберёшься
   до нужной, сцена уезжает за край экрана. Поэтому они разложены
   по закладкам, а колонка всегда одной высоты. */
function showSideGroup(имя) {
  $('side-tabs').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.g === имя);
  });
  document.querySelectorAll('.side-group').forEach((g) => {
    g.classList.toggle('active', g.dataset.g === имя);
  });
}

$('side-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-g]');
  if (btn) showSideGroup(btn.dataset.g);
});

/* --- Предпросмотр во весь экран ---
   Свой режим, а не системный полноэкранный: он одинаково работает
   и на сайте, и в приложении, и из него видно плеер — можно слушать
   и править, не выходя обратно. */
function stageFullOn() {
  return document.body.classList.contains('stage-full');
}

function setStageFull(on) {
  document.body.classList.toggle('stage-full', !!on);
  const btn = $('btn-stage-full');
  btn.textContent = on ? '⤡' : '⤢';
  btn.title = on ? 'Свернуть предпросмотр (Esc)' : 'Развернуть предпросмотр (F)';
  btn.setAttribute('aria-label', btn.title);
  // Сцена стала другого размера: кегль и точки отсчёта считаем заново
  fitStageLines($('lyrics-stage'));
  placeCountdown($('lyrics-stage'));
}

$('btn-stage-full').addEventListener('click', () => setStageFull(!stageFullOn()));

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const el = document.activeElement;
  const вПоле = el && (el.tagName === 'INPUT' || el.tagName === 'SELECT'
    || el.tagName === 'TEXTAREA' || el.isContentEditable);
  if (e.key === 'Escape' && stageFullOn()) {
    e.preventDefault();
    setStageFull(false);
    return;
  }
  if (e.code === 'KeyF' && !вПоле && $('step-4').classList.contains('active')) {
    e.preventDefault();
    setStageFull(!stageFullOn());
  }
});

/* --- Эквалайзер --- */
const EQ_BANDS = ['low', 'mid', 'high'];

function updateEqUI() {
  EQ_BANDS.forEach((band) => {
    const v = state.eq[band];
    $(`eq-${band}`).value = v;
    $(`eq-${band}-val`).textContent = `${v > 0 ? '+' : ''}${v} дБ`;
  });
}

EQ_BANDS.forEach((band) => {
  $(`eq-${band}`).addEventListener('input', () => {
    state.eq[band] = +$(`eq-${band}`).value;
    updateEqUI();
    if (audio.eqChain) audio.eqChain.apply();
    saveProject();
  });
});

$('eq-reset').addEventListener('click', () => {
  state.eq = { low: 0, mid: 0, high: 0 };
  updateEqUI();
  if (audio.eqChain) audio.eqChain.apply();
  saveProject();
});

$('btn-back-3').addEventListener('click', () => goToStep(3));

/* ---------- Проверка звука ----------
   Меряет реальный сигнал на выходе и в самих буферах: это отличает
   «браузер глушит сайт» от «минусовка пустая» и от «звук идёт,
   но не слышно» (заглушённая вкладка, громкость, наушники). */
function bufferLevel(buffer, fromSec = 0, seconds = 1) {
  if (!buffer) return null;
  const rate = buffer.sampleRate;
  const start = Math.min(Math.floor(fromSec * rate), Math.max(0, buffer.length - 1));
  const end = Math.min(start + Math.floor(seconds * rate), buffer.length);
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = start; i < end; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

$('btn-sound-check').addEventListener('click', async () => {
  if (!state.originalBuffer) { alert('Сначала загрузи песню.'); return; }
  const btn = $('btn-sound-check');
  const label = btn.textContent;
  btn.textContent = 'Слушаем…';
  btn.disabled = true;

  const wasPlaying = audio.playing;
  const at = Math.min(audio.position() || 0, Math.max(0, audio.duration - 2));
  audio.pause();

  const ctx = audio.ensureCtx();
  audio.play(at);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  audio.eqChain.output.connect(analyser);

  // Копим пик выходного сигнала примерно за секунду.
  // Именно таймер, а не requestAnimationFrame: rAF замирает,
  // если вкладка неактивна, и проверка никогда бы не закончилась.
  let outPeak = 0;
  const buf = new Float32Array(analyser.fftSize);
  await new Promise((resolve) => {
    const deadline = Date.now() + 1000;
    const id = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      for (const v of buf) { const a = Math.abs(v); if (a > outPeak) outPeak = a; }
      // По часам, а не по числу тиков: в фоновой вкладке таймеры
      // замедляются до секунды, и проверка не должна растягиваться
      if (Date.now() >= deadline) { clearInterval(id); resolve(); }
    }, 50);
  });

  audio.pause();
  if (!wasPlaying) audio.offset = at;
  updatePlayerUI();
  btn.textContent = label;
  btn.disabled = false;

  const songPeak = bufferLevel(state.originalBuffer, at);
  const instPeak = bufferLevel(state.instrumentalBuffer, at);
  const hasInst = !!state.instrumentalBuffer;
  const instShort = hasInst && state.instrumentalBuffer.duration < audio.duration - 0.5;
  const src = hasInst
    ? (state.customInst ? `своя минусовка (${state.instName})` : 'встроенное приглушение вокала')
    : 'минусовки нет, играет оригинал';

  const lines = [
    `Позиция: ${fmtTime(at)} из ${fmtTime(audio.duration)}`,
    `Источник: ${src}`,
    `Громкость вокала: ${Math.round(state.vocalMix * 100)}%`,
    '',
    `Сигнал в песне: ${songPeak == null ? '—' : songPeak.toFixed(3)}`,
    `Сигнал в минусовке: ${instPeak == null ? '—' : instPeak.toFixed(3)}`,
    `Сигнал на выходе: ${outPeak.toFixed(3)}`,
    `Состояние аудио: ${ctx.state}, частота ${Math.round(ctx.sampleRate)} Гц`,
    '',
  ];

  if (hasInst && instPeak !== null && instPeak < 0.001) {
    lines.push('❗ В минусовке на этом месте тишина. Возможно, файл не тот ' +
      '(например, дорожка с одним вокалом) или он короче песни. ' +
      'Попробуй убрать свою минусовку или подвинуть позицию.');
  } else if (instShort) {
    lines.push('❗ Минусовка короче песни — ближе к концу будет тишина.');
  } else if (outPeak < 0.001) {
    lines.push('❗ Данные звука есть, но на выходе тишина — звук глушит браузер.\n' +
      'В Brave: значок льва → отключи Shields для сайта.\n' +
      'В Safari: правый клик по вкладке → «Включить звук», и Настройки → ' +
      'Веб-сайты → Автовоспроизведение → «Разрешить все».');
  } else {
    lines.push('✅ Звук идёт нормально. Если не слышно — проверь громкость системы, ' +
      'выбранное устройство вывода и не заглушена ли вкладка.');
  }
  alert(lines.join('\n'));
});

/* ---------- Экспорт LRC ---------- */
$('btn-export-lrc').addEventListener('click', () => {
  const lines = syncedLines();
  if (!lines.length) { alert('Сначала синхронизируй текст.'); return; }
  const name = (state.fileName || 'song').replace(/\.[^.]+$/, '');
  const lrc = [
    `[ti:${name}]`,
    '[by:Karaoke Punch]',
    ...lines.map((l) => `[${fmtLrcTime(l.time)}]${l.text}`),
  ].join('\n');
  download(new Blob([lrc], { type: 'text/plain;charset=utf-8' }), `${name}.lrc`);
});

/* Расширенный LRC («enhanced LRC»): после метки строки идут метки слов
   в угловых скобках. Обычные плееры угловые скобки игнорируют и всё
   равно читают текст, а понимающие — подсвечивают по словам.
   Слова берём те же, что показывает сцена: ручные метки, если они есть,
   иначе автоматическое деление по длине слов. */
$('btn-export-lrc-words').addEventListener('click', () => {
  const lines = syncedLines();
  if (!lines.length) { alert('Сначала синхронизируй текст.'); return; }
  const name = (state.fileName || 'song').replace(/\.[^.]+$/, '');
  const body = lines.map((l, i) => {
    const span = lineSpan(lines, i);
    const words = lineWords(l, span);
    const inner = words
      .map((w) => `<${fmtLrcTime(w.start)}>${w.text}`)
      .join('')
      .replace(/\s+$/, '');
    // Метка конца строки — чтобы плеер знал, когда гасить подсветку
    return `[${fmtLrcTime(span.start)}]${inner}<${fmtLrcTime(span.end)}>`;
  });
  const lrc = [
    `[ti:${name}]`,
    '[by:Karaoke Punch]',
    ...body,
  ].join('\n');
  download(new Blob([lrc], { type: 'text/plain;charset=utf-8' }), `${name} (по словам).lrc`);
});

/* ---------- Экспорт WAV (минусовка) ---------- */
function bufferToWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const rate = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const dataSize = frames * numCh * bytesPerSample;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * numCh * bytesPerSample, true);
  view.setUint16(32, numCh * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/* Минусовка на выгрузку — с оригиналом на размеченных отрезках.

   Считаем офлайн тем же расписанием, что играет в колонки: если в файле
   окажется не то, что человек слышал в караоке, — это провал. Цепь тут
   короче плеерной (без эквалайзера и лимитера): выгружается дорожка
   аккомпанемента, а не готовая смесь, и такой она была всегда. */
async function собратьМинусовку() {
  const inst = state.instrumentalBuffer;
  if (!inst) return null;
  const spans = отрезкиОригинала();
  if (!spans.length) return inst;

  const orig = state.originalBuffer;
  const SR = inst.sampleRate;
  const каналов = Math.max(inst.numberOfChannels, orig.numberOfChannels);
  const ctx = new OfflineAudioContext(каналов, Math.max(inst.length, orig.length), SR);
  const vGain = ctx.createGain();
  const iGain = ctx.createGain();
  vGain.connect(ctx.destination);
  iGain.connect(ctx.destination);
  const o = ctx.createBufferSource(); o.buffer = orig; o.connect(vGain);
  const i = ctx.createBufferSource(); i.buffer = inst; i.connect(iGain);
  // Ползунок вокала в этот файл не входит: снаружи отрезков — чистая
  // минусовка, внутри — оригинал целиком
  расписатьОтрезки(ctx, vGain, iGain, усиленияМикса(0, true, false), spans, 0);
  o.start(); i.start();
  return ctx.startRendering();
}

$('btn-export-wav').addEventListener('click', async () => {
  if (!state.instrumentalBuffer) {
    alert('Для моно-файла минусовку сделать нельзя.');
    return;
  }
  const name = (state.fileName || 'song').replace(/\.[^.]+$/, '');
  const buf = await собратьМинусовку();
  download(bufferToWav(buf), `${name} (минус).wav`);
});

/* ============================================================
   Шаг 3 — редактор: сетка строк + предпросмотр + дорожка

   Три поверхности, у каждой своя работа:
     • сетка строк — навигация и правка текста. Никаких кнопок
       подстройки в самой строке: они дублируют дорожку и клавиши;
     • панель выбранной строки — одна на весь редактор: начало, конец,
       слова, удаление, вокал и «простучать заново»;
     • дорожка — весь тайминг.
   Плюс предпросмотр караоке, один в один со сценой.
   ============================================================ */
const editor = {
  pxPerSec: 40,
  scrollT: 0,
  peaks: null,   // огибающая волны для отрисовки дорожки
  drag: null,    // что тащим прямо сейчас, см. timelineHit
  stageKey: '',

  sel: -1,       // выбранная строка (номер в state.lines), -1 — ничего
  origSel: -1,   // выбранный отрезок оригинала (номер в state.origSpans)
  loop: false,   // играть выбранную строку по кругу
  snap: true,     // магнит: притягивать границы к осмысленным точкам
  безМагнита: false, // зажат Alt — магнит отключён на время
  snapped: null,  // { t, вид } — куда притянулось, для направляющей
  hearVocal: true, // в редакторе по умолчанию звучит оригинал с вокалом

  // Отмена и повтор: снимки времён, см. pushHistory
  history: [],
  future: [],
  histLines: 0,  // при скольких строках снят стек (изменилось — стек не годен)

  spans: null,   // разложенные по времени строки, см. editorSpans
  spansKey: '',
};

/* ============================================================
   Размах строк для дорожки

   Настоящие границы строки считает lineSpan — тот же код, по которому
   живёт сцена. Считать его на каждый кадр дорожки нельзя: внутри есть
   медиана длин строк, а это сортировка на каждую строку. Поэтому
   результат кэшируется, а ключом служит слепок времён: изменилось
   хоть одно — раскладка пересчитается сама.
   ============================================================ */
function spansKey(lines) {
  let k = `${lines.length}|${voiceReady() ? 1 : 0}|${(audio.duration || 0).toFixed(2)}`;
  for (const l of lines) {
    k += `;${l.time.toFixed(3)}`;
    if (l.ручнойКонец && l.end != null) k += `>${l.end.toFixed(3)}`;
    if (l.words && l.words.length) {
      const last = l.words[l.words.length - 1];
      k += `w${l.words.length}:${(last.end != null ? last.end : last.time).toFixed(3)}`;
    }
  }
  return k;
}

function editorSpans() {
  const lines = syncedLines();
  const key = spansKey(lines);
  if (editor.spansKey === key && editor.spans) return editor.spans;
  editor.spans = lines.map((line, i) => {
    const sp = lineSpan(lines, i);
    return {
      line,
      row: state.lines.indexOf(line),   // номер в общем списке строк
      start: sp.start,
      core: sp.core,
      end: sp.end,
    };
  });
  editor.spansKey = key;
  return editor.spans;
}

// Раскладка одной строки по её номеру в state.lines (или null)
function spanOfRow(row) {
  return editorSpans().find((s) => s.row === row) || null;
}

/* ============================================================
   Отмена и повтор

   Храним снимки только времён: начала, концы, ручные концы, метки слов
   и признак «время на глазок». Текст строк в снимок не входит — его
   правят прямо в поле, и там работает обычная отмена браузера; мешать
   ей своей было бы хуже, чем не иметь её вовсе.

   pushHistory вызывается ПЕРЕД изменением: в стеке лежит то, что было.
   ============================================================ */
const HISTORY_MAX = 80;

function snapshotTimings() {
  const snap = state.lines.map((l) => ({
    /* Текст в снимке лежит, но при обычной отмене не применяется —
       он нужен только чтобы вернуть удалённую строку целиком.
       См. applySnapshot: пока число строк не изменилось, текст не трогаем. */
    text: l.text,
    time: l.time,
    end: l.end != null ? l.end : null,
    hand: !!l.ручнойКонец,
    guess: !!l.сомнительная,
    words: l.words ? l.words.map((w) => ({ text: w.text, time: w.time, end: w.end })) : null,
  }));
  /* Отрезки оригинала едут в снимке отдельным свойством, а не лишним
     элементом списка: снимок повсюду перебирается как список строк,
     и чужой элемент внутри пришлось бы обходить в каждом месте. */
  snap.отрезки = отрезкиОригинала().map((s) => ({ ...s }));
  return snap;
}

function snapshotEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const ao = a.отрезки || [];
  const bo = b.отрезки || [];
  if (ao.length !== bo.length) return false;
  for (let i = 0; i < ao.length; i++) {
    if (ao[i].start !== bo[i].start || ao[i].end !== bo[i].end) return false;
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.time !== y.time || x.end !== y.end || x.hand !== y.hand || x.guess !== y.guess) return false;
    const xw = x.words;
    const yw = y.words;
    if (!!xw !== !!yw) return false;
    if (xw && yw) {
      if (xw.length !== yw.length) return false;
      for (let k = 0; k < xw.length; k++) {
        if (xw[k].time !== yw[k].time || xw[k].end !== yw[k].end) return false;
      }
    }
  }
  return true;
}

function pushHistory() {
  const snap = snapshotTimings();
  const last = editor.history[editor.history.length - 1];
  if (snapshotEqual(last, snap)) return;   // ничего не поменялось — не мусорим
  editor.history.push(snap);
  if (editor.history.length > HISTORY_MAX) editor.history.shift();
  editor.future.length = 0;
  editor.histLines = state.lines.length;
  updateHistoryButtons();
}

/* Снимок положили, а изменить ничего не изменили (взялись и отпустили,
   сдвиг упёрся в соседнюю строку) — убираем его из стека, чтобы отмена
   не срабатывала «вхолостую» */
function dropEmptyHistory() {
  const last = editor.history[editor.history.length - 1];
  if (last && snapshotEqual(last, snapshotTimings())) {
    editor.history.pop();
    updateHistoryButtons();
    return true;
  }
  return false;
}

function clearHistory() {
  editor.history.length = 0;
  editor.future.length = 0;
  editor.histLines = state.lines.length;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const undo = $('tl-undo');
  const redo = $('tl-redo');
  if (undo) undo.disabled = !editor.history.length;
  if (redo) redo.disabled = !editor.future.length;
}

/* Разложить снимок обратно по строкам и обновить всё, что от них зависит */
function applySnapshot(snap) {
  /* Текст в снимке отличается от нынешнего — значит отменяют правку
     самого текста (строку добавили, убрали или переставили). Тогда
     список восстанавливается целиком, вместе с текстом: иначе времена
     легли бы на чужие строки. Раньше сверялось только число строк,
     и отмена перестановки возвращала времена не тем строкам. */
  const тотЖеТекст = snap.length === state.lines.length
    && snap.every((s, i) => s.text === state.lines[i].text);
  if (!тотЖеТекст) {
    state.lines = snap.map((s) => {
      const l = {
        text: s.text,
        time: s.time,
        end: s.end,
        ручнойКонец: s.hand,
        сомнительная: s.guess,
      };
      if (s.words) l.words = s.words.map((w) => ({ ...w }));
      return l;
    });
    editor.histLines = state.lines.length;
    $('lyrics-input').value = state.lines.map((l) => l.text).join('\n');
    if (editor.sel >= state.lines.length) editor.sel = state.lines.length - 1;
  } else {
    // Обычная отмена: текст правят прямо в поле, там своя отмена браузера
    snap.forEach((s, i) => {
      const l = state.lines[i];
      if (!l) return;
      l.time = s.time;
      l.end = s.end;
      l.ручнойКонец = s.hand;
      l.сомнительная = s.guess;
      if (s.words) l.words = s.words.map((w) => ({ ...w }));
      else delete l.words;
    });
  }
  state.origSpans = нормОтрезки(snap.отрезки || [], audio.duration);
  if (editor.origSel >= state.origSpans.length) editor.origSel = -1;
  editor.spansKey = '';
  refreshTimes();
  renderEditList();
  updateWordExportBtn();
  editor.stageKey = '';
  renderEditStage();
  audio.applyMix();   // отменили правку отрезка — звук меняется сразу
  saveProject();
  drawTimeline();
}

function undoEdit() {
  if (!editor.history.length) return;
  editor.future.push(snapshotTimings());
  applySnapshot(editor.history.pop());
  updateHistoryButtons();
}

function redoEdit() {
  if (!editor.future.length) return;
  editor.history.push(snapshotTimings());
  applySnapshot(editor.future.pop());
  updateHistoryButtons();
}

function computePeaks() {
  const buf = state.originalBuffer;
  const d = buf.getChannelData(0);
  const bucket = 2048;
  const n = Math.ceil(d.length / bucket);
  const mins = new Float32Array(n);
  const maxs = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    let mn = 1, mx = -1;
    const end = Math.min(d.length, (b + 1) * bucket);
    for (let i = b * bucket; i < end; i++) {
      const v = d[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    mins[b] = mn;
    maxs[b] = mx;
  }
  editor.peaks = { mins, maxs, bucketDur: bucket / buf.sampleRate };
}

function openEditor() {
  if (!state.originalBuffer) return;
  if (!editor.peaks) computePeaks();
  // Разметку пересобрали заново — прежние снимки уже не о тех строках
  if (editor.histLines !== state.lines.length) clearHistory();
  editor.spansKey = '';
  if (editor.sel >= state.lines.length || (editor.sel >= 0 && state.lines[editor.sel].time == null)) {
    editor.sel = -1;
  }
  if (editor.sel < 0) {
    const first = state.lines.findIndex((l) => l.time != null);
    editor.sel = first;
  }
  renderEditList();
  renderEditStage();
  updateWordExportBtn();
  updateHistoryButtons();
  updateSelInfo();
  /* Переключатель вокала имеет смысл, только если есть чем заменить
     оригинал: у моно-файла минусовки нет, и звучит он всегда как есть */
  const вокалЕсть = !!state.instrumentalBuffer;
  const пер = $('sel-vocal');
  пер.checked = editor.hearVocal;
  пер.disabled = !вокалЕсть;
  пер.parentElement.title = вокалЕсть
    ? 'В редакторе по умолчанию звучит оригинал: размечать на слух без голоса невозможно'
    : 'Файл моно — минусовки нет, оригинал звучит всегда';
  $('tl-voice-note').textContent = voiceReady()
    ? '— видно, где на самом деле поют'
    : '— появится, когда уберёшь вокал нейросетью';
  resizeTimeline();
  $('edit-total').textContent = fmtTime(audio.duration);
  drawTimeline();

  /* На сайте простукивание — единственный способ разметки: нейросетей
     там нет. Поэтому, когда времён нет вовсе, редактор открывается сразу
     в режиме простукивания и прятать его за кнопкой не приходится.
     В приложении после подгонки времена уже есть — открывается обычный вид. */
  if (!tap.active && state.lines.length && state.lines.every((l) => l.time == null)) {
    startTapMode(0);
  }
}

/* --- Сетка строк ---

   В строке только то, что помогает её найти и прочитать: номер, начало,
   конец, длительность, текст и тихие пометки (≈ — время на глазок,
   ♪ — слова размечены руками). Кнопок подстройки в строке нет: их было
   по восемь на строку, и они дублировали дорожку, клавиши и панель
   выбранной строки. Из-за них список было не прочитать. */
function renderEditList() {
  const ul = $('edit-list');
  const synced = syncedLines();
  ul.innerHTML = '';
  state.lines.forEach((line, i) => {
    const li = document.createElement('li');
    li.className = 'edit-row';
    if (i === editor.sel) li.classList.add('selected-row');
    li.dataset.row = i;

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);

    const j = synced.indexOf(line);

    const ts = document.createElement('span');
    ts.className = 'ts' + (line.time == null ? ' empty' : '');
    ts.dataset.tsI = i;
    ts.textContent = line.time == null ? '–:––' : fmtTime(line.time);

    const end = document.createElement('span');
    end.className = 'ts end-ts' + (line.ручнойКонец ? '' : ' empty');
    end.dataset.endTsI = i;
    end.textContent = line.time == null ? '–:––' : `до ${fmtTime(lineEnd(synced, j))}`;

    // Длительность: по ней сразу видно строку, которой не хватило места
    const dur = document.createElement('span');
    dur.className = 'ts dur-ts';
    dur.dataset.durI = i;
    dur.textContent = line.time == null
      ? '' : `${(lineEnd(synced, j) - lineStart(synced, j)).toFixed(1)} с`;

    /* Тихая пометка: время этой строки нейросеть подобрала на глазок.
       На дорожке такой блок тоже нарисован иначе. */
    let guess = null;
    if (line.сомнительная) {
      guess = document.createElement('span');
      guess.className = 'guess-mark';
      guess.textContent = '≈';
      guess.title = 'Время подобрано приблизительно — послушай и поправь';
    }

    const text = document.createElement('div');
    text.className = 'edit-text';
    text.contentEditable = 'true';
    text.spellcheck = false;
    text.textContent = line.text;
    text.dataset.textI = i;

    // Строка размечена по словам — тоже тихой пометкой, а не кнопкой
    let mark = null;
    if (hasWords(line)) {
      mark = document.createElement('span');
      mark.className = 'word-mark';
      mark.textContent = '♪';
      mark.title = 'Слова этой строки размечены вручную';
    }

    li.append(num, ts, end, dur);
    if (guess) li.appendChild(guess);
    li.appendChild(text);
    if (mark) li.appendChild(mark);
    ul.appendChild(li);
  });
}

/* Любой клик по строке делает её выбранной: с ней работают клавиши,
   кольцо, полоса слов на дорожке и панель выбранной строки */
$('edit-list').addEventListener('click', (e) => {
  const row = e.target.closest('.edit-row');
  if (row && +row.dataset.row !== editor.sel) {
    selectLine(+row.dataset.row, { scrollTimeline: true });
  }
});

/* Двойной клик по строке перематывает песню на её начало.
   По самому тексту — не перематывает: там двойной клик выделяет слово,
   и отнимать это у правки текста нельзя. */
$('edit-list').addEventListener('dblclick', (e) => {
  if (e.target.closest('.edit-text')) return;
  const row = e.target.closest('.edit-row');
  if (!row) return;
  const i = +row.dataset.row;
  const line = state.lines[i];
  if (!line || line.time == null) return;
  if (editor.sel !== i) selectLine(i, {});
  const sp = spanOfRow(i);
  const t = sp ? sp.start : line.time;
  if (audio.playing) audio.play(t);
  else audio.offset = t;
  showTime(sp);
  editor.stageKey = '';
  renderEditStage();
  updatePlayerUI();
  drawTimeline();
});

/* Прокрутка сетки за воспроизведением: текущая строка сама всплывает
   в середину списка. Двигаем только сам список, не страницу: иначе
   при каждой смене строки уезжал бы весь редактор. */
function scrollEditListTo(row) {
  const list = $('edit-list');
  const el = list.querySelector(`.edit-row[data-row="${row}"]`);
  if (!el) return;
  const listBox = list.getBoundingClientRect();
  const elBox = el.getBoundingClientRect();
  const delta = (elBox.top + elBox.height / 2) - (listBox.top + listBox.height / 2);
  if (Math.abs(delta) < 2) return;
  list.scrollTop = Math.max(0, list.scrollTop + delta);
}

/* ============================================================
   Панель выбранной строки

   Одна на весь редактор — вместо кнопок, стоявших в каждой строке.
   ============================================================ */
function selPanelNudge(what, delta) {
  if (editor.sel < 0) return;
  pushHistory();
  if (what === 'start') nudgeLine(editor.sel, delta);
  else nudgeLineEnd(editor.sel, delta);
  dropEmptyHistory();
  renderEditList();
  editor.stageKey = '';
  renderEditStage();
  drawTimeline();
}

/* ---------- Начало и конец строки: поля со значениями ----------

   Правка идёт тем же путём, что перетаскивание границы на дорожке:
   считаем, на сколько человек сдвинул число, и передаём этот сдвиг
   в selPanelNudge. Значит, и ограничения те же самые — не раньше
   предыдущей строки, не позже следующей, конец не раньше начала,
   всё в пределах песни (см. setLineTime и setLineEnd). И в отмену
   правка попадает наравне с перетаскиванием: снимок кладёт
   selPanelNudge, а пустой снимок сам же и убирает.

   Значение зажимается молча, а поле после правки перезаполняется
   тем, что получилось: человек сразу видит, куда его число улеглось,
   и не гадает, применилось оно или нет. */
function читатьСекунды(текст) {
  // Запятая наравне с точкой: на русской раскладке её набирают чаще
  const t = String(текст).trim().replace(',', '.');
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function применитьПолеСтроки(какой) {
  const поле = $(какой === 'start' ? 'sel-start' : 'sel-end');
  if (!поле) return;
  const sp = spanOfRow(editor.sel);
  if (!sp) { updateSelInfo(); return; }
  const v = читатьСекунды(поле.value);
  // Не число или отрицательное время — поле краснеет, набранное
  // остаётся на месте, разметка не трогается
  if (v == null || v < 0) { поле.classList.add('bad'); return; }
  поле.classList.remove('bad');
  const было = какой === 'start' ? sp.start : sp.end;
  delete поле.dataset.набирают;   // набор закончен, поле снова можно обновлять
  if (Math.abs(v - было) >= 0.005) selPanelNudge(какой, v - было);
  updateSelInfo();
  /* Поле перезаполняем и когда оно в фокусе (updateSelInfo такие
     обходит): иначе после Enter в нём осталось бы набранное число,
     а следом пришедшее событие change приняло бы его за новую правку
     и сдвинуло строку второй раз. */
  const стало = spanOfRow(editor.sel);
  if (стало) поле.value = (какой === 'start' ? стало.start : стало.end).toFixed(2);
}

['sel-start', 'sel-end'].forEach((id) => {
  const поле = $(id);
  const какой = id === 'sel-start' ? 'start' : 'end';
  // Пока в поле набирают, панель его не перезаписывает
  поле.addEventListener('input', () => { поле.dataset.набирают = '1'; });
  // change срабатывает и на Enter, и при уходе из поля
  поле.addEventListener('change', () => применитьПолеСтроки(какой));
  поле.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); применитьПолеСтроки(какой); }
    // Escape — забыть набранное и вернуть то, что было
    else if (e.key === 'Escape') {
      e.preventDefault();
      delete поле.dataset.набирают;
      поле.classList.remove('bad');
      поле.blur();
      updateSelInfo();
    }
  });
  // Ушли из поля, ничего не применив (Escape уже вернул) — показать
  // настоящее значение, а не оборванный набор
  поле.addEventListener('blur', () => {
    delete поле.dataset.набирают;
    поле.classList.remove('bad');
    updateSelInfo();
  });
});

$('btn-sel-play').addEventListener('click', () => {
  if (editor.sel >= 0) playLine(editor.sel);
});
$('btn-sel-words').addEventListener('click', () => {
  if (editor.sel >= 0) startWordTap(editor.sel);
});
$('btn-sel-words-reset').addEventListener('click', () => {
  if (editor.sel >= 0) resetWords(editor.sel);
});
$('btn-sel-del').addEventListener('click', () => deleteLine(editor.sel));
$('btn-sel-tap').addEventListener('click', () => {
  startTapMode(editor.sel >= 0 ? editor.sel : 0);
});

$('sel-vocal').addEventListener('change', () => {
  editor.hearVocal = $('sel-vocal').checked;
  audio.restoreVocal();
});

/* Убрать строку из караоке. Отменяется общей отменой: снимок держит
   и текст, поэтому удалённая строка возвращается целиком. */
function deleteLine(row) {
  const line = state.lines[row];
  if (!line) return;
  if (state.lines.length <= 1) {
    alert('Это последняя строка — удалять нечего. Текст правится на шаге «Текст».');
    return;
  }
  if (!confirm(`Убрать строку «${line.text}» из караоке?\n\nОтменяется через ${МОД}+Z.`)) return;
  pushHistory();
  state.lines.splice(row, 1);
  editor.histLines = state.lines.length;
  $('lyrics-input').value = state.lines.map((l) => l.text).join('\n');
  editor.spansKey = '';
  editor.sel = Math.min(row, state.lines.length - 1);
  renderEditList();
  refreshTimes();
  updateWordExportBtn();
  editor.stageKey = '';
  renderEditStage();
  saveProject();
  drawTimeline();
}

/* Сдвиг всей разметки разом — раньше жил на шаге «Синхронизация» */
$('shift-all').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-shift]');
  if (!btn) return;
  pushHistory();
  shiftAllLines(+btn.dataset.shift);
  dropEmptyHistory();
  renderEditList();
  editor.stageKey = '';
  renderEditStage();
  drawTimeline();
});

/* ============================================================
   Разметка слов внутри строки

   Автоматическое деление времени строки между словами по их длине
   работает сносно, но настоящая подсветка получается только с ручными
   метками: играет отрывок строки, пользователь жмёт пробел на каждом
   слове. Метки ложатся в line.words и попадают и на сцену, и в видео,
   и в расширенный LRC.
   ============================================================ */
const wordTap = {
  active: false,
  line: -1,      // номер строки в state.lines
  index: 0,      // какое слово ждём
  marks: [],     // отмеченные моменты, по одному на слово
  chunks: [],
  start: 0,
  end: 0,
};
const WORD_TAP_LEAD = 1.2; // сколько секунд играем до начала строки

function hasWords(line) {
  return !!(line && line.words && line.words.length);
}

function anyWords() {
  return state.lines.some(hasWords);
}

function updateWordExportBtn() {
  $('btn-export-lrc-words').classList.toggle('hidden', !anyWords());
}

function startWordTap(i) {
  const line = state.lines[i];
  if (!line || line.time == null) {
    alert('Сначала простучи начало этой строки: кнопка «✎ простучать заново» в панели выбранной строки.');
    return;
  }
  const chunks = splitWords(line.text);
  if (!chunks.length) return;
  if (wordTap.active) finishWordTap(false);

  const synced = syncedLines();
  wordTap.active = true;
  wordTap.line = i;
  wordTap.index = 0;
  wordTap.marks = [];
  wordTap.chunks = chunks;
  wordTap.start = line.time;
  wordTap.end = lineEnd(synced, synced.indexOf(line));

  // playSegment сам включает вокал — без него не понять, куда попадать
  audio.playSegment(Math.max(0, line.time - WORD_TAP_LEAD),
    Math.min(audio.duration, wordTap.end + 0.4));

  $('word-tap').classList.remove('hidden');
  renderWordTap();
}

function renderWordTap() {
  const box = $('word-tap-line');
  box.innerHTML = '';
  wordTap.chunks.forEach((chunk, k) => {
    const span = document.createElement('span');
    span.className = 'wt-word';
    if (k < wordTap.marks.length) span.classList.add('done');
    else if (k === wordTap.index) span.classList.add('next');
    span.textContent = chunk.trim();
    box.appendChild(span);
  });
  $('word-tap-count').textContent =
    `${wordTap.marks.length} из ${wordTap.chunks.length}`;
}

function tapWord() {
  if (!wordTap.active || wordTap.index >= wordTap.chunks.length) return;
  // Раньше начала строки метка бессмысленна — подтягиваем к началу
  wordTap.marks.push(Math.max(wordTap.start, audio.position()));
  wordTap.index++;
  renderWordTap();
  if (wordTap.index >= wordTap.chunks.length) finishWordTap(true);
}

/* Из отмеченных моментов делаем метки слов. Если пользователь не успел
   отметить всё, остаток делим пропорционально длине слов — как делает
   автоматика, но уже от последней настоящей метки. */
function buildWords(chunks, marks, start, end) {
  const n = chunks.length;
  const exact = Math.min(marks.length, n);
  const times = [];
  for (let k = 0; k < exact; k++) {
    // Метки должны идти по возрастанию: случайный двойной тап не должен
    // создавать слово отрицательной длины
    const t = Math.max(start, marks[k]);
    times.push(k > 0 ? Math.max(t, times[k - 1] + 0.02) : t);
  }
  if (exact < n) {
    /* Последнее отмеченное слово входит в хвост вместе с неотмеченными:
       где оно кончается, мы не знаем — это сказал бы следующий тап.
       Поэтому остаток времени делим начиная с него. */
    const first = Math.max(0, exact - 1);
    const from = times.length ? times[first] : start;
    const rest = chunks.slice(first);
    const weights = rest.map((c) => Math.max(1, c.trim().length));
    const total = weights.reduce((a, b) => a + b, 0);
    const span = Math.max(0.05, end - from);
    let acc = from;
    for (let j = 0; j < rest.length; j++) {
      if (first + j >= times.length) times.push(acc);
      acc += span * (weights[j] / total);
    }
  }
  return chunks.map((text, k) => ({
    text,
    time: times[k],
    end: k + 1 < chunks.length ? times[k + 1] : Math.max(times[k] + 0.05, end),
  }));
}

function finishWordTap(save) {
  if (!wordTap.active) return;
  const line = state.lines[wordTap.line];
  wordTap.active = false;
  audio.pause();
  audio.stopAt = null;
  audio.restoreVocal();
  $('word-tap').classList.add('hidden');

  if (save && wordTap.marks.length && line) {
    pushHistory();   // разметку слов тоже можно отменить
    line.words = buildWords(wordTap.chunks, wordTap.marks, wordTap.start, wordTap.end);
    editor.spansKey = '';
    saveProject();
  }
  renderEditList();
  updateSelInfo();      // в панели зажигается «♪ слова ✓» и сброс
  editor.stageKey = '';
  renderEditStage();
  updateWordExportBtn();
  updatePlayerUI();
}

function resetWords(i) {
  const line = state.lines[i];
  if (!line) return;
  pushHistory();
  delete line.words;
  editor.spansKey = '';
  saveProject();
  renderEditList();
  updateSelInfo();
  editor.stageKey = '';
  renderEditStage();
  updateWordExportBtn();
}

/* Пока идёт вступление, отмечать нечего — показываем это приглушением */
function highlightWordTap() {
  const waiting = audio.position() < wordTap.start;
  const box = $('word-tap');
  if (box.classList.contains('waiting') !== waiting) box.classList.toggle('waiting', waiting);
}

$('btn-word-done').addEventListener('click', () => finishWordTap(true));
$('btn-word-cancel').addEventListener('click', () => finishWordTap(false));
$('word-tap-line').addEventListener('click', tapWord); // на телефоне пробела нет

/* ============================================================
   Режим простукивания

   Не отдельный шаг и не панель в придачу к редактору, а режим внутри
   него: пока он включён, сетка строк, предпросмотр и панель выбранной
   строки убраны с глаз (класс .tapping на панели шага). На экране
   остаётся ровно то, чем в этот момент пользуются: крупная текущая
   строка, следующая помельче, счётчик, время, дорожка — на ней метки
   появляются на глазах — и две кнопки.

   Правила переписывания меток. Человек не должен бояться, что потеряет
   работу, поэтому:
     • стучать можно с любого места; метки раньше него не трогаются;
     • ничего не стирается заранее: метка переписывается ровно в тот
       момент, когда по строке ударили. Строки, до которых не дошли,
       остаются как были;
     • каждый удар отменяется по отдельности — «отменить последнюю»,
       она же Backspace: строка возвращается к прежнему времени,
       а песня отматывается назад, чтобы попробовать ещё раз;
     • весь заход целиком откатывается общей отменой Cmd+Z — снимок
       всех времён кладётся в стек один раз, перед первым ударом.
   ============================================================ */
const tap = {
  active: false,
  index: 0,      // строка, которую ждём (номер в state.lines)
  from: 0,       // с какой строки начали заход
  done: [],      // по записи на удар: чем строка была до него
  pushed: false, // снимок захода лежит в стеке отмены
};
const TAP_LEAD = 1;   // сколько секунд играем до строки, с которой начали

function startTapMode(from) {
  if (!state.originalBuffer || !state.lines.length) return;
  if (wordTap.active) finishWordTap(false);
  if (editor.loop) setLoop(false);
  from = Math.max(0, Math.min(from | 0, state.lines.length - 1));

  tap.active = true;
  tap.from = from;
  tap.index = from;
  tap.done = [];
  // Один снимок на весь заход: Cmd+Z должен снимать его целиком
  pushHistory();
  tap.pushed = true;

  $('step-3').classList.add('tapping');
  $('tap-mode').classList.remove('hidden');

  const prev = from > 0 && state.lines[from - 1].time != null ? state.lines[from - 1].time : 0;
  const at = state.lines[from].time != null ? state.lines[from].time : prev;
  audio.play(Math.max(0, at - TAP_LEAD));
  audio.onEnded = () => finishTapMode();
  renderTapMode();
  resizeTimeline();
  drawTimeline();
}

function renderTapMode() {
  const total = state.lines.length;
  const done = state.lines.filter((l) => l.time != null).length;
  $('tap-count').textContent = `размечено ${done} из ${total}`;
  const cur = state.lines[tap.index];
  const next = state.lines[tap.index + 1];
  $('tap-now').textContent = cur ? cur.text : 'Все строки размечены';
  $('tap-next').textContent = next ? next.text : '';
  $('btn-tap-undo').disabled = !tap.done.length;
}

/* Удар: строка получает время, следующая становится текущей */
function tapHit() {
  if (!tap.active) return;
  const i = tap.index;
  const line = state.lines[i];
  if (!line) { finishTapMode(); return; }
  const t = audio.position();

  // Чем строка была до удара — чтобы вернуть её кнопкой «отменить последнюю»
  tap.done.push({
    row: i,
    time: line.time,
    end: line.end,
    hand: !!line.ручнойКонец,
    guess: !!line.сомнительная,
    words: line.words ? line.words.map((w) => ({ ...w })) : null,
  });

  const was = line.time;
  line.time = t;
  line.сомнительная = false;
  // Метки слов заданы абсолютным временем — двигаются вместе со строкой
  if (was != null) shiftWords(line, t - was);
  // Ручной конец переживает удар, пока он всё ещё позже начала
  if (line.ручнойКонец && line.end != null && line.end <= t + 0.05) {
    line.end = null;
    line.ручнойКонец = false;
  }

  tap.index++;
  editor.spansKey = '';
  renderTapMode();
  drawTimeline();
  if (tap.index >= state.lines.length) finishTapMode();
}

/* Отменить последний удар: строка возвращается к прежнему времени,
   а песня отматывается к тому месту, где по ней ударили */
function undoLastTap() {
  if (!tap.active || !tap.done.length) return;
  const last = tap.done.pop();
  const line = state.lines[last.row];
  const hit = line ? line.time : null;
  if (line) {
    line.time = last.time;
    line.end = last.end;
    line.ручнойКонец = last.hand;
    line.сомнительная = last.guess;
    if (last.words) line.words = last.words.map((w) => ({ ...w }));
    else delete line.words;
  }
  tap.index = last.row;
  editor.spansKey = '';
  if (hit != null) audio.play(Math.max(0, hit - TAP_LEAD));
  renderTapMode();
  drawTimeline();
}

/* Закончить заход. Метки остаются как есть, снимок остаётся в стеке —
   Cmd+Z снимет весь заход. */
function finishTapMode() {
  if (!tap.active) return;
  tap.active = false;
  audio.pause();
  audio.onEnded = null;
  $('step-3').classList.remove('tapping');
  $('tap-mode').classList.add('hidden');
  // Простучали и ничего не изменили — отменять нечего
  if (tap.pushed) { dropEmptyHistory(); tap.pushed = false; }

  if (tap.done.length) {
    editor.sel = tap.done[tap.done.length - 1].row;
    проверитьПорядокПослеЗахода();
  }
  editor.spansKey = '';
  audio.restoreVocal();
  renderEditList();
  refreshTimes();
  updateWordExportBtn();
  editor.stageKey = '';
  renderEditStage();
  saveProject();
  resizeTimeline();
  drawTimeline();
  updatePlayerUI();
}

/* Заход закончили посреди песни, а дальше лежат метки из прошлой
   разметки — и они могут оказаться РАНЬШЕ только что простуканных.
   Молча ломать караоке нельзя, но и стирать чужую работу без спроса
   тоже: спрашиваем. Стирание попадает в тот же снимок отмены. */
function проверитьПорядокПослеЗахода() {
  const last = tap.done[tap.done.length - 1];
  const t = state.lines[last.row] ? state.lines[last.row].time : null;
  if (t == null) return;
  let k = -1;
  for (let i = last.row + 1; i < state.lines.length; i++) {
    if (state.lines[i].time != null) { k = i; break; }
  }
  if (k < 0 || state.lines[k].time > t) return;
  const ok = confirm(
    `Строка ${k + 1} размечена раньше, чем та, которую ты только что простучал.\n\n` +
    `Стереть метки с ${k + 1}-й строки и дальше, чтобы простучать их заново?\n` +
    `Всё вместе с этим заходом отменяется через ${МОД}+Z.`);
  if (!ok) return;
  for (let i = k; i < state.lines.length; i++) {
    const l = state.lines[i];
    l.time = null; l.end = null; l.ручнойКонец = false; l.сомнительная = false;
    delete l.words;
  }
}

/* На телефоне пробела нет — вся большая плашка и есть кнопка удара.
   Фокус на ней не оставляем: иначе следующий пробел браузер мог бы
   засчитать и нам, и кнопке, то есть за два удара. */
$('tap-hit').addEventListener('click', () => { $('tap-hit').blur(); tapHit(); });
$('btn-tap-undo').addEventListener('click', undoLastTap);
$('btn-tap-done').addEventListener('click', () => finishTapMode());

/* Вставка в строки — только плоским текстом, без HTML из буфера */
$('edit-list').addEventListener('paste', (e) => {
  const el = e.target.closest('.edit-text');
  if (!el) return;
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData)
    .getData('text/plain').replace(/\n/g, ' ');
  document.execCommand('insertText', false, text);
});

/* Правка текста прямо в списке */
$('edit-list').addEventListener('input', (e) => {
  const el = e.target.closest('.edit-text');
  if (!el) return;
  const i = +el.dataset.textI;
  const line = state.lines[i];
  line.text = el.textContent.replace(/\n/g, ' ').trim() || line.text;
  // Метки слов держатся, пока число слов не изменилось. Иначе они
  // указывали бы не на те слова, и лучше вернуться к автоматике.
  if (hasWords(line)) {
    const chunks = splitWords(line.text);
    if (chunks.length === line.words.length) {
      line.words = line.words.map((w, k) => ({ ...w, text: chunks[k] }));
    } else {
      delete line.words;
      // Перерисовать список сразу нельзя — потеряется курсор в поле,
      // поэтому просто убираем пометку «♪» у этой строки
      const mark = el.closest('.edit-row').querySelector('.word-mark');
      if (mark) mark.remove();
      if (i === editor.sel) updateSelInfo();
      updateWordExportBtn();
    }
  }
  $('lyrics-input').value = state.lines.map((l) => l.text).join('\n');
  saveProject();
  editor.stageKey = ''; // заставляем предпросмотр перерисоваться
  editor.spansKey = ''; // и раскладку дорожки: подписи блоков поменялись
});

/* --- Мини-сцена предпросмотра --- */
function renderEditStage() {
  const el = $('edit-stage');
  const lines = syncedLines();
  if (!lines.length) { el.innerHTML = ''; return; }
  const pos = audio.position();
  const ph = stagePhase(pos);

  /* Предпросмотр рисуется ТЕМ ЖЕ кодом, что и сцена караоке: те же
     места строк, тот же значок проигрыша. Раньше он собирал свой
     список — и строки в нём подменяли друг друга, съезжая вверх,
     тогда как на сцене они стоят на закреплённых местах. Человек
     видел в редакторе не то, что получит. */
  editor.stageKey = state.style.swapLines
    ? `${ph.mode}:${ph.cur}`
    : `${ph.mode}:${ph.cur}:${ph.cur % 2}`;
  const cur = ph.cur;

  syncStageLines(el, state.style.swapLines
    ? scrollingItems(lines, ph)
    : fixedSlotItems(lines, ph));

  // Единый кегль — тот же, что на большой сцене и в видео
  fitStageLines(el);

  // Подсветка текущей строки в списке
  const globalIdx = cur >= 0 ? state.lines.indexOf(lines[cur]) : -1;
  document.querySelectorAll('#edit-list .edit-row').forEach((row) => {
    row.classList.toggle('current-row', +row.dataset.row === globalIdx);
  });

  /* Сетка идёт за воспроизведением: текущая строка сама всплывает.
     Не лезем, когда человек правит текст прямо в списке — курсор бы
     уехал из поля вместе с прокруткой. */
  if (audio.playing && globalIdx >= 0 && !tap.active) {
    const el = document.activeElement;
    if (!(el && el.isContentEditable && $('edit-list').contains(el))) {
      scrollEditListTo(globalIdx);
    }
  }
}

function updateEditStage() {
  const lines = syncedLines();
  if (!lines.length) return;
  const pos = audio.position();
  const ph = stagePhase(pos);
  // Ключ считается так же, как в renderEditStage: в режиме закреплённых
  // мест в него входит чётность строки, иначе места не поменяются местами
  const key = state.style.swapLines
    ? `${ph.mode}:${ph.cur}`
    : `${ph.mode}:${ph.cur}:${ph.cur % 2}`;
  if (key !== editor.stageKey) renderEditStage();
  const el = $('edit-stage').querySelector(
    ph.mode === 'break' ? '.break-line' : '.stage-line.current');
  if (!el) return;
  const start = ph.start;
  const end = ph.mode === 'break' ? ph.until : ph.end;
  if (ph.mode === 'break' || ph.cur < 0) {
    const p = end > start ? Math.min(1, Math.max(0, (pos - start) / (end - start))) : 1;
    const spans = el.children;
    const sung = Math.round(spans.length * p);
    for (let i = 0; i < spans.length; i++) spans[i].classList.toggle('sung', i < sung);
    return;
  }
  // Подсветка по словам — как на большой сцене
  applyWordFill(el, lines[ph.cur], ph, pos);
}

/* ============================================================
   Дорожка редактора

   Дорожка собрана из полос, сверху вниз:
     • линейка времени;
     • оригинал — отрезки, где вместо минусовки звучит сама песня
       со словами. Пусто по умолчанию: протянул мышью — появился
       отрезок, потянул за край — сдвинул границу;
     • голос — огибающая вокальной дорожки. Её считает настольная
       версия после удаления вокала нейросетью, и по ней прямо видно,
       где на самом деле поют. На сайте этой полосы нет, дорожка просто
       становится ниже;
     • волна общего микса;
     • строки — блоками от начала до конца, а не точками: видно длину;
     • слова выбранной строки.

   Всё рисуется на одном канвасе: элементов было бы под тысячу, а
   перерисовка идёт каждый кадр вместе с указателем воспроизведения.
   ============================================================ */

const LANE_RULER = 18;
const LANE_ORIG = 22;
const LANE_VOICE = 34;
const LANE_WAVE = 46;
const LANE_LINES = 38;
const LANE_WORDS = 24;
const EDGE_GRAB = 6;      // сколько пикселей у края блока считаются «за край»
const SNAP_PX = 12;       // на таком расстоянии от точки магнит притягивает границу
const MIN_SPAN = 0.08;    // короче строку и слово не делаем

/* Полосы дорожки: где какая лежит и какой высоты. Полоса голоса
   появляется, только когда огибающая есть. */
function timelineLanes() {
  /* На низком экране дорожка ужимается: редактор должен помещаться
     в окно целиком, а высота нужнее сетке строк и предпросмотру. */
  const k = window.innerHeight <= 780 ? 0.8 : 1;
  const px = (v) => Math.round(v * k);
  let y = 0;
  const L = {};
  L.ruler = { y, h: px(LANE_RULER) }; y += L.ruler.h;
  L.orig = { y, h: px(LANE_ORIG) }; y += L.orig.h;
  if (voiceReady()) { L.voice = { y, h: px(LANE_VOICE) }; y += L.voice.h; }
  L.wave = { y, h: px(LANE_WAVE) }; y += L.wave.h;
  L.lines = { y, h: px(LANE_LINES) }; y += L.lines.h;
  L.words = { y, h: px(LANE_WORDS) }; y += L.words.h;
  L.total = y;
  return L;
}

function resizeTimeline() {
  const c = $('timeline');
  const h = timelineLanes().total;
  c.style.height = `${h}px`;
  // Ширину задаёт вёрстка (width: 100%), мы только меряем: считать её
  // от родителя нельзя — там своё поле, и канвас вылезал за край
  const w = Math.max(120, Math.round(c.getBoundingClientRect().width));
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
}

function timelineDims() {
  const c = $('timeline');
  const dpr = window.devicePixelRatio || 1;
  return { W: c.width / dpr, H: c.height / dpr, dpr };
}

const tToX = (t) => (t - editor.scrollT) * editor.pxPerSec;
const xToT = (x) => editor.scrollT + x / editor.pxPerSec;

function clampScroll() {
  const { W } = timelineDims();
  const viewDur = W / editor.pxPerSec;
  editor.scrollT = Math.min(Math.max(0, editor.scrollT),
    Math.max(0, (audio.duration || 0) - viewDur));
}

/* Прямоугольник со скруглением: roundRect есть не везде, поэтому свой */
function roundRect(g, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}

/* Подпись внутри блока: обрезаем по ширине, чтобы не лезла к соседям */
function clipText(g, text, maxW) {
  if (maxW < 12) return '';
  if (g.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s.length > 1 ? s + '…' : '';
}

/* ---------- Полоса отрезков оригинала ----------
   Розовый — «здесь поёт запись, а не вы». Крестик у правого края
   убирает отрезок; пока блок узкий, крестик не рисуем и не ловим. */
const ORIG_DEL_W = 14;   // ширина крестика внутри блока

function drawOrigLane(g, lane, W) {
  const spans = отрезкиОригинала();
  g.fillStyle = 'rgba(30, 16, 22, 0.85)';
  g.fillRect(0, lane.y, W, lane.h);

  if (!spans.length) {
    g.fillStyle = 'rgba(251, 113, 133, 0.55)';
    g.font = '10px sans-serif';
    g.textAlign = 'left';
    g.fillText('оригинал: протяни мышью — на этом куске зазвучат настоящие слова',
      6, lane.y + lane.h / 2 + 3);
    return;
  }

  const y = lane.y + 3;
  const h = lane.h - 6;
  g.font = '10px sans-serif';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  spans.forEach((s, i) => {
    const x0 = tToX(s.start);
    const x1 = tToX(s.end);
    if (x1 < -40 || x0 > W + 40) return;
    const w = Math.max(2, x1 - x0);
    const sel = i === editor.origSel;
    roundRect(g, x0, y, w, h, 4);
    g.fillStyle = sel ? 'rgba(251, 113, 133, 0.42)' : 'rgba(251, 113, 133, 0.26)';
    g.fill();
    g.lineWidth = sel ? 2 : 1;
    g.strokeStyle = sel ? '#fda4af' : '#fb7185';
    g.stroke();
    // Ручки по краям — за них тянут границу
    g.fillStyle = sel ? '#fda4af' : '#fb7185';
    g.fillRect(x0, y, 2, h);
    g.fillRect(x1 - 2, y, 2, h);

    const крестик = w >= ORIG_DEL_W + 26;
    g.fillStyle = '#ffe4e6';
    const txt = clipText(g, 'оригинал', w - 8 - (крестик ? ORIG_DEL_W : 0));
    if (txt) g.fillText(txt, x0 + 4, lane.y + lane.h / 2);
    if (крестик) {
      g.textAlign = 'center';
      g.fillStyle = 'rgba(255, 228, 230, 0.85)';
      g.fillText('✕', x1 - ORIG_DEL_W / 2 - 2, lane.y + lane.h / 2);
      g.textAlign = 'left';
    }
  });
  g.textBaseline = 'alphabetic';
}

/* ---------- Полоса голоса ---------- */
function drawVoiceLane(g, lane, W) {
  const level = voice.level;
  g.fillStyle = 'rgba(10, 22, 32, 0.9)';
  g.fillRect(0, lane.y, W, lane.h);

  // Куски пения — подложкой: сразу видно, где голос вообще есть
  g.fillStyle = 'rgba(56, 189, 248, 0.16)';
  for (const r of voice.runs) {
    const x0 = tToX(r.start);
    const x1 = tToX(r.end);
    if (x1 < 0 || x0 > W) continue;
    g.fillRect(x0, lane.y, Math.max(1, x1 - x0), lane.h);
  }

  // Сама огибающая: столбик на пиксель, высота — громкость голоса
  if (level && level.length) {
    g.fillStyle = 'rgba(56, 189, 248, 0.75)';
    const base = lane.y + lane.h - 1;
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor(xToT(x) * VOICE_RATE);
      const i1 = Math.floor(xToT(x + 1) * VOICE_RATE);
      if (i1 < 0) continue;
      if (i0 >= level.length) break;
      let mx = 0;
      for (let i = Math.max(0, i0); i <= Math.min(level.length - 1, i1); i++) {
        if (level[i] > mx) mx = level[i];
      }
      const h = (mx / 255) * (lane.h - 2);
      if (h > 0.5) g.fillRect(x, base - h, 1, h);
    }
  }

  g.fillStyle = 'rgba(56, 189, 248, 0.5)';
  g.font = '9px sans-serif';
  g.textAlign = 'left';
  g.fillText('голос', 4, lane.y + 10);
}

/* ---------- Полоса волны ---------- */
function drawWaveLane(g, lane, W) {
  const { mins, maxs, bucketDur } = editor.peaks;
  g.fillStyle = 'rgba(45, 212, 191, 0.5)';
  const mid = lane.y + lane.h / 2;
  for (let x = 0; x < W; x++) {
    const t0 = xToT(x);
    if (t0 < 0) continue;
    const b0 = Math.floor(t0 / bucketDur);
    if (b0 >= maxs.length) break;
    const b1 = Math.min(maxs.length - 1, Math.floor(xToT(x + 1) / bucketDur));
    let mn = 1;
    let mx = -1;
    for (let b = b0; b <= b1; b++) {
      if (mins[b] < mn) mn = mins[b];
      if (maxs[b] > mx) mx = maxs[b];
    }
    const y0 = mid + mn * (lane.h / 2) * 0.92;
    const y1 = mid + mx * (lane.h / 2) * 0.92;
    g.fillRect(x, Math.min(y0, y1), 1, Math.max(1, Math.abs(y1 - y0)));
  }
}

/* ---------- Блоки строк ---------- */
function drawLineBlocks(g, lane, W) {
  g.font = '11px sans-serif';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  for (const sp of editorSpans()) {
    const x0 = tToX(sp.start);
    const x1 = tToX(sp.end);
    if (x1 < -40 || x0 > W + 40) continue;
    const w = Math.max(2, x1 - x0);
    const sel = sp.row === editor.sel;
    const guess = !!sp.line.сомнительная;
    const y = lane.y + 3;
    const h = lane.h - 6;

    roundRect(g, x0, y, w, h, 5);
    g.fillStyle = sel ? 'rgba(132, 204, 22, 0.34)'
      : guess ? 'rgba(245, 158, 11, 0.22)' : 'rgba(16, 185, 129, 0.24)';
    g.fill();
    g.lineWidth = sel ? 2 : 1;
    g.strokeStyle = sel ? '#a3e635' : guess ? '#f59e0b' : '#10b981';
    g.setLineDash(guess ? [4, 3] : []);
    g.stroke();
    g.setLineDash([]);

    /* Где строка спета по словам (core) и докуда её тянет голос (end) —
       разница видна тонкой чертой: справа от неё распев. */
    if (sp.core < sp.end - 0.02) {
      const xc = tToX(sp.core);
      if (xc > x0 + 2 && xc < x1 - 1) {
        g.strokeStyle = 'rgba(255, 255, 255, 0.28)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(xc, y + 2);
        g.lineTo(xc, y + h - 2);
        g.stroke();
      }
    }

    // Ручки по краям — чтобы было видно, за что тянуть
    g.fillStyle = sel ? '#a3e635' : guess ? '#f59e0b' : '#10b981';
    g.fillRect(x0, y, 2, h);
    g.fillRect(x1 - 2, y, 2, h);

    /* Строку подтянуло к настоящему вступлению голоса — покажем, где
       при этом стоит своя метка. Иначе непонятно, почему блок «не там,
       куда положили»: это и есть работа огибающей. */
    if (Math.abs(sp.start - sp.line.time) > 0.02) {
      const xr = tToX(sp.line.time);
      g.strokeStyle = 'rgba(56, 189, 248, 0.7)';
      g.lineWidth = 1;
      g.setLineDash([2, 2]);
      g.beginPath();
      g.moveTo(xr, y);
      g.lineTo(xr, y + h);
      g.stroke();
      g.setLineDash([]);
    }

    const label = (guess ? '≈ ' : '') + sp.line.text;
    g.fillStyle = sel ? '#f2f7e6' : 'rgba(226, 245, 238, 0.92)';
    const txt = clipText(g, label, w - 10);
    if (txt) g.fillText(txt, x0 + 5, lane.y + lane.h / 2);
  }
  g.textBaseline = 'alphabetic';
}

/* ---------- Слова выбранной строки ---------- */
function drawWordBlocks(g, lane, W) {
  g.fillStyle = 'rgba(255, 255, 255, 0.03)';
  g.fillRect(0, lane.y, W, lane.h);
  const sp = spanOfRow(editor.sel);
  if (!sp) {
    g.fillStyle = 'rgba(154, 154, 176, 0.6)';
    g.font = '10px sans-serif';
    g.textAlign = 'left';
    g.fillText('выбери строку — здесь появятся её слова', 6, lane.y + lane.h / 2 + 3);
    return;
  }
  const manual = hasWords(sp.line);
  const words = lineWords(sp.line, sp);
  g.font = '10px sans-serif';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  words.forEach((w, k) => {
    const x0 = tToX(w.start);
    const x1 = tToX(w.end);
    if (x1 < -20 || x0 > W + 20) return;
    const width = Math.max(2, x1 - x0);
    roundRect(g, x0, lane.y + 3, width, lane.h - 7, 3);
    g.fillStyle = manual
      ? (k % 2 ? 'rgba(132, 204, 22, 0.28)' : 'rgba(132, 204, 22, 0.2)')
      : (k % 2 ? 'rgba(148, 163, 184, 0.2)' : 'rgba(148, 163, 184, 0.13)');
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = manual ? 'rgba(163, 230, 53, 0.8)' : 'rgba(148, 163, 184, 0.5)';
    g.setLineDash(manual ? [] : [3, 3]);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = manual ? '#e8f7cf' : 'rgba(226, 232, 240, 0.75)';
    const txt = clipText(g, w.text.trim(), width - 6);
    if (txt) g.fillText(txt, x0 + 3, lane.y + lane.h / 2);
  });
  g.textBaseline = 'alphabetic';
}

function drawTimeline() {
  if (!editor.peaks) return;
  const c = $('timeline');
  const g = c.getContext('2d');
  const { W, H, dpr } = timelineDims();
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const L = timelineLanes();
  clampScroll();

  g.fillStyle = '#0e0e15';
  g.fillRect(0, 0, W, H);

  drawOrigLane(g, L.orig, W);
  if (L.voice) drawVoiceLane(g, L.voice, W);
  drawWaveLane(g, L.wave, W);

  // Кольцевое прослушивание: отрезок, который крутится, слегка подсвечен
  if (editor.loop) {
    const sp = spanOfRow(editor.sel);
    if (sp) {
      const x0 = tToX(sp.start - LOOP_LEAD);
      const x1 = tToX(sp.end + LOOP_TAIL);
      g.fillStyle = 'rgba(132, 204, 22, 0.09)';
      // L.ruler — полоса, а не число: раньше здесь стояло само L.ruler,
      // и высота выходила NaN, то есть подсветка не рисовалась вовсе
      g.fillRect(x0, L.ruler.y, Math.max(1, x1 - x0), H - L.ruler.y);
    }
  }

  drawLineBlocks(g, L.lines, W);
  drawWordBlocks(g, L.words, W);

  // Разделители полос
  g.fillStyle = 'rgba(255, 255, 255, 0.07)';
  [L.orig, L.wave, L.lines, L.words].forEach((lane) => g.fillRect(0, lane.y, W, 1));

  // Линейка времени
  const step = editor.pxPerSec >= 60 ? 1 : editor.pxPerSec >= 25 ? 2 : editor.pxPerSec >= 12 ? 5 : 10;
  const viewDur = W / editor.pxPerSec;
  g.fillStyle = '#0e0e15';
  g.fillRect(0, 0, W, L.ruler);
  g.fillStyle = '#9a9ab0';
  g.font = '10px sans-serif';
  g.textAlign = 'left';
  for (let t = Math.ceil(editor.scrollT / step) * step; t <= editor.scrollT + viewDur; t += step) {
    const x = tToX(t);
    g.fillRect(x, 0, 1, 5);
    g.fillText(fmtTime(t), x + 3, 12);
  }

  /* Направляющая магнита: там, где граница примагнитилась, встаёт
     черта цветом той полосы, к которой прилипло, — сразу видно,
     почему граница «не там, куда привели мышь» */
  if (editor.snapped) {
    const x = tToX(editor.snapped.t);
    g.fillStyle = ЦВЕТ_МАГНИТА[editor.snapped.вид] || '#38bdf8';
    g.fillRect(x - 1, L.ruler.y, 2, H - L.ruler.y);
    g.font = '10px sans-serif';
    g.textAlign = x > W - 60 ? 'right' : 'left';
    g.fillText(editor.snapped.вид, x + (x > W - 60 ? -4 : 4), L.ruler.y + 10);
    g.textAlign = 'left';
  }

  // Указатель воспроизведения
  const px = tToX(audio.position());
  if (px >= -2 && px <= W + 2) {
    g.fillStyle = '#f2f2f7';
    g.fillRect(px - 1, 0, 2, H);
    g.beginPath();
    g.moveTo(px - 5, 0);
    g.lineTo(px + 5, 0);
    g.lineTo(px, 7);
    g.closePath();
    g.fill();
  }
}

/* ============================================================
   Что под курсором

   Возвращает, за что человек взялся: за край блока строки, за её
   середину, за границу слова или ни за что (тогда клик перематывает).
   ============================================================ */
function timelineHit(x, y) {
  const L = timelineLanes();

  // Отрезки оригинала
  if (y >= L.orig.y && y < L.orig.y + L.orig.h) {
    const spans = отрезкиОригинала();
    for (let i = 0; i < spans.length; i++) {
      const x0 = tToX(spans[i].start);
      const x1 = tToX(spans[i].end);
      if (Math.abs(x - x0) <= EDGE_GRAB) return { kind: 'orig-start', i };
      if (Math.abs(x - x1) <= EDGE_GRAB) return { kind: 'orig-end', i };
      if (x > x0 && x < x1) {
        const крестик = x1 - x0 >= ORIG_DEL_W + 26;
        if (крестик && x >= x1 - ORIG_DEL_W - 4) return { kind: 'orig-del', i };
        return { kind: 'orig-move', i };
      }
    }
    return { kind: 'orig-new' };
  }

  // Слова выбранной строки
  if (y >= L.words.y && y < L.words.y + L.words.h) {
    const sp = spanOfRow(editor.sel);
    if (sp) {
      const words = lineWords(sp.line, sp);
      for (let k = 0; k < words.length; k++) {
        const x0 = tToX(words[k].start);
        const x1 = tToX(words[k].end);
        // Границу между словами тянем за левый край — кроме самого первого:
        // начало первого слова — это начало строки, у него своя ручка
        if (k > 0 && Math.abs(x - x0) <= EDGE_GRAB) return { kind: 'word-edge', row: sp.row, k };
        if (x >= x0 && x <= x1) return { kind: 'word-move', row: sp.row, k };
      }
    }
    return null;
  }

  // Блоки строк
  if (y >= L.lines.y && y < L.lines.y + L.lines.h) {
    const spans = editorSpans();
    // Сначала края — они важнее середины соседнего блока
    for (const sp of spans) {
      if (Math.abs(x - tToX(sp.start)) <= EDGE_GRAB) return { kind: 'line-start', row: sp.row };
      if (Math.abs(x - tToX(sp.end)) <= EDGE_GRAB) return { kind: 'line-end', row: sp.row };
    }
    for (const sp of spans) {
      if (x >= tToX(sp.start) && x <= tToX(sp.end)) return { kind: 'line-move', row: sp.row };
    }
  }
  return null;
}

/* ============================================================
   Магнит

   Границы при перетаскивании прилипают к осмысленным точкам — как
   в Logic Pro и Final Cut. Куда липнет:
     • к началам и концам соседних строк;
     • к указателю воспроизведения;
     • к границам отрезков оригинала;
     • к вступлениям и концам пения — если огибающая голоса есть
       (в приложении после удаления вокала нейросетью);
     • к самым краям песни.

   Порог задан в ПИКСЕЛЯХ, а не в секундах: на любом масштабе граница
   прилипает с одного и того же расстояния на экране.

   Зажатый Alt отключает магнит на время перетаскивания — так же
   в обеих названных программах. Общий выключатель — кнопка
   «🧲 магнит» и клавиша S.

   Прежняя кнопка «⇥ к голосу» была тем же самым, только про одну
   породу точек. Двух похожих переключателей быть не должно, поэтому
   она стала общим магнитом, а голос — одним из его видов точек.
   ============================================================ */

/* Чем меньше вес, тем важнее точка при равном расстоянии: попасть
   в указатель или в край соседней строки нужнее, чем в огибающую */
const ВЕС_МАГНИТА = { указатель: 0, строка: 1, оригинал: 1, голос: 2, край: 3 };
const ЦВЕТ_МАГНИТА = {
  указатель: '#f2f2f7', строка: '#a3e635', оригинал: '#fb7185',
  голос: '#38bdf8', край: '#9a9ab0',
};

/* Все точки, к которым сейчас имеет смысл липнуть.
   что.кромеСтроки — номер строки, которую тащат (сама к себе не липнет),
   что.кроме — номер отрезка оригинала, который тащат. */
function точкиМагнита(что) {
  const о = что || {};
  const точки = [];
  const добавить = (t, вид) => {
    if (Number.isFinite(t) && t >= 0) точки.push({ t, вид });
  };
  for (const sp of editorSpans()) {
    if (sp.row === о.кромеСтроки) continue;
    добавить(sp.start, 'строка');
    добавить(sp.end, 'строка');
  }
  добавить(audio.position(), 'указатель');
  отрезкиОригинала().forEach((s, i) => {
    if (i === о.кроме) return;
    добавить(s.start, 'оригинал');
    добавить(s.end, 'оригинал');
  });
  if (voiceReady()) {
    for (const r of voice.runs) { добавить(r.start, 'голос'); добавить(r.end, 'голос'); }
  }
  добавить(0, 'край');
  добавить(audio.duration, 'край');
  return точки;
}

/* Притянуть время t к ближайшей точке. Магнит выключен или зажат Alt —
   время остаётся ровно тем, куда привели мышь. */
function примагнитить(t, что) {
  editor.snapped = null;
  if (!editor.snap || editor.безМагнита) return t;
  const w = SNAP_PX / editor.pxPerSec;
  let best = null;
  let bestKey = Infinity;
  for (const p of точкиМагнита(что)) {
    const d = Math.abs(p.t - t);
    if (d > w) continue;
    /* Ключ: сначала расстояние в целых пикселях, потом вес. Так две
       точки на одном и том же пикселе разбираются не порядком перебора,
       а важностью — иначе прилипание скакало бы туда-сюда. */
    const key = Math.round(d * editor.pxPerSec) * 10 + ВЕС_МАГНИТА[p.вид];
    if (key < bestKey) { bestKey = key; best = p; }
  }
  if (!best) return t;
  editor.snapped = best;
  return best.t;
}

/* Прежнее имя притягивания. Самопроверка приложения зовёт его отсюда,
   а её код живёт в desktop/main.js, править который нельзя, — поэтому
   вход остаётся. Голос теперь лишь одна из пород точек магнита. */
function snapToVoice(t) {
  return примагнитить(t);
}

/* ---------- Выбор строки ---------- */
function selectLine(row, opts) {
  const o = opts || {};
  const line = state.lines[row];
  editor.sel = line && line.time != null ? row : -1;
  document.querySelectorAll('#edit-list .edit-row').forEach((el) => {
    el.classList.toggle('selected-row', +el.dataset.row === editor.sel);
  });
  if (o.scrollList && editor.sel >= 0) {
    const el = document.querySelector(`#edit-list .edit-row[data-row="${editor.sel}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
  if (o.scrollTimeline) showTime(spanOfRow(editor.sel));
  updateSelInfo();
  drawTimeline();
}

/* Подвинуть окно дорожки так, чтобы строка попала в кадр */
function showTime(sp) {
  if (!sp) return;
  const { W } = timelineDims();
  const viewDur = W / editor.pxPerSec;
  if (sp.start < editor.scrollT + viewDur * 0.1 || sp.end > editor.scrollT + viewDur * 0.9) {
    editor.scrollT = Math.max(0, sp.start - viewDur * 0.25);
    clampScroll();
  }
}

/* Подпись и поля панели выбранной строки.

   Времена лежат в полях, а не в подписи: раньше строка вида
   «№26: 87.74 → 90.30 с · 2.56 с» была только для чтения, а править
   их приходилось восемью кнопками ±1/±0,1. Теперь в подписи остаётся
   один номер строки, а числа правятся прямо там, где показаны. */
function updateSelInfo() {
  const el = $('tl-sel');
  if (!el) return;
  const sp = spanOfRow(editor.sel);
  const line = sp ? sp.line : null;
  el.textContent = !sp ? 'Строка не выбрана'
    : `Строка №${sp.row + 1}${line.сомнительная ? ' · время на глазок' : ''}`;

  /* Поле, в котором прямо сейчас набирают, не трогаем: панель
     обновляется и по ходу воспроизведения, и затирать набранное
     на полуслове было бы худшим, что можно сделать с полем ввода.
     Именно набирают, а не просто «стоит курсор»: иначе отмена при
     курсоре в поле оставляла бы в нём отменённое число. */
  const заполнить = (id, v) => {
    const поле = $(id);
    if (!поле) return;
    поле.disabled = !sp;
    if (document.activeElement === поле && поле.dataset.набирают) return;
    поле.classList.remove('bad');
    поле.value = sp ? v.toFixed(2) : '';
  };
  заполнить('sel-start', sp ? sp.start : 0);
  заполнить('sel-end', sp ? sp.end : 0);
  const dur = $('sel-dur');
  if (dur) dur.textContent = sp ? Math.max(0, sp.end - sp.start).toFixed(2) : '—';

  // Пока строка не выбрана, работать не с чем — кнопки гаснут
  const panel = $('sel-panel');
  panel.classList.toggle('empty', !sp);
  $('btn-sel-play').disabled = !sp;
  $('btn-sel-words').disabled = !sp;
  $('btn-sel-del').disabled = !state.lines.length;
  const marked = !!(line && hasWords(line));
  $('btn-sel-words').classList.toggle('marked', marked);
  $('btn-sel-words').textContent = marked ? '♪ слова ✓' : '♪ слова';
  $('btn-sel-words-reset').classList.toggle('hidden', !marked);
}

/* ---------- Правка отрезков оригинала ----------
   Отрезки лежат в state.origSpans по возрастанию времени и не налезают
   друг на друга. Порядок держится сам собой: каждая граница зажата
   между соседями, поэтому во время перетаскивания номера не меняются
   и editor.origSel остаётся тем же отрезком. */

/* Куда вправе двигаться отрезок №i: до соседей, с зазором в два
   затухания — чтобы переходы не наложились друг на друга */
function границыОтрезка(i) {
  const spans = отрезкиОригинала();
  const зазор = ОТРЕЗОК_ФЕЙД * 2;
  const пред = spans[i - 1];
  const след = spans[i + 1];
  return {
    lo: пред ? пред.end + зазор : 0,
    hi: след ? след.start - зазор : (audio.duration || Infinity),
  };
}

/* Новый отрезок в точке t. Возвращает его номер или −1, если места
   нет: точка внутри чужого отрезка или свободный промежуток слишком мал. */
function вставитьОтрезок(t) {
  const spans = state.origSpans;
  const зазор = ОТРЕЗОК_ФЕЙД * 2;
  let i = 0;
  while (i < spans.length && spans[i].end <= t) i++;
  if (i < spans.length && spans[i].start <= t) return -1;   // внутри чужого
  const lo = i > 0 ? spans[i - 1].end + зазор : 0;
  const hi = i < spans.length ? spans[i].start - зазор : (audio.duration || Infinity);
  if (hi - lo < ОТРЕЗОК_МИН) return -1;
  const start = Math.min(Math.max(t, lo), hi - ОТРЕЗОК_МИН);
  spans.splice(i, 0, { start, end: start });
  return i;
}

function удалитьОтрезок(i) {
  if (!state.origSpans[i]) return;
  pushHistory();
  state.origSpans.splice(i, 1);
  editor.origSel = -1;
  saveProject();
  drawTimeline();
}

/* ---------- Перетаскивание ---------- */
const tl = $('timeline');

function beginOrigDrag(hit, t) {
  pushHistory();
  let i = hit.i;
  let kind = hit.kind;
  let создан = false;
  if (kind === 'orig-new') {
    i = вставитьОтрезок(t);
    if (i < 0) { dropEmptyHistory(); return; }
    создан = true;
  }
  editor.origSel = i;
  editor.drag = { kind, i, создан, grabT: t, was: { ...state.origSpans[i] }, moved: false };
}

function applyOrigDrag(t) {
  const d = editor.drag;
  const s = state.origSpans[d.i];
  if (!s) return;
  const гр = границыОтрезка(d.i);
  const зажать = (v) => Math.min(Math.max(v, гр.lo), гр.hi);
  d.moved = Math.abs(t - d.grabT) * editor.pxPerSec >= 4;

  if (d.kind === 'orig-new') {
    /* Тянем в любую сторону от точки нажатия: отрезок растёт туда,
       куда ведут мышь, — как рисуют область в монтажной программе */
    const nt = зажать(примагнитить(t, { кроме: d.i }));
    s.start = Math.min(d.grabT, nt);
    s.end = Math.max(d.grabT, nt);
    s.start = зажать(s.start);
    s.end = Math.max(s.start, зажать(s.end));
  } else if (d.kind === 'orig-start') {
    s.start = Math.min(зажать(примагнитить(t, { кроме: d.i })), s.end - ОТРЕЗОК_МИН);
    s.start = Math.max(s.start, гр.lo);
  } else if (d.kind === 'orig-end') {
    s.end = Math.max(зажать(примагнитить(t, { кроме: d.i })), s.start + ОТРЕЗОК_МИН);
    s.end = Math.min(s.end, гр.hi);
  } else if (d.kind === 'orig-move') {
    const длина = d.was.end - d.was.start;
    const nt = примагнитить(d.was.start + (t - d.grabT), { кроме: d.i });
    s.start = Math.min(Math.max(nt, гр.lo), Math.max(гр.lo, гр.hi - длина));
    s.end = s.start + длина;
  }
  drawTimeline();
}

function endOrigDrag() {
  const d = editor.drag;
  editor.drag = null;
  editor.snapped = null;
  const s = state.origSpans[d.i];
  /* Просто щелчок по пустому месту полосы — это не «отрезок в ноль
     длиной», а перемотка: ставим указатель туда, куда ткнули */
  if (d.создан && (!d.moved || !s || s.end - s.start < ОТРЕЗОК_МИН)) {
    state.origSpans.splice(d.i, 1);
    editor.origSel = -1;
    dropEmptyHistory();
    if (!d.moved) seekTo(d.grabT);
    drawTimeline();
    return;
  }
  state.origSpans = нормОтрезки(state.origSpans, audio.duration);
  // После слияния номер мог сдвинуться — ищем отрезок по времени
  editor.origSel = state.origSpans.findIndex((x) => s && x.start <= s.start && x.end >= s.end);
  if (!dropEmptyHistory()) saveProject();
  audio.applyMix();   // расписание пересчитывается на ходу, не дожидаясь перезапуска
  drawTimeline();
}

function beginDrag(hit, t) {
  const sp = spanOfRow(hit.row);
  if (!sp) return;
  pushHistory();
  editor.drag = {
    kind: hit.kind,
    row: hit.row,
    k: hit.k,
    grabT: t,
    startWas: sp.line.time,
    endWas: lineEnd(syncedLines(), syncedLines().indexOf(sp.line)),
    words: hasWords(sp.line) ? sp.line.words.map((w) => ({ ...w })) : null,
    moved: false,
  };
}

/* Ручную разметку слов делаем из того, что видно: пока слова делились
   автоматически, тянуть их границу было бы некуда — сначала записываем
   текущее деление как настоящее, а потом двигаем в нём одну границу. */
function ensureWords(line, sp) {
  if (hasWords(line)) return line.words;
  const words = lineWords(line, sp);
  line.words = words.map((w) => ({ text: w.text, time: w.start, end: w.end }));
  return line.words;
}

function applyDrag(t) {
  const d = editor.drag;
  const line = state.lines[d.row];
  if (!line) return;
  const sp = spanOfRow(d.row);
  d.moved = true;

  if (d.kind === 'line-start') {
    setLineTime(d.row, примагнитить(t, { кромеСтроки: d.row }));
  } else if (d.kind === 'line-end') {
    setLineEnd(d.row, примагнитить(t, { кромеСтроки: d.row }));
  } else if (d.kind === 'line-move') {
    const hadEnd = line.ручнойКонец;
    // Блок целиком тянется за начало: липнет ведущая граница, как в монтажной
    const ns = примагнитить(d.startWas + (t - d.grabT), { кромеСтроки: d.row });
    setLineTime(d.row, ns);
    // Конец едет за строкой, только если человек уже задавал его руками:
    // иначе он и так пересчитается от нового начала
    if (hadEnd) setLineEnd(d.row, d.endWas + (ns - d.startWas));
  } else if (d.kind === 'word-edge' || d.kind === 'word-move') {
    if (!sp) return;
    const words = ensureWords(line, sp);
    const k = d.k;
    if (!words[k]) return;
    if (d.kind === 'word-edge') {
      const lo = (words[k - 1] ? words[k - 1].time : line.time) + MIN_SPAN;
      const hi = (words[k].end != null ? words[k].end : sp.end) - MIN_SPAN;
      const nt = Math.min(Math.max(примагнитить(t), lo), Math.max(lo, hi));
      words[k].time = nt;
      if (words[k - 1]) words[k - 1].end = nt;
    } else {
      // Слово целиком: двигаем его вместе с обеими границами
      const src = d.words && d.words[k] ? d.words[k] : words[k];
      const delta = t - d.grabT;
      const width = (src.end != null ? src.end : src.time + 0.3) - src.time;
      const lo = (words[k - 1] ? words[k - 1].time : line.time) + MIN_SPAN;
      const hi = (words[k + 1] ? words[k + 1].end != null ? words[k + 1].end : sp.end : sp.end)
        - width - MIN_SPAN;
      const nt = Math.min(Math.max(src.time + delta, lo), Math.max(lo, hi));
      words[k].time = nt;
      words[k].end = nt + width;
      if (words[k - 1]) words[k - 1].end = nt;
      if (words[k + 1]) words[k + 1].time = Math.max(nt + width, words[k + 1].time);
    }
  }
  editor.spansKey = '';
  refreshTimes();
  editor.stageKey = '';
  drawTimeline();
}

/* Перемотка щелчком по пустому месту дорожки */
function seekTo(t) {
  const пос = Math.min(Math.max(0, t), audio.duration);
  if (audio.playing) audio.play(пос);
  else audio.offset = пос;
  editor.stageKey = '';
  renderEditStage();
  updatePlayerUI();
  setText('edit-time', fmtTime(audio.position()));
}

tl.addEventListener('pointerdown', (e) => {
  const rect = tl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const hit = timelineHit(x, y);
  editor.безМагнита = !!e.altKey;
  if (hit && hit.kind === 'orig-del') {
    удалитьОтрезок(hit.i);
    return;
  }
  if (hit && hit.kind.startsWith('orig-')) {
    beginOrigDrag(hit, xToT(x));
    try { tl.setPointerCapture(e.pointerId); } catch (err) { /* необязательно */ }
  } else if (hit) {
    if (hit.row !== editor.sel) selectLine(hit.row, { scrollList: true });
    beginDrag(hit, xToT(x));
    try { tl.setPointerCapture(e.pointerId); } catch (err) { /* необязательно */ }
  } else {
    seekTo(xToT(x));
  }
  drawTimeline();
});

tl.addEventListener('pointermove', (e) => {
  const rect = tl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  // Зажатый Alt отключает магнит на время: так же в Logic Pro и Final Cut
  editor.безМагнита = !!e.altKey;
  if (editor.drag) {
    if (editor.drag.kind.startsWith('orig-')) applyOrigDrag(xToT(x));
    else applyDrag(xToT(x));
    return;
  }
  const hit = timelineHit(x, y);
  tl.style.cursor = !hit ? 'pointer'
    : hit.kind === 'orig-del' ? 'pointer'
      : hit.kind === 'orig-new' ? 'crosshair'
        : hit.kind === 'line-start' || hit.kind === 'line-end'
          || hit.kind === 'word-edge' || hit.kind === 'orig-start' || hit.kind === 'orig-end'
          ? 'ew-resize' : 'grab';
});

function endDrag() {
  if (!editor.drag) return;
  if (editor.drag.kind.startsWith('orig-')) { endOrigDrag(); return; }
  editor.drag = null;
  editor.snapped = null;
  if (!dropEmptyHistory()) {
    saveProject();
    renderEditList();
    updateSelInfo();   // ручное деление слов могло появиться, см. ensureWords
    updateWordExportBtn();
    editor.stageKey = '';
    renderEditStage();
  }
  drawTimeline();
}

tl.addEventListener('pointerup', endDrag);
tl.addEventListener('pointercancel', endDrag);

/* Двойной щелчок по отрезку оригинала убирает его — как и крестик
   у правого края блока. Крестик виден, двойной щелчок привычен. */
tl.addEventListener('dblclick', (e) => {
  const rect = tl.getBoundingClientRect();
  const hit = timelineHit(e.clientX - rect.left, e.clientY - rect.top);
  if (hit && (hit.kind === 'orig-move' || hit.kind === 'orig-start'
    || hit.kind === 'orig-end' || hit.kind === 'orig-del')) {
    e.preventDefault();
    удалитьОтрезок(hit.i);
  }
});

/* Колесо: прокрутка по времени, с Cmd/Ctrl/Alt (и щипком тачпада) — масштаб */
tl.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = tl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (e.ctrlKey || e.metaKey || e.altKey) {
    zoomAt(Math.pow(0.995, e.deltaY), x);
  } else {
    editor.scrollT += (e.deltaX + e.deltaY) / editor.pxPerSec;
    clampScroll();
    drawTimeline();
  }
}, { passive: false });

/* Масштаб вокруг точки: время под курсором остаётся на месте */
function zoomAt(factor, x) {
  const t = xToT(x);
  editor.pxPerSec = Math.min(400, Math.max(4, editor.pxPerSec * factor));
  editor.scrollT = t - x / editor.pxPerSec;
  clampScroll();
  drawTimeline();
}

function zoomTimeline(factor) {
  const { W } = timelineDims();
  zoomAt(factor, W / 2);
}
$('tl-zoom-in').addEventListener('click', () => zoomTimeline(1.5));
$('tl-zoom-out').addEventListener('click', () => zoomTimeline(1 / 1.5));
$('tl-fit').addEventListener('click', () => {
  const { W } = timelineDims();
  editor.pxPerSec = Math.max(4, W / Math.max(1, audio.duration || 1));
  editor.scrollT = 0;
  drawTimeline();
});
$('tl-undo').addEventListener('click', undoEdit);
$('tl-redo').addEventListener('click', redoEdit);
$('tl-snap').addEventListener('click', () => setSnap(!editor.snap));
$('tl-loop').addEventListener('click', () => setLoop(!editor.loop));

function setSnap(on) {
  editor.snap = !!on;
  $('tl-snap').classList.toggle('on', editor.snap);
  editor.snapped = null;
  drawTimeline();
}

/* ---------- Прослушивание выбранной строки по кругу ----------
   Кольцо крутит отрезок «немного до строки — строка — немного после».
   Вокал при этом включён всегда: подгонять на слух иначе не выйдет. */
const LOOP_LEAD = 0.8;
const LOOP_TAIL = 0.5;

function loopBounds() {
  const sp = spanOfRow(editor.sel);
  if (!sp) return null;
  return {
    from: Math.max(0, sp.start - LOOP_LEAD),
    to: Math.min(audio.duration, sp.end + LOOP_TAIL),
  };
}

function setLoop(on) {
  editor.loop = !!on && editor.sel >= 0;
  $('tl-loop').classList.toggle('on', editor.loop);
  const b = loopBounds();
  if (editor.loop && b) {
    audio.play(b.from);
    audio.stopAt = null;      // кольцо само вернёт указатель назад
    audio.forceVocal = true;
    audio.applyMix();
  } else {
    audio.restoreVocal();
  }
  drawTimeline();
}

/* Вызывается каждый кадр, пока открыт редактор */
function tickLoop() {
  if (!editor.loop) return;
  const b = loopBounds();
  if (!b) { setLoop(false); return; }
  if (audio.playing && audio.position() >= b.to) audio.play(b.from);
}

$('btn-edit-play').addEventListener('click', () => {
  if (audio.playing) audio.pause();
  else audio.play();
});

$('btn-back-2').addEventListener('click', () => goToStep(2));
$('btn-editor-next').addEventListener('click', () => goToStep(4));

window.addEventListener('resize', () => {
  if ($('step-3').classList.contains('active')) {
    resizeTimeline();
    drawTimeline();
    fitStageLines($('edit-stage'));
  }
  if ($('step-4').classList.contains('active')) {
    fitStageLines($('lyrics-stage'));
    placeCountdown($('lyrics-stage')); // раскладка поехала — точки тоже
  }
});

/* Держим курсор в кадре во время воспроизведения */
function followPlayhead() {
  if (!audio.playing || editor.drag) return;
  const { W } = timelineDims();
  const viewDur = W / editor.pxPerSec;
  const pos = audio.position();
  if (pos > editor.scrollT + viewDur * 0.85 || pos < editor.scrollT) {
    editor.scrollT = Math.max(0, pos - viewDur * 0.15);
  }
}

/* ============================================================
   Клавиши редактора

   Пробел живёт в общем обработчике внизу файла — он один на все шаги.
   Здесь всё остальное: выбор строки, точная подстройка, отмена.
   Величина шага: обычная 0,1 с, с Shift мельче, с Alt крупнее.
   ============================================================ */
const NUDGE_STEP = 0.1;
const NUDGE_FINE = 0.02;
const NUDGE_COARSE = 1;

/* Клавиша по её месту на клавиатуре, а не по букве: у русской раскладки
   Cmd+Z — это Cmd+я, и по букве такое не поймать. Обычно место называет
   сам браузер в e.code; там, где его нет, выручает эта табличка. */
const KEY_ALIASES = {
  z: 'KeyZ', 'я': 'KeyZ', y: 'KeyY', 'н': 'KeyY',
  l: 'KeyL', 'д': 'KeyL', s: 'KeyS', 'ы': 'KeyS',
  '[': 'BracketLeft', 'х': 'BracketLeft',
  ']': 'BracketRight', 'ъ': 'BracketRight',
  '=': 'Equal', '+': 'Equal', '-': 'Minus', '_': 'Minus',
  ' ': 'Space',
};

function keyCode(e) {
  if (e.code) return e.code;
  const k = e.key || '';
  return KEY_ALIASES[k.toLowerCase()] || k;
}

function editorStep(e) {
  return e.shiftKey ? NUDGE_FINE : e.altKey ? NUDGE_COARSE : NUDGE_STEP;
}

function moveSelection(delta) {
  const rows = state.lines
    .map((l, i) => (l.time != null ? i : -1))
    .filter((i) => i >= 0);
  if (!rows.length) return;
  const at = rows.indexOf(editor.sel);
  const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1)
    : Math.min(rows.length - 1, Math.max(0, at + delta));
  selectLine(rows[next], { scrollList: true, scrollTimeline: true });
}

/* Подстройка выбранной строки с клавиатуры — с записью в историю */
function nudgeSelected(what, delta) {
  if (editor.sel < 0) return;
  pushHistory();
  if (what === 'start') nudgeLine(editor.sel, delta);
  else nudgeLineEnd(editor.sel, delta);
  dropEmptyHistory();   // сдвиг упёрся в соседнюю строку — отменять нечего
  renderEditList();
  editor.stageKey = '';
  renderEditStage();
  drawTimeline();
}

document.addEventListener('keydown', (e) => {
  if (!$('step-3').classList.contains('active')) return;
  if (wordTap.active) return;                 // разметка слов держит клавиши сама
  const el = document.activeElement;
  const typing = el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  const cmd = e.metaKey || e.ctrlKey;
  const code = keyCode(e);

  // Отмена и повтор работают всегда, кроме правки текста: там своя отмена
  if (cmd && (code === 'KeyZ' || code === 'KeyY')) {
    if (typing) return;
    e.preventDefault();
    // Общая отмена посреди простукивания снимает весь заход целиком:
    // сначала закрываем его, потом откатываем снимок, снятый перед ним
    if (tap.active) finishTapMode();
    if (code === 'KeyY' || e.shiftKey) redoEdit();
    else undoEdit();
    return;
  }
  // Остальными клавишами режим простукивания управляет сам, см. tapHit
  if (tap.active) return;
  if (cmd || typing) return;

  switch (code) {
    case 'ArrowUp': e.preventDefault(); moveSelection(-1); break;
    case 'ArrowDown': e.preventDefault(); moveSelection(1); break;
    case 'ArrowLeft': e.preventDefault(); nudgeSelected('start', -editorStep(e)); break;
    case 'ArrowRight': e.preventDefault(); nudgeSelected('start', editorStep(e)); break;
    case 'BracketLeft': e.preventDefault(); nudgeSelected('end', -editorStep(e)); break;
    case 'BracketRight': e.preventDefault(); nudgeSelected('end', editorStep(e)); break;
    case 'Enter':
      e.preventDefault();
      if (editor.sel >= 0) playLine(editor.sel);
      break;
    case 'KeyL': e.preventDefault(); setLoop(!editor.loop); break;
    case 'KeyS': e.preventDefault(); setSnap(!editor.snap); break;
    // Выбранный отрезок оригинала — убрать. Строки удаляются кнопкой
    // в инспекторе: слишком легко снести разметку случайной клавишей
    case 'Delete':
    case 'Backspace':
      if (editor.origSel >= 0) { e.preventDefault(); удалитьОтрезок(editor.origSel); }
      break;
    case 'Escape':
      if (editor.loop) { e.preventDefault(); setLoop(false); }
      else if (editor.origSel >= 0) { editor.origSel = -1; drawTimeline(); }
      break;
    case 'Equal':
    case 'NumpadAdd': e.preventDefault(); zoomTimeline(1.5); break;
    case 'Minus':
    case 'NumpadSubtract': e.preventDefault(); zoomTimeline(1 / 1.5); break;
    default: break;
  }
});

/* ---------- Экспорт видео для YouTube ----------
   Рисуем караоке на canvas 1280×720, звук ведём в MediaStream,
   пишем всё вместе через MediaRecorder. Запись в реальном времени. */
const videoExport = { active: false, cancelled: false };

/* ---------- Знак студии в углу кадра ----------
   Раньше в кадр попадала одна картинка логотипа: по ней узнаёт тот,
   кто уже знает, а название нигде не написано. Теперь над логотипом
   стоит имя студии — тем же фирменным Bungee Shade, что и в заставке.

   Кегль и отступы считаются от высоты кадра, чтобы знак одинаково
   смотрелся и в HD, и в 2K. Прозрачность у надписи ниже, чем у
   логотипа: спорить с текстом песни она не должна. */
const ЗНАК_ТЕКСТ = 'Karaoke Punch';
const ЗНАК_ШРИФТ = '"Bungee Shade", Impact, sans-serif';
const знакКегль = (H) => Math.max(10, Math.round(H * 0.03));

/* Холст рисует нужным шрифтом только после того, как шрифт по-настоящему
   загружен: сам по себе canvas загрузку не запускает, в отличие от текста
   на странице. Если начать запись раньше, первые кадры уедут запасным
   шрифтом — на экране этого не видно, видно только в готовом файле.
   Поэтому перед записью ждём шрифт явно.

   Возвращает true, если шрифт действительно доступен: не пришёл файл —
   пишем запасным, отменять из-за этого экспорт незачем. */
async function дождатьсяЗнака(H) {
  if (!document.fonts || !document.fonts.load) return false;
  const запрос = `${знакКегль(H)}px ${ЗНАК_ШРИФТ}`;
  try {
    await document.fonts.load(запрос, ЗНАК_ТЕКСТ);
    await document.fonts.ready;
    /* Проверяем один Bungee Shade, без запасных: в списке с запасными
       ответ был бы «да» и тогда, когда фирменный файл не пришёл. */
    return document.fonts.check(`${знакКегль(H)}px "Bungee Shade"`, ЗНАК_ТЕКСТ);
  } catch (e) {
    return false;   // шрифта нет — не повод срывать запись
  }
}

function рисоватьЗнак(g2d, W, H, watermark) {
  const size = Math.round(H * 0.09);      // сторона логотипа
  const margin = Math.round(H * 0.03);
  const кегль = знакКегль(H);
  g2d.save();
  if (watermark) {
    g2d.globalAlpha = 0.75;
    g2d.drawImage(watermark, W - size - margin, H - size - margin, size, size);
  }
  // Имя выровнено по правому краю логотипа и стоит над ним
  g2d.globalAlpha = 0.6;
  g2d.font = `400 ${кегль}px ${ЗНАК_ШРИФТ}`;
  g2d.textAlign = 'right';
  g2d.textBaseline = 'alphabetic';
  const низ = H - margin - (watermark ? size : 0) - Math.round(H * 0.012);
  /* Тёмный контур под белой буквой. Фоном кадра бывает и светлая
     картинка, а на ней белая надпись без контура просто теряется —
     проверено на светлой подложке. Контур тонкий: у Bungee Shade
     объём нарисован в самой букве, и толстая обводка съела бы его. */
  g2d.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  g2d.lineWidth = Math.max(1, кегль * 0.11);
  g2d.lineJoin = 'round';
  g2d.strokeText(ЗНАК_ТЕКСТ, W - margin, низ);
  g2d.fillStyle = '#ffffff';
  g2d.fillText(ЗНАК_ТЕКСТ, W - margin, низ);
  g2d.restore();
  // Для самопроверки: ширина надписи в последнем кадре
  рисоватьЗнак.последний = {
    кегль,
    ширина: g2d.measureText ? измеритьЗнак(g2d, кегль) : 0,
    низ,
  };
}

/* Ширина надписи знака тем шрифтом, которым её сейчас нарисовали бы.
   Отдельной функцией, потому что этим же замером проверяется, что
   к началу записи применился именно Bungee Shade, а не запасной. */
function измеритьЗнак(g2d, кегль) {
  const было = g2d.font;
  g2d.font = `400 ${кегль}px ${ЗНАК_ШРИФТ}`;
  const w = g2d.measureText(ЗНАК_ТЕКСТ).width;
  g2d.font = было;
  return w;
}

function drawVideoFrame(g2d, W, H, bgImg, pos, watermark) {
  const st = state.style;

  // Фон
  if (st.bgMode === 'color') {
    g2d.fillStyle = st.bgColor;
    g2d.fillRect(0, 0, W, H);
  } else if (bgImg) {
    const scale = Math.max(W / bgImg.width, H / bgImg.height);
    const w = bgImg.width * scale, h = bgImg.height * scale;
    g2d.drawImage(bgImg, (W - w) / 2, (H - h) / 2, w, h);
    // Та же подложка, что на экране: полоса под текстом, а не общее затемнение
    const stops = scrimStops(st);
    if (stops) {
      const scrim = g2d.createLinearGradient(0, 0, 0, H);
      stops.forEach((p) => scrim.addColorStop(p.at, `rgba(8, 8, 12, ${p.alpha})`));
      g2d.fillStyle = scrim;
      g2d.fillRect(0, 0, W, H);
    }
  } else {
    const grad = g2d.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#171129');
    grad.addColorStop(1, '#0a0a0f');
    g2d.fillStyle = grad;
    g2d.fillRect(0, 0, W, H);
  }

  const lines = syncedLines();
  const ph = stagePhase(pos);
  const cur = ph.cur;

  // Поля по краям берём из настроек: на нуле текст занимает всю ширину
  const maxWidth = W * (1 - (st.pad / 100) * 2);
  g2d.textAlign = 'center';
  g2d.textBaseline = 'middle';

  const family = (FONTS[st.font] || FONTS.system).css;
  const font = (size) => `${st.weight} ${size}px ${family}`;

  /* Кегль — единый на всю песню и тот же, что на экране: stageFit
     считает его от ширины поверхности, а поверхность здесь — кадр.
     Поэтому при любом качестве записи текст занимает одну и ту же
     долю картинки, и та же доля выходит на сцене караоке и в
     предпросмотре редактора. */
  const fit = stageFit(W / FIT_FRAME_COLS, maxWidth);
  const size = Math.max(10, fit.size);
  const lineGap = st.line / 10;
  const rowH = size * lineGap;

  // Последний нарисованный кадр — для самопроверки (единый кегль,
  // отсутствие наложений). Данные те же, по которым идёт отрисовка.
  const layout = { size, unit: W / FIT_FRAME_COLS, m: fit.m, rowH, items: [] };
  drawVideoFrame.последнийКадр = layout;

  /* Строка разбирается на куски: слово со своей долей закраски (p)
     либо весь текст целиком, когда закраска идёт по всей строке
     (ноты проигрыша). Одни и те же куски идут и в раскладку, и в отрисовку,
     поэтому число рядов у них совпадает. */
  const chunksFor = (text, kind, line) => {
    if (kind === 'cur' && line) {
      const words = lineWords(line, ph);
      const done = wordProgress(words, pos);
      return words.map((w, i) => ({ text: w.text, p: done[i] }));
    }
    if (kind === 'cur') {
      const start = ph.start;
      const end = ph.mode === 'break' ? ph.until : ph.end;
      const p = end > start ? Math.min(1, Math.max(0, (pos - start) / (end - start))) : 1;
      return [{ text, p }];
    }
    return fit.wrap.has(text)
      ? splitWords(text).map((t) => ({ text: t, p: null }))
      : [{ text, p: null }];
  };

  /* Ряды строки: обычно один. Строку, отмеченную к переносу (не влезла
     даже на самом мелком едином кегле), раскладываем жадно по ширине —
     так же, как её переносит браузер на экране. */
  const rowsOf = (text, chunks) => {
    if (!fit.wrap.has(text)) return [chunks];
    g2d.font = font(size);
    const rows = [];
    let row = [];
    let w = 0;
    for (const c of chunks) {
      const cw = g2d.measureText(c.text).width;
      if (row.length && w + cw > maxWidth) { rows.push(row); row = []; w = 0; }
      row.push(c);
      w += cw;
    }
    if (row.length) rows.push(row);
    return rows;
  };

  const strokeIfNeeded = (text, x, cy) => {
    if (st.outline > 0) {
      g2d.lineWidth = st.outline * 2;
      g2d.strokeStyle = st.outlineColor;
      g2d.lineJoin = 'round';
      g2d.strokeText(text, x, cy);
    }
  };

  /* Приглушение неактивных строк — прозрачностью и размытием, как на экране.
     Размер строк одинаковый у всех, меняется только «плотность». */
  const dimAlpha = Math.max(0, Math.min(100, st.dim)) / 100;
  const nearAlpha = Math.min(0.95, dimAlpha + 0.3);
  const canFilter = 'filter' in g2d;
  const blurPx = (st.blur || 0) * (H / 360); // на экране сцена вдвое ниже кадра
  const setDim = (kind) => {
    g2d.globalAlpha = kind === 'cur' ? 1 : kind === 'near' ? nearAlpha : dimAlpha;
    if (canFilter) {
      const b = kind === 'cur' ? 0 : kind === 'near' ? blurPx * 0.5 : blurPx;
      g2d.filter = b > 0.1 ? `blur(${b.toFixed(2)}px)` : 'none';
    }
  };
  const clearDim = () => {
    g2d.globalAlpha = 1;
    if (canFilter) g2d.filter = 'none';
  };

  /* Отсчёт перед вступлением строки: три точки на месте нот проигрыша */
  const cd = countdownState(pos, ph);
  const drawCountdown = (cy) => {
    const r = Math.max(4, size * 0.2);
    const gap = r * 3.4;
    const from = W / 2 - ((COUNT_DOTS - 1) * gap) / 2;
    for (let i = 0; i < COUNT_DOTS; i++) {
      const alive = i < cd.lit;
      const scale = alive
        ? (i === cd.lit - 1 && !reduceMotion.matches ? 0.55 + 0.45 * cd.frac : 1)
        : 0.55;
      g2d.globalAlpha = alive ? 1 : 0.18;
      g2d.fillStyle = alive ? st.accent : st.inactive;
      g2d.beginPath();
      g2d.arc(from + i * gap, cy, r * scale, 0, Math.PI * 2);
      g2d.fill();
    }
    clearDim();
  };

  /* Одна строка кадра: куски рисуются по очереди, каждый своим цветом
     и со своей долей закраски. Длинная строка занимает несколько рядов,
     они расходятся вверх и вниз от середины строки. Возвращает высоту,
     которую строка заняла, — по ней считается раскладка. */
  const drawLineAt = (text, cy, kind, line) => {
    g2d.font = font(size);
    g2d.letterSpacing = `${st.letter}px`;
    const chunks = chunksFor(text, kind, line);
    const rows = rowsOf(text, chunks);
    layout.items.push({ text, cy, kind, rows: rows.length, size, height: rows.length * rowH });
    setDim(kind);
    g2d.textAlign = 'left';
    rows.forEach((row, r) => {
      const widths = row.map((c) => g2d.measureText(c.text).width);
      const rowW = widths.reduce((a, b) => a + b, 0);
      const y = cy + (r - (rows.length - 1) / 2) * rowH;
      let x = (W - rowW) / 2;
      row.forEach((c, i) => {
        strokeIfNeeded(c.text, x, y);
        if (kind !== 'cur' || c.p == null) {
          g2d.fillStyle = kind === 'off' ? st.inactive : st.active;
          g2d.fillText(c.text, x, y);
        } else if (st.effect === 'fill') {
          g2d.fillStyle = st.active;
          g2d.fillText(c.text, x, y);
          if (c.p > 0) {
            g2d.save();
            g2d.beginPath();
            g2d.rect(x, y - size, widths[i] * c.p, size * 2);
            g2d.clip();
            g2d.fillStyle = st.accent;
            g2d.fillText(c.text, x, y);
            g2d.restore();
          }
        } else {
          g2d.fillStyle = (st.effect === 'highlight' && c.p >= 0.5) ? st.accent : st.active;
          g2d.fillText(c.text, x, y);
        }
        x += widths[i];
      });
    });
    g2d.textAlign = 'center';
    clearDim();
    return rows.length * rowH;
  };

  /* Сколько места займёт строка, если её нарисовать, — нужно раскладке
     до отрисовки. Считается теми же кусками, что и сама отрисовка. */
  const heightOf = (text, kind, line) =>
    rowsOf(text, chunksFor(text, kind, line)).length * rowH;

  /* Закреплённые места: две строки рисуются каждая на своей высоте
     и не съезжают. Активна та, чья очередь петь. */
  if (!st.swapLines) {
    /* Места строк — те же, что на сцене (slotPositions): перенесённые
       на несколько рядов строки раздвигаются, чтобы не налезть друг
       на друга. Считается одинаково здесь и в караоке. */
    const места = slotPositions(fit, H);
    const место = (доля) => (доля === st.posCurrent ? места.a
      : доля === st.posNext ? места.b : H * доля / 100);
    const activeSlot = cur < 0 ? 0 : cur % 2;
    const nextIndex = cur < 0 ? 0 : cur + 1;
    /* То же правило, что на сцене: ноты проигрыша занимают целое место,
       строку оттуда убираем. Место выбираем так, чтобы следующая строка
       осталась на виду: ноты встают туда, где её нет. */
    const nextSlot = cur < 0 ? 0 : 1 - activeSlot;
    const breakSlot = 1 - nextSlot;
    for (const slot of [0, 1]) {
      if (ph.mode === 'break' && slot === breakSlot) continue;
      const top = slot === 0 ? st.posCurrent : st.posNext;
      let index;
      let kind = 'off';
      if (cur < 0) index = slot === 0 ? 0 : 1;
      else if (slot === activeSlot) { index = cur; if (ph.mode !== 'break') kind = 'cur'; }
      else index = nextIndex;
      if (index >= lines.length) continue;
      if (kind !== 'cur' && index === nextIndex) kind = 'near';
      drawLineAt(lines[index].text, место(top), kind, kind === 'cur' ? lines[index] : null);
    }
    const breakTop = breakSlot === 0 ? st.posCurrent : st.posNext;
    // Пока идёт отсчёт, точки занимают место нот проигрыша
    if (ph.mode === 'break' && !cd) {
      drawLineAt(BREAK_TEXT_FRAME, место(breakTop), 'cur', null);
    }
    if (cd) {
      drawCountdown(ph.mode === 'break'
        ? место(breakTop)
        : места.a - места.half - size * 0.35);
    }
    g2d.letterSpacing = '0px';
    рисоватьЗнак(g2d, W, H, watermark);
    return;
  }

  /* Прокрутка: строки идут столбиком, ноты проигрыша — отдельной строкой
     между спетой и следующей. Каждая занимает своё место в столбце,
     поэтому налезть друг на друга они не могут. */
  const blocks = [];
  const push = (text, kind, index = null) => {
    const line = kind === 'cur' && index != null ? lines[index] : null;
    blocks.push({ text, kind, line, height: heightOf(text, kind, line) });
  };
  const total = st.lines;
  const before = Math.min(2, Math.floor((total - 1) / 2));
  if (ph.mode === 'break') {
    for (let i = Math.max(0, cur - before + 1); i <= cur; i++) push(lines[i].text, 'off');
    push(BREAK_TEXT_FRAME, 'cur');
    for (let i = cur + 1; i < Math.min(lines.length, cur + total - before); i++) {
      push(lines[i].text, i === cur + 1 ? 'near' : 'off', i);
    }
  } else {
    const anchor = cur === -1 ? 0 : cur;
    const first = Math.max(0, anchor - before);
    for (let i = first; i < Math.min(lines.length, first + total); i++) {
      push(lines[i].text,
        i === cur ? 'cur' : (i === cur + 1 || (cur === -1 && i === 0)) ? 'near' : 'off', i);
    }
  }

  const blockGap = Math.round(size * 0.35);
  const totalH = blocks.reduce((sum, b) => sum + b.height + blockGap, -blockGap);
  const pad = Math.round(H / 18);
  let y = st.valign === 'flex-start' ? pad
    : st.valign === 'flex-end' ? H - pad - totalH
    : H / 2 - totalH / 2;

  let countCy = null;
  for (const b of blocks) {
    const cy = y + b.height / 2;
    const isBreak = b.kind === 'cur' && !b.line && ph.mode === 'break';
    // Отсчёт встаёт на место нот проигрыша, а до первого куплета — над строкой
    if (cd && (isBreak || (countCy == null && b.kind === 'near'))) {
      countCy = isBreak ? cy : y - rowH * 0.35;
    }
    // Пока идёт отсчёт, ноты скрыты — вместо них точки
    if (!(isBreak && cd)) drawLineAt(b.text, cy, b.kind, b.line);
    y += b.height + blockGap;
  }
  g2d.letterSpacing = '0px';
  if (cd) drawCountdown(countCy != null ? countCy : H / 2);

  // Знак студии в правом нижнем углу: логотип и имя над ним
  рисоватьЗнак(g2d, W, H, watermark);
}

async function exportVideo() {
  if (videoExport.active || !state.originalBuffer) return;
  const lines = syncedLines();
  if (!lines.length) { alert('Сначала синхронизируй текст.'); return; }

  audio.pause();
  updatePlayerUI();
  videoExport.active = true;
  videoExport.cancelled = false;
  $('export-overlay').classList.remove('hidden');
  $('export-fill').style.width = '0%';
  $('export-status').textContent = 'Записываем видео…';

  // Логотип для угла кадра — грузим заранее, чтобы не мигал
  const watermark = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = 'watermark.png';
  });

  // Фоновая картинка (если есть)
  let bgImg = null;
  if (state.bgImage) {
    bgImg = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = state.bgImage;
    });
  }

  const quality = Number($('video-quality').value) || 1080;
  const H = quality;
  const W = Math.round(H * 16 / 9);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g2d = canvas.getContext('2d');

  /* Ждём фирменный шрифт знака до первого кадра. Ждать надо именно
     здесь, а не «когда-нибудь»: холст загрузку шрифта не запускает,
     и если начать писать раньше, первые секунды видео уйдут запасным
     шрифтом, а дальше надпись сменится на Bungee Shade. На экране
     такого не увидишь — разнобой остаётся только в файле. */
  $('export-status').textContent = 'Готовим шрифт…';
  await дождатьсяЗнака(H);
  $('export-status').textContent = 'Записываем видео…';

  // Звук: та же смесь, что в плеере, но в MediaStream вместо колонок
  const ctx = audio.ensureCtx();
  const dest = ctx.createMediaStreamDestination();
  const смесь = собратьМикс(ctx);
  смесь.output.connect(dest);
  const vGain = смесь.vocalGain;
  const iGain = смесь.instGain;
  const hasInst = !!state.instrumentalBuffer;
  // Ползунок вокала в записи действует ровно как в плеере
  const g = усиленияМикса(state.vocalMix, hasInst, false);
  vGain.gain.value = g.вокал;
  iGain.gain.value = g.минусовка;

  const sources = [];
  const orig = ctx.createBufferSource();
  orig.buffer = state.originalBuffer;
  orig.connect(vGain);
  sources.push(orig);
  if (hasInst) {
    const inst = ctx.createBufferSource();
    inst.buffer = state.instrumentalBuffer;
    inst.connect(iGain);
    sources.push(inst);
  }

  // Ноль кадров в секунду: захват идёт только по нашему requestFrame.
  // При автозахвате браузер сам решает, когда брать кадр, и в свёрнутом
  // окне перестаёт это делать — картинка замирает, а звук пишется дальше.
  const canvasStream = canvas.captureStream(0);
  const videoTrack = canvasStream.getVideoTracks()[0];
  const stream = new MediaStream([
    videoTrack,
    ...dest.stream.getAudioTracks(),
  ]);
  const mime = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ].find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const recorder = new MediaRecorder(stream, mime
    ? { mimeType: mime, videoBitsPerSecond: quality >= 1440 ? 18_000_000 : quality >= 1080 ? 12_000_000 : 7_000_000 }
    : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  const duration = audio.duration;
  const t0 = ctx.currentTime + 0.1;
  /* Отрезки оригинала — тем же расписанием, что и в плеере: в видео
     должно попасть ровно то, что человек слышал в караоке */
  расписатьОтрезки(ctx, vGain, iGain, g, отрезкиОригинала(), t0);
  const cleanup = () => {
    sources.forEach((s) => { try { s.stop(); } catch (e) { /* уже остановлен */ } });
    try { videoTrack.stop(); } catch (e) { /* уже остановлен */ }
    videoExport.active = false;
    $('export-overlay').classList.add('hidden');
  };

  recorder.onstop = () => {
    cleanup();
    if (videoExport.cancelled || !chunks.length) return;
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const name = (state.fileName || 'song').replace(/\.[^.]+$/, '');
    download(new Blob(chunks, { type: mime || 'video/webm' }), `${name} (караоке).${ext}`);
  };

  sources.forEach((s) => s.start(t0));
  recorder.start(1000);

  // Такты берём из фонового потока: обычные таймеры в свёрнутом окне
  // браузер замедляет до одного раза в секунду, и вместо видео получается
  // слайд-шоу, хотя звук пишется на полной скорости. Таймеры внутри
  // Worker такому замедлению не подвержены.
  const ticker = makeTicker(1000 / 30);
  let finished = false;
  const stop = () => {
    if (finished) return;
    finished = true;
    ticker.stop();
    recorder.stop();
  };
  videoExport.stop = stop;

  ticker.onTick = () => {
    if (videoExport.cancelled) { stop(); return; }
    const pos = ctx.currentTime - t0;
    if (pos >= duration + 0.3) { stop(); return; }
    drawVideoFrame(g2d, W, H, bgImg, Math.max(0, pos), watermark);
    if (typeof videoTrack.requestFrame === 'function') videoTrack.requestFrame();
    const pct = Math.min(100, (pos / duration) * 100);
    $('export-fill').style.width = `${pct.toFixed(1)}%`;
    $('export-status').textContent =
      `Записываем видео… ${fmtTime(Math.max(0, pos))} / ${fmtTime(duration)}`;
  };
  ticker.start();
}

/* Тактовый генератор в фоновом потоке — чтобы запись не замирала,
   когда окно свёрнуто или пользователь ушёл в другую вкладку */
function makeTicker(intervalMs) {
  const src = `let id = null;
    onmessage = (e) => {
      if (e.data.cmd === 'start') {
        clearInterval(id);
        id = setInterval(() => postMessage('tick'), e.data.ms);
      } else { clearInterval(id); id = null; }
    };`;
  const api = { onTick: null, start: null, stop: null };
  let worker = null;
  let fallback = null;

  api.start = () => {
    try {
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = () => { if (api.onTick) api.onTick(); };
      worker.postMessage({ cmd: 'start', ms: intervalMs });
    } catch (e) {
      // Если фоновый поток запретили — пишем обычным таймером
      fallback = setInterval(() => { if (api.onTick) api.onTick(); }, intervalMs);
    }
  };
  api.stop = () => {
    if (worker) { worker.postMessage({ cmd: 'stop' }); worker.terminate(); worker = null; }
    if (fallback) { clearInterval(fallback); fallback = null; }
  };
  return api;
}

$('btn-export-video').addEventListener('click', exportVideo);
$('btn-export-cancel').addEventListener('click', () => { videoExport.cancelled = true; });

/* Политика автовоспроизведения: некоторые браузеры «замораживают»
   аудиоконтекст до жеста пользователя — размораживаем при любом клике */
document.addEventListener('pointerdown', () => {
  if (audio.ctx && audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
}, true);

/* ---------- Клавиатура ---------- */
document.addEventListener('keydown', (e) => {
  // Разметка слов забирает и пробел, и Esc — даже из полей ввода:
  // иначе пробел уедет в текст строки вместо отметки
  const code = keyCode(e);
  if (wordTap.active) {
    if (code === 'Space') { e.preventDefault(); tapWord(); return; }
    if (code === 'Escape') { e.preventDefault(); finishWordTap(false); return; }
    if (code === 'Enter') { e.preventDefault(); finishWordTap(true); return; }
  }
  /* Простукивание забирает пробел себе — в том числе с кнопки, на
     которой остался фокус после клика: иначе удар прошёл бы дважды.
     Escape и Enter заканчивают заход, Backspace отменяет последний удар. */
  if (tap.active) {
    if (code === 'Space') { e.preventDefault(); tapHit(); return; }
    if (code === 'Escape' || code === 'Enter') { e.preventDefault(); finishTapMode(); return; }
    if (code === 'Backspace') { e.preventDefault(); undoLastTap(); return; }
  }
  if (code !== 'Space') return;
  const active = document.activeElement;
  const tag = active && active.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'BUTTON' || (active && active.isContentEditable)) {
    return;
  }
  if (($('step-3').classList.contains('active') || $('step-4').classList.contains('active'))
      && state.originalBuffer) {
    e.preventDefault();
    if (audio.playing) audio.pause();
    else audio.play();
    updatePlayerUI();
  }
});

/* ---------- Автосохранение текста ---------- */
$('lyrics-input').addEventListener('input', () => saveProject());

/* ---------- Логотип ----------
   Если файлы иконок ещё не сделаны (node make-icons.js),
   вместо битой картинки показываем прежний значок */
function useLogoFallback(img) {
  img.classList.add('hidden');
  const fallback = $('logo-fallback');
  if (fallback) fallback.classList.remove('hidden');
}

['logo-img', 'logo-img-footer'].forEach((id) => {
  const img = $(id);
  if (!img) return;
  img.addEventListener('error', () => useLogoFallback(img));
  // Картинка могла не загрузиться ещё до подключения скрипта
  if (img.complete && img.naturalWidth === 0) useLogoFallback(img);
});

/* ---------- Проверка обновлений ----------
   Браузер охотно показывает старую копию из кэша, поэтому сверяем
   версию с сервером и предлагаем перезагрузиться в обход кэша.
   В настольной версии эту логику перехватывает desktop.js. */
const updater = {
  latest: null,
  handled: false, // настольная версия ставит true и решает сама
};

function showUpdateBar(text, actionLabel) {
  $('update-text').textContent = text;
  $('update-action').textContent = actionLabel;
  $('update-bar').classList.remove('hidden');
}

async function checkWebUpdate() {
  if (updater.handled) return;
  try {
    const res = await fetch(`version.json?ts=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.version || data.version === APP_VERSION) return;
    if (localStorage.getItem('karaoke-skip-version') === data.version) return;
    updater.latest = data.version;
    showUpdateBar(`Вышла новая версия студии — ${data.version}`, 'Обновить');
  } catch (e) { /* нет сети — не мешаем работать */ }
}

$('update-action').addEventListener('click', () => {
  if (updater.handled) return; // настольная версия навесит свой обработчик
  // Новый адрес заставляет браузер взять свежие файлы вместо кэша
  location.replace(`${location.pathname}?v=${updater.latest || Date.now()}${location.hash}`);
});

$('update-dismiss').addEventListener('click', () => {
  if (updater.latest) localStorage.setItem('karaoke-skip-version', updater.latest);
  $('update-bar').classList.add('hidden');
});

/* ---------- Окно «Что нового» ----------
   Показывается один раз после обновления и по кнопке в подвале.
   NEWS_VERSION — версия, про которую написан список в index.html.
   Она нарочно отдельна от APP_VERSION: мелкий выпуск без новостей
   не должен показывать окно с прошлым списком. */
const NEWS_VERSION = '1.8.4';
const NEWS_KEY = 'karaoke-news-version';

/* Сравнение номеров вида 1.7.0: −1, 0 или 1 */
function cmpVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/* Первый ли это визит: в хранилище нет ни одного нашего ключа.
   Новичку список изменений не нужен — он только мешает начать. */
function isFirstVisit() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('karaoke-')) return false;
    }
  } catch (e) { return true; } // хранилище недоступно — считаем первым визитом
  return true;
}

function showWhatsNew() {
  $('whatsnew').classList.remove('hidden');
  // Окно длинное и прокручивается: открываем его всегда сверху,
  // а фокус ставим без прокрутки, иначе список сразу уезжает в конец
  document.querySelector('.whatsnew-box').scrollTop = 0;
  $('whatsnew-ok').focus({ preventScroll: true });
}

function hideWhatsNew() {
  $('whatsnew').classList.add('hidden');
  try { localStorage.setItem(NEWS_KEY, NEWS_VERSION); } catch (e) { /* нет хранилища */ }
}

function maybeShowWhatsNew() {
  let seen = null;
  try { seen = localStorage.getItem(NEWS_KEY); } catch (e) { return; }
  if (seen === null) {
    // Либо новичок, либо тот, кто пользовался студией до появления окна.
    // Первому ничего не показываем, но метку ставим — увидит следующее обновление.
    if (isFirstVisit()) {
      try { localStorage.setItem(NEWS_KEY, NEWS_VERSION); } catch (e) { /* нет хранилища */ }
      return;
    }
    showWhatsNew();
    return;
  }
  if (cmpVersions(NEWS_VERSION, seen) > 0) showWhatsNew();
}

$('btn-whatsnew').addEventListener('click', () => showWhatsNew());
$('whatsnew-ok').addEventListener('click', hideWhatsNew);
$('whatsnew-close').addEventListener('click', hideWhatsNew);
// Клик мимо окна — по подложке, а не по самой карточке
$('whatsnew').addEventListener('click', (e) => {
  if (e.target === $('whatsnew')) hideWhatsNew();
});
// Ссылка на скачивание закрывает окно, иначе оно перекроет нужный раздел
$('whatsnew-link').addEventListener('click', hideWhatsNew);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('whatsnew').classList.contains('hidden')) {
    e.preventDefault();
    hideWhatsNew();
  }
});

/* ---------- Восстановление проекта при загрузке страницы ----------
   Восстанавливаем ВСЁ, что попало в проект, а не только текст с
   оформлением. Раньше эквалайзер и фон оставались только в хранилище,
   а в состоянии были пустыми — и первое же сохранение записывало
   поверх них нули и отсутствие картинки. */
(function init() {
  расставитьМодификаторы();
  const saved = loadProject();
  if (saved && saved.lyrics) $('lyrics-input').value = saved.lyrics;
  if (saved && saved.style) state.style = styleFromSaved(saved);
  // Отрезки оригинала: длины песни ещё не знаем, обрежем её при загрузке файла
  if (saved && saved.origSpans) state.origSpans = нормОтрезки(saved.origSpans, 0);
  if (saved && saved.eq) {
    state.eq = {
      low: +saved.eq.low || 0, mid: +saved.eq.mid || 0, high: +saved.eq.high || 0,
    };
  }
  updateStyleUI();
  updateEqUI();
  applyStyle();
  // Фон ставим через setBgImage: он же обновляет предпросмотр и кнопки
  if (saved && saved.bg) setBgImage(saved.bg);
  updateInstUI();
  tickPlayer(); // общий цикл обновления UI (лёгкий, обновляет только видимое)

  // Проверяем обновления при запуске и раз в полчаса
  setTimeout(checkWebUpdate, 1500);
  setInterval(checkWebUpdate, 30 * 60 * 1000);

  /* «Что нового» — с задержкой: настольная версия успевает пометить body
     классом is-desktop, и список сразу выходит правильным */
  setTimeout(maybeShowWhatsNew, 400);
})();
