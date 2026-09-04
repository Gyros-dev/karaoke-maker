/* ============================================================
   Перевод интерфейса: русский и английский

   Сборки в проекте нет — обычные index.html, style.css, app.js, —
   поэтому и перевод сделан без неё: этот файл подключается перед
   app.js обычным <script>, кладёт в окно I18N и t() и дальше всё
   работает на живом дереве документа.

   Два словаря, потому что у надписей два происхождения:

     • РАЗМЕТКА — то, что написано прямо в index.html. Русский текст
       остаётся в разметке (её и читать так проще, и рассинхрона
       с переводом не бывает), а элемент помечается ключом:
         data-i18n="ключ"            — textContent
         data-i18n-html="ключ"       — innerHTML (там, где внутри <b>,
                                       <a> или <span class="mod-key">)
         data-i18n-title / -placeholder / -aria / -mod-title
       Русский вариант снимается с документа при первом применении
       и хранится в WeakMap, поэтому возврат на русский точен всегда.
       В словаре EN лежит только английский.

     • СТРОКИ — то, что собирается в коде (сообщения, подписи кнопок,
       оценки времени). Здесь в документе брать нечего, поэтому
       в словаре лежат обе стороны: { ru, en }.

   data-i18n-html вставляет разметкой только НАШ собственный текст
   из этого файла — он часть исходников, а не данные пользователя.
   Правило проекта «пользовательский текст только через textContent»
   в силе: имена файлов, текст песни и всё, что пришло снаружи,
   по-прежнему ставится textContent'ом.

   В разметке подстановки тоже работают, но набор у них общий и берётся
   не из вызова, а из ПОДСТАНОВОК: там лежит то, что обязано читаться
   одинаково на любом языке, — сейчас это {версия}. Номеру версии
   в словаре не место: он там однажды отстал, и английский заголовок
   окна «Что нового» объявлял прошлую версию.

   Подстановки: t('ключ', { n: 3 }) заменяет {n} в строке. Если
   значение в словаре не строка, а набор форм, форма выбирается
   через Intl.PluralRules по числу n — русские «минута/минуты/минут»
   и английские «minute/minutes» считаются каждый по своим правилам.
   ============================================================ */

const I18N = (function () {
  const ЯЗЫКИ = ['ru', 'en'];
  const КЛЮЧ_ХРАНИЛИЩА = 'karaoke-lang';

  /* Какой язык показать при первом заходе — всегда русский.
     Настройки браузера мы нарочно не спрашиваем: студия русская,
     русский текст живёт прямо в разметке, и он же должен встречать
     любого, кто зашёл впервые. Английский — только по явному выбору
     кнопкой в шапке; выбор запоминается и переживает перезагрузку. */
  const ПО_УМОЛЧАНИЮ = 'ru';

  let язык = (() => {
    try {
      const сохранён = localStorage.getItem(КЛЮЧ_ХРАНИЛИЩА);
      if (ЯЗЫКИ.includes(сохранён)) return сохранён;
    } catch (e) { /* хранилище недоступно — остаёмся на языке по умолчанию */ }
    return ПО_УМОЛЧАНИЮ;
  })();

  /* Подстановки, общие для всей разметки. Сюда попадает то, что обязано
     быть одинаковым на любом языке и потому не имеет права лежать
     в словаре: номер версии, про которую написан список «Что нового».
     Он объявлен один раз в разметке (data-news-version у <html>),
     оттуда же его берёт app.js — разойтись им негде. */
  const ПОДСТАНОВКИ = {
    версия: document.documentElement.dataset.newsVersion || '',
  };

  /* Как элемент выглядел по-русски. Снимаем один раз, при первом
     применении, и больше не трогаем: возврат на русский обязан
     возвращать ровно то, что написано в index.html. */
  const исходное = new WeakMap();

  function запомнить(el, поле, значение) {
    let о = исходное.get(el);
    if (!о) { о = {}; исходное.set(el, о); }
    if (!(поле in о)) о[поле] = значение;
    return о[поле];
  }

  const множественные = {};
  function форма(n) {
    if (!множественные[язык]) {
      множественные[язык] = new Intl.PluralRules(язык === 'ru' ? 'ru-RU' : 'en-US');
    }
    return множественные[язык].select(n);
  }

  /* Значение ключа. Для разметки английский лежит в EN, русский
     приходит из документа (аргумент «русский»).

     Обычно отвечаем на языке интерфейса, но иногда нужен другой:
     похвала после песни звучит на языке ПЕСНИ, а не студии (см. финал
     в app.js). Для этого есть необязательный третий довод. */
  function значение(ключ, русский, наЯзыке) {
    return значениеНа(ключ, русский, наЯзыке || язык);
  }

  function значениеНа(ключ, русский, язык) {
    const своя = I18N.СТРОКИ[ключ];
    if (своя) return своя[язык] !== undefined ? своя[язык] : своя.ru;
    if (язык === 'en') {
      const en = I18N.EN[ключ];
      if (en !== undefined) return en;
      if (!I18N.молча) console.warn('i18n: нет перевода для ключа', ключ);
    }
    return русский;
  }

  function подставить(строка, парам) {
    if (typeof строка !== 'string' || !парам) return строка;
    /* Имена подстановок бывают русскими, поэтому \w здесь не годится:
       он не считает буквой ни «о», ни «т». */
    return строка.replace(/\{([^{}]+)\}/g, (всё, имя) =>
      (парам[имя] === undefined ? всё : String(парам[имя])));
  }

  /* Главная функция. t('ключ') — строка из СТРОК на текущем языке;
     t('ключ', { n: 5 }) — она же с подстановкой и нужной формой. */
  function t(ключ, парам, наЯзыке) {
    let v = значение(ключ, ключ, наЯзыке);
    if (v && typeof v === 'object') {
      const n = парам && парам.n;
      v = v[форма(Number(n) || 0)] !== undefined
        ? v[форма(Number(n) || 0)] : v.other;
    }
    return подставить(v, парам);
  }

  /* ---------- Применение к документу ---------- */

  const АТРИБУТЫ = [
    ['i18nTitle', 'title'],
    ['i18nPlaceholder', 'placeholder'],
    ['i18nAria', 'aria-label'],
    ['i18nAlt', 'alt'],
    ['i18nContent', 'content'],   // описание страницы в <meta>
    // Подсказка с модификатором: %s подставляет app.js (Cmd или Ctrl)
    ['i18nModTitle', 'data-mod-title'],
  ];

  function применить(корень) {
    const где = корень || document;

    document.documentElement.lang = язык;

    /* Подстановки применяются и к русскому из разметки, и к английскому
       из словаря: {версия} должна раскрыться одинаково на обоих. */
    где.querySelectorAll('[data-i18n]').forEach((el) => {
      const ключ = el.dataset.i18n;
      el.textContent = подставить(
        значение(ключ, запомнить(el, 'текст', el.textContent)), ПОДСТАНОВКИ);
    });

    где.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const ключ = el.dataset.i18nHtml;
      el.innerHTML = подставить(
        значение(ключ, запомнить(el, 'html', el.innerHTML)), ПОДСТАНОВКИ);
    });

    for (const [поле, атрибут] of АТРИБУТЫ) {
      где.querySelectorAll(`[data-${поле.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}]`)
        .forEach((el) => {
          const ключ = el.dataset[поле];
          const было = запомнить(el, атрибут, el.getAttribute(атрибут) || '');
          el.setAttribute(атрибут, значение(ключ, было));
        });
    }

    // Заголовок вкладки и описание страницы
    const titleEl = document.querySelector('title[data-i18n]');
    if (titleEl) document.title = titleEl.textContent;

    document.dispatchEvent(new CustomEvent('i18n', { detail: { язык } }));
  }

  function установить(новый, корень) {
    if (!ЯЗЫКИ.includes(новый) || новый === язык) return;
    язык = новый;
    try { localStorage.setItem(КЛЮЧ_ХРАНИЛИЩА, язык); } catch (e) { /* некуда писать */ }
    применить(корень);
  }

  return {
    ЯЗЫКИ,
    t,
    применить,
    установить,
    язык: () => язык,
    английский: () => язык === 'en',
    молча: false,
    EN: {},        // разметка: ключ → английский текст
    СТРОКИ: {},    // код: ключ → { ru, en }
  };
})();

/* ============================================================
   ПОХВАЛА ПОСЛЕ ПЕСНИ

   Список, а не словарь, — и язык здесь ПО ПЕСНЕ, а не по интерфейсу.
   Пел человек по-русски — хвалим по-русски, даже если студия у него
   английская: похвала обращена к тому, кто только что стоял
   с микрофоном, и звучать она должна на языке, на котором он пел.
   Какой это язык, решает алфавит текста (см. языкПесни в app.js).

   Фразы намеренно разные по тону: от тихого «спасибо» до «это было
   ОГОНЬ». Выпадает случайная — иначе на третьей песне её перестают
   читать.
   ============================================================ */
I18N.ПОХВАЛЫ = {
  ru: [
    'Браво! Это было великолепно!',
    'Спасибо за этот момент! Ты лучший!',
    'Браво! Спасибо за прекрасное исполнение!',
    'Спасибо за выступление! Это было круто!',
    'Браво! Ты сделал это потрясающе!',
    'Спасибо, что поделился своим голосом!',
    'Браво! Спасибо за такую красоту!',
    'Спасибо за исполнение! Было великолепно!',
    'Браво! Это было незабываемо!',
    'Спасибо за музыку и настроение!',
    'Браво! Ты настоящий артист!',
    'Спасибо, что подарил нам эту песню!',
    'Браво! Было очень круто!',
    'Спасибо, что спел для нас. Ты лучший! \u2764\uFE0F',
    'Браво! Спасибо, что подарил нам этот момент!',
    'Спасибо за твой голос и твоё настроение!',
    'Браво! Слушать тебя — одно удовольствие!',
    'Спасибо за такую душевную песню!',
    'Браво! Ты сделал этот вечер особенным!',
    'Спасибо, что вышел к микрофону и зажёг!',
    'Браво! Спасибо за эмоции!',
    'Спасибо за прекрасное исполнение. Это было от души!',
    'Браво! Спасибо, что поделился своей энергией!',
    'Спасибо за песню! Было тепло, красиво и очень круто.',
    'Браво! Спасибо за этот маленький концерт!',
    'Спасибо, что сделал наш вечер ярче!',
    'Браво! Твой голос сегодня звучал особенно прекрасно!',
    'БРАВО! Спасибо, это было ОГОНЬ! \u{1F525}',
    'Спасибо за разрыв! Браво!',
    'Браво! Ты просто зажёг сцену!',
    'Спасибо за такое мощное выступление!',
    'Браво! Вот это подача!',
    'Спасибо за этот вокальный пожар! \u{1F525}',
    'Браво! Ты устроил настоящее шоу!',
    'Спасибо! Это было невероятно мощно!',
    'Браво! Вот так надо петь!',
    'Спасибо за энергию! Ты был великолепен!',
    'Браво! Сцена точно была твоей!',
    'Спасибо за такой драйв!',
    'Браво! Ты сегодня настоящая рок-звезда!',
    'Спасибо за выступление! Это было на высшем уровне!',
    'Браво! Спасибо за выступление — это было великолепно!',
    'Спасибо за песню! Ты настоящий талант!',
    'Браво! Спасибо, что подарил нам своё лучшее исполнение!',
    'Спасибо за этот невероятный вокал! Браво!',
    'Браво! Ты сделал эту песню своей!',
    'Спасибо за выступление! Ты был великолепен!',
    'Браво! Спасибо за настоящее музыкальное удовольствие!',
    'Спасибо, что спел! Ты определённо умеешь зажечь публику!',
    'Браво! Спасибо за такой прекрасный перформанс!',
    'Спасибо за песню! Ещё долго будем её вспоминать!',
    'Браво! Ты только что подарил нам отличный концерт!',
    'Спасибо за голос, эмоции и настроение!',
    'Браво! Спасибо за незабываемое исполнение!',
    'Спасибо! Это было настолько хорошо, что хочется ещё!',
    'Браво! Спасибо, микрофон тобой гордится!',
    'Спасибо за песню! Браво, микрофон теперь можно передавать следующему артисту!',
    'Браво! Спасибо за такой вокальный шедевр!',
    'Спасибо! Браво! Где твой сольный концерт?',
    'Браво! Спасибо за выступление — публика требует ещё!',
    'Спасибо за песню! Браво, звезда родилась! \u2B50',
    'Браво! Спасибо! Кажется, нам пора выпускать твой альбом.',
    'Спасибо за выступление! Браво, сцена тебя запомнила!',
    'Браво! Спасибо за прекрасный концерт длиной в одну песню!',
    'Спасибо! Браво! Грамми где-то рядом. \u{1F3C6}',
    'Браво! Спасибо за шоу! На бис!',
    'Спасибо за этот вокальный шедевр! Браво!',
    'Браво! Спасибо, что сделал караоке немного прекраснее!',
    'Спасибо за песню! Браво — сегодня ты звезда!',
    'Браво! Спасибо, что спел! Karaoke Punch гордится тобой!',
    'Спасибо за песню! Браво, ты настоящий Karaoke Punch!',
    'Браво! Спасибо за этот вокальный удар!',
    'Спасибо за выступление! Ты только что сделал настоящий Punch!',
    'Браво! Спасибо, что устроил такой Punch-концерт!',
    'Спасибо за голос! Браво — это было мощно!',
    'Браво! Спасибо за песню. Удар получился! \u{1F44A}\u{1F3A4}',
    'Спасибо за выступление! Punch одобряет. Браво!',
    'Браво! Спасибо, что спел от души!',
    'Спасибо за этот Punch-момент! Браво!',
  ],
  en: [
    'Bravo! That was magnificent!',
    'Thank you for this moment! You are the best!',
    'Bravo! Thank you for a beautiful performance!',
    'Thanks for the show! That was awesome!',
    'Bravo! You absolutely nailed it!',
    'Thank you for sharing your voice!',
    'Bravo! Thank you for something that lovely!',
    'Thanks for singing! It was magnificent!',
    'Bravo! That was unforgettable!',
    'Thank you for the music and the mood!',
    'Bravo! You are a true performer!',
    'Thank you for giving us this song!',
    'Bravo! That was really something!',
    'Thanks for singing for us. You are the best! \u2764\uFE0F',
    'Bravo! Thank you for giving us this moment!',
    'Thank you for your voice and your spirit!',
    'Bravo! Listening to you is pure pleasure!',
    'Thank you for a song with so much heart!',
    'Bravo! You made this evening special!',
    'Thanks for stepping up to the mic and lighting it up!',
    'Bravo! Thank you for the feeling!',
    'Thank you for a beautiful performance. Straight from the heart!',
    'Bravo! Thank you for sharing your energy!',
    'Thanks for the song! Warm, beautiful and very cool.',
    'Bravo! Thank you for this little concert!',
    'Thank you for making our evening brighter!',
    'Bravo! Your voice sounded especially good tonight!',
    'BRAVO! Thank you, that was FIRE! \u{1F525}',
    'Thanks for tearing it up! Bravo!',
    'Bravo! You set the stage alight!',
    'Thank you for a performance that powerful!',
    'Bravo! What a delivery!',
    'Thank you for that vocal blaze! \u{1F525}',
    'Bravo! You put on a real show!',
    'Thank you! That was incredibly powerful!',
    'Bravo! That is how it is done!',
    'Thank you for the energy! You were magnificent!',
    'Bravo! That stage was definitely yours!',
    'Thank you for the drive!',
    'Bravo! You are a proper rock star tonight!',
    'Thanks for the show! That was top class!',
    'Bravo! Thank you for the performance — it was magnificent!',
    'Thanks for the song! You are a real talent!',
    'Bravo! Thank you for giving us your very best!',
    'Thank you for that incredible vocal! Bravo!',
    'Bravo! You made that song your own!',
    'Thanks for the show! You were magnificent!',
    'Bravo! Thank you for real musical pleasure!',
    'Thanks for singing! You certainly know how to work a room!',
    'Bravo! Thank you for such a beautiful performance!',
    'Thanks for the song! We will be remembering it for a while!',
    'Bravo! You just gave us a great concert!',
    'Thank you for the voice, the feeling and the mood!',
    'Bravo! Thank you for an unforgettable performance!',
    'Thank you! That was so good it makes us want more!',
    'Bravo! Thank you, the microphone is proud of you!',
    'Thanks for the song! Bravo — the mic may now be passed on!',
    'Bravo! Thank you for that vocal masterpiece!',
    'Thank you! Bravo! Where is your solo concert?',
    'Bravo! Thanks for the show — the crowd wants more!',
    'Thanks for the song! Bravo, a star is born! \u2B50',
    'Bravo! Thank you! It might be time to release your album.',
    'Thanks for the show! Bravo, the stage will remember you!',
    'Bravo! Thank you for a wonderful one-song concert!',
    'Thank you! Bravo! A Grammy is somewhere nearby. \u{1F3C6}',
    'Bravo! Thanks for the show! Encore!',
    'Thank you for that vocal masterpiece! Bravo!',
    'Bravo! Thank you for making karaoke a little more beautiful!',
    'Thanks for the song! Bravo — tonight you are the star!',
    'Bravo! Thanks for singing! Karaoke Punch is proud of you!',
    'Thanks for the song! Bravo, you are a real Karaoke Punch!',
    'Bravo! Thank you for that vocal punch!',
    'Thanks for the show! You just landed a real Punch!',
    'Bravo! Thank you for a Punch of a concert!',
    'Thank you for the voice! Bravo — that was powerful!',
    'Bravo! Thanks for the song. The punch landed! \u{1F44A}\u{1F3A4}',
    'Thanks for the show! Punch approves. Bravo!',
    'Bravo! Thank you for singing from the heart!',
    'Thank you for that Punch of a moment! Bravo!',
  ],
};

