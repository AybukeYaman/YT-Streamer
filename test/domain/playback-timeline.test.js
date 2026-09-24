const test = require('node:test');
const assert = require('node:assert/strict');

const { PlaybackTimeline } = require('../../src/domain/playback-timeline');
const { Track } = require('../../src/domain/track');

const track = (name, durationSeconds) => new Track({ path: `C:/music/${name}.m4a`, durationSeconds });
const A = track('a', 100);
const B = track('b', 50.5);
const C = track('c', 200);

test('kümülatif sınırlar parça sürelerinin birikimli toplamı', () => {
  assert.deepEqual(new PlaybackTimeline([A, B, C]).boundaries, [100, 150.5, 350.5]);
});

test('segments: her parçanın başlangıcı öncekinin bitişi, son parçanın bitişi açık (null)', () => {
  assert.deepEqual(new PlaybackTimeline([A, B, C]).segments(), [
    { track: A, start: 0, end: 100 },
    { track: B, start: 100, end: 150.5 },
    { track: C, start: 150.5, end: null }, // -shortest video kuyruğunda da yazı kalır
  ]);
});

test('segments: tek parçalı playlist baştan sona açık aralık', () => {
  assert.deepEqual(new PlaybackTimeline([A]).segments(), [{ track: A, start: 0, end: null }]);
});

test('boş playlist reddedilir', () => {
  assert.throws(() => new PlaybackTimeline([]), /en az bir parça/);
});
