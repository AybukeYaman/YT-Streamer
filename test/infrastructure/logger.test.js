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
