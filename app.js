/* ============================================================
   Караоке Студия — вся обработка звука происходит в браузере
   ============================================================ */

const $ = (id) => document.getElementById(id);

/* Версия студии — сверяется с version.json, чтобы предупредить,
   что браузер показывает устаревшую копию из кэша */
const APP_VERSION = '1.7.0';

/* ---------- Состояние ---------- */
const state = {
  fileName: null,
  originalBuffer: null,     // AudioBuffer исходной песни
  instrumentalBuffer: null, // AudioBuffer с приглушённым вокалом (null для моно)
  lines: [],                // [{ text, time|null, end:number|null }]
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
    size: 100,          // проценты от базового размера
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
    pad: 8,             // поля по краям сцены, % — 0 растягивает текст во всю ширину
    swapLines: false,   // строки поднимаются вверх по мере пения
    posCurrent: 40,     // где стоит первая строка, % от верха (когда не меняются местами)
    posNext: 60,        // где стоит вторая строка
    anim: 'fade',       // fade | slide | none
    valign: 'center',   // flex-start | center | flex-end
    dim: 45,            // прозрачность неактивных строк, % (размер не меняется)
    blur: 0,            // лёгкое размытие неактивных строк, px
    scrim: 70,          // подложка-градиент под текстом поверх картинки, %
    countdown: true,    // отсчёт из трёх точек перед вступлением строки
  };
}
state.style = defaultStyle();

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

/* ---------- Аудио-движок ---------- */
const audio = {
  ctx: null,
  sources: [],
  vocalGain: null,
  instGain: null,
  startedAt: 0,
  offset: 0,
  playing: false,
  forceVocal: false, // режим синхронизации: вокал всегда включён
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
    if (this.forceVocal && !sync.active) {
      this.forceVocal = false;
      this.applyMix();
    }
  },

  play(fromOffset) {
    this.stopSources();
    this.stopAt = null;
    // Вокал принудительно звучит только во время разметки; обычный запуск
    // всегда возвращает громкость к той, что выставлена ползунком
    this.forceVocal = sync.active;
    const ctx = this.ensureCtx();
    this.offset = Math.max(0, Math.min(fromOffset ?? this.offset, this.duration));
    // Позиция у самого конца — начинаем сначала, иначе тишина
    if (this.offset >= this.duration - 0.05) this.offset = 0;

    this.vocalGain = ctx.createGain();
    this.instGain = ctx.createGain();
    const fade = ctx.createGain();
    this.eqChain = buildEqChain(ctx);
    const limiter = makeLimiter(ctx);
    this.vocalGain.connect(this.eqChain.input);
    this.instGain.connect(this.eqChain.input);
    this.eqChain.output.connect(limiter);
    limiter.connect(fade);
    fade.connect(ctx.destination);
    this.applyMix();

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

  applyMix() {
    if (!this.vocalGain) return;
    const hasInst = !!state.instrumentalBuffer;
    const v = this.forceVocal || !hasInst ? 1 : state.vocalMix;
    this.vocalGain.gain.value = v;
    this.instGain.gain.value = hasInst ? 1 - v : 0;
  },
};

/* ---------- Приглушение вокала ----------
   Классика жанра: голос обычно в центре стерео-картины,
   поэтому разность каналов (L − R) почти не содержит вокала.
   Чтобы не потерять бас и бочку (они тоже в центре),
   добавляем обратно низкие частоты моно-сигнала. */
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

  // Разность каналов: L·0.7 + R·(−0.7)
  const side = ctx.createGain();
  const l = ctx.createGain(); l.gain.value = 0.7;
  const r = ctx.createGain(); r.gain.value = -0.7;
  split.connect(l, 0); split.connect(r, 1);
  l.connect(side); r.connect(side);

  // Низ из моно-суммы, чтобы вернуть бас
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 170;
  // Без резонанса на частоте среза: по умолчанию фильтр её подчёркивает
  // и долго звенит, из-за чего начало трека звучит грязно
  lowpass.Q.value = 0.707;
  const ml = ctx.createGain(); ml.gain.value = 0.5;
  const mr = ctx.createGain(); mr.gain.value = 0.5;
  split.connect(ml, 0); split.connect(mr, 1);
  ml.connect(lowpass); mr.connect(lowpass);

  const merge = ctx.createChannelMerger(2);
  side.connect(merge, 0, 0); side.connect(merge, 0, 1);
  lowpass.connect(merge, 0, 0); lowpass.connect(merge, 0, 1);
  merge.connect(ctx.destination);

  src.start();
  const rendered = await ctx.startRendering();

  // Отрезаем разгон фильтра
  const trimmed = ctx.createBuffer(2, buffer.length, buffer.sampleRate);
  for (let c = 0; c < 2; c++) {
    trimmed.copyToChannel(
      rendered.getChannelData(c).subarray(PREROLL, PREROLL + buffer.length), c);
  }
  return normalizeInstrumental(trimmed, buffer);
}

/* Сумма «разность каналов + бас» может вылезать за 1.0 — на выходе это
   слышно как хрип и треск. Подгоняем громкость минусовки под оригинал
   и следим, чтобы пики не превышали 0.95. */
function normalizeInstrumental(inst, original) {
  const rmsOf = (buf) => {
    let sum = 0, n = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i += 97) { sum += d[i] * d[i]; n++; }
    }
    return Math.sqrt(sum / n) || 1e-6;
  };
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

  let gain = Math.min(rmsOf(original) / rmsOf(inst), 4);
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

/* ---------- Сохранение проекта (текст, разметка, фон) ---------- */
function saveProject() {
  // Пока строки ещё не разобраны (например, сразу после загрузки файла),
  // не затираем уже сохранённую разметку этой же песни
  const prev = loadProject();
  const keepPrev = prev && prev.name === state.fileName;
  const data = {
    name: state.fileName,
    lyrics: $('lyrics-input').value || (keepPrev && prev.lyrics) || '',
    times: state.lines.length ? state.lines.map((l) => l.time)
      : (keepPrev && prev.times) || [],
    ends: state.lines.length ? state.lines.map((l) => l.end ?? null)
      : (keepPrev && prev.ends) || [],
    // Ручная разметка слов: [{text, time, end}] или null для строк без неё
    words: state.lines.length ? state.lines.map((l) => l.words || null)
      : (keepPrev && prev.words) || [],
    // Строки, чьё время нейросеть подобрала на глазок при подгонке текста
    guess: state.lines.length ? state.lines.map((l) => !!l.сомнительная)
      : (keepPrev && prev.guess) || [],
    bg: state.bgImage,
    eq: { ...state.eq },
    style: { ...state.style },
  };
  try {
    localStorage.setItem('karaoke-project', JSON.stringify(data));
  } catch (e) {
    // Скорее всего не влезла картинка — сохраняем хотя бы текст и разметку
    try {
      delete data.bg;
      localStorage.setItem('karaoke-project', JSON.stringify(data));
    } catch (e2) { /* localStorage недоступен */ }
  }
}

