const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Logger } = require('../../src/infrastructure/logger');

// Her test kendi geçici dizininde çalışır; mkdtemp dolu, benzersiz bir yol garanti eder.
function withTempDir(fn) {
  return () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-logger-test-'));
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function fakeConsole() {
  const lines = { log: [], error: [] };
  return { out: { log: (l) => lines.log.push(l), error: (l) => lines.error.push(l) }, lines };
}

const fixedNow = (iso) => () => new Date(iso);

test('dosya adı tarih damgalı, satır biçimi zaman + düzey + kapsam', withTempDir((dir) => {
  const { out } = fakeConsole();
  const log = new Logger({ dir, out, now: fixedNow('2026-09-24T14:05:09.007') });
  log.info('merhaba');
  const file = path.join(dir, 'stream-2026-09-24.log');
  assert.equal(fs.readFileSync(file, 'utf8'), '2026-09-24 14:05:09.007 [INFO] [main] merhaba\n');
}));

test('debug sadece dosyaya, info konsola da; warn/error konsolun hata akışına', withTempDir((dir) => {
  const { out, lines } = fakeConsole();
  const log = new Logger({ dir, out, now: fixedNow('2026-09-24T10:00:00') });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.equal(lines.log.length, 1);
  assert.match(lines.log[0], /\[INFO\] \[main\] i$/);
  assert.deepEqual(lines.error.map((l) => l.split('] ').at(-1)), ['w', 'e']);
  const fileLines = fs.readFileSync(path.join(dir, 'stream-2026-09-24.log'), 'utf8').trim().split('\n');
  assert.deepEqual(fileLines.map((l) => l.match(/\[(\w+)\]/)[1]), ['DEBUG', 'INFO', 'WARN', 'ERROR']);
}));

test('child aynı dosyaya kendi kapsamıyla yazar', withTempDir((dir) => {
  const { out } = fakeConsole();
  const log = new Logger({ dir, out, now: fixedNow('2026-09-24T10:00:00') });
  log.child('encoder').info('x');
  log.info('y');
  const text = fs.readFileSync(path.join(dir, 'stream-2026-09-24.log'), 'utf8');
  assert.match(text, /\[encoder\] x\n.*\[main\] y\n/);
}));

test('gece yarısı yeni tarihli dosyaya geçer', withTempDir((dir) => {
  const { out } = fakeConsole();
  let t = new Date('2026-09-24T23:59:59.900');
  const log = new Logger({ dir, out, now: () => t });
  log.info('gün 1');
  t = new Date('2026-09-25T00:00:00.100');
  log.info('gün 2');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['stream-2026-09-24.log', 'stream-2026-09-25.log']);
}));

test('log dizini yoksa oluşturulur', withTempDir((dir) => {
  const { out } = fakeConsole();
  const nested = path.join(dir, 'runtime', 'logs');
  new Logger({ dir: nested, out }).info('x');
  assert.equal(fs.readdirSync(nested).length, 1);
}));

// "2026-09-24 10:00:00.000 [INFO] [main] " = 38 bayt önek; mesaj + \n ile satır uzunluğu ayarlanır.
const lineOf = (n) => 'x'.repeat(n - 39);
const sizes = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.statSync(path.join(dir, f)).size]));

test('rotasyon: eşiği aşacak satırda dosya .1\'e döner, yeni satır boş dosyaya gider', withTempDir((dir) => {
  const { out } = fakeConsole();
  const log = new Logger({ dir, out, now: fixedNow('2026-09-24T10:00:00'), maxBytes: 250 });
  log.info(lineOf(100));
  log.info(lineOf(100)); // 200 ≤ 250
  log.info(lineOf(100)); // 300 > 250 → döndür
  assert.deepEqual(sizes(dir), { 'stream-2026-09-24.1.log': 200, 'stream-2026-09-24.log': 100 });
}));

