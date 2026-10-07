const test = require('node:test');
const assert = require('node:assert/strict');
const { PomodoroPlanner } = require('../../src/application/pomodoro-planner');
const { PomodoroOverlayWriter } = require('../../src/application/pomodoro-overlay-writer');

const T0 = 1_700_000_000_000;

function fakeLog() {
  const lines = [];
  const rec = (level) => (m) => lines.push({ level, m });
  return { log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }, lines };
}

// Belleğe yazan sahte store: load/save çağrıları kaydedilir.
function fakeStore(initial = null) {
  return { saved: [], value: initial, load() { return this.value; }, save(s) { this.saved.push(s); this.value = s.startedAt; } };
}

function setup({ store = fakeStore(), type = '50+10', nowMs = T0 } = {}) {
  const writes = new Map();
  const { log, lines } = fakeLog();
  const planner = new PomodoroPlanner({
    type,
    overlayWriter: new PomodoroOverlayWriter({
      dir: '/ov', writeFile: (p, c) => writes.set(p, c), fontSize: 56,
    }),
    store,
    log,
    now: () => nowMs,
  });
  return { planner, writes, store, lines };
}

test('ilk plan: döngü şimdi başlar ve diske yazılır', () => {
  const { planner, store } = setup();
  planner.plan({ durationSeconds: 600 });
  assert.deepEqual(store.saved, [{ type: '50+10', startedAt: T0 }]);
});

test('kayıtlı başlangıç varsa yeniden yazılmaz, faz oradan hesaplanır (restart kurtarma)', () => {
  // Döngü 55 dk önce başlamış → şu an molanın 5. dakikası
  const store = fakeStore(T0 - 55 * 60_000);
  const { planner, writes } = setup({ store });
  const { phase } = planner.plan({ durationSeconds: 600 });

  assert.equal(phase, 'break');
  assert.deepEqual(store.saved, [], 'var olan başlangıç üzerine yazılmamalı');
  assert.equal(writes.get('/ov/pomodoro-001.txt'), 'BREAK');
});

test('döngü bir kez çözülür: ikinci plan aynı başlangıcı kullanır', () => {
  const { planner, store } = setup();
  planner.plan({ durationSeconds: 600 });
  planner.plan({ durationSeconds: 600 });
  assert.equal(store.saved.length, 1);
});

test('plan: overlay metinleri ve bip zamanları encoder biçiminde döner', () => {
  // Çalışmanın bitimine 20 sn kala başla: geçiş ve 3 bip bu çalıştırmada
  const store = fakeStore(T0 - (50 * 60 - 20) * 1000);
  const { planner, writes } = setup({ store });
  const { pomodoro, beepTimes } = planner.plan({ durationSeconds: 60 });

  assert.deepEqual(pomodoro.statusTexts.map((s) => s.start), [0, 20]);
  assert.equal(pomodoro.statusTexts[0].end, 20);
  assert.equal(pomodoro.statusTexts[1].end, null, 'son faz açık uçlu olmalı');
  assert.equal(writes.get('/ov/pomodoro-001.txt'), 'STUDY');
  assert.equal(writes.get('/ov/pomodoro-002.txt'), 'BREAK');
  assert.equal(writes.get('/ov/pomodoro-label.txt'), 'POMODORO 50+10');
  assert.equal(pomodoro.labelTextFile, '/ov/pomodoro-label.txt');
  assert.deepEqual(beepTimes, [18.2, 18.8, 19.4]);
});

test('30+10 türü etikete ve çizelgeye yansır', () => {
  const { planner, writes } = setup({ type: '30+10' });
  const { pomodoro } = planner.plan({ durationSeconds: 2500 });
  assert.equal(writes.get('/ov/pomodoro-label.txt'), 'POMODORO 30+10');
  assert.deepEqual(pomodoro.statusTexts.map((s) => s.start), [0, 1800, 2400]);
});

test('durum yazısı parça başlığından ayrı konum ve punto alır', () => {
  const { planner } = setup();
  const { pomodoro } = planner.plan({ durationSeconds: 600 });
  assert.equal(pomodoro.fontSize, 56);
  assert.equal(pomodoro.statusPosition, 'center');
  assert.equal(pomodoro.labelPosition, 'top-right');
});
