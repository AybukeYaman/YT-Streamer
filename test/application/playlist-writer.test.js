const test = require('node:test');
const assert = require('node:assert/strict');

const { PlaylistWriter, concatLine } = require('../../src/application/playlist-writer');
const { AlbumQueue } = require('../../src/application/album-queue');
const { Album } = require('../../src/domain/album');
const { Track } = require('../../src/domain/track');

const track = (name, durationSeconds = 100) => new Track({ path: `C:\\Users\\Aybuke Yeni\\music\\${name}.m4a`, durationSeconds });

const albumQueue = (tracks) => new AlbumQueue({ albums: [new Album({ name: 'x', backgroundPath: 'bg', tracks })], mode: 'sequential' });

function memoryWriter() {
  const writes = [];
  return { writeFile: (p, content) => writes.push({ p, content }), writes };
}

test('concat satırı: düz bölü, tek tırnak içinde, boşluk korunur', () => {
  assert.equal(
    concatLine('C:\\Users\\Aybuke Yeni\\music\\Silk & Mahogany.m4a'),
    "file 'C:/Users/Aybuke Yeni/music/Silk & Mahogany.m4a'",
  );
});

test('concat satırı: yoldaki tek tırnak kaçışlanır', () => {
  assert.equal(concatLine("C:/m/Don't Stop.m4a"), "file 'C:/m/Don'\\''t Stop.m4a'");
});

test('batchSize kadar parçayı sırayla yazar, parçaları ve toplam süreyi döndürür', () => {
  const q = albumQueue([track('a', 100), track('b', 150), track('c', 200)]);
  const { writeFile, writes } = memoryWriter();
  const w = new PlaylistWriter({ queue: q, batchSize: 2, playlistPath: 'C:/rt/playlist.txt', writeFile });
  const r = w.writeNext();
  assert.deepEqual(r.tracks.map((t) => t.title), ['a', 'b']);
  assert.equal(r.totalDurationSeconds, 250);
  assert.equal(r.path, 'C:/rt/playlist.txt');
  assert.deepEqual(writes, [{
    p: 'C:/rt/playlist.txt',
    content: "file 'C:/Users/Aybuke Yeni/music/a.m4a'\nfile 'C:/Users/Aybuke Yeni/music/b.m4a'\n",
  }]);
});

test('ardışık playlist\'ler kuyruğun kaldığı yerden devam eder (baştan başlamaz)', () => {
  const q = albumQueue(['a', 'b', 'c'].map((n) => track(n)));
  const w = new PlaylistWriter({ queue: q, batchSize: 2, playlistPath: 'p', writeFile: () => {} });
  const titles = [w.writeNext(), w.writeNext(), w.writeNext()].map((r) => r.tracks.map((t) => t.title).join(''));
  assert.deepEqual(titles, ['ab', 'ca', 'bc']);
});

test('batchSize albümden uzunsa playlist albüm kadar olur (parça tekrarlanmaz), albüm döner', () => {
  const q = albumQueue([track('a'), track('b')]);
  const w = new PlaylistWriter({ queue: q, batchSize: 5, playlistPath: 'p', writeFile: () => {} });
  const r = w.writeNext();
  assert.deepEqual(r.tracks.map((t) => t.title), ['a', 'b']);
  assert.equal(r.album.name, 'x');
});

test('write: verilen parçaları yazar, kuyruğa dokunmaz', () => {
  const q = albumQueue([track('a', 100), track('b', 50), track('c')]);
  const { writeFile, writes } = memoryWriter();
  const w = new PlaylistWriter({ queue: q, batchSize: 2, playlistPath: 'C:/rt/playlist.txt', writeFile });
  const r = w.write([track('b', 50), track('c', 70)]);
  assert.deepEqual(r.tracks.map((t) => t.title), ['b', 'c']);
  assert.equal(r.totalDurationSeconds, 120);
  assert.equal(writes.length, 1);
  assert.deepEqual(w.writeNext().tracks.map((t) => t.title), ['a', 'b']); // kuyruk baştan — tüketilmemiş
});

test('geçersiz batchSize reddedilir', () => {
  const q = albumQueue([track('a')]);
  for (const batchSize of [0, -1, 2.5, '50', undefined]) {
    assert.throws(() => new PlaylistWriter({ queue: q, batchSize, playlistPath: 'p', writeFile: () => {} }), /batchSize/, String(batchSize));
  }
});
