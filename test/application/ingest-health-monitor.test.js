// IngestHealthMonitor testleri: ağ yok, gerçek zamanlayıcı yok. tick() elle çağrılır.
const test = require('node:test');
const assert = require('node:assert/strict');

const { IngestHealthMonitor } = require('../../src/application/ingest-health-monitor');

function fakeLog() {
  const lines = [];
  const rec = (level) => (m) => lines.push({ level, m });
  return { lines, log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') } };
}

// results: tick başına sırayla dönecek sonuçlar (son değer tekrar eder).
// Error örneği verilirse o tick'te fırlatılır.
function setup(results, options = {}) {
  const { log, lines } = fakeLog();
  const queue = [...results];
  const calls = [];
  const goLiveService = {
    checkIngestHealth: async () => {
      const r = queue.length > 1 ? queue.shift() : queue[0];
      calls.push(r);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const monitor = new IngestHealthMonitor({ goLiveService, log, ...options });
  return { monitor, lines, calls };
}

const UNHEALTHY = {
  skipped: false, healthy: false, broadcastId: 'hSqzx1FiX_k',
  ingest: { streamStatus: 'inactive', healthStatus: 'noData' },
};
const HEALTHY = {
  skipped: false, healthy: true, broadcastId: 'hSqzx1FiX_k',
  ingest: { streamStatus: 'active', healthStatus: 'good' },
};

// Eşiğin sebebi: her albüm geçişinde ffmpeg yeniden başlıyor, ingest kısa süre
// 'inactive' görünebilir. Tek örnekte alarm vermek yanlış alarm üretir.
test('eşik altındaki sağlıksız örnekler uyarı verir, alarm vermez', async () => {
  const { monitor, lines } = setup([UNHEALTHY], { unhealthyThreshold: 3 });

  assert.deepEqual(await monitor.tick(), { healthy: false, alerted: false });
  assert.deepEqual(await monitor.tick(), { healthy: false, alerted: false });
  assert.ok(!lines.some((l) => l.level === 'error'));
  assert.equal(lines.filter((l) => l.level === 'warn').length, 2);
  assert.ok(/1\/3/.test(lines[0].m) && /2\/3/.test(lines[1].m));
});

test('eşiğe ulaşınca error, sonraki tick warn (log seli olmaz)', async () => {
  const { monitor, lines } = setup([UNHEALTHY], { unhealthyThreshold: 3, intervalMs: 60000 });

  await monitor.tick();
  await monitor.tick();
  const third = await monitor.tick();
  assert.deepEqual(third, { healthy: false, alerted: true });
  const errors = lines.filter((l) => l.level === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].m, /YAYIN ÖLÜ/);
  assert.match(errors[0].m, /hSqzx1FiX_k/);
  assert.match(errors[0].m, /~3 dk/); // 3 örnek × 60 sn
  assert.match(errors[0].m, /systemctl restart yt-streamer/); // ne yapılacağı yazılı

  await monitor.tick();
  assert.equal(lines.filter((l) => l.level === 'error').length, 1);
  assert.ok(lines.filter((l) => l.level === 'warn').some((l) => /YAYIN ÖLÜ/.test(l.m)));
});

test('araya sağlıklı örnek girerse sayaç sıfırlanır', async () => {
  const { monitor, lines } = setup([UNHEALTHY, UNHEALTHY, HEALTHY, UNHEALTHY], { unhealthyThreshold: 3 });

  await monitor.tick();
  await monitor.tick();
  await monitor.tick(); // sağlıklı → sıfırla
  await monitor.tick(); // tekrar sağlıksız ama sayaç 1
  assert.ok(!lines.some((l) => l.level === 'error'));
  assert.ok(lines.some((l) => l.level === 'info' && /tekrar sağlıklı/.test(l.m)));
});

// API hatası "yayın ölü" KANITI DEĞİL: kota/ağ teklemesi alarm üretmemeli.
test('checkIngestHealth hata atarsa sayaç artmaz', async () => {
  const { monitor, lines } = setup([new Error('503 backend error'), UNHEALTHY, UNHEALTHY], { unhealthyThreshold: 3 });

  assert.deepEqual(await monitor.tick(), { ok: false });
  await monitor.tick();
  await monitor.tick();
  // 3 tick geçti ama yalnızca 2'si gerçek sağlıksız örnek → alarm yok.
  assert.ok(!lines.some((l) => l.level === 'error'));
  assert.ok(lines.some((l) => /okunamadı/.test(l.m)));
});

test('yayın yoksa (skipped) sayaç sıfırlanır ve alarm verilmez', async () => {
  const { monitor, lines } = setup([UNHEALTHY, UNHEALTHY, { skipped: true, reason: 'kayıtlı yayın yok' }, UNHEALTHY], {
    unhealthyThreshold: 3,
  });

  await monitor.tick();
  await monitor.tick();
  assert.deepEqual(await monitor.tick(), { skipped: true });
  await monitor.tick();
  assert.ok(!lines.some((l) => l.level === 'error'));
});

// Zamanlayıcı: setInterval değil setTimeout zinciri — yavaş bir yoklama çağrıları
// üst üste bindirmesin.
test('start/stop: zincir kurulur, stop sonrası yeni zamanlayıcı kurulmaz', async () => {
  const timers = [];
  let nextId = 1;
  const setTimeoutFn = (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms }); return { id, unref() {} }; };
  const cleared = [];
  const clearTimeoutFn = (t) => cleared.push(t.id);
  const { monitor } = setup([HEALTHY], { intervalMs: 60000, setTimeoutFn, clearTimeoutFn });

  monitor.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60000);
  assert.equal(monitor.running, true);

  // İlk tick'i tetikle: zincir bir sonrakini kurar.
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
  const { monitor } = setup([HEALTHY], { setTimeoutFn });

  monitor.start();
  monitor.start();
  assert.equal(timers.length, 1);
});
