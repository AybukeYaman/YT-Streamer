const test = require('node:test');
const assert = require('node:assert');
const { BackgroundPlaylistWriter } = require('../../src/application/background-playlist-writer');
const { Album } = require('../../src/domain/album');
const { Track } = require('../../src/domain/track');

const tracks = [new Track({ path: '/m/1.m4a', durationSeconds: 180 })];
const writerWith = (writes, rotationSeconds = 3600) => new BackgroundPlaylistWriter({
  playlistPath: '/runtime/backgrounds.txt',
  writeFile: (path, content) => writes.push({ path, content }),
  rotationSeconds,
});

test('tek arkaplanlı albümde liste yazılmaz, null döner', () => {
  const writes = [];
  const album = new Album({ name: 'a', backgroundPath: '/bg.mp4', tracks });
  assert.equal(writerWith(writes).write(album), null);
  assert.equal(writes.length, 0);
});

test('çoğul arkaplanda concat formatında liste yazılır', () => {
  const writes = [];
  const album = new Album({
    name: 'a',
    backgrounds: [{ path: '/bg/01.mp4', durationSeconds: 1800 }, { path: '/bg/02.mp4', durationSeconds: 900 }],
    tracks,
  });
  const result = writerWith(writes, 1800).write(album);

  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/runtime/backgrounds.txt');
  assert.deepEqual(writes[0].content.trim().split('\n'), [
    "file '/bg/01.mp4'",
    "file '/bg/02.mp4'",
    "file '/bg/02.mp4'",
  ]);
  assert.deepEqual(result, { path: '/runtime/backgrounds.txt', lineCount: 3, backgroundCount: 2 });
});

test('yoldaki ters bölü ve tek tırnak concat kuralına göre yazılır', () => {
  const writes = [];
  const album = new Album({
    name: 'a',
    backgrounds: [
      { path: 'C:\\bg\\Don\'t Stop.mp4', durationSeconds: 60 },
      { path: 'C:/bg/02.mp4', durationSeconds: 60 },
    ],
    tracks,
  });
  writerWith(writes, 60).write(album);
  const lines = writes[0].content.trim().split('\n');
  assert.equal(lines[0], "file 'C:/bg/Don'\\''t Stop.mp4'");
  assert.equal(lines[1], "file 'C:/bg/02.mp4'");
});

test('geçersiz rotationSeconds kurulumda yakalanır', () => {
  assert.throws(() => new BackgroundPlaylistWriter({
    playlistPath: '/x.txt', writeFile: () => {}, rotationSeconds: 0,
  }), /rotationSeconds/);
});
