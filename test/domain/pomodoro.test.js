const test = require('node:test');
const assert = require('node:assert/strict');
const { PomodoroCycle, PomodoroError, POMODORO_TYPES, STUDY, BREAK } = require('../../src/domain/pomodoro');

const T0 = 1_700_000_000_000; // sabit başlangıç anı
const at = (minutes) => T0 + minutes * 60_000;
const cycle = (type = '50+10', startedAt = T0) => new PomodoroCycle({ type, startedAt });

test('iki tür tanımlı, süreleri doğru', () => {
  assert.deepEqual(Object.keys(POMODORO_TYPES), ['50+10', '30+10']);
  assert.equal(cycle('50+10').cycleSeconds, 3600);
  assert.equal(cycle('30+10').cycleSeconds, 2400);
});

test('etiket türden türüyor', () => {
  assert.equal(cycle('50+10').label, 'POMODORO 50+10');
  assert.equal(cycle('30+10').label, 'POMODORO 30+10');
});

test('bilinmeyen tür ve geçersiz başlangıç kurulumda yakalanır', () => {
  // Biçime uymayan ya da sıfır/negatif süreli türler reddedilir.
  assert.throws(() => cycle('yirmibes'), PomodoroError);
  assert.throws(() => cycle('0+5'), PomodoroError);
  assert.throws(() => cycle('50-10'), PomodoroError);
  assert.throws(() => new PomodoroCycle({ type: '50+10', startedAt: null }), PomodoroError);
});

// Serbest süre: hazır listede olmayan "<calisma>+<mola>" da geçerli bir tür (TUI'daki
// "Custom" seçeneği bu metni üretir). Ayrı bir alan/ikinci bir tür listesi yok.
test('serbest süre türü kabul edilir ve etikete yansır', () => {
  const c = cycle('45+15');
  assert.equal(c.studySeconds, 45 * 60);
  assert.equal(c.breakSeconds, 15 * 60);
  assert.equal(c.label, 'POMODORO 45+15');
});

test('phaseAt: çalışma ve mola doğru yerde, kalan süre doğru', () => {
  const c = cycle();
  assert.deepEqual(c.phaseAt(at(0)), { phase: STUDY, remainingSeconds: 3000 });
  assert.deepEqual(c.phaseAt(at(49)), { phase: STUDY, remainingSeconds: 60 });
  assert.deepEqual(c.phaseAt(at(50)), { phase: BREAK, remainingSeconds: 600 });
  assert.deepEqual(c.phaseAt(at(59)), { phase: BREAK, remainingSeconds: 60 });
  // ikinci tur: döngü başa sarar
  assert.deepEqual(c.phaseAt(at(60)), { phase: STUDY, remainingSeconds: 3000 });
  assert.deepEqual(c.phaseAt(at(110)), { phase: BREAK, remainingSeconds: 600 });
});

test('geçmiş startedAt restart sonrası doğru faza düşürür (kurtarma)', () => {
  // Döngü saatler önce başlamış; süreç yeni ayağa kalkmış olsa da faz kaymaz.
  const c = cycle('50+10', T0);
  // 140 dk = 2 tam tur + 20 dk → çalışmanın 20. dakikası, 30 dk kalmış
  assert.deepEqual(c.phaseAt(at(140)), { phase: STUDY, remainingSeconds: 1800 });
  // 115 dk = 1 tam tur + 55 dk → molanın 5. dakikası, 5 dk kalmış
  assert.deepEqual(c.phaseAt(at(115)), { phase: BREAK, remainingSeconds: 300 });
});

test('startedAt gelecekteyse (saat kayması) döngü başlamamış sayılır', () => {
  const c = cycle('50+10', at(10));
  assert.equal(c.elapsedAt(T0), 0);
  assert.equal(c.phaseAt(T0).phase, STUDY);
});

test('segmentsFor: faz başında başlayan çalıştırma', () => {
  const segments = cycle().segmentsFor({ nowMs: at(0), durationSeconds: 3700 });
  assert.deepEqual(segments, [
    { phase: STUDY, start: 0, end: 3000, phaseIndex: 0 },
    { phase: BREAK, start: 3000, end: 3600, phaseIndex: 0 },
    { phase: STUDY, start: 3600, end: null, phaseIndex: 1 },
  ]);
});

