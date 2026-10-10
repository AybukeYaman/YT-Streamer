const test = require('node:test');
const assert = require('node:assert/strict');
const { PomodoroPlanner, MAX_CLIPS_PER_RUN } = require('../../src/application/pomodoro-planner');
const { PomodoroOverlayWriter } = require('../../src/application/pomodoro-overlay-writer');

const T0 = 1_700_000_000_000;

function fakeLog() {
  const lines = [];
  const rec = (level) => (m) => lines.push({ level, m });
  return { log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }, lines };
}

// Belleğe yazan sahte store: load/save çağrıları kaydedilir.
function fakeStore(initial = null) {
  return {
    saved: [],
    value: initial,
    load() { return this.value; },
    save(s) { this.saved.push(s); this.value = { startedAt: s.startedAt, seed: s.seed }; },
  };
}

function setup({
  store = fakeStore(), type = '50+10', nowMs = T0, studyClips = [], breakClips = [], randomSeed = () => 1,
} = {}) {
  const writes = new Map();
  const { log, lines } = fakeLog();
  const planner = new PomodoroPlanner({
    type,
    overlayWriter: new PomodoroOverlayWriter({
      dir: '/ov', writeFile: (p, c) => writes.set(p, c), fontSize: 56,
    }),
    store,
    log,
    studyClips,
    breakClips,
    randomSeed,
    now: () => nowMs,
  });
  return { planner, writes, store, lines };
}

test('ilk plan: döngü şimdi başlar, seed üretilir, ikisi diske yazılır', () => {
  const { planner, store } = setup({ randomSeed: () => 7 });
  planner.plan({ durationSeconds: 600 });
  assert.deepEqual(store.saved, [{ type: '50+10', startedAt: T0, seed: 7 }]);
});

test('kayıtlı başlangıç varsa yeniden yazılmaz, faz oradan hesaplanır (restart kurtarma)', () => {
  // Döngü 55 dk önce başlamış → şu an molanın 5. dakikası
  const store = fakeStore({ startedAt: T0 - 55 * 60_000, seed: 3 });
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
  const store = fakeStore({ startedAt: T0 - (50 * 60 - 20) * 1000, seed: 1 });
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
  const store = fakeStore({ startedAt: T0 - 55 * 60_000, seed: 1 });
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

// ── study/break klip havuzu (N3) ─────────────────────────────────────────────

test('havuzlar boşsa phaseBackgrounds boş (mevcut davranış: albümün kendi arkaplanı)', () => {
  const { planner } = setup();
  assert.deepEqual(planner.plan({ durationSeconds: 3700 }).phaseBackgrounds, []);
});

test('mola pencereleri BREAK segmentleriyle BİREBİR aynı (yazı ile görsel kayamaz)', () => {
  const writes = new Map();
  const { log } = fakeLog();
  const planner = new PomodoroPlanner({
    type: '50+10',
    overlayWriter: new PomodoroOverlayWriter({ dir: '/ov', writeFile: (p, c) => writes.set(p, c), fontSize: 56 }),
    store: fakeStore(),
    log,
    breakClips: ['/runtime/break-background.mp4'],
    randomSeed: () => 1,
    now: () => T0,
  });
  const { pomodoro, phaseBackgrounds } = planner.plan({ durationSeconds: 3700 });

  // STUDY 0-3000, BREAK 3000-3600, STUDY 3600-null — tek break penceresi var.
  assert.deepEqual(phaseBackgrounds, [{ path: '/runtime/break-background.mp4', start: 3000, end: 3600 }]);
  const breakStatus = pomodoro.statusTexts[1];
  assert.equal(breakStatus.start, phaseBackgrounds[0].start);
  assert.equal(breakStatus.end, phaseBackgrounds[0].end);
  assert.equal(writes.get('/ov/pomodoro-002.txt'), 'BREAK');
});

test('tek elemanlı havuz: hep aynı klip (tekrar kuralı uygulanamaz)', () => {
  const planner = new PomodoroPlanner({
    type: '50+10',
    overlayWriter: new PomodoroOverlayWriter({ dir: '/ov', writeFile: () => {}, fontSize: 56 }),
    store: fakeStore(), log: fakeLog().log,
    studyClips: ['/s.mp4'], breakClips: ['/b.mp4'],
    randomSeed: () => 1, now: () => T0,
  });
  const { phaseBackgrounds } = planner.plan({ durationSeconds: 7300 });
  assert.ok(phaseBackgrounds.every((p) => p.path === '/s.mp4' || p.path === '/b.mp4'));
});

test('restart simülasyonu: aynı seed + aynı nowMs → aynı klip ataması', () => {
  const store1 = fakeStore();
  const studyClips = ['/a.mp4', '/b.mp4', '/c.mp4'];
  const p1 = new PomodoroPlanner({
    type: '50+10',
    overlayWriter: new PomodoroOverlayWriter({ dir: '/ov', writeFile: () => {}, fontSize: 56 }),
    store: store1, log: fakeLog().log, studyClips, randomSeed: () => 99, now: () => T0,
  });
  const first = p1.plan({ durationSeconds: 60 });

  // "Restart": YENİ bir planner örneği ama store aynı diske yazılmış kaydı döndürüyor —
  // ffmpeg'in session ortasında yeniden başlamasını simüle eder.
  const store2 = fakeStore(store1.value);
  const p2 = new PomodoroPlanner({
    type: '50+10',
    overlayWriter: new PomodoroOverlayWriter({ dir: '/ov', writeFile: () => {}, fontSize: 56 }),
    store: store2, log: fakeLog().log, studyClips, randomSeed: () => 1234, now: () => T0,
  });
  const second = p2.plan({ durationSeconds: 60 });
  assert.deepEqual(first.phaseBackgrounds, second.phaseBackgrounds);
});

test('MAX_CLIPS_PER_RUN aşımında fazlalar zaten kullanılan kliplere deterministik düşer', () => {
  // 50+10'da 7300 sn'lik bir çalıştırma 3 study + 2 break faz üretiyor (bkz.
  // domain/pomodoro.test.js); 5 farklı klipli bir havuzla MAX_CLIPS_PER_RUN'ı
  // (4) aşmayı zorluyoruz.
  const planner = new PomodoroPlanner({
    type: '50+10',
    overlayWriter: new PomodoroOverlayWriter({ dir: '/ov', writeFile: () => {}, fontSize: 56 }),
    store: fakeStore(), log: fakeLog().log,
    studyClips: ['/s1.mp4', '/s2.mp4', '/s3.mp4', '/s4.mp4', '/s5.mp4'],
    randomSeed: () => 1, now: () => T0,
  });
  const { phaseBackgrounds } = planner.plan({ durationSeconds: 7300 });
  const distinct = new Set(phaseBackgrounds.map((p) => p.path));
  assert.ok(distinct.size <= MAX_CLIPS_PER_RUN, `distinct=${distinct.size} MAX=${MAX_CLIPS_PER_RUN}'ı aşmamalı`);
});

test('klip yokken komut BUGÜNKÜYLE BİREBİR AYNI (regresyon kalkanı)', () => {
  const { planner } = setup({ studyClips: [], breakClips: [] });
  const { phaseBackgrounds } = planner.plan({ durationSeconds: 3700 });
  assert.deepEqual(phaseBackgrounds, []);
});
