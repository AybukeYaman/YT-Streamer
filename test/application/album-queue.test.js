const test = require('node:test');
const assert = require('node:assert/strict');

const { AlbumQueue } = require('../../src/application/album-queue');
const { Album, AlbumError } = require('../../src/domain/album');
const { Track } = require('../../src/domain/track');

const track = (name) => new Track({ path: `C:/ms/${name}.m4a`, durationSeconds: 60 });
const album = (name, n) => new Album({
  name, backgroundPath: `C:/ms/${name}/background.mp4`,
  tracks: Array.from({ length: n }, (_, i) => track(`${name}${i + 1}`)),
});
const titles = (batch) => batch.tracks.map((t) => t.title).join(',');

// Deterministik "rastgele": verilen dizi döngüyle
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

test('Album: ad, arkaplan ve en az bir parça zorunlu; parça listesi dışarıdan değişmez', () => {
  assert.throws(() => new Album({ name: '', backgroundPath: 'bg', tracks: [track('a')] }), AlbumError);
  assert.throws(() => new Album({ name: 'x', backgroundPath: '', tracks: [track('a')] }), /arkaplan/);
  assert.throws(() => new Album({ name: 'x', backgroundPath: 'bg', tracks: [] }), /hiç parça yok/);
  const tracks = [track('a')];
  const a = new Album({ name: 'x', backgroundPath: 'bg', tracks });
  tracks.push(track('b'));
  assert.equal(a.tracks.length, 1);
});

test('her batch tek albüm; albüm kısaysa batch albüm kadar, albüm kaldığı yerden devam eder', () => {
  const q = new AlbumQueue({ albums: [album('A', 3), album('B', 1)], mode: 'sequential' });
  const batches = [q.nextBatch(2), q.nextBatch(2), q.nextBatch(2), q.nextBatch(2)];
  assert.deepEqual(batches.map((b) => b.album.name), ['A', 'B', 'A', 'B']);
  assert.deepEqual(batches.map(titles), ['A1,A2', 'B1', 'A3,A1', 'B1']);
});

test('shuffle: aynı albüm arka arkaya gelmez (tur sınırında da), batch içinde parça tekrarlanmaz', () => {
  const albums = [album('A', 4), album('B', 4), album('C', 4)];
  for (const random of [Math.random, seq(0), seq(0.99), seq(0.5, 0.1, 0.9)]) {
    const q = new AlbumQueue({ albums, mode: 'shuffle', random });
    let prev = null;
    for (let i = 0; i < 60; i++) {
      const b = q.nextBatch(10);
      assert.notEqual(b.album, prev, `ardışık aynı albüm (adım ${i})`);
      assert.equal(new Set(b.tracks).size, b.tracks.length);
      assert.ok(b.tracks.every((t) => b.album.tracks.includes(t)), 'batch başka albümden parça içeriyor');
      prev = b.album;
    }
  }
});

test('tek albüm: her batch aynı albüm (hata değil)', () => {
  const q = new AlbumQueue({ albums: [album('A', 2)], mode: 'shuffle' });
  assert.deepEqual([q.nextBatch(5), q.nextBatch(5)].map((b) => b.album.name), ['A', 'A']);
});

test('albüm yoksa anlaşılır hata', () => {
  assert.throws(() => new AlbumQueue({ albums: [], mode: 'shuffle' }), /hiç albüm yok/);
});
