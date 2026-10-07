const test = require('node:test');
const assert = require('node:assert');
const {
  backgroundRotationPaths, repeatsFor, BackgroundRotationError, MAX_REPEATS_PER_BACKGROUND,
} = require('../../src/domain/background-rotation');

const bg = (path, durationSeconds) => ({ path, durationSeconds });

test('tekrar sayısı rotasyon süresini dolduracak kadar — yuvarlanır', () => {
  // 16 sn klip, 1 saat: 3600/16 = 225 tam
  assert.equal(repeatsFor(16, 3600), 225);
  // 10 sn klip, 1 saat: 360
  assert.equal(repeatsFor(10, 3600), 360);
  // 7 sn klip: 3600/7 = 514.28 → 514 (geçiş döngü sınırına düşsün diye yuvarlanır)
  assert.equal(repeatsFor(7, 3600), 514);
});

test('rotasyon süresinden uzun klip bir kez oynar — kırpılmaz', () => {
  assert.equal(repeatsFor(5000, 3600), 1);
});

test('çok kısa klipte tekrar sayısı tavanla sınırlanır', () => {
  // 0.5 sn klip 1 saatte 7200 tekrar isterdi; liste şişmesin diye tavan uygulanır
  assert.equal(repeatsFor(0.5, 3600), MAX_REPEATS_PER_BACKGROUND);
});

test('liste tek tur içerir: her klip kendi payı kadar, sırayla', () => {
  const paths = backgroundRotationPaths({
    backgrounds: [bg('/a.mp4', 1800), bg('/b.mp4', 900)],
    rotationSeconds: 1800,
  });
  // a: 1800/1800 = 1 kez, b: 1800/900 = 2 kez
  assert.deepEqual(paths, ['/a.mp4', '/b.mp4', '/b.mp4']);
});

test('sıra korunur — klipler karışmaz', () => {
  const paths = backgroundRotationPaths({
    backgrounds: [bg('/1.mp4', 60), bg('/2.mp4', 60), bg('/3.mp4', 60)],
    rotationSeconds: 120,
  });
  assert.deepEqual(paths, ['/1.mp4', '/1.mp4', '/2.mp4', '/2.mp4', '/3.mp4', '/3.mp4']);
});

test('süresi bilinmeyen klip hata verir — tekrar sayısı hesaplanamaz', () => {
  assert.throws(
    () => backgroundRotationPaths({ backgrounds: [bg('/a.mp4', null)], rotationSeconds: 3600 }),
    BackgroundRotationError,
  );
});

test('boş liste ve geçersiz rotasyon süresi hata verir', () => {
  assert.throws(() => backgroundRotationPaths({ backgrounds: [], rotationSeconds: 3600 }), BackgroundRotationError);
  assert.throws(
    () => backgroundRotationPaths({ backgrounds: [bg('/a.mp4', 10)], rotationSeconds: 0 }),
    BackgroundRotationError,
  );
});
