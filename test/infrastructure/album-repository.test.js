const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AlbumRepository, SingleAlbumRepository } = require('../../src/infrastructure/album-repository');

function fakeLog() {
  const lines = [];
  const rec = (level) => (m) => lines.push({ level, m });
  return { log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }, lines };
}

const probeDuration = async () => 180;

// Geçici music-source/ ağacı: { "<albüm>": { background: bool, tracks: [...] } }
function withSource(layout, fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-albumrepo-test-'));
    try {
      for (const [name, { background = true, tracks = [] }] of Object.entries(layout)) {
        fs.mkdirSync(path.join(dir, name, 'music'), { recursive: true });
        if (background) fs.writeFileSync(path.join(dir, name, 'background.mp4'), '');
        for (const t of tracks) fs.writeFileSync(path.join(dir, name, 'music', t), '');
      }
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('albümleri adıyla, arkaplanıyla ve parçalarıyla yükler; eksik/boş albümü atlayıp uyarır', withSource({
  'video 1': { tracks: ['Işığı Kapatmadan.m4a', 'Sayfa Arası.m4a'] },
  'video-3': { tracks: ['Amber on the Rocks.m4a'] },
  'arkaplansiz': { background: false, tracks: ['x.m4a'] },
  'bos': { tracks: [] },
}, async (dir) => {
  const { log, lines } = fakeLog();
  const albums = await new AlbumRepository({ dir, log, probeDuration }).list();
  assert.deepEqual(albums.map((a) => a.name), ['video 1', 'video-3']);
  assert.equal(albums[0].backgroundPath, path.join(dir, 'video 1', 'background.mp4'));
  assert.deepEqual(albums[0].tracks.map((t) => t.title), ['Işığı Kapatmadan', 'Sayfa Arası']);
  assert.ok(lines.some((l) => l.level === 'warn' && /arkaplansiz/.test(l.m)));
  assert.ok(lines.some((l) => l.level === 'warn' && /bos — okunabilir parça yok/.test(l.m)));
}));

test('SingleAlbumRepository: eski düzen tek albüm olarak döner', withSource({
  music: { tracks: ['a.m4a', 'b.m4a'] },
}, async (dir) => {
  const { log } = fakeLog();
  const [album, ...rest] = await new SingleAlbumRepository({
    musicDir: path.join(dir, 'music', 'music'), backgroundPath: 'C:/assets/background.mp4', log, probeDuration,
  }).list();
  assert.equal(rest.length, 0);
  assert.equal(album.backgroundPath, 'C:/assets/background.mp4');
  assert.deepEqual(album.tracks.map((t) => t.title), ['a', 'b']);
}));
