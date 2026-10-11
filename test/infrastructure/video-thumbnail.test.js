const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureThumbnail, buildThumbnailArgs, hashOf } = require('../../src/infrastructure/video-thumbnail');

function fakeLog() {
  const lines = [];
  return { lines, warn: (m) => lines.push(m), info() {} };
}

// Gerçek süreç açmadan sahte bir ffmpeg child'ı (ffmpeg-encoder.test.js ile aynı desen).
// onSuccess: dönülen args'taki ÇIKTI yoluna (son eleman) boş bir dosya yazar — gerçek
// ffmpeg'in "dosyayı ürettim" halini simüle eder.
function fakeSpawn({ exitCode = 0, writeOutput = true } = {}) {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (writeOutput && exitCode === 0) fs.writeFileSync(args[args.length - 1], '');
      child.emit('close', exitCode);
    });
    return child;
  };
}

function withTmp(fn) {
  // fn ASENKRON — finally'nin dizini fn tamamlanmadan silmemesi için await ŞART (aksi
  // halde setImmediate ile gelen gecikmeli dosya yazımı "klasör zaten silindi" ile
  // ENOENT verirdi).
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-thumb-'));
    try {
      return await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('buildThumbnailArgs: video için -ss ve -frames:v var', () => {
  const args = buildThumbnailArgs('/x/clip.mp4', '/out/x.jpg');
  assert.ok(args.includes('-ss'));
  assert.ok(args.includes('-frames:v'));
  assert.ok(args.includes('/x/clip.mp4'));
  assert.ok(args.includes('/out/x.jpg'));
});

test('buildThumbnailArgs: görselde -ss/-frames:v YOK (tek kareli girişte 0 kare üretirdi)', () => {
  const args = buildThumbnailArgs('/x/kapak.jpg', '/out/x.jpg');
  assert.ok(!args.includes('-ss'));
  assert.ok(!args.includes('-frames:v'));
});

test('hashOf: aynı yol aynı hash, farklı yol farklı hash', () => {
  assert.equal(hashOf('/a/b.mp4'), hashOf('/a/b.mp4'));
  assert.notEqual(hashOf('/a/b.mp4'), hashOf('/c/b.mp4'));
});

test('ensureThumbnail: kaynak yoksa null, ffmpeg hiç çağrılmaz', withTmp(async (dir) => {
  const log = fakeLog();
  const result = await ensureThumbnail({ sourcePath: path.join(dir, 'yok.mp4'), runtimeDir: dir, log });
  assert.equal(result, null);
}));

test('ensureThumbnail: ffmpeg başarısız olursa null döner, yayın/sayfa kırılmaz', withTmp(async (dir) => {
  const src = path.join(dir, 'kaynak.mp4');
  fs.writeFileSync(src, 'sahte video');
  const log = fakeLog();
  const result = await ensureThumbnail({
    sourcePath: src, runtimeDir: dir, spawnFn: fakeSpawn({ exitCode: 1, writeOutput: false }), log,
  });
  assert.equal(result, null);
  assert.ok(log.lines.some((l) => /önizleme üretilemedi/.test(l)));
}));

test('ensureThumbnail: başarılı üretimde meta dosyası yazılır, aynı kaynakla ikinci çağrı ffmpeg\'i YENİDEN ÇALIŞTIRMAZ', withTmp(async (dir) => {
  const src = path.join(dir, 'kaynak.mp4');
  fs.writeFileSync(src, 'sahte video');
  const log = fakeLog();
  let spawnCount = 0;
  const countingSpawn = (...args) => { spawnCount += 1; return fakeSpawn()(...args); };

  const first = await ensureThumbnail({ sourcePath: src, runtimeDir: dir, spawnFn: countingSpawn, log });
  assert.ok(first, 'üretim başarılı olmalı');
  assert.ok(fs.existsSync(first));
  assert.equal(spawnCount, 1);
  const mtimeAfterFirst = fs.statSync(first).mtimeMs;

  // İkinci çağrı: kaynak değişmedi → ffmpeg HİÇ çağrılmamalı, dosya aynen kalmalı.
  await new Promise((r) => { setTimeout(r, 10); });
  const second = await ensureThumbnail({ sourcePath: src, runtimeDir: dir, spawnFn: countingSpawn, log });
  assert.equal(second, first);
  assert.equal(spawnCount, 1, 'önbellek isabetinde ffmpeg tekrar çağrılmamalı');
  assert.equal(fs.statSync(second).mtimeMs, mtimeAfterFirst);
}));

test('önizlemeler sırayla üretilir: aynı anda en fazla bir ffmpeg', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { EventEmitter } = require('node:events');
  const { ensureThumbnail } = require('../../src/infrastructure/video-thumbnail');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-thq-'));
  const sources = [1, 2, 3, 4].map((n) => {
    const f = path.join(dir, `k${n}.mp4`);
    fs.writeFileSync(f, String(n));
    return f;
  });
  let running = 0;
  let maxRunning = 0;
  const spawnFn = (_cmd, args) => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => {
      fs.writeFileSync(args[args.length - 1], 'jpg');
      running -= 1;
      child.emit('close', 0);
    }, 15);
    return child;
  };
  const log = { warn() {} };
  const results = await Promise.all(sources.map((sourcePath) => ensureThumbnail({
    sourcePath, runtimeDir: dir, spawnFn, log,
  })));
  assert.equal(maxRunning, 1);
  assert.ok(results.every(Boolean));
});

test('aynı dosya için eşzamanlı istekler tek ffmpeg çalıştırır', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { EventEmitter } = require('node:events');
  const { ensureThumbnail } = require('../../src/infrastructure/video-thumbnail');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-thq2-'));
  const src = path.join(dir, 'k.mp4');
  fs.writeFileSync(src, 'x');
  let spawns = 0;
  const spawnFn = (_cmd, args) => {
    spawns += 1;
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => { fs.writeFileSync(args[args.length - 1], 'jpg'); child.emit('close', 0); }, 10);
    return child;
  };
  await Promise.all([1, 2, 3].map(() => ensureThumbnail({ sourcePath: src, runtimeDir: dir, spawnFn, log: { warn() {} } })));
  assert.equal(spawns, 1);
});
