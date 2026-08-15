/* ============================================================
   Караоке Студия — вся обработка звука происходит в браузере
   ============================================================ */

const $ = (id) => document.getElementById(id);

/* Версия студии — сверяется с version.json, чтобы предупредить,
   что браузер показывает устаревшую копию из кэша */
const APP_VERSION = '1.2.2';

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
    anim: 'fade',       // fade | slide | none
    valign: 'center',   // flex-start | center | flex-end
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

  /* Проиграть отрывок [from, to) с вокалом — чтобы услышать слова строки */
  playSegment(from, to) {
    this.forceVocal = true;
    this.play(from);
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
    if (state.style.bgMode !== 'color') {
      stage.style.backgroundImage =
        `linear-gradient(rgba(10, 10, 15, 0.68), rgba(10, 10, 15, 0.68)), url("${dataUrl}")`;
    }
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
    const savedTimes = saved && saved.name === state.fileName ? saved.times : null;
    state.lines = texts.map((text, i) => ({
      text,
      time: savedTimes && savedTimes.length === texts.length ? savedTimes[i] : null,
      end: saved && saved.name === state.fileName && saved.ends && saved.ends.length === texts.length
        ? saved.ends[i] : null,
    }));
  }

  saveProject();
  renderSyncList();
  updateSyncButtons();
  goToStep(3);
});

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

function setLineTime(i, t) {
  const line = state.lines[i];
  const prev = i > 0 && state.lines[i - 1].time != null ? state.lines[i - 1].time + 0.05 : 0;
  const next = i < state.lines.length - 1 && state.lines[i + 1].time != null
    ? state.lines[i + 1].time - 0.05
    : audio.duration;
  line.time = Math.min(Math.max(t, prev), Math.max(prev, next));
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
      l.time = Math.min(Math.max(l.time + delta, 0), audio.duration);
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
  state.lines.slice(from).forEach((l) => { l.time = null; l.end = null; });
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
  state.lines.forEach((l) => { l.time = null; l.end = null; });
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

function makeBreakLine() {
  const b = document.createElement('div');
  b.className = 'stage-line current break-line';
  b.textContent = '♪ ♪ ♪';
  return b;
}

/* Строки не переносятся — если строка шире сцены,
   уменьшаем её шрифт так, чтобы она поместилась целиком */
function fitStageLines(container) {
  const avail = container.clientWidth
    - parseFloat(getComputedStyle(container).paddingLeft)
    - parseFloat(getComputedStyle(container).paddingRight);
  if (avail <= 0) return;
  container.querySelectorAll('.stage-line').forEach((el) => {
    el.style.fontSize = '';
    // Несколько проходов: ширина меряется в целых пикселях,
    // поэтому одного пересчёта бывает мало
    for (let pass = 0; pass < 4 && el.scrollWidth > avail; pass++) {
      const cur = parseFloat(getComputedStyle(el).fontSize);
      const next = Math.max(10, cur * (avail / el.scrollWidth) * 0.98);
      el.style.fontSize = `${next}px`;
      if (next <= 10) break;
    }
  });
}

function renderStage() {
  const stage = $('lyrics-stage');
  const lines = syncedLines();
  stage.innerHTML = '';
  if (!lines.length) {
    stage.innerHTML = '<p class="stage-empty">Нет синхронизированных строк</p>';
    return;
  }
  const pos = audio.position();
  const ph = stagePhase(pos);
  player.stageKey = `${ph.mode}:${ph.cur}`;
  const cur = ph.cur;

  if (ph.mode === 'break' && cur === -1) stage.appendChild(makeBreakLine());

  // Окно строк вокруг текущей: сколько показывать — из настроек
  const total = state.style.lines;
  const before = Math.min(2, Math.floor((total - 1) / 2));
  const from = Math.max(0, cur - before);
  const to = Math.min(lines.length, from + total);
  for (let i = from; i < to; i++) {
    const div = document.createElement('div');
    div.className = 'stage-line';
    if (i === cur && ph.mode === 'line') div.classList.add('current');
    else if (i === cur + 1) div.classList.add('near');
    div.textContent = lines[i].text;
    div.dataset.index = i;
    stage.appendChild(div);
    if (i === cur && ph.mode === 'break') stage.appendChild(makeBreakLine());
  }
  if (cur === -1 && ph.mode !== 'break' && stage.firstChild) {
    // Песня ещё не дошла до первой строки
    stage.firstChild.classList.add('near');
  }
  fitStageLines(stage);
}

function updateStageFill() {
  const lines = syncedLines();
  if (!lines.length) return;
  const pos = audio.position();
  const ph = stagePhase(pos);
  if (`${ph.mode}:${ph.cur}` !== player.stageKey) renderStage();
  const el = $('lyrics-stage').querySelector(
    ph.mode === 'break' ? '.break-line' : '.stage-line.current');
  if (!el) return;
  const start = ph.start;
  const end = ph.mode === 'break' ? ph.until : ph.end;
  const fill = end > start ? ((pos - start) / (end - start)) * 100 : 100;
  el.style.setProperty('--fill', `${Math.min(100, Math.max(0, fill)).toFixed(1)}%`);
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
    updatePlayerUI();
  }

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
    stage.style.setProperty('--st-size', `${baseRem * s.size / 100}rem`);
    stage.style.setProperty('--st-weight', s.weight);
    stage.style.setProperty('--st-inactive', s.inactive);
    stage.style.setProperty('--st-active', s.active);
    stage.style.setProperty('--st-effect', s.accent);
    stage.style.setProperty('--st-outline-c', s.outlineColor);
    stage.style.setProperty('--st-outline', `${s.outline}px`);
    stage.style.setProperty('--st-ls', `${s.letter}px`);
    stage.style.setProperty('--st-gap', `${(s.line / 10 - 1).toFixed(2)}em`);
    stage.style.justifyContent = s.valign;
    stage.dataset.effect = s.effect;
    stage.dataset.anim = s.anim;
  });

  // Фон сцены плеера: либо картинка/градиент как раньше, либо сплошной цвет
  const stage = $('lyrics-stage');
  if (s.bgMode === 'color') {
    stage.style.backgroundColor = s.bgColor;
    stage.style.backgroundImage = 'none';
  } else {
    stage.style.backgroundColor = '';
    stage.style.backgroundImage = state.bgImage
      ? `linear-gradient(rgba(10, 10, 15, 0.68), rgba(10, 10, 15, 0.68)), url("${state.bgImage}")`
      : '';
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
  $('st-lines').value = s.lines;
  $('st-lines-val').textContent = s.lines;
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
 ['st-letter', 'letter'], ['st-line', 'line'], ['st-lines', 'lines']]
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
    li.append(play, ts, end, text, nudge, endNudge);
    ul.appendChild(li);
  });
}

