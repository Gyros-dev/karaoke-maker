/* ============================================================
   DSP для HTDemucs: FFT, STFT и обратное преобразование.
   Соглашения повторяют torch.stft/torch.istft с параметрами,
   которыми обучался Demucs: окно Ханна, normalized=True,
   center=True, pad_mode='reflect'.
   ============================================================ */

const NFFT = 4096;
const HOP = 1024;

/* --- Комплексное БПФ по основанию 2, на месте --- */
function makeFFT(n) {
  const levels = Math.log2(n);
  if (levels % 1 !== 0) throw new Error('Размер БПФ должен быть степенью двойки');

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

  return function fft(re, im, inverse) {
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
          const s = inverse ? sinT[k] : -sinT[k];
          const tre = re[l] * c - im[l] * s;
          const tim = re[l] * s + im[l] * c;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
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

/* --- STFT: возвращает {re, im} размера (bins × frames) построчно --- */
function stft(signal, frames) {
  const bins = NFFT / 2 + 1;
  const padded = padReflect(signal, NFFT / 2, NFFT / 2);
  const re = new Float64Array(bins * frames);
  const im = new Float64Array(bins * frames);
  const bufRe = new Float64Array(NFFT);
  const bufIm = new Float64Array(NFFT);
  const norm = 1 / Math.sqrt(NFFT); // normalized=True

  for (let t = 0; t < frames; t++) {
    const off = t * HOP;
    for (let i = 0; i < NFFT; i++) {
      const s = off + i < padded.length ? padded[off + i] : 0;
      bufRe[i] = s * WINDOW[i];
      bufIm[i] = 0;
    }
    fft(bufRe, bufIm, false);
    for (let f = 0; f < bins; f++) {
      re[f * frames + t] = bufRe[f] * norm;
      im[f * frames + t] = bufIm[f] * norm;
    }
  }
  return { re, im, bins, frames };
}

/* --- Обратное STFT с перекрытием-суммированием --- */
function istft(re, im, bins, frames, outLength) {
  const total = (frames - 1) * HOP + NFFT;
  const acc = new Float64Array(total);
  const wsum = new Float64Array(total);
  const bufRe = new Float64Array(NFFT);
  const bufIm = new Float64Array(NFFT);
  const denorm = Math.sqrt(NFFT); // обратное к normalized=True

  for (let t = 0; t < frames; t++) {
    for (let f = 0; f < bins; f++) {
      const r = re[f * frames + t] * denorm;
      const i2 = im[f * frames + t] * denorm;
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
  module.exports = { NFFT, HOP, stft, istft, padReflect, makeFFT, WINDOW };
} else {
  self.DSP = { NFFT, HOP, stft, istft, padReflect, makeFFT, WINDOW };
}
