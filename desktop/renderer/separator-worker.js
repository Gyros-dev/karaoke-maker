/* ============================================================
   Разделение вокала в фоновом потоке окна.
   Считает WebAssembly-версия ONNX: нативная библиотека внутри
   Electron падает, а эта работает и использует все ядра.

   Модель — UVR-MDX-NET-Inst_HQ_3, та самая, которой считает UVR5.
   Конвенции повторяют UVR (separate.py, класс SeperateMDX):
   вход — комплексная спектрограмма куска, нарезка по 261 120
   отсчётов, склейка окном Ханна, первые три полосы обнуляются.

   Важное отличие от прежней htdemucs: эта модель отдаёт сразу
   ИНСТРУМЕНТАЛ (в model_data.json у неё primary_stem =
   "Instrumental"), а вокал получается вычитанием инструментала
   из микса. Вокал нам нужен: по нему распознаётся текст и
   рисуется полоса «голос» на дорожке редактора.
   ============================================================ */

// NFFT, HOP, DIM_F, DIM_T, BINS, stft и istft приходят из dsp.js
// как глобальные — повторно объявлять их здесь нельзя
importScripts('ort/ort.min.js', 'dsp.js');

/* Параметры модели. Взяты не с потолка: они лежат в
   mdx_model_data/model_data.json репозитория TRvlvr под ключом,
   который равен md5 последних 10 000 КБ файла модели. Для
   UVR-MDX-NET-Inst_HQ_3 это 55657dd70583b0fedfba5f67df11d711:

     mdx_n_fft_scale_set = 6144   → NFFT
     mdx_dim_f_set       = 3072   → DIM_F
     mdx_dim_t_set       = 8      → DIM_T = 2⁸ = 256
     compensate          = 1.022
     primary_stem        = Instrumental                                */
const COMPENSATE = 1.022;

const TRIM = NFFT / 2;                 // 3072
const CHUNK = HOP * (DIM_T - 1);       // 261 120 отсчётов ≈ 5,9 с
const GEN = CHUNK - 2 * TRIM;          // 254 976
/* Перекрытие кусков. 0,25 — умолчание UVR для MDX-Net; на нём и
   сделан эталон, с которым мы сверялись. Каждая четверть перекрытия
   стоит ровно столько же времени, сколько экономит на стыках. */
const OVERLAP = 0.25;
const STEP = Math.floor((1 - OVERLAP) * CHUNK);

let session = null;
let cancelled = false;

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
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

/* Спектр пары каналов (re, im) обратно в волну куска.
   Модель видит только DIM_F полос из BINS — верхние достраиваем нулями,
   ровно как делает STFT.inverse в UVR. */
function обратно(buf, cRe, cIm, re, im) {
  re.fill(0); im.fill(0);
  const bRe = cRe * DIM_F * DIM_T, bIm = cIm * DIM_F * DIM_T;
  for (let f = 0; f < DIM_F; f++) {
    const dst = f * DIM_T, sRe = bRe + dst, sIm = bIm + dst;
    for (let t = 0; t < DIM_T; t++) {
      re[dst + t] = buf[sRe + t];
      im[dst + t] = buf[sIm + t];
    }
  }
  return istft(re, im, BINS, DIM_T, CHUNK);
}

/* Сколько кусков выйдет из записи такой длины — нужно и для нарезки,
   и для честного процента в окне ожидания */
function длинаСДополнением(total) {
  return TRIM + total + (GEN + TRIM - (total % GEN));
}
function кусков(total) {
  return Math.ceil(длинаСДополнением(total) / STEP);
}

/* Один полный проход разделения по всей записи.
   Возвращает инструментал (стерео) и вокал (моно). */
