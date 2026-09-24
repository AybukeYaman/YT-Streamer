const test = require('node:test');
const assert = require('node:assert/strict');

const { Queue, QueueError } = require('../../src/domain/queue');
const { Track, TrackError } = require('../../src/domain/track');

const track = (name) => new Track({ path: `C:/music/${name}.m4a`, durationSeconds: 180 });
const TRACKS = ['a', 'b', 'c', 'd', 'e'].map(track);
const titles = (list) => list.map((t) => t.title);
const take = (q, n) => Array.from({ length: n }, () => q.next());

// Deterministik rastgele (mulberry32) — tekrar üretilebilir shuffle testleri için.
function seeded(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Track ---

test('Track: başlık dosya adından, uzantısız', () => {
  assert.equal(track('Golden Hour, Darling (Take 2)').title, 'Golden Hour, Darling (Take 2)');
  assert.equal(new Track({ path: 'C:\\m\\x.y.m4a', durationSeconds: 1 }).title, 'x.y');
  assert.ok(Object.isFrozen(track('a')));
});

test('Track: boş yol ve pozitif olmayan süre reddedilir', () => {
  assert.throws(() => new Track({ path: '', durationSeconds: 10 }), TrackError);
  for (const durationSeconds of [0, -1, NaN, Infinity, '180']) {
    assert.throws(() => new Track({ path: 'C:/a.m4a', durationSeconds }), TrackError, String(durationSeconds));
  }
});

// --- Queue ---

test('sequential: dosya sırası ve sonsuz döngü', () => {
  const q = new Queue({ tracks: TRACKS, mode: 'sequential' });
  assert.deepEqual(titles(take(q, 12)), ['a', 'b', 'c', 'd', 'e', 'a', 'b', 'c', 'd', 'e', 'a', 'b']);
});

test('shuffle: her turda her parça tam bir kez, sonsuz döngü', () => {
  const q = new Queue({ tracks: TRACKS, mode: 'shuffle', random: seeded(1) });
  for (let round = 0; round < 20; round++) {
    assert.deepEqual(titles(take(q, 5)).sort(), ['a', 'b', 'c', 'd', 'e'], `tur ${round}`);
  }
});

test('shuffle: aynı parça arka arkaya gelmez (tur sınırları dahil, 1000 tur)', () => {
  for (const n of [2, 3, 5]) {
    const q = new Queue({ tracks: TRACKS.slice(0, n), mode: 'shuffle', random: seeded(42 + n) });
    const played = take(q, n * 1000);
    for (let i = 1; i < played.length; i++) {
      assert.notEqual(played[i], played[i - 1], `n=${n}, ${i}. parça tekrarı`);
    }
  }
});

test('shuffle: tek parçalı listede aynı parça tekrar çalar (başka seçenek yok)', () => {
  const q = new Queue({ tracks: [track('tek')], mode: 'shuffle' });
  assert.deepEqual(titles(take(q, 3)), ['tek', 'tek', 'tek']);
});

test('shuffle: gerçekten karıştırıyor (sabit sıra değil)', () => {
  const q = new Queue({ tracks: TRACKS, mode: 'shuffle', random: seeded(7) });
  const rounds = new Set(Array.from({ length: 10 }, () => titles(take(q, 5)).join('')));
  assert.ok(rounds.size > 1);
});

test('peek next\'i tüketmez ve sonraki next\'ler tam olarak peek\'in gösterdiğini döndürür', () => {
  for (const mode of ['sequential', 'shuffle']) {
    const q = new Queue({ tracks: TRACKS, mode, random: seeded(3) });
    q.next();
    const peeked = q.peek(12); // tur sınırını aşan bir bakış
    assert.deepEqual(q.peek(12), peeked, `${mode}: ikinci peek aynı`);
    assert.deepEqual(take(q, 12), peeked, `${mode}: next'ler peek ile aynı`);
  }
});

test('boş liste açık hata fırlatır', () => {
  assert.throws(() => new Queue({ tracks: [], mode: 'shuffle' }), (err) => err instanceof QueueError && /hiç parça yok/.test(err.message));
  assert.throws(() => new Queue({ tracks: undefined, mode: 'sequential' }), QueueError);
});

test('geçersiz mod reddedilir', () => {
  assert.throws(() => new Queue({ tracks: TRACKS, mode: 'random' }), /geçersiz kuyruk modu "random"/);
});

test('dışarıdaki dizi değişse de kuyruk etkilenmez', () => {
  const list = [...TRACKS];
  const q = new Queue({ tracks: list, mode: 'sequential' });
  list.length = 0;
  assert.deepEqual(titles(take(q, 2)), ['a', 'b']);
});
