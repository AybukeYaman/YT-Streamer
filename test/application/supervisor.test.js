const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { Supervisor } = require('../../src/application/supervisor');

// Sahte orchestrator: çağrıları sayar, çökmeyi test tetikler (crash()).
class FakeOrchestrator extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.failResume = 0;
  }
  async start() { this.calls.push('start'); }
  async resume() {
    this.calls.push('resume');
    if (this.failResume-- > 0) throw new Error('playlist yazılamadı');
  }
  async stop() { this.calls.push('stop'); }
  crash(code = 1) { this.emit('exit', { expected: false, code, signal: null }); }
}

// Sahte zaman: setTimer zamanlayıcıları kaydeder, advance() süresi dolanları çalıştırır.
function fakeClock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    pending: () => timers.map((h) => h.at - t),
    async advance(ms) {
      t += ms;
      for (const h of timers.filter((x) => x.at <= t)) {
        timers.splice(timers.indexOf(h), 1);
        await h.fn();
      }
    },
  };
}

// Sahte alerter: gönderilen bildirimleri kaydeder. failNext ile bir kez hata atar
// (bozuk bildirim kanalının gözetmeni etkilemediğini sınamak için).
function fakeAlerter() {
  const sent = [];
  return {
    sent,
    failNext: 0,
    async alert(payload) {
      sent.push(payload);
      if (this.failNext-- > 0) throw new Error('webhook 500');
    },
  };
}

function setup(opts = {}) {
  const orch = new FakeOrchestrator();
  const clock = fakeClock();
  const lines = [];
  const alerter = fakeAlerter();
  const rec = (level) => (m) => lines.push({ level, m });
  const sup = new Supervisor({
    orchestrator: orch, log: { info: rec('info'), warn: rec('warn'), error: rec('error') },
    alerter,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...opts,
  });
  return { orch, clock, lines, alerter, sup };
}

test('üstel geri çekilme: 3 → 6 → 12 → 24 → 48 → 60 sn tavan (crash loop kapalıyken)', async () => {
  const { orch, clock, sup } = setup({ maxCrashes: Infinity });
  await sup.start();
  const delays = [];
  for (let i = 0; i < 8; i++) {
    await clock.advance(1000); // her denemede 1 sn çalışıp düşüyor
    orch.crash();
    delays.push(clock.pending()[0]);
    await clock.advance(clock.pending()[0]);
  }
  assert.deepEqual(delays, [3000, 6000, 12000, 24000, 48000, 60000, 60000, 60000]);
  assert.equal(orch.calls.filter((c) => c === 'resume').length, 8);
});