test('rotasyon: eski numaralar kayar (.1 → .2), en yeni içerik ana dosyada', withTempDir((dir) => {
  const { out } = fakeConsole();
  const log = new Logger({ dir, out, now: fixedNow('2026-09-24T10:00:00'), maxBytes: 150 });
  for (const tag of ['a', 'b', 'c']) log.info(`${tag}${lineOf(99)}`);
  const first = (f) => fs.readFileSync(path.join(dir, f), 'utf8').split('] ')[2][0];
  assert.deepEqual(['stream-2026-09-24.log', 'stream-2026-09-24.1.log', 'stream-2026-09-24.2.log'].map(first), ['c', 'b', 'a']);
}));

test('saklama: en fazla maxFiles dosya — en eski numaralı dosya silinir', withTempDir((dir) => {
  const { out } = fakeConsole();
  const log = new Logger({ dir, out, now: fixedNow('2026-09-24T10:00:00'), maxBytes: 150, maxFiles: 3 });
  for (let i = 0; i < 6; i++) log.info(lineOf(100));
  assert.deepEqual(Object.keys(sizes(dir)), ['stream-2026-09-24.1.log', 'stream-2026-09-24.2.log', 'stream-2026-09-24.log']);
}));

test('saklama: günlük dosyalar da sayılır, yeni gün başlarken en eski günler silinir', withTempDir((dir) => {
  const { out } = fakeConsole();
  for (const d of ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']) fs.writeFileSync(path.join(dir, `stream-${d}.log`), 'eski\n');
  fs.writeFileSync(path.join(dir, 'stream-2026-09-22.1.log'), 'eski\n');
  fs.writeFileSync(path.join(dir, 'baska.txt'), 'dokunma\n');
  new Logger({ dir, out, now: fixedNow('2026-09-24T10:00:00'), maxFiles: 3 }).info('yeni gün');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['baska.txt', 'stream-2026-09-22.log', 'stream-2026-09-23.log', 'stream-2026-09-24.log']);
}));

test('rotasyon: önceki çalıştırmadan kalan dosyanın boyutu hesaba katılır', withTempDir((dir) => {
  const { out } = fakeConsole();
  fs.writeFileSync(path.join(dir, 'stream-2026-09-24.log'), 'x'.repeat(200));
  new Logger({ dir, out, now: fixedNow('2026-09-24T10:00:00'), maxBytes: 250 }).info(lineOf(100));
  assert.deepEqual(sizes(dir), { 'stream-2026-09-24.1.log': 200, 'stream-2026-09-24.log': 100 });
}));

test('rotasyon: eşikten büyük tek satır boş dosyaya yine de yazılır (sonsuz döndürme yok)', withTempDir((dir) => {
  const { out } = fakeConsole();
  new Logger({ dir, out, now: fixedNow('2026-09-24T10:00:00'), maxBytes: 50 }).info(lineOf(100));
  assert.deepEqual(sizes(dir), { 'stream-2026-09-24.log': 100 });
}));

test('varsayılan eşikler 50 MB ve 5 dosya', withTempDir((dir) => {
  const log = new Logger({ dir, out: fakeConsole().out });
  assert.equal(log.sink.maxBytes, 50 * 1024 * 1024);
  assert.equal(log.sink.maxFiles, 5);
}));

test('dosya yazılamazsa bir kez uyarır, konsola devam eder, child da paylaşır', withTempDir((dir) => {
  const { out, lines } = fakeConsole();
  const log = new Logger({ dir, out, now: fixedNow('2026-09-24T10:00:00') });
  // Log dosyasının yerine aynı adda bir dizin koy → appendFileSync EISDIR ile düşer.
  fs.mkdirSync(path.join(dir, 'stream-2026-09-24.log'));
  log.info('a');
  log.child('encoder').info('b');
  log.info('c');
  assert.equal(lines.error.filter((l) => /log dosyasına yazılamıyor/.test(l)).length, 1);
  assert.equal(lines.log.length, 3);
}));