async function separatePass(L, R, total, session, onChunk) {
  const mixLen = длинаСДополнением(total);

  const mixL = new Float32Array(mixLen), mixR = new Float32Array(mixLen);
  mixL.set(L, TRIM); mixR.set(R, TRIM);

  const resL = new Float32Array(mixLen), resR = new Float32Array(mixLen);
  /* «Микс, прошедший тот же тракт»: обратное преобразование того же
     спектра, что ушёл в модель. Вычитая из него инструментал, получаем
     вокал без следов срезанных полос. Копим сразу в моно — стерео
     распознаванию не нужно, а лишний буфер на песню в четыре минуты
     это ещё сорок мегабайт. */
  const mixMono = new Float32Array(mixLen);
  const div = new Float32Array(mixLen);

  const partL = new Float32Array(CHUNK), partR = new Float32Array(CHUNK);
  const spec = new Float32Array(4 * DIM_F * DIM_T);
  const re = new Float64Array(BINS * DIM_T), im = new Float64Array(BINS * DIM_T);

  const всегоКусков = кусков(total);
  let кусок = 0;

  for (let i = 0; i < mixLen; i += STEP) {
    if (cancelled) throw new Error('отменено');
    const start = i, end = Math.min(i + CHUNK, mixLen);
    const act = end - start;

    partL.fill(0); partR.fill(0);
    partL.set(mixL.subarray(start, end), 0);
    partR.set(mixR.subarray(start, end), 0);

    const SL = stft(partL, DIM_T), SR = stft(partR, DIM_T);
    // Каналы модели: [Lre, Lim, Rre, Rim], только нижние DIM_F полос
    for (let f = 0; f < DIM_F; f++) {
      const dst = f * DIM_T, src = f * DIM_T;
      for (let t = 0; t < DIM_T; t++) {
        spec[dst + t] = SL.re[src + t];
        spec[DIM_F * DIM_T + dst + t] = SL.im[src + t];
        spec[2 * DIM_F * DIM_T + dst + t] = SR.re[src + t];
        spec[3 * DIM_F * DIM_T + dst + t] = SR.im[src + t];
      }
    }
    // Первые три полосы в нуль — так UVR кормит модель
    for (let c = 0; c < 4; c++) {
      spec.fill(0, c * DIM_F * DIM_T, c * DIM_F * DIM_T + 3 * DIM_T);
    }

    const out = await session.run({
      input: new ort.Tensor('float32', spec, [1, 4, DIM_F, DIM_T]),
    });
    const o = out.output.data;

    // istft каждый раз отдаёт свой массив, так что копировать нечего
    const tarL = обратно(o, 0, 1, re, im);
    const tarR = обратно(o, 2, 3, re, im);
    const rawL = обратно(spec, 0, 1, re, im);
    const rawR = обратно(spec, 2, 3, re, im);

    // Окно на стыках — симметричное Ханна длины куска, как np.hanning
    for (let j = 0; j < act; j++) {
      const w = act > 1 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (act - 1)) : 1;
      resL[start + j] += tarL[j] * w;
      resR[start + j] += tarR[j] * w;
      mixMono[start + j] += (rawL[j] + rawR[j]) * 0.5 * w;
      div[start + j] += w;
    }

    кусок++;
    onChunk(кусок, всегоКусков);
  }

  // Делим на сумму весов, снимаем TRIM, обрезаем до исходной длины.
  // COMPENSATE — предписанный моделью коэффициент, без него минусовка
  // выходит тише оригинала примерно на два процента.
  const outL = new Float32Array(total), outR = new Float32Array(total);
  const outV = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const j = i + TRIM;
    const w = div[j] || 1e-12;
    const l = (resL[j] / w) * COMPENSATE;
    const r = (resR[j] / w) * COMPENSATE;
    outL[i] = l; outR[i] = r;
    outV[i] = mixMono[j] / w - (l + r) * 0.5;
  }
  return { outL, outR, outV };
}

async function separate({ modelBytes, left, right, sampleRate, shifts = 1 }) {
  cancelled = false;
  const L = new Float32Array(left);
  const R = new Float32Array(right);
  const total = L.length;

  post({ type: 'progress', percent: 0, text: 'Готовим модель…' });
  await ensureSession(modelBytes);

  /* Приём со сдвигами: каждый проход смещает запись на случайную долю
     секунды, результаты усредняются. Мы его замеряли: на качество он
     не влияет (три прохода против одного расходятся на −31 дБ, остаток
     вокала совпадает до сотых долей децибела), поэтому по умолчанию
     проход один. Переключатель оставлен, но обещаний за него не даём. */
  const passes = Math.max(1, Math.min(4, shifts));
  const MAX_SHIFT = Math.round(sampleRate * 0.5);
  const sumL = new Float64Array(total);
  const sumR = new Float64Array(total);
  const sumV = new Float64Array(total);
  const t0 = Date.now();
  let сделано = 0;
  const всего = passes * кусков(total);

  for (let pass = 0; pass < passes; pass++) {
    // Первый проход без смещения, дальше — со сдвигом
    const shift = pass === 0 ? 0 : 1 + Math.floor(Math.random() * MAX_SHIFT);
    const padded = total + shift;
    const sL = new Float32Array(padded);
    const sR = new Float32Array(padded);
    sL.set(L, shift);
    sR.set(R, shift);

    const { outL, outR, outV } = await separatePass(
      sL, sR, padded, session,
      (done, all) => {
        сделано++;
        const frac = Math.min(сделано / всего, 0.999);
        const elapsed = (Date.now() - t0) / 1000;
        const rest = elapsed / Math.max(frac, 0.001) - elapsed;
        post({
          type: 'progress',
          percent: Math.round(frac * 100),
          text: passes > 1
            ? `Убираем вокал: проход ${pass + 1} из ${passes}, кусок ${done} из ${all}`
            : `Убираем вокал: ${done} из ${all}`,
          eta: rest > 3 ? `осталось около ${Math.ceil(rest / 6) * 6 < 60
            ? Math.ceil(rest / 6) * 6 + ' с'
            : Math.ceil(rest / 60) + ' мин'}` : '',
        });
      });

    // Снимаем сдвиг и копим сумму
    for (let i = 0; i < total; i++) {
      sumL[i] += outL[i + shift];
      sumR[i] += outR[i + shift];
      sumV[i] += outV[i + shift];
    }
  }

  const outL = new Float32Array(total);
  const outR = new Float32Array(total);
  const voc = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    outL[i] = sumL[i] / passes;
    outR[i] = sumR[i] / passes;
    voc[i] = sumV[i] / passes;
  }
  return { left: outL, right: outR, vocal: voc, sampleRate };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.cmd === 'cancel') { cancelled = true; return; }
  separate(msg)
    .then(({ left, right, vocal, sampleRate }) => {
      post({ type: 'done', left: left.buffer, right: right.buffer, vocal: vocal.buffer, sampleRate },
        [left.buffer, right.buffer, vocal.buffer]);
    })
    .catch((err) => {
      post({ type: 'error', error: String((err && err.message) || err) });
    });
};
