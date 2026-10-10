const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PomodoroStore } = require('../../src/infrastructure/pomodoro-store');

function fakeLog() {
  const lines = [];
  const rec = (level) => (m) => lines.push({ level, m });
  return { log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }, lines };
}

function withStore(fn) {
  return () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-pomostore-'));
    try {
      const file = path.join(dir, 'pomodoro.json');
      const { log, lines } = fakeLog();
      fn({
        store: new PomodoroStore({ file, writeFile: (p, c) => fs.writeFileSync(p, c), log }),
        file, lines,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('yazılan başlangıç ve seed aynı tür için geri okunur', withStore(({ store }) => {
  store.save({ type: '50+10', startedAt: 1234, seed: 42 });
  assert.deepEqual(store.load('50+10'), { startedAt: 1234, seed: 42 });
}));

test('seed olmayan eski kayıt (N3 öncesi) seed:0 ile okunur, yoksayılmaz', withStore(({ store, file }) => {
  fs.writeFileSync(file, JSON.stringify({ type: '50+10', startedAt: 1234 }));
  assert.deepEqual(store.load('50+10'), { startedAt: 1234, seed: 0 });
}));

test('dosya yoksa null, uyarı da yok (ilk çalıştırma normal)', withStore(({ store, lines }) => {
  assert.equal(store.load('50+10'), null);
  assert.equal(lines.filter((l) => l.level === 'warn').length, 0);
}));

test('tür değişmişse kayıt yoksayılır — yarım 50 dakikanın 30\'luk düzende karşılığı yok', withStore(({ store, lines }) => {
  store.save({ type: '50+10', startedAt: 1234 });
  assert.equal(store.load('30+10'), null);
  assert.ok(lines.some((l) => /türü değişmiş/.test(l.m)));
}));

test('bozuk JSON ve eksik alan yayını durdurmaz, null döner', withStore(({ store, file, lines }) => {
  fs.writeFileSync(file, '{bozuk');
  assert.equal(store.load('50+10'), null);
  fs.writeFileSync(file, JSON.stringify({ type: '50+10' }));
  assert.equal(store.load('50+10'), null);
  assert.equal(lines.filter((l) => l.level === 'warn').length, 2);
}));

test('yazma hatası yutulur (yayın sürmeli)', withStore(({ file, lines }) => {
  const store = new PomodoroStore({
    file,
    writeFile: () => { throw new Error('disk dolu'); },
    log: { warn: (m) => lines.push({ level: 'warn', m }), info: () => {} },
  });
  store.save({ type: '50+10', startedAt: 1 });
  assert.ok(lines.some((l) => /yazılamadı/.test(l.m)));
}));
