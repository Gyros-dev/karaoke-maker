/* ============================================================
   DSP для MDX-Net: БПФ, STFT и обратное преобразование.

   Соглашения повторяют torch.stft/torch.istft с теми параметрами,
   с которыми MDX-Net гоняет UVR5: окно Ханна (periodic),
   center=True, pad_mode='reflect', normalized=False.

   Главное отличие от прежней версии, считавшей htdemucs: у MDX-Net
   n_fft = 6144, а это НЕ степень двойки. 6144 = 2048 × 3, поэтому
   к прежнему БПФ по основанию 2 добавлена одна стадия по основанию 3.
   Подробности — у makeFFT.
   ============================================================ */

const NFFT = 6144;      // mdx_n_fft_scale_set
const HOP = 1024;       // в UVR зашито жёстко
const DIM_F = 3072;     // mdx_dim_f_set — сколько полос видит модель
const DIM_T = 256;      // 2 ** mdx_dim_t_set — кадров в одном куске
const BINS = NFFT / 2 + 1;

/* ------------------------------------------------------------
   Ядро по основанию 2, на месте, без деления на n.
   sign = -1 — прямое преобразование, +1 — обратное.
   ------------------------------------------------------------ */
function makeRadix2Core(n) {
  const levels = Math.round(Math.log2(n));
  if (2 ** levels !== n) throw new Error('radix-2: размер должен быть степенью двойки');

  const cosT = new Float64Array(n / 2);
  const sinT = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / n);
    sinT[i] = Math.sin((2 * Math.PI * i) / n);
  }

  // Таблица перестановок бит
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }

  return function core(re, im, sign) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = cosT[k];
          const s = sign > 0 ? sinT[k] : -sinT[k];
          const tre = re[l] * c - im[l] * s;
          const tim = re[l] * s + im[l] * c;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  };
}

/* ------------------------------------------------------------
   Ядро для n = 3 × (степень двойки).

   Обычное разложение Кули—Тьюки, только внешний множитель равен
   трём, а не двум: вход раскладывается на три подряда по остатку
   от деления номера на 3, каждый считается прежним БПФ основания 2,
   и результаты сводятся с поворотными множителями

       X[k] = X0[k mod m] + W^k · X1[k mod m] + W^2k · X2[k mod m],
       W = exp(∓2πi/n),  m = n/3.

   Почему так, а не по Блустейну. Алгоритм Блустейна берёт любой
   размер, но считает его через три БПФ длиной не меньше 2n−1: для
   6144 это 16384, то есть примерно вдесятеро больше работы, да ещё
   и с лишней потерей точности на чирп-множителях. Здесь же
   разложение точное и стоит одного лишнего прохода по массиву.
   ------------------------------------------------------------ */
function makeRadix3Core(n) {
  const m = n / 3;
  const sub = makeRadix2Core(m);

  const cosW = new Float64Array(n);
  const sinW = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    cosW[k] = Math.cos((2 * Math.PI * k) / n);
    sinW[k] = Math.sin((2 * Math.PI * k) / n);
  }

  // Буферы под подряды заводим один раз: БПФ зовут десятки тысяч раз
  const aRe = [new Float64Array(m), new Float64Array(m), new Float64Array(m)];
  const aIm = [new Float64Array(m), new Float64Array(m), new Float64Array(m)];

  return function core(re, im, sign) {
    for (let r = 0; r < 3; r++) {
      const pr = aRe[r], pi = aIm[r];
      for (let j = 0; j < m; j++) { pr[j] = re[3 * j + r]; pi[j] = im[3 * j + r]; }
      sub(pr, pi, sign);
    }
    const r0 = aRe[0], i0 = aIm[0];
    const r1 = aRe[1], i1 = aIm[1];
    const r2 = aRe[2], i2 = aIm[2];
    // k пробегает 0…n−1, а k mod m — это три круга по подрядам.
    // Поворотные индексы ведём приращением: остаток от деления
    // в самом горячем цикле стоит дороже сложения.
    let k = 0, t1 = 0, t2 = 0;
    for (let blk = 0; blk < 3; blk++) {
      for (let j = 0; j < m; j++) {
        const c1 = cosW[t1], s1 = sign > 0 ? sinW[t1] : -sinW[t1];
        const c2 = cosW[t2], s2 = sign > 0 ? sinW[t2] : -sinW[t2];
        const x1 = r1[j], y1 = i1[j];
        const x2 = r2[j], y2 = i2[j];
        re[k] = r0[j] + (x1 * c1 - y1 * s1) + (x2 * c2 - y2 * s2);
        im[k] = i0[j] + (x1 * s1 + y1 * c1) + (x2 * s2 + y2 * c2);
        k++;
        t1++;                       // t1 = k mod n, а k < n — сбрасывать не нужно
        t2 += 2; if (t2 >= n) t2 -= n;
      }
    }
  };
}

