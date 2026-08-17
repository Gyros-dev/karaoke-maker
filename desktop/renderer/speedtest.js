/* Мостик для сквозной проверки: запускает тот же воркер,
   которым пользуется кнопка «Убрать вокал». */
window.__runSeparationTest = function (modelBytes, L, R) {
  return new Promise((resolve) => {
    const w = new Worker('separator-worker.js');
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { console.log('прогресс', m.percent, m.text); return; }
      if (m.type === 'done') resolve({ ok: true, left: m.left, right: m.right, vocal: m.vocal });
      else resolve({ ok: false, error: m.error });
      w.terminate();
    };
    w.onerror = (err) => resolve({ ok: false, error: err.message || 'сбой воркера' });
    const l = L.slice(), r = R.slice();
    w.postMessage({ modelBytes, left: l.buffer, right: r.buffer, sampleRate: 44100 },
      [l.buffer, r.buffer]);
  });
};
