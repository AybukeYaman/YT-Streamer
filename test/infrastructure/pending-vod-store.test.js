// PendingVodStore testleri: gerçek fs (geçici klasör), atomik yazma sahte.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PendingVodStore } = require('../../src/infrastructure/pending-vod-store');

function withStore(body, { initialText = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vodstore-'));
  const file = path.join(dir, 'vod-pending.json');
  if (initialText !== null) fs.writeFileSync(file, initialText);
  const warns = [];
  const store = new PendingVodStore({
    file,
    writeFile: (f, content) => fs.writeFileSync(f, content),
    log: { warn: (m) => warns.push(m) },
  });
  try {
    return body({ store, file, warns });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('dosya yoksa boş liste döner, uyarı YOK (normal ilk durum)', () => {
  withStore(({ store, warns }) => {
    assert.deepEqual(store.list(), []);
    assert.deepEqual(warns, []);
  });
});

test('add → list: kayıt diske yazılır ve geri okunur', () => {
  withStore(({ store, file }) => {
    store.add({ broadcastId: 'b1', title: 'Yayın', discoveredAt: '2026-10-02T00:00:00.000Z' });
    assert.deepEqual(store.list(), [{ broadcastId: 'b1', title: 'Yayın', discoveredAt: '2026-10-02T00:00:00.000Z' }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pending.length, 1);
  });
});

test('aynı broadcastId tekrar eklenmez (liste şişmesin, boşa API çağrısı olmasın)', () => {
  withStore(({ store }) => {
    store.add({ broadcastId: 'b1', discoveredAt: 'x' });
    store.add({ broadcastId: 'b1', discoveredAt: 'y' });
    store.add({ broadcastId: 'b2', discoveredAt: 'z' });
    assert.deepEqual(store.list().map((e) => e.broadcastId), ['b1', 'b2']);
  });
});

test('remove yalnızca verilenleri düşürür, kalanlar korunur (tekrar denenecekler)', () => {
  withStore(({ store }) => {
    for (const id of ['a', 'b', 'c']) store.add({ broadcastId: id, discoveredAt: 't' });
    store.remove(['a', 'c']);
    assert.deepEqual(store.list().map((e) => e.broadcastId), ['b']);
  });
});

test('remove boş liste ile çağrılırsa dosyaya dokunmaz', () => {
  withStore(({ store, file }) => {
    store.add({ broadcastId: 'a', discoveredAt: 't' });
    const before = fs.statSync(file).mtimeMs;
    store.remove([]);
    assert.equal(fs.statSync(file).mtimeMs, before);
  });
});

test('bozuk JSON: boş liste + uyarı — akışı DURDURMAZ', () => {
  withStore(({ store, warns }) => {
    assert.deepEqual(store.list(), []);
    assert.ok(warns.some((m) => /geçerli JSON değil/.test(m)));
  }, { initialText: '{ yarım' });
});

test('pending dizisi yoksa boş liste + uyarı', () => {
  withStore(({ store, warns }) => {
    assert.deepEqual(store.list(), []);
    assert.ok(warns.some((m) => /"pending" dizisi taşımıyor/.test(m)));
  }, { initialText: '{"baska":1}' });
});

test('broadcastId taşımayan kayıtlar atılır (çevrilecek video belirsiz)', () => {
  withStore(({ store }) => {
    assert.deepEqual(store.list().map((e) => e.broadcastId), ['iyi']);
  }, { initialText: JSON.stringify({ pending: [{ title: 'idsiz' }, { broadcastId: '' }, { broadcastId: 'iyi' }] }) });
});

test('bozuk dosyaya add yapılırsa sağlam bir liste ile baştan yazılır', () => {
  withStore(({ store }) => {
    store.add({ broadcastId: 'yeni', discoveredAt: 't' });
    assert.deepEqual(store.list().map((e) => e.broadcastId), ['yeni']);
  }, { initialText: 'bozuk' });
});
