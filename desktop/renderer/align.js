/* ============================================================
   Подгонка своего текста под песню

   Свободное распознавание пения врёт в буквах, но время называет
   довольно точно: слово услышано там, где его действительно поют,
   просто записано криво. Поэтому берём у нейросети времена, а буквы —
   у человека.

   Задача сводится к выравниванию двух последовательностей слов:
   что услышала модель и что вставил пользователь. Считаем
   Нидлманом—Вуншем, но сравниваем слова не на строгое равенство,
   а на похожесть (расстояние Левенштейна по нормализованной записи) —
   иначе «пабричном» и «фабричном» никогда не сцепятся.

   Слова, которым нашлась пара, получают настоящее время — это опоры.
   Остальные раскладываются между соседними опорами по числу слогов.

   Файл подключается и в окно приложения, и в проверку из Node,
   поэтому наружу отдаётся через self и module — без импортов.
   ============================================================ */

(function (root, factory) {
  const api = factory();
  root.Align = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* ---------- Настройки ----------
     Пороги подобраны на живом пении: см. README, раздел про подгонку. */
  const MATCH_MIN = 0.6;   // ниже этой похожести пара уже не пара
  const MATCH_LOW = 0.45;  // на втором проходе, внутри промежутка между опорами
  const GAP = -0.55;       // цена пропущенного слова
  const MISMATCH = -0.9;   // цена замены (дешевле двух пропусков)
  const MERGE_PEN = -0.25; // надбавка за склейку «одно слово ↔ два»
  const MIN_STEP = 0.01;   // насколько слово обязано отставать от соседа
  const DEF_SYL = 0.3;     // секунд на слог, пока нечего измерить

  /* Цифры нейросеть пишет цифрами («4»), человек — словами («четыре»).
     Без этой таблички отсчёты и годы теряют опоры на ровном месте. */
  const NUMERALS = {
    0: 'ноль', 1: 'один', 2: 'два', 3: 'три', 4: 'четыре', 5: 'пять',
    6: 'шесть', 7: 'семь', 8: 'восемь', 9: 'девять', 10: 'десять',
    11: 'одиннадцать', 12: 'двенадцать', 13: 'тринадцать',
    14: 'четырнадцать', 15: 'пятнадцать', 16: 'шестнадцать',
    17: 'семнадцать', 18: 'восемнадцать', 19: 'девятнадцать',
    20: 'двадцать', 30: 'тридцать', 40: 'сорок', 50: 'пятьдесят',
    60: 'шестьдесят', 70: 'семьдесят', 80: 'восемьдесят',
    90: 'девяносто', 100: 'сто', 1000: 'тысяча',
  };

  /* Нормализация: нижний регистр, ё→е, прочь знаки препинания.
     Дефис внутри распева («пропада-да-да») тоже уходит — модель ставит
     его как попало, а слышит при этом то же самое. */
  function norm(word) {
    const s = String(word == null ? '' : word)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}]+/gu, '');
    if (/^\d+$/.test(s) && NUMERALS[+s]) return NUMERALS[+s];
    return s;
  }

  const VOWELS = /[аеиоуыэюяaeiouy]/g;

  // Слогов в слове — по гласным. Слово без гласных всё равно поётся.
  function syllables(word) {
    const m = norm(word).match(VOWELS);
    return Math.max(1, m ? m.length : 1);
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    const n = a.length;
    const m = b.length;
    if (!n) return m;
    if (!m) return n;
    let prev = new Array(m + 1);
    let cur = new Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
      cur[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= m; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[m];
  }

  /* Похожесть двух нормализованных слов, 0…1. Совпавшее начало ценим
     отдельно: пение съедает окончания чаще, чем корни, поэтому
     «люблю» и «люблюю» должны считаться одним словом. */
  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const max = Math.max(a.length, b.length);
    const base = 1 - levenshtein(a, b) / max;
    let same = 0;
    while (same < a.length && same < b.length && a[same] === b[same]) same++;
    const bonus = Math.min(4, same) * 0.03;
    return Math.min(1, base + bonus);
  }

  /* ---------- Выравнивание ----------

     Обычный Нидлман—Вунш: оба ряда разбираются целиком. Кроме трёх
     привычных ходов есть склейки — одно слово человека против двух
     услышанных и наоборот: модель то делит распев на части, то
     склеивает предлог со словом.

     Порог похожести передаётся снаружи: первый проход идёт строгим,
     второй (по дырам между найденными парами) — мягким. */
  const D1 = 0;   // слово ↔ слово
  const UP = 1;   // слово пользователя без пары
  const LEFT = 2; // услышанное слово без пары
  const D12 = 3;  // одно слово пользователя ↔ два услышанных
  const D21 = 4;  // два слова пользователя ↔ одно услышанное

  function score(sim, порог) {
    return sim >= порог ? 2 * sim - 1 : MISMATCH;
  }

  function align(user, rec, порог) {
    const min = порог || MATCH_MIN;
    const n = user.length;
    const m = rec.length;
    const W = m + 1;
    const F = new Float32Array((n + 1) * W);
    const P = new Uint8Array((n + 1) * W);

    for (let i = 1; i <= n; i++) {
      F[i * W] = i * GAP;
      P[i * W] = UP;
    }
    for (let j = 1; j <= m; j++) {
      F[j] = j * GAP;
      P[j] = LEFT;
    }

    for (let i = 1; i <= n; i++) {
      const u = user[i - 1];
      for (let j = 1; j <= m; j++) {
        const cell = i * W + j;
        let best = F[(i - 1) * W + j - 1] + score(similarity(u, rec[j - 1]), min);
        let move = D1;

        const up = F[(i - 1) * W + j] + GAP;
        if (up > best) { best = up; move = UP; }

        const left = F[i * W + j - 1] + GAP;
        if (left > best) { best = left; move = LEFT; }

        if (j >= 2) {
          const sim = similarity(u, rec[j - 2] + rec[j - 1]);
          if (sim >= min) {
            const v = F[(i - 1) * W + j - 2] + score(sim, min) + MERGE_PEN;
            if (v > best) { best = v; move = D12; }
          }
        }
        if (i >= 2) {
          const sim = similarity(user[i - 2] + u, rec[j - 1]);
          if (sim >= min) {
            const v = F[(i - 2) * W + j - 1] + score(sim, min) + MERGE_PEN;
            if (v > best) { best = v; move = D21; }
          }
        }

        F[cell] = best;
        P[cell] = move;
      }
    }

    /* Обратный ход из дальнего угла: выравнивание строгое, оба ряда
       разбираются целиком. Свисающие концы («бесплатный» мусор до и
       после песни) пробовали — стало хуже: пропустить конец текста
       оказывалось дешевле, чем найти в нём последние опоры. Лишние
       услышанные слова и так стоят ровно по пропуску за штуку, где бы
       они ни стояли, и на выбор пар не влияют.

       Пара засчитывается опорой, только если слова действительно
       похожи: замена времени не даёт — там мы явно не знаем,
       что услышали. */
    const pairs = [];   // { user, from, to } — индексы услышанных слов
    const bestJ = m;
    let i = n;
    let j = bestJ;
    while (i > 0) {
      const move = j > 0 ? P[i * W + j] : UP;
      if (move === D1) {
        if (similarity(user[i - 1], rec[j - 1]) >= min) {
          pairs.push({ user: i - 1, from: j - 1, to: j - 1 });
        }
        i--; j--;
      } else if (move === D12) {
        pairs.push({ user: i - 1, from: j - 2, to: j - 1 });
        i--; j -= 2;
      } else if (move === D21) {
        // Два слова человека на одно услышанное: делим его пополам позже
        pairs.push({ user: i - 1, from: j - 1, to: j - 1, half: 'вторая' });
        pairs.push({ user: i - 2, from: j - 1, to: j - 1, half: 'первая' });
        i -= 2; j--;
      } else if (move === UP) {
        i--;
      } else {
        j--;
      }
    }
    pairs.reverse();
    return pairs;
  }

  /* Второй проход: в каждой дыре между уже найденными парами заново
     выравниваем оставшиеся куски, но с мягким порогом. Дыра ограничена
     соседними парами, поэтому лишняя пара внутри неё сдвигает слово
     максимум на длину этой дыры. */
  function refine(user, rec, pairs) {
    const out = [];
    let uFrom = 0;
    let rFrom = 0;

    const дыра = (uTo, rTo) => {
      if (uTo < uFrom || rTo < rFrom) return;
      const u = user.slice(uFrom, uTo + 1);
      const r = rec.slice(rFrom, rTo + 1);
      // Огромные дыры второму проходу не по зубам и не по времени
      if (!u.length || !r.length || u.length * r.length > 40000) return;
      align(u, r, MATCH_LOW).forEach((p) => {
        out.push({ user: p.user + uFrom, from: p.from + rFrom, to: p.to + rFrom, half: p.half });
      });
    };

    for (const p of pairs) {
      дыра(p.user - 1, p.from - 1);
      out.push(p);
      uFrom = p.user + 1;
      rFrom = p.to + 1;
    }
    дыра(user.length - 1, rec.length - 1);

    // Пары от двух проходов перемешались — раскладываем обратно по порядку
    out.sort((a, b) => a.user - b.user || a.from - b.from);
    return out;
  }

  /* ---------- Разбор текста пользователя ----------
     Пустая строка — просто разделитель куплетов, в разметку не идёт.
     Слова режем ровно так же, как студия (splitWords в app.js):
     пробел приклеен к предыдущему слову, иначе подсветка будет рваной. */
  function parseLyrics(text) {
    const lines = [];
    const words = [];
    String(text).split('\n').forEach((raw) => {
      const t = raw.trim();
      if (!t) return;
      const chunks = t.match(/\S+\s*/g) || [];
      if (!chunks.length) return;
      const line = { text: t, from: words.length, count: chunks.length };
      chunks.forEach((c) => words.push({ text: c, line: lines.length }));
      lines.push(line);
    });
    return { lines, words };
  }

  /* ---------- Раскладка времени ----------
     Между двумя опорами свободные слова делят промежуток по числу
     слогов: длинное слово поётся дольше короткого.

     ПО ПЕНИЮ, А НЕ ПО ЧАСАМ, когда известна огибающая голоса.

     Беда, ради которой это заведено, замерена на «Любви» Ленинграда:
     между «ба-ба-ба, любовь» и «ла-ла-лай» лежит проигрыш в двадцать
     секунд. Слова делили весь этот промежуток поровну — и четыре
     строки припева вставали в тишину, за десять секунд до того, как
     их запели. Нейросеть там не слышит ничего, опереться не на что,
     а огибающая голоса знает точно: вот тут поют, а тут молчат.

     Поэтому доли считаются от ПРОПЕТОГО времени: слово встаёт туда,
     где к этому моменту накопилось столько-то секунд настоящего пения.
     Тишина при этом просто пропускается. Огибающей нет (сайт, или
     вокал не отделяли) — раскладываем как раньше, ровно по часам. */
  function пенияВ(runs, a, b) {
    let s = 0;
    for (const r of runs) {
      const x = Math.max(a, r.start);
      const y = Math.min(b, r.end);
      if (y > x) s += y - x;
    }
    return s;
  }

  function времяПоПению(runs, a, b, нужно) {
    let s = 0;
    for (const r of runs) {
      const x = Math.max(a, r.start);
      const y = Math.min(b, r.end);
      if (y <= x) continue;
      if (s + (y - x) >= нужно) return x + (нужно - s);
      s += y - x;
    }
    return b;
  }

  function spread(times, words, fromIdx, toIdx, start, span, runs) {
    let total = 0;
    for (let k = fromIdx; k <= toIdx; k++) total += syllables(words[k].text);
    const конец = start + span;
    /* Считаем по пению, только когда в промежутке и правда есть тишина
       (иначе разницы никакой) и есть за что зацепиться. */
    const пения = runs && runs.length ? пенияВ(runs, start, конец) : 0;
    const поПению = пения > 0.5 && пения < span - 0.5;
    let acc = 0;
    for (let k = fromIdx; k <= toIdx; k++) {
      const w = syllables(words[k].text);
      const было = acc;
      acc += w;
      const т = (доля) => (поПению
        ? времяПоПению(runs, start, конец, пения * доля)
        : start + span * доля);
      times[k] = { time: т(было / total), end: т(acc / total), опора: false };
    }
  }

  /* Главная работа: текст пользователя + слова нейросети → строки
     с временами. duration — длина песни, нужна, чтобы хвост без опор
     не улетел за край. */
  function fit(text, recWords, opts) {
    const о = opts || {};
    const duration = о.duration || 0;
    /* Огибающая голоса: куски, где на самом деле поют. Приходит
       из приложения после разделения вокала; на сайте её нет.

       Мелочь отбрасываем. После разделения в проигрышах остаётся
       призвук — гитара, эхо, хлопок, — и огибающая честно помечает
       его пением: на «Любви» это семь кусков по полсекунды посреди
       двадцатисекундного проигрыша. Считать их пением значит отдавать
       им слоги, то есть ставить строки в тишину. Настоящая пропетая
       фраза короче секунды не бывает. */
    const МИН_КУСОК = 1.2;
    const всеКуски = Array.isArray(о.runs)
      ? о.runs.filter((r) => r && r.end > r.start) : null;
    const крупные = всеКуски
      ? всеКуски.filter((r) => r.end - r.start >= МИН_КУСОК) : null;
    const runs = крупные && крупные.length ? крупные : всеКуски;
    const parsed = parseLyrics(text);
    const words = parsed.words;
    /* Отдаём ключ словаря, а не готовую фразу: причину показывает
       окно поверх страницы, а языка интерфейса здесь не знают. */
    if (!words.length) return { ok: false, error: 'подгонка.пустойТекст' };

    const rec = (recWords || [])
      .map((w) => ({ n: norm(w.text), start: w.start, end: w.end }))
      .filter((w) => w.n && w.start != null);
    if (!rec.length) return { ok: false, error: 'подгонка.ниСлова' };

    const uNorm = words.map((w) => norm(w.text));
    const rNorm = rec.map((w) => w.n);
    let pairs = align(uNorm, rNorm);
    if (!pairs.length) {
      return { ok: false, error: 'подгонка.неСовпало' };
    }

    /* Второй проход по дырам. В промежутке между двумя опорами и текст,
       и услышанное уже зажаты с обоих концов: слово оттуда никуда не
       уедет, даже если пара окажется случайной. Поэтому там сравниваем
       мягче — так подбираются строки, которые нейросеть разобрала совсем
       криво. Снаружи такой порог опасен: он утаскивал последний куплет
       на десяток секунд вперёд. */
    pairs = refine(uNorm, rNorm, pairs);

    /* Опоры. Порядок выравнивание сохраняет, но метки самой нейросети
       изредка идут вспять — такие опоры выкидываем, иначе строки
       поедут друг на друга. */
    const times = new Array(words.length).fill(null);
    const anchors = [];
    let last = -Infinity;
    for (const p of pairs) {
      const a = rec[p.from];
      const b = rec[p.to];
      let start = a.start;
      let end = b.end != null ? b.end : (rec[p.to + 1] ? rec[p.to + 1].start : a.start + 0.4);
      if (end <= start) end = start + 0.15;
      if (p.half === 'первая') end = start + (end - start) / 2;
      if (p.half === 'вторая') start = start + (end - start) / 2;
      if (start < last + MIN_STEP) continue;
      times[p.user] = { time: start, end, опора: true };
      anchors.push(p.user);
      last = start;
    }
    if (!anchors.length) return { ok: false, error: 'подгонка.опорыНеСложились' };

    /* Сколько секунд занимает слог, ПОКА ПОЮТ.

       Раньше здесь стояло расстояние от первой опоры до последней,
       делённое на все слоги между ними. В это расстояние попадают
       и паузы между строками, и проигрыши — на «Ленинграде» один
       такой длится полминуты, — поэтому слог выходил вдвое длиннее
       настоящего. А по этой скорости отматывается голова, и первая
       строка уезжала во вступление: начиналась на 4,8 с при настоящем
       начале пения около 16 с и растягивалась на 14,5 с при соседях
       по три секунды.

       Считаем иначе: по соседним опорам, стоящим подряд, — сколько
       времени уходит на слог при переходе от слова к слову. Берём
       середину списка, а не среднее: одна пауза посреди строки не
       должна тянуть скорость на себя. */
    const темпы = [];
    for (let a = 0; a < anchors.length - 1; a++) {
      const i = anchors[a];
      if (anchors[a + 1] !== i + 1) continue; // между ними есть неразмеченные слова
      const шаг = times[i + 1].time - times[i].time;
      // Больше трёх секунд на слово — это уже не пение, а пауза
      if (шаг > 0 && шаг < 3) темпы.push(шаг / (syllables(words[i].text) || 1));
    }
    темпы.sort((x, y) => x - y);
    const secPerSyl = темпы.length
      ? Math.max(0.08, Math.min(0.8, темпы[темпы.length >> 1]))
      : DEF_SYL;

    /* ---------- Отбраковка невозможных опор ----------

       Нейросеть иногда слышит то, чего в песне нет. На «Кирпичах» ей
       послышалось в первые две секунды «Прому, мы будем счастливы», а
       настоящие первые три строки она пропустила совсем. Одно слово
       текста цеплялось за эту галлюцинацию — и всё, что до следующей
       опоры, расплющивалось: две строки укладывались в треть секунды,
       третья растягивалась на двадцать одну.

       Проверяем каждый промежуток на здравый смысл: за него надо успеть
       спеть столько-то слогов, а быстрее ТЕМП_ПРЕДЕЛ от обычного темпа
       этой же песни не поёт никто. Не успеваем — одна из двух опор по
       краям промежутка лишняя. Выкидываем ту, у которой меньше соседей
       рядом: настоящие опоры ходят стайками, случайная стоит одна. */
    const ТЕМП_ПРЕДЕЛ = 0.35;   // втрое быстрее обычного — уже невозможно
    const ОКНО_ПОДДЕРЖКИ = 5;   // секунд вокруг опоры, где считаем соседей

    const поддержка = (u) => {
      const t = times[u].time;
      let n = 0;
      for (const a of anchors) {
        if (a !== u && Math.abs(times[a].time - t) <= ОКНО_ПОДДЕРЖКИ) n++;
      }
      return n;
    };

    for (let проход = 0; проход < 20 && anchors.length > 1; проход++) {
      let лишняя = -1;
      for (let a = 0; a < anchors.length; a++) {
        const j = anchors[a];
        const i = a > 0 ? anchors[a - 1] : -1;   // −1 — начало записи
        let слогов = 0;
        for (let k = i + 1; k < j; k++) слогов += syllables(words[k].text);
        if (!слогов) continue;
        const было = i >= 0 ? times[i].end : 0;
        if (times[j].time - было >= слогов * secPerSyl * ТЕМП_ПРЕДЕЛ) continue;
        лишняя = (i >= 0 && поддержка(i) < поддержка(j)) ? i : j;
        break;
      }
      /* Тот же здравый смысл — для ХВОСТА, после последней опоры.

         Проверка выше смотрит только на промежутки МЕЖДУ опорами,
         и опора у самого края записи ускользала: за ней ничего нет,
         сравнивать не с чем. А беда живая: на «Звёздах и луне»
         нейросеть на Windows услышала что-то на 143,8 секунде при
         длине песни 144,03 — и три последних строки уложились
         в двадцать сотых, по 0,07 с на строку. На дорожке их не видно
         вовсе: тонкая полоска у самого края, и найти её можно только
         кнопкой «вся песня».

         Конец записи здесь — такая же опора, как соседняя: за хвост
         надо успеть спеть столько-то слогов, а быстрее ТЕМП_ПРЕДЕЛ
         от обычного темпа песни не поёт никто. Не успеваем — последняя
         опора ложная, выкидываем её и считаем хвост от предыдущей. */
      if (лишняя < 0 && duration > 0 && anchors.length > 1) {
        const j = anchors[anchors.length - 1];
        let слогов = 0;
        for (let k = j + 1; k < words.length; k++) слогов += syllables(words[k].text);
        if (слогов && duration - times[j].end < слогов * secPerSyl * ТЕМП_ПРЕДЕЛ) лишняя = j;
      }
      if (лишняя < 0) break;
      times[лишняя] = null;
      anchors.splice(anchors.indexOf(лишняя), 1);
    }
    /* ---------- Опора, разошедшаяся со своей же строкой ----------

       Беда живая, замерена на «Любви» Ленинграда. Нейросеть поставила
       слово «Я» на 9,26 секунды, а остальные слова той же строки —
       на 22,3–25,5, где строка и поётся на самом деле. Подгонка взяла
       первую опору за начало строки: строка уехала на двенадцать секунд
       назад, а строку выше сплющило перед ней.

       Проверка выше ловит только «слишком быстро» между соседними
       опорами; тринадцать секунд на одно слово ей не подозрительны —
       мало ли, пауза. Но ВНУТРИ ОДНОЙ СТРОКИ паузы такой длины
       не бывает: строку поют подряд.

       Поэтому у каждой опоры спрашиваем, где по ней начинается её
       строка (время минус слоги до неё), и берём серединное из этих
       мнений. Опора, разошедшаяся с серединой больше чем на предел,
       выбрасывается: одно кривое слово не должно решать за строку. */
    const ПРЕДЕЛ_РАЗЛАДА = 2.5;   // секунд расхождения внутри строки
    for (const л of parsed.lines) {
      const свои = anchors.filter((u) => u >= л.from && u < л.from + л.count);
      if (свои.length < 2) continue;
      const мнение = (u) => {
        let слогов = 0;
        for (let k = л.from; k < u; k++) слогов += syllables(words[k].text);
        return times[u].time - слогов * secPerSyl;
      };
      if (свои.length === 2) {
        /* Двое спорят — большинства нет. Верим той опоре, у которой
           больше соседей рядом: настоящие опоры ходят стайками,
           случайная стоит одна (та же мера, что и выше). */
        const [a, b] = свои;
        if (Math.abs(мнение(a) - мнение(b)) > ПРЕДЕЛ_РАЗЛАДА) {
          const лишняя = поддержка(a) < поддержка(b) ? a : b;
          times[лишняя] = null;
          anchors.splice(anchors.indexOf(лишняя), 1);
        }
        continue;
      }
      const мнения = свои.map(мнение).sort((a, b) => a - b);
      const серединное = мнения[мнения.length >> 1];
      for (const u of свои) {
        if (Math.abs(мнение(u) - серединное) <= ПРЕДЕЛ_РАЗЛАДА) continue;
        times[u] = null;
        anchors.splice(anchors.indexOf(u), 1);
      }
    }
    if (!anchors.length) return { ok: false, error: 'подгонка.опорыНеСложились' };

    const first = anchors[0];
    const lastA = anchors[anchors.length - 1];

    /* Голова: до первой опоры отматываем назад ровно столько, сколько
       нужно на эти слоги, но не дальше начала записи — и не дальше
       первого звука, который нейросеть вообще услышала. Раньше первого
       услышанного слова не поёт никто, там вступление; эта граница
       нужна на случай, когда скорость всё-таки оказалась щедрой.
       Если до первой опоры нейросеть не услышала ничего, границы нет:
       значит, начало она просто прослушала, и опереться не на что. */
    if (first > 0) {
      let need = 0;
      for (let k = 0; k < first; k++) need += syllables(words[k].text) * secPerSyl;
      const слышноС = pairs[0] && pairs[0].from > 0 ? rec[0].start : 0;
      const start = Math.max(0, слышноС, times[first].time - need);
      spread(times, words, 0, first - 1, start, Math.max(0.05, times[first].time - start), runs);
    }

    // Середина: между соседними опорами
    for (let a = 0; a < anchors.length - 1; a++) {
      const i = anchors[a];
      const j = anchors[a + 1];
      if (j - i < 2) continue;
      const start = Math.min(times[i].end, times[j].time - MIN_STEP);
      const span = Math.max(MIN_STEP, times[j].time - start);
      spread(times, words, i + 1, j - 1, start, span, runs);
    }

    // Хвост: после последней опоры
    if (lastA < words.length - 1) {
      let need = 0;
      for (let k = lastA + 1; k < words.length; k++) need += syllables(words[k].text) * secPerSyl;
      const start = times[lastA].end;
      const limit = duration > 0 ? Math.max(start + 0.2, duration) : start + need;
      let span = Math.max(0.2, Math.min(need, limit - start));
      /* Когда огибающая известна, хвост тянется до КОНЦА ПЕНИЯ, а не
         на столько, на сколько хватило бы слогов подряд. Иначе строки
         хвоста жмутся сразу за последней опорой и попадают в тишину:
         на «Любви» последний припев поётся на 112-й секунде, а вставал
         он на 103-ю. Тишину внутри раскладка всё равно пропустит —
         слова лягут только туда, где поют (см. spread). */
      if (runs && runs.length) {
        const конецПения = runs[runs.length - 1].end;
        if (конецПения > start + span) span = Math.min(limit - start, конецПения - start);
      }
      spread(times, words, lastA + 1, words.length - 1, start, span, runs);
    }

    /* ---------- Строку не разрывает тишина ----------

       Слова раскладываются по слогам, и строке без опор ничто не мешало
       начаться в хвосте одного куска пения, а кончиться в следующем —
       через двадцать секунд проигрыша. На «Любви» так и вышло: «А вокруг
       тишина» вставала на 35,9 с, в затухании прошлого куплета, тогда
       как поётся она на 51-й, сразу после проигрыша.

       Строку поют подряд: она не может начаться до тишины и кончиться
       после неё. Если строка без опор не помещается в тот кусок, где
       началась, — двигаем её целиком к началу следующего куска, но
       не дальше ближайшей опоры: у той время настоящее. */
    if (runs && runs.length) {
      for (const л of parsed.lines) {
        const от = л.from;
        const до = л.from + л.count - 1;
        let своиОпоры = false;
        for (let k = от; k <= до && !своиОпоры; k++) своиОпоры = !!times[k].опора;
        if (своиОпоры) continue;
        const t0 = times[от].time;
        const t1 = times[до].end;
        const кусок = runs.find((r) => t0 >= r.start && t0 < r.end);
        if (кусок) {
          if (t1 <= кусок.end + 0.2) continue;   // помещается — не трогаем
          /* Строку, начинающуюся ВМЕСТЕ с пением, не трогаем: она уже
             стоит там, где голос вступает, а за край её выводит только
             щедрая оценка длины по слогам («ба-ба-ба-ба-ба» слогов
             много, а поётся коротко). Двигаем ту, что начинается
             посреди куска и потому и правда разорвана тишиной. */
          if (t0 <= кусок.start + 0.3) continue;
        }
        /* Строка, начавшаяся в тишине, тоже едет к ближайшему пению:
           там её и поют. Без этого «А вокруг тишина» вставала
           на 40-ю секунду, посреди проигрыша. */
        const след = runs.find((r) => r.start >= (кусок ? кусок.end : t0));
        if (!след) continue;
        let предел = duration > 0 ? duration : след.start + (t1 - t0);
        for (let k = до + 1; k < times.length; k++) {
          if (times[k].опора) { предел = times[k].time - MIN_STEP; break; }
        }
        if (след.start <= t0 + 0.05 || предел - след.start < 0.2) continue;
        /* Раскладываем строку ЗАНОВО от начала следующего куска — а не
           двигаем как есть. Растянутую через тишину строку сдвиг только
           перенёс бы вместе с её же дырой: у «А вокруг тишина» длина
           выходила шестнадцать секунд на семь слов. */
        spread(times, words, от, до, след.start, предел - след.start, runs);
        if (window.__asrDebug) {
          console.log('ТИШИНА-СТРОКА', JSON.stringify({
            текст: л.text.slice(0, 20), было: +t0.toFixed(2),
            стало: +times[от].time.toFixed(2), предел: +предел.toFixed(2),
          }));
        }
      }
    }

    /* Строгий порядок. Тут же ловим редкий случай, когда в тесном
       промежутке оказалось больше слов, чем секунд: слова всё равно
       расходятся, просто вплотную. */
    let prev = -Infinity;
    for (let k = 0; k < times.length; k++) {
      const t = times[k];
      if (t.time <= prev) t.time = prev + MIN_STEP;
      if (t.end == null || t.end <= t.time) t.end = t.time + MIN_STEP;
      prev = t.time;
    }
    for (let k = 0; k < times.length - 1; k++) {
      if (times[k].end > times[k + 1].time) times[k].end = times[k + 1].time;
    }

    /* ---------- Собираем строки ----------
       Границы строк — те же, что поставил человек. */
    const lines = parsed.lines.map((l) => {
      const ws = [];
      let опор = 0;
      for (let k = l.from; k < l.from + l.count; k++) {
        if (times[k].опора) опор++;
        ws.push({ text: words[k].text, time: times[k].time, end: times[k].end });
      }
      const доля = опор / l.count;
      return {
        text: l.text,
        time: ws[0].time,
        end: ws[ws.length - 1].end,
        words: ws,
        опор,
        слов: l.count,
        // Строка без опор растянута наугад — человеку стоит её проверить
        сомнительная: доля < 0.34,
      };
    });

    /* ---------- Цифры для самопроверки ---------- */
    let растяжка = 0;
    for (let a = 0; a < anchors.length - 1; a++) {
      const i = anchors[a];
      const j = anchors[a + 1];
      if (j - i < 2) continue;
      растяжка = Math.max(растяжка, times[j].time - times[i].end);
    }
    if (first > 0) растяжка = Math.max(растяжка, times[first].time - times[0].time);
    if (lastA < words.length - 1) {
      растяжка = Math.max(растяжка, times[times.length - 1].end - times[lastA].end);
    }

    let монотонно = true;
    for (let k = 1; k < times.length; k++) {
      if (times[k].time <= times[k - 1].time) монотонно = false;
    }

    return {
      ok: true,
      lines,
      статистика: {
        словТекста: words.length,
        словУслышано: rec.length,
        опор: anchors.length,
        доляОпор: +(anchors.length / words.length).toFixed(3),
        самаяДлиннаяРастяжка: +растяжка.toFixed(2),
        монотонно,
        начало: +times[0].time.toFixed(2),
        конец: +times[times.length - 1].end.toFixed(2),
        покрытие: duration > 0
          ? +((times[times.length - 1].end - times[0].time) / duration).toFixed(3)
          : null,
        сомнительныхСтрок: lines.filter((l) => l.сомнительная).length,
        строк: lines.length,
      },
    };
  }

  /* spread наружу — редактор пользуется им отдельно от fit(): команда
     «распределить» в панели слова раскладывает слова уже готовой строки
     по числу слогов той же самой функцией, безо всякого распознавания
     речи (см. распределитьСлова в app.js). */
  return { fit, align, norm, similarity, syllables, spread, parseLyrics, MATCH_MIN };
});
