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

// ── Çoğul arkaplan (backgrounds/) ────────────────────────────────────────────
// Ayrı bir kurucu: withSource yalnızca tek background.mp4 düzenini kuruyor.
function withBackgroundsSource(layout, fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-bgrepo-test-'));
    try {
      for (const [name, { background = false, backgrounds = null, tracks = ['a.m4a'] }] of Object.entries(layout)) {
        fs.mkdirSync(path.join(dir, name, 'music'), { recursive: true });
        for (const t of tracks) fs.writeFileSync(path.join(dir, name, 'music', t), '');
        if (background) fs.writeFileSync(path.join(dir, name, 'background.mp4'), '');
        if (backgrounds) {
          fs.mkdirSync(path.join(dir, name, 'backgrounds'), { recursive: true });
          for (const f of backgrounds) fs.writeFileSync(path.join(dir, name, 'backgrounds', f), '');
        }
      }
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('backgrounds/ varsa çoğul arkaplan okunur: adına göre sıralı, süreleriyle', withBackgroundsSource({
  rotasyonlu: { backgrounds: ['02-gece.mp4', '01-gun.mp4', 'okuma.txt'] },
}, async (dir) => {
  const { log } = fakeLog();
  const [album] = await new AlbumRepository({ dir, log, probeDuration: async () => 16 }).list();

  assert.equal(album.rotates, true);
  assert.deepEqual(album.backgrounds.map((b) => path.basename(b.path)), ['01-gun.mp4', '02-gece.mp4']);
  assert.deepEqual(album.backgrounds.map((b) => b.durationSeconds), [16, 16]);
  // backgroundPath ilk klibe işaret eder — tek arkaplan bekleyen kod yolları kırılmasın
  assert.equal(album.backgroundPath, path.join(dir, 'rotasyonlu', 'backgrounds', '01-gun.mp4'));
}));

test('backgrounds/ ve background.mp4 birlikteyse backgrounds/ kazanır', withBackgroundsSource({
  ikisi: { background: true, backgrounds: ['01.mp4'] },
}, async (dir) => {
  const { log } = fakeLog();
  const [album] = await new AlbumRepository({ dir, log, probeDuration: async () => 10 }).list();
  assert.equal(album.backgroundPath, path.join(dir, 'ikisi', 'backgrounds', '01.mp4'));
}));

test('backgrounds/ boş ya da okunamazsa background.mp4\'a düşer', withBackgroundsSource({
  bosklasor: { background: true, backgrounds: [] },
}, async (dir) => {
  const { log, lines } = fakeLog();
  const [album] = await new AlbumRepository({ dir, log, probeDuration: async () => 10 }).list();
  assert.equal(album.rotates, false);
  assert.equal(album.backgroundPath, path.join(dir, 'bosklasor', 'background.mp4'));
  assert.ok(lines.some((l) => l.level === 'warn' && /okunabilir arkaplan yok/.test(l.m)));
}));

test('süresi okunamayan klip listeden düşer, albüm atlanmaz', withBackgroundsSource({
  kismi: { backgrounds: ['01.mp4', '02-bozuk.mp4'] },
}, async (dir) => {
  const { log, lines } = fakeLog();
  const probe = async (f) => {
    if (path.basename(f) === '02-bozuk.mp4') throw new Error('süre okunamadı');
    return 12;
  };
  const [album] = await new AlbumRepository({ dir, log, probeDuration: probe }).list();
  assert.deepEqual(album.backgrounds.map((b) => path.basename(b.path)), ['01.mp4']);
  assert.equal(album.rotates, false);
  assert.ok(lines.some((l) => l.level === 'warn' && /02-bozuk\.mp4/.test(l.m)));
}));

test('hiç arkaplan yoksa (ne backgrounds/ ne background.mp4) albüm atlanır', withBackgroundsSource({
  arkaplansiz: {},
}, async (dir) => {
  const { log, lines } = fakeLog();
  const albums = await new AlbumRepository({ dir, log, probeDuration }).list();
  assert.deepEqual(albums, []);
  assert.ok(lines.some((l) => l.level === 'warn' && /arkaplansiz/.test(l.m)));
}));
