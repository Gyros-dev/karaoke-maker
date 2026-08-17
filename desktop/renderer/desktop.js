/* ============================================================
   Настольная часть: удаление вокала нейросетью.
   Работает поверх общего интерфейса — в браузерной версии
   этот файл просто не подключается.
   ============================================================ */

(function () {
  if (!window.desktop || !window.desktop.isDesktop) return;

  const MODEL_SR = 44100; // модель обучена на этой частоте
  let busy = false;

  $('ai-block').classList.remove('hidden');

  // Приложение уже установлено — предлагать его скачать незачем
  const cta = document.getElementById('desktop');
  if (cta) cta.remove();
  document.querySelectorAll('a[href="#desktop"]').forEach((a) => {
    a.replaceWith(document.createTextNode(a.textContent));
  });

  /* Обновления: сверяемся с релизами на GitHub. Автоустановку не делаем —
     сборки без подписи разработчика её не переживают, поэтому ведём
     на страницу загрузки. Проверку берёт на себя эта версия. */
  updater.handled = true;
  let updateUrl = null;

  $('update-action').addEventListener('click', async () => {
    const label = $('update-action').textContent;
    if (autoReady && label === 'Перезапустить') {
      window.desktop.installUpdate();
      return;
    }
    if (autoReady) {
      $('update-action').disabled = true;
      $('update-text').textContent = 'Скачиваем обновление…';
      const res = await window.desktop.downloadUpdate();
      if (!res.ok) {
        $('update-action').disabled = false;
        $('update-text').textContent = 'Не удалось скачать обновление';
      }
      return;
    }
    if (updateUrl) window.desktop.openExternal(updateUrl);
  });

  async function checkDesktopUpdate() {
    try {
      const res = await window.desktop.checkUpdate();
      if (!res.ok || !res.hasUpdate) return;
      if (localStorage.getItem('karaoke-skip-version') === res.latest) return;
      updater.latest = res.latest;
      updateUrl = res.url;
      showUpdateBar(
        `Вышла версия ${res.latest} — у тебя ${res.current}`,
        'Скачать');
    } catch (e) { /* нет сети — не мешаем работать */ }
  }

  /* Windows умеет обновляться сам: там показываем не ссылку,
     а кнопку, которая скачивает и ставит новую версию. */
  let autoReady = false;

  window.desktop.onAutoUpdate((m) => {
    if (m.stage === 'available') {
      autoReady = true;
      updater.latest = m.version;
      showUpdateBar(`Вышла версия ${m.version}`, 'Обновить');
    } else if (m.stage === 'progress') {
      $('update-text').textContent = `Скачиваем обновление… ${m.percent}%`;
    } else if (m.stage === 'ready') {
      $('update-text').textContent = `Версия ${m.version} готова к установке`;
      $('update-action').textContent = 'Перезапустить';
      $('update-action').disabled = false;
    } else if (m.stage === 'error') {
      $('update-text').textContent = 'Не удалось обновиться автоматически';
      $('update-action').textContent = 'Скачать вручную';
      autoReady = false;
    }
  });

  window.desktop.autoUpdateSupported().then((yes) => {
    // Где автообновления нет — обычная проверка со ссылкой на загрузку
    if (!yes) {
      setTimeout(checkDesktopUpdate, 3000);
      setInterval(checkDesktopUpdate, 6 * 60 * 60 * 1000);
    }
  });

  function setProgress(percent, status, hint) {
    $('ai-fill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (status) $('ai-status').textContent = status;
    if (hint) $('ai-hint').textContent = hint;
  }

  function showOverlay(show) {
    $('ai-overlay').classList.toggle('hidden', !show);
  }

  function fmtMB(bytes) {
    return (bytes / 1024 / 1024).toFixed(0);
  }

  /* Пересчёт частоты дискретизации через встроенный ресемплер браузера —
     качественнее самодельного и бесплатно */
  async function resample(buffer, targetRate) {
    if (Math.abs(buffer.sampleRate - targetRate) < 1) return buffer;
    const frames = Math.ceil(buffer.duration * targetRate);
    const off = new OfflineAudioContext(buffer.numberOfChannels, frames, targetRate);
    const src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start();
    return off.startRendering();
  }

  function toStereo(buffer) {
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    return { left, right };
  }

  async function ensureModel() {
    const st = await window.desktop.modelStatus();
    if (st.ready) return true;

    const ok = confirm(
      `Для удаления вокала нужна модель — ${fmtMB(st.bytes)} МБ.\n\n` +
      'Она скачается один раз и останется на компьютере: дальше всё работает без интернета. ' +
      'Скачать сейчас?');
    if (!ok) return false;

    showOverlay(true);
    setProgress(0, 'Скачиваем модель…', 'Это разовая загрузка, потом интернет не нужен.');
    window.desktop.onModelProgress(({ done, total }) => {
      setProgress((done / total) * 100,
        `Скачиваем модель… ${fmtMB(done)} из ${fmtMB(total)} МБ`);
    });
    const res = await window.desktop.downloadModel();
    if (!res.ok) {
      showOverlay(false);
      alert('Не удалось скачать модель: ' + res.error);
      return false;
    }
    return true;
  }

  let sepWorker = null;

  /* Считаем в фоновом потоке окна: тяжёлый счёт не морозит интерфейс */
  function runSeparation(modelBytes, left, right, shifts) {
    return new Promise((resolve) => {
      sepWorker = new Worker('separator-worker.js');
      sepWorker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          setProgress(m.percent, m.text, m.eta || undefined);
        } else if (m.type === 'done') {
          resolve({ ok: true, left: m.left, right: m.right, vocal: m.vocal, sampleRate: m.sampleRate });
          sepWorker.terminate();
          sepWorker = null;
        } else if (m.type === 'error') {
          resolve({ ok: false, error: m.error });
          sepWorker.terminate();
          sepWorker = null;
        }
      };
      sepWorker.onerror = (err) => {
        resolve({ ok: false, error: err.message || 'сбой в потоке расчёта' });
      };
      const l = left.slice();
      const r = right.slice();
      sepWorker.postMessage(
        { modelBytes, left: l.buffer, right: r.buffer, sampleRate: MODEL_SR, shifts },
        [l.buffer, r.buffer]);
    });
  }

  async function removeVocals() {
    if (busy) return;
    if (!state.originalBuffer) { alert('Сначала загрузи песню.'); return; }

    busy = true;
    try {
      if (!(await ensureModel())) { busy = false; return; }

      showOverlay(true);
      setProgress(0, 'Готовим звук…',
        'Считает на твоём компьютере, ничего не отправляется в интернет.');

      audio.pause();
      const src44 = await resample(state.originalBuffer, MODEL_SR);
      const { left, right } = toStereo(src44);

      setProgress(0, 'Загружаем модель…', 'Считает на твоём компьютере, ничего не отправляется в интернет.');
      const modelBytes = await window.desktop.modelBytes();
      if (!modelBytes) throw new Error('Модель не найдена');

      const shifts = Number($('ai-quality').value) || 1;
      const res = await runSeparation(modelBytes, left, right, shifts);
      if (!res.ok) {
        showOverlay(false);
        busy = false;
        if (res.error !== 'отменено') alert('Не получилось убрать вокал: ' + res.error);
        return;
      }

      setProgress(100, 'Почти готово…', 'Возвращаем исходное качество звука.');

      // Чистый вокал не выбрасываем: распознавание текста по нему
      // ошибается заметно реже, чем по полному миксу
      if (res.vocal) {
        try {
          asr.vocal = await toWhisperPcm(new Float32Array(res.vocal), MODEL_SR);
          updateAsrSource();
        } catch (e) { asr.vocal = null; }
      }

      // Собираем результат и возвращаем к частоте плеера
      const ctx = audio.ensureCtx();
      const outL = new Float32Array(res.left);
      const outR = new Float32Array(res.right);
      let buf = ctx.createBuffer(2, outL.length, MODEL_SR);
      buf.copyToChannel(outL, 0);
      buf.copyToChannel(outR, 1);
      if (Math.abs(ctx.sampleRate - MODEL_SR) > 1) buf = await resample(buf, ctx.sampleRate);
      // Защита от пиков после нейросети: иначе на старте и громких атаках
      // возможны клиппинг и цифровой треск.
      buf = normalizeInstrumental(buf, state.originalBuffer);

      audio.stop();
      state.instrumentalBuffer = buf;
      state.customInst = true;
      state.instName = shifts > 1 ? 'нейросеть (Demucs, точный режим)' : 'нейросеть (Demucs)';
      $('mono-warning').classList.add('hidden');
      updateInstUI();
      $('inst-input').value = '';

      showOverlay(false);
      busy = false;
      alert('Готово! Вокал убран нейросетью.\n\n' +
        'Минусовка уже подставлена — можно идти дальше. ' +
        'Если захочешь вернуть обычное приглушение, нажми «Убрать» в блоке минусовки.');
    } catch (err) {
      showOverlay(false);
      busy = false;
      alert('Ошибка при удалении вокала: ' + (err && err.message ? err.message : err));
    }
  }

  $('btn-ai-run').addEventListener('click', removeVocals);
  $('btn-ai-cancel').addEventListener('click', () => {
    if (sepWorker) {
      sepWorker.postMessage({ cmd: 'cancel' });
      sepWorker.terminate();
      sepWorker = null;
    }
    showOverlay(false);
    busy = false;
  });

  /* ============================================================
     Распознавание текста песни

     Whisper через transformers.js в отдельном потоке. Модель качается
     при первом использовании — так же, как модель разделения вокала.
     Слушаем чистый вокал, если он уже посчитан: по нему заметно точнее.
     ============================================================ */
  const WHISPER_SR = 16000;   // Whisper работает только на этой частоте
  const asr = { vocal: null, worker: null, busy: false, stop: null, percent: 0 };

  $('asr-block').classList.remove('hidden');

  /* Имена папок с моделями. Сборки «_timestamped» отличаются тем, что
     отдают внимание декодера к кодировщику — без него меток по словам
     не получить, а именно они нам и нужны. */
  const ASR_IDS = { base: 'whisper-base_timestamped', small: 'whisper-small_timestamped' };
  const asrModelId = (key) => ASR_IDS[key] || ASR_IDS.base;

  /* Приводим дорожку к тому, что ждёт Whisper: моно, 16 кГц */
  async function toWhisperPcm(samples, rate) {
    if (Math.abs(rate - WHISPER_SR) < 1) return samples;
    const frames = Math.max(1, Math.round(samples.length * WHISPER_SR / rate));
    const off = new OfflineAudioContext(1, frames, WHISPER_SR);
    const src = off.createBufferSource();
    const buf = off.createBuffer(1, samples.length, rate);
    buf.copyToChannel(samples, 0);
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return out.getChannelData(0).slice();
  }

  function updateAsrSource() {
    $('asr-source').textContent = asr.vocal
      ? '✓ слушаем чистый вокал'
      : '';
  }

  // Новая песня — старый вокал больше не годится
  $('file-input').addEventListener('change', () => {
    asr.vocal = null;
    updateAsrSource();
  });

  async function fillAsrModels() {
    const st = await window.desktop.asrStatus();
    const sel = $('asr-model');
    // Список перебираем целиком, поэтому выбор запоминаем: иначе после
    // скачивания крупной модели список молча прыгает обратно на обычную
    const was = sel.value;
    sel.innerHTML = '';
    st.models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.key;
      opt.textContent = m.ready ? `${m.label} — скачана` : m.label;
      sel.appendChild(opt);
    });
    if (was && st.models.some((m) => m.key === was)) sel.value = was;
    return st;
  }
  fillAsrModels().catch(() => {});

  function setAsrProgress(percent, status, hint) {
    $('asr-fill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (status) $('asr-status').textContent = status;
    if (hint !== undefined) $('asr-hint').textContent = hint;
  }

  function showAsrOverlay(show) {
    $('asr-overlay').classList.toggle('hidden', !show);
  }

  async function ensureAsrModel(key) {
    const st = await window.desktop.asrStatus();
    const model = st.models.find((m) => m.key === key);
    if (!model) return false;
    if (model.ready) return true;

    const ok = confirm(
      `Для распознавания нужна модель — около ${fmtMB(model.bytes)} МБ.\n\n` +
      'Она скачается один раз и останется на компьютере: дальше всё работает без интернета. ' +
      'Скачать сейчас?');
    if (!ok) return false;

    showAsrOverlay(true);
    setAsrProgress(0, 'Скачиваем модель распознавания…', 'Это разовая загрузка, потом интернет не нужен.');
    window.desktop.onAsrProgress(({ done, total }) => {
      setAsrProgress((done / total) * 100,
        `Скачиваем модель… ${fmtMB(done)} из ${fmtMB(total)} МБ`);
    });
    const res = await window.desktop.asrDownload(key);
    if (!res.ok) {
      showAsrOverlay(false);
      if (res.error !== 'отменено') alert('Не удалось скачать модель: ' + res.error);
      return false;
    }
    await fillAsrModels();
    return true;
  }

  function runWhisper(modelId, pcm, language) {
    return new Promise((resolve) => {
      const finish = (res) => {
        asr.stop = null;
        if (asr.worker) { asr.worker.terminate(); asr.worker = null; }
        resolve(res);
      };
      // Отмена гасит поток и сама завершает ожидание: иначе распознавание
      // «висит» недоделанным обещанием до конца работы приложения
      asr.stop = () => finish({ ok: false, error: 'отменено' });
      // Модульный поток: transformers.js поставляется как ES-модуль
      asr.worker = new Worker('whisper-worker.js', { type: 'module' });
      asr.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          asr.percent = m.percent;
          setAsrProgress(m.percent, m.text, m.eta || undefined);
        } else if (m.type === 'done') {
          finish({ ok: true, text: m.text, words: m.words });
        } else if (m.type === 'error') {
          finish({ ok: false, error: m.error });
        }
      };
      asr.worker.onerror = (err) => {
        finish({ ok: false, error: err.message || 'сбой в потоке распознавания' });
      };
      const copy = pcm.slice();
      asr.worker.postMessage({ modelId, audio: copy.buffer, language }, [copy.buffer]);
    });
  }

  /* Whisper отдаёт поток слов с метками. Караоке нужны строки, поэтому
     режем поток по паузам между словами и по длине: слишком длинная
     строка на сцене всё равно ужмётся до нечитаемого размера. */
  const LINE_GAP = 0.7;     // пауза, после которой начинается новая строка
  const LINE_MAX_CHARS = 42;
  const LINE_MAX_WORDS = 9;

  function wordsToLines(words) {
    const lines = [];
    let cur = null;
    for (const w of words) {
      let brk = !cur;
      if (cur) {
        const prev = cur.words[cur.words.length - 1];
        const gap = prev.end != null ? w.start - prev.end : 0;
        const chars = cur.text.length + 1 + w.text.length;
        if (gap > LINE_GAP) brk = true;
        // Конец фразы — самый естественный перенос
        else if (/[.!?…]$/.test(prev.text) && cur.words.length >= 2) brk = true;
        // Запятая годится, когда строка уже набралась
        else if (/[,;:—–]$/.test(prev.text) && chars > LINE_MAX_CHARS * 0.6) brk = true;
        else if (chars > LINE_MAX_CHARS || cur.words.length >= LINE_MAX_WORDS) brk = true;
      }
      if (brk) {
        cur = { text: w.text, words: [w] };
        lines.push(cur);
      } else {
        cur.text += ' ' + w.text;
        cur.words.push(w);
      }
    }
    return lines.map((l) => {
      const last = l.words[l.words.length - 1];
      const end = last.end != null ? last.end : l.words[0].start + 1;
      return {
        text: l.text,
        time: l.words[0].start,
        end,
        // Метки слов в том же виде, что делает ручное простукивание:
        // пробел приклеен к предыдущему слову
        words: l.words.map((w, i) => ({
          text: w.text + (i < l.words.length - 1 ? ' ' : ''),
          time: w.start,
          end: w.end != null ? w.end : (l.words[i + 1] ? l.words[i + 1].start : end),
        })),
      };
    });
  }

  async function recognizeLyrics() {
    if (asr.busy || busy) return;
    if (!state.originalBuffer) { alert('Сначала загрузи песню.'); return; }

    const key = $('asr-model').value || 'base';
    asr.busy = true;
    try {
      if (!(await ensureAsrModel(key))) { asr.busy = false; showAsrOverlay(false); return; }

      showAsrOverlay(true);
      setAsrProgress(0, 'Готовим звук…', 'Считает на твоём компьютере, ничего не отправляется в интернет.');
      audio.pause();

      // Чистый вокал точнее, но если его нет — слушаем полный микс
      let pcm = asr.vocal;
      if (!pcm) {
        const buf = state.originalBuffer;
        const mono = new Float32Array(buf.length);
        const ch0 = buf.getChannelData(0);
        const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
        for (let i = 0; i < buf.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
        pcm = await toWhisperPcm(mono, buf.sampleRate);
      }

      const modelId = asrModelId(key);
      const res = await runWhisper(modelId, pcm, $('asr-lang').value);
      if (!res.ok) {
        showAsrOverlay(false);
        asr.busy = false;
        if (res.error !== 'отменено') alert('Не получилось распознать текст: ' + res.error);
        return;
      }

      const lines = wordsToLines(res.words || []);
      showAsrOverlay(false);
      asr.busy = false;

      if (!lines.length) {
        alert('Распознавание ничего не разобрало.\n\n' +
          'Попробуй сначала убрать вокал нейросетью на первом шаге — ' +
          'по чистому голосу получается заметно лучше. Ещё помогает выбрать язык вручную.');
        return;
      }

      /* Текст кладём в поле — его можно править как обычно.
         Метки времени и слов запоминаем: если пользователь не станет
         менять строки, разметка подставится сама. */
      $('lyrics-input').value = lines.map((l) => l.text).join('\n');
      $('lyrics-input').dispatchEvent(new Event('input'));
      window.__asrLines = lines;

      alert(`Распознано строк: ${lines.length}.\n\n` +
        'Это черновик: пение распознаётся хуже речи, часть строк наверняка ' +
        'придётся поправить прямо в поле текста. Времена строк и слов уже проставлены — ' +
        'если текст не менять, синхронизацию можно пропустить и сразу идти в редактор.');
    } catch (err) {
      showAsrOverlay(false);
      asr.busy = false;
      alert('Ошибка при распознавании: ' + (err && err.message ? err.message : err));
    }
  }

  /* Крючок для самопроверки: прогоняет распознавание на готовом
     звуковом буфере и отдаёт то, что получилось, без окон и диалогов */
  window.__runAsrTest = async (buffer, language, key) => {
    try {
      const ch0 = buffer.getChannelData(0);
      const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
      const mono = new Float32Array(buffer.length);
      for (let i = 0; i < buffer.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
      const pcm = await toWhisperPcm(mono, buffer.sampleRate);
      asr.percent = 0;
      const res = await runWhisper(asrModelId(key),
        pcm, language || '');
      if (!res.ok) return { ok: false, error: res.error };
      const lines = wordsToLines(res.words || []);

      /* Проходим тот же путь, что и пользователь: текст в поле,
         разметка в window.__asrLines, кнопка «Дальше». Так проверяется
         и applyRecognized — что времена доезжают до строк студии. */
      $('lyrics-input').value = lines.map((l) => l.text).join('\n');
      $('lyrics-input').dispatchEvent(new Event('input'));
      window.__asrLines = lines;
      $('btn-to-sync').click();

      return {
        ok: true,
        текст: res.text,
        слов: (res.words || []).length,
        строк: lines.length,
        строки: lines.map((l) => `${l.time.toFixed(2)}–${l.end.toFixed(2)} ${l.text}`),
        слова: (res.words || []).slice(0, 12)
          .map((w) => `${w.start.toFixed(2)} ${w.text}`),
        // Полоса прогресса должна доехать дальше 10% — иначе счётчик
        // разбора слов снова оторвался от библиотеки и молчит
        прогрессДо: Math.round(asr.percent),
        // Что получила студия после переноса в шаг «Синхронизация»
        студияСтрок: state.lines.length,
        студияВремена: state.lines.map((l) => (l.time == null ? null : +l.time.toFixed(2))),
        студияСлов: state.lines.map((l) => (l.words ? l.words.length : 0)),
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };

  $('btn-asr-run').addEventListener('click', recognizeLyrics);
  $('btn-asr-cancel').addEventListener('click', () => {
    if (asr.worker) asr.worker.postMessage({ cmd: 'cancel' });
    if (asr.stop) asr.stop();
    window.desktop.asrCancel();
    showAsrOverlay(false);
    asr.busy = false;
  });
})();
