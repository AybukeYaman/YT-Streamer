const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DurationCache } = require('../../src/infrastructure/duration-cache');

function fakeLog() {
  const lines = [];
  const rec = (level) => (m) => lines.push({ level, m });
  return { log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }, lines };
}

// Gerçek dosyalarla çalışır: geçerlilik boyut+mtime'a bakıyor, sahte fs ile sınanamaz.
function withFiles(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-durcache-'));
    try {
      const track = path.join(dir, 'a.m4a');
      fs.writeFileSync(track, 'ses');
      const { log, lines } = fakeLog();
      const make = (overrides = {}) => new DurationCache({
        file: path.join(dir, 'durations.json'),
        writeFile: (p, c) => fs.writeFileSync(p, c),
        log,
        flushDelayMs: 0,
        ...overrides,
      });
      await fn({ dir, track, make, lines, cacheFile: path.join(dir, 'durations.json') });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('ilk ölçüm yapılır, ikincisi önbellekten gelir', withFiles(async ({ track, make }) => {
  let probes = 0;
  const cache = make();
  const probe = cache.wrap(async () => { probes++; return 180; });

  assert.equal(await probe(track), 180);
  assert.equal(await probe(track), 180);
  assert.equal(probes, 1, 'ikinci çağrı ffprobe çalıştırmamalı');
  assert.equal(cache.hits, 1);
  assert.equal(cache.misses, 1);
}));

test('yeni süreç diskteki önbellekten okur — ffprobe hiç çalışmaz', withFiles(async ({ track, make }) => {
  const first = make();
  await first.wrap(async () => 123)(track);
  first.flush();

  let probes = 0;
  const second = make();
  assert.equal(await second.wrap(async () => { probes++; return 999; })(track), 123);
  assert.equal(probes, 0);
}));

test('dosya değişirse (mtime/boyut) yeniden ölçülür — eskimiş süre riski yok', withFiles(async ({ track, make }) => {
  const cache = make();
  await cache.wrap(async () => 100)(track);
  cache.flush();

  // Dosyayı değiştir: boyut ve mtime değişir
  fs.writeFileSync(track, 'cok daha uzun ses verisi');
  let probes = 0;
  const fresh = make();
  assert.equal(await fresh.wrap(async () => { probes++; return 250; })(track), 250);
  assert.equal(probes, 1, 'değişen dosya yeniden ölçülmeli');
}));

test('bozuk önbellek dosyası yayını engellemez, boş başlanır', withFiles(async ({ track, make, cacheFile, lines }) => {
  fs.writeFileSync(cacheFile, '{bozuk');
  const cache = make();
  assert.equal(await cache.wrap(async () => 77)(track), 77);
  assert.ok(lines.some((l) => l.level === 'warn' && /okunamadı/.test(l.m)));
}));

test('önbellek dosyası yoksa uyarı verilmez (ilk çalıştırma normal)', withFiles(async ({ track, make, lines }) => {
  await make().wrap(async () => 5)(track);
  assert.equal(lines.filter((l) => l.level === 'warn').length, 0);
}));

test('yazma hatası yutulur — ölçüm yine döner', withFiles(async ({ track, make, lines }) => {
  const cache = make({ writeFile: () => { throw new Error('disk dolu'); } });
  assert.equal(await cache.wrap(async () => 42)(track), 42);
  cache.flush();
  assert.ok(lines.some((l) => /yazılamadı/.test(l.m)));
}));

test('okunamayan dosyada önbellek atlanır, hata ölçümden gelir', withFiles(async ({ dir, make }) => {
  const cache = make();
  await assert.rejects(
    cache.wrap(async () => { throw new Error('ffprobe: yok'); })(path.join(dir, 'yok.m4a')),
    /ffprobe: yok/,
  );
}));

test('özet isabet ve ölçüm sayısını bildirir', withFiles(async ({ track, make }) => {
  const cache = make();
  const probe = cache.wrap(async () => 1);
  await probe(track);
  await probe(track);
  assert.equal(cache.summary(), 'süre önbelleği: 1 isabet, 1 ölçüm');
}));
