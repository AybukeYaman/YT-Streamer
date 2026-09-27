const test = require('node:test');
const assert = require('node:assert');
const { cleanTitle, planAlbum } = require('../../scripts/normalize-albums');

test('cleanTitle: üretici imzasını temizler', () => {
  assert.strictEqual(cleanTitle('midnight-street [usesuno.com]'), 'midnight-street');
  assert.strictEqual(cleanTitle('Song [USESUNO.COM] (Take 2)'), 'Song (Take 2)');
  assert.strictEqual(cleanTitle('Track [udio.ai]'), 'Track');
});

test('cleanTitle: anlamlı etiketlere ve diğer köşeli parantezlere dokunmaz', () => {
  assert.strictEqual(cleanTitle('Golden Hour, Darling (Take 2)'), 'Golden Hour, Darling (Take 2)');
  assert.strictEqual(cleanTitle('Leaves Along the Shore_1'), 'Leaves Along the Shore_1');
  assert.strictEqual(cleanTitle('Live [Remix]'), 'Live [Remix]');
  assert.strictEqual(cleanTitle('Işığı Kapatmadan'), 'Işığı Kapatmadan');
});

const titles = (files) => Object.fromEntries(planAlbum(files).plan.map((p) => [p.file, p.title]));

test('planAlbum: tek versiyonda _N eki düşer', () => {
  assert.deepStrictEqual(titles(['A Warm Cup_1.m4a', 'Solo.m4a']), { 'A Warm Cup_1.m4a': 'A Warm Cup', 'Solo.m4a': 'Solo' });
});

test('planAlbum: çoklu versiyonlar ek sırasına göre (II), (III) alır, eksiz olan önde', () => {
  assert.deepStrictEqual(titles(['Path_3.m4a', 'Path_1.m4a', 'Path_2.m4a']),
    { 'Path_1.m4a': 'Path', 'Path_2.m4a': 'Path (II)', 'Path_3.m4a': 'Path (III)' });
  assert.deepStrictEqual(titles(['Notlar_1.m4a', 'Notlar.m4a']), { 'Notlar.m4a': 'Notlar', 'Notlar_1.m4a': 'Notlar (II)' });
  assert.deepStrictEqual(titles(['Lake (Take 2).m4a', 'Lake (Take 2)_1.m4a']),
    { 'Lake (Take 2).m4a': 'Lake (Take 2)', 'Lake (Take 2)_1.m4a': 'Lake (Take 2) (II)' });
});

test('planAlbum: imza temizliği sonrası versiyonlanır; boş başlık ve aynı versiyon çakışması atlanır', () => {
  const { plan, rejected } = planAlbum([
    'a [usesuno.com].m4a', 'A.m4a', '[usesuno.com].m4a', 'b [usesuno.com].m4a', 'c (Take 2).m4a',
  ]);
  assert.deepStrictEqual(plan.map((p) => p.title), ['b', 'c (Take 2)']);
  assert.deepStrictEqual(rejected.map((r) => r.file).sort(), ['A.m4a', '[usesuno.com].m4a', 'a [usesuno.com].m4a']);
});