test('segmentsFor: faz ORTASINDA başlayan çalıştırma — ilk segment 0\'a kırpılır', () => {
  // Çalışma fazının 20. dakikasında başla: 30 dk çalışma kalmış
  const segments = cycle().segmentsFor({ nowMs: at(20), durationSeconds: 2400 });
  assert.deepEqual(segments, [
    { phase: STUDY, start: 0, end: 1800, phaseIndex: 0 },
    { phase: BREAK, start: 1800, end: null, phaseIndex: 0 },
  ]);
});

test('segmentsFor: mola ortasında başlayan çalıştırma', () => {
  const segments = cycle().segmentsFor({ nowMs: at(55), durationSeconds: 600 });
  assert.deepEqual(segments, [
    { phase: BREAK, start: 0, end: 300, phaseIndex: 0 },
    { phase: STUDY, start: 300, end: null, phaseIndex: 1 },
  ]);
});

test('segmentsFor: tek faza sığan kısa çalıştırma', () => {
  const segments = cycle().segmentsFor({ nowMs: at(0), durationSeconds: 60 });
  assert.deepEqual(segments, [{ phase: STUDY, start: 0, end: null, phaseIndex: 0 }]);
});

test('segmentsFor: phaseIndex restart\'a dayanıklı — aynı anın segmenti, farklı durationSeconds\'ta aynı index', () => {
  // 140. dakikada başlayan (2 tam tur + 20 dk) bir çalıştırma, ffmpeg'in bu session'ı
  // farklı bir noktada (örn. restart sonrası) yeniden başlatmasını simüle eder: aynı
  // nowMs'teki faz hep aynı phaseIndex'e düşmeli, durationSeconds'tan bağımsız.
  const short = cycle().segmentsFor({ nowMs: at(140), durationSeconds: 60 });
  const long = cycle().segmentsFor({ nowMs: at(140), durationSeconds: 2400 });
  assert.equal(short[0].phaseIndex, long[0].phaseIndex);
  assert.equal(short[0].phaseIndex, 2); // 2 tam tur tamamlanmış → üçüncü study (0-based: 2)
});

test('segmentsFor: phaseIndex ardışık fazlarda artıyor, study/break ayrı sayılıyor', () => {
  const segments = cycle().segmentsFor({ nowMs: at(0), durationSeconds: 7300 });
  assert.deepEqual(segments.map((s) => [s.phase, s.phaseIndex]), [
    [STUDY, 0], [BREAK, 0], [STUDY, 1], [BREAK, 1], [STUDY, 2],
  ]);
});

test('segmentsFor: geçersiz süre reddedilir', () => {
  assert.throws(() => cycle().segmentsFor({ nowMs: T0, durationSeconds: 0 }), PomodoroError);
});

test('beepTimesFor: her geçişten önce 3 bip', () => {
  // 0'da başlayan çalıştırma: ilk faz zaten başlamış, bip yok; 3000. sn'deki molaya 3 bip
  const beeps = cycle().beepTimesFor({ nowMs: at(0), durationSeconds: 3300 });
  assert.deepEqual(beeps, [2998.2, 2998.8, 2999.4]);
});

test('beepTimesFor: iki geçiş varsa iki üçlü', () => {
  const beeps = cycle().beepTimesFor({ nowMs: at(0), durationSeconds: 3700 });
  assert.equal(beeps.length, 6);
  assert.deepEqual(beeps.slice(0, 3), [2998.2, 2998.8, 2999.4]);
  assert.deepEqual(beeps.slice(3), [3598.2, 3598.8, 3599.4]);
});

test('beepTimesFor: yarıda yakalanan faz için bip ÇALMAZ (geçiş geçmişte kaldı)', () => {
  const beeps = cycle().beepTimesFor({ nowMs: at(20), durationSeconds: 600 });
  assert.deepEqual(beeps, []);
});

test('30+10 türünde geçişler 30. ve 40. dakikada', () => {
  const segments = cycle('30+10').segmentsFor({ nowMs: at(0), durationSeconds: 2500 });
  assert.deepEqual(segments, [
    { phase: STUDY, start: 0, end: 1800, phaseIndex: 0 },
    { phase: BREAK, start: 1800, end: 2400, phaseIndex: 0 },
    { phase: STUDY, start: 2400, end: null, phaseIndex: 1 },
  ]);
});