$('edit-list').addEventListener('click', (e) => {
  const playBtn = e.target.closest('[data-play]');
  if (playBtn) { playLine(+playBtn.dataset.play); return; }
  const endBtn = e.target.closest('[data-end-i]');
  if (endBtn) { nudgeLineEnd(+endBtn.dataset.endI, +endBtn.dataset.endDelta); renderEditList(); return; }
  const btn = e.target.closest('.nudge-btn');
  if (btn) nudgeLine(+btn.dataset.i, +btn.dataset.delta);
});

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
  state.lines[i].text = el.textContent.replace(/\n/g, ' ').trim() || state.lines[i].text;
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
    const div = document.createElement('div');
    div.className = 'stage-line' + (cls ? ' ' + cls : '');
    if (cls.includes('current')) {
      // Текущую строку набираем посимвольно: так подсветка работает
      // и когда строка переносится, а длинный текст не приходится обрезать
      for (const ch of text) {
        const span = document.createElement('span');
        span.textContent = ch;
        div.appendChild(span);
      }
    } else {
      div.textContent = text;
    }
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
  const p = end > start ? Math.min(1, Math.max(0, (pos - start) / (end - start))) : 1;
  // Красим символы по мере пения — работает и с перенесённой строкой
  const spans = el.children;
  const sung = Math.round(spans.length * p);
  for (let i = 0; i < spans.length; i++) {
    spans[i].classList.toggle('sung', i < sung);
  }
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
  if ($('step-5').classList.contains('active')) fitStageLines($('lyrics-stage'));
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