function loadProject() {
  try {
    return JSON.parse(localStorage.getItem('karaoke-project'));
  } catch (e) { return null; }
}

/* ---------- Навигация по шагам ---------- */
function goToStep(n) {
  // Караоке готово — редактор тоже становится доступен
  state.maxStep = Math.max(state.maxStep, n === 4 ? 5 : n);
  document.querySelectorAll('.step-tab').forEach((tab) => {
    const step = +tab.dataset.step;
    tab.classList.toggle('active', step === n);
    tab.disabled = step > state.maxStep;
  });
  document.querySelectorAll('.step-panel').forEach((p) => p.classList.remove('active'));
  $(`step-${n}`).classList.add('active');

  stopSync();
  if (wordTap.active) finishWordTap(false);
  // Смена шага гасит режим принудительного вокала: иначе он остаётся
  // от недослушанной строки и ползунок в караоке будто не действует
  if (!sync.active && audio.forceVocal) {
    audio.forceVocal = false;
    audio.applyMix();
  }
  if (n !== 4 && n !== 5) { audio.pause(); updatePlayerUI(); }
  if (n === 4) openEditor();
  if (n === 5) renderStage();
}

document.querySelectorAll('.step-tab').forEach((tab) => {
  tab.addEventListener('click', () => goToStep(+tab.dataset.step));
});

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
      if (saved.eq) {
        state.eq = { low: +saved.eq.low || 0, mid: +saved.eq.mid || 0, high: +saved.eq.high || 0 };
        updateEqUI();
      }
      if (saved.style) {
        state.style = { ...defaultStyle(), ...saved.style };
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

$('btn-to-sync').addEventListener('click', () => {
  const raw = $('lyrics-input').value;
  const texts = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!texts.length) {
    alert('Сначала вставь текст песни — хотя бы пару строк.');
    return;
  }

  // Сохраняем старую разметку, если текст не менялся
  const sameText = state.lines.length === texts.length &&
    state.lines.every((l, i) => l.text === texts[i]);
  if (!sameText) {
    const saved = loadProject();
    const mine = saved && saved.name === state.fileName ? saved : null;
    const savedTimes = mine ? mine.times : null;
    const savedWords = mine && mine.words && mine.words.length === texts.length ? mine.words : null;
    state.lines = texts.map((text, i) => {
      const line = {
        text,
        time: savedTimes && savedTimes.length === texts.length ? savedTimes[i] : null,
        end: mine && mine.ends && mine.ends.length === texts.length ? mine.ends[i] : null,
      };
      // Метки слов годятся, пока число слов в строке то же самое:
      // поправленную орфографию переживают, переписанную строку — нет
      const w = savedWords ? savedWords[i] : null;
      const chunks = splitWords(text);
      if (w && w.length && w.length === chunks.length) {
        line.words = w.map((x, k) => ({ ...x, text: chunks[k] }));
      }
      // Пометка «время подобрано на глазок» переживает перезагрузку
      if (mine && mine.guess && mine.guess.length === texts.length) {
        line.сомнительная = !!mine.guess[i];
      }
      return line;
    });
  }

  applyRecognized(state.lines);
  saveProject();
  updateWordExportBtn();
  renderSyncList();
  updateSyncButtons();
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
    line.сомнительная = !!r.сомнительная;
    if (r.words && r.words.length) line.words = r.words.map((w) => ({ ...w }));
  });
  window.__asrLines = null;
}

/* ============================================================
   Шаг 3 — синхронизация
   ============================================================ */
const sync = { active: false, index: 0, selected: 0, raf: null };

function renderSyncList() {
  const ul = $('sync-list');
  ul.innerHTML = '';
  state.lines.forEach((line, i) => {
    const li = document.createElement('li');
    li.className = line.time != null ? 'done' : 'pending';
    if (sync.active && i === sync.index) li.classList.add('next');
    if (!sync.active && i === sync.selected) li.classList.add('next');
    const ts = document.createElement('span');
    ts.className = 'ts' + (line.time == null ? ' empty' : '');
    ts.textContent = line.time == null ? '–:––' : fmtTime(line.time);
    const text = document.createElement('span');
    text.className = 'line-text';
    text.textContent = line.text;
    li.append(ts, text);

    /* Строка, которую нейросеть не расслышала при подгонке текста:
       время у неё подобрано на глазок. Тихая пометка, чтобы человек
       знал, где именно стоит послушать и подвинуть. */
    if (line.сомнительная) {
      const mark = document.createElement('span');
      mark.className = 'guess-mark';
      mark.textContent = '≈';
      mark.title = 'Нейросеть почти не расслышала эту строку — время подобрано ' +
        'приблизительно. Послушай и поправь кнопками сдвига.';
      li.insertBefore(mark, text);
    }

    if (!sync.active) {
      const resume = document.createElement('button');
      resume.className = 'nudge-btn';
      resume.textContent = 'Продолжить отсюда';
      resume.title = 'Стереть метки с этой строки и продолжить синхронизацию';
      resume.dataset.resume = i;
      li.appendChild(resume);
    }

    // Кнопки прослушивания и точной подстройки — только для отмеченных строк
    if (line.time != null && !sync.active) {
      const play = document.createElement('button');
      play.className = 'nudge-btn line-play';
      play.textContent = '▶';
      play.title = 'Прослушать эту строку';
      play.dataset.play = i;
      li.insertBefore(play, ts);

      const nudge = document.createElement('span');
      nudge.className = 'nudge';
      [[-1, '−1'], [-0.1, '−0,1'], [0.1, '+0,1'], [1, '+1']].forEach(([delta, label]) => {
        const b = document.createElement('button');
        b.className = 'nudge-btn';
        b.textContent = label;
        b.title = `Сдвинуть начало строки на ${label} с`;
        b.dataset.i = i;
        b.dataset.delta = delta;
        nudge.appendChild(b);
      });
      li.appendChild(nudge);
    }
    ul.appendChild(li);
  });
  const anyDone = state.lines.some((l) => l.time != null);
  $('shift-all').classList.toggle('hidden', sync.active || !anyDone);
}

/* Сдвиг одной строки с сохранением порядка: не раньше предыдущей
   и не позже следующей */
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
}

