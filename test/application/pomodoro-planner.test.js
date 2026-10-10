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
  assert.deepEqual(beepTimes, [18.2, 18.8, 19.4]);
});

test('"POMODORO 50+10" etiketi artık YAZILMAZ (sağ üst sayaca ve duruma ayrıldı)', () => {
  const { planner, writes } = setup();
  const { pomodoro } = planner.plan({ durationSeconds: 600 });
  assert.equal(writes.get('/ov/pomodoro-label.txt'), undefined);
  assert.equal(pomodoro.labelTextFile, undefined);
});

test('30+10 türü çizelgeye yansır', () => {
  const { planner } = setup({ type: '30+10' });
  const { pomodoro } = planner.plan({ durationSeconds: 2500 });
  assert.deepEqual(pomodoro.statusTexts.map((s) => s.start), [0, 1800, 2400]);
});

test('geri sayım döngünün ölçüleriyle birlikte döner (çalıştırmaya göreli offset)', () => {
  // Döngü 55 dk önce başladı → çalıştırma döngünün 3300. saniyesinde yakalıyor
  const store = fakeStore(T0 - 55 * 60_000);
  const { planner } = setup({ store });
  const { pomodoro } = planner.plan({ durationSeconds: 600 });
  assert.deepEqual(pomodoro.countdown, {
    studySeconds: 3000, cycleSeconds: 3600, offsetSeconds: 3300,
  });
});

test('durum yazısı parça başlığından ayrı konum ve punto alır; sayaçla iki satır', () => {
  const { planner } = setup();
  const { pomodoro } = planner.plan({ durationSeconds: 600 });
  assert.equal(pomodoro.fontSize, 56);
  assert.equal(pomodoro.statusPosition, 'top-right');
  assert.equal(pomodoro.lineGap, 14, 'satır aralığı punto ile orantılı');
});

// ── Mola arkaplanı ───────────────────────────────────────────────────────────
test('breakClipPath verilmezse mola arkaplanı yok', () => {
  const { planner } = setup();
  assert.equal(planner.plan({ durationSeconds: 3700 }).breakBackground, null);
});

test('mola pencereleri BREAK segmentleriyle BİREBİR aynı (yazı ile görsel kayamaz)', () => {
  const store = fakeStore();
  const writes = new Map();
  const { log } = fakeLog();
  const planner = new PomodoroPlanner({
    type: '50+10',
    overlayWriter: new PomodoroOverlayWriter({ dir: '/ov', writeFile: (p, c) => writes.set(p, c), fontSize: 56 }),
    store,
    log,
    breakClipPath: '/runtime/break-background.mp4',
    now: () => T0,
  });
  const { pomodoro, breakBackground } = planner.plan({ durationSeconds: 3700 });

  assert.equal(breakBackground.path, '/runtime/break-background.mp4');
  // STUDY 0-3000, BREAK 3000-3600, STUDY 3600-null
  const breakStatus = pomodoro.statusTexts.filter((_, i) => i === 1);
  assert.deepEqual(breakBackground.windows, [{ start: 3000, end: 3600 }]);
  assert.equal(breakStatus[0].start, breakBackground.windows[0].start);
  assert.equal(breakStatus[0].end, breakBackground.windows[0].end);
  assert.equal(writes.get('/ov/pomodoro-002.txt'), 'BREAK');
});

test('çalıştırmada hiç mola yoksa mola arkaplanı verilmez', () => {
  const store = fakeStore();
  const { log } = fakeLog();
  const planner = new PomodoroPlanner({
    type: '50+10',
    overlayWriter: new PomodoroOverlayWriter({ dir: '/ov', writeFile: () => {}, fontSize: 56 }),
    store, log, breakClipPath: '/runtime/break.mp4', now: () => T0,
  });
  // Yalnızca çalışma fazına sığan kısa çalıştırma
  assert.equal(planner.plan({ durationSeconds: 600 }).breakBackground, null);
});