function drawVideoFrame(g2d, W, H, bgImg, pos) {
  const st = state.style;

  // Фон
  if (st.bgMode === 'color') {
    g2d.fillStyle = st.bgColor;
  } else if (bgImg) {
    const scale = Math.max(W / bgImg.width, H / bgImg.height);
    const w = bgImg.width * scale, h = bgImg.height * scale;
    g2d.drawImage(bgImg, (W - w) / 2, (H - h) / 2, w, h);
    g2d.fillStyle = 'rgba(10, 10, 15, 0.72)';
  } else {
    const grad = g2d.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#171129');
    grad.addColorStop(1, '#0a0a0f');
    g2d.fillStyle = grad;
  }
  g2d.fillRect(0, 0, W, H);

  const lines = syncedLines();
  const ph = stagePhase(pos);
  const cur = ph.cur;

  // Безопасная зона: текст занимает не больше 80% ширины кадра
  const maxWidth = W * 0.8;
  g2d.textAlign = 'center';
  g2d.textBaseline = 'middle';

  const family = (FONTS[st.font] || FONTS.system).css;
  const font = (size) => `${st.weight} ${size}px ${family}`;

  // Собираем блоки: все строки одного кадра получают один размер. Иначе
  // длинная фраза визуально «проваливается» относительно остальных.
  const baseSize = Math.round(40 * st.size / 100);
  const rawBlocks = [];
  const pushText = (text, isCur) => {
    g2d.font = font(baseSize);
    const w = g2d.measureText(text).width;
    rawBlocks.push({ text, width: w, isCur });
  };
  const total = st.lines;
  const before = Math.min(2, Math.floor((total - 1) / 2));
  if (ph.mode === 'break') {
    for (let i = Math.max(0, cur - before + 1); i <= cur; i++) pushText(lines[i].text, false);
    pushText('♪   ♪   ♪', true);
    for (let i = cur + 1; i < Math.min(lines.length, cur + total - before); i++) {
      pushText(lines[i].text, false);
    }
  } else {
    const anchor = cur === -1 ? 0 : cur;
    const first = Math.max(0, anchor - before);
    for (let i = first; i < Math.min(lines.length, first + total); i++) {
      pushText(lines[i].text, i === cur);
    }
  }

  const fittedSize = rawBlocks.reduce((size, b) =>
    Math.min(size, b.width > maxWidth ? baseSize * maxWidth / b.width : baseSize), baseSize);
  const blocks = rawBlocks.map((b) => ({ ...b, size: Math.max(14, fittedSize) }));

  const lineGap = st.line / 10;
  const blockGap = Math.round(baseSize * 0.35);
  const totalH = blocks.reduce((sum, b) => sum + b.size * lineGap + blockGap, -blockGap);
  const pad = 40;
  let y = st.valign === 'flex-start' ? pad
    : st.valign === 'flex-end' ? H - pad - totalH
    : H / 2 - totalH / 2;

  const strokeIfNeeded = (text, x, cy) => {
    if (st.outline > 0) {
      g2d.lineWidth = st.outline * 2;
      g2d.strokeStyle = st.outlineColor;
      g2d.lineJoin = 'round';
      g2d.strokeText(text, x, cy);
    }
  };

  for (const b of blocks) {
    g2d.font = font(b.size);
    g2d.letterSpacing = `${st.letter}px`;
    const rowH = b.size * lineGap;
    const cy = y + rowH / 2;
    strokeIfNeeded(b.text, W / 2, cy);
    if (b.isCur) {
      const start = ph.start;
      const end = ph.mode === 'break' ? ph.until : ph.end;
      const p = end > start ? Math.min(1, Math.max(0, (pos - start) / (end - start))) : 1;
      if (st.effect === 'fill') {
        g2d.fillStyle = st.active;
        g2d.fillText(b.text, W / 2, cy);
        // Заливка цветом эффекта слева направо по мере пения
        const textW = g2d.measureText(b.text).width;
        g2d.save();
        g2d.beginPath();
        g2d.rect((W - textW) / 2, y - 4, textW * p, rowH + 8);
        g2d.clip();
        g2d.fillStyle = st.accent;
        g2d.fillText(b.text, W / 2, cy);
        g2d.restore();
      } else {
        g2d.fillStyle = st.effect === 'highlight' ? st.accent : st.active;
        g2d.fillText(b.text, W / 2, cy);
      }
    } else {
      g2d.fillStyle = st.inactive;
      g2d.fillText(b.text, W / 2, cy);
    }
    y += rowH + blockGap;
  }
  g2d.letterSpacing = '0px';
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
    drawVideoFrame(g2d, W, H, bgImg, Math.max(0, pos));
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
})();
