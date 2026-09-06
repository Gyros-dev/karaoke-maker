/* ============================================================
   Быстрые проверки арифметики разметки — без Electron и без окна.

   Полная самопроверка приложения идёт минуты: она поднимает окно,
   рисует холст, гоняет звук. А правка в timing.js бывает в одну
   строку, и ждать ради неё пять минут — значит не проверять вовсе.
   Здесь то же самое считается за миллисекунды:

     npm test

   Что сюда попадает: только чистые функции. Всё, чему нужны холст,
   звук или состояние студии, проверяется разделами самопроверки
   в desktop/main.js — им место там.
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');
const {
  MIN_SPAN, splitWords, сдвигСлов, меткаПоПоказанному,
  разложитьПоВесу, вместитьСлова, lineWords, wordProgress,
} = require('../timing.js');

const кругл = (v) => Math.round(v * 1000) / 1000;
const карта = (слова) => слова.map((w) => [w.text.trim(), кругл(w.start), кругл(w.end)]);

// Строка с размеченными словами: «на небе звёзды и луна», 10,0 → 11,9
const собрать = () => ({
  text: 'на небе звёзды и луна',
  time: 10,
  words: [
    { text: 'на ', time: 10.0, end: 10.4 },
    { text: 'небе ', time: 10.4, end: 10.8 },
    { text: 'звёзды ', time: 10.8, end: 11.3 },
    { text: 'и ', time: 11.3, end: 11.5 },
    { text: 'луна', time: 11.5, end: 11.9 },
  ],
});

test('splitWords: пробел приклеен к слову, подсветка идёт сплошняком', () => {
  assert.deepStrictEqual(splitWords('на небе звёзды'), ['на ', 'небе ', 'звёзды']);
  assert.deepStrictEqual(splitWords('   '), []);
  assert.deepStrictEqual(splitWords(''), []);
});

test('разложитьПоВесу: длинное слово поётся дольше, промежуток закрыт весь', () => {
  const места = разложитьПоВесу(['я ', 'работаю ', 'на ', 'складе'], 0, 4);
  assert.strictEqual(места.length, 4);
  assert.strictEqual(кругл(места[0].start), 0);
  assert.strictEqual(кругл(места[3].end), 4);
  // «работаю» длиннее «я» — и звучит дольше
  assert.ok(места[1].end - места[1].start > места[0].end - места[0].start);
  // Стык в стык: без дыр между словами
  for (let i = 1; i < места.length; i++) {
    assert.strictEqual(кругл(места[i].start), кругл(места[i - 1].end));
  }
});

test('вместитьСлова: помещаются — никого не трогаем', () => {
  const пок = [{ text: 'а ', start: 0, end: 1 }, { text: 'б', start: 1, end: 2 }];
  const было = JSON.stringify(пок);
  вместитьСлова(пок, 0, 2);
  assert.strictEqual(JSON.stringify(пок), было);
});

test('вместитьСлова: укоротили строку — сжимается ХВОСТ, а не всё разом', () => {
  const пок = [
    { text: 'на ', start: 10.0, end: 10.4 },
    { text: 'небе ', start: 10.4, end: 10.8 },
    { text: 'звёзды ', start: 10.8, end: 11.3 },
    { text: 'и ', start: 11.3, end: 11.5 },
    { text: 'луна', start: 11.5, end: 11.9 },
  ];
  вместитьСлова(пок, 10.0, 11.2);
  // Первые два помещались — стоят где стояли
  assert.deepStrictEqual([кругл(пок[0].start), кругл(пок[0].end)], [10, 10.4]);
  assert.deepStrictEqual([кругл(пок[1].start), кругл(пок[1].end)], [10.4, 10.8]);
  // Остальные разложены в остатке и внутрь строки уложились
  assert.ok(пок[2].start >= 10.8 - 1e-9);
  assert.ok(пок[4].end <= 11.2 + 1e-9);
  // Прежний код ужимал общим множителем: первое кончалось бы на 10,253
  assert.ok(пок[0].end > 10.35);
});

test('lineWords: метки едут за строкой, подтянутой к голосу', () => {
  const line = собрать();
  const span = { start: 10.3, core: 12.2, end: 12.2 };   // сдвиг 0,3 с
  assert.strictEqual(кругл(сдвигСлов(line, span)), 0.3);
  const слова = lineWords(line, span);
  assert.deepStrictEqual(карта(слова)[0], ['на', 10.3, 10.7]);
  assert.deepStrictEqual(карта(слова)[4], ['луна', 11.8, 12.2]);
  // Показанное и метка переводятся друг в друга без потерь
  assert.strictEqual(кругл(меткаПоПоказанному(line, span, 11.8)), 11.5);
});

test('lineWords: распев достаётся последнему слову, а не всей строке', () => {
  const line = собрать();
  const span = { start: 10, core: 11.9, end: 13 };       // голос тянет до 13
  const слова = lineWords(line, span);
  assert.strictEqual(кругл(слова[4].end), 13);           // хвост у последнего
  assert.strictEqual(кругл(слова[4].свой), 11.9);        // свой конец — без хвоста
  assert.strictEqual(кругл(слова[3].end), 11.5);         // соседям хвоста не досталось
});

test('lineWords: конец, выставленный руками, важнее распева', () => {
  const line = собрать();
  line.words[4].ручнойКонец = true;
  const слова = lineWords(line, { start: 10, core: 11.9, end: 13 });
  assert.strictEqual(кругл(слова[4].end), 11.9);
});

test('lineWords: строка без разметки делится по весу, хвост — последнему', () => {
  const слова = lineWords({ text: 'я работаю на складе', time: 0 }, { start: 0, core: 4, end: 5 });
  assert.strictEqual(слова.length, 4);
  assert.strictEqual(кругл(слова[0].start), 0);
  assert.strictEqual(кругл(слова[3].end), 5);            // распев
  assert.strictEqual(кругл(слова[3].свой), 4);           // свой конец — на core
});

test('lineWords: пауза перед первым словом остаётся паузой', () => {
  const line = { text: 'раз два', time: 10, words: [
    { text: 'раз ', time: 10.5, end: 10.9 },
    { text: 'два', time: 10.9, end: 11.3 },
  ] };
  const слова = lineWords(line, { start: 10, core: 11.3, end: 11.3 });
  assert.strictEqual(кругл(слова[0].start), 10.5);       // а не 10: певец вступает не сразу
});

test('wordProgress: слово закрашивается ровно внутри себя', () => {
  const слова = [{ start: 0, end: 1 }, { start: 1, end: 2 }];
  assert.deepStrictEqual(wordProgress(слова, 0), [0, 0]);
  assert.deepStrictEqual(wordProgress(слова, 1.5), [1, 0.5]);
  assert.deepStrictEqual(wordProgress(слова, 3), [1, 1]);
});

test('MIN_SPAN: короче этого ничего не делаем', () => {
  assert.strictEqual(MIN_SPAN, 0.08);
});

/* ---------- Чтение .lrc ---------- */
const { разобратьLrc } = require('../timing.js');

