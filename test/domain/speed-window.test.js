const test = require('node:test');
const assert = require('node:assert/strict');

const { SpeedWindow } = require('../../src/domain/speed-window');

// Her 500 ms'de bir ilerleme satırı; speedAt(t) o aralıktaki anlık hız.
function feed(w, { fromMs, toMs, speedAt, startFrame = 0 }) {
  let frame = startFrame;
  for (let t = fromMs; t <= toMs; t += 500) {
    w.add(Math.round(frame), t);
    frame += speedAt(t) * 24 * 0.5;
  }
  return frame;
}

test('gerçek zamanlı akış: ısınma + pencere dolunca ortalama 1.0, durum ok', () => {
  const w = new SpeedWindow({ fps: 24 });
  feed(w, { fromMs: 0, toMs: 70000, speedAt: () => 1 });
  const s = w.status(70000);
  assert.equal(s.state, 'ok');
  assert.ok(Math.abs(s.average - 1) < 0.01, String(s.average));
});

test('ilk 30 sn (ısınma) ve ardından pencere dolana kadar warming — başlangıç sıçraması sayılmaz', () => {
  const w = new SpeedWindow({ fps: 24 });
  // ilk 30 sn 5x (restart sıçraması), sonra 1x
  feed(w, { fromMs: 0, toMs: 59000, speedAt: (t) => (t < 30000 ? 5 : 1) });
  assert.deepEqual(w.status(59000), { state: 'warming', average: null });
  feed(w, { fromMs: 59500, toMs: 61000, speedAt: () => 1, startFrame: 24 * (30 * 5 + 29.5) });
  const s = w.status(61000);
  assert.equal(s.state, 'ok');
  assert.ok(Math.abs(s.average - 1) < 0.01, `sıçrama pencereye girdi: ${s.average}`);
});

test('pencere kayar: yavaşlama 30 sn içinde ortalamayı eşiğin altına indirir → slow', () => {
  const w = new SpeedWindow({ fps: 24 });
  const f = feed(w, { fromMs: 0, toMs: 90000, speedAt: () => 1 });
  feed(w, { fromMs: 90500, toMs: 125000, speedAt: () => 0.8, startFrame: f });
  const s = w.status(125000);
  assert.equal(s.state, 'slow');
  assert.ok(Math.abs(s.average - 0.8) < 0.02, String(s.average));
});

test('sessiz arıza belirtisi: hız 1.1\'in üstüne çıkarsa fast', () => {
  const w = new SpeedWindow({ fps: 24 });
  feed(w, { fromMs: 0, toMs: 70000, speedAt: (t) => (t < 30000 ? 1 : 3) });
  assert.equal(w.status(70000).state, 'fast');
});

test('ham speed= ortalamasının aksine: saatler sonraki yavaşlama da görünür', () => {
  const w = new SpeedWindow({ fps: 24 });
  const f = feed(w, { fromMs: 0, toMs: 3 * 3600 * 1000, speedAt: () => 1 }); // 3 saat sağlam
  const end = 3 * 3600 * 1000 + 40000;
  feed(w, { fromMs: 3 * 3600 * 1000 + 500, toMs: end, speedAt: () => 0.9, startFrame: f });
  assert.equal(w.status(end).state, 'slow'); // süreç başından ortalama hâlâ ~0.999 olurdu
});

test('reset: yeni süreçte frame 0\'dan başlar, önceki örnekler silinir, yine ısınma', () => {
  const w = new SpeedWindow({ fps: 24 });
  feed(w, { fromMs: 0, toMs: 70000, speedAt: () => 1 });
  w.reset(71000);
  w.add(0, 71000);
  w.add(12, 71500); // geriye giden frame sorun değil — reset sonrası önceki yok
  assert.deepEqual(w.status(72000), { state: 'warming', average: null });
  assert.equal(w.samples.length, 0);
});

test('geçersiz fps reddedilir', () => {
  assert.throws(() => new SpeedWindow({ fps: 0 }), /fps/);
});
