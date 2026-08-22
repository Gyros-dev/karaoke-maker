/* ============================================================
   Распознавание текста песни в фоновом потоке окна.

   Модель Whisper через transformers.js: она сама делает мел-спектр,
   прогоняет кодировщик и декодировщик и умеет отдавать метки времени
   по словам (return_timestamps: 'word'). Это закрывает сразу и текст,
   и точную разметку line.words.

   Файлы модели лежат в папке настроек и отдаются по адресу
   app://bundle/models/<модель>/… — обработчик схемы в main.js.
   В интернет отсюда никто не ходит: allowRemoteModels выключен.
   ============================================================ */

import { pipeline, env } from './xf/transformers.min.js';

// Только локальные файлы: скачиванием занимается главный процесс
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('models/', location.href).href;

/* Пути к движку задаём поимённо. По умолчанию transformers.js берёт
   сборку asyncify — она нужна только для WebGPU и весит вдвое больше,
   а нам хватает обычной многопоточной. */
const XF = new URL('xf/', location.href).href;
env.backends.onnx.wasm.wasmPaths = {
  mjs: XF + 'ort-wasm-simd-threaded.mjs',
  wasm: XF + 'ort-wasm-simd-threaded.wasm',
};
env.backends.onnx.wasm.numThreads =
  Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
env.backends.onnx.wasm.proxy = false;

/* Кэш браузера для схемы app:// не работает и сыплет предупреждениями.
   Файлы и так лежат на диске — читать их заново дёшево. */
env.useBrowserCache = false;
env.useWasmCache = false;

const WHISPER_SR = 16000;
// Whisper слушает запись кусками по 30 секунд с перехлёстом по 5 с с краёв
const CHUNK_S = 30;
const STRIDE_S = 5;

/* ============================================================
   Борьба с зацикливанием

   Whisper иногда залипает: поймав повтор, он гонит одно и то же
   слово до упора в 448 токенов («да, да, да…» на сотни строк).
   В оригинальном whisper от OpenAI на этот случай есть откат по
   температуре: кусок, чей текст подозрительно хорошо сжимается,
   переслушивают заново — со случайным выбором слов вместо жадного.
   Случайность сбивает модель с наезженной колеи, и петля рвётся.

   В transformers.js 4.x такого нет: в generate нет ни
   compression_ratio_threshold, ни logprob_threshold, ни отката —
   есть только разовые temperature / do_sample / no_repeat_ngram_size
   (проверено по исходникам models/modeling_utils.js и
   models/whisper/generation_whisper.js). Поэтому откат делаем сами:
   подменяем model.generate своей обёрткой, которая переслушивает
   плохие куски. Библиотека зовёт generate ровно один раз на каждое
   30-секундное окно, так что зерно отката ложится точно по кускам.
   ============================================================ */

/* Сжимаемость текста. У OpenAI порог 2,4, но он выставлен по английскому
   тексту в однобайтовой кодировке. Русские буквы в UTF-8 занимают по два
   байта, и упаковщик срезает лишний байт даже на осмысленной строке —
   счёт задран примерно в полтора раза. Замеры по эталону этой песни:
   честное 30-секундное окно даёт 1,4–1,9, дважды спетый в одно окно
   припев — 3,5, а настоящая петля — от 17 и выше. Поэтому здесь порог
   стоит с большим запасом и работает как страховка: основную работу
   делает счётчик повторов ниже, а сжимаемость ловит то, что он
   пропускает (например, чередование «4, 3, 4, 3…»). */
const COMPRESSION_LIMIT = 5;

/* Сколько раз подряд можно повторить одно и то же, чтобы это ещё
   считалось пением. Отдельно считаем повторы одного слова и повторы
   связки из нескольких слов: петля бывает и такой — «раз, два, раз,
   два…», одинаковых слов подряд там нет вовсе.

   Пороги стоят по замерам на живой песне, и запас тут огромный.
   Настоящий распев — «Я просто пропада-да-да-да-да-да-даю, да» —
   модель честно расписывает как 11–12 «да» подряд. А сорвавшаяся в
   петлю модель выдаёт 91, 197, 219, 437, 438 повторов: она долбит
   одно слово, пока не упрётся в потолок в 448 токенов. Между 12 и 91
   пропасть, поэтому порог кладём посередине с перекосом в сторону
   пения: живой распев дороже, чем лишний прогон. */