function nudgeLineEnd(i, delta) {
  const line = state.lines[i];
  if (!line || line.time == null) return;
  setLineEnd(i, (line.end ?? lineEnd(syncedLines(), syncedLines().indexOf(line))) + delta);
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

/* Обновить отображение таймингов во всех списках */
function refreshTimes() {
  renderSyncList();
  document.querySelectorAll('#edit-list .ts').forEach((el) => {
    const line = state.lines[+el.dataset.tsI];
    if (line) el.textContent = line.time == null ? '–:––' : fmtTime(line.time);
  });
}

$('sync-list').addEventListener('click', (e) => {
  const resume = e.target.closest('[data-resume]');
  if (resume) {
    sync.selected = +resume.dataset.resume;
    renderSyncList();
    $('btn-sync-start').textContent = `▶ Продолжить с ${sync.selected + 1}-й строки`;
    return;
  }
  const playBtn = e.target.closest('[data-play]');
  if (playBtn) { playLine(+playBtn.dataset.play); return; }
  const btn = e.target.closest('.nudge-btn');
  if (btn) nudgeLine(+btn.dataset.i, +btn.dataset.delta);
});

$('shift-all').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-shift]');
  if (btn) shiftAllLines(+btn.dataset.shift);
});

function updateSyncButtons() {
  const allDone = state.lines.length > 0 && state.lines.every((l) => l.time != null);
  $('btn-to-player').disabled = !allDone;
}

function startSync(from = sync.selected) {
  if (typeof from !== 'number') from = sync.selected;
  from = Math.max(0, Math.min(from, state.lines.length - 1));
  const resumeAt = state.lines[from].time;
  // Всё до выбранной строки оставляем нетронутым. Выбранная и последующие
  // метки будут записаны заново, поэтому ошибку не нужно переделывать с нуля.
  state.lines.slice(from).forEach((l) => { l.time = null; l.end = null; l.сомнительная = false; });
  sync.active = true;
  sync.index = from;
  sync.selected = from;
  audio.forceVocal = true;
  audio.applyMix();
  const prev = from > 0 ? state.lines[from - 1].time : 0;
  audio.play(Math.max(0, (resumeAt ?? prev ?? 0) - 1));
  audio.onEnded = finishSync;

  $('btn-sync-start').classList.add('hidden');
  $('btn-sync-stop').classList.remove('hidden');
  $('tap-button').classList.remove('hidden');
  $('tap-next').textContent = `Дальше: «${state.lines[from].text}»`;
  renderSyncList();
  updateSyncButtons();
  // Если начали не с первой строки, список сам к ней не прокрутится
  scrollSyncListTo(from);
  tickSync();
}

/* Прокручиваем только сам список, не страницу.
   scrollIntoView двигает все контейнеры сразу, и при отметке строк
   разметка уезжает вверх — кнопка «Отметить» пропадает с экрана. */
function scrollSyncListTo(index) {
  const list = $('sync-list');
  const li = list.children[index];
  if (!li) return;
  const listBox = list.getBoundingClientRect();
  const liBox = li.getBoundingClientRect();
  const delta = (liBox.top + liBox.height / 2) - (listBox.top + listBox.height / 2);
  list.scrollTop = Math.max(0, list.scrollTop + delta);
}

function tickSync() {
  setText('sync-time', fmtTime(audio.position()));
  if (sync.active) sync.raf = requestAnimationFrame(tickSync);
}

function tapLine() {
  if (!sync.active || sync.index >= state.lines.length) return;
  state.lines[sync.index].time = audio.position();
  state.lines[sync.index].сомнительная = false;
  sync.index++;
  if (sync.index >= state.lines.length) {
    finishSync();
  } else {
    $('tap-next').textContent = `Дальше: «${state.lines[sync.index].text}»`;
    renderSyncList();
    scrollSyncListTo(sync.index);
  }
}

function finishSync() {
  sync.active = false;
  cancelAnimationFrame(sync.raf);
  audio.forceVocal = false;
  audio.pause();
  audio.offset = 0;
  audio.applyMix();
  sync.selected = Math.min(sync.index, Math.max(0, state.lines.length - 1));
  $('btn-sync-start').classList.remove('hidden');
  $('btn-sync-start').textContent = '▶ Продолжить';
  $('btn-sync-stop').classList.add('hidden');
  $('tap-button').classList.add('hidden');
  renderSyncList();
  updateSyncButtons();
  saveProject();
}

function stopSync() {
  if (sync.active) finishSync();
}

$('btn-sync-start').addEventListener('click', startSync);
$('btn-sync-stop').addEventListener('click', finishSync);
$('btn-sync-reset').addEventListener('click', () => {
  sync.selected = 0;
  state.lines.forEach((l) => { l.time = null; l.end = null; l.сомнительная = false; });
  saveProject();
  renderSyncList();
  updateSyncButtons();
  $('btn-sync-start').textContent = '▶ Начать';
});
$('tap-button').addEventListener('click', tapLine);
$('btn-back-2').addEventListener('click', () => goToStep(2));
$('btn-to-player').addEventListener('click', () => goToStep(4));

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
    if (pos >= lines[i].time) idx = i; else break;
  }
  return idx;
}

/* Если конец задан в редакторе, он всегда важнее эвристики. Иначе используем
   следующую строку или короткую длительность по умолчанию. */
const BREAK_GAP = 6;
const SING_DUR = 4;

function lineEnd(lines, index) {
  const line = lines[index];
  const next = index + 1 < lines.length ? lines[index + 1].time : null;
  const limit = next != null ? next - 0.02 : audio.duration;
  if (line.end != null) return Math.max(line.time + 0.05, Math.min(line.end, limit));
  return next != null && next - line.time <= BREAK_GAP
    ? next : Math.min(line.time + SING_DUR, limit);
}

function stagePhase(pos) {
  const lines = syncedLines();
  if (!lines.length) return { mode: 'empty', cur: -1 };
  const cur = currentLineIndex(pos);

  if (cur === -1) {
    // Вступление до первой строки
    if (lines[0].time >= BREAK_GAP) {
      return { mode: 'break', cur, start: 0, until: lines[0].time };
    }
    return { mode: 'intro', cur };
  }

  const start = lines[cur].time;
  const end = lineEnd(lines, cur);
  const next = cur + 1 < lines.length ? lines[cur + 1].time : null;
  if (next != null && end < next - 0.02 && pos >= end) {
    return { mode: 'break', cur, start: end, until: next };
  }
  return { mode: 'line', cur, start, end };
}

/* ---------- Отсчёт перед вступлением строки ----------
   Три точки гаснут по одной за COUNT_LEAD секунд до начала строки.
   Показываем только там, где перед строкой действительно есть пауза:
   после проигрыша и перед самым первым куплетом. */
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
  else if (ph.mode === 'intro') { next = lines[0].time; from = 0; }
  else return null;
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