test('lrc: строка, время и сведения о песне', () => {
  const { строки, мета } = разобратьLrc('[ti:Звёзды]\n[ar:Ленинград]\n[00:12.30]первая\n[01:05.50]вторая');
  assert.strictEqual(мета.ti, 'Звёзды');
  assert.strictEqual(мета.ar, 'Ленинград');
  assert.deepStrictEqual(строки.map((л) => [л.text, кругл(л.time)]),
    [['первая', 12.3], ['вторая', 65.5]]);
});

test('lrc: метка без текста закрывает предыдущую строку', () => {
  const { строки } = разобратьLrc('[00:10.00]раз\n[00:12.00]\n[00:20.00]два');
  assert.strictEqual(кругл(строки[0].end), 12);
  assert.strictEqual(строки.length, 2);      // пустой строки не появилось
});

test('lrc: припев с несколькими метками разворачивается в строки', () => {
  const { строки } = разобратьLrc('[00:10.00][01:10.00][02:10.00]на небе звёзды');
  assert.strictEqual(строки.length, 3);
  assert.deepStrictEqual(строки.map((л) => кругл(л.time)), [10, 70, 130]);
  assert.ok(строки.every((л) => л.text === 'на небе звёзды'));
});

test('lrc: расширенный — слова, паузы и конец строки', () => {
  const { строки } = разобратьLrc('[00:12.30]<00:12.30>на <00:12.80>небе<00:13.50>');
  const л = строки[0];
  assert.strictEqual(л.text, 'на небе');
  assert.strictEqual(кругл(л.end), 13.5);
  assert.deepStrictEqual(л.words.map((w) => [w.text.trim(), кругл(w.time), кругл(w.end)]),
    [['на', 12.3, 12.8], ['небе', 12.8, 13.5]]);
});

