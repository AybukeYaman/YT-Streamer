const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StateStore } = require('../../src/infrastructure/state-store');
const { writeFileAtomic } = require('../../src/infrastructure/atomic-file');

function fakeLog() {
  const lines = [];
  const rec = (level) => (m) => lines.push({ level, m });
  return { log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }, lines };
}

// Gerçek dosya sistemi: okuma fs'e doğrudan bağlı, geçici dizinde çalışır.
function setup({ writeFile = writeFileAtomic } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-store-'));
  const { log, lines } = fakeLog();
  const file = path.join(dir, 'state.json');
  return { store: new StateStore({ file, writeFile, log }), file, lines };
}

const STATE = { album: 'video 1', trackPaths: ['C:/m/a.m4a', 'C:/m/b.m4a'], elapsedSeconds: 837.5 };

test('yazılan durum aynı şekilde geri okunur', () => {
  const { store } = setup();
  store.save(STATE);
  assert.deepEqual(store.load(), STATE);
});

test('dosya yoksa null döner ve uyarmaz (ilk çalıştırma normaldir)', () => {
  const { store, lines } = setup();
  assert.equal(store.load(), null);
  assert.deepEqual(lines, []);
});

test('bozuk JSON: uyarır ve null döner (yayın sıfırdan başlayabilsin)', () => {
  const { store, file, lines } = setup();
  fs.writeFileSync(file, '{ yarım');
  assert.equal(store.load(), null);
  assert.ok(lines.some((l) => l.level === 'warn' && /geçerli JSON değil/.test(l.m)));
});

test('eksik ya da geçersiz alanlar: uyarır ve null döner', () => {
  for (const bad of [
    {},
    { album: 'x', trackPaths: [], elapsedSeconds: 0 },
    { album: 'x', trackPaths: ['a'] },
    { album: 'x', trackPaths: 'a', elapsedSeconds: 0 },
    { album: 5, trackPaths: ['a'], elapsedSeconds: 0 },
    { album: 'x', trackPaths: ['a'], elapsedSeconds: 'çok' },
    null,
  ]) {
    const { store, file, lines } = setup();
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.equal(store.load(), null, `kabul edilmemeliydi: ${JSON.stringify(bad)}`);
    assert.ok(lines.some((l) => l.level === 'warn'));
  }
});

test('yazma hatası yayını düşürmez: uyarıyla yutulur', () => {
  const { store, lines } = setup({
    writeFile: () => { throw new Error('disk dolu'); },
  });
  store.save(STATE); // atmamalı
  assert.ok(lines.some((l) => l.level === 'warn' && /durum yazılamadı: disk dolu/.test(l.m)));
});

test('clear: dosyayı siler, yoksa da hata vermez', () => {
  const { store, lines } = setup();
  store.save(STATE);
  store.clear();
  assert.equal(store.load(), null);
  store.clear();
  assert.deepEqual(lines, []);
});
