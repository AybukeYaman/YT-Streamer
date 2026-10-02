// file-stat testleri: gerçek dosya sistemi (küçük, geçici dizinde).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readMtimeMs, fileExists } = require('../../src/infrastructure/file-stat');

function tempFile(name = 'state.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-stat-'));
  const file = path.join(dir, name);
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('readMtimeMs: var olan dosyanın mtime’ı sayı döner', () => {
  const { file, cleanup } = tempFile();
  fs.writeFileSync(file, '{}');
  const before = Date.now();
  const mtime = readMtimeMs(file);
  assert.equal(typeof mtime, 'number');
  assert.ok(Math.abs(mtime - before) < 10_000);
  cleanup();
});

// "Hiç yayın yapılmamış" ile "okuma hatası" ayrı şeyler: ilki null, ikincisi fırlatır.
test('readMtimeMs: dosya yoksa null (alarm değil)', () => {
  const { file, cleanup } = tempFile();
  assert.equal(readMtimeMs(file), null);
  cleanup();
});

test('fileExists: park işareti var/yok', () => {
  const { file, cleanup } = tempFile('.env.stream2.disabled');
  assert.equal(fileExists(file), false);
  fs.writeFileSync(file, '');
  assert.equal(fileExists(file), true);
  cleanup();
});

test('fileExists: okunamayan yol için fırlatmaz, false döner', () => {
  assert.equal(fileExists(path.join(os.tmpdir(), 'olmayan-dizin-xyz', 'a', 'b')), false);
});