test('yeterince uzun (5 dk) çökmeden çalışınca sayaç sıfırlanır', async () => {
  const { orch, clock, sup, lines } = setup();
  await sup.start();
  orch.crash();
  await clock.advance(3000);
  orch.crash();
  assert.deepEqual(clock.pending(), [6000]);
  await clock.advance(6000); // yeniden başladı
  await clock.advance(5 * 60 * 1000); // 5 dk sağlam
  orch.crash();
  assert.deepEqual(clock.pending(), [3000]);
  assert.ok(lines.some((l) => l.level === 'warn' && /3 sn sonra yeniden başlatılacak \(deneme 1/.test(l.m)));
});

// Bildirim bilerek await edilmiyor (çökme anında webhook backoff'u geciktirmesin),
// bu yüzden kontrolden önce mikro görev kuyruğu boşaltılır.
const flush = () => new Promise((r) => setImmediate(r));

// Eşiğe kadar çökertir (maxCrashes kadar çökme), son çökmeden sonra yeniden başlatır.
async function pushIntoCrashLoop({ orch, clock }) {
  for (let i = 0; i < 4; i++) {
    orch.crash();
    await clock.advance(clock.pending()[0]);
  }
  orch.crash(); // 5. çökme (3+6+12+24 = 45 sn içinde)
  await flush();
}

test('tekrarlayan çökme: 5 dk içinde 5 çökme → alarm verir AMA yeniden başlatmaya devam eder', async () => {
  const { orch, clock, sup, lines, alerter } = setup();
  const events = [];
  sup.on('crash-loop', (e) => events.push(e));
  await sup.start();
  await pushIntoCrashLoop({ orch, clock });

  assert.equal(sup.crashLoop, true);
  assert.deepEqual(events, [{ crashes: 5 }]);
  assert.ok(lines.some((l) => l.level === 'error' && /TEKRARLAYAN ÇÖKME: 300 sn içinde 5 çökme/.test(l.m)));
  // Kritik fark: vazgeçmek yerine sıradaki gecikmeyle (48 sn) yeniden başlatma kuruldu.
  assert.deepEqual(clock.pending(), [48000]);
  await clock.advance(48000);
  assert.equal(orch.calls.filter((c) => c === 'resume').length, 5);
  assert.equal(alerter.sent.length, 1);
  assert.equal(alerter.sent[0].level, 'error');
  assert.match(alerter.sent[0].title, /tekrarlayan çökme/);
});

test('tekrarlayan çökme sürerken alarm TEKRARLANMAZ, yeniden başlatma yine sürer', async () => {
  const { orch, clock, sup, lines, alerter } = setup();
  await sup.start();
  await pushIntoCrashLoop({ orch, clock });
  await clock.advance(clock.pending()[0]);

  for (let i = 0; i < 2; i++) {
    orch.crash();
    await flush();
    assert.equal(clock.pending().length, 1); // her çökmede yine yeniden başlatma kuruldu
    await clock.advance(clock.pending()[0]);
  }
  assert.equal(alerter.sent.length, 1); // 6. ve 7. çökme bildirim ÜRETMEDİ
  assert.ok(lines.some((l) => l.level === 'warn' && /alarm tekrarlanmıyor/.test(l.m)));
  assert.equal(orch.calls.filter((c) => c === 'resume').length, 7);
});

test('5 dk çökmeden çalışınca durum temizlenir ve "düzeldi" bildirimi gider', async () => {
  const { orch, clock, sup, lines, alerter } = setup();
  await sup.start();
  await pushIntoCrashLoop({ orch, clock });
  await clock.advance(clock.pending()[0]); // yeniden başladı → toparlanma kontrolü kuruldu

  assert.deepEqual(clock.pending(), [5 * 60 * 1000]);
  await clock.advance(5 * 60 * 1000);
  await flush();

  assert.equal(sup.crashLoop, false);
  assert.equal(sup.attempt, 0);
  assert.equal(alerter.sent.length, 2);
  assert.equal(alerter.sent[1].level, 'info');
  assert.ok(lines.some((l) => l.level === 'info' && /tekrarlayan çökme bitti/.test(l.m)));
  // Temizlendikten sonra sayaç sıfırdan: sonraki çökme yine 3 sn ile başlar.
  orch.crash();
  assert.deepEqual(clock.pending(), [3000]);
});

test('toparlanma beklenirken gelen yeni çökme kontrolü iptal eder (düzeldi denmez)', async () => {
  const { orch, clock, sup, alerter } = setup();
  await sup.start();
  await pushIntoCrashLoop({ orch, clock });
  await clock.advance(clock.pending()[0]);
  assert.deepEqual(clock.pending(), [5 * 60 * 1000]);

  orch.crash(); // toparlanma dolmadan yeni çökme
  await flush();
  assert.deepEqual(clock.pending(), [60000]); // yalnızca yeniden başlatma timer'ı kaldı
  await clock.advance(10 * 60 * 1000);
  assert.equal(sup.crashLoop, true);
  assert.ok(!alerter.sent.some((a) => a.level === 'info'));
});

test('stop: bekleyen toparlanma kontrolünü de iptal eder', async () => {
  const { orch, clock, sup, alerter } = setup();
  await sup.start();
  await pushIntoCrashLoop({ orch, clock });
  await clock.advance(clock.pending()[0]);

  await sup.stop();
  assert.deepEqual(clock.pending(), []);
  await clock.advance(10 * 60 * 1000);
  assert.ok(!alerter.sent.some((a) => a.level === 'info'));
});

test('bozuk bildirim kanalı yeniden başlatmayı etkilemez', async () => {
  const { orch, clock, sup, lines, alerter } = setup();
  alerter.failNext = 1;
  await sup.start();
  await pushIntoCrashLoop({ orch, clock });
  await clock.advance(clock.pending()[0]);

  assert.equal(orch.calls.filter((c) => c === 'resume').length, 5);
  assert.ok(lines.some((l) => l.level === 'warn' && /bildirim gönderilemedi \(webhook 500\)/.test(l.m)));
});

test('tekrarlayan çökme penceresi kayar: 5 dk\'dan eski çökmeler sayılmaz', async () => {
  const { orch, clock, sup, lines } = setup();
  await sup.start();
  for (let i = 0; i < 4; i++) {
    orch.crash();
    await clock.advance(clock.pending()[0]);
    await clock.advance(80 * 1000); // aralarda 80 sn çalışıyor
  }
  orch.crash(); // ilk çökme artık 5 dk'dan eski → pencerede 4
  assert.equal(sup.crashLoop, false);
  assert.equal(clock.pending().length, 1);
  assert.ok(lines.some((l) => /4\/5 çökme/.test(l.m)));
});

test('beklenen çıkış (stop) ya da durdurulurken gelen çıkış yeniden başlatılmaz', async () => {
  const { orch, clock, sup } = setup();
  await sup.start();
  orch.emit('exit', { expected: true, code: 0, signal: null });
  assert.deepEqual(clock.pending(), []);
  await sup.stop();
  orch.crash();
  assert.deepEqual(clock.pending(), []);
});

test('stop: bekleyen yeniden başlatmayı iptal eder', async () => {
  const { orch, clock, sup, lines } = setup();
  await sup.start();
  orch.crash();
  assert.equal(clock.pending().length, 1);
  await sup.stop();
  assert.deepEqual(clock.pending(), []);
  await clock.advance(10000);
  assert.deepEqual(orch.calls, ['start', 'stop']);
  assert.ok(lines.some((l) => l.m === 'bekleyen yeniden başlatma iptal edildi'));
});

test('yeniden başlatma da düşerse aynı çökme mantığından geçer (sonraki gecikme)', async () => {
  const { orch, clock, sup, lines } = setup();
  await sup.start();
  orch.failResume = 1;
  orch.crash();
  await clock.advance(3000); // resume düşer
  assert.ok(lines.some((l) => l.level === 'error' && /yeniden başlatılamadı: playlist yazılamadı/.test(l.m)));
  assert.deepEqual(clock.pending(), [6000]);
});