const REPEAT_LIMIT = 24;  // одно слово подряд
const CYCLE_LIMIT = 16;   // связка из 2–4 слов подряд (на живом пении ≤ 6)
const CYCLE_MAX = 4;      // до какой длины связки ищем

/* Ступени отката. У OpenAI их шесть — 0 (жадно), 0,2, 0,4 … 1,0, — но
   ступень 0,2 здесь выбрасываем: на замерах она давала ровно тот же
   текст, что и жадный проход (распределение слишком острое, случайность
   почти всегда выбирает то же слово), то есть целый лишний прогон впустую.
   Петли рвутся начиная с 0,4 — с неё и начинаем. */
const FALLBACK_TEMPS = [0.4, 0.6, 0.8, 1.0];

let pipe = null;
let pipeId = null;
let cancelled = false;

/* Во сколько раз текст ужимается упаковщиком. Петля — это одно и то же
   слово сотни раз подряд, такой текст жмётся в десятки раз; живая речь
   держится в пределах двух с небольшим. deflate-raw выбран потому, что
   у него нет заголовка: на коротких кусках он не искажает счёт. */
async function compressionRatio(text) {
  const raw = new TextEncoder().encode(text);
  // На пол-строчки мерить нечего: любой результат будет случайным
  if (raw.length < 60) return 1;
  const packed = await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  ).arrayBuffer();
  return raw.length / Math.max(1, packed.byteLength);
}

function toWords(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

/* Самая длинная шарманка: сколько раз подряд повторяется связка из
   period слов. Для period = 1 это просто цепочка одинаковых слов.
   Считаем в лоб — слово совпадает с тем, что было period слов назад. */
function maxCycleRun(words, period) {
  let run = 0;    // сколько слов подряд повторяют сказанное period слов назад
  let best = words.length ? 1 : 0;
  for (let i = period; i < words.length; i++) {
    if (words[i] === words[i - period]) run++;
    else run = 0;
    const cycles = Math.floor(run / period) + 1;
    if (cycles > best) best = cycles;
  }
  return best;
}

/* Насколько кусок похож на петлю. Ноль — всё в порядке; чем больше
   число, тем сильнее залипание (по нему выбираем лучшую попытку). */
async function loopScore(text) {
  const ratio = await compressionRatio(text);
  const words = toWords(text);

  const run = maxCycleRun(words, 1);
  let byCycle = 0;
  let cycle = 1;
  for (let p = 2; p <= CYCLE_MAX; p++) {
    const c = maxCycleRun(words, p);
    if (c > cycle) cycle = c;
    byCycle = Math.max(byCycle, c - CYCLE_LIMIT);
  }

  const byRatio = Math.max(0, ratio - COMPRESSION_LIMIT);
  const byRun = Math.max(0, run - REPEAT_LIMIT);
  byCycle = Math.max(0, byCycle);
  return {
    score: byRatio + byRun + byCycle,
    ratio, run, cycle,
    bad: byRatio > 0 || byRun > 0 || byCycle > 0,
  };
}

function post(msg) {
  self.postMessage(msg);
}

async function ensurePipe(modelId) {
  if (pipe && pipeId === modelId) return pipe;
  if (pipe) { await pipe.dispose().catch(() => {}); pipe = null; }
  /* Как и в разделении: воркер отдаёт ключ, строку складывает
     desktop.js — словарь живёт там. */
  post({ type: 'progress', percent: 2, ключ: 'asr.загружаемМодель' });
  pipe = await pipeline('automatic-speech-recognition', modelId, {
    // На wasm по умолчанию q8 — те самые файлы *_quantized.onnx
    device: 'wasm',
    /* Оптимизатор графа в свежем onnxruntime спотыкается о старую
       квантованную сборку Whisper («Missing required scale … MatMulNBits»).
       Отключаем — модель считается ровно так, как её экспортировали. */
    session_options: { graphOptimizationLevel: 'disabled' },
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        post({
          type: 'progress',
          percent: 2 + (p.loaded / p.total) * 8,
          ключ: 'asr.загружаемМодель',
        });
      }
    },
  });
  pipeId = modelId;
  return pipe;
}

