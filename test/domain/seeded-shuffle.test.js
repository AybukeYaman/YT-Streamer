const test = require('node:test');
const assert = require('node:assert/strict');

const { shuffledAt } = require('../../src/domain/seeded-shuffle');

const POOL = ['a.mp4', 'b.mp4', 'c.mp4'];

test('aynı seed+index her zaman aynı sonucu verir', () => {
  const a = shuffledAt(POOL, 42, 5);
  const b = shuffledAt(POOL, 42, 5);
  assert.equal(a, b);
});

test('farklı seed, aynı index için farklı sonuç üretebilir', () => {
  const results = new Set();
  for (let seed = 0; seed < 20; seed++) results.add(shuffledAt(POOL, seed, 0));
  assert.ok(results.size > 1, 'farklı seed hep aynı sonucu vermemeli');
});

test('tek elemanlı havuz: her index için aynı (tek) eleman', () => {
  for (let i = 0; i < 10; i++) assert.equal(shuffledAt(['only.mp4'], 7, i), 'only.mp4');
});

test('boş havuz: null', () => {
  assert.equal(shuffledAt([], 7, 0), null);
});

test('bir tur içinde her eleman tam bir kez görünür (tekrar yok)', () => {
  const seen = new Set();
  for (let i = 0; i < POOL.length; i++) seen.add(shuffledAt(POOL, 99, i));
  assert.equal(seen.size, POOL.length);
});

test('tur sınırında (çok turlu dizi) art arda aynı eleman gelmiyor', () => {
  const seed = 123;
  const seq = [];
  for (let i = 0; i < POOL.length * 50; i++) seq.push(shuffledAt(POOL, seed, i));
  for (let i = 1; i < seq.length; i++) {
    assert.notEqual(seq[i], seq[i - 1], `index ${i} önceki ile aynı: ${seq[i]}`);
  }
});

test('geçersiz index reddedilir', () => {
  assert.throws(() => shuffledAt(POOL, 1, -1));
  assert.throws(() => shuffledAt(POOL, 1, 1.5));
});
