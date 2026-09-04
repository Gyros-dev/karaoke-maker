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

  /* Вернуть клавиатуру странице после долгой работы.

     Беда видна только на Windows: пока считалась разметка или уходил
     вокал, окно никуда не девалось — значит, и обработчики возвращения
     окна (win.on('focus') в main.js) не срабатывали. А фокус при этом
     остаётся у окна, не доходя до страницы: мышь работает, текст
     выделяется, а буквы не идут ни в поле текста, ни в редактор.
     Со стороны это «текст не редактируется». */
  function вернутьКлавиатуру() {
    /* Счётчик для самопроверки: сколько раз клавиатуру возвращали.
       Считаем ЗДЕСЬ, в самой функции, а не в обёртке вокруг неё —
       проверка должна мерить настоящий путь, а не свою подмену. */
    window.__клавиатураВозвращена = (window.__клавиатураВозвращена || 0) + 1;
    try {
      window.focus();
      if (window.desktop && window.desktop.focusPage) window.desktop.focusPage();
      /* Фокус мог остаться на кнопке внутри окна, которое только что
         спрятали: элемент есть, он в фокусе — и клавиши уходят в него,
         то есть в никуда. Со стороны это ровно то же самое: «текст
         не редактируется». Снимаем фокус со всего невидимого. */
      const где = document.activeElement;
      if (где && где !== document.body && !где.offsetParent) {
        где.blur();
        document.body.focus();
      }
    } catch (e) { /* фокус — не то, из-за чего стоит падать */ }
  }
  window.__вернутьКлавиатуру = вернутьКлавиатуру;

  /* Каждое системное окно возвращает клавиатуру странице.

     Вот на чём держалась беда «после подгонки текст не редактируется».
     Подгонка кончается сообщением с итогом — обычным alert, а это
     на Windows настоящее окно системы. Закрыл его — окно приложения
     фокус получило, а страница внутри него нет; мышь работает, текст
     выделяется, буквы не идут никуда. До подгонки окон нет, и потому
     всё печатается — ровно то, что человек и заметил: «если текст
     не подгонять, редактировать можно».

     Поэтому оборачиваем все три системных окна разом, а не лечим одно
     место: alert, confirm и prompt зовутся из десятков мест, и каждое
     из них — та же самая ловушка. Самопроверка подменяет эти функции
     своими заглушками поверх нашей обёртки, ей это не мешает. */
  function обернутьОкно(родное) {
    return function (...доводы) {
      try {
        return родное.apply(window, доводы);
      } finally {
        вернутьКлавиатуру();
      }
    };
  }
  const обёрнуты = [];
  ['alert', 'confirm', 'prompt'].forEach((имя) => {
    if (typeof window[имя] !== 'function') return;
    window[имя] = обернутьОкно(window[имя]);
    обёрнуты.push(имя);
  });
  /* Для самопроверки: сами окна ей звать нельзя — она глушит alert
     и confirm своими заглушками поверх нашей обёртки, а настоящее окно
     посреди прогона всплывёт на экране у человека. Поэтому отдаём
     саму обёртку: проверка обернёт свою пустышку и убедится, что
     клавиатуру возвращают. */
  window.__обернутьОкно = обернутьОкно;
  window.__окнаОбёрнуты = обёрнуты;

  /* Блок «Версия для компьютера» прячут СТИЛИ (body.is-desktop
     в style.css), а не этот скрипт. Раньше он сносился отсюда — и,
     поскольку desktop.js подключается последним, человек успевал
     увидеть его между шапкой и студией: на Маке миг, на Windows
     секунда, и это выглядело как «на секунду появился сайт».
     Одно правило, одно место: витрину прячет CSS. */

  /* Витрины в приложении нет вовсе (см. body.is-desktop в style.css):
     ни геройского экрана, ни возможностей, ни вопросов, ни подвала —
     студия занимает окно целиком. Но кнопка «Что нового» жила именно
     в подвале, а знать, что изменилось в версии, нужно по-прежнему.
     Переносим её в шапку, к переключателям языка и темы: там она
     видна с любого шага и высоты у рабочего места не отнимает. */
  const новости = document.getElementById('btn-whatsnew');
  const переключатели = document.querySelector('.header-switches');
  if (новости && переключатели) переключатели.parentNode.insertBefore(новости, переключатели);

  /* Шапка в приложении другой высоты: меню и кнопки «Открыть студию»
     в ней нет, зато прибавилась «Что нового». От этой высоты считается
     высота студии, поэтому меряем её заново — app.js мерил до нас. */
  if (typeof measureHeader === 'function') measureHeader();

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
    if (!show) вернутьКлавиатуру();
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
       • разделение MDX-Net одним проходом — около 1,2 длины песни
         (модель считает кусок 5,9 с примерно за 4,5 с плюс своё
         преобразование Фурье; прежняя htdemucs шла за 0,9, новая
         чуть медленнее, зато заметно чище);
       • распознавание по миксу: обычная модель ≈0,6, крупная ≈1,2;
       • по чистому вокалу нейросеть возится дольше, чем по миксу,
         примерно в 1,75 раза (355 с против 202 с).

     Компьютеры разные, поэтому после каждого настоящего прогона
     запоминаем свою скорость и дальше считаем уже по ней. */
  /* Секунд счёта на секунду песни. У разделения их два: видеокартой
     оно идёт вчетверо быстрее процессора (замерено на 25 секундах:
     38,8 с против 10,2 — при отсчёт в отсчёт одинаковом звуке).
     Какой брать, решает наличие рабочего адаптера WebGPU. */
  const СКОРОСТЬ = {
    разделение: { webgpu: 0.32, wasm: 1.2 },
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

  /* Чем будет считать разделение. Спрашиваем один раз при запуске:
     ответ нужен оценке времени ещё до того, как что-то посчитают.
     До ответа считаем по процессору — так честнее ошибиться в большую
     сторону, чем пообещать две минуты и считать восемь. */
  let движокРазделения = 'wasm';
  (async () => {
    try {
      if (navigator.gpu && await navigator.gpu.requestAdapter()) движокРазделения = 'webgpu';
    } catch (e) { /* нет видеокарты — считаем процессором */ }
    /* Пересобирать строку оценки есть смысл только когда песня уже
       открыта: без неё текст один и тот же при любом движке
       («Время посчитаем, когда загрузишь песню»), а лишняя запись
       в узел — это ровно та холостая работа, которую сторожит раздел
       кадрыРедактора. Появится песня — строку пересоберёт наблюдатель
       за карточкой трека. */
    if (длинаПесни()) обновитьВремяРазделения();
  })();

  function оценкаРазделения(секунд, проходов) {
    /* Замеры держим отдельно по движкам: машина, у которой видеокарта
       отвалилась, не должна обещать время, снятое на видеокарте. */
    const своя = замеры()['разделение:' + движокРазделения];
    const базовая = СКОРОСТЬ.разделение[движокРазделения] || СКОРОСТЬ.разделение.wasm;
    return секунд * (своя > 0 ? своя : базовая) * (проходов || 1);
  }

  function оценкаРаспознавания(секунд, ключ, поВокалу) {
    const своя = замеры()['распознавание:' + ключ];
    const базовая = СКОРОСТЬ.распознавание[ключ] || СКОРОСТЬ.распознавание.small;
    /* Слушаем не всю песню, а только спетое (см. «Пропуск проигрышей»).
       Коэффициент снят на секунду ЗВУЧАЩЕГО звука, поэтому долю
       проигрышей учитываем здесь — иначе обещали бы вдвое дольше,
       чем считаем. Огибающей нет — доля единица, и всё как было. */
    return секунд * доляСлуха() * (своя > 0 ? своя : базовая)
      * (поВокалу ? СКОРОСТЬ.вокалДороже : 1);
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
  function runSeparation(modelBytes, left, right, shifts, движокСилой) {
    return new Promise((resolve) => {
      sepWorker = new Worker('separator-worker.js');
      sepWorker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          setProgress(m.percent, текстПрогресса(m), осталосьСловами(m.осталось));
        } else if (m.type === 'done') {
          resolve({ ok: true, left: m.left, right: m.right, vocal: m.vocal,
            sampleRate: m.sampleRate, движок: m.движок });
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
        { modelBytes, left: l.buffer, right: r.buffer, sampleRate: MODEL_SR, shifts, движокСилой },
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
      /* Разделяем НЕТРОНУТУЮ песню: если человек уже сменил
         тональность, в state.originalBuffer лежит сдвинутая, и
         нейросеть слушала бы не ту запись. */
      const src44 = await resample(чистыйОригинал(), MODEL_SR);
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
        /* Движок берём из ответа потока, а не из своей догадки: он
           мог не завестись и молча откатиться на процессор. */
        if (res.движок) движокРазделения = res.движок;
        запомнитьСкорость('разделение:' + движокРазделения,
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
          // Чистый вокал на руках — заодно узнаём тональность песни
          узнатьТональность();
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
      /* Минусовка нейросети посчитана по нетронутой песне — значит,
         и звучать всё начинает в исходной тональности. Кэш прежних
         тональностей теперь про другую минусовку и не годится. */
      сменилсяЗвук();
      /* Вместе с кэшем обнулился и ВЫБОР тональности: минусовка теперь
         другая, и «хотели +2» было про прежнюю. Показываем это сразу
         (чип памяти и орган управления) и записываем в проект — иначе
         после перезагрузки студия предложила бы посчитать тональность,
         от которой уже ничего не осталось. */
      обновитьПамять();
      saveProject();
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
      закрытьПоток(sepWorker);
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
  const ASR_IDS = { small: 'whisper-small_timestamped' };

  /* Модель одна. Была и вторая, поменьше и вдвое быстрее, — убрана:
     пение она разбирала заметно хуже, а разбирать его и есть вся её
     работа. Выбирать между «быстро и мимо» и «дольше и по делу»
     человеку незачем, если первое всё равно приходится переделывать.
     Ключ остался: вдруг когда-нибудь появится вторая, которая лучше. */
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
    const ключ = ASR_ЛУЧШАЯ;
    const длина = длинаПесни();
    const поВокалу = !!asr.vocal;
    let хвост = t('asr.хвост.крупная');
    if (поВокалу) хвост += t('asr.хвост.вокал');
    поставитьОценку($('asr-eta'),
      длина ? времяСловами(оценкаРаспознавания(длина, ключ, поВокалу),
        замеры()['распознавание:' + ключ] > 0) : '',
      длина ? хвост : t('время.когдаЗагрузишь') + хвост);
  }

  /* app.js общий с сайтом, править его нельзя, а про новую песню знать
     надо: как только заполнится строка с длительностью песни —
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

  обновитьВремяРаспознавания();

  function setAsrProgress(percent, status, hint) {
    $('asr-fill').style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (status) $('asr-status').textContent = status;
    if (hint !== undefined) $('asr-hint').textContent = hint;
  }

  function showAsrOverlay(show) {
    $('asr-overlay').classList.toggle('hidden', !show);
    if (!show) вернутьКлавиатуру();
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
    return true;
  }

  /* Убить поток, дав ему отпустить движок нейросети.

     Под каждым нашим потоком живёт стайка потоков WASM — по числу
     ядер, до восьми, — и terminate() их не спрашивает. Поэтому
     сначала просим закрыться, ответа ждём, но не вечно: поток мог
     уже не отвечать, а висеть в ожидании нельзя.

     На обычном пути (расчёт дошёл до конца) ждать нечего: поток
     закрывает сессию ДО того, как пришлёт ответ. Это для отмены. */
  function закрытьПоток(worker, мс) {
    if (!worker) return;
    let убит = false;
    const убить = () => { if (убит) return; убит = true; worker.terminate(); };
    worker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'closed') убить();
    });
    setTimeout(убить, мс || 4000);
    try { worker.postMessage({ cmd: 'cancel' }); } catch (e) { убить(); }
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

  /* ---------- Пропуск проигрышей ----------

     Whisper слушает песню подряд, кусками по тридцать секунд, — включая
     проигрыши, где петь нечего. А мы знаем, где поют: огибающую голоса
     приносит разделение вокала. Значит, можно вырезать спетые куски,
     склеить их через короткую тишину и дать нейросети только их.

     Качество от этого не падает, а РАСТЁТ: на чисто музыкальных кусках
     модель склонна выдумывать слова, и эти выдумки потом мешают
     подгонке — она цепляется за них как за опоры. Времена возвращаются
     на место обратным пересчётом, поэтому наружу разницы не видно.

     Берём с запасом по краям: огибающая ставит границу по порогу
     громкости, а первый призвук тише вершины — обрезать его нельзя.
     Куски, между которыми меньше двух запасов, сливаем: дробить
     дорожку ради полусекунды тишины незачем.

     Огибающей нет (вокал не отделяли) — слушаем всё подряд, как раньше. */
  const ЗАПАС_КУСКА = 1.0;          // секунда с каждого края спетого куска
  const ТИШИНА_НА_СТЫКЕ = 0.4;      // пауза между склеенными кусками
  const ПРОПУСК_ОТ = 0.9;           // выкроили больше этой доли — не связываемся

  function кускиДляСлуха() {
    if (!voiceReady() || !voice.runs) return null;
    const длит = длинаПесни();
    if (!длит) return null;
    const куски = [];
    for (const r of voice.runs) {
      const a = Math.max(0, r.start - ЗАПАС_КУСКА);
      const b = Math.min(длит, r.end + ЗАПАС_КУСКА);
      if (b <= a) continue;
      const пред = куски[куски.length - 1];
      if (пред && a - пред.конец < ЗАПАС_КУСКА * 2) пред.конец = Math.max(пред.конец, b);
      else куски.push({ начало: a, конец: b });
    }
    if (!куски.length) return null;
    const спето = куски.reduce((s, к) => s + (к.конец - к.начало), 0);
    /* Резать почти всю песню ради пары процентов не стоит: каждый стык —
       это место, где нейросеть может услышать несуществующее слово. */
    if (спето / длит > ПРОПУСК_ОТ) return null;
    return куски;
  }

  // Какую долю песни придётся слушать. Нужна оценке времени: она
  // считает от длины песни, а слушаем мы теперь меньше.
  function доляСлуха() {
    const куски = кускиДляСлуха();
    if (!куски) return 1;
    const длит = длинаПесни() || 1;
    const спето = куски.reduce((s, к) => s + (к.конец - к.начало), 0);
    return Math.min(1, Math.max(0.05, спето / длит));
  }

  /* Склеить спетые куски в одну дорожку. Возвращает саму дорожку
     и карту: по ней время в склейке пересчитывается обратно в время
     песни. */
  function сжатьДляСлуха(pcm, куски) {
    const тишина = Math.round(ТИШИНА_НА_СТЫКЕ * WHISPER_SR);
    const карта = [];
    let всего = 0;
    for (const к of куски) {
      const a = Math.max(0, Math.round(к.начало * WHISPER_SR));
      const b = Math.min(pcm.length, Math.round(к.конец * WHISPER_SR));
      if (b <= a) continue;
      карта.push({ откуда: a, докуда: b, вНовом: всего / WHISPER_SR,
        вСтаром: a / WHISPER_SR, длина: (b - a) / WHISPER_SR, кудаКласть: всего });
      всего += (b - a) + тишина;
    }
    if (!карта.length) return null;
    всего -= тишина;                  // после последнего куска тишина не нужна
    const out = new Float32Array(всего);
    for (const к of карта) out.set(pcm.subarray(к.откуда, к.докуда), к.кудаКласть);
    return { pcm: out, карта };
  }

  /* Время из склейки обратно в время песни. Попало в тишину на стыке —
     прижимаем к ближайшему краю куска: выдумывать секунды, которых
     в песне нет, нельзя. */
  function вернутьВремя(t, карта) {
    if (!Number.isFinite(t)) return t;
    for (const к of карта) {
      if (t < к.вНовом) return к.вСтаром;
      if (t <= к.вНовом + к.длина) return к.вСтаром + (t - к.вНовом);
    }
    const п = карта[карта.length - 1];
    return п.вСтаром + п.длина;
  }

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
      const buf = чистыйОригинал();
      const mono = new Float32Array(buf.length);
      const ch0 = buf.getChannelData(0);
      const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
      for (let i = 0; i < buf.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
      pcm = await toWhisperPcm(mono, buf.sampleRate);
    }

    /* Проигрыши не слушаем — их в песне бывает половина (см.
       «Пропуск проигрышей» выше). Наружу этого не видно: времена
       возвращаются в шкалу песни сразу после расчёта. */
    const куски = кускиДляСлуха();
    const сжато = куски ? сжатьДляСлуха(pcm, куски) : null;
    if (сжато) pcm = сжато.pcm;
    const слушали = pcm.length / WHISPER_SR;

    const началоСчёта = Date.now();
    const res = await runWhisper(asrModelId(key), pcm, $('asr-lang').value);

    if (res.ok && сжато) {
      res.words = (res.words || []).map((w) => ({
        ...w,
        start: вернутьВремя(w.start, сжато.карта),
        end: вернутьВремя(w.end, сжато.карта),
      }));
      res.пропущено = +(длина - слушали).toFixed(1);
    }

    /* Своя скорость: следующая оценка будет уже по этой машине. Считаем
       от того, что РЕАЛЬНО слушали, а не от длины песни: иначе на песне
       с длинными проигрышами коэффициент вышел бы вдвое меньше правды
       и следующая оценка обманула бы. Долю проигрышей оценка учитывает
       отдельно, через доляСлуха(). */
    if (res.ok && слушали > 5) {
      запомнитьСкорость('распознавание:' + key,
        ((Date.now() - началоСчёта) / 1000) / (слушали * (поВокалу ? СКОРОСТЬ.вокалДороже : 1)));
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

  /* Свободного распознавания («нейросеть напишет текст сама») здесь
     больше нет. Пение оно разбирало плохо: гласные тянутся, мешают
     бэк-вокал и музыка, рифм модель не знает, — и вместо помощи выходил
     черновик, который всё равно переписывали целиком. Осталась подгонка
     готового текста: буквы приносит человек, времена — нейросеть.
     Вместе с распознаванием ушла и вторая кнопка, и переключение
     режимов у первой. */

  /* ---------- Подгонка своего текста ----------
     Главный способ работы: буквы берём у человека, времена — у
     нейросети. Сама раскладка живёт в align.js. */
  async function fitLyrics() {
    if (asr.busy || busy) return;
    if (!state.originalBuffer) { alert(t('asr.сначалаПесня')); return; }
    const text = $('lyrics-input').value;
    if (!text.trim()) { alert(t('asr.сначалаТекст')); return; }

    const key = ASR_ЛУЧШАЯ;
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

  /* Дело у кнопки одно — подогнать готовый текст, — поэтому подпись
     и пояснение стоят прямо в разметке и не переключаются. Следим
     здесь только за одним: поле опустошили — метка о прежней разметке
     врёт, размечать больше нечего. Правку отдельных строк метка
     переживает: времена остальных строк от этого не портятся. */
  function updateAsrMode() {
    if (!$('lyrics-input').value.trim()) показатьИтогРазметки(null);
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
  /* ---------- В какой тональности песня ----------

     Считается по чистому вокалу, который оставляет разделение: метод
     Маклауда ищет одну основную частоту и работает на одноголосом
     звуке, а на полном миксе выдал бы мусор. Поэтому зовём только
     после удаления вокала — и только один раз на песню.

     Ответ уходит в app.js (поставитьТональностьПесни): строка
     о тональности стоит рядом с органом сдвига, там же, где ею
     и пользуются. */
  let тональностьСчитаем = false;

  function узнатьТональность() {
    if (тональностьСчитаем || !asr.vocal || !asr.vocal.length) return;
    тональностьСчитаем = true;
    let поток = null;
    const закрыть = () => { if (поток) { поток.terminate(); поток = null; } };
    try {
      поток = new Worker('key-worker.js');
    } catch (e) {
      тональностьСчитаем = false;
      return;
    }
    поток.onmessage = (e) => {
      const о = e.data;
      закрыть();
      if (о && о.ok) поставитьТональностьПесни(о.тоника, о.лад);
      /* Не вышло — молчим. Строка о тональности просто не появится:
         соврать про неё хуже, чем не сказать ничего. */
    };
    поток.onerror = () => { закрыть(); };
    const копия = asr.vocal.slice();
    поток.postMessage({ pcm: копия.buffer, rate: WHISPER_SR }, [копия.buffer]);
  }

  /* Пропуск проигрышей наружу — самопроверке. Считать тут нечего,
     кроме карты и пересчёта времён, а это чистые функции: проверяются
     за миллисекунды, без нейросети и без четверти гигабайта модели. */
  window.__пропуск = {
    куски: кускиДляСлуха,
    сжать: сжатьДляСлуха,
    вернуть: вернутьВремя,
    доля: доляСлуха,
  };

  window.__оценкаВремени = (секунд) => ({
    движок: движокРазделения,
    разделениеБыстро: Math.round(оценкаРазделения(секунд, 1)),
    разделениеЛучшее: Math.round(оценкаРазделения(секунд, 3)),
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
      // Без песни в студии сцена не знает длины песни и обрежет последнюю строку
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

  $('btn-asr-run').addEventListener('click', () => fitLyrics());
  $('btn-asr-cancel').addEventListener('click', () => {
    if (asr.worker) {
      закрытьПоток(asr.worker);
      asr.worker = null;   // чтобы finish ниже не убил его вторым разом
    }
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