async function transcribe({ modelId, audio, language }) {
  cancelled = false;
  const pcm = new Float32Array(audio);
  const seconds = pcm.length / WHISPER_SR;
  const asr = await ensurePipe(modelId);
  if (cancelled) throw new Error('отменено');

  post({ type: 'progress', percent: 10, ключ: 'asr.слушаем' });

  /* Прогресс и отмена идут через streamer: библиотека дёргает его на
     каждом порождённом токене. (Старое `callback_function` в generate
     уже не смотрят — оно осталось только у готовых текстовых потоков,
     и молча ничего не делало.)

     Считать, докуда дошли, помогают служебные метки времени: Whisper
     выдаёт их вперемешку с текстом, номера идут подряд от
     tokenizer.timestamp_begin с шагом 0,02 с внутри текущего куска. */
  const t0 = Date.now();
  const tsBegin = asr.tokenizer.timestamp_begin;

  /* Куски идут внахлёст: следующий начинается через 30 − 2×5 = 20 с.
     Считаем их заранее — так полоса не врёт даже при переслушивании. */
  const jump = CHUNK_S - 2 * STRIDE_S;
  const totalWindows = Math.max(1, Math.ceil(Math.max(0, seconds - CHUNK_S) / jump) + 1);

  let windowIdx = 0;   // сколько 30-секундных окон уже разобрано
  let inChunk = 0;     // докуда дошли внутри текущего окна, секунды
  let ticks = 0;
  let lastPost = 0;
  // Не null, пока окно слушается повторно: тогда полоса честно стоит
  let попытка = null;   // какой заход переслушивания идёт сейчас (или null)

  const streamer = {
    put(rows) {
      if (cancelled) throw new Error('отменено');
      ticks++;
      for (const row of rows) {
        for (const id of row) {
          const n = Number(id);
          if (n >= tsBegin) inChunk = Math.max(inChunk, (n - tsBegin) * 0.02);
        }
      }
      const now = Date.now();
      if (now - lastPost < 250) return;
      lastPost = now;
      const done = windowIdx + Math.min(1, inChunk / CHUNK_S);
      // Пока меток нет, двигаемся по числу токенов — лишь бы полоса жила
      const frac = Math.min(0.98,
        Math.max(done / totalWindows, ticks / (seconds * 8 + 40)));
      const elapsed = (now - t0) / 1000;
      const rest = elapsed / Math.max(frac, 0.02) - elapsed;
      /* Пока окно переслушивается, полоса стоит на месте — двигать её
         вперёд нечестно, работа идёт по второму разу. Но и молчать
         нельзя: с упёршейся полосой и обещанием «около 10 с» это
         выглядит намертво повисшей программой. Поэтому говорим прямо,
         чем заняты, и не обещаем срок, которого не знаем. */
      const переслушиваем = попытка != null;
      post({
        type: 'progress',
        percent: 10 + frac * 88,
        'ключ': переслушиваем ? 'asr.трудныйКусок' : 'asr.разбираем',
        'парам': переслушиваем ? попытка : null,
        осталось: переслушиваем || rest <= 5 || frac >= 0.98
          ? null
          : (rest < 60
            ? { n: Math.ceil(rest / 10) * 10, 'единица': 'с' }
            : { n: Math.ceil(rest / 60), 'единица': 'мин' }),
      });
    },
    /* Раньше здесь считали куски, но end() срабатывает не по разу на
       окно: внутри модели есть свой цикл догона по меткам времени.
       Теперь окна считает обёртка отката — она знает точно. */
    end() {},
  };

  /* ---------- Откат по температуре ----------
     Подменяем generate у модели: библиотека зовёт его по разу на каждое
     30-секундное окно. Сначала слушаем как обычно (жадно), проверяем
     результат на залипание и, если он испорчен, переслушиваем окно с
     повышенной температурой.

     Бюджет переслушиваний ограничен: распознавание и так идёт минуты,
     а без ограничения плохая запись растянула бы его в шесть раз. */
  let retriesLeft = Math.max(4, totalWindows);
  let retriesUsed = 0;
  let loopsLeft = 0;   // сколько окон так и не удалось расслышать

  const model = asr.model;
  const originalGenerate = model.generate.bind(model);

  // Текст окна без служебных меток времени — по нему и ищем петлю
  const decodeWindow = (out) => {
    const seq = out && out.sequences ? out.sequences : out;
    const ids = seq[0].tolist().map(Number).filter((n) => n < tsBegin);
    return String(asr.tokenizer.decode(ids, { skip_special_tokens: true })).trim();
  };

  model.generate = async (args) => {
    inChunk = 0;
    let best = null;
    let bestJudge = null;

    for (let attempt = 0; attempt <= FALLBACK_TEMPS.length; attempt++) {
      const temp = attempt === 0 ? 0 : FALLBACK_TEMPS[attempt - 1];
      const extra = temp === 0
        ? { do_sample: false }
        : {
            do_sample: true,
            temperature: temp,
            /* Со второй попытки вдобавок запрещаем дословный повтор
               длинных цепочек. Десять токенов — заведомо больше любого
               распева, поэтому «пропада-да-да-даю» это не задевает,
               а бесконечную шарманку рвёт наверняка. */
            ...(attempt >= 2 ? { no_repeat_ngram_size: 10 } : {}),
          };

      inChunk = 0;
      попытка = attempt === 0
        ? null
        : { n: attempt, 'всего': FALLBACK_TEMPS.length };
      const out = await originalGenerate({ ...args, ...extra });
      if (cancelled) throw new Error('отменено');

      const wtext = decodeWindow(out);
      const judge = await loopScore(wtext);
      if (self.__asrDebug) {
        console.log(`[окно ${windowIdx} t=${temp}] ${judge.bad ? 'ПЕТЛЯ' : 'норма'}`
          + ` сжатие=${judge.ratio.toFixed(2)} слово=${judge.run} связка=${judge.cycle}`
          + ` :: ${wtext.slice(0, 110)}`);
      }
      if (!bestJudge || judge.score < bestJudge.score) { best = out; bestJudge = judge; }
      if (!judge.bad) break;

      // Слушать заново больше нечем — берём наименее испорченный вариант
      if (attempt === FALLBACK_TEMPS.length || retriesLeft <= 0) break;
      retriesLeft--;
      retriesUsed++;
    }

    if (bestJudge && bestJudge.bad) loopsLeft++;
    попытка = null;     // окно закрыто, дальше полоса снова едет
    windowIdx++;
    return best;
  };

  const options = {
    task: 'transcribe',
    return_timestamps: 'word',
    chunk_length_s: CHUNK_S,
    stride_length_s: STRIDE_S,
    streamer,
  };
  // Пустой язык — пусть Whisper определит сам
  if (language) options.language = language;

  let out;
  try {
    out = await asr(pcm, options);
  } finally {
    model.generate = originalGenerate;
  }
  if (cancelled) throw new Error('отменено');

  const chunks = collapseRuns((out.chunks || [])
    .map((c) => ({
      text: String(c.text || '').trim(),
      start: c.timestamp && c.timestamp[0] != null ? c.timestamp[0] : null,
      end: c.timestamp && c.timestamp[1] != null ? c.timestamp[1] : null,
    }))
    .filter((c) => c.text && c.start != null));

  return {
    text: chunks.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim(),
    words: chunks,
    // Для самопроверки: сколько раз пришлось переслушивать и что осталось
    отладка: { окон: totalWindows, переслушано: retriesUsed, залипло: loopsLeft },
  };
}

/* Подстраховка после распознавания: даже с откатом отдельная серия
   может просочиться, а одна такая строка на сцене ломает всё караоке.
   Режем только патологию — цепочки длиннее REPEAT_LIMIT; настоящий
   распев «пропада-да-да-да-даю» короче и остаётся как есть. */
function collapseRuns(words) {
  const out = [];
  let prevKey = null;
  let run = 1;
  for (const w of words) {
    const key = w.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (key && key === prevKey) run++;
    else { run = 1; prevKey = key; }
    if (run > REPEAT_LIMIT) continue;
    out.push(w);
  }
  return out;
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.cmd === 'cancel') { cancelled = true; return; }
  // Разбор отката по температуре в самопроверке: KARAOKE_ASR_DEBUG=1
  if (msg.debug) self.__asrDebug = true;
  transcribe(msg)
    .then((res) => post({ type: 'done', ...res }))
    .catch((err) => post({ type: 'error', error: String((err && err.message) || err) }));
};
