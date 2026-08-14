/* ============================================================
   Разделение вокала в фоновом потоке окна.
   Считает WebAssembly-версия ONNX: нативная библиотека внутри
   Electron падает, а эта работает и использует все ядра.

   Конвенции повторяют demucs (hdemucs.py / apply.py):
   сегмент 343980 сэмплов при 44100 Гц, перекрытие 25%,
   треугольные веса на стыках, порядок стемов
   [ударные, бас, остальное, вокал].
   ============================================================ */

// HOP, stft и istft приходят из dsp.js как глобальные —
// повторно объявлять их здесь нельзя
importScripts('ort/ort.min.js', 'dsp.js');

const SEG = 343980;
const FRAMES = 336;
const FREQ = 2048;
const PAD = (HOP / 2) * 3;
const OVERLAP = 0.25;
const STRIDE = Math.floor(SEG * (1 - OVERLAP));
const SOURCES = 4;

let session = null;
let cancelled = false;

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

/* Спектрограмма сегмента: [4, 2048, 336], каналы [Lre, Lim, Rre, Rim] */
function segmentSpec(left, right) {
  const out = new Float32Array(4 * FREQ * FRAMES);
  const chans = [left, right];
  const rightPad = PAD + FRAMES * HOP - SEG;
  for (let c = 0; c < 2; c++) {
    const ch = chans[c];
    const padded = new Float32Array(PAD + SEG + rightPad);
    padded.set(ch, PAD);
    for (let i = 0; i < PAD; i++) padded[PAD - 1 - i] = ch[i + 1];
    for (let i = 0; i < rightPad; i++) padded[PAD + SEG + i] = ch[SEG - 2 - i];

    const S = stft(padded, FRAMES + 4);
    for (let f = 0; f < FREQ; f++) {
      for (let t = 0; t < FRAMES; t++) {
        const src = f * S.frames + (t + 2);
        out[(c * 2) * FREQ * FRAMES + f * FRAMES + t] = S.re[src];
        out[(c * 2 + 1) * FREQ * FRAMES + f * FRAMES + t] = S.im[src];
      }
    }
  }
  return out;
}

/* Спектр одного источника обратно в волну */
function specToWave(spec, base) {
  const frames = FRAMES + 4;
  const bins = FREQ + 1;
  const re = new Float64Array(bins * frames);
  const im = new Float64Array(bins * frames);
  for (let f = 0; f < FREQ; f++) {
    for (let t = 0; t < FRAMES; t++) {
      re[f * frames + (t + 2)] = spec[base + f * FRAMES + t];
      im[f * frames + (t + 2)] = spec[base + FREQ * FRAMES + f * FRAMES + t];
    }
  }
  const full = istft(re, im, bins, frames, PAD * 2 + FRAMES * HOP);
  return full.subarray(PAD, PAD + SEG);
}

async function ensureSession(modelBytes) {
  if (session) return session;
  ort.env.wasm.wasmPaths = new URL('ort/', location.href).href;
  ort.env.wasm.numThreads = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
  ort.env.wasm.simd = true;
  session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return session;
}

async function separate({ modelBytes, left, right, sampleRate }) {
  cancelled = false;
  const L = new Float32Array(left);
  const R = new Float32Array(right);
  const total = L.length;

  post({ type: 'progress', percent: 0, text: 'Готовим модель…' });
  await ensureSession(modelBytes);

  // Нормализация по моно-миксу, как в demucs.apply_model
  let mean = 0;
  for (let i = 0; i < total; i++) mean += (L[i] + R[i]) * 0.5;
  mean /= total;
  let varSum = 0;
  for (let i = 0; i < total; i++) {
    const m = (L[i] + R[i]) * 0.5 - mean;
    varSum += m * m;
  }
  const std = Math.sqrt(varSum / total) || 1;

  // Треугольные веса — плавная склейка перекрытий
  const weight = new Float32Array(SEG);
  const half = Math.floor(SEG / 2);
  for (let i = 0; i < SEG; i++) weight[i] = (i < half ? i + 1 : SEG - i) / half;

  const instL = new Float64Array(total);
  const instR = new Float64Array(total);
  const wAcc = new Float64Array(total);

  const starts = [];
  for (let s = 0; s < total; s += STRIDE) starts.push(s);
  const segL = new Float32Array(SEG);
  const segR = new Float32Array(SEG);
  const t0 = Date.now();

  for (let si = 0; si < starts.length; si++) {
    if (cancelled) throw new Error('отменено');
    const start = starts[si];
    segL.fill(0); segR.fill(0);
    const n = Math.min(SEG, total - start);
    for (let i = 0; i < n; i++) {
      segL[i] = (L[start + i] - mean) / std;
      segR[i] = (R[start + i] - mean) / std;
    }

    const spec = segmentSpec(segL, segR);
    const wave = new Float32Array(2 * SEG);
    wave.set(segL, 0);
    wave.set(segR, SEG);

    const res = await session.run({
      input: new ort.Tensor('float32', wave, [1, 2, SEG]),
      x: new ort.Tensor('float32', spec, [1, 4, FREQ, FRAMES]),
    });
    const specOut = res.output.data;
    const waveOut = res.add_67.data;

    // Инструментал = ударные + бас + остальное (стемы 0..2, без вокала)
    for (let src = 0; src < SOURCES - 1; src++) {
      const specBase = src * 4 * FREQ * FRAMES;
      const wl = specToWave(specOut, specBase);
      const wr = specToWave(specOut, specBase + 2 * FREQ * FRAMES);
      const tBase = src * 2 * SEG;
      for (let i = 0; i < n; i++) {
        instL[start + i] += (wl[i] + waveOut[tBase + i]) * weight[i];
        instR[start + i] += (wr[i] + waveOut[tBase + SEG + i]) * weight[i];
      }
    }
    for (let i = 0; i < n; i++) wAcc[start + i] += weight[i];

    const doneFrac = (si + 1) / starts.length;
    const elapsed = (Date.now() - t0) / 1000;
    const left = elapsed / doneFrac - elapsed;
    post({
      type: 'progress',
      percent: Math.round(doneFrac * 100),
      text: `Убираем вокал: ${si + 1} из ${starts.length}`,
      eta: left > 3 ? `осталось около ${Math.ceil(left / 6) * 6 < 60
        ? Math.ceil(left / 6) * 6 + ' с'
        : Math.ceil(left / 60) + ' мин'}` : '',
    });
  }

  const outL = new Float32Array(total);
  const outR = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const w = wAcc[i] || 1;
    outL[i] = (instL[i] / w) * std + mean;
    outR[i] = (instR[i] / w) * std + mean;
  }
  return { left: outL, right: outR, sampleRate };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.cmd === 'cancel') { cancelled = true; return; }
  separate(msg)
    .then(({ left, right, sampleRate }) => {
      post({ type: 'done', left: left.buffer, right: right.buffer, sampleRate },
        [left.buffer, right.buffer]);
    })
    .catch((err) => {
      post({ type: 'error', error: String((err && err.message) || err) });
    });
};