/* Полное БПФ: прямое без множителя, обратное с делением на n —
   те же соглашения, что у прежней версии. */
function makeFFT(n) {
  let core;
  if (n > 0 && (n & (n - 1)) === 0) core = makeRadix2Core(n);
  else if (n % 3 === 0 && ((n / 3) & (n / 3 - 1)) === 0) core = makeRadix3Core(n);
  else throw new Error('БПФ: размер должен быть 2^k или 3×2^k, получено ' + n);

  return function fft(re, im, inverse) {
    core(re, im, inverse ? 1 : -1);
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  };
}

const fft = makeFFT(NFFT);

/* Окно Ханна, periodic — как torch.hann_window по умолчанию */
const WINDOW = new Float64Array(NFFT);
for (let i = 0; i < NFFT; i++) {
  WINDOW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT);
}

/* Отражающее дополнение (pad_mode='reflect') */
function padReflect(x, left, right) {
  const n = x.length;
  const out = new Float32Array(left + n + right);
  out.set(x, left);
  for (let i = 0; i < left; i++) out[left - 1 - i] = x[(i + 1) % n];
  for (let i = 0; i < right; i++) out[left + n + i] = x[n - 2 - (i % (n - 1))];
  return out;
}

/* --- STFT: возвращает {re, im} размера (bins × frames) построчно.
   normalized=False, поэтому никакого множителя 1/√n здесь нет. --- */
function stft(signal, frames) {
  const padded = padReflect(signal, NFFT / 2, NFFT / 2);
  const re = new Float64Array(BINS * frames);
  const im = new Float64Array(BINS * frames);
  const bufRe = new Float64Array(NFFT);
  const bufIm = new Float64Array(NFFT);

  for (let t = 0; t < frames; t++) {
    const off = t * HOP;
    for (let i = 0; i < NFFT; i++) {
      const s = off + i < padded.length ? padded[off + i] : 0;
      bufRe[i] = s * WINDOW[i];
      bufIm[i] = 0;
    }
    fft(bufRe, bufIm, false);
    for (let f = 0; f < BINS; f++) {
      re[f * frames + t] = bufRe[f];
      im[f * frames + t] = bufIm[f];
    }
  }
  return { re, im, bins: BINS, frames };
}

/* --- Обратное STFT с перекрытием-суммированием --- */
function istft(re, im, bins, frames, outLength) {
  const total = (frames - 1) * HOP + NFFT;
  const acc = new Float64Array(total);
  const wsum = new Float64Array(total);
  const bufRe = new Float64Array(NFFT);
  const bufIm = new Float64Array(NFFT);

  for (let t = 0; t < frames; t++) {
    bufRe.fill(0); bufIm.fill(0);
    for (let f = 0; f < bins; f++) {
      const r = re[f * frames + t];
      const i2 = im[f * frames + t];
      bufRe[f] = r;
      bufIm[f] = i2;
      if (f > 0 && f < NFFT / 2) {
        // Эрмитова симметрия для вещественного сигнала
        bufRe[NFFT - f] = r;
        bufIm[NFFT - f] = -i2;
      }
    }
    bufIm[0] = 0;
    bufIm[NFFT / 2] = 0;
    fft(bufRe, bufIm, true);

    const off = t * HOP;
    for (let i = 0; i < NFFT; i++) {
      const w = WINDOW[i];
      acc[off + i] += bufRe[i] * w;
      wsum[off + i] += w * w;
    }
  }

  // Снимаем центрирующее дополнение и делим на сумму квадратов окна
  const out = new Float32Array(outLength);
  const shift = NFFT / 2;
  for (let i = 0; i < outLength; i++) {
    const j = i + shift;
    if (j < total && wsum[j] > 1e-8) out[i] = acc[j] / wsum[j];
  }
  return out;
}

// В окне и в воркере модуль подключается через importScripts —
// экспортируем в глобальную область, если module недоступен
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NFFT, HOP, DIM_F, DIM_T, BINS, stft, istft, padReflect, makeFFT, WINDOW };
} else {
  self.DSP = { NFFT, HOP, DIM_F, DIM_T, BINS, stft, istft, padReflect, makeFFT, WINDOW };
}