function lineWords(line, start, end) {
  if (line.words && line.words.length) {
    return line.words.map((w, i, arr) => ({
      text: w.text,
      start: w.time,
      end: w.end != null ? w.end : (i + 1 < arr.length ? arr[i + 1].time : end),
    }));
  }

  const chunks = splitWords(line.text);
  if (!chunks.length) return [];
  // Вес слова — число букв без пробелов, минимум единица
  const weights = chunks.map((c) => Math.max(1, c.trim().length));
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(0.05, end - start);
  const out = [];
  let acc = start;
  for (let i = 0; i < chunks.length; i++) {
    const dur = span * (weights[i] / total);
    out.push({ text: chunks[i], start: acc, end: acc + dur });
    acc += dur;
  }
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
  for (const chunk of splitWords(text)) {
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = chunk;
    div.appendChild(span);
  }
  if (!div.children.length) div.textContent = text;
  return div;
}

function applyWordFill(el, line, start, end, pos) {
  const words = lineWords(line, start, end);
  const done = wordProgress(words, pos);
  const spans = el.querySelectorAll('.w');
  for (let i = 0; i < spans.length; i++) {
    const p = done[i] != null ? done[i] : 0;
    spans[i].style.setProperty('--wfill', `${(p * 100).toFixed(1)}%`);
    spans[i].classList.toggle('sung', p >= 0.5);
  }
}

const BREAK_TEXT = '♪ ♪ ♪';

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
    if (it.top != null) el.style.top = `${it.top}%`;
    else el.style.removeProperty('top');
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

/* Ширина самого текста строки, а не её коробки.
   Мерить коробку (scrollWidth) нельзя: она никогда не бывает уже сцены.
   У строки на закреплённом месте коробка вообще шире полей — абсолютный
   элемент считает свои left/right от области с полями родителя, а не от
   текста, — из-за чего строки ужимались до предела на ровном месте.
   Слова лежат в отдельных span'ах, поэтому берём охват их прямоугольников:
   для строки в одну строку это ровно ширина текста, а для переносимой
   (превью редактора) — ширина самой длинной её части. */
function lineTextWidth(el) {
  const spans = el.querySelectorAll('.w');
  if (!spans.length) return el.scrollWidth;
  let left = Infinity;
  let right = -Infinity;
  spans.forEach((s) => {
    const r = s.getBoundingClientRect();
    if (!r.width && !r.height) return;   // пустой span ширины не даёт
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  });
  return right > left ? right - left : 0;
}

/* Строки не переносятся — если строка шире сцены,
   уменьшаем её шрифт так, чтобы она поместилась целиком */
