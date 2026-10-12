const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');

const {
  saveUploadedAudio, safeTrackName, saveZipUpload, readZipEntries, openZipEntry, candidateEntries,
  AudioJobs, createAudioService,
} = require('../../src/infrastructure/audio-upload');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ses-test-'));
const rd = (text) => Readable.from([Buffer.from(text)]);

// Sahte ffprobe/ffmpeg: probe "audio" döner (içerik "NOAUDIO" ise boş), ffmpeg çıktıyı yazar.
function fakeRun({ ffmpegCode = 0 } = {}) {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'ffprobe') {
      const content = fs.readFileSync(args[args.length - 1], 'utf8');
      return content.startsWith('NOAUDIO') ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: 'audio\n', stderr: '' };
    }
    if (ffmpegCode === 0) fs.writeFileSync(args[args.length - 1], 'M4A');
    return { code: ffmpegCode, stdout: '', stderr: 'boom' };
  };
  fn.calls = calls;
  return fn;
}

// Küçük zip üretici (test için): [{ name, data, deflate }]
function buildZip(items) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data, deflate } of items) {
    const raw = Buffer.from(data);
    const comp = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(deflate ? 8 : 0, 10);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(items.length, 8);
  eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

test('safeTrackName: uzantı atılır, yol ve tehlikeli karakterler temizlenir', () => {
  assert.equal(safeTrackName('Gece Yarısı.mp3'), 'Gece Yarısı');
  assert.equal(safeTrackName('../../etc/passwd'), 'passwd');
  assert.equal(safeTrackName('a\\b\\şarkı (2).m4v'), 'şarkı (2)');
  assert.equal(safeTrackName('???.mp3'), 'parca');
  assert.equal(safeTrackName(''), 'parca');
});

test('saveUploadedAudio: ses dönüştürülüp music/ içine .m4a olarak konur, geçici dosya kalmaz', async () => {
  const dir = tmp();
  const runFn = fakeRun();
  const out = await saveUploadedAudio({ readable: rd('veri'), musicDir: dir, filename: 'Şarkı.mp3', runFn });
  assert.equal(out.name, 'Şarkı.m4a');
  assert.equal(fs.readFileSync(path.join(dir, 'Şarkı.m4a'), 'utf8'), 'M4A');
  assert.deepEqual(fs.readdirSync(dir), ['Şarkı.m4a']);
  const args = runFn.calls.find((c) => c[0] === 'ffmpeg')[1];
  assert.ok(args.includes('-vn') && args.includes('aac') && args.includes('48000'));
});

test('saveUploadedAudio: aynı ad varsa (2) eklenir, üzerine yazmaz', async () => {
  const dir = tmp();
  await saveUploadedAudio({ readable: rd('a'), musicDir: dir, filename: 'x.mp3', runFn: fakeRun() });
  const second = await saveUploadedAudio({ readable: rd('b'), musicDir: dir, filename: 'x.m4v', runFn: fakeRun() });
  assert.equal(second.name, 'x (2).m4a');
});

test('saveUploadedAudio: sesi olmayan dosya reddedilir ve iz bırakmaz', async () => {
  const dir = tmp();
  await assert.rejects(
    () => saveUploadedAudio({ readable: rd('NOAUDIO...'), musicDir: dir, filename: 'resim.mp4', runFn: fakeRun() }),
    /ses bulunamadı/,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('saveUploadedAudio: ffmpeg hatası, boş dosya ve boyut sınırı', async () => {
  const dir = tmp();
  await assert.rejects(() => saveUploadedAudio({ readable: rd('x'), musicDir: dir, filename: 'a.mp3', runFn: fakeRun({ ffmpegCode: 1 }) }), /dönüştürülemedi/);
  await assert.rejects(() => saveUploadedAudio({ readable: Readable.from([]), musicDir: dir, filename: 'a.mp3', runFn: fakeRun() }), /boş/);
  await assert.rejects(() => saveUploadedAudio({ readable: rd('123456'), musicDir: dir, filename: 'a.mp3', runFn: fakeRun(), maxBytes: 3 }), /çok büyük/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('zip: girişler okunur (stored + deflate), gereksiz dosyalar elenir', async () => {
  const dir = tmp();
  const zipPath = path.join(dir, 't.zip');
  fs.writeFileSync(zipPath, buildZip([
    { name: 'album/bir.mp3', data: 'BIR', deflate: true },
    { name: 'album/iki.m4v', data: 'IKI', deflate: false },
    { name: 'album/kapak.jpg', data: 'JPG' },
    { name: '__MACOSX/album/._bir.mp3', data: 'X' },
    { name: 'album/', data: '' },
  ]));
  const entries = readZipEntries(zipPath);
  assert.equal(entries.length, 5);
  const candidates = candidateEntries(entries);
  assert.deepEqual(candidates.map((e) => e.name), ['album/bir.mp3', 'album/iki.m4v']);
  const read = async (entry) => {
    const chunks = [];
    for await (const c of openZipEntry(zipPath, entry)) chunks.push(c);
    return Buffer.concat(chunks).toString();
  };
  assert.equal(await read(candidates[0]), 'BIR');
  assert.equal(await read(candidates[1]), 'IKI');
});

test('zip: geçersiz dosya reddedilir', () => {
  const dir = tmp();
  const bad = path.join(dir, 'x.zip');
  fs.writeFileSync(bad, 'zip değil');
  assert.throws(() => readZipEntries(bad), /geçerli bir zip değil/);
});

test('AudioJobs: zip içindeki dosyalar tek tek işlenir, hatalılar raporlanır, zip silinir', async () => {
  const dir = tmp();
  const zipPath = path.join(dir, 'j.zip');
  fs.writeFileSync(zipPath, buildZip([
    { name: 'a.mp3', data: 'A', deflate: true },
    { name: 'b.mp3', data: 'NOAUDIO', deflate: true },
  ]));
  const musicDir = path.join(dir, 'music');
  const jobs = new AudioJobs({
    save: ({ readable, filename }) => saveUploadedAudio({ readable, filename, musicDir, runFn: fakeRun() }),
  });
  const id = jobs.start({ zipPath });
  for (let i = 0; i < 100 && jobs.status(id).state === 'running'; i += 1) await new Promise((r) => setTimeout(r, 20));
  const status = jobs.status(id);
  assert.equal(status.state, 'done');
  assert.deepEqual(status.added, ['a.m4a']);
  assert.equal(status.failed.length, 1);
  assert.equal(status.failed[0].name, 'b.mp3');
  assert.equal(fs.existsSync(zipPath), false);
});

test('createAudioService: .zip iş döner, diğerleri hemen kaydedilir', async () => {
  const albumsDir = tmp();
  const service = createAudioService({ albumsDir });
  const zipBuf = buildZip([{ name: 'x.txt', data: 'metin' }]);
  const res = await service.save({ album: 'mimi', filename: 'paket.zip', readable: Readable.from([zipBuf]) });
  assert.ok(res.job);
  for (let i = 0; i < 100 && service.status(res.job).state === 'running'; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(service.status(res.job).state, 'error');
  assert.match(service.status(res.job).error, /bulunamadı/);
  assert.equal(service.status('yok'), null);
});

test('saveZipUpload: gövde geçici zip dosyasına yazılır, sınır aşılırsa silinir', async () => {
  const dir = tmp();
  const file = await saveZipUpload({ readable: rd('PKdata'), dir });
  assert.equal(fs.readFileSync(file, 'utf8'), 'PKdata');
  await assert.rejects(() => saveZipUpload({ readable: rd('123456'), dir, maxBytes: 3 }), /çok büyük/);
  assert.equal(fs.readdirSync(dir).length, 1);
});
