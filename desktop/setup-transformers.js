#!/usr/bin/env node
/* Кладёт библиотеку transformers.js и её движок ONNX в папку интерфейса.
   Нужна для распознавания текста песни (Whisper).

   Важно: у transformers.js внутри свой onnxruntime-web другой версии,
   чем у разделения вокала. Поэтому берём wasm-файлы именно из его
   вложенных зависимостей — иначе версии стекла и бинарника разъедутся
   и всё падает с «wasm module not found».

   Запускается сам после установки зависимостей. */

const fs = require('fs');
const path = require('path');

const PKG = path.join(__dirname, 'node_modules', '@huggingface', 'transformers');
const OUT = path.join(__dirname, 'renderer', 'xf');

// Вложенный onnxruntime-web transformers.js, если он есть; иначе общий
const NESTED = path.join(PKG, 'node_modules', 'onnxruntime-web', 'dist');
const SHARED = path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist');
const ORT = fs.existsSync(NESTED) ? NESTED : SHARED;

if (!fs.existsSync(PKG)) {
  console.error('Не нашёл @huggingface/transformers — сначала запусти npm install');
  process.exit(1);
}

const FILES = [
  [path.join(PKG, 'dist', 'transformers.min.js'), 'transformers.min.js'],
  // Однопоточная и многопоточная сборки: движок сам выберет по возможностям
  [path.join(ORT, 'ort-wasm-simd-threaded.mjs'), 'ort-wasm-simd-threaded.mjs'],
  [path.join(ORT, 'ort-wasm-simd-threaded.wasm'), 'ort-wasm-simd-threaded.wasm'],
];

fs.mkdirSync(OUT, { recursive: true });
let copied = 0;
for (const [from, name] of FILES) {
  if (!fs.existsSync(from)) {
    console.error('Нет файла', from, '— возможно, изменилась версия transformers.js');
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(OUT, name));
  copied++;
}
console.log(`Распознавание речи готово: ${copied} файлов в renderer/xf`);