window.I18N = I18N;
window.t = I18N.t;

/* ============================================================
   СЛОВАРЬ 1. Разметка: ключ → английский текст.
   Русский берётся из index.html, поэтому здесь его нет.
   ============================================================ */
I18N.EN = {
  /* ---------- Голова страницы ---------- */
  'мета.заголовок': 'Karaoke Punch — turn any song into karaoke',
  'мета.описание': 'Free karaoke studio in your browser: load a song, duck the vocals, time the lyrics line by line and word by word, and sing along with word-level highlighting. No servers, no sign-up.',

  /* ---------- Полоса обновления ---------- */
  'обновление.позже': 'Later',

  /* ---------- Окно «Что нового» ---------- */
  'новости.цветаДуэта': '<b>\u{1F3A8} You pick the duet colours.</b> Blue and pink were hard-wired in the code and came with every song. They are now part of the design, like the font and the line colour: three swatches on the “Colour” tab, and what you pick reaches the line list, the stage, the video frame, and travels with the project.',
  'новости.ширинаСписка': '<b>\u2194 The line list resizes like every other pane.</b> Every editor pane could be dragged except that one: it held a fixed share and took more than half the editor on a wide screen. It now has the same divider as its neighbours: mouse, arrow keys, a double click puts it back, and the width is remembered between sessions.',
  'новости.панельПараметров': '<b>The parameters panel no longer asks to be scrolled.</b> It has three sections — word, line, stretch — and open at once they needed twice the height available. Exactly one is open now: the one you just asked about with a click. A neighbour opens with its triangle. The buttons inside sit in two columns instead of six rows, and the pane is called “Parameters” rather than repeating the name of the open section.',
  'новости.тональностьУСтрелок': '<b>The key is spelled out right at the arrows.</b> You used to see “+2” and had to read the line below to learn which key that was. The stepper now says “0 (Am)”, “+2 (Bm)”, and “Apply” is an ordinary-sized button like “Reset” next to it. The settings column also stopped scrolling sideways: the “0 dB” readout was running off the right edge.',
  'новости.простораВРедакторе': '<b>The studio has more room.</b> The collapsed “How to edit the timing” help always took a row under the track, and it is read once — it moved into the guide behind the “How to use” button. In the app the song-rights line gave its space back to the stage: it is now an icon next to “Save video”. Both gains went where they matter — to the track and the stage.',
  'новости.логотипФинала': '<b>The finale logo is sharp again.</b> The finale draws it full-screen, but the picture came from the corner watermark — four times smaller than needed. The finale now has its own full-size file, with transparency: the logo stands on the dark finale background instead of a light square.',
  'новости.безМиганияСайта': '<b>The app no longer flashes the website on start.</b> For a second after launch you could see the site header and its showcase, and only then the studio — most noticeably on Windows. The app now knows what it is before the first paint.',
  'новости.тональностьПесни': '<b>\u{1F3BC} The studio tells you what key the song is in.</b> The “higher — lower” arrows used to move the recording blind: only someone who hears keys by ear knew what they were counting from. Now it says underneath what the song sounds like — “A minor”, say. We work it out from the clean vocal left over by vocal removal, and we say nothing when we are not sure: being wrong about the key is worse than staying quiet.',
  'новости.панельОтрезка': '<b>The original-stretch panel explains itself, and wakes up on a click.</b> It used to say “no stretch selected” and not a word about what to do to select one. And clicking a stretch on the track highlighted the block while the level slider stayed dead, leaving you to guess whether it was broken or meant to be that way. The panel now says where to click, and comes alive with the click.',
  'новости.колонкаНастроек': '<b>The karaoke settings fit without scrolling.</b> The “Colour” and “Sound” tabs ran out of height, so you had to scroll the column to reach a slider. We squeezed the air between the rows, not the text: same type, same wording, over a hundred points more room — every setting at once.',
  'новости.финалВидео': '<b>\u{1F3AC} The finale is in the video now — and it lands in three beats.</b> First the “Karaoke Punch” wordmark flies in full-screen, then the logo, and only then the praise and the score come up over it. The entrances are sharp: not a fade but a punch — a concert does not trail off, it lands. All of it goes into the recorded video, not just onto the screen.',
  'новости.финалПоСлову': '<b>The praise comes after the last word, not after the song.</b> A song can have half a minute of instrumental left, and the singer would stand there with the microphone wondering whether they had finished. The praise now appears three seconds after the last word, while the music plays on — the way karaoke actually works.',
  'новости.финал': '<b>\u{1F389} Praise and a score after the song.</b> You sing, and the karaoke says thank you: a random line out of eighty and a score that runs up to a frankly impossible number. Over the top on purpose: “you sang at 242,037,446 %” is funny precisely because it cannot happen. The praise comes in the language of the SONG, not the studio — it is addressed to whoever just held the microphone.',
  'новости.дуэты': '<b>\u{1F3A4} Duets.</b> A line now has a part: first voice, second, or “both sing”. The singer knows theirs by its colour — in advance, while the line is still waiting its turn. The colour shows in the line list, on the track and on stage, and goes into the video. And if the second voice comes in before the first voice’s line has ended, both light up and both fill in — the way it is actually sung.',
  'новости.пропускПроигрышей': '<b>Lyric timing no longer listens to the instrumental breaks.</b> The network used to listen to the song straight through, including the parts where there is nothing to sing. But we know where the singing is: vocal removal shows us. Now only the sung stretches are listened to — on a song with long breaks that is twice as fast, and more accurate: on pure music the model is prone to inventing words.',
  'новости.зеркало': '<b>The recognition model lives with us.</b> The weights were downloaded from someone else’s server, and without them lyric timing does not work at all. They are now in our own storage and are fetched from there first; the original source remains the fallback.',
  'новости.фокус': '<b>Editing lyrics works again on Windows.</b> Switch to another window and back, and letters stopped going in: the window got the focus, the page inside it did not. The mouse kept working as if nothing were wrong, text still selected — and from the outside it looked like the editor had broken. The keyboard now comes back to the page by itself.',
  'новости.видеокарта': '<b>\u26A1 Vocal removal runs on the graphics card — four times faster.</b> It used to run on the CPU while the graphics card sat idle next to it. The model, the graph and the precision are the same; only the performer changes: on a 25-second measurement, 38.8 seconds against 10.2 — with results identical to four decimal places. No graphics card, or it won’t start? We compute on the CPU, as before.',
  'новости.однаМодель': '<b>Lyric timing is down to one model.</b> The second one, twice as fast and noticeably worse, is gone: making out singing is its whole job, and a choice between “fast and wrong” and “slower and right” is no choice at all when the first has to be redone anyway. The model list and the “More options” fold went with it.',
  'новости.двеПары': '<b>The project and the timing file have stopped competing.</b> Four identical round buttons in a row read as four equal ways to save. The main one is now the project folder, while the .kpunch file is set apart by a rule and labelled for what it does: it carries the timing alone, without audio — to another computer, or to someone who already has this song.',
  'новости.проект': '<b>\u{1F4C1} A project is a folder, the way editing suites do it.</b> A draft is timing without audio: you have to open it over the same song, and it doesn’t bring the neural instrumental at all — after a restart you had to work it out again. Now you can save the project as a folder: the song, the instrumental, the background and all the timing live together. Open the folder and the studio is back where you left it, with nothing recomputed. Cmd+S saves to the same folder, Cmd+O opens one.',
  'новости.громкостьОтрезка': '<b>\u{1F50A} A stretch of the original has a level of its own.</b> A stretch where the recording plays instead of the instrumental sounded exactly as recorded — and “keep the original bit, but quieter” could not be done at all. Now every stretch has its own level, and an “original” button in the line and word panels lays a stretch out over exactly the piece you picked. What you set goes into the .wav instrumental and into the video too.',
  'новости.черновикСтроки': '<b>Lines on the preview no longer run ahead.</b> After opening a draft the text changed noticeably earlier than it is sung, whatever stood on the track. The voice envelope was to blame: a draft could lose it, or wipe the one you had. Now it waits for the song and leaves someone else’s alone, and the line end the network found counts alongside word timing.',
  'новости.разметкаОдна': '<b>Lyric timing is down to one button.</b> Transcribing from scratch is gone: it made out singing poorly, and instead of help you got a draft that had to be rewritten end to end. What is left is fitting your own lyrics — the words are yours, the timing comes from the network. The “detect the language” option is gone too: on singing it missed, and missing the language means missing every word at once.',
  'новости.первыйШаг': '<b>The first step starts with the main thing.</b> The “Remove the vocals” block stood last, after your own instrumental and the background picture — so the main action ended up at the very bottom of the card. Now it comes first and stands out: remove the vocals, and on the “Lyrics” step the network will time your own lines.',
  'новости.виндоус': '<b>On Windows you can see where you are typing.</b> The page said nothing about being dark, so the system decided for it: scrollbars came out white and the caret colour was left to the engine. The studio now states its own colour scheme — the scrollbars are dark whatever the system theme is, and the caret in every field glows in the accent of the chosen theme.',
  'новости.минусовкаПотеряна': '<b>The studio says when the neural instrumental is gone.</b> The audio tracks themselves are not kept in the project — they run to hundreds of megabytes — but the voice envelope is. After a restart the “voice” track is still there and everything looks as though the vocals were removed by the network, while what you hear is the built-in ducking, and the original comes through in karaoke. The studio now warns about it on the first step, next to the “Remove vocals” button.',
  'новости.переключатели': '<b>Theme and language are picked from a list.</b> The header had collected too many buttons, so both pairs became drop-down lists. The languages are labelled in their own words — “Русский” and “English” — so that people who cannot read the current one still find theirs. The inspector on the right is half as tall now, and its width is set by a divider you can drag.',
  'новости.права': '<b>The video is saved as a file, not “for YouTube”.</b> The button is named after what you get, like its neighbours “Lyrics .lrc” and “Instrumental .wav”. A short line about rights sits next to it: make karaoke from what you have the rights to, and publishing the finished video is up to whoever publishes it. The project also has a licence now, and a list of the licences of everything that ships inside it.',
  'новости.дорожкаБольше': '<b>The timeline is twice as tall.</b> It used to take 122 pixels on any screen, and the timing was hard to read on it. A divider you can drag now sets the height: move it once and the studio remembers. The tracks share whatever height they are given instead of standing at a fixed size, so the waveform, the voice, and the lines with their words all grew along with it.',
  'новости.стальная': '<b>A third theme — “Steel”.</b> A cold grey ground, panels lighter than the background and a blue accent, in the spirit of editing suites. The theme switch became a drop-down list: three buttons in a row made the header crowded. The level sliders on the timeline tracks were brought up to match, too: a wide groove and a large handle, the way a fader looks.',
  'новости.темп': '<b>The tempo is worked out far more confidently.</b> The studio used to listen to overall loudness, and on a dense mix the beats barely show through it: confidence came out at 7–9%, and one song and its own instrumental could disagree by half again. The tempo is now read from the spectrum — from where a new sound appears, not where it merely gets louder. Confidence is up to 41–47%, and a song and its instrumental now give the same tempo and the same downbeat.',
  'новости.плавность': '<b>The editor stopped working for nothing.</b> Sitting on pause, the studio redrew the timeline three hundred times a second with the very same picture and recalculated the karaoke stage from step four. Dragging an edge while the music played scrolled the line list on every frame. Only what actually changed now reaches the frame: dragging runs at the full frame rate instead of three quarters of it.',
  'новости.словарь': '<b>The interface calls things by one name.</b> Timeline and track, song and audio, look and styling, preview and view — the same thing went by different names in different corners of the studio, and in the translation too. There is a glossary now: the timeline as a whole and a track as one of its rows, a stretch of the original and a range of lines, a project and a draft.',
  'новости.починки': '<b>Fixes after a bug hunt.</b> The big one: a tapping run is no longer lost. Tap a line later than the mark already sitting on the next one and the studio failed silently — the “erase the marks after this?” question never appeared, and the run itself was never saved, so it vanished on reload. Also: editor keys no longer fire through open windows (you could page through the guide with the arrow keys and quietly shift your timing), the tempo field no longer sticks on a rejected number, text cleared in a line field comes back honestly, “reset words” redraws the timeline at once, and a very long word now wraps instead of running off the stage.',
  'новости.тональность': '<b>You can sing a song in your own key.</b> Karaoke step → Look → Sound: shift it up to seven semitones up or down. The tempo does not move by a hundredth — all the timing stays where it was, and the .wav instrumental and the video carry the same key you rehearsed with. It is worked out once before you sing, about half a minute per song; the choice is remembered, and going back to a key you already used is instant.',
  'новости.краяСлов': '<b>Any word’s start can be edited now.</b> The first word of a line had no handle at all: it was moved by the line start, and a pause before the singer comes in could not be expressed. It now has a handle and a field like every other word. The last word’s end works too: the melisma tail still stretches on its own, but an end set by hand stays where it was put.',
  'новости.подложка': '<b>The scrim under the text covers all of it.</b> It used to be of a fixed height while the line positions move on sliders — pull the lines apart and the second one hung on bare artwork. The scrim is now measured from where the lines actually are, and you can set its height yourself. Along with it: an instrumental break is drawn with five notes instead of three, the count-in dots never land on the text any more, and the sound under the cursor is off by default — switch it on like snapping.',
  'новости.безВитрины': '<b>The app opens straight into the studio.</b> The site’s shop window — the cover, the feature cards, the questions — is no longer shown inside the program: you read that when you downloaded it, not every time you start it. The window opens maximised and the studio fills it. “How to use it” opens the guide over the studio.',
  'новости.тише': '<b>The studio got quieter.</b> The colour key moved under the “? colours” button by the timeline, the help text moved below the editor, the invitation in the original track fades once you make your first stretch, the line list shows two time columns instead of three, and the “♪” mark now flags the rare case: once the whole song is timed by word, it marks the lines WITHOUT hand-made word marks. The inspector folds up by section, and remembers it.',
  'новости.скиммирование': '<b>Sound under the cursor, just from hovering.</b> A passage used to play only while you dragged the playhead. Now moving the mouse over the timeline is enough: you find the spot by ear, and the playhead stays where it was.',
  'новости.поиск': '<b>Search across the lines.</b> A song runs to fifty lines and the right one had to be found by eye. The field above the list keeps only what matches; the numbers stay real, Esc brings everything back.',
  'новости.подсказки': '<b>Every button has a hint.</b> Our own, not the system one: it shows up at once and is written in the studio’s own style. Forty-seven buttons that said nothing at all were found and labelled along the way.',
  'новости.черновик': '<b>Your project can be saved to a file.</b> The project used to live only in the browser’s memory, and that memory goes: a cleared cache, another browser, a reinstall. There is a draft file now — lyrics, timing, original stretches and the look — saved and opened with the buttons beside the step row. The same place shows whose project the studio is holding right now: before you load another song, not after.',
  'новости.время': '<b>Time is written the same way everywhere.</b> The timeline said “3:10” while the fields said “190”, and there was no way to check one against the other. It is minutes and seconds all round now, and a field takes either form. The inspector was rearranged too: the selected word on top, the line it belongs to underneath.',
  'новости.дописанные': '<b>Add a line and it shows up on the timeline.</b> You remember a forgotten verse, type it in — and those lines simply were not on the timeline: with no timing there is nothing to draw. Now a new line is given room between its neighbours and marked “≈”: the timing is a guess and worth checking.',
  'новости.пауза': '<b>Words can have a pause between them.</b> A word’s end had to equal the next one’s start, so on a swallowed word the highlight sailed right on. Drag the joint between two words with <kbd><span class="mod-key">Cmd</span></kbd> held and the edges come apart — in the pause the highlight honestly waits.',
  'новости.диапазон': '<b>A range of timing can be moved or stretched.</b> A verse drifts half a second late — the whole song used to move with it. Select a range by dragging along the ruler (or Shift-clicking in the line list) and move it as one; pull an edge and every time inside stretches proportionally, word marks included.',
  'новости.наушники': '<b>You can hear where you are pointing.</b> While you drag the playhead or an edge, the sound under the cursor plays — the spot is found by ear in a second. Tracks also gained a “listen to this only” button and a level slider: music quieter, voice as recorded — that is how words get made out.',
  'новости.доли': '<b>A beat grid.</b> The studio works out the song’s tempo and can snap edges to beats. You switch it on yourself: the tempo is not always read correctly, and a wrong grid would get in the way more than it helped. The tempo and the first beat’s offset can both be set by hand.',
  'новости.словаНастройки': '<b>Words now have settings of their own.</b> Precise editing used to stop at the line — a word could only be dragged. A selected word now has numeric start, end and length fields, the same keys as a line, loop playback and snapping. Next to them: “spread”, which lays the words out across the line by syllable count.',
  'новости.тема': '<b>The studio now looks like an editing suite.</b> Tighter layout, proper icons instead of mismatched emoji, times down to the millisecond, a column of track names, and the exact time under the cursor while you drag. There is a theme picker too — the green signature look or a neutral grey one, right in the header.',
  'новости.закрыть': 'Close',
  'новости.починки': 'Fixes and improvements',
  'новости.раньше': 'Earlier releases',
  'новости.версияСлово': 'Version',
  'новости.значок': 'Update',
  'новости.заголовок': 'What’s new in {версия}',
  'новости.язык': '<b>\u{1F30D} The interface speaks English now.</b> The language switch sits in the header \u2014 in reach from every step of the studio. Everything you see is translated \u2014 labels, hints, questions, the guide and messages. Your lyrics, of course, stay yours.',
  'новости.установщик': '<b>📦 The installer is 40 MB lighter.</b> A second copy of the neural-network engine had been slipping into the app by oversight — 131 MB that nothing ever loaded. It’s gone now: 202 MB instead of 242.',
  'новости.клавиши': '<b>⌨️ Key names match your system.</b> On Windows the hints said “Cmd+Z” — a key that isn’t there. The code was right all along; only the labels lied.',
  'новости.вокал': '<b>🎚 Vocal removal is cleaner and faster.</b> We switched to the very model UVR5 runs. Measured against an instrumental made by the real UVR5, the match went from 84% to 94%. The model is three times lighter too — 64 MB instead of 172. And the wait is shorter: the old “accurate mode” with three passes turned out to add nothing — the difference from a single pass is down at the noise floor — so one pass is now the default.',
  'новости.имя': '<b>🥊 The studio is now called Karaoke Punch.</b> Only the name changed: every project, every timing and every downloaded model stayed put and moved across on its own.',
  'новости.оригинал': '<b>🎤 Bring the original back where you want it.</b> Sometimes the opening should stay as it is — someone is talking, or another voice is singing — and you take over after that. On the editor timeline you mark the stretches where the original plays instead of the instrumental: drag to create, pull the edges, delete what you don’t need. Works the same in karaoke, in the exported instrumental and in the video.',
  'новости.магнит': '<b>🧲 Edges snap.</b> While you drag a line edge it sticks to neighbouring lines, to the playhead, to the edges of original-audio stretches and to real vocal onsets. Holding Alt suspends the snap for that drag — same as Logic Pro and Final Cut.',
  'новости.шаги': '<b>🎯 Four steps now, and tapping moved into the editor.</b> There is no separate “Sync” step any more: tapping the spacebar is a mode inside the editor. While it runs, the line list and the preview step aside, leaving the current line large on screen, the next one below it, a counter, and the timeline where marks appear as you go. You can start tapping anywhere: earlier marks are left alone, every hit undoes on its own, and the whole run undoes with the usual <span class="mod-key">Cmd</span>+Z.',
  'новости.разметка': '<b>🗣 The network times your own lyrics.</b> Paste the lyrics and the Whisper model listens to the singing, finds where each word is sung, and lays your lines out on those marks. Line and word timings appear by themselves — no tapping needed. The words stay yours: only the timing comes from the network, and it gets timing wrong far less often than letters. Lines it barely made out are flagged with ≈ — worth a check. It comes out better if you remove the vocals first: then the network hears a clean voice instead of a mix.',
  'новости.редактор': '<b>🎚 A real timeline in the editor.</b> Lines and words are drawn as blocks — you see length, not just a start point. Drag the edges, drag the whole block, undo and redo (<span class="mod-key">Cmd</span>+Z), loop a line, and keys for everything else. And in the <span class="only-web">desktop version</span><span class="only-desktop">app</span> a vocal envelope is laid over the timeline: you can see where the singing actually is, and edges pull towards the real onset instead of a guess.',
  'новости.слова': '<b>✨ Highlighting follows the words.</b> The fill no longer crawls through a line at a constant speed — it steps at word boundaries, the way modern karaoke players do. Same on stage, in the editor preview and in the video.',
  'новости.разметкаСлов': '<b>♪ Word timing by hand.</b> The selected-line panel has a “♪ words” button: the passage plays with vocals and you tap the spacebar on each word. Next to it a new export — “.lrc with words”, the extended format with a timestamp on every word.',
  'новости.отсчёт': '<b>⏱ A count-in before you sing.</b> Three dots fade out over the three seconds before a line starts — no more guessing when to come in after an instrumental break.',
  'новости.подача': '<b>🎨 Calmer text.</b> Lines cross-fade, inactive ones dim and, if you like, blur, and instead of darkening the whole frame there is a soft scrim under the text. All of it goes into the video too.',
  'новости.ещё': 'And the <a href="#desktop" id="whatsnew-link">desktop version</a> has two more neural networks: lyric timing and vocal removal.',
  'новости.ок': 'Got it',

  /* ---------- Шапка ---------- */
  'шапка.возможности': 'Features',
  'шапка.компьютер': 'Desktop',
  'шапка.как': 'How it works',
  'шапка.вопросы': 'FAQ',
  'шапка.язык': 'Interface language',
  'шапка.тема': 'Theme',

  /* ---------- Первый экран ---------- */
  'герой.заголовок': 'Turn any song<br><span class="grad-text">into karaoke</span>',
  'герой.подзаголовок': 'Load a song — the studio ducks the vocals, helps you time the lyrics line by line and word by word, and runs karaoke with word-level highlighting. Nothing is uploaded anywhere: it all happens on your device.',
  'герой.вБраузере': 'Make karaoke in the browser (beta)',
  'герой.скачать': 'Neural networks remove the vocals and time the lyrics — right on your computer',
  'герой.мак': '🍎 Download for macOS',
  'герой.виндоус': '🪟 Download for Windows',
  'герой.приватно': '100% private',
  'герой.файлы': 'files never leave your computer',

  /* ---------- Возможности ---------- */
  'возможности.заголовок': 'Everything a karaoke night needs',
  'возможности.вокал.заголовок': 'Vocal ducking',
  'возможности.вокал.текст': 'In the browser the voice sitting in the centre of the stereo image is cancelled straight away, and vocal level stays adjustable while you sing. Need a truly clean instrumental — load a ready one as a second file, or take the <a href="#desktop">desktop version</a> with its neural network.',
  'возможности.текст.заголовок': 'Lyric timing',
  'возможности.текст.текст': 'Paste the lyrics — then tap the spacebar on each line, in time with the music, right in the editor. That’s also where you fix the starts and ends of lines, audition them one by one, drag blocks on the timeline, and use the “♪ words” button to tap out every word inside a line.',
  'возможности.караоке.заголовок': 'Karaoke mode',
  'возможности.караоке.текст': 'Highlighting steps word by word, and three count-in dots fade out before you come in after a break. Your own background image, font, size, colours, outline, scrim under the text, equaliser. Export what you made: video up to 2K, instrumental as WAV, lyrics as LRC — plain or with a timestamp on every word.',

  /* ---------- Настольная версия ---------- */
  'настольная.заголовок': 'Desktop version: two neural networks inside',
  'настольная.вокал': '<b>Remove the vocals.</b> In the browser the voice is ducked the simple way — fast, but reverb tails and backing vocals stay. The desktop version strips it out with the local UVR-MDX-NET-Inst_HQ_3 model — the very one UVR5 runs. The model downloads once, weighs 64 MB, and works offline afterwards.',
  'настольная.текст': '<b>Time the lyrics.</b> Paste the lyrics and the Whisper model listens to the singing, finds where each word is sung, and lays your lines out on those marks. Line and word timings appear by themselves — no tapping needed. The words stay yours: only the timing comes from the network, and it gets timing wrong far less often than letters. It comes out better if you remove the vocals first: then the network hears a clean voice instead of a mix.',
  'настольная.локально': 'Your computer does all the work; nothing goes to the internet.',
  'настольная.мак': '🍎 Download for macOS',
  'настольная.виндоус': '🪟 Download for Windows',
  'настольная.заметка': 'Free and open source. Each model downloads once, on first use — after that you don’t need the internet: vocal removal is 64 MB, lyric timing 242 MB. A 3-minute song is cleaned in about a minute on a graphics card, and three and a half without one.<br>macOS — Apple Silicon; Windows — x64 and ARM. <a href="https://github.com/Gyros-dev/karaoke-maker/releases/latest">All releases and release notes</a>',
  'настольная.первыйЗапуск': 'First launch: your system will ask for confirmation',
  'настольная.подпись': 'The app is self-signed but not notarised by Apple: a developer certificate costs money. So the system refuses the first launch — you allow it by hand, once.',
  'настольная.мак.как': '<b>macOS — step by step:</b>',
  'настольная.мак.шаг1': 'Open the downloaded <code>.dmg</code> and drag “Karaoke Punch” into Applications — the disk image window has an arrow showing where.',
  'настольная.мак.шаг2': 'Launch the app. The system refuses with a window titled <b>“Karaoke Punch” Not Opened</b> — “Apple could not verify…”. Press <b>Done</b> in it. Not “Move to Trash”: that button throws the app away.',
  'настольная.мак.шаг3': 'Open System Settings → Privacy &amp; Security and scroll down to the Security section. There you will now see “Karaoke Punch” was blocked to protect your Mac and an <b>Open Anyway</b> button.',
  'настольная.мак.шаг4': 'A <b>second</b> window pops up — “Open ‘Karaoke Punch’?”. Press <b>Open Anyway</b> again. This is where people get stuck: it looks as if the first press did nothing — it did, the system simply asks twice.',
  'настольная.мак.шаг5': 'That’s it. From now on the app opens like any other, with nothing to confirm.',
  'настольная.мак.терминал': 'The quick way, if a command feels easier: drag the app into Applications, open Terminal and clear the “downloaded from the internet” flag — then there are no windows at all.',
  'настольная.виндоус.как': '<b>Windows.</b> SmartScreen shows a blue window → “More info” → “Run anyway”.',

  /* ---------- Как это работает ---------- */
  'как.заголовок': 'How it works',
  'как.лид': 'The recommended route is four steps. Below, in collapsed blocks, the editor and everything else.',
  'как.шаг1.заголовок': 'Add a song',
  'как.шаг1.текст': 'MP3, WAV, OGG and M4A all work. You can pick a background image for the karaoke while you’re here.',
  'как.шаг1.приложение': '<b>And press “Remove vocals” right away.</b> The network will work out a clean instrumental on your computer — not only nicer to sing over, but noticeably better timing on the next step, because the network will hear a voice instead of a mix. It takes a while (the estimate is under the button), which is exactly why it should go first.',
  'как.шаг1.сайт': 'If you already have a clean instrumental — from UVR5, say — drop it into the “Your own instrumental” field: it sounds much better than the built-in ducking.',
  'как.шаг2.заголовок': 'Paste the lyrics',
  'как.шаг2.текст': 'One non-empty line is one karaoke line. Finding the lyrics and copying them takes half a minute; timing them by hand takes far longer.',
  'как.шаг2.приложение': '<b>Then press “Fit my lyrics”.</b> The network listens to the singing, finds where each word is sung, and lays your lines out on those marks: the words stay yours, only the timing comes from the network. Line and word timings appear by themselves — no tapping needed.',
  'как.шаг3.заголовок': 'Time it in the editor',
  'как.шаг3.сайт': '<b>Tap the song out with the spacebar.</b> The editor has a tapping mode: the song plays and you hit the spacebar at the start of each line. You can start anywhere — earlier marks are left alone.',
  'как.шаг3.приложение': '<b>Check what the network laid out.</b> Lines it barely made out are flagged with ≈ — start there. The rest usually just needs a loop and a nudge of the edges on the timeline.',
  'как.шаг3.дальше': 'Then polish: edit the text, drag blocks on the timeline, loop a line, time the words inside a line. More in the “Editor” block below.',
  'как.шаг4.заголовок': 'Sing and save',
  'как.шаг4.текст': 'The “Karaoke” step is where you set up the look of the text, the background, the vocal level and the equaliser — and then save the song as a file: .lrc, a .wav instrumental or a finished video. More in the “Look and what you can save” block below.',
  'как.редактор.заголовок': 'Editor: timeline, snapping, original-audio stretches, words, tapping',
  'как.редактор.дорожка': '<b>Timeline.</b> Lines and words are drawn as blocks — you see length, not just a start point. Drag the edges, drag the whole block. Arrow keys nudge the selected line a little; with Alt held, a lot. <span class="mod-key">Cmd</span>+Z undoes, <span class="mod-key">Cmd</span>+Shift+Z redoes. The loop button plays the selected line round and round — the fastest way to tell whether the timing lands.',
  'как.редактор.магнит': '<b>Snapping.</b> While you drag an edge it sticks to neighbouring lines, to the playhead, to the edges of original-audio stretches and to real vocal onsets. Holding <b>Alt</b> suspends it for that drag — same as Logic Pro and Final Cut. <span class="only-desktop">In the app a vocal envelope is drawn on the timeline as well: you can see where the singing actually is.</span>',
  'как.редактор.отрезки': '<b>Original-audio stretches.</b> Sometimes the opening should stay as it is — someone is talking, or another voice is singing. Drag across the stretch track: inside a stretch the original plays instead of the instrumental, the edges can be pulled, an unwanted stretch removed. Works the same in karaoke, in the exported instrumental and in the video — wherever the “Vocals” slider sits.',
  'как.редактор.слова': '<b>Word timing.</b> If the words aren’t timed, the line’s time is split between them by length — usually enough. When you want it exact, the selected line has a <b>“♪ words”</b> button: the passage plays with vocals and you tap the spacebar on each word. Timed lines are marked green; reset brings the automatic split back.',
  'как.редактор.простукивание': '<b>Tapping.</b> There is no separate step — it’s a mode inside the editor. While it runs, the line list and the preview step aside: the current line stays large on screen, with the next one, a counter and the timeline, where marks appear as you go. Every hit undoes on its own, and the whole run undoes with the usual <span class="mod-key">Cmd</span>+Z.',
  'как.экспорт.заголовок': 'Look and what you can save',
  'как.экспорт.оформление': '<b>Look.</b> Tabs down the left of the “Karaoke” step: font and size, colours, stage (where the lines sit, the scrim under the text, blur on the inactive lines, the three-dot count-in before a line) and sound (vocal level and equaliser). Everything shows up straight away in the preview on the right, and the F key blows it up full screen.',
  'как.экспорт.lrc': '<b>.lrc</b> is the standard synced-lyrics format: a line and its time. Plenty of players read it. Next to it, “.lrc with words” — the extended variant with a timestamp on every word.',
  'как.экспорт.wav': '<b>Instrumental .wav</b> — the audio without vocals as a single file, including the stretches where you kept the original.',
  'как.экспорт.видео': '<b>Video</b> — a finished clip with background, text and instrumental in HD, Full HD or 2K, as a <b>.webm</b> file. It records in real time, so it takes exactly as long as the song; you can minimise the window and recording carries on.',
  'как.экспорт.сохранение': 'Lyrics, timings, word timing and the look are saved automatically and survive closing the <span class="only-web">tab</span><span class="only-desktop">app</span>. The only thing you have to pick again is the audio file itself.',

  /* ---------- Студия: шаги ---------- */
  'студия.заголовок': 'Studio',
  'студия.шаг1': '<span>1</span> Song',
  'студия.шаг2': '<span>2</span> Lyrics',
  'студия.шаг3': '<span>3</span> Editor',
  'студия.шаг4': '<span>4</span> Karaoke',
  'студия.шаг1.подсказка': 'Step 1: load the song, your own instrumental and a background picture',
  'студия.шаг2.подсказка': 'Step 2: paste the lyrics — one line of text becomes one karaoke line',
  'студия.шаг3.подсказка': 'Step 3: time the lines and the words on the timeline',
  'студия.шаг4.подсказка': 'Step 4: the look, preview and export',
  'студия.справка': 'How to use it',
  'студия.справка.подсказка': 'A short guide: the recommended route, the editor and exporting',
  'студия.справка.aria': 'How to use it',

  /* ---------- Шаг 1 ---------- */
  'шаг1.перетащи': 'Drop an audio file here<br>or click to choose one',
  'шаг1.форматы': 'MP3 · WAV · OGG · M4A',
  'шаг1.обработка': 'Processing the song…',
  'шаг1.моно': 'The file is mono — vocals can’t be ducked, but lyric timing and karaoke will work.',
  'шаг1.минусовкаПотеряна': 'The instrumental made by the neural network is not kept between launches: what you hear now is the built-in ducking, and the vocals come through it. Remove the vocals again — or load your own instrumental from a file.',
  'шаг1.фон.заголовок': 'Karaoke background',
  'шаг1.фон.текст': 'Optional: the picture sits under the text while you sing',
  'шаг1.фон.alt': 'Karaoke background',
  'шаг1.убрать': 'Remove',
  'шаг1.порядок': '<b>This is where you start.</b> Remove the vocals, and on the “Lyrics” step the network will time your own lines. Everything else on this step is optional.',
  'шаг1.минусовка.заголовок': 'Your own instrumental',
  'шаг1.минусовка.текст': 'Optional: a ready file with no vocals (from UVR5, say) — sounds much better than the built-in ducking',
  'шаг1.минусовка.готова': '✓ loaded',
  'шаг1.другойФайл': 'Another file',
  'шаг1.дальше': 'To the lyrics →',
  'шаг1.фон.выбрать.подсказка': 'Pick a picture: it sits under the text on the karaoke stage and goes into the video',
  'шаг1.фон.убрать.подсказка': 'Remove the picture — the stage goes back to its plain background',
  'шаг1.минусовка.выбрать.подсказка': 'Pick a ready file with no vocals: it will play instead of the built-in ducking',
  'шаг1.минусовка.убрать.подсказка': 'Drop your own instrumental and go back to the built-in vocal ducking',
  'шаг1.другойФайл.подсказка': 'Load a different song. The lyrics, the timing and the look stay',
  'шаг1.дальше.подсказка': 'Go to step 2: paste the lyrics',

  /* ---------- Шаг 1: блоки приложения ---------- */
  'ии.заголовок': '🧠 Remove the vocals with a neural network',
  'ии.текст': 'The local UVR-MDX-NET-Inst_HQ_3 model — the same one UVR5 runs. All of it is worked out on your computer',
  'ии.кнопка': 'Remove vocals',
  'ии.кнопка.подсказка': 'Work out the instrumental with a neural network right on this computer. The song is not sent anywhere',
  'ии.ещё': 'More options',
  'ии.качество': 'Quality',
  'ии.один': 'One pass',
  'ии.три': 'Three passes — three times the wait',
  'ии.пояснение': 'We measured it: three offset passes give the same result as one. They differ by −31 dB, and the vocal residue matches to the second decimal. This used to be set to three passes with a promise of better quality — which turned out to be untrue, and cost you three times the wait for nothing. The choice is left in case your recording does show a difference, but one pass is the default.',
  'ии.готовим': 'Preparing the model…',
  'ии.локально': 'Worked out on your computer; nothing is sent to the internet.',
  'ии.отменить': 'Cancel',

  'asr.заголовок': '🗣 Lyric timing by neural network',
  'asr.подгонка': '<b>The lyrics are in place — the network will time them.</b> It listens to the song, finds where each word is sung, and lays your lines out on those marks: the words stay yours, only the timing comes from the network. That is more reliable than transcribing from scratch — the model gets timing wrong far less often than letters. It comes out better still if you remove the vocals on step one first: then it hears a clean voice instead of a mix.',
  'asr.язык': 'Language',
  'asr.язык.ru': 'Russian',
  'asr.язык.en': 'English',
  'asr.язык.uk': 'Ukrainian',
  'asr.язык.de': 'German',
  'asr.язык.fr': 'French',
  'asr.язык.es': 'Spanish',
  'asr.язык.it': 'Italian',
  'asr.готовим': 'Preparing the model…',
  'asr.локально': 'Worked out on your computer; nothing is sent to the internet.',
  'asr.отменить': 'Cancel',

  /* ---------- Шаг 2 ---------- */
  'шаг2.подсказка': 'Paste the lyrics. One line of text is one karaoke line. Empty lines don’t count.',
  'шаг2.поле': 'Paste the lyrics here…\n\nEach line is\na separate karaoke line',
  'шаг2.назад': '← Back',
  'шаг2.дальше': 'To the editor →',
  'шаг2.назад.подсказка': 'Back to step 1: song, instrumental and background',
  'шаг2.дальше.подсказка': 'Split the lyrics into lines and go on to timing them',

  /* ---------- Шаг 4: оформление ---------- */
  'караоке.оформление': 'Look',
  'караоке.сбросить': 'Reset',
  'караоке.вкл.текст': 'Text',
  'караоке.вкл.цвет': 'Colour',
  'караоке.вкл.сцена': 'Stage',
  'караоке.вкл.звук': 'Sound',
  'караоке.сбросить.подсказка': 'Put the whole look of the text back to its defaults',
  'караоке.вкл.текст.подсказка': 'What the lines are set in and how big they are',
  'караоке.вкл.цвет.подсказка': 'Line colours, the singing effect, the outline and the stage background',
  'караоке.вкл.сцена.подсказка': 'How many lines show, where they sit and how they appear',
  'караоке.вкл.звук.подсказка': 'Equaliser: you hear it in the player and it goes into the video',
  'караоке.эффект.заливка.подсказка': 'The line fills with colour left to right as it is sung',
  'караоке.эффект.подсветка.подсказка': 'The word being sung lights up whole, with no letter-by-letter fill',
  'караоке.эффект.нет.подсказка': 'No effect: the line simply brightens when its turn comes',
  'караоке.фон.какбыло.подсказка': 'Stage background as it was: your picture, or the plain dark ground',
  'караоке.фон.цветом.подсказка': 'Fill the stage with the chosen colour instead of a picture',
  'караоке.появление.плавно.подсказка': 'A new line fades in',
  'караоке.появление.сдвиг.подсказка': 'A new line slides in from below',
  'караоке.появление.нет.подсказка': 'A new line appears at once, with no motion',
  'караоке.выравнивание.верх.подсказка': 'Push the lines to the top of the frame',
  'караоке.выравнивание.центр.подсказка': 'Keep the lines in the middle of the frame',
  'караоке.выравнивание.низ.подсказка': 'Push the lines to the bottom of the frame',
  'караоке.эквалайзер.сбросить.подсказка': 'Set all three equaliser bands back to zero',
  'караоке.играть.подсказка': 'Play and pause (space)',
  'караоке.шрифт': 'Font',
  'караоке.размер': 'Size',
  'караоке.размер.подсказка': '100% is the largest size at which lines still fit on one row. Larger is fine too: long lines will wrap onto two rows',
  'караоке.жирность': 'Weight',
  'караоке.межбуквенный': 'Letter spacing',
  'караоке.межстрочный': 'Line spacing',
  'караоке.поля': 'Side margins',
  'караоке.эффект': 'Effect',
  'караоке.эффект.заливка': 'Fill',
  'караоке.эффект.подсветка': 'Highlight',
  'караоке.эффект.нет': 'None',
  'караоке.цветаПартий': 'Duet colours',
  'караоке.цвет.партия1': 'First voice',
  'караоке.цвет.партия1.мини': '1st',
  'караоке.цвет.партия2': 'Second voice',
  'караоке.цвет.партия2.мини': '2nd',
  'караоке.цвет.партияОба': 'Both sing',
  'караоке.цвет.партияОба.мини': 'both',
  'караоке.цвета': 'Colours',
  'караоке.цвет.неактив': 'Inactive text',
  'караоке.цвет.неактив.мини': 'inactive',
  'караоке.цвет.актив': 'Active line',
  'караоке.цвет.актив.мини': 'active',
  'караоке.цвет.эффект': 'Effect colour',
  'караоке.цвет.эффект.мини': 'effect',
  'караоке.обводка': 'Outline',
  'караоке.обводка.цвет': 'Outline colour',
  'караоке.фон': 'Stage background',
  'караоке.фон.какбыло': 'As is',
  'караоке.фон.цветом': 'Colour',
  'караоке.приглушение': 'Dimming',
  'караоке.приглушение.подсказка': 'How visible the lines that aren’t being sung are',
  'караоке.размытие': 'Blur on inactive',
  'караоке.подложка': 'Scrim under the text',
  'караоке.подложка.подсказка': 'A dark scrim under the lines, over the picture — instead of darkening the whole frame',
  'караоке.подложка.высота': 'Scrim height',
  'караоке.подложка.высота.подсказка': 'How tall the scrim is: 100% covers both lines exactly, however far apart the “First line at” and “Second line at” sliders put them',
  'караоке.меняются': 'Lines swap places',
  'караоке.меняются.подсказка': 'Turn this on and lines will move up as you sing',
  'караоке.строкВидно': 'Lines visible',
  'караоке.местоПервой': 'First line at',
  'караоке.местоВторой': 'Second line at',
  'караоке.появление': 'Transition',
  'караоке.появление.плавно': 'Fade',
  'караоке.появление.сдвиг': 'Slide',
  'караоке.появление.нет': 'None',
  'караоке.выравнивание': 'Alignment',
  'караоке.выравнивание.верх': 'Top',
  'караоке.выравнивание.центр': 'Middle',
  'караоке.выравнивание.низ': 'Bottom',
  'караоке.отсчёт': 'Count-in before a line',
  'караоке.отсчёт.подсказка': 'Three dots fade out over the three seconds before you come in — so you know when to start after a break',
  'караоке.заметка.видео': 'The look carries over into the finished video',
  /* Тональность: орган управления на закладке «Звук».
     Key вместо pitch — это то слово, которым про песню и говорят. */
  'караоке.тональность': 'Key <small>higher or lower than recorded</small>',
  'караоке.тон.ниже.подсказка': 'A semitone down',
  'караоке.тон.выше.подсказка': 'A semitone up',
  'караоке.тон.применить': 'Apply',
  'караоке.тон.применить.подсказка': 'Work out the chosen key. Takes about half a minute for a three-minute song — the instrumental and the original at once',
  'караоке.тон.вНоль': 'Back to zero',
  'караоке.тон.вНоль.подсказка': 'Put the song back into the key it was recorded in. This is instant',
  'караоке.тон.подсказка': 'Tempo and length stay the same. The shift goes into the .wav and the video too.',
  'караоке.тон.подсказка.полно': 'Tempo and length stay exactly as they were, and so does your timing. Both the instrumental and the original on its stretches move. You hear it in the player, and it goes into the .wav instrumental and the video.',
  'караоке.тон.считаем': 'Changing the key…',
  'караоке.тон.ждать': 'Both the instrumental and the original are worked out. Stop it and the previous key stays as it was.',
  'караоке.тон.отменить': 'Cancel',
  'караоке.тон.отменить.подсказка': 'Stop the calculation and keep the previous key',
  'караоке.низкие': 'Low <small>bass, kick</small>',
  'караоке.средние': 'Mid <small>guitars, voice</small>',
  'караоке.высокие': 'High <small>cymbals, air</small>',
  'караоке.эквалайзер.сбросить': 'Reset',
  'караоке.эквалайзер.подсказка': 'Applies in the player and goes into the video',
  'караоке.заметка.вокал': 'Vocal level lives under the preview — that’s where you can hear it straight away',
  'караоке.развернуть': 'Expand the preview (F)',
  'караоке.вокал': 'Vocals',
  'караоке.микшер.подсказка': 'Original-audio stretches marked in the editor play in full regardless of this slider',

  /* ---------- Шаг 4: экспорт ---------- */
  'экспорт.назад': '← Editor',
  'экспорт.звук': 'Check the sound',
  'экспорт.lrc': 'Lyrics .lrc',
  'экспорт.lrcСлова': '.lrc with words',
  'экспорт.lrcСлова.подсказка': 'Extended LRC: a timestamp for every word inside a line',
  'экспорт.wav': 'Instrumental .wav',
  'экспорт.wav.подсказка': 'Instrumental with the original on the stretches marked in the editor',
  'экспорт.качество': 'Quality',
  /* Строка про права: одна на всю студию, под кнопками вывода */
  'экспорт.права': 'The rights to the song stay with whoever holds them. Make karaoke out of what you have the rights to, and publishing the finished video is on you.',
  'экспорт.видео': 'Save video',
  'экспорт.идёт': 'Recording the video…',
  'экспорт.подсказка': 'Recording runs in real time. You can minimise the window: the export carries on in the background. Don’t close the page before it finishes.',
  'экспорт.отменить': 'Cancel',
  'экспорт.назад.подсказка': 'Back to the editor to fix the timing',
  'экспорт.звук.подсказка': 'A short beep: check the sound is going where it should and can be heard',
  'экспорт.lrc.подсказка': 'Save the lyrics with line times (.lrc) — nearly every karaoke player reads it',
  'экспорт.видео.подсказка': 'Record a video of the stage with the sound — a finished .webm file',
  'экспорт.отменить.подсказка': 'Stop recording the video. What has been recorded is not kept',

  /* ---------- Шаг 3: редактор ---------- */
  'ред.справка.заголовок': 'How to fix the timing',
  'ред.справка.первый': 'The text is on the left — edit it in the list, double-click to jump to a line. The preview is in the middle, the inspector on the right: the selected word on top, the line it belongs to underneath. Times in the inspector read the same way as on the timeline — minutes and seconds. The timeline is at the bottom: drag a block’s edges to move a boundary, its middle to move the whole line; the bottom track works the same way for word edges, and clicking a word selects it — its numbers show up in the inspector. Two neighbouring words share one joint: the left one’s end and the right one’s start move together. Drag it with Cmd held and the edges come apart, leaving a pause between the words; either edge brings them back together. The first word of a line has a left edge of its own: push it later and a pause appears before it — a singer does not always come in at once. The last word’s right edge stretches to the end of the line by itself (that is the melisma), but once you set it by hand it stays where you put it. The “S” button by a track name leaves that track alone in your headphones, and the slider next to it makes that track louder or quieter. Line starts are tapped with the spacebar: the “tap again” button.',
  'ред.справка.оригинал': '<b>The top track is the original.</b> Drag across it and the real words from the recording play on that stretch instead of the instrumental — handy for an intro you’d rather not sing. Pull the edges to adjust; the cross, a double-click or <kbd>Delete</kbd> removes a stretch. Inside a stretch the original is heard in full, wherever the “Vocals” slider sits in karaoke — and it goes into the .wav instrumental and the recorded video just the same. In the editor itself you won’t hear the difference: the original plays everywhere here, or there would be nothing to time against. To hear the stretches, clear “hear the original” on the right or go to karaoke.',
  'ред.легенда.оригинал': 'original plays here',
  'ред.легенда.голос': 'voice',
  'ред.легенда.строка': 'line',
  'ред.легенда.глазок': '≈ rough timing',
  'ред.легенда.слова': 'words of the selected line',
  'ред.легенда.своё': 'own timing, if the line was pulled to the voice',
  /* Легенда цветов спрятана за значком «?»: читают её один раз, а строку
     под дорожкой она занимала всегда */
  'ред.легенда.цвета': 'colours',
  'ред.легенда.подсказка': 'What each colour on the timeline means: the original, the voice, lines, words',
  'ред.легенда.aria': 'What each colour on the timeline means',
  /* Поиск по строкам: в песне их сорок-шестьдесят, и нужную ищут долго */
  'ред.поиск.место': 'search the lines',
  'ред.поиск.подсказка': 'Show only the lines containing these letters. Case and “ё” do not matter, Esc clears it. Line numbers stay as they are',
  'ред.поиск.aria': 'Search the lines of the song',
  'ред.поиск.очистить': 'Clear the search and show every line (Esc)',
  'ред.поиск.пусто': 'Nothing found',
  /* Руководство в приложении открывается окном поверх студии: витрины
     там нет вовсе, и ссылке «Как пользоваться» некуда было бы вести */
  'руководство.закрыть': 'Close the guide and go back to the studio (Esc)',
  'ред.справка.магнит': '<b><svg class="icon" aria-hidden="true"><use href="#i-magnet"></use></svg> Snapping.</b> While you drag, edges stick to neighbouring lines, to neighbouring word edges, to the playhead, to the edges of original stretches, to vocal onsets and endings (when the envelope is there) and to the edges of the song. A coloured guide appears where it sticks — the colour says what it caught. The threshold is the same at any zoom. Holding <kbd>Alt</kbd> suspends the snap; the <kbd>S</kbd> key turns it off for good.',
  'ред.клавиши': '<kbd>space</kbd> play · <kbd>↑</kbd><kbd>↓</kbd> line · <kbd>←</kbd><kbd>→</kbd> start · <kbd>[</kbd><kbd>]</kbd> end · <kbd>Shift</kbd> finer, <kbd>Alt</kbd> coarser · <kbd>Enter</kbd> audition · <kbd>L</kbd> loop · <kbd>S</kbd> snap · <kbd>Delete</kbd> remove stretch · <kbd><span class="mod-key">Cmd</span>+Z</kbd> undo · <kbd><span class="mod-key">Cmd</span></kbd> + drag a word joint pulls its edges apart · wheel scrolls, with <kbd><span class="mod-key">Cmd</span></kbd> zooms',
  'ред.простук.клавиша': 'hit <kbd>space</kbd> at the start of a line — or click here',
  'ред.простук.отменить': 'undo last',
  'ред.простук.готово': 'Done',
  'ред.простук.поле.подсказка': 'Hit space (or click here) at the start of every line — the timing sets itself',
  'ред.простук.отменить.подсказка': 'Drop the last line you tapped and tap it again',
  'ред.простук.готово.подсказка': 'Finish tapping and go back to the editor',
  'ред.играть.подсказка': 'Play and pause (space)',
  'ред.отменить': 'Undo the last action (%s+Z)',
  'ред.отменить.aria': 'Undo the last action',
  'ред.повторить': 'Redo (%s+Shift+Z)',
  'ред.повторить.aria': 'Redo the undone action',
  'ред.покругу': 'loop',
  'ред.покругу.подсказка': 'Play the selected line round and round (key L)',
  'ред.магнит': 'snap',
  'ред.магнит.подсказка': 'Snapping: edges stick to neighbouring lines, to neighbouring word edges, to the playhead, to original stretches and to the real vocal onset. The S key turns it off for good, holding Alt suspends it for one drag',
  'ред.доли': 'beat grid',
  'ред.доли.подсказка': 'Beat grid: beat lines appear on the timeline and edges snap to them (a beat is the weakest snapping target of all). Off by default: the tempo is machine-detected and may be wrong. Key G',
  'ред.доли.темп': 'tempo, beats per minute',
  'ред.доли.темп.подсказка': 'Tempo in beats per minute. Detected from the music — type your own number if the estimate missed. Double-click restores the detected value',
  'ред.доли.фаза': 'first beat offset, seconds',
  'ред.доли.фаза.подсказка': 'Offset of the first beat in seconds: where the downbeat falls. Double-click restores the detected value',
  'ред.скраб': 'audible scrub',
  'ред.скраб.подсказка': 'Audible scrubbing and skimming: the song plays under the cursor — both while you simply move the mouse over the timeline (the playhead stays put) and while you drag it or an edge. You find the spot by ear. It sounds like whatever the track faders are set to. Off by default — click to turn it on',
  'ред.сдвиг.минус': '−0.1',
  'ред.сдвиг.плюс': '+0.1',
  'ред.отдалить': 'Zoom out (key −)',
  'ред.отдалить.aria': 'Zoom out',
  'ред.приблизить': 'Zoom in (key +)',
  'ред.приблизить.aria': 'Zoom in',
  'ред.вся': 'whole song',
  'ред.вся.подсказка': 'Show the whole song',
  'ред.окно.строки': 'Lines',
  'ред.окно.просмотр': 'Preview',
  'ред.разделитель': 'Border between the windows and the timeline',
  'ред.разделитель.подсказка': 'Drag up or down: the timeline gets taller or shorter, the windows above it the other way round. The ↑ and ↓ keys move the border from the keyboard, a double click puts it back. The position is remembered',
  'ред.разделительСписка': 'Border between the line list and the preview',
  'ред.разделительСписка.подсказка': 'Drag left or right: the line list gets narrower or wider, the preview next to it the other way round. The \u2190 and \u2192 keys move the border from the keyboard, a double click puts it back. The width is remembered',
  'ред.разделительВбок': 'Border between the preview and the inspector',
  'ред.разделительВбок.подсказка': 'Drag left or right: the inspector gets wider or narrower, the preview next to it the other way round. The ← and → keys move the border from the keyboard, a double click puts it back. The width is remembered',
  'ред.начало': 'start',
  'ред.начало.подсказка': 'Line start as minutes:seconds, the way the timeline reads it (plain seconds work too). Enter applies, Esc puts it back',
  'ред.конец': 'end',
  'ред.конец.подсказка': 'Line end as minutes:seconds, the way the timeline reads it (plain seconds work too). Enter applies, Esc puts it back',
  'ред.секунды': 's',
  'ред.прослушать': 'audition',
  'ред.прослушать.подсказка': 'Audition this line (Enter)',
  'ред.слова.подсказка': 'Tap out the words inside this line',
  'ред.сброс.слова': 'reset words',
  'ред.сброс.слова.подсказка': 'Bring back the automatic word split',
  'ред.распределить': 'spread out',
  'ред.распределить.подсказка': 'Spaces the line’s words out in time in proportion to their syllable count: a long word is sung longer than a short one. This stands in for tapping the words out by hand — good while the words have not been timed by hand',
  'ред.простучать': 'tap again',
  'ред.простучать.подсказка': 'Tap this line and the ones after it again (with the spacebar)',
  'ред.инсп.партия': 'part',
  'ред.партия.нет.подсказка': 'An ordinary line — nobody’s in particular',
  'ред.партия.1.подсказка': 'First voice. The line is coloured on stage and in the video so the singer sees it is theirs — in advance, while it is still waiting',
  'ред.партия.2.подсказка': 'Second voice. Same, in the other colour',
  'ред.партия.оба.подсказка': 'Both sing — a chorus. If a range of lines is selected, the part goes to all of them at once',
  'ред.удалить': 'delete',
  'ред.удалить.подсказка': 'Remove this line from the karaoke',
  'ред.оригиналКнопка': 'original',
  'ред.оригинал.строка.подсказка': 'Turn this line into an original stretch: the recording itself plays under it, with a level of its own',
  'ред.оригинал.слово.подсказка': 'Turn this word into an original stretch: the recording itself plays under it, with a level of its own',
  'ред.громкость.подсказка': 'How loud this stretch of the original is against the rest of the song. Double-click brings back 100 %. It goes into the .wav instrumental and into the video as well',
  'ред.отрезок.как': 'A stretch is a piece where the recording itself plays instead of the instrumental. To make one: the “original” button in the line or word panel, or drag along the “original” lane on the track. Click a stretch to select it.',
  'ред.отрезок.убрать.подсказка': 'Remove this stretch — the instrumental plays under it again',
  'ред.слышу': 'hear the original',
  'ред.слова.заголовок': 'Word timing',
  'ред.слова.подсказка2': 'Hit <kbd>space</kbd> the moment each word starts. Esc cancels.',
  'ред.слова.сохранить': 'Save',
  'ред.слова.отменить': 'Cancel',
  'ред.слова.сохранить.подсказка': 'Save the words you tapped out in this line',
  'ред.слова.отменить.подсказка': 'Leave word timing without changing anything',
  /* ---------- Панель выбранного слова ---------- */
  'ред.началоСлова.подсказка': 'Word start as minutes:seconds, the way the timeline reads it (plain seconds work too). The first word has a start of its own: push it later and a pause appears before it — a singer does not always come in at once',
  'ред.конецСлова.подсказка': 'Word end as minutes:seconds, the way the timeline reads it (plain seconds work too). The last word’s end stretches to the end of the line by itself — that is the melisma; set it by hand and the tail stays with the line, bring it back flush and it stretches again',
  'ред.слово.поКругу.подсказка': 'Play this word round and round, with a short run-up and tail (key L)',
  'проект.сохранить': 'Save the project',
  'проект.сохранить.подсказка': 'Save the project as a folder: the song, the instrumental, the background and all the timing (Cmd+S; Shift+Cmd+S to save a copy)',
  'проект.открыть': 'Open a project',
  'проект.открыть.подсказка': 'Open a project folder — with the audio, the instrumental and the timing (Cmd+O)',
  'черновик.сохранить': 'Save a draft',
  'черновик.сохранить.подсказка': 'Save a draft file: the lyrics, the timing, the original stretches and the look',
  'черновик.открыть': 'Open a draft',
  'черновик.открыть.подсказка': 'Open a draft file',
  'ред.назад': '← Lyrics',
  'ред.дальше': 'Karaoke →',
  'ред.назад.подсказка': 'Back to step 2: the song lyrics',
  'ред.дальше.подсказка': 'Go to step 4: the look, preview and export',

  /* ---------- Вопросы ---------- */
  'faq.заголовок': 'Frequently asked',
  'faq.1.вопрос': 'Why aren’t the vocals removed completely?',
  'faq.1.ответ': 'In the browser the studio uses the classic “centre channel subtraction” trick: the voice is usually recorded identically in the left and right channels, so it can be subtracted out. Reverb, backing vocals and processing stay — for karaoke at home that’s usually enough. Full removal is a job for neural networks, and there’s a <a href="#desktop">desktop version</a> for that.',
  'faq.2.вопрос': 'How do I get a really clean instrumental?',
  'faq.2.ответ1': '<b>The easiest way is the <a href="#desktop">desktop version</a>:</b> it has a “Remove the vocals with a neural network” button that does everything for you. It uses the local UVR-MDX-NET-Inst_HQ_3 model — the very one UVR5 runs, so the result is the same: we compared our instrumental against one from the real UVR5 and came within 6% by amplitude, and almost all of that difference is not vocal residue but a different way of cutting the song into chunks.',
  'faq.2.ответ2': 'If you’d rather not install anything, run the song through a neural network separately and load the finished file into the “Your own instrumental” field on step one. The free option is <b>Ultimate Vocal Remover (UVR5)</b>: it runs locally — pick an MDX-Net model (the same UVR-MDX-NET-Inst_HQ_3, for instance) and save the “Instrumental” track. Among paid services, LALAL.AI and Moises give comparable quality.',
  'faq.2.ответ3': 'The instrumental file has to be the same song at the same length as the original — otherwise the lyrics will drift.',
  'faq.3.вопрос': 'Are my files uploaded anywhere?',
  'faq.3.ответ': 'No. It all happens in your browser through the Web Audio API. The site has no server at all — you can even go offline after the page loads. The desktop version is the same: the neural networks run on your computer and no audio is sent anywhere. The only thing the app downloads is the models themselves, and only once.',
  'faq.4.вопрос': 'What is word-level highlighting, and why time the words?',
  'faq.4.ответ1': 'The fill doesn’t crawl through the line at a constant speed — it steps at word boundaries, the way modern karaoke players do. If a line’s words aren’t timed, its time is split between them in proportion to length: a long word is sung longer than a short one. That’s usually enough.',
  'faq.4.ответ2': 'When you want it exact, the editor has a <b>“♪ words”</b> button on the selected line: the passage plays with vocals and you tap the spacebar on each word. Timed lines are marked green; reset brings the automatic split back. The marks travel with the line when you shift it and are saved into the project.',
  'faq.5.вопрос': 'Where do I get the lyrics?',
  'faq.5.ответ1': 'On the website you paste the lyrics yourself — copy them from anywhere and drop them into the field on step two.',
  'faq.5.ответ2': 'The lyrics to any song take half a minute to find — timing them by hand takes far longer. That’s what the <a href="#desktop">desktop version</a> does: you paste your own lyrics, the Whisper model listens to the singing and lays your lines out on the marks it found. The words stay yours, only the timing comes from the network — and it gets timing wrong far less often than letters. Lines it barely made out are flagged with ≈: worth a check.',
  'faq.5.ответ3': 'It comes out noticeably better if you remove the vocals first: then the network hears a clean voice instead of a mix. The lyrics themselves have to be yours — the studio doesn’t write them for you: singing transcribes much worse than speech, and a draft like that would have to be rewritten from end to end anyway.',
  'faq.6.вопрос': 'What is an .lrc file?',
  'faq.6.ответ1': 'It’s the standard format for synced lyrics: every line is tagged with a time. Plenty of players and karaoke programs read these files.',
  'faq.6.ответ2': 'The “⬇ .lrc with words” button saves the extended variant — with a timestamp on every word inside a line. Players that don’t understand it will still read the lyrics line by line; the ones that do will highlight word by word.',
  'faq.7.вопрос': 'What kind of file is the video saved as?',
  'faq.7.ответ': 'The “Save video” button records a finished clip with background, text and instrumental — quality is chosen next to it: HD 1280×720, Full HD 1920×1080 or 2K 2560×1440. The whole stage look and the equaliser go into the recording. The file is WebM: browsers, editing suites and video sites all read it, so nothing needs converting. Recording runs in real time, so it takes as long as the song; you can minimise the window and the export carries on in the background.',
  'faq.8.вопрос': 'Will my project be saved?',
  'faq.8.ответ': 'Lyrics, line timings, word timing, the look, the equaliser and the background image are saved in the browser automatically. You’ll have to pick the audio file again next time — browsers don’t keep large files.',

  /* ---------- Подвал ---------- */
  'подвал.сделано': 'Made with love for music · runs without servers',
  'подвал.лицензии': 'Licences',
  'подвал.лицензии.подсказка': 'MIT for the studio itself and the list of third-party licences — on GitHub',
  'подвал.новости': 'What’s new in {версия}',
};

