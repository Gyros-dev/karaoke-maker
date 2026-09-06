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
