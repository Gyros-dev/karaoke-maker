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

let pipe = null;
let pipeId = null;
let cancelled = false;

function post(msg) {
  self.postMessage(msg);
}

async function ensurePipe(modelId) {
  if (pipe && pipeId === modelId) return pipe;
  if (pipe) { await pipe.dispose().catch(() => {}); pipe = null; }
  post({ type: 'progress', percent: 2, text: 'Загружаем модель распознавания…' });
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
          text: 'Загружаем модель распознавания…',
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

  post({ type: 'progress', percent: 10, text: 'Слушаем песню…' });

  /* Прогресс и отмена идут через streamer: библиотека дёргает его на
     каждом порождённом токене. (Старое `callback_function` в generate
     уже не смотрят — оно осталось только у готовых текстовых потоков,
     и молча ничего не делало.)

     Считать, докуда дошли, помогают служебные метки времени: Whisper
     выдаёт их вперемешку с текстом, номера идут подряд от
     tokenizer.timestamp_begin с шагом 0,02 с внутри текущего куска. */
  const t0 = Date.now();
  const tsBegin = asr.tokenizer.timestamp_begin;
  let chunkIdx = 0;    // сколько кусков по 30 с уже разобрано
  let inChunk = 0;     // докуда дошли внутри текущего куска, секунды
  let ticks = 0;
  let lastPost = 0;

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
      // Куски идут внахлёст: следующий начинается через 30 − 2×5 = 20 с
      const sec = chunkIdx * (CHUNK_S - 2 * STRIDE_S) + inChunk;
      // Пока меток нет, двигаемся по числу токенов — лишь бы полоса жила
      const frac = Math.min(0.98, Math.max(sec / seconds, ticks / (seconds * 8 + 40)));
      const elapsed = (now - t0) / 1000;
      const rest = elapsed / Math.max(frac, 0.02) - elapsed;
      post({
        type: 'progress',
        percent: 10 + frac * 88,
        text: 'Разбираем слова…',
        eta: rest > 5
          ? `осталось около ${rest < 60 ? Math.ceil(rest / 10) * 10 + ' с' : Math.ceil(rest / 60) + ' мин'}`
          : '',
      });
    },
    end() { chunkIdx++; inChunk = 0; },
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

  const out = await asr(pcm, options);
  if (cancelled) throw new Error('отменено');
  const chunks = (out.chunks || [])
    .map((c) => ({
      text: String(c.text || '').trim(),
      start: c.timestamp && c.timestamp[0] != null ? c.timestamp[0] : null,
      end: c.timestamp && c.timestamp[1] != null ? c.timestamp[1] : null,
    }))
    .filter((c) => c.text && c.start != null);
  return { text: String(out.text || '').trim(), words: chunks };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.cmd === 'cancel') { cancelled = true; return; }
  transcribe(msg)
    .then((res) => post({ type: 'done', ...res }))
    .catch((err) => post({ type: 'error', error: String((err && err.message) || err) }));
};