/* ============================================================
   СЛОВАРЬ 2. Строки, которые собираются в коде.
   ============================================================ */
I18N.СТРОКИ = {
  /* ---------- Переключатель языка ----------
     Устроен выпадающим списком, как переключатель темы рядом: кнопка
     со значком-глобусом, а по нажатию — пункты с названиями языков.
     Отсюда три вида надписи у каждого языка: короткая («Рус») осталась
     на случай, если она где-то понадобится числом, самоназвание стоит
     в пункте списка, а объяснение — в его подсказке.

     САМОНАЗВАНИЯ НЕ ПЕРЕВОДЯТСЯ, и это нарочно: обе стороны у них
     одинаковые. Языковой переключатель существует ровно для того, кто
     НЕ читает на нынешнем языке. Переведи их — и англичанин, попавший
     на русскую студию, увидит «Русский» и «Английский» и не поймёт,
     куда нажимать; а по-русски «Russian» и «English» были бы такой же
     загадкой для того, кто английского не знает. Поэтому каждый язык
     подписан так, как он называет себя сам, — «Русский» и «English», —
     и подпись одна на оба словаря. Так делают все, кто делает
     переключатель языка всерьёз.

     Подсказка при наведении переводится по-прежнему: она объясняет
     ДЕЙСТВИЕ («Русский язык интерфейса» / «Russian interface»),
     а не называет язык. */
  'язык.ru': { ru: 'Рус', en: 'Rus' },
  'язык.en': { ru: 'Eng', en: 'Eng' },
  'язык.ru.имя': { ru: 'Русский', en: 'Русский' },
  'язык.en.имя': { ru: 'English', en: 'English' },
  'язык.ru.полно': { ru: 'Русский язык интерфейса', en: 'Russian interface' },
  'язык.en.полно': { ru: 'Английский язык интерфейса', en: 'English interface' },
  'язык.выбрать': {
    ru: 'Язык интерфейса: {имя}. Нажми, чтобы выбрать другой',
    en: 'Interface language: {имя}. Click to pick another',
  },

  /* ---------- Переключатель темы ----------
     Три темы, все — монтажная плотность (см. style.css): «нейтральная»
     без цветового акцента; «фирменная», где прежний тёмный грунт
     и зелёный, но зелёный означает только выделенное и включённое,
     а не украшает всё подряд; «стальная» — холодный серый грунт
     и синий акцент, манера больших монтажных программ. Фирменная —
     по умолчанию. Короткое имя стоит в пункте списка, полное — в его
     подсказке; у самой кнопки подсказка говорит, что тема сейчас
     выбрана и что список открывается нажатием. */
  'тема.neutral': { ru: 'Нейтральная', en: 'Neutral' },
  'тема.signature': { ru: 'Фирменная', en: 'Signature' },
  'тема.steel': { ru: 'Стальная', en: 'Steel' },
  'тема.neutral.полно': {
    ru: 'Нейтральная тема: серый грунт без оттенка, жёлтая рамка выделения',
    en: 'Neutral theme: plain grey ground, yellow selection ring',
  },
  'тема.signature.полно': {
    ru: 'Фирменная тема: тёмный грунт и зелёный акцент студии',
    en: 'Signature theme: dark ground and the studio’s green accent',
  },
  'тема.steel.полно': {
    ru: 'Стальная тема: холодный серый грунт, синий акцент — как в Logic Pro',
    en: 'Steel theme: cold grey ground and a blue accent, like Logic Pro',
  },
  'тема.выбрать': {
    ru: 'Тема студии: {имя}. Нажми, чтобы выбрать другую',
    en: 'Studio theme: {имя}. Click to pick another',
  },

  /* ---------- Сетка долей ----------
     Уверенность и подсказки ставит код (обновитьСетку в app.js):
     число внутри них считается на месте, в разметке его быть не может. */
  'ред.доли.нетТемпа': {
    ru: 'Темп ещё не определён: открой песню и зайди в редактор',
    en: 'Tempo not detected yet: open a song and enter the editor',
  },
  'ред.доли.считаем': {
    ru: 'Считаем темп… Разбор идёт в отдельном потоке, студия при этом '
      + 'не замирает: число появится через полсекунды',
    en: 'Detecting the tempo… It runs in a background thread, so the studio '
      + 'stays responsive: the number shows up in about half a second',
  },
  'ред.доли.руками': { ru: 'своё', en: 'own' },
  'ред.доли.руками.подсказка': {
    ru: 'Темп поставлен руками — автомат его больше не перебивает. '
      + 'Двойной щелчок по полю вернёт найденное автоматом',
    en: 'Tempo set by hand — the estimator no longer overrides it. '
      + 'Double-click the field to restore the detected value',
  },
  'ред.доли.уверенность.подсказка': {
    ru: 'Темп {bpm} определён с уверенностью {n}%. Ошибся — набери своё число',
    en: 'Tempo {bpm} detected with {n}% confidence. Wrong? Type your own number',
  },
  'ред.доли.двойственный': {
    ru: 'Темп {bpm}, уверенность {n}%. Вдвое медленнее или вдвое быстрее '
      + 'подходит почти так же — если сетка встала не туда, подели темп '
      + 'надвое или умножь на два',
    en: 'Tempo {bpm}, confidence {n}%. Half or double the tempo fits almost '
      + 'as well — if the grid looks wrong, halve or double the number',
  },

  /* ---------- Породы точек магнита ----------
     Подпись у направляющей рисуется прямо на канвасе, поэтому её
     нельзя взять из разметки: переводим здесь. */
  'магнит.указатель': { ru: 'указатель', en: 'playhead' },
  'магнит.строка': { ru: 'строка', en: 'line' },
  'магнит.слово': { ru: 'слово', en: 'word' },
  'магнит.оригинал': { ru: 'оригинал', en: 'original' },
  'магнит.голос': { ru: 'голос', en: 'voice' },
  'магнит.край': { ru: 'край', en: 'edge' },
  'магнит.доля': { ru: 'доля', en: 'beat' },

  /* ---------- Шрифты сцены ---------- */
  'шрифт.system': { ru: 'Системный', en: 'System' },
  'шрифт.impact': { ru: 'Плакатный (Impact)', en: 'Poster (Impact)' },
  'шрифт.arial': { ru: 'Гротеск (Arial)', en: 'Sans (Arial)' },
  'шрифт.verdana': { ru: 'Широкий (Verdana)', en: 'Wide (Verdana)' },
  'шрифт.trebuchet': { ru: 'Мягкий (Trebuchet)', en: 'Soft (Trebuchet)' },
  'шрифт.georgia': { ru: 'Книжный (Georgia)', en: 'Serif (Georgia)' },
  'шрифт.courier': { ru: 'Печатная машинка', en: 'Typewriter' },

  /* ---------- Звук ---------- */
  'звук.заблокирован': {
    ru: 'Браузер блокирует звук на этом сайте.\n\n'
      + 'Проверь:\n'
      + '• не заглушена ли вкладка (правый клик по вкладке → «Включить звук»);\n'
      + '• в Brave — нажми на значок льва и отключи Shields для этого сайта '
      + '(строгая защита от фингерпринтинга глушит Web Audio);\n'
      + '• в Safari — Настройки → Веб-сайты → Автовоспроизведение: разреши для этого сайта.',
    en: 'Your browser is blocking audio on this site.\n\n'
      + 'Check:\n'
      + '• whether the tab is muted (right-click the tab → “Unmute site”);\n'
      + '• in Brave — click the lion icon and turn Shields off for this site '
      + '(strict fingerprinting protection kills Web Audio);\n'
      + '• in Safari — Settings → Websites → Auto-Play: allow it for this site.',
  },

  /* ---------- Шаг 1: загрузка песни ---------- */
  'песня.другая': {
    ru: 'Сейчас в студии песня «{прежняя}», размечено строк: {n}.\n'
      + 'Студия помнит одну песню за раз — если открыть другую, вернуть '
      + 'разметку прежней будет нельзя.\n\n'
      + 'Открыть «{новая}»?',
    en: 'The studio currently holds “{прежняя}”, with {n} lines timed.\n'
      + 'It remembers one song at a time — open another and the timing for '
      + 'this one is gone for good.\n\n'
      + 'Open “{новая}”?',
  },
  /* ---------- Что сейчас в памяти студии ----------
     Студия помнит одну работу за раз, и раньше об этом узнавали только
     из вопроса «открыть другую песню?» — когда рука уже занесена над
     чужой разметкой. Теперь то же самое написано заранее: чипом в ряду
     шагов и строкой над зоной загрузки. */
  'память.чип.подсказка': { ru: 'Что сейчас в памяти студии', en: 'What the studio is holding right now' },
  'память.строк': {
    ru: '«{имя}» · размечено строк: {n} из {всего}',
    en: '“{имя}” · {n} of {всего} lines timed',
  },
  'память.безРазметки': { ru: '«{имя}» · разметки пока нет', en: '“{имя}” · no timing yet' },
  'память.ждётПесню': {
    ru: 'В памяти проект по песне «{имя}»: строк в тексте {всего}, размечено {n}. '
      + 'Загрузи тот же файл — и продолжишь с того же места. Другой файл заменит этот проект.',
    en: 'The studio is holding the project for “{имя}”: {всего} lines of text, {n} of them timed. '
      + 'Load the same file and you carry on where you left off. A different file replaces this project.',
  },
  'память.безИмени': { ru: 'черновик', en: 'draft' },

  /* ---------- Черновик файлом ----------
     Проект живёт в хранилище браузера, а оно теряется: чистка кэша,
     другой браузер, переустановка приложения. Черновик — тот же проект,
     но файлом, который можно положить куда угодно. Звук в него не
     кладём: песня и так есть у человека, а файл вышел бы в десятки
     мегабайт. Поэтому в черновике записано имя песни, и при открытии
     оно сверяется с тем, что загружено. */
  /* ---------- Проект папкой ----------
     Черновик — разметка без звука; проект — папка, в которой лежит вся
     работа: песня, минусовка нейросети, фон и разметка. Открыл папку —
     студия встала туда, где её оставили, без единого пересчёта. */
  'проект.нечего': {
    ru: 'Пока нечего сохранять: нет ни песни, ни текста, ни разметки.',
    en: 'Nothing to save yet: no song, no lyrics and no timing.',
  },
  'проект.неЗаписался': {
    ru: 'Не удалось записать проект. {причина}',
    en: 'Couldn’t write the project. {причина}',
  },
  'проект.неПрочитался': {
    ru: 'Не удалось открыть эту папку как проект Karaoke Punch.',
    en: 'Couldn’t open this folder as a Karaoke Punch project.',
  },
  'проект.нетПесни': {
    ru: 'В папке проекта не нашлось файла песни. Открой её как обычно, '
      + 'а разметку подтяни черновиком.',
    en: 'The project folder has no song file. Load the song as usual '
      + 'and bring the timing in with a draft.',
  },
  'проект.открыт': {
    ru: 'Проект открыт: строк {всего}, из них размечено {n}.',
    en: 'Project opened: {всего} lines, {n} of them timed.',
  },
  'проект.чип': {
    ru: 'Проект: {путь}',
    en: 'Project: {путь}',
  },
  /* Подписи файла разметки В ПРИЛОЖЕНИИ. Ставит их код (см.
     обновитьПодписиЧерновика), поэтому обе стороны лежат здесь,
     а не в словаре разметки. На сайте у тех же кнопок свои подписи —
     там .kpunch и есть единственный способ сохраниться, и зовётся
     он черновиком. */
  /* Финал песни. Язык здесь по ПЕСНЕ, а не по студии (см. финал
     в app.js): благодарят того, кто только что пел. */
  /* Тональность песни. Имя даём и словами, и буквами: словами читает
     тот, кто поёт, буквами — тот, кто играет. */
  'тон.мажор': { ru: 'мажор', en: 'major' },
  'тон.минор': { ru: 'минор', en: 'minor' },
  'тон.имя': { ru: '{нота} {лад} ({буква})', en: '{нота} {лад} ({буква})' },
  'тон.песняВ': {
    ru: 'Песня записана в тональности {тональность}.',
    en: 'The song is recorded in {тональность}.',
  },
  'финал.подпись': {
    ru: 'Точность попадания в ноты и в слова — по нашим самым щедрым подсчётам',
    en: 'Accuracy on the notes and the words — by our most generous reckoning',
  },
  'финал.ещё': { ru: 'Спеть ещё раз', en: 'Sing it again' },
  'финал.закрыть': { ru: 'Закрыть', en: 'Close' },
  /* Подписи кнопок идут за языком ПЕСНИ — их переписывает финал.
     А подсказки остаются на языке студии: они для того, кто ведёт
     вечер, а не для того, кто только что пел. */
  'финал.ещё.подсказка': {
    ru: 'Начать эту же песню сначала',
    en: 'Start the same song from the beginning',
  },
  'финал.закрыть.подсказка': {
    ru: 'Убрать похвалу и вернуться к сцене',
    en: 'Dismiss the praise and go back to the stage',
  },
  'черновик.разметка': {
    ru: 'Сохранить разметку файлом',
    en: 'Save the timing to a file',
  },
  'черновик.разметка.подсказка': {
    ru: 'Файл .kpunch — только текст и времена, без звука. Работа целиком '
      + 'сохраняется проектом (папка слева); этот файл нужен, чтобы унести '
      + 'разметку на другой компьютер или отдать её тому, у кого эта песня уже есть',
    en: 'A .kpunch file — the lyrics and the timing only, no audio. The whole job '
      + 'is saved by the project folder next to it; this file is for carrying the '
      + 'timing to another computer, or handing it to someone who already has this song',
  },
  'черновик.разметкаОткрыть': {
    ru: 'Открыть разметку из файла',
    en: 'Open timing from a file',
  },
  'черновик.разметкаОткрыть.подсказка': {
    ru: 'Взять времена из файла .kpunch и положить их на открытую песню',
    en: 'Take the timing out of a .kpunch file and lay it on the song that is open',
  },
  'черновик.нечего': {
    ru: 'Пока нечего сохранять: нет ни текста, ни разметки.',
    en: 'Nothing to save yet: no lyrics and no timing.',
  },
  'черновик.неПрочитался': {
    ru: 'Не удалось открыть этот файл как черновик Karaoke Punch.',
    en: 'Couldn’t open this file as a Karaoke Punch draft.',
  },
  'черновик.новее': {
    ru: 'Черновик сделан в студии версии {v}, а эта — {своя}. '
      + 'Часть работы может не открыться. Всё равно открыть?',
    en: 'This draft was made in studio version {v}; this one is {своя}. '
      + 'Some of the work may not open. Open it anyway?',
  },
  'черновик.поверх': {
    ru: 'Сейчас в студии «{прежняя}», размечено строк: {n}.\n'
      + 'Открыть черновик «{новая}»? Нынешняя разметка будет заменена.',
    en: 'The studio currently holds “{прежняя}”, with {n} lines timed.\n'
      + 'Open the draft “{новая}”? The current timing will be replaced.',
  },
  'черновик.другаяПесня': {
    ru: 'Черновик сделан для песни «{имя}», а открыта «{текущая}». '
      + 'Разметка может не совпасть со звуком. Всё равно открыть?',
    en: 'This draft was made for “{имя}”, but “{текущая}” is open. '
      + 'The timing may not match the audio. Open it anyway?',
  },
  'черновик.открыт': {
    ru: 'Разметка открыта: строк {всего}, из них размечено {n}.',
    en: 'Timing opened: {всего} lines, {n} of them timed.',
  },
  'песня.читаем': { ru: 'Читаем файл…', en: 'Reading the file…' },
  'песня.декодируем': { ru: 'Декодируем аудио…', en: 'Decoding the audio…' },
  'песня.приглушаем': { ru: 'Приглушаем вокал…', en: 'Ducking the vocals…' },
  'песня.моно': { ru: 'моно', en: 'mono' },
  'песня.стерео': { ru: 'стерео', en: 'stereo' },
  'песня.кгц': { ru: '{v} кГц', en: '{v} kHz' },
  'песня.неПрочиталась': {
    ru: 'Не удалось прочитать этот файл как аудио. Попробуй другой формат (MP3, WAV, OGG).',
    en: 'Couldn’t read this file as audio. Try another format (MP3, WAV, OGG).',
  },

  /* ---------- Своя минусовка ---------- */
  'минусовка.заменить': { ru: 'Заменить', en: 'Replace' },
  'минусовка.выбрать': { ru: 'Выбрать', en: 'Choose' },
  'минусовка.сначалаПесня': { ru: 'Сначала загрузи саму песню.', en: 'Load the song itself first.' },
  'минусовка.длина': {
    ru: 'Длительность минусовки ({минус}) отличается от песни ({песня}) на {разница} с. '
      + 'Текст может разъехаться. Всё равно использовать?',
    en: 'The instrumental ({минус}) differs in length from the song ({песня}) by {разница} s. '
      + 'The lyrics may drift. Use it anyway?',
  },
  'минусовка.неПрочиталась': {
    ru: 'Не удалось прочитать этот файл как аудио. Попробуй MP3, WAV или OGG.',
    en: 'Couldn’t read this file as audio. Try MP3, WAV or OGG.',
  },

  /* ---------- Картинка-фон ---------- */
  'фон.неОткрылась': {
    ru: 'Не удалось открыть эту картинку. Попробуй JPG или PNG.',
    en: 'Couldn’t open this image. Try JPG or PNG.',
  },

  /* ---------- Шаг 2: текст ---------- */
  'текст.пусто': {
    ru: 'Сначала вставь текст песни — хотя бы пару строк.',
    en: 'Paste the lyrics first — a couple of lines at least.',
  },
  'текст.потеряется': {
    ru: {
      one: 'Разметка {n} строки потеряется — в новом тексте такой строки нет:\n\n',
      few: 'Разметка {n} строки потеряется — в новом тексте таких строк нет:\n\n',
      many: 'Разметка {n} строк потеряется — в новом тексте таких строк нет:\n\n',
      other: 'Разметка {n} строк потеряется — в новом тексте таких строк нет:\n\n',
    },
    en: {
      one: 'The timing of {n} line will be lost — the new text has no such line:\n\n',
      other: 'The timing of {n} lines will be lost — the new text has no such lines:\n\n',
    },
  },
  'текст.ещё': { ru: '\n…и ещё {n}', en: '\n…and {n} more' },
  'текст.применить': {
    ru: '\n\nПрименить новый текст? Отменить правку можно будет в редакторе кнопкой «↶ отменить».',
    en: '\n\nApply the new text? You can undo the edit in the editor with the “↶ undo” button.',
  },

  /* ---------- Сцена ---------- */
  'сцена.пусто': { ru: 'Нет размеченных строк', en: 'No timed lines yet' },
  'сцена.свернуть': { ru: 'Свернуть просмотр (Esc)', en: 'Collapse the preview (Esc)' },
  'сцена.развернуть': { ru: 'Развернуть просмотр (F)', en: 'Expand the preview (F)' },
  'сцена.дБ': { ru: '{знак}{v} дБ', en: '{знак}{v} dB' },

  /* ---------- Проверка звука ---------- */
  'проверка.сначалаПесня': { ru: 'Сначала загрузи песню.', en: 'Load a song first.' },
  'проверка.слушаем': { ru: 'Слушаем…', en: 'Listening…' },
  'проверка.источник.своя': { ru: 'своя минусовка ({имя})', en: 'your own instrumental ({имя})' },
  'проверка.источник.встроенное': { ru: 'встроенное приглушение вокала', en: 'built-in vocal ducking' },
  'проверка.источник.нет': { ru: 'минусовки нет, играет оригинал', en: 'no instrumental, playing the original' },
  'проверка.позиция': { ru: 'Позиция: {at} из {всего}', en: 'Position: {at} of {всего}' },
  'проверка.источник': { ru: 'Источник: {src}', en: 'Source: {src}' },
  'проверка.громкость': { ru: 'Громкость вокала: {v}%', en: 'Vocal level: {v}%' },
  'проверка.сигналПесня': { ru: 'Сигнал в песне: {v}', en: 'Signal in the song: {v}' },
  'проверка.сигналМинус': { ru: 'Сигнал в минусовке: {v}', en: 'Signal in the instrumental: {v}' },
  'проверка.сигналВыход': { ru: 'Сигнал на выходе: {v}', en: 'Signal at the output: {v}' },
  'проверка.состояние': { ru: 'Состояние аудио: {state}, частота {rate} Гц', en: 'Audio state: {state}, sample rate {rate} Hz' },
  'проверка.тишинаВМинусе': {
    ru: '❗ В минусовке на этом месте тишина. Возможно, файл не тот '
      + '(например, файл с одним вокалом) или он короче песни. '
      + 'Попробуй убрать свою минусовку или подвинуть позицию.',
    en: '❗ The instrumental is silent at this point. The file may be the wrong one '
      + '(a vocals-only file, say) or shorter than the song. '
      + 'Try removing your instrumental or moving the position.',
  },
  'проверка.минусКороче': {
    ru: '❗ Минусовка короче песни — ближе к концу будет тишина.',
    en: '❗ The instrumental is shorter than the song — it will go silent towards the end.',
  },
  'проверка.браузерГлушит': {
    ru: '❗ Данные звука есть, но на выходе тишина — звук глушит браузер.\n'
      + 'В Brave: значок льва → отключи Shields для сайта.\n'
      + 'В Safari: правый клик по вкладке → «Включить звук», и Настройки → '
      + 'Веб-сайты → Автовоспроизведение → «Разрешить все».',
    en: '❗ The audio data is there but the output is silent — the browser is muting it.\n'
      + 'In Brave: lion icon → turn Shields off for this site.\n'
      + 'In Safari: right-click the tab → “Unmute site”, and Settings → '
      + 'Websites → Auto-Play → “Allow All”.',
  },
  'проверка.всёХорошо': {
    ru: '✅ Звук идёт нормально. Если не слышно — проверь громкость системы, '
      + 'выбранное устройство вывода и не заглушена ли вкладка.',
    en: '✅ Audio is flowing fine. If you still hear nothing, check the system volume, '
      + 'the selected output device and whether the tab is muted.',
  },

  /* ---------- Экспорт ---------- */
  'экспорт.нетСтрок': { ru: 'Сначала размети текст.', en: 'Time the lyrics first.' },
  'экспорт.имяСлова': { ru: '{имя} (по словам).lrc', en: '{имя} (word by word).lrc' },
  'экспорт.имяМинус': { ru: '{имя} (минус).wav', en: '{имя} (instrumental).wav' },
  'экспорт.имяВидео': { ru: '{имя} (караоке).{ext}', en: '{имя} (karaoke).{ext}' },
  'экспорт.моно': {
    ru: 'Для монофайла минусовку сделать нельзя.',
    en: 'An instrumental can’t be made from a mono file.',
  },
  'экспорт.готовимШрифт': { ru: 'Готовим шрифт…', en: 'Preparing the font…' },
  'экспорт.записываем': { ru: 'Записываем видео…', en: 'Recording the video…' },
  'экспорт.записываемХод': { ru: 'Записываем видео… {at} / {всего}', en: 'Recording the video… {at} / {всего}' },

  /* ---------- Редактор ---------- */
  'ред.вокал.есть': {
    ru: 'В редакторе по умолчанию звучит оригинал: размечать на слух без голоса невозможно',
    en: 'The editor plays the original by default: timing by ear without the voice is impossible',
  },
  'ред.вокал.моно': {
    ru: 'Файл моно — минусовки нет, оригинал звучит всегда',
    en: 'Mono file — there is no instrumental, so the original always plays',
  },
  'ред.голос.есть': { ru: '— видно, где на самом деле поют', en: '— shows where the singing actually is' },
  'ред.голос.нет': {
    ru: '— появится, когда уберёшь вокал нейросетью',
    en: '— appears once you remove the vocals with the neural network',
  },
  'ред.глазок.подсказка': {
    ru: 'Время подобрано приблизительно — послушай и поправь',
    en: 'This timing is a rough guess — listen and fix it',
  },
  'ред.слова.помечены': {
    ru: 'Слова этой строки размечены вручную',
    en: 'The words of this line are timed by hand',
  },
  /* Обратная пометка: слова размечены почти везде, а здесь — нет.
     Когда разметка стала правилом, редким становится её отсутствие,
     и значок обязан говорить именно об этом (см. renderEditList). */
  'ред.слова.неРазмечены': {
    ru: 'Слова этой строки НЕ размечены вручную — в остальной песне размечены',
    en: 'The words of this line are NOT timed by hand — in the rest of the song they are',
  },
  'ред.последняяСтрока': {
    ru: 'Это последняя строка — удалять нечего. Текст правится на шаге «Текст».',
    en: 'This is the last line — there is nothing to delete. Edit the text on the “Lyrics” step.',
  },
  'ред.удалитьСтроку': {
    ru: 'Убрать строку «{текст}» из караоке?\n\nОтменяется через {мод}+Z.',
    en: 'Remove the line “{текст}” from the karaoke?\n\nUndo with {мод}+Z.',
  },
  'ред.сначалаПростучи': {
    ru: 'Сначала простучи начало этой строки: кнопка «✎ простучать заново» в панели выбранной строки.',
    en: 'Tap out the start of this line first: the “✎ tap again” button in the selected-line panel.',
  },
  'ред.словСчёт': { ru: '{n} из {всего}', en: '{n} of {всего}' },
  'ред.размечено': { ru: 'размечено {n} из {всего}', en: '{n} of {всего} timed' },
  'ред.всёРазмечено': { ru: 'Все строки размечены', en: 'Every line is timed' },
  'ред.порядок': {
    ru: 'Строка {k} размечена раньше, чем та, которую ты только что простучал.\n\n'
      + 'Стереть метки с {k}-й строки и дальше, чтобы простучать их заново?\n'
      + 'Всё вместе с этим заходом отменяется через {мод}+Z.',
    en: 'Line {k} is timed earlier than the one you have just tapped.\n\n'
      + 'Clear the marks from line {k} onwards so you can tap them again?\n'
      + 'That, together with this run, undoes with {мод}+Z.',
  },
  'ред.строкаНеВыбрана': { ru: 'Строка не выбрана', en: 'No line selected' },
  'ред.строкаНомер': { ru: 'Строка №{n}', en: 'Line {n}' },
  'ред.строкаГлазок': { ru: ' · время на глазок', en: ' · rough timing' },
  'ред.словаКнопка': { ru: 'слова', en: 'words' },
  'ред.словаКнопкаГотово': { ru: 'слова', en: 'words' },
  'ред.словоНеВыбрано': { ru: 'Слово не выбрано', en: 'No word selected' },
  /* Инспектор выбранного: подписи рядов. Короткие нарочно — ряд читается
     слева направо, а места в узком столбце мало. */
  'ред.окно.параметры': { ru: 'Параметры', en: 'Parameters' },
  'ред.окно.строка': { ru: 'Строка', en: 'Line' },
  'ред.словоЗаголовок': { ru: 'Слово', en: 'Word' },
  'ред.инсп.слово': { ru: 'слово', en: 'word' },
  'ред.инсп.строка': { ru: 'строка', en: 'line' },
  'ред.инсп.длина': { ru: 'длина', en: 'length' },
  'ред.словоНет': { ru: 'не выбрано', en: 'none' },
  'ред.строкаНет': { ru: 'не выбрана', en: 'none' },
  /* Отрезок оригинала: кусок, где вместо минусовки звучит сама запись.
     У каждого своя громкость — она уходит и в .wav, и в видео. */
  'ред.окно.оригинал': { ru: 'Оригинал', en: 'Original' },
  'ред.инсп.отрезок': { ru: 'отрезок', en: 'stretch' },
  'ред.инсп.громкость': { ru: 'громкость', en: 'level' },
  'ред.отрезокНет': { ru: 'не выбран', en: 'none' },
  'ред.отрезокОт': { ru: '{от} → {до}', en: '{от} → {до}' },
  'дорожка.оригинал.тише': { ru: 'оригинал · {v}%', en: 'original · {v}%' },
  'ред.номер': { ru: '№{n}', en: '#{n}' },
  'ред.сдвинуть.подсказка': {
    ru: 'Сдвинуть всю разметку на {v} с',
    en: 'Shift the whole timing by {v} s',
  },
  /* Пока на дорожке выделен диапазон, те же кнопки двигают только его */
  'ред.сдвинуть.диапазон': {
    ru: 'Сдвинуть выделенные строки на {v} с',
    en: 'Shift the selected lines by {v} s',
  },
  'ред.словоНомер': { ru: 'Слово №{n} из {всего}', en: 'Word {n} of {всего}' },

  /* ---------- Подписи на дорожке ---------- */
  'дорожка.оригинал.пусто': {
    ru: 'оригинал: протяни мышью — на этом отрезке зазвучат настоящие слова',
    en: 'original: drag across — the real words will play on that stretch',
  },
  'дорожка.оригинал': { ru: 'оригинал', en: 'original' },
  'дорожка.голос': { ru: 'голос', en: 'voice' },
  'дорожка.словаПусто': {
    ru: 'выбери строку — здесь появятся её слова',
    en: 'select a line — its words will appear here',
  },

  /* ---------- Колонка заголовков полос, слева от канваса ----------
     Место под будущую кнопку «слушать только это» уже заложено
     в вёрстке (см. .tl-head-solo в style.css) — сама кнопка появится
     отдельным заходом, сейчас только подпись и отступ под неё. */
  /* Кнопка «слушать только эту полосу» в колонке заголовков полос.
     Буква S на кнопке одна и та же на обоих языках — как в монтажных
     программах (solo, соло). */
  'дорожка.соло': { ru: 'Слушать только «{имя}»', en: 'Listen to “{имя}” only' },
  /* Ползунок уровня полосы в наушниках. У голоса он не «громкость», а
     прибавка: отдельной записи голоса нет, он берётся вычитанием
     минусовки из песни. Двойной щелчок возвращает умолчание. */
  'дорожка.уровень': {
    ru: 'Уровень «{имя}» в наушниках: {v}%. Двойной щелчок — вернуть как было',
    en: '“{имя}” level in your headphones: {v}%. Double-click puts it back',
  },
  'дорожка.уровень.оригинал': {
    ru: 'Уровень оригинала в наушниках: {v}%. На нуле остаётся чистая минусовка, '
      + 'на сотне голос звучит как в записи. Двойной щелчок — вернуть как было',
    en: 'Original level in your headphones: {v}%. At zero only the instrumental is left, '
      + 'at 100 the voice is as recorded. Double-click puts it back',
  },
  'дорожка.соло.выкл': { ru: 'Вернуть обычную смесь', en: 'Back to the normal mix' },
  'дорожка.заголовок.время': { ru: 'время', en: 'time' },
  'дорожка.заголовок.минус': { ru: 'минус', en: 'instrumental' },
  'дорожка.заголовок.строки': { ru: 'строки', en: 'lines' },
  'дорожка.заголовок.слова': { ru: 'слова', en: 'words' },

  /* ---------- Обновления ---------- */
  'обновление.вышла': { ru: 'Вышла новая версия студии — {v}', en: 'A new version of the studio is out — {v}' },
  // То же без номера: стоит в разметке до того, как обновление найдено
  'обновление.вышлаБезНомера': { ru: 'Вышла новая версия студии', en: 'A new version of the studio is out' },
  'обновление.обновить': { ru: 'Обновить', en: 'Update' },
  'обновление.версия': { ru: 'Вышла версия {v} — у тебя {текущая}', en: 'Version {v} is out — you have {текущая}' },
  'обновление.версияПросто': { ru: 'Вышла версия {v}', en: 'Version {v} is out' },
  'обновление.скачать': { ru: 'Скачать', en: 'Download' },
  'обновление.скачиваем': { ru: 'Скачиваем обновление…', en: 'Downloading the update…' },
  'обновление.скачиваемПроцент': { ru: 'Скачиваем обновление… {p}%', en: 'Downloading the update… {p}%' },
  'обновление.готово': { ru: 'Версия {v} готова к установке', en: 'Version {v} is ready to install' },
  'обновление.перезапустить': { ru: 'Перезапустить', en: 'Restart' },
  'обновление.неСкачалось': { ru: 'Не удалось скачать обновление', en: 'Couldn’t download the update' },
  'обновление.неАвто': { ru: 'Не удалось обновиться автоматически', en: 'Couldn’t update automatically' },
  'обновление.вручную': { ru: 'Скачать вручную', en: 'Download by hand' },

  /* ============================================================
     Настольная часть
     ============================================================ */

  /* ---------- Оценка времени ---------- */
  'время.несколькоМинут': { ru: 'несколько минут', en: 'a few minutes' },
  'время.меньшеМинуты': { ru: 'меньше минуты', en: 'under a minute' },
  'время.вилка': {
    ru: {
      one: '{от}–{n} минуты',
      few: '{от}–{n} минуты',
      many: '{от}–{n} минут',
      other: '{от}–{n} минут',
    },
    en: {
      one: '{от}–{n} minute',
      other: '{от}–{n} minutes',
    },
  },
  'время.займёт': { ru: 'Займёт примерно ', en: 'Takes roughly ' },
  'время.прикидка': {
    ru: 'По прикидке это {время}. Считает на твоём компьютере, ничего не отправляется в интернет.',
    en: 'Rough estimate: {время}. It runs on your computer; nothing is sent to the internet.',
  },
  'время.локально': {
    ru: 'Считает на твоём компьютере, ничего не отправляется в интернет.',
    en: 'It runs on your computer; nothing is sent to the internet.',
  },
  'время.когдаЗагрузишь': {
    ru: 'Время посчитаем, когда загрузишь песню. ',
    en: 'We’ll work out the time once you load a song. ',
  },
  'время.осталосьСек': { ru: 'осталось около {n} с', en: 'about {n} s left' },
  'время.осталосьМин': { ru: 'осталось около {n} мин', en: 'about {n} min left' },

  /* ---------- Разделение вокала ---------- */
  'ии.проходовМного': {
    ru: 'Выбрано {n} прохода — ждать во столько же раз дольше, а результат тот же.',
    en: '{n} passes selected — the wait grows by the same factor and the result is the same.',
  },
  'ии.проходОдин': {
    ru: 'Один проход. Больше проходов качества не добавляют, мы это замерили.',
    en: 'One pass. More passes add no quality — we measured it.',
  },
  'ии.стараяМодель': {
    ru: 'Вокал теперь убирает другая модель — та же, что в UVR5: '
      + 'она и чище, и втрое легче.\n\n'
      + 'Прежняя модель Demucs осталась на компьютере и занимает {мб} МБ. '
      + 'Она больше не нужна. Удалить её?',
    en: 'Vocals are now removed by a different model — the same one UVR5 uses: '
      + 'cleaner, and three times lighter.\n\n'
      + 'The old Demucs model is still on your computer, taking up {мб} MB. '
      + 'It is no longer needed. Delete it?',
  },
  'ии.стараяНеУдалилась': {
    ru: 'Не получилось удалить прежнюю модель: ',
    en: 'Couldn’t delete the old model: ',
  },
  'ии.модельБитая': {
    ru: 'Модель на компьютере повреждена: скачано {есть} из {всего} МБ.\n\n'
      + 'Похоже, прошлая загрузка оборвалась. Скачать заново?',
    en: 'The model on your computer is damaged: {есть} of {всего} MB downloaded.\n\n'
      + 'The previous download seems to have been cut short. Download it again?',
  },
  'ии.модельНужна': {
    ru: 'Для удаления вокала нужна модель — {мб} МБ.\n\n'
      + 'Она скачается один раз и останется на компьютере: дальше всё работает без интернета. '
      + 'Скачать сейчас?',
    en: 'Vocal removal needs a model — {мб} MB.\n\n'
      + 'It downloads once and stays on your computer: everything works offline afterwards. '
      + 'Download it now?',
  },
  'ии.скачиваемМодель': { ru: 'Скачиваем модель…', en: 'Downloading the model…' },
  'ии.разоваяЗагрузка': {
    ru: 'Это разовая загрузка, потом интернет не нужен.',
    en: 'A one-time download; after this you don’t need the internet.',
  },
  'ии.скачиваемХод': { ru: 'Скачиваем модель… {есть} из {всего} МБ', en: 'Downloading the model… {есть} of {всего} MB' },
  'ии.модельНеСкачалась': { ru: 'Не удалось скачать модель: ', en: 'Couldn’t download the model: ' },
  'ии.сбойПотока': { ru: 'сбой в потоке расчёта', en: 'the worker thread failed' },
  'ии.сначалаПесня': { ru: 'Сначала загрузи песню.', en: 'Load a song first.' },
  'ии.готовимЗвук': { ru: 'Готовим звук…', en: 'Preparing the audio…' },
  'ии.загружаемМодель': { ru: 'Загружаем модель…', en: 'Loading the model…' },
  'ии.модельНеНайдена': { ru: 'Модель не найдена', en: 'Model not found' },
  'ии.неПолучилось': { ru: 'Не получилось убрать вокал: ', en: 'Couldn’t remove the vocals: ' },
  'ии.почтиГотово': { ru: 'Почти готово…', en: 'Almost done…' },
  'ии.возвращаемКачество': { ru: 'Возвращаем исходное качество звука.', en: 'Restoring the original audio quality.' },
  'ии.имяНесколько': {
    ru: 'нейросеть (UVR-MDX-NET-Inst_HQ_3, {n} прохода)',
    en: 'neural network (UVR-MDX-NET-Inst_HQ_3, {n} passes)',
  },
  'ии.имя': { ru: 'нейросеть (UVR-MDX-NET-Inst_HQ_3)', en: 'neural network (UVR-MDX-NET-Inst_HQ_3)' },
  'ии.готово': {
    ru: 'Готово! Вокал убран нейросетью.\n\n'
      + 'Минусовка уже подставлена — можно идти дальше. '
      + 'Если захочешь вернуть обычное приглушение, нажми «Убрать» в блоке минусовки.',
    en: 'Done — the vocals are gone.\n\n'
      + 'The instrumental is already in place, so you can move on. '
      + 'If you want the plain ducking back, press “Remove” in the instrumental block.',
  },
  'ии.ошибка': { ru: 'Ошибка при удалении вокала: ', en: 'Error while removing the vocals: ' },
  'ии.готовимМодель': { ru: 'Готовим модель…', en: 'Preparing the model…' },
  'ии.ходПроходы': {
    ru: 'Убираем вокал: проход {проход} из {проходов}, кусок {кусок} из {кусков}',
    en: 'Removing vocals: pass {проход} of {проходов}, chunk {кусок} of {кусков}',
  },
  'ии.ход': { ru: 'Убираем вокал: {кусок} из {кусков}', en: 'Removing vocals: {кусок} of {кусков}' },

  /* ---------- Смена тональности ----------
     Надписи, которые собирает код: ход расчёта, состояние органа
     управления («звучит на два полутона выше», «выбрано, но ещё
     не посчитано») и значок в чипе памяти. Всё, что написано прямо
     в разметке, лежит в EN — там же рядом. */
  'тон.считаем': { ru: 'Меняем тональность…', en: 'Changing the key…' },
  'тон.ход': {
    ru: 'Меняем тональность: {процент} %',
    en: 'Changing the key: {процент}%',
  },
  'тон.сбойПотока': { ru: 'сбой в потоке расчёта', en: 'the worker thread failed' },
  'тон.неПолучилось': { ru: 'Не получилось сменить тональность: ', en: 'Couldn’t change the key: ' },
  'тон.возвращаем': {
    ru: 'Возвращаем тональность {выбрано}, выбранную в прошлый раз…',
    en: 'Restoring the key {выбрано} you chose last time…',
  },
  'тон.какЗаписана': {
    ru: 'Песня звучит так, как записана.',
    en: 'The song plays exactly as recorded.',
  },
  'тон.выше': {
    ru: {
      one: 'Звучит на {n} полутон выше записи.',
      few: 'Звучит на {n} полутона выше записи.',
      many: 'Звучит на {n} полутонов выше записи.',
    },
    en: {
      one: 'Playing {n} semitone above the recording.',
      other: 'Playing {n} semitones above the recording.',
    },
  },
  'тон.ниже': {
    ru: {
      one: 'Звучит на {n} полутон ниже записи.',
      few: 'Звучит на {n} полутона ниже записи.',
      many: 'Звучит на {n} полутонов ниже записи.',
    },
    en: {
      one: 'Playing {n} semitone below the recording.',
      other: 'Playing {n} semitones below the recording.',
    },
  },
  'тон.ждёт': {
    ru: 'Выбрано {выбрано}, а звучит {звучит}. Нажми «Применить» — расчёт займёт около {сек} с.',
    en: 'Chosen {выбрано}, playing {звучит}. Press “Apply” — it takes about {сек} s.',
  },
  'тон.чип': { ru: 'тональность {выбрано}', en: 'key {выбрано}' },

  /* ---------- Распознавание и подгонка текста ---------- */
  'asr.чистыйВокал': { ru: '✓ слушаем чистый вокал', en: '✓ listening to the clean vocal' },
  'asr.хвост.крупная': {
    ru: 'Считает крупная модель — она разбирает пение лучше всех, что у нас есть.',
    en: 'A large model does the work — it makes out singing better than anything else we have.',
  },
  'asr.хвост.вокал': {
    ru: ' Слушаем чистый вокал: по нему точнее, но дольше, чем по миксу.',
    en: ' Listening to the clean vocal: more accurate, but slower than the mix.',
  },
  'asr.модельНужна': {
    ru: 'Для распознавания нужна модель — около {мб} МБ.\n\n'
      + 'Она скачается один раз и останется на компьютере: дальше всё работает без интернета. '
      + 'Скачать сейчас?',
    en: 'Transcription needs a model — around {мб} MB.\n\n'
      + 'It downloads once and stays on your computer: everything works offline afterwards. '
      + 'Download it now?',
  },
  'asr.скачиваемМодель': { ru: 'Скачиваем модель распознавания…', en: 'Downloading the transcription model…' },
  'asr.модельНеСкачалась': { ru: 'Не удалось скачать модель: ', en: 'Couldn’t download the model: ' },
  'asr.сбойПотока': { ru: 'сбой в потоке распознавания', en: 'the transcription worker failed' },
  'asr.загружаемМодель': { ru: 'Загружаем модель распознавания…', en: 'Loading the transcription model…' },
  'asr.слушаем': { ru: 'Слушаем песню…', en: 'Listening to the song…' },
  'asr.разбираем': { ru: 'Разбираем слова…', en: 'Making out the words…' },
  'asr.трудныйКусок': {
    ru: 'Трудный кусок, слушаем заново ({n} из {всего})…',
    en: 'Tricky passage, listening again ({n} of {всего})…',
  },
  'asr.готовимЗвук': { ru: 'Готовим звук…', en: 'Preparing the audio…' },
  'asr.сначалаПесня': { ru: 'Сначала загрузи песню.', en: 'Load a song first.' },
  'asr.сначалаТекст': { ru: 'Сначала вставь текст песни в поле ниже.', en: 'Paste the lyrics into the field below first.' },
  'asr.меткаВремена': {
    ru: 'Времена проставлены. Строк: {строк}, слов: {слов}.',
    en: 'Timings are in place. Lines: {строк}, words: {слов}.',
  },
  'asr.меткаРасслышала': {
    ru: ' Нейросеть точно расслышала {процент}% слов.',
    en: ' The network heard {процент}% of the words for certain.',
  },
  'asr.меткаСомнительных': {
    ru: ' Строк с временем на глазок: {n} — в редакторе они помечены знаком ≈.',
    en: ' Lines with rough timing: {n} — flagged with ≈ in the editor.',
  },
  'asr.меткаБезСомнительных': {
    ru: ' Строк с временем на глазок нет.',
    en: ' No lines with rough timing.',
  },
  'asr.итогРазложено': {
    ru: 'Текст разложен по песне. Строк: {строк}, слов: {слов}.\n\n'
      + 'Нейросеть точно расслышала {процент}% слов — их время настоящее. '
      + 'Остальные расставлены между ними по числу слогов.',
    en: 'The lyrics are laid out over the song. Lines: {строк}, words: {слов}.\n\n'
      + 'The network heard {процент}% of the words for certain — their timing is real. '
      + 'The rest are spaced between them by syllable count.',
  },
  'asr.итогСомнительные': {
    ru: '\n\nСтрок, которые нейросеть почти не расслышала: {n}. '
      + 'В редакторе они помечены знаком ≈ — их стоит проверить и поправить '
      + 'в панели выбранной строки или прямо на дорожке.',
    en: '\n\nLines the network barely made out: {n}. '
      + 'They are flagged with ≈ in the editor — worth checking and fixing '
      + 'in the selected-line panel or right on the timeline.',
  },
  'asr.итогХвост': {
    ru: '\n\nВремена уже проставлены — простукивать в редакторе ничего не придётся.',
    en: '\n\nThe timings are already in place — there is nothing left to tap in the editor.',
  },
  'asr.ошибкаПодгонки': { ru: 'Ошибка при подгонке текста: ', en: 'Error while fitting the lyrics: ' },
  'asr.кнопка.подогнать': { ru: 'Подогнать мой текст', en: 'Fit my lyrics' },
  'asr.кнопка.подогнать.подсказка': {
    ru: 'Нейросеть послушает пение и расставит время строкам и словам по ТВОЕМУ тексту — сам текст останется как есть',
    en: 'The neural network listens to the singing and times the lines and words of YOUR lyrics — the text itself stays as it is',
  },

  /* ---------- Ошибки подгонки (align.js) ---------- */
  'подгонка.пустойТекст': { ru: 'пустой текст', en: 'the text is empty' },
  'подгонка.ниСлова': { ru: 'нейросеть не разобрала ни слова', en: 'the network made out no words at all' },
  'подгонка.неСовпало': {
    ru: 'ни одно слово текста не совпало с песней',
    en: 'not a single word of the text matched the song',
  },
  'подгонка.опорыНеСложились': { ru: 'опоры не сложились', en: 'no anchor points could be built' },
};

/* Раскладываем перевод сразу, на этом же вызове: файл подключён
   в конце <body>, дерево уже разобрано, и до первой отрисовки успеваем.
   Иначе на английском на долю секунды мелькнула бы русская страница. */
I18N.применить();
