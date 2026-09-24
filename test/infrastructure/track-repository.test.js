const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TrackRepository } = require('../../src/infrastructure/track-repository');
const { Track } = require('../../src/domain/track');

function fakeLog() {
  const lines = [];
  const rec = (level) => (m) => lines.push({ level, m });
  return { log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }, lines };
}

// Geçici music/ dizini; mkdtemp dolu, benzersiz bir yol garanti eder.
function withMusicDir(files, fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-trackrepo-test-'));
    try {
      for (const f of files) fs.writeFileSync(path.join(dir, f), '');
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// Dosya adına göre süre veren sahte ffprobe; "bozuk" içeren dosyada hata.
function fakeProbe() {
  const calls = [];
  const probeDuration = async (file) => {
    calls.push(path.basename(file));
    if (file.includes('bozuk')) throw new Error('Invalid data found when processing input');
    return 180;
  };
  return { probeDuration, calls };
}

test('sadece .m4a dosyaları, sıralı, Track olarak döner', withMusicDir(['b.m4a', 'A.M4A', 'not.txt', 'c.mp3'], async (dir) => {
  const { log } = fakeLog();
  const repo = new TrackRepository({ dir, log, probeDuration: fakeProbe().probeDuration });
  const tracks = await repo.list();
  assert.deepEqual(tracks.map((t) => t.title), ['A', 'b']);
  assert.ok(tracks.every((t) => t instanceof Track && t.durationSeconds === 180));
  assert.equal(tracks[0].path, path.join(dir, 'A.M4A'));
}));

test('bozuk dosya atlanır ve uyarı loglanır', withMusicDir(['iyi.m4a', 'bozuk.m4a'], async (dir) => {
  const { log, lines } = fakeLog();
  const repo = new TrackRepository({ dir, log, probeDuration: fakeProbe().probeDuration });
  const tracks = await repo.list();
  assert.deepEqual(tracks.map((t) => t.title), ['iyi']);
  assert.ok(lines.some((l) => l.level === 'warn' && /bozuk\.m4a/.test(l.m)));
  assert.ok(lines.some((l) => l.level === 'info' && /1\/2 parça/.test(l.m)));
}));

test('önbellek: dosya sayısı değişmedikçe yeniden ffprobe çalışmaz', withMusicDir(['a.m4a', 'b.m4a'], async (dir) => {
  const { log } = fakeLog();
  const { probeDuration, calls } = fakeProbe();
  const repo = new TrackRepository({ dir, log, probeDuration });
  const first = await repo.list();
  const second = await repo.list();
  assert.equal(calls.length, 2);
  assert.equal(second, first);
}));

test('önbellek: dosya sayısı değişince yeniden taranır', withMusicDir(['a.m4a'], async (dir) => {
  const { log } = fakeLog();
  const { probeDuration, calls } = fakeProbe();
  const repo = new TrackRepository({ dir, log, probeDuration });
  await repo.list();
  fs.writeFileSync(path.join(dir, 'yeni.m4a'), '');
  const tracks = await repo.list();
  assert.deepEqual(tracks.map((t) => t.title), ['a', 'yeni']);
  assert.equal(calls.length, 3);
}));

test('süresi 0 dönen dosya da atlanır (Track doğrulaması)', withMusicDir(['sifir.m4a'], async (dir) => {
  const { log, lines } = fakeLog();
  const repo = new TrackRepository({ dir, log, probeDuration: async () => 0 });
  assert.deepEqual(await repo.list(), []);
  assert.ok(lines.some((l) => l.level === 'warn' && /süre pozitif/.test(l.m)));
}));
