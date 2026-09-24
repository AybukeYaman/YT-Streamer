const test = require('node:test');
const assert = require('node:assert/strict');

const { NowPlayingWriter, truncateTitle } = require('../../src/application/now-playing-writer');

function memoryWriter() {
  const writes = [];
  return { writeFile: (p, content) => writes.push({ p, content }), writes };
}

test('kısa başlık olduğu gibi kalır; sınırda tam uzunluk da kısaltılmaz', () => {
  assert.equal(truncateTitle('Coral Lipstick', 40), 'Coral Lipstick');
  const exact = 'x'.repeat(40);
  assert.equal(truncateTitle(exact, 40), exact);
});

test('uzun başlık … ile kısaltılır, sonuç … dahil tam sınır uzunluğunda', () => {
  const t = truncateTitle('a'.repeat(41), 40);
  assert.equal(t, 'a'.repeat(39) + '…');
  assert.equal([...t].length, 40);
});

test('kesim noktasındaki boşluk …\'dan önce kırpılır', () => {
  assert.equal(truncateTitle('Strawberries at Noon', 14), 'Strawberries…');
});

test('uzunluk karakter olarak sayılır, Türkçe/çok baytlı karakter bölünmez', () => {
  assert.equal(truncateTitle('ğüşıöç ğüşıöç', 8), 'ğüşıöç…');
  assert.equal(truncateTitle('🎷🎷🎷🎷', 3), '🎷🎷…');
});

test('writeAll: her başlığı sıra numaralı ayrı dosyaya kısaltarak yazar, yolları döndürür', () => {
  const { writeFile, writes } = memoryWriter();
  const w = new NowPlayingWriter({ dir: 'C:/rt/overlay', writeFile, maxLength: 10 });
  const files = w.writeAll(['Emerald Velvet & Silk', 'Power Shift', 'Kısa']);
  assert.deepEqual(files, ['C:/rt/overlay/track-001.txt', 'C:/rt/overlay/track-002.txt', 'C:/rt/overlay/track-003.txt']);
  assert.deepEqual(writes, [
    { p: 'C:/rt/overlay/track-001.txt', content: 'Emerald V…' },
    { p: 'C:/rt/overlay/track-002.txt', content: 'Power Shi…' },
    { p: 'C:/rt/overlay/track-003.txt', content: 'Kısa' },
  ]);
});

test('writeAll: 50 parçalık playlist için sıra numarası üç haneli', () => {
  const { writeFile } = memoryWriter();
  const files = new NowPlayingWriter({ dir: 'd', writeFile }).writeAll(Array.from({ length: 50 }, (_, i) => `t${i}`));
  assert.equal(files[49], 'd/track-050.txt');
});

test('varsayılan sınır 40', () => {
  const { writeFile, writes } = memoryWriter();
  new NowPlayingWriter({ dir: 'd', writeFile }).writeAll(['b'.repeat(50)]);
  assert.equal([...writes[0].content].length, 40);
});

test('geçersiz maxLength reddedilir', () => {
  assert.throws(() => new NowPlayingWriter({ dir: 'd', writeFile: () => {}, maxLength: 1 }), /maxLength/);
});
