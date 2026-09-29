const test = require('node:test');
const assert = require('node:assert/strict');

const { LogBuffer } = require('../../src/ui/log-buffer');

test('log/error girdileri doğru düzeyle saklanır', () => {
  const buf = new LogBuffer();
  buf.log('bilgi satırı');
  buf.error('hata satırı');
  assert.deepEqual(buf.entries, [
    { level: 'info', text: 'bilgi satırı' },
    { level: 'error', text: 'hata satırı' },
  ]);
});

test('recent: son N satırı en yeni sonda döndürür', () => {
  const buf = new LogBuffer();
  for (let i = 1; i <= 5; i++) buf.log(`satır ${i}`);
  const last3 = buf.recent(3);
  assert.equal(last3.length, 3);
  assert.equal(last3[0].text, 'satır 3');
  assert.equal(last3[2].text, 'satır 5');
});

test('recent: limit <= 0 boş dizi döner', () => {
  const buf = new LogBuffer();
  buf.log('x');
  assert.deepEqual(buf.recent(0), []);
  assert.deepEqual(buf.recent(-1), []);
});

test('kapasite aşılınca en eski satırlar düşer (ring)', () => {
  const buf = new LogBuffer({ capacity: 3 });
  for (let i = 1; i <= 5; i++) buf.log(`s${i}`);
  assert.equal(buf.entries.length, 3);
  assert.equal(buf.entries[0].text, 's3');
  assert.equal(buf.entries[2].text, 's5');
});

test('Logger out arayüzü olarak çalışır (log/error metotları mevcut)', () => {
  const buf = new LogBuffer();
  assert.equal(typeof buf.log, 'function');
  assert.equal(typeof buf.error, 'function');
});

// ─── REGRESYON: bağlamsız (unbound) çağrı — TUI'de start/restart çökmesi ───────
// Logger.#write: `(cond ? out.error : out.log)(line)` — receiver'sız çağırır, this kaybolur.
// console buna dayanıklı; LogBuffer da olmalı (yoksa --tui'de her log çağrısı TypeError).

test('regresyon: log/error receiver olmadan çağrılabilir (this kaybolsa da)', () => {
  const buf = new LogBuffer();
  const { log, error } = buf; // metotları kopar
  assert.doesNotThrow(() => log('bilgi'));
  assert.doesNotThrow(() => error('hata'));
  assert.deepEqual(buf.entries, [
    { level: 'info', text: 'bilgi' },
    { level: 'error', text: 'hata' },
  ]);
});

test('regresyon: Logger\'ın seçici çağrı deseni (cond ? out.error : out.log)(line)', () => {
  const buf = new LogBuffer();
  const out = buf;
  const write = (isErr, line) => (isErr ? out.error : out.log)(line); // logger.js:60 deseni
  assert.doesNotThrow(() => write(false, 'INFO satır'));
  assert.doesNotThrow(() => write(true, 'ERROR satır'));
  assert.equal(buf.entries[0].level, 'info');
  assert.equal(buf.entries[1].level, 'error');
});

test('regresyon: gerçek Logger out=LogBuffer ile info/warn/error yazımı çökmeden tampona düşer', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { Logger } = require('../../src/infrastructure/logger');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logbuf-'));
  try {
    const buf = new LogBuffer();
    const logger = new Logger({ dir, out: buf });
    const child = logger.child('control');
    assert.doesNotThrow(() => child.info('yayın başlatma komutu alındı'));
    assert.doesNotThrow(() => child.warn('uyarı'));
    assert.doesNotThrow(() => child.error('hata'));
    assert.ok(buf.entries.some((e) => e.level === 'info' && /yayın başlatma/.test(e.text)));
    assert.ok(buf.entries.some((e) => e.level === 'error' && /uyarı/.test(e.text))); // WARN → out.error
    assert.ok(buf.entries.some((e) => e.level === 'error' && /hata/.test(e.text)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
