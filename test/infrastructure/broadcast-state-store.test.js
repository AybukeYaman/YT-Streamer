// Broadcast kaydı: idempotansın tek bilgi kaynağı. Bozuk dosya go-live'ı engellememeli.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BroadcastStateStore } = require('../../src/infrastructure/broadcast-state-store');
const { writeFileAtomic } = require('../../src/infrastructure/atomic-file');

function setup(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-bcast-'));
  const file = path.join(dir, 'broadcast.json');
  if (contents !== undefined) fs.writeFileSync(file, contents);
  const lines = [];
  const store = new BroadcastStateStore({
    file, writeFile: writeFileAtomic, log: { warn: (m) => lines.push(m) },
  });
  return { store, file, lines };
}

test('save + load: kayıt geri okunur', () => {
  const { store } = setup();
  const state = { broadcastId: 'bid-1', streamId: 'sid-1', status: 'live', title: 't', createdAt: 'x' };
  store.save(state);
  assert.deepEqual(store.load(), state);
});

test('dosya yoksa null (uyarı yok — normal ilk çalıştırma)', () => {
  const { store, lines } = setup();
  assert.equal(store.load(), null);
  assert.deepEqual(lines, []);
});

test('bozuk JSON: null + uyarı (go-live engellenmez)', () => {
  const { store, lines } = setup('{ yarim');
  assert.equal(store.load(), null);
  assert.ok(lines.some((m) => /geçerli JSON değil/.test(m)));
});

test('broadcastId taşımayan kayıt yoksayılır', () => {
  const { store, lines } = setup('{"status":"live"}');
  assert.equal(store.load(), null);
  assert.ok(lines.some((m) => /broadcastId taşımıyor/.test(m)));
});

test('clear: kayıt silinir, ikinci clear zararsız', () => {
  const { store, file } = setup();
  store.save({ broadcastId: 'b' });
  store.clear();
  assert.equal(fs.existsSync(file), false);
  store.clear();
  assert.equal(store.load(), null);
});

test('save hatası yukarı iletilir (GoLiveService idempotans için durmalı)', () => {
  const { store } = setup();
  store.writeFile = () => { throw new Error('disk dolu'); };
  assert.throws(() => store.save({ broadcastId: 'b' }), /disk dolu/);
});