function fitStageLines(container) {
  const cs = getComputedStyle(container);
  const avail = container.clientWidth
    - parseFloat(cs.paddingLeft)
    - parseFloat(cs.paddingRight);
  if (avail <= 0) return;
  container.querySelectorAll('.stage-line').forEach((el) => {
    el.style.fontSize = '';
    // Несколько проходов: ширина текста меняется не строго пропорционально
    // размеру шрифта (округления, кернинг), поэтому результат уточняем.
    // Полпикселя запаса — чтобы не ужимать строку из-за округлений.
    for (let pass = 0; pass < 3; pass++) {
      const w = lineTextWidth(el);
      if (w <= avail + 0.5) break;
      const cur = parseFloat(getComputedStyle(el).fontSize);
      const next = Math.max(10, cur * (avail / w) * 0.99);
      el.style.fontSize = `${next}px`;
      if (next <= 10) break;
    }
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

  for (const slot of [0, 1]) {
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
      top: activeSlot === 0 ? s.posCurrent : s.posNext,
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
  const start = ph.start;
  const end = ph.mode === 'break' ? ph.until : ph.end;

  if (ph.mode === 'break') {
    // Ноты — три «слова»: закрашиваем их по ходу проигрыша
    const p = end > start ? Math.min(1, Math.max(0, (pos - start) / (end - start))) : 1;
    const spans = el.querySelectorAll('.w');
    for (let i = 0; i < spans.length; i++) {
      const share = Math.min(1, Math.max(0, p * spans.length - i));
      spans[i].style.setProperty('--wfill', `${(share * 100).toFixed(1)}%`);
      spans[i].classList.toggle('sung', share >= 0.5);
    }
    return;
  }
  applyWordFill(el, lines[ph.cur], start, end, pos);
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
  if ($('step-4').classList.contains('active') && editor.peaks) {
    setText('edit-time', fmtTime(audio.position()));
    setText('btn-edit-play', audio.playing ? '⏸' : '▶');
    updateEditStage();
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
  stages.forEach((stage, i) => {
    if (!stage) return;
    const baseRem = i === 0 ? 1.15 : 1.0; // редакторская сцена меньше
    stage.style.setProperty('--st-font', (FONTS[s.font] || FONTS.system).css);
    // На узком экране базовый размер меньше, но настройка пользователя
    // по-прежнему действует — она умножается, а не перекрывается
    const narrow = parseFloat(getComputedStyle(stage).getPropertyValue('--st-narrow')) || 1;
    stage.style.setProperty('--st-size', `${baseRem * narrow * s.size / 100}rem`);
    stage.style.setProperty('--st-weight', s.weight);
    stage.style.setProperty('--st-inactive', s.inactive);
    stage.style.setProperty('--st-active', s.active);
    stage.style.setProperty('--st-effect', s.accent);
    stage.style.setProperty('--st-outline-c', s.outlineColor);
    stage.style.setProperty('--st-outline', `${s.outline}px`);
    stage.style.setProperty('--st-ls', `${s.letter}px`);
    stage.style.setProperty('--st-gap', `${(s.line / 10 - 1).toFixed(2)}em`);
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
  // Места строк нужны только когда они закреплены
  $('row-pos-cur').classList.toggle('hidden', s.swapLines);
  $('row-pos-next').classList.toggle('hidden', s.swapLines);
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

$('btn-back-3').addEventListener('click', () => goToStep(4));

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
    '[by:Бэнэнгская Рапсодия]',
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
    const words = lineWords(l, l.time, lineEnd(lines, i));
    const inner = words
      .map((w) => `<${fmtLrcTime(w.start)}>${w.text}`)
      .join('')
      .replace(/\s+$/, '');
    // Метка конца строки — чтобы плеер знал, когда гасить подсветку
    return `[${fmtLrcTime(l.time)}]${inner}<${fmtLrcTime(lineEnd(lines, i))}>`;
  });
  const lrc = [
    `[ti:${name}]`,
    '[by:Бэнэнгская Рапсодия]',
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

$('btn-export-wav').addEventListener('click', () => {
  if (!state.instrumentalBuffer) {
    alert('Для моно-файла минусовку сделать нельзя.');
    return;
  }
  const name = (state.fileName || 'song').replace(/\.[^.]+$/, '');
  download(bufferToWav(state.instrumentalBuffer), `${name} (минус).wav`);
});

/* ============================================================
   Шаг 5 — редактор: текст + предпросмотр + дорожка
   ============================================================ */
const editor = {
  pxPerSec: 40,
  scrollT: 0,
  peaks: null,   // огибающая волны для отрисовки дорожки
  drag: null,    // { index } — какой маркер тащим
  stageKey: '',
};

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
  renderEditList();
  renderEditStage();
  updateWordExportBtn();
  resizeTimeline();
  $('edit-total').textContent = fmtTime(audio.duration);
  drawTimeline();
}

/* --- Список строк с редактированием текста --- */
function renderEditList() {
  const ul = $('edit-list');
  ul.innerHTML = '';
  state.lines.forEach((line, i) => {
    const li = document.createElement('li');
    li.className = 'edit-row';
    li.dataset.row = i;

    const play = document.createElement('button');
    play.className = 'nudge-btn line-play';
    play.textContent = '▶';
    play.title = 'Прослушать эту строку';
    play.dataset.play = i;

    const ts = document.createElement('span');
    ts.className = 'ts' + (line.time == null ? ' empty' : '');
    ts.dataset.tsI = i;
    ts.textContent = line.time == null ? '–:––' : fmtTime(line.time);

    const end = document.createElement('span');
    end.className = 'ts end-ts' + (line.end == null ? ' empty' : '');
    end.textContent = line.time == null ? '–:––' : `до ${fmtTime(lineEnd(syncedLines(), syncedLines().indexOf(line)))}`;

    const text = document.createElement('div');
    text.className = 'edit-text';
    text.contentEditable = 'true';
    text.spellcheck = false;
    text.textContent = line.text;
    text.dataset.textI = i;

    const nudge = document.createElement('span');
    nudge.className = 'nudge';
    [[-1, '−1'], [-0.1, '−0,1'], [0.1, '+0,1'], [1, '+1']].forEach(([delta, label]) => {
      const b = document.createElement('button');
      b.className = 'nudge-btn';
      b.textContent = label;
      b.title = `Сдвинуть начало строки на ${label} с`;
      b.dataset.i = i;
      b.dataset.delta = delta;
      nudge.appendChild(b);
    });

    const endNudge = document.createElement('span');
    endNudge.className = 'nudge end-nudge';
    [[-1, 'конец −1'], [-0.1, '−0,1'], [0.1, '+0,1'], [1, 'конец +1']].forEach(([delta, label]) => {
      const b = document.createElement('button');
      b.className = 'nudge-btn'; b.textContent = label;
      b.title = `Сдвинуть конец строки на ${label} с`;
      b.dataset.endI = i; b.dataset.endDelta = delta;
      endNudge.appendChild(b);
    });

    // Разметка слов: у размеченных строк кнопка светится и рядом появляется сброс
    const marked = hasWords(line);
    const wordsGroup = document.createElement('span');
    wordsGroup.className = 'nudge words-nudge';
    const wordsBtn = document.createElement('button');
    wordsBtn.className = 'nudge-btn words-btn' + (marked ? ' marked' : '');
    wordsBtn.textContent = marked ? '♪ слова ✓' : '♪ слова';
    wordsBtn.title = marked
      ? 'Строка размечена по словам. Нажми, чтобы простучать заново'
      : 'Простучать слова внутри строки';
    wordsBtn.dataset.words = i;
    wordsGroup.appendChild(wordsBtn);
    if (marked) {
      const rst = document.createElement('button');
      rst.className = 'nudge-btn words-reset';
      rst.textContent = '⨯';
      rst.title = 'Вернуть автоматическое деление слов';
      rst.dataset.wordsReset = i;
      wordsGroup.appendChild(rst);
    }

    li.append(play, ts, end, text, nudge, endNudge, wordsGroup);
    ul.appendChild(li);
  });
}

$('edit-list').addEventListener('click', (e) => {
  const playBtn = e.target.closest('[data-play]');
  if (playBtn) { playLine(+playBtn.dataset.play); return; }
  const wordsBtn = e.target.closest('[data-words]');
  if (wordsBtn) { startWordTap(+wordsBtn.dataset.words); return; }
  const wordsReset = e.target.closest('[data-words-reset]');
  if (wordsReset) { resetWords(+wordsReset.dataset.wordsReset); return; }
  const endBtn = e.target.closest('[data-end-i]');
  if (endBtn) { nudgeLineEnd(+endBtn.dataset.endI, +endBtn.dataset.endDelta); renderEditList(); return; }
  const btn = e.target.closest('.nudge-btn');
  if (btn) nudgeLine(+btn.dataset.i, +btn.dataset.delta);
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
    alert('Сначала отметь начало этой строки на шаге «Синхронизация».');
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
  audio.forceVocal = false;
  audio.applyMix();
  $('word-tap').classList.add('hidden');

  if (save && wordTap.marks.length && line) {
    line.words = buildWords(wordTap.chunks, wordTap.marks, wordTap.start, wordTap.end);
    saveProject();
  }
  renderEditList();
  editor.stageKey = '';
  renderEditStage();
  updateWordExportBtn();
  updatePlayerUI();
}

function resetWords(i) {
  const line = state.lines[i];
  if (!line) return;
  delete line.words;
  saveProject();
  renderEditList();
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
      // поэтому просто гасим отметку у этой строки
      const btn = el.closest('.edit-row').querySelector('.words-btn');
      if (btn) { btn.classList.remove('marked'); btn.textContent = '♪ слова'; }
      const rst = el.closest('.edit-row').querySelector('.words-reset');
      if (rst) rst.remove();
      updateWordExportBtn();
    }
  }
  $('lyrics-input').value = state.lines.map((l) => l.text).join('\n');
  saveProject();
  editor.stageKey = ''; // заставляем предпросмотр перерисоваться
});

/* --- Мини-сцена предпросмотра --- */
function renderEditStage() {
  const el = $('edit-stage');
  const lines = syncedLines();
  el.innerHTML = '';
  if (!lines.length) return;
  const pos = audio.position();
  const ph = stagePhase(pos);
  editor.stageKey = `${ph.mode}:${ph.cur}`;
  const cur = ph.cur;

  const items = [];
  if (ph.mode === 'break') {
    if (cur >= 0) items.push([lines[cur].text, '']);
    items.push(['♪ ♪ ♪', 'current break-line']);
    if (cur + 1 < lines.length) items.push([lines[cur + 1].text, 'near']);
  } else if (cur === -1) {
    items.push([lines[0].text, 'near']);
    if (lines[1]) items.push([lines[1].text, '']);
  } else {
    items.push([lines[cur].text, 'current']);
    if (lines[cur + 1]) items.push([lines[cur + 1].text, 'near']);
  }
  for (const [text, cls] of items) {
    // Ноты проигрыша красим посимвольно, обычные строки — по словам
    const div = cls.includes('break-line')
      ? (() => {
          const d = document.createElement('div');
          d.className = 'stage-line ' + cls;
          for (const ch of text) {
            const sp = document.createElement('span');
            sp.textContent = ch;
            d.appendChild(sp);
          }
          return d;
        })()
      : buildLineEl(text, cls);
    el.appendChild(div);
  }

  // Подсветка текущей строки в списке
  const globalIdx = cur >= 0 ? state.lines.indexOf(lines[cur]) : -1;
  document.querySelectorAll('#edit-list .edit-row').forEach((row) => {
    row.classList.toggle('current-row', +row.dataset.row === globalIdx);
  });
}

function updateEditStage() {
  const lines = syncedLines();
  if (!lines.length) return;
  const pos = audio.position();
  const ph = stagePhase(pos);
  if (`${ph.mode}:${ph.cur}` !== editor.stageKey) renderEditStage();
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
  applyWordFill(el, lines[ph.cur], start, end, pos);
}

/* --- Дорожка --- */
function resizeTimeline() {
  const c = $('timeline');
  const w = c.parentElement.clientWidth - 2;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(w * dpr);
  c.height = Math.round(150 * dpr);
  c.style.width = `${w}px`;
  c.style.height = '150px';
}

function timelineDims() {
  const c = $('timeline');
  const dpr = window.devicePixelRatio || 1;
  return { W: c.width / dpr, H: c.height / dpr, dpr };
}

function drawTimeline() {
  if (!editor.peaks) return;
  const c = $('timeline');
  const g = c.getContext('2d');
  const { W, H, dpr } = timelineDims();
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const rulerH = 20;
  const waveH = H - rulerH;
  const viewDur = W / editor.pxPerSec;
  editor.scrollT = Math.min(Math.max(0, editor.scrollT), Math.max(0, audio.duration - viewDur));

  g.fillStyle = '#0e0e15';
  g.fillRect(0, 0, W, H);

  // Волна
  const { mins, maxs, bucketDur } = editor.peaks;
  g.fillStyle = 'rgba(45, 212, 191, 0.5)';
  const mid = rulerH + waveH / 2;
  for (let x = 0; x < W; x++) {
    const t0 = editor.scrollT + x / editor.pxPerSec;
    const b0 = Math.floor(t0 / bucketDur);
    if (b0 >= maxs.length) break;
    const b1 = Math.min(maxs.length - 1, Math.floor((t0 + 1 / editor.pxPerSec) / bucketDur));
    let mn = 1, mx = -1;
    for (let b = b0; b <= b1; b++) {
      if (mins[b] < mn) mn = mins[b];
      if (maxs[b] > mx) mx = maxs[b];
    }
    const y0 = mid + mn * (waveH / 2) * 0.92;
    const y1 = mid + mx * (waveH / 2) * 0.92;
    g.fillRect(x, Math.min(y0, y1), 1, Math.max(1, Math.abs(y1 - y0)));
  }

  // Линейка времени
  const step = editor.pxPerSec >= 60 ? 1 : editor.pxPerSec >= 25 ? 2 : editor.pxPerSec >= 12 ? 5 : 10;
  g.fillStyle = '#9a9ab0';
  g.font = '10px sans-serif';
  g.textAlign = 'left';
  for (let t = Math.ceil(editor.scrollT / step) * step; t <= editor.scrollT + viewDur; t += step) {
    const x = (t - editor.scrollT) * editor.pxPerSec;
    g.fillRect(x, 0, 1, 5);
    g.fillText(fmtTime(t), x + 3, 12);
  }

  // Маркеры строк
  g.font = '10px sans-serif';
  state.lines.forEach((line, i) => {
    if (line.time == null) return;
    const x = (line.time - editor.scrollT) * editor.pxPerSec;
    if (x < -60 || x > W + 60) return;
    const active = editor.drag && editor.drag.index === i;
    g.fillStyle = active ? '#84cc16' : '#10b981';
    g.fillRect(x - 1, rulerH, 2, waveH);
    g.fillStyle = active ? '#d9f99d' : 'rgba(52, 211, 153, 0.9)';
    const label = line.text.length > 14 ? line.text.slice(0, 14) + '…' : line.text;
    g.fillText(label, x + 4, rulerH + 12);
  });

  // Курсор воспроизведения
  const px = (audio.position() - editor.scrollT) * editor.pxPerSec;
  if (px >= 0 && px <= W) {
    g.fillStyle = '#f2f2f7';
    g.fillRect(px - 1, 0, 2, H);
  }
}

function timelineHitMarker(x) {
  let best = null, bestDist = 7;
  state.lines.forEach((line, i) => {
    if (line.time == null) return;
    const mx = (line.time - editor.scrollT) * editor.pxPerSec;
    const dist = Math.abs(mx - x);
    if (dist < bestDist) { best = i; bestDist = dist; }
  });
  return best;
}

const tl = $('timeline');

tl.addEventListener('pointerdown', (e) => {
  const rect = tl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const idx = timelineHitMarker(x);
  if (idx != null) {
    editor.drag = { index: idx };
    try { tl.setPointerCapture(e.pointerId); } catch (err) { /* необязательно */ }
  } else {
    const t = editor.scrollT + x / editor.pxPerSec;
    if (audio.playing) audio.play(t);
    else audio.offset = Math.min(Math.max(0, t), audio.duration);
    renderEditStage();
  }
  drawTimeline();
});

tl.addEventListener('pointermove', (e) => {
  const rect = tl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (editor.drag) {
    setLineTime(editor.drag.index, editor.scrollT + x / editor.pxPerSec);
    refreshTimes();
    drawTimeline();
  } else {
    tl.style.cursor = timelineHitMarker(x) != null ? 'ew-resize' : 'pointer';
  }
});

tl.addEventListener('pointerup', () => {
  if (editor.drag) {
    editor.drag = null;
    saveProject();
    renderEditStage();
    drawTimeline();
  }
});

tl.addEventListener('wheel', (e) => {
  e.preventDefault();
  editor.scrollT += (e.deltaX + e.deltaY) / editor.pxPerSec;
  drawTimeline();
}, { passive: false });

function zoomTimeline(factor) {
  const { W } = timelineDims();
  const center = editor.scrollT + W / editor.pxPerSec / 2;
  editor.pxPerSec = Math.min(200, Math.max(8, editor.pxPerSec * factor));
  editor.scrollT = center - W / editor.pxPerSec / 2;
  drawTimeline();
}
$('tl-zoom-in').addEventListener('click', () => zoomTimeline(1.5));
$('tl-zoom-out').addEventListener('click', () => zoomTimeline(1 / 1.5));

$('btn-edit-play').addEventListener('click', () => {
  if (audio.playing) audio.pause();
  else audio.play();
});

$('btn-back-4').addEventListener('click', () => goToStep(3));
$('btn-editor-next').addEventListener('click', () => goToStep(5));

window.addEventListener('resize', () => {
  if ($('step-4').classList.contains('active')) {
    resizeTimeline();
    drawTimeline();
    fitStageLines($('edit-stage'));
  }
  if ($('step-5').classList.contains('active')) {
    fitStageLines($('lyrics-stage'));
    placeCountdown($('lyrics-stage')); // раскладка поехала — точки тоже
  }
});

/* Держим курсор в кадре во время воспроизведения */
function followPlayhead() {
  if (!audio.playing) return;
  const { W } = timelineDims();
  const viewDur = W / editor.pxPerSec;
  const pos = audio.position();
  if (pos > editor.scrollT + viewDur * 0.85 || pos < editor.scrollT) {
    editor.scrollT = Math.max(0, pos - viewDur * 0.15);
  }
}

/* ---------- Экспорт видео для YouTube ----------
   Рисуем караоке на canvas 1280×720, звук ведём в MediaStream,
   пишем всё вместе через MediaRecorder. Запись в реальном времени. */
const videoExport = { active: false, cancelled: false };

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

  // Собираем блоки: все строки одного кадра получают один размер. Иначе
  // длинная фраза визуально «проваливается» относительно остальных.
  const baseSize = Math.round(40 * st.size / 100);
  const rawBlocks = [];
  // index — номер строки: без него подсветка по словам не включалась
  const pushText = (text, isCur, index = null, isNear = false) => {
    g2d.font = font(baseSize);
    const w = g2d.measureText(text).width;
    rawBlocks.push({ text, width: w, isCur, index, isNear });
  };
  const total = st.lines;
  const before = Math.min(2, Math.floor((total - 1) / 2));
  if (ph.mode === 'break') {
    for (let i = Math.max(0, cur - before + 1); i <= cur; i++) pushText(lines[i].text, false);
    pushText('♪   ♪   ♪', true);
    for (let i = cur + 1; i < Math.min(lines.length, cur + total - before); i++) {
      pushText(lines[i].text, false, i, i === cur + 1);
    }
  } else {
    const anchor = cur === -1 ? 0 : cur;
    const first = Math.max(0, anchor - before);
    for (let i = first; i < Math.min(lines.length, first + total); i++) {
      pushText(lines[i].text, i === cur, i, i === cur + 1 || (cur === -1 && i === 0));
    }
  }

  const fittedSize = rawBlocks.reduce((size, b) =>
    Math.min(size, b.width > maxWidth ? baseSize * maxWidth / b.width : baseSize), baseSize);
  const blocks = rawBlocks.map((b) => ({ ...b, size: Math.max(14, fittedSize) }));

  /* Рисуем строку по словам: целые слова закрашены, текущее доезжает.
     Это то же поведение, что на экране, чтобы видео совпадало с ним. */
  const drawWords = (line, text, size, cy, ph2) => {
    g2d.font = font(size);
    const words = line ? lineWords(line, ph2.start, ph2.mode === 'break' ? ph2.until : ph2.end) : null;
    const widths = words ? words.map((w) => g2d.measureText(w.text).width) : null;
    const totalW = widths ? widths.reduce((a, b) => a + b, 0) : g2d.measureText(text).width;
    let x = (W - totalW) / 2;

    if (!words) {
      g2d.fillStyle = st.active;
      g2d.fillText(text, W / 2, cy);
      return;
    }
    const done = wordProgress(words, pos);
    g2d.textAlign = 'left';
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const wWidth = widths[i];
      if (st.outline > 0) {
        g2d.lineWidth = st.outline * 2;
        g2d.strokeStyle = st.outlineColor;
        g2d.lineJoin = 'round';
        g2d.strokeText(w.text, x, cy);
      }
      if (st.effect === 'fill') {
        g2d.fillStyle = st.active;
        g2d.fillText(w.text, x, cy);
        const p = done[i];
        if (p > 0) {
          g2d.save();
          g2d.beginPath();
          g2d.rect(x, cy - size, wWidth * p, size * 2);
          g2d.clip();
          g2d.fillStyle = st.accent;
          g2d.fillText(w.text, x, cy);
          g2d.restore();
        }
      } else {
        g2d.fillStyle = (st.effect === 'highlight' && done[i] >= 0.5) ? st.accent : st.active;
        g2d.fillText(w.text, x, cy);
      }
      x += wWidth;
    }
    g2d.textAlign = 'center';
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
    const r = Math.max(4, baseSize * 0.2);
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

  /* Закреплённые места: две строки рисуются каждая на своей высоте
     и не съезжают. Активна та, чья очередь петь. */
  if (!st.swapLines) {
    const drawAt = (text, topPercent, kind, line) => {
      g2d.font = font(baseSize);
      let size = baseSize;
      const w = g2d.measureText(text).width;
      if (w > maxWidth) size = Math.max(14, baseSize * maxWidth / w);
      g2d.font = font(size);
      g2d.letterSpacing = `${st.letter}px`;
      const cy = H * (topPercent / 100);
      setDim(kind);
      if (kind === 'cur' && line) {
        drawWords(line, text, size, cy, ph);
      } else if (kind === 'cur') {
        strokeIfNeeded(text, W / 2, cy);
        const start = ph.start;
        const end = ph.mode === 'break' ? ph.until : ph.end;
        const p = end > start ? Math.min(1, Math.max(0, (pos - start) / (end - start))) : 1;
        g2d.fillStyle = st.active;
        g2d.fillText(text, W / 2, cy);
        const textW = g2d.measureText(text).width;
        g2d.save();
        g2d.beginPath();
        g2d.rect((W - textW) / 2, cy - size, textW * p, size * 2);
        g2d.clip();
        g2d.fillStyle = st.accent;
        g2d.fillText(text, W / 2, cy);
        g2d.restore();
      } else {
        strokeIfNeeded(text, W / 2, cy);
        g2d.fillStyle = kind === 'near' ? st.active : st.inactive;
        g2d.fillText(text, W / 2, cy);
      }
      clearDim();
    };

    const activeSlot = cur < 0 ? 0 : cur % 2;
    const nextIndex = cur < 0 ? 0 : cur + 1;
    for (const slot of [0, 1]) {
      const top = slot === 0 ? st.posCurrent : st.posNext;
      let index;
      let kind = 'off';
      if (cur < 0) index = slot === 0 ? 0 : 1;
      else if (slot === activeSlot) { index = cur; if (ph.mode !== 'break') kind = 'cur'; }
      else index = nextIndex;
      if (index >= lines.length) continue;
      if (kind !== 'cur' && index === nextIndex) kind = 'near';
      drawAt(lines[index].text, top, kind, kind === 'cur' ? lines[index] : null);
    }
    const breakTop = activeSlot === 0 ? st.posCurrent : st.posNext;
    // Пока идёт отсчёт, точки занимают место нот проигрыша
    if (ph.mode === 'break' && !cd) drawAt('♪   ♪   ♪', breakTop, 'cur');
    if (cd) {
      drawCountdown(ph.mode === 'break'
        ? H * (breakTop / 100)
        : H * (st.posCurrent / 100) - baseSize * 0.9);
    }
    g2d.letterSpacing = '0px';
    if (watermark) {
      const size = Math.round(H * 0.09);
      const margin = Math.round(H * 0.03);
      g2d.save();
      g2d.globalAlpha = 0.75;
      g2d.drawImage(watermark, W - size - margin, H - size - margin, size, size);
      g2d.restore();
    }
    return;
  }

  const lineGap = st.line / 10;
  const blockGap = Math.round(baseSize * 0.35);
  const totalH = blocks.reduce((sum, b) => sum + b.size * lineGap + blockGap, -blockGap);
  const pad = 40;
  let y = st.valign === 'flex-start' ? pad
    : st.valign === 'flex-end' ? H - pad - totalH
    : H / 2 - totalH / 2;

  let countCy = null;
  for (const b of blocks) {
    g2d.font = font(b.size);
    g2d.letterSpacing = `${st.letter}px`;
    const rowH = b.size * lineGap;
    const cy = y + rowH / 2;
    const isBreak = b.isCur && b.index == null && ph.mode === 'break';
    // Отсчёт встаёт на место нот проигрыша, а до первого куплета — над строкой
    if (cd && (isBreak || (countCy == null && b.isNear))) countCy = isBreak ? cy : cy - rowH * 0.85;
    setDim(b.isCur ? 'cur' : b.isNear ? 'near' : 'off');
    if (isBreak && cd) {
      // ноты скрыты — вместо них отсчёт
    } else if (b.isCur && b.index != null && ph.mode !== 'break') {
      drawWords(lines[b.index], b.text, b.size, cy, ph);
    } else if (b.isCur) {
      strokeIfNeeded(b.text, W / 2, cy);
      const start = ph.start;
      const end = ph.mode === 'break' ? ph.until : ph.end;
      const p = end > start ? Math.min(1, Math.max(0, (pos - start) / (end - start))) : 1;
      g2d.fillStyle = st.active;
      g2d.fillText(b.text, W / 2, cy);
      const textW = g2d.measureText(b.text).width;
      g2d.save();
      g2d.beginPath();
      g2d.rect((W - textW) / 2, y - 4, textW * p, rowH + 8);
      g2d.clip();
      g2d.fillStyle = st.accent;
      g2d.fillText(b.text, W / 2, cy);
      g2d.restore();
    } else {
      strokeIfNeeded(b.text, W / 2, cy);
      g2d.fillStyle = b.isNear ? st.active : st.inactive;
      g2d.fillText(b.text, W / 2, cy);
    }
    clearDim();
    y += rowH + blockGap;
  }
  g2d.letterSpacing = '0px';
  if (cd) drawCountdown(countCy != null ? countCy : H / 2);

  // Логотип в правом нижнем углу — размер от высоты кадра,
  // чтобы одинаково смотрелся и в HD, и в 2K
  if (watermark) {
    const size = Math.round(H * 0.09);
    const margin = Math.round(H * 0.03);
    g2d.save();
    g2d.globalAlpha = 0.75;
    g2d.drawImage(watermark, W - size - margin, H - size - margin, size, size);
    g2d.restore();
  }
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

  // Звук: та же смесь, что в плеере, но в MediaStream вместо колонок
  const ctx = audio.ensureCtx();
  const dest = ctx.createMediaStreamDestination();
  const eq = buildEqChain(ctx);
  const limiter = makeLimiter(ctx);
  eq.output.connect(limiter);
  limiter.connect(dest);
  const vGain = ctx.createGain();
  const iGain = ctx.createGain();
  vGain.connect(eq.input);
  iGain.connect(eq.input);
  const hasInst = !!state.instrumentalBuffer;
  vGain.gain.value = hasInst ? state.vocalMix : 1;
  iGain.gain.value = hasInst ? 1 - state.vocalMix : 0;

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
  if (wordTap.active) {
    if (e.code === 'Space') { e.preventDefault(); tapWord(); return; }
    if (e.code === 'Escape') { e.preventDefault(); finishWordTap(false); return; }
    if (e.code === 'Enter') { e.preventDefault(); finishWordTap(true); return; }
  }
  if (e.code !== 'Space') return;
  const active = document.activeElement;
  const tag = active && active.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'BUTTON' || (active && active.isContentEditable)) {
    if (!sync.active) return;
  }
  if (sync.active) {
    e.preventDefault();
    tapLine();
  } else if (($('step-4').classList.contains('active') || $('step-5').classList.contains('active'))
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
const NEWS_VERSION = '1.7.0';
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

/* ---------- Восстановление текста при загрузке страницы ---------- */
(function init() {
  const saved = loadProject();
  if (saved && saved.lyrics) $('lyrics-input').value = saved.lyrics;
  if (saved && saved.style) state.style = { ...defaultStyle(), ...saved.style };
  updateStyleUI();
  applyStyle();
  updateInstUI();
  tickPlayer(); // общий цикл обновления UI (лёгкий, обновляет только видимое)

  // Проверяем обновления при запуске и раз в полчаса
  setTimeout(checkWebUpdate, 1500);
  setInterval(checkWebUpdate, 30 * 60 * 1000);

  /* «Что нового» — с задержкой: настольная версия успевает пометить body
     классом is-desktop, и список сразу выходит правильным */
  setTimeout(maybeShowWhatsNew, 400);
})();
