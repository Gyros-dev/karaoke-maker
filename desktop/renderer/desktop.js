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

  /* Метка для общего интерфейса: по ней CSS показывает пункты с классом
     only-desktop (нейросети) и прячет only-web (например, строку
     «а в приложении ещё…» в окне «Что нового») */
  document.body.classList.add('is-desktop');

  // Приложение уже установлено — предлагать его скачать незачем
  const cta = document.getElementById('desktop');
  if (cta) cta.remove();

  /* Пункт меню «Для компьютера» ведёт в раздел, который мы только что
     убрали, — в приложении его быть не должно вовсе. Раньше его, как и
     все прочие ссылки на раздел, разворачивали в голый текстовый узел:
     ключ перевода (data-i18n) висит на самой ссылке, вместе с ней он и
     пропадал — надпись застревала по-русски навсегда. */
  const пунктМеню = document.querySelector('.site-nav a[href="#desktop"]');
  if (пунктМеню) пунктМеню.remove();

  /* Остальные ссылки на раздел встречаются внутри переведённых абзацев
     («возьми версию для компьютера»). Там ключ стоит на абзаце, а не на
     ссылке, поэтому её и правда достаточно развернуть в текст. Делать
     это надо заново после каждой смены языка: перевод абзаца кладётся
     через innerHTML и приносит ссылку обратно. */
  function развернутьСсылкиНаРаздел() {
    document.querySelectorAll('a[href="#desktop"]').forEach((a) => {
      a.replaceWith(document.createTextNode(a.textContent));
    });
  }
  развернутьСсылкиНаРаздел();
  document.addEventListener('i18n', развернутьСсылкиНаРаздел);

  /* Обновления: сверяемся с релизами на GitHub. Автоустановку не делаем —
     сборки без подписи разработчика её не переживают, поэтому ведём
     на страницу загрузки. Проверку берёт на себя эта версия. */
  updater.handled = true;
  let updateUrl = null;

  $('update-action').addEventListener('click', async () => {
    if (autoReady && готовоКУстановке) {
      window.desktop.installUpdate();
      return;
    }
    if (autoReady) {
      $('update-action').disabled = true;
      $('update-text').textContent = t('обновление.скачиваем');
      const res = await window.desktop.downloadUpdate();
      if (!res.ok) {
        $('update-action').disabled = false;
        $('update-text').textContent = t('обновление.неСкачалось');
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
      updater.перерисовать = () => showUpdateBar(
        t('обновление.версия', { v: res.latest, 'текущая': res.current }),
        t('обновление.скачать'));
      updater.перерисовать();
    } catch (e) { /* нет сети — не мешаем работать */ }
  }

  /* Windows умеет обновляться сам: там показываем не ссылку,
     а кнопку, которая скачивает и ставит новую версию. */
  let autoReady = false;
  /* Готовность к установке держим отдельным признаком, а не сверяем
     подпись кнопки со словом «Перезапустить»: подпись переводится,
     и на английском такое сравнение молча перестало бы срабатывать. */
  let готовоКУстановке = false;

  window.desktop.onAutoUpdate((m) => {
    if (m.stage === 'available') {
      autoReady = true;
      готовоКУстановке = false;
      updater.latest = m.version;
      updater.перерисовать = () => showUpdateBar(
        t('обновление.версияПросто', { v: m.version }), t('обновление.обновить'));
      updater.перерисовать();
    } else if (m.stage === 'progress') {
      updater.перерисовать = null;
      $('update-text').textContent = t('обновление.скачиваемПроцент', { p: m.percent });
    } else if (m.stage === 'ready') {
      готовоКУстановке = true;
      updater.перерисовать = () => showUpdateBar(
        t('обновление.готово', { v: m.version }), t('обновление.перезапустить'));
      updater.перерисовать();
      $('update-action').disabled = false;
    } else if (m.stage === 'error') {
      готовоКУстановке = false;
      updater.перерисовать = () => showUpdateBar(
        t('обновление.неАвто'), t('обновление.вручную'));
      updater.перерисовать();
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

  /* ---------- Надписи прогресса из фоновых потоков ----------
     Воркеры лежат отдельными файлами, словаря у них нет и про
     выбранный язык они не знают, поэтому шлют ключ и числа.
     Строку складываем здесь. */
  function текстПрогресса(m) {
    return m.ключ ? t(m.ключ, m.парам || {}) : (m.text || '');
  }

  /* Остаток времени воркеры округляют каждый по-своему (разделение —
     до шести секунд, распознавание — до десяти), поэтому число и
     единицу присылают уже готовыми, а мы только подписываем.
     Пусто — возвращаем undefined: прежнюю подсказку тогда не трогаем. */
  function осталосьСловами(о) {
    if (!о) return undefined;
    return t(о.единица === 'мин' ? 'время.осталосьМин' : 'время.осталосьСек', { n: о.n });
  }

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

  /* ============================================================
     Сколько это займёт

     Считает всё на своём компьютере, и это небыстро: разделение
     и крупная модель распознавания вместе легко съедают четверть
     часа. Поэтому время показываем ЗАРАНЕЕ, до нажатия кнопки, —
     чтобы человек не гадал, считает оно или повисло.

     Коэффициенты — секунды счёта на секунду звука. Замерено на этом
     Маке:
       • разделение MDX-Net одним проходом — около 1,2 длины трека
         (модель считает кусок 5,9 с примерно за 4,5 с плюс своё
         преобразование Фурье; прежняя htdemucs шла за 0,9, новая
         чуть медленнее, зато заметно чище);
       • распознавание по миксу: обычная модель ≈0,6, крупная ≈1,2;
       • по чистому вокалу нейросеть возится дольше, чем по миксу,
         примерно в 1,75 раза (355 с против 202 с).

     Компьютеры разные, поэтому после каждого настоящего прогона
     запоминаем свою скорость и дальше считаем уже по ней. */
  const СКОРОСТЬ = {
    разделение: 1.2,
    распознавание: { base: 0.60, small: 1.17 },
    вокалДороже: 1.75,
  };
  const КЛЮЧ_СКОРОСТИ = 'karaoke-speed';

  function замеры() {
    try { return JSON.parse(localStorage.getItem(КЛЮЧ_СКОРОСТИ)) || {}; }
    catch (e) { return {}; }
  }

  /* Один странный прогон не должен ломать оценку, поэтому копим среднее.
     Совсем дикие значения (нейросеть отменили на первой секунде, машина
     ушла в своп) отбрасываем. */
  function запомнитьСкорость(что, значение) {
    if (!Number.isFinite(значение) || значение <= 0.02 || значение > 60) return;
    const все = замеры();
    все[что] = все[что] > 0 ? все[что] * 0.5 + значение * 0.5 : значение;
    try { localStorage.setItem(КЛЮЧ_СКОРОСТИ, JSON.stringify(все)); } catch (e) { /* некуда писать — не беда */ }
  }

  const длинаПесни = () => (state.originalBuffer ? state.originalBuffer.duration : 0);

  function оценкаРазделения(секунд, проходов) {
    const своя = замеры().разделение;
    return секунд * (своя > 0 ? своя : СКОРОСТЬ.разделение) * (проходов || 1);
  }

  function оценкаРаспознавания(секунд, ключ, поВокалу) {
    const своя = замеры()['распознавание:' + ключ];
    const базовая = СКОРОСТЬ.распознавание[ключ] || СКОРОСТЬ.распознавание.small;
    return секунд * (своя > 0 ? своя : базовая) * (поВокалу ? СКОРОСТЬ.вокалДороже : 1);
  }

  /* Вилка честнее одной цифры: наши коэффициенты сняты с одной машины,
     а считать будут на самых разных. Пока своих замеров нет, разброс
     берём шире; после первого настоящего прогона сужаем.

     Склонение считает словарь: по-русски «1–2 минуты», «5–9 минут»,
     «20–21 минуты», по-английски minute/minutes — правила разные,
     поэтому форму выбирает Intl.PluralRules по последнему числу. */
  function времяСловами(секунд, откалибровано) {
    if (!Number.isFinite(секунд) || секунд <= 0) return t('время.несколькоМинут');
    if (секунд < 40) return t('время.меньшеМинуты');
    const мин = секунд / 60;
    const от = Math.max(1, Math.floor(мин * (откалибровано ? 0.85 : 0.75)));
    const до = Math.max(от + 1, Math.ceil(мин * (откалибровано ? 1.2 : 1.3)));
    return t('время.вилка', { 'от': от, n: до });
  }

  /* Строка оценки под блоком. Собираем узлами, а не разметкой: текст
     тут наш, но правило проекта одно для всех — никакого innerHTML. */
  function поставитьОценку(el, время, хвост) {
    el.textContent = '';
    // Значок из общего спрайта (см. значокSVG в app.js) вместо ⏳:
    // эмодзи-часы выглядят по-разному на macOS и Windows
    el.appendChild(значокSVG('hourglass'));
    el.append(' ');
    if (время) {
      el.append(t('время.займёт'));
      const b = document.createElement('b');
      b.textContent = время;
      el.append(b, '. ');
    }
    el.append(хвост);
  }

  // Та же оценка в окне прогресса — там ждать и приходится
  const подсказкаПрогресса = (время) => (время
    ? t('время.прикидка', { 'время': время })
    : t('время.локально'));

  /* ---------- Оценка для разделения вокала ---------- */
  function обновитьВремяРазделения() {
    const проходов = Number($('ai-quality').value) || 1;
    const длина = длинаПесни();
    const хвост = проходов > 1
      ? t('ии.проходовМного', { n: проходов })
      : t('ии.проходОдин');
    поставитьОценку($('ai-eta'),
      длина ? времяСловами(оценкаРазделения(длина, проходов), замеры().разделение > 0) : '',
      длина ? хвост : t('время.когдаЗагрузишь') + хвост);
  }
  $('ai-quality').addEventListener('change', обновитьВремяРазделения);
  обновитьВремяРазделения();

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

  /* Прежняя модель Demucs (172 МБ) после перехода на MDX-Net не нужна.
     Сами её не стираем: место на диске чужое, и человек мог оставить
     её нарочно. Спрашиваем один раз — отказ запоминаем, чтобы не
     доставать вопросом при каждом запуске. */
  const КЛЮЧ_СТАРОЙ = 'karaoke-старая-модель-спрошено';
  async function предложитьУбратьСтарую(st) {
    if (!st || !st.старая) return;
    try { if (localStorage.getItem(КЛЮЧ_СТАРОЙ)) return; } catch (e) { /* нет хранилища — спросим */ }
    try { localStorage.setItem(КЛЮЧ_СТАРОЙ, '1'); } catch (e) { /* не беда */ }
    const ok = confirm(t('ии.стараяМодель', { 'мб': fmtMB(st.старая.bytes) }));
    if (!ok) return;
    const res = await window.desktop.removeOldModel();
    if (!res.ok) alert(t('ии.стараяНеУдалилась') + res.error);
  }

  async function ensureModel() {
    const st = await window.desktop.modelStatus();
    await предложитьУбратьСтарую(st);
    if (st.ready) return true;

    /* Битую модель объясняем словами. Раньше обрезанный файл считался
       готовым, разделение падало с английским «protobuf parsing failed»,
       и человек не понимал ни что случилось, ни что делать. */
    const ok = confirm(st.broken
      ? t('ии.модельБитая', { 'есть': fmtMB(st.have), 'всего': fmtMB(st.bytes) })
      : t('ии.модельНужна', { 'мб': fmtMB(st.bytes) }));
    if (!ok) return false;

    showOverlay(true);
    setProgress(0, t('ии.скачиваемМодель'), t('ии.разоваяЗагрузка'));
    window.desktop.onModelProgress(({ done, total }) => {
      setProgress((done / total) * 100,
        t('ии.скачиваемХод', { 'есть': fmtMB(done), 'всего': fmtMB(total) }));
    });
    const res = await window.desktop.downloadModel();
    if (!res.ok) {
      showOverlay(false);
      alert(t('ии.модельНеСкачалась') + res.error);
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
          setProgress(m.percent, текстПрогресса(m), осталосьСловами(m.осталось));
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
        resolve({ ok: false, error: err.message || t('ии.сбойПотока') });
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
    if (!state.originalBuffer) { alert(t('ии.сначалаПесня')); return; }

    busy = true;
    try {
      if (!(await ensureModel())) { busy = false; return; }

      // Умолчание — один проход: остальные ничего не добавляют
      const shifts = Number($('ai-quality').value) || 1;
      const длина = длинаПесни();
      const прикидка = времяСловами(оценкаРазделения(длина, shifts), замеры().разделение > 0);

      showOverlay(true);
      setProgress(0, t('ии.готовимЗвук'), подсказкаПрогресса(прикидка));

      audio.pause();
      const src44 = await resample(state.originalBuffer, MODEL_SR);
      const { left, right } = toStereo(src44);

      setProgress(0, t('ии.загружаемМодель'), подсказкаПрогресса(прикидка));
      const modelBytes = await window.desktop.modelBytes();
      if (!modelBytes) throw new Error(t('ии.модельНеНайдена'));

      const началоСчёта = Date.now();
      const res = await runSeparation(modelBytes, left, right, shifts);
      if (!res.ok) {
        showOverlay(false);
        busy = false;
        if (res.error !== 'отменено') alert(t('ии.неПолучилось') + res.error);
        return;
      }

      // Своя скорость: следующая оценка будет уже по этой машине
      if (длина > 5) {
        запомнитьСкорость('разделение',
          ((Date.now() - началоСчёта) / 1000) / (длина * shifts));
      }

      setProgress(100, t('ии.почтиГотово'), t('ии.возвращаемКачество'));

      // Чистый вокал не выбрасываем: распознавание текста по нему
      // ошибается заметно реже, чем по полному миксу, а огибающая его
      // громкости говорит сцене, где на самом деле поют, а где проигрыш
      if (res.vocal) {
        try { setVoiceTrack(new Float32Array(res.vocal), MODEL_SR); } catch (e) { /* не беда */ }
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
      buf = normalizeInstrumental(buf);

      audio.stop();
      state.instrumentalBuffer = buf;
      state.customInst = true;
      state.instName = shifts > 1
        ? t('ии.имяНесколько', { n: shifts })
        : t('ии.имя');
      $('mono-warning').classList.add('hidden');
      updateInstUI();
      $('inst-input').value = '';

      showOverlay(false);
      busy = false;
      alert(t('ии.готово'));
    } catch (err) {
      showOverlay(false);
      busy = false;
      alert(t('ии.ошибка') + (err && err.message ? err.message : err));
    }
  }

  $('btn-ai-run').addEventListener('click', removeVocals);
  $('btn-ai-cancel').addEventListener('click', () => {
    if (sepWorker) {
      sepWorker.postMessage({ cmd: 'cancel' });
      sepWorker.terminate();
      sepWorker = null;
    }
    /* Отмена должна отменять и скачивание, а не только расчёт: раньше
       172 МБ продолжали качаться после нажатия «Отмена», и повторный
       запуск начинал вторую загрузку в тот же файл. */
    if (window.desktop.cancelModelDownload) window.desktop.cancelModelDownload();
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

  /* Умолчание — лучшее, что у нас есть: крупная модель разбирает пение
     заметно увереннее обычной. Обычная никуда не делась, но убрана
     в свёрнутое «Ещё варианты» — она вдвое быстрее и хуже. */
  const ASR_ЛУЧШАЯ = 'small';
  const asrModelId = (key) => ASR_IDS[key] || ASR_IDS[ASR_ЛУЧШАЯ];

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
    $('asr-source').textContent = asr.vocal ? t('asr.чистыйВокал') : '';
    // По чистому вокалу нейросеть возится дольше — оценку надо пересчитать
    обновитьВремяРаспознавания();
  }

  /* ---------- Оценка для распознавания ---------- */
  function обновитьВремяРаспознавания() {
    const ключ = $('asr-model').value || ASR_ЛУЧШАЯ;
    const длина = длинаПесни();
    const поВокалу = !!asr.vocal;
    let хвост = t(ключ === 'base' ? 'asr.хвост.обычная' : 'asr.хвост.крупная');
    if (поВокалу) хвост += t('asr.хвост.вокал');
    поставитьОценку($('asr-eta'),
      длина ? времяСловами(оценкаРаспознавания(длина, ключ, поВокалу),
        замеры()['распознавание:' + ключ] > 0) : '',
      длина ? хвост : t('время.когдаЗагрузишь') + хвост);
  }

  /* app.js общий с сайтом, править его нельзя, а про новую песню знать
     надо: как только заполнится строка с длительностью трека —
     пересчитываем обе оценки.

     Следим именно за #track-meta, а не за всей карточкой: строка оценки
     #ai-eta лежит внутри карточки, и наблюдение за её поддеревом
     закольцевалось бы — обработчик правит текст, правка будит
     обработчик, и окно намертво замирает. */
  const строкаТрека = document.getElementById('track-meta');
  if (строкаТрека) {
    new MutationObserver(() => {
      обновитьВремяРазделения();
      обновитьВремяРаспознавания();
    }).observe(строкаТрека, { childList: true, characterData: true, subtree: true });
  }

  // Новая песня — старый вокал больше не годится
  $('file-input').addEventListener('change', () => {
    asr.vocal = null;
    updateAsrSource();
  });

  /* Подписи моделей на текущем языке. Отдельно от fillAsrModels,
     потому что та спрашивает систему и ждёт ответа: при смене языка
     список успел бы остаться на прежнем языке до конца ожидания. */
  function перевестиМодели() {
    [...$('asr-model').options].forEach((o) => {
      const label = t('asr.модель.' + o.value);
      o.textContent = o.dataset.готова ? t('asr.модель.скачана', { label }) : label;
    });
  }

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
      /* Подпись переводим здесь, а не в главном процессе: там про
         выбранный язык не знают, а список всё равно пересобирается.
         Скачанность держим на самом пункте — по ней перевод потом
         соберёт подпись заново, не спрашивая систему второй раз. */
      opt.dataset.готова = m.ready ? '1' : '';
      sel.appendChild(opt);
    });
    перевестиМодели();
    // Выбор человека важнее, но по умолчанию — лучшая модель
    if (was && st.models.some((m) => m.key === was)) sel.value = was;
    else if (st.models.some((m) => m.key === ASR_ЛУЧШАЯ)) sel.value = ASR_ЛУЧШАЯ;
    обновитьВремяРаспознавания();
    return st;
  }
  fillAsrModels().catch(() => {});
  $('asr-model').addEventListener('change', обновитьВремяРаспознавания);
  обновитьВремяРаспознавания();

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

    const ok = confirm(t('asr.модельНужна', { 'мб': fmtMB(model.bytes) }));
    if (!ok) return false;

    showAsrOverlay(true);
    setAsrProgress(0, t('asr.скачиваемМодель'), t('ии.разоваяЗагрузка'));
    window.desktop.onAsrProgress(({ done, total }) => {
      setAsrProgress((done / total) * 100,
        t('ии.скачиваемХод', { 'есть': fmtMB(done), 'всего': fmtMB(total) }));
    });
    const res = await window.desktop.asrDownload(key);
    if (!res.ok) {
      showAsrOverlay(false);
      if (res.error !== 'отменено') alert(t('asr.модельНеСкачалась') + res.error);
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
          setAsrProgress(m.percent, текстПрогресса(m), осталосьСловами(m.осталось));
        } else if (m.type === 'done') {
          finish({ ok: true, text: m.text, words: m.words, отладка: m.отладка });
        } else if (m.type === 'error') {
          finish({ ok: false, error: m.error });
        }
      };
      asr.worker.onerror = (err) => {
        finish({ ok: false, error: err.message || t('asr.сбойПотока') });
      };
      const copy = pcm.slice();
      asr.worker.postMessage(
        { modelId, audio: copy.buffer, language, debug: !!window.__asrDebug },
        [copy.buffer]);
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
    /* Последняя подстраховка от зацикливания: петлю ловит и рвёт сам
       воркер, но если одна всё же просочилась, она даст вереницу
       совершенно одинаковых строк — на сцене это выглядит хуже всего.
       Три повтора подряд оставляем: и в припевах строки честно
       повторяются, и длинный распев «да-да-да…» занимает пару строк. */
    const REPEAT_LINES = 3;
    const kept = [];
    let sameKey = null;
    let same = 0;
    for (const l of lines) {
      const key = l.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (key && key === sameKey) same++;
      else { same = 1; sameKey = key; }
      if (same > REPEAT_LINES) continue;
      kept.push(l);
    }

    return kept.map((l) => {
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

  /* Общая часть обоих режимов: проверить модель, приготовить звук
     и послушать песню. Возвращает слова с метками времени. */
  async function listenToSong(key) {
    if (!(await ensureAsrModel(key))) return { ok: false, error: 'отменено' };

    const длина = длинаПесни();
    const поВокалу = !!asr.vocal;
    const прикидка = времяСловами(оценкаРаспознавания(длина, key, поВокалу),
      замеры()['распознавание:' + key] > 0);

    showAsrOverlay(true);
    setAsrProgress(0, t('asr.готовимЗвук'), подсказкаПрогресса(прикидка));
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

    const началоСчёта = Date.now();
    const res = await runWhisper(asrModelId(key), pcm, $('asr-lang').value);
    // Своя скорость: следующая оценка будет уже по этой машине
    if (res.ok && длина > 5) {
      запомнитьСкорость('распознавание:' + key,
        ((Date.now() - началоСчёта) / 1000) / (длина * (поВокалу ? СКОРОСТЬ.вокалДороже : 1)));
    }
    return res;
  }

  /* ---------- Метка о готовой разметке ----------
     Расчёт долгий, и раньше по его окончании на экране не оставалось
     никакого следа: окно с итогом закрыли — и непонятно, проставились
     ли времена. Метка живёт в блоке разметки, поэтому переживает
     переход на другой шаг и обратно, и меняется только тогда, когда
     разметку делают заново.

     Текст кладём только через textContent: политика безопасности
     запрещает вставлять разметку строкой. */
  /* Метку помним не строками, а тем, как её собрать: при смене языка
     она обязана перевестись вместе со всем остальным. Поэтому сюда
     передают не текст, а функцию, отдающую пару «заголовок, пояснение»
     на текущем языке (или null — тогда метка прячется). */
  let собратьИтог = null;

  function показатьИтогРазметки(собрать, безПрокрутки) {
    собратьИтог = собрать || null;
    const узел = $('asr-result');
    if (!узел) return;
    const о = собратьИтог ? собратьИтог() : null;
    const заголовок = о ? о.заголовок : '';
    const пояснение = о ? о.пояснение : '';
    $('asr-result-head').textContent = заголовок || '';
    $('asr-result-note').textContent = заголовок ? (пояснение || '') : '';
    узел.classList.toggle('hidden', !заголовок);
    /* Блок разметки прокручивается внутри своей колонки, и метка могла
       оказаться выше видимой части. Подводим её к глазам — «nearest»,
       чтобы не дёргать заодно всю страницу. */
    if (заголовок && !безПрокрутки) узел.scrollIntoView({ block: 'nearest' });
  }

  async function recognizeLyrics() {
    if (asr.busy || busy) return;
    if (!state.originalBuffer) { alert(t('asr.сначалаПесня')); return; }

    const key = $('asr-model').value || ASR_ЛУЧШАЯ;
    asr.busy = true;
    try {
      const res = await listenToSong(key);
      if (!res.ok) {
        showAsrOverlay(false);
        asr.busy = false;
        if (res.error !== 'отменено') alert(t('asr.неРаспозналось') + res.error);
        return;
      }

      const lines = wordsToLines(res.words || []);
      showAsrOverlay(false);
      asr.busy = false;

      if (!lines.length) {
        alert(t('asr.ничегоНеРазобрало'));
        return;
      }

      /* Текст кладём в поле — его можно править как обычно.
         Метки времени и слов запоминаем: если пользователь не станет
         менять строки, разметка подставится сама. */
      $('lyrics-input').value = lines.map((l) => l.text).join('\n');
      $('lyrics-input').dispatchEvent(new Event('input'));
      window.__asrLines = lines;
      показатьИтогРазметки(() => ({
        заголовок: t('asr.меткаРаспознано', { n: lines.length }),
        пояснение: t('asr.меткаРаспознаноХвост'),
      }));

      alert(t('asr.итогРаспознано', { n: lines.length }));
    } catch (err) {
      showAsrOverlay(false);
      asr.busy = false;
      alert(t('asr.ошибка') + (err && err.message ? err.message : err));
    }
  }

  /* ---------- Подгонка своего текста ----------
     Главный способ работы: буквы берём у человека, времена — у
     нейросети. Сама раскладка живёт в align.js. */
  async function fitLyrics() {
    if (asr.busy || busy) return;
    if (!state.originalBuffer) { alert(t('asr.сначалаПесня')); return; }
    const text = $('lyrics-input').value;
    if (!text.trim()) { alert(t('asr.сначалаТекст')); return; }

    const key = $('asr-model').value || ASR_ЛУЧШАЯ;
    asr.busy = true;
    try {
      const res = await listenToSong(key);
      if (!res.ok) {
        showAsrOverlay(false);
        asr.busy = false;
        if (res.error !== 'отменено') alert(t('asr.неПослушалось') + res.error);
        return;
      }

      setAsrProgress(99, t('asr.раскладываем'), '');
      const fit = Align.fit(text, res.words || [], { duration: state.originalBuffer.duration });
      showAsrOverlay(false);
      asr.busy = false;

      if (!fit.ok) {
        alert(t('asr.неПодогналось', { 'ошибка': t(fit.error) }));
        return;
      }

      /* Текст пользователя не трогаем: подставляем только времена.
         Дальше их заберёт applyRecognized при переходе в редактор. */
      window.__asrLines = fit.lines;
      $('lyrics-input').dispatchEvent(new Event('input'));

      const с = fit.статистика;
      const процент = Math.round(с.доляОпор * 100);
      показатьИтогРазметки(() => ({
        заголовок: t('asr.меткаВремена', { 'строк': с.строк, 'слов': с.словТекста }),
        пояснение: t('asr.меткаРасслышала', { 'процент': процент }) + (с.сомнительныхСтрок
          ? t('asr.меткаСомнительных', { n: с.сомнительныхСтрок })
          : t('asr.меткаБезСомнительных')),
      }));
      let итог = t('asr.итогРазложено',
        { 'строк': с.строк, 'слов': с.словТекста, 'процент': процент });
      if (с.сомнительныхСтрок) {
        итог += t('asr.итогСомнительные', { n: с.сомнительныхСтрок });
      }
      итог += t('asr.итогХвост');
      alert(итог);
    } catch (err) {
      showAsrOverlay(false);
      asr.busy = false;
      alert(t('asr.ошибкаПодгонки') + (err && err.message ? err.message : err));
    }
  }

  /* Поле пустое — распознаём с нуля, поле заполнено — подгоняем.
     Кнопка и пояснение меняются вместе, чтобы человек видел заранее,
     что произойдёт, и не затёр свой текст случайно. */
  function updateAsrMode() {
    const есть = !!$('lyrics-input').value.trim();
    $('btn-asr-run').textContent = t(есть ? 'asr.кнопка.подогнать' : 'asr.кнопка.распознать');
    $('btn-asr-fresh').classList.toggle('hidden', !есть);
    $('asr-about-fit').classList.toggle('hidden', !есть);
    $('asr-about-fresh').classList.toggle('hidden', есть);
    /* Поле опустошили — метка о прежней разметке врёт: размечать
       больше нечего. Правку отдельных строк она переживает: времена
       остальных строк от этого не портятся. */
    if (!есть) показатьИтогРазметки(null);
  }
  $('lyrics-input').addEventListener('input', updateAsrMode);
  updateAsrMode();

  /* ---------- Крючки для самопроверки ----------
     Прогоняют то же самое, что и кнопки, но без окон и диалогов.

     opts.separate — сначала выделить вокал нейросетью и слушать его,
     как и задумано в приложении: по чистому голосу ошибок меньше.
     opts.words — готовые слова с метками из прошлого прогона: подгонку
     тогда можно проверять за секунду, не гоняя нейросеть заново. */

  /* Оценка времени без песни: самопроверка подставляет длину в секундах
     и сверяет цифры с настоящими замерами, чтобы мы не наврали в разы. */
  window.__оценкаВремени = (секунд) => ({
    разделениеБыстро: Math.round(оценкаРазделения(секунд, 1)),
    разделениеЛучшее: Math.round(оценкаРазделения(секунд, 3)),
    распознаваниеОбычная: Math.round(оценкаРаспознавания(секунд, 'base', false)),
    распознаваниеКрупная: Math.round(оценкаРаспознавания(секунд, 'small', false)),
    распознаваниеПоВокалу: Math.round(оценкаРаспознавания(секунд, 'small', true)),
    словами: времяСловами(оценкаРазделения(секунд, 3), false),
    короткое: времяСловами(20, false),
    пустое: времяСловами(0, false),
  });

  // Звук для проверок: либо чистый вокал нейросети, либо полный микс
  async function testPcm(buffer, opts) {
    if (opts && opts.separate) {
      const modelBytes = await window.desktop.modelBytes();
      if (!modelBytes) throw new Error('модель разделения не скачана');
      const src44 = await resample(buffer, MODEL_SR);
      const { left, right } = toStereo(src44);
      const sepRes = await runSeparation(modelBytes, left, right, 1);
      if (!sepRes.ok) throw new Error('разделение: ' + sepRes.error);
      if (!sepRes.vocal) throw new Error('разделение не отдало вокал');
      setVoiceTrack(new Float32Array(sepRes.vocal), MODEL_SR);
      return {
        pcm: await toWhisperPcm(new Float32Array(sepRes.vocal), MODEL_SR),
        источник: 'чистый вокал',
      };
    }
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    const mono = new Float32Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
    return { pcm: await toWhisperPcm(mono, buffer.sampleRate), источник: 'полный микс' };
  }

  // Послушать песню (или взять готовые слова из прошлого прогона)
  async function testListen(buffer, language, key, opts) {
    if (opts && opts.words && opts.words.length) {
      return { ok: true, words: opts.words, готовое: true, источник: 'слова из файла' };
    }
    const { pcm, источник } = await testPcm(buffer, opts);
    asr.percent = 0;
    const res = await runWhisper(asrModelId(key), pcm, language || '');
    return { ...res, источник };
  }

  /* Огибающая голоса для проверок: сохранить в файл и подставить обратно.
     Разделение трёхминутной песни идёт пару минут, а пороги сцены хочется
     подбирать за секунды — поэтому огибающую можно один раз выгрузить
     и дальше гонять проверки уже с ней. */
  window.__voiceDump = () => (voice.level ? voiceToText(voice.level) : null);
  window.__voiceLoad = (text, duration) => {
    restoreVoiceTrack(text, duration);
    return voiceReady();
  };

  /* Что получилось на сцене: размах каждой строки, проигрыши и паузы.
     Считается теми же самыми lineSpan и stagePhase, что рисуют караоке
     и видео, — иначе цифры проверки ничего бы не значили. */
  window.__sceneReport = () => {
    const lines = syncedLines();
    const spans = lines.map((l, i) => lineSpan(lines, i));
    const проигрыши = [];
    const first = spans.length ? spans[0].start : 0;
    if (first >= BREAK_MIN) проигрыши.push({ от: 0, до: +first.toFixed(2), длина: +first.toFixed(2), после: 'вступление' });
    for (let i = 0; i + 1 < lines.length; i++) {
      const пауза = spans[i + 1].start - spans[i].end;
      if (пауза >= BREAK_MIN) {
        проигрыши.push({
          от: +spans[i].end.toFixed(2), до: +spans[i + 1].start.toFixed(2),
          длина: +пауза.toFixed(2), после: lines[i].text.slice(0, 30),
        });
      }
    }
    return {
      голосЕсть: voiceReady(),
      кусковГолоса: voice.runs ? voice.runs.length : 0,
      куски: (voice.runs || []).map((r) => `${r.start.toFixed(2)}–${r.end.toFixed(2)}`),
      порогПроигрыша: BREAK_MIN,
      проигрышей: проигрыши.length,
      проигрыши,
      // Все паузы между строками — по ним видно, каким мог бы быть порог
      паузы: lines.slice(0, -1).map((l, i) => +(spans[i + 1].start - spans[i].end).toFixed(2)),
      строки: lines.map((l, i) => ({
        i,
        сырое: +l.time.toFixed(2),
        старт: +spans[i].start.toFixed(2),
        сдвиг: +(spans[i].start - l.time).toFixed(2),
        конец: +spans[i].end.toFixed(2),
        длина: +(spans[i].end - spans[i].start).toFixed(2),
        текст: l.text,
      })),
    };
  };

  window.__runAsrTest = async (buffer, language, key, opts) => {
    try {
      const res = await testListen(buffer, language, key, opts);
      if (!res.ok) return { ok: false, error: res.error };
      const lines = wordsToLines(res.words || []);

      /* Проходим тот же путь, что и пользователь: текст в поле,
         разметка в window.__asrLines, кнопка «Дальше». Так проверяется
         и applyRecognized — что времена доезжают до строк студии. */
      $('lyrics-input').value = lines.map((l) => l.text).join('\n');
      $('lyrics-input').dispatchEvent(new Event('input'));
      window.__asrLines = lines;
      $('btn-to-editor').click();

      return {
        ok: true,
        источник: res.источник,
        откат: res.отладка,
        текст: res.text,
        слов: (res.words || []).length,
        строк: lines.length,
        строки: lines.map((l) => `${l.time.toFixed(2)}–${l.end.toFixed(2)} ${l.text}`),
        слова: (res.words || []).slice(0, 12)
          .map((w) => `${w.start.toFixed(2)} ${w.text}`),
        // Полоса прогресса должна доехать дальше 10% — иначе счётчик
        // разбора слов снова оторвался от библиотеки и молчит
        прогрессДо: Math.round(asr.percent),
        // Что получила студия после переноса в редактор
        студияСтрок: state.lines.length,
        студияВремена: state.lines.map((l) => (l.time == null ? null : +l.time.toFixed(2))),
        студияСлов: state.lines.map((l) => (l.words ? l.words.length : 0)),
        // Чтобы сохранить слова и потом гонять подгонку без нейросети
        всеСлова: res.words || [],
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };

  /* Подгонка своего текста: слушаем песню и раскладываем по ней
     готовый текст. Отдаём цифры, по которым видно, получилось или нет. */
  window.__runFitTest = async (buffer, text, language, key, opts) => {
    try {
      // Без песни в студии сцена не знает длины трека и обрежет последнюю строку
      state.originalBuffer = buffer;
      const res = await testListen(buffer, language, key, opts);
      if (!res.ok) return { ok: false, error: res.error };

      const fit = Align.fit(text, res.words || [], { duration: buffer.duration });
      if (!fit.ok) return { ok: false, error: fit.error, всеСлова: res.words || [] };

      // Тот же путь, что у пользователя: текст в поле, времена рядом
      $('lyrics-input').value = text;
      $('lyrics-input').dispatchEvent(new Event('input'));
      window.__asrLines = fit.lines;
      const с = fit.статистика;
      показатьИтогРазметки(() => ({
        заголовок: t('asr.меткаВремена', { 'строк': с.строк, 'слов': с.словТекста }),
        пояснение: t('asr.меткаРасслышала', { 'процент': Math.round(с.доляОпор * 100) })
          + (с.сомнительныхСтрок
            ? t('asr.меткаСомнительных', { n: с.сомнительныхСтрок })
            : t('asr.меткаБезСомнительных')),
      }));
      $('btn-to-editor').click();

      const времена = state.lines.map((l) => (l.time == null ? null : +l.time.toFixed(2)));
      let порядок = true;
      for (let i = 1; i < времена.length; i++) {
        if (времена[i] == null || времена[i - 1] == null || времена[i] <= времена[i - 1]) порядок = false;
      }

      return {
        ok: true,
        источник: res.источник,
        откат: res.отладка,
        длина: +buffer.duration.toFixed(1),
        ...fit.статистика,
        // Что доехало до студии — там же проверяется applyRecognized
        студияСтрок: state.lines.length,
        студияБезВремени: state.lines.filter((l) => l.time == null).length,
        студияПорядокСтрок: порядок,
        студияСомнительных: state.lines.filter((l) => l.сомнительная).length,
        /* Метка о готовой разметке. Читаем её уже с третьего шага —
           заодно видно, что переход на другой шаг она переживает. */
        меткаРазметки: $('asr-result').classList.contains('hidden') ? null
          : $('asr-result-head').textContent + $('asr-result-note').textContent,
        строки: state.lines.map((l, i) =>
          `${(l.time == null ? 0 : l.time).toFixed(2)} ${fit.lines[i] && fit.lines[i].сомнительная ? '≈' : ' '} ${l.text}`),
        опорыПоСтрокам: fit.lines.map((l) => `${l.опор}/${l.слов}`),
        сцена: window.__sceneReport(),
        всеСлова: res.words || [],
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };

  $('btn-asr-run').addEventListener('click', () => {
    if ($('lyrics-input').value.trim()) fitLyrics();
    else recognizeLyrics();
  });

  /* Свободное распознавание при непустом поле затрёт чужую работу,
     поэтому прячем его во вторую кнопку и переспрашиваем */
  $('btn-asr-fresh').addEventListener('click', () => {
    const ok = confirm(t('asr.сНуляВопрос'));
    if (ok) recognizeLyrics();
  });
  $('btn-asr-cancel').addEventListener('click', () => {
    if (asr.worker) asr.worker.postMessage({ cmd: 'cancel' });
    if (asr.stop) asr.stop();
    window.desktop.asrCancel();
    showAsrOverlay(false);
    asr.busy = false;
  });

  /* ---------- Смена языка ----------
     Разметку блоков переводит i18n.js по ключам, а всё, что собрано
     здесь — подписи моделей, оценки времени, метка о готовой разметке
     и подпись главной кнопки, — надо переставить руками. */
  document.addEventListener('i18n', () => {
    перевестиМодели();
    обновитьВремяРазделения();
    обновитьВремяРаспознавания();
    updateAsrSource();
    updateAsrMode();
    показатьИтогРазметки(собратьИтог, true);
    // Меню приложения живёт в главном процессе — оно там же и собирается
    if (window.desktop.setLanguage) window.desktop.setLanguage(I18N.язык());
  });
  if (window.desktop.setLanguage) window.desktop.setLanguage(I18N.язык());

  /* Язык песни на английском интерфейсе по умолчанию английский:
     подставлять русский тому, кто читает интерфейс по-английски,
     заведомо неверно. Выбор человека это не трогает — только
     умолчание, и только пока его не меняли. */
  if (I18N.английский() && $('asr-lang').value === 'russian') {
    $('asr-lang').value = 'english';
  }
})();
