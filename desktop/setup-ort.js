#!/usr/bin/env node
/* Кладёт файлы движка ONNX из зависимостей в папку интерфейса.
   В репозитории их нет — это 39 МБ, которые ставятся через npm install.
   Запускается сам после установки зависимостей. */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist');
const OUT = path.join(__dirname, 'renderer', 'ort');

const NEEDED = [
  'ort.min.js',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];

if (!fs.existsSync(SRC)) {
  console.error('Не нашёл onnxruntime-web — сначала запусти npm install');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
let copied = 0;
for (const name of NEEDED) {
  const from = path.join(SRC, name);
  if (!fs.existsSync(from)) {
    console.error('Нет файла', name, '— возможно, изменилась версия onnxruntime-web');
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(OUT, name));
  copied++;
}
console.log(`Движок ONNX готов: ${copied} файлов в renderer/ort`);
