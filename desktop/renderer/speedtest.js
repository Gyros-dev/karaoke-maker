/* Мостик для сквозной проверки: запускает тот же воркер,
   которым пользуется кнопка «Убрать вокал». */
window.__runSeparationTest = function (modelBytes, L, R, shifts, движокСилой) {
  return new Promise((resolve) => {
    const w = new Worker('separator-worker.js');
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { console.log('прогресс', m.percent, m.ключ); return; }
      if (m.type === 'done') resolve({ ok: true, left: m.left, right: m.right, vocal: m.vocal, движок: m.движок });
      else resolve({ ok: false, error: m.error });
      w.terminate();
    };
    w.onerror = (err) => resolve({ ok: false, error: err.message || 'сбой воркера' });
    const l = L.slice(), r = R.slice();
    // Проходов столько же, сколько выбрано в интерфейсе: так проверка
    // гоняет ровно тот режим, который получит человек
    w.postMessage({ modelBytes, left: l.buffer, right: r.buffer, sampleRate: 44100, shifts, движокСилой },
      [l.buffer, r.buffer]);
  });
};
