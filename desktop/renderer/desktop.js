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
          resolve({ ok: true, left: m.left, right: m.right, sampleRate: m.sampleRate });
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
})();
