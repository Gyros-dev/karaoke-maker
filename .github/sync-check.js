/* Приложение носит копию сайта в desktop/renderer/ — её кладёт
   `npm run app:sync`. Забыть синхронизацию легко: правишь app.js,
   гоняешь самопроверку (она берёт копию!) и не понимаешь, почему
   ничего не изменилось. Здесь сверяются только те файлы, которые
   переносятся БЕЗ изменений: app.js и index.html синхронизатор
   дописывает своим, и сравнивать их построчно нечем. */
const fs = require('fs');
const path = require('path');
const КОРЕНЬ = path.join(__dirname, '..');
const файлы = ['timing.js', 'fft.js', 'tempo.js', 'pitch-worker.js',
  'mp4-muxer.js', 'webm-muxer.js'];
let бед = 0;
for (const имя of файлы) {
  const сайт = fs.readFileSync(path.join(КОРЕНЬ, имя), 'utf8');
  const копия = path.join(КОРЕНЬ, 'desktop', 'renderer', имя);
  if (!fs.existsSync(копия)) {
    console.error(`нет копии ${имя} в приложении — сделай npm run app:sync`);
    бед++;
    continue;
  }
  if (fs.readFileSync(копия, 'utf8') !== сайт) {
    console.error(`копия ${имя} отстала от сайта — сделай npm run app:sync`);
    бед++;
  }
}
if (бед) process.exit(1);
console.log(`копии на месте: ${файлы.join(', ')}`);
