// HealthMonitor testleri: ağ yok, gerçek zamanlayıcı yok. tick() elle çağrılır.
const test = require('node:test');
const assert = require('node:assert/strict');

const { HealthMonitor } = require('../../src/application/health-monitor');

function fakeLog() {
  const lines = [];
  const rec = (level) => (m) => lines.push({ level, m });
  return { lines, log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') } };
}

// results: tick başına sırayla dönecek sonuç (son değer tekrar eder).
// Error örneği verilirse o turda fırlatılır.
function fakeCheck(name, results) {
  const queue = [...results];
  return {
    name,
    run: async () => {
      const r = queue.length > 1 ? queue.shift() : queue[0];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

function fakeAlerter() {
  const sent = [];
  return { sent, alert: async (payload) => { sent.push(payload); } };
}

const UNHEALTHY = { status: 'unhealthy', message: 'YAYIN ÖLÜ: veri akmıyor' };
const HEALTHY = { status: 'healthy', message: 'ingest active/good' };

function setup(checks, options = {}) {
  const { log, lines } = fakeLog();
  const alerter = options.alerter ?? fakeAlerter();
  const monitor = new HealthMonitor({ checks, log, alerter, unhealthyThreshold: 3, ...options });
  return { monitor, lines, alerter };
}

test('kontrol listesi boş olamaz (sessizce hiçbir şey izlemeyen monitör olmasın)', () => {
  const { log } = fakeLog();
  assert.throws(() => new HealthMonitor({ checks: [], log }), /en az bir kontrol/);
});

test('eşik altındaki sağlıksız örnekler uyarı verir, bildirim göndermez', async () => {
  const { monitor, lines, alerter } = setup([fakeCheck('ingest', [UNHEALTHY])]);

  await monitor.tick();
  await monitor.tick();
  assert.ok(!lines.some((l) => l.level === 'error'));
  assert.deepEqual(alerter.sent, []);
  assert.ok(/1\/3/.test(lines[0].m) && /2\/3/.test(lines[1].m));
});

test('eşiğe ulaşınca error + BİR bildirim; sonraki turlar yalnızca warn', async () => {
  const { monitor, lines, alerter } = setup([fakeCheck('ingest', [UNHEALTHY])], { intervalMs: 60000 });

  await monitor.tick();
  await monitor.tick();
  await monitor.tick();
  assert.equal(lines.filter((l) => l.level === 'error').length, 1);
  assert.equal(alerter.sent.length, 1);
  assert.equal(alerter.sent[0].level, 'error');
  assert.match(alerter.sent[0].title, /ingest/);
  assert.match(alerter.sent[0].message, /~3 dk/); // 3 örnek × 60 sn

  await monitor.tick();
  await monitor.tick();
  assert.equal(lines.filter((l) => l.level === 'error').length, 1, 'error tekrarlanmamalı');
  assert.equal(alerter.sent.length, 1, 'her turda bildirim gitmemeli');
});

test('toparlanınca "düzeldi" bildirimi gider ve sayaç sıfırlanır', async () => {
  const { monitor, alerter } = setup([fakeCheck('encoder', [UNHEALTHY, UNHEALTHY, UNHEALTHY, HEALTHY])]);

  await monitor.tick();
  await monitor.tick();
  await monitor.tick(); // eşik → error bildirimi
  await monitor.tick(); // sağlıklı → düzeldi bildirimi
  assert.equal(alerter.sent.length, 2);
  assert.equal(alerter.sent[1].level, 'info');
  assert.match(alerter.sent[1].title, /düzeldi/);
  assert.equal(monitor.snapshot().encoder.consecutiveUnhealthy, 0);
  assert.equal(monitor.snapshot().encoder.alerted, false);
});

test('toparlanma alarm verilmeden olursa bildirim gönderilmez', async () => {
  const { monitor, alerter } = setup([fakeCheck('ingest', [UNHEALTHY, HEALTHY])]);

  await monitor.tick();
  await monitor.tick();
  assert.deepEqual(alerter.sent, []);
});

// Kontrolün hatası (ağ, kota, dosya) sağlıksızlık KANITI DEĞİL.
test('kontrol fırlatırsa sayaç artmaz', async () => {
  const { monitor, lines, alerter } = setup([
    fakeCheck('ingest', [new Error('503 backend error'), UNHEALTHY, UNHEALTHY]),
  ]);

  await monitor.tick();
  await monitor.tick();
  await monitor.tick();
  assert.ok(!lines.some((l) => l.level === 'error'));
  assert.deepEqual(alerter.sent, []);
  assert.ok(lines.some((l) => /okunamadı/.test(l.m)));
});

test('skipped sayacı sıfırlar (yayın kapalıyken birikmesin)', async () => {
  const { monitor, lines } = setup([
    fakeCheck('encoder', [UNHEALTHY, UNHEALTHY, { status: 'skipped', message: 'yayın hiç başlamamış' }, UNHEALTHY]),
  ]);

  await monitor.tick();
  await monitor.tick();
  await monitor.tick();
  await monitor.tick();
  assert.ok(!lines.some((l) => l.level === 'error'));
});

test('kontroller birbirinden bağımsız sayılır', async () => {
  const { monitor, alerter } = setup([
    fakeCheck('ingest', [UNHEALTHY]),
    fakeCheck('encoder', [HEALTHY]),
  ]);

  await monitor.tick();
  await monitor.tick();
  await monitor.tick();
  assert.equal(alerter.sent.length, 1);
  assert.match(alerter.sent[0].title, /ingest/);
  const snap = monitor.snapshot();
  assert.equal(snap.ingest.consecutiveUnhealthy, 3);
  assert.equal(snap.encoder.consecutiveUnhealthy, 0);
});

// ÖLÜ ADAM ANAHTARI: ping yalnızca her şey yolundayken atılır; sağlıksızlıkta susar ve
// dış servis (healthchecks.io) alarm verir.
test('ping sağlıklı turda atılır, sağlıksız turda atılmaz', async () => {
  let pings = 0;
  const { monitor } = setup([fakeCheck('ingest', [HEALTHY, UNHEALTHY])], {
    pingAlive: async () => { pings += 1; },
  });

  await monitor.tick();
  assert.equal(pings, 1);
  await monitor.tick();
  assert.equal(pings, 1, 'sağlıksız turda ping susmalı');
});

test('skipped turda ping atılır (yayın bilerek kapalıysa dış alarm çalmasın)', async () => {
  let pings = 0;
  const { monitor } = setup([fakeCheck('encoder', [{ status: 'skipped', message: 'yok' }])], {
    pingAlive: async () => { pings += 1; },
  });

  await monitor.tick();
  assert.equal(pings, 1);
});

// Bildirim/ping kanalı bozuksa izleme DURMAMALI.
test('alerter fırlatırsa tur düşmez', async () => {
  const alerter = { alert: async () => { throw new Error('ntfy 500'); } };
  const { monitor, lines } = setup([fakeCheck('ingest', [UNHEALTHY])], { alerter });

  await monitor.tick();
  await monitor.tick();
  await monitor.tick();
  assert.ok(lines.some((l) => /bildirim gönderilemedi/.test(l.m)));
});

test('pingAlive fırlatırsa tur düşmez', async () => {
  const { monitor, lines } = setup([fakeCheck('ingest', [HEALTHY])], {
    pingAlive: async () => { throw new Error('ağ yok'); },
  });

  await monitor.tick();
  assert.ok(lines.some((l) => /ping/.test(l.m)));
});

// Zamanlayıcı: setInterval değil setTimeout zinciri.
test('start/stop: zincir kurulur, stop sonrası yeni zamanlayıcı kurulmaz', async () => {
  const timers = [];
  const setTimeoutFn = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; };
  const { monitor } = setup([fakeCheck('ingest', [HEALTHY])], { intervalMs: 60000, setTimeoutFn, clearTimeoutFn: () => {} });

  monitor.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60000);
  assert.equal(monitor.running, true);

  await timers[0].fn();
  assert.equal(timers.length, 2);

  monitor.stop();
  await timers[1].fn();
  assert.equal(timers.length, 2, 'stop sonrası yeni zamanlayıcı kurulmamalı');
  assert.equal(monitor.running, false);
});

test('start iki kez çağrılırsa ikinci çağrı yoksayılır', () => {
  const timers = [];
  const setTimeoutFn = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; };
  const { monitor } = setup([fakeCheck('ingest', [HEALTHY])], { setTimeoutFn });

  monitor.start();
  monitor.start();
  assert.equal(timers.length, 1);
});

test('bildirim kanalı yoksa uyarı loglanır ve tur çalışır', async () => {
  const { log, lines } = fakeLog();
  const monitor = new HealthMonitor({
    checks: [fakeCheck('ingest', [UNHEALTHY])], log, unhealthyThreshold: 1, setTimeoutFn: () => ({ unref() {} }),
  });
  monitor.start();
  await monitor.tick();
  assert.ok(lines.some((l) => /bildirim kanalı yok/.test(l.m)));
  assert.ok(lines.some((l) => l.level === 'error'));
});
