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

// ── Tur sınırı: aynı playlist'te aynı parça iki kez olmamalı ────────────────
// 10 Ekim 2026: albümün parça kuyruğu kaldığı yerden devam ettiği için, turda az
// parça kalmışken istenen büyük batch "kalan + yeni turdan" karışımı oluyordu ve
// yeni tur kalanları tekrar içerebiliyordu.

test('sequential: tur sınırı kesme GEREKTİRMEZ, sıra kesintisiz döner', () => {
  // Yeni tur aynı listenin kopyası olduğu için sınırı aşan batch tekrar üretemez.
  const q = new AlbumQueue({ albums: [album('A', 5)], mode: 'sequential' });
  q.nextBatch(3);
  const batch = q.nextBatch(5);
  assert.equal(titles(batch), 'A4,A5,A1,A2,A3');
  assert.equal(new Set(batch.tracks).size, 5, 'tekrar yok');
});

test('shuffle: tur sınırını aşan batch tekrar üretecekse kesilir', () => {
  // seq(0.9,0.1) + 4 parça + 3'lük batch: eski kod 2. playlist'i "A4,A2,A4" yapıyordu.
  const q = new AlbumQueue({ albums: [album('A', 4)], mode: 'shuffle', random: seq(0.9, 0.1) });
  assert.equal(q.nextBatch(3).tracks.length, 3);
  const second = q.nextBatch(3);
  assert.equal(titles(second), 'A4,A2', 'tekrar eden parçadan önce kesilmeli');
  assert.equal(new Set(second.tracks).size, 2);
});

test('kesilen batch parça ATLAMAZ: kesilen parça sonraki playlist’in başında gelir', () => {
  const q = new AlbumQueue({ albums: [album('A', 4)], mode: 'shuffle', random: seq(0.9, 0.1) });
  q.nextBatch(3);
  q.nextBatch(3); // "A4,A2" olarak kesildi; sıradaki A4 bekliyor
  assert.equal(titles(q.nextBatch(3)).split(',')[0], 'A4', 'kesilen yerden devam');
});

test('shuffle: tur sınırını aşan batch istendiğinde de tekrar yok (çok tur)', () => {
  const albums = [album('A', 7), album('B', 7)];
  for (const random of [Math.random, seq(0), seq(0.99), seq(0.5, 0.1, 0.9)]) {
    const q = new AlbumQueue({ albums, mode: 'shuffle', random });
    for (let i = 0; i < 40; i++) {
      const b = q.nextBatch(5); // 7'lik albümde 5'lik batch: sınır sürekli kayar
      assert.ok(b.tracks.length >= 1 && b.tracks.length <= 5);
      assert.equal(new Set(b.tracks).size, b.tracks.length, `adım ${i}: playlist'te tekrar var`);
    }
  }
});

test('batch albüm uzunluğuna eşitse tam tur döner (kesilme yok)', () => {
  const q = new AlbumQueue({ albums: [album('A', 4)], mode: 'sequential' });
  assert.equal(q.nextBatch(4).tracks.length, 4);
  assert.equal(q.nextBatch(4).tracks.length, 4, 'tur sınırı tam denk geliyorsa kesilme olmaz');
});
