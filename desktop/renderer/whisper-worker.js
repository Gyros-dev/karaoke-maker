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

  /* Прогресс честно посчитать нечем: библиотека не сообщает, какой
     кусок считает. Идём по числу порождённых кусочков текста —
     оно растёт примерно равномерно вместе с записью. */
  const t0 = Date.now();
  let ticks = 0;
  const expected = Math.max(20, seconds * 3);

  const options = {
    task: 'transcribe',
    return_timestamps: 'word',
    chunk_length_s: 30,
    stride_length_s: 5,
    callback_function: () => {
      if (cancelled) throw new Error('отменено');
      ticks++;
      const frac = Math.min(0.97, ticks / expected);
      const elapsed = (Date.now() - t0) / 1000;
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