test('lrc: метки слов у повтора едут вместе со строкой', () => {
  const { строки } = разобратьLrc('[00:10.00][00:30.00]<00:10.00>раз <00:10.50>два<00:11.00>');
  assert.strictEqual(кругл(строки[1].words[0].time), 30);
  assert.strictEqual(кругл(строки[1].words[1].time), 30.5);
  assert.strictEqual(кругл(строки[1].end), 31);
});

test('lrc: offset сдвигает всё разом, и в минус время не уходит', () => {
  const { строки, offset } = разобратьLrc('[offset:+500]\n[00:10.00]раз\n[00:00.20]рано');
  assert.strictEqual(кругл(offset), 0.5);
  assert.strictEqual(кругл(строки.find((л) => л.text === 'раз').time), 9.5);
  assert.strictEqual(кругл(строки.find((л) => л.text === 'рано').time), 0);
});

test('lrc: строки без времени и мусор пропускаются', () => {
  const { строки } = разобратьLrc('просто текст\n\n[кривая]\n[00:05.00]годная');
  assert.deepStrictEqual(строки.map((л) => л.text), ['годная']);
  assert.deepStrictEqual(разобратьLrc('').строки, []);
});

test('lrc: строки возвращаются по возрастанию времени', () => {
  const { строки } = разобратьLrc('[00:30.00]третья\n[00:10.00]первая\n[00:20.00]вторая');
  assert.deepStrictEqual(строки.map((л) => л.text), ['первая', 'вторая', 'третья']);
});

/* ---------- QR-код для «петь с телефона» ---------- */
const { qrКод, qrВерсияПод } = require('../qr.js');
const crypto = require('node:crypto');

// Слепок кода той самой ссылки, что стоит в примерах. Считан один раз
// и проверен распознавателем macOS: если он поехал — поехал и код.
const СЛЕПОК_QR = '0ad161e408074371';

test('qr: размер растёт версиями, длинное не влезает', () => {
  assert.strictEqual(qrКод('https://karaoke.punch/x').length, 25);      // версия 2
  assert.strictEqual(qrКод('http://192.168.1.42:8731/a7f3c1').length, 29); // версия 3
  assert.strictEqual(qrВерсияПод(200), 0);        // шестой версии не хватит
  assert.strictEqual(qrКод('я'.repeat(200)), null);
});

test('qr: глаза, линейки и чёрная точка на местах', () => {
  const m = qrКод('http://192.168.1.42:8731/a7f3c1');
  const n = m.length;
  // Три угловых глаза: чёрная рамка 7×7 с белым кольцом внутри
  for (const [cy, cx] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    assert.strictEqual(m[cy][cx], 1);
    assert.strictEqual(m[cy + 1][cx + 1], 0);
    assert.strictEqual(m[cy + 3][cx + 3], 1);
  }
  // Линейки между глазами чередуются
  for (let i = 8; i < n - 8; i++) assert.strictEqual(m[6][i], i % 2 === 0 ? 1 : 0);
  assert.strictEqual(m[n - 8][8], 1);             // всегда чёрная точка
  // Пустых клеток не осталось
  assert.ok(m.every((р) => р.every((v) => v === 0 || v === 1)));
});

test('qr: код не меняется от запуска к запуску', () => {
  /* Сам код проверен настоящим распознавателем macOS (см. README,
     «Пение с телефона»); здесь стережём, чтобы он не поехал от правок. */
  const слепок = (s) => crypto.createHash('sha256')
    .update(qrКод(s).map((р) => р.join('')).join('')).digest('hex').slice(0, 16);
  assert.strictEqual(слепок('http://192.168.1.42:8731/a7f3c1'), СЛЕПОК_QR);
});
