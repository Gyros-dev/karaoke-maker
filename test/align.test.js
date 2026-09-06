/* Быстрые проверки подгонки текста под песню (desktop/renderer/align.js).

   Файл нарочно отдаётся и в окно приложения, и в Node — вот второй
   случай. Тут проверяется арифметика: похожесть слов, слоги, раскладка
   между опорами и сама подгонка на коротком выдуманном «распознавании».
   Живые замеры на настоящей песне — отдельная работа, их место
   не в быстрых проверках. */
const test = require('node:test');
const assert = require('node:assert');
const Align = require('../desktop/renderer/align.js');

const кругл = (v) => Math.round(v * 1000) / 1000;

test('norm и similarity: «пабричном» узнаётся как «фабричном»', () => {
  assert.strictEqual(Align.norm('Ёлки-палки!'), 'елкипалки');
  assert.ok(Align.similarity('фабричном', 'пабричном') > Align.MATCH_MIN);
  assert.ok(Align.similarity('луна', 'трактор') < Align.MATCH_MIN);
});

test('syllables: слоги считаются по гласным, минимум один', () => {
  assert.strictEqual(Align.syllables('луна'), 2);
  assert.strictEqual(Align.syllables('здравствуйте'), 3);
  assert.strictEqual(Align.syllables('в'), 1);
});

test('parseLyrics: текст разбирается на строки и слова', () => {
  const { lines, words } = Align.parseLyrics('на небе звёзды\nи луна');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(words.length, 5);
  assert.strictEqual(lines[1].from, 3);
  assert.strictEqual(lines[1].count, 2);
});

test('spread: слова раскладываются по слогам внутри промежутка', () => {
  const words = [{ text: 'на' }, { text: 'небе' }, { text: 'звёздочка' }];
  const times = new Array(3).fill(null);
  Align.spread(times, words, 0, 2, 10, 6);
  assert.strictEqual(кругл(times[0].time), 10);
  assert.strictEqual(кругл(times[2].end), 16);
  // Три слога у «звёздочки» против одного у «на» — и времени втрое больше
  const длина = (t) => t.end - t.time;
  assert.ok(длина(times[2]) > длина(times[0]) * 2);
  // Слова идут подряд и не налезают
  assert.ok(times[1].time >= times[0].end - 1e-9);
  assert.ok(times[2].time >= times[1].end - 1e-9);
});

test('spread с огибающей: слова садятся на пение, а не на тишину', () => {
  const words = [{ text: 'раз' }, { text: 'два' }];
  const тишина = new Array(2).fill(null);
  Align.spread(тишина, words, 0, 1, 0, 10);
  const сПением = new Array(2).fill(null);
  // Поют только в конце промежутка — второе слово обязано уехать туда
  Align.spread(сПением, words, 0, 1, 0, 10, [{ start: 6, end: 10 }]);
  assert.ok(сПением[1].time > тишина[1].time);
});

test('fit: времена берутся у нейросети, буквы — у человека', () => {
  const recWords = [
    { text: 'на', start: 10.0, end: 10.4 },
    { text: 'небе', start: 10.4, end: 10.9 },
    { text: 'звёзды', start: 10.9, end: 11.6 },
    { text: 'и', start: 12.5, end: 12.7 },
    { text: 'пабричном', start: 12.7, end: 13.4 },
  ];
  const итог = Align.fit('на небе звёзды\nи фабричном', recWords, { duration: 20 });
  assert.strictEqual(итог.lines.length, 2);
  // Первая строка встала на своё распознанное место
  assert.ok(Math.abs(итог.lines[0].time - 10.0) < 0.2);
  // Вторая — тоже, хотя слово услышано с ошибкой в первой букве
  assert.ok(Math.abs(итог.lines[1].time - 12.5) < 0.3);
  // Текст остался человеческим, а не распознанным
  assert.strictEqual(итог.lines[1].text, 'и фабричном');
});
