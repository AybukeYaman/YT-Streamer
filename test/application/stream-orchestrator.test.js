const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { StreamOrchestrator } = require('../../src/application/stream-orchestrator');
const { Encoder } = require('../../src/application/encoder');
const { Track } = require('../../src/domain/track');
const { Album } = require('../../src/domain/album');

// Sözleşmeye uyan sahte encoder: çağrıları kaydeder, olayları test tetikler.
class FakeEncoder extends Encoder {
  constructor() {
    super();
    this.starts = [];
    this.stopCalls = 0;
  }
  start(options) { this.starts.push(options); }
  stop() {
    this.stopCalls++;
    setImmediate(() => this.emit('exit', 0, null));
    return new Promise((resolve) => this.once('exit', () => resolve()));
  }
}

function fakeLog() {
  const lines = [];
  const rec = (level) => (m) => lines.push({ level, m });
  return { log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }, lines };
}

const track = (name) => new Track({ path: `C:/music/${name}.m4a`, durationSeconds: 60 });
const TRACKS = ['a', 'b', 'c', 'd', 'e'].map(track);
const BG = 'C:/music-source/x/background.mp4';
const oneAlbum = (tracks) => ({ list: async () => [new Album({ name: 'x', backgroundPath: BG, tracks })] });

// Playlist yazımlarını bellekte tutar; her yazılan içerikten parça başlıklarını çıkarır.
function setup({ tracks = TRACKS, batchSize = 2, now, nowPlayingWriter } = {}) {
  const encoder = new FakeEncoder();
  const { log, lines } = fakeLog();
  const playlists = [];
  const orch = new StreamOrchestrator({
    encoder,
    log,
    albumRepository: oneAlbum(tracks),
    queue: { mode: 'sequential', batchSize },
    playlistPath: 'C:/runtime/playlist.txt',
    writeFile: (p, content) => playlists.push(content.trim().split('\n').map((l) => l.match(/\/(\w+)\.m4a'$/)[1]).join('')),
    ...(now ? { now } : {}),
    nowPlayingWriter,
  });
  return { encoder, orch, lines, playlists };
}

test('start: parçaları yükler, ilk playlist\'i yazar, encoder\'ı playlist modunda başlatır', async () => {
  const { encoder, orch, playlists } = setup();
  await orch.start();
  assert.deepEqual(playlists, ['ab']);
  assert.deepEqual(encoder.starts, [{ playlistPath: 'C:/runtime/playlist.txt', runNumber: 1, backgroundPath: BG }]);
  assert.equal(orch.running, true);
  await assert.rejects(orch.start(), /zaten çalışıyor/);
});

test('code=0 (playlist bitti): kuyruğun kaldığı yerden yeni playlist yazıp hemen yeniden başlatır', async () => {
  const { encoder, orch, playlists, lines } = setup();
  const exits = [];
  orch.on('exit', (e) => exits.push(e));
  await orch.start();
  encoder.emit('exit', 0, null);
  encoder.emit('exit', 0, null);
  assert.deepEqual(playlists, ['ab', 'cd', 'ea']); // baştan başlamıyor, sonsuz döngüde sarıyor
  assert.deepEqual(encoder.starts.map((s) => s.runNumber), [1, 2, 3]);
  assert.deepEqual(exits, []); // restart bir "çıkış" değil
  assert.equal(orch.running, true);
  assert.ok(lines.some((l) => l.level === 'info' && /playlist #1 bitti, yeniden başlatılıyor/.test(l.m)));
  assert.ok(!lines.some((l) => l.level === 'error'));
});

test('code!==0: loglanır, kendisi restart etmez, beklenmeyen çıkış bildirilir (karar supervisor\'da)', async () => {
  const { encoder, orch, lines } = setup();
  const exits = [];
  orch.on('exit', (e) => exits.push(e));
  await orch.start();
  encoder.emit('exit', 1, null);
  assert.equal(encoder.starts.length, 1);
  assert.deepEqual(exits, [{ expected: false, code: 1, signal: null }]);
  assert.equal(orch.running, false);
  assert.ok(lines.some((l) => l.level === 'error' && /beklenmeyen kapanış/.test(l.m)));
});

test('resume: çöken playlist o an çalan parçadan devam eder, kuyruk korunur', async () => {
  let t = 0;
  const { encoder, orch, playlists, lines } = setup({ batchSize: 4, now: () => t });
  await orch.start(); // abcd, 60'ar sn
  t = 1000;
  encoder.emit('log', { kind: 'progress', frame: 5, fps: 24, bitrateKbps: 2500, speed: 1 }); // ilk kare
  t = 1000 + 130 * 1000; // 130. sn → c çalıyor
  encoder.emit('exit', 1, null);
  await orch.resume();
  assert.deepEqual(playlists, ['abcd', 'cd']); // c baştan, d; a-b atlanmaz ama tekrar da edilmez
  assert.equal(orch.running, true);
  assert.ok(lines.some((l) => /playlist #2 \(kaldığı parçadan devam\): albüm "x", 2 parça/.test(l.m)));
  encoder.emit('exit', 0, null); // kalan bitti → kuyruk kaldığı yerden
  assert.deepEqual(playlists, ['abcd', 'cd', 'eabc']);
});

test('resume: hiç kare gelmeden çöktüyse aynı playlist baştan', async () => {
  const { encoder, orch, playlists } = setup({ batchSize: 2 });
  await orch.start();
  encoder.emit('exit', 1, null);
  await orch.resume();
  assert.deepEqual(playlists, ['ab', 'ab']);
});

test('resume: hiç başlamamışsa start gibi davranır; çalışırken hata verir', async () => {
  const { orch, playlists } = setup({ batchSize: 2 });
  await orch.resume();
  assert.deepEqual(playlists, ['ab']);
  await assert.rejects(orch.resume(), /zaten çalışıyor/);
});

test('stop: kapanış beklenen olarak bildirilir, restart yapılmaz', async () => {
  const { encoder, orch } = setup();
  const exits = [];
  orch.on('exit', (e) => exits.push(e));
  await orch.start();
  await orch.stop();
  assert.equal(encoder.stopCalls, 1);
  assert.equal(encoder.starts.length, 1); // stop sonrası code=0 restart sayılmadı
  assert.deepEqual(exits, [{ expected: true, code: 0, signal: null }]);
  assert.equal(orch.running, false);
});

test('çalışmıyorken stop bir şey yapmaz', async () => {
  const { encoder, orch } = setup();
  await orch.stop();
  assert.equal(encoder.stopCalls, 0);
});

test('boş music/: start açık hatayla düşer, running kalmaz', async () => {
  const { orch } = setup({ tracks: [] });
  await assert.rejects(orch.start(), /hiç parça yok/);
  assert.equal(orch.running, false);
});

test('restart boşluğu: önceki exit\'ten yeni sürecin ilk frame>0 satırına kadar ölçülür', async () => {
  let t = 1000;
  const { encoder, orch, lines } = setup({ now: () => t });
  await orch.start();
  encoder.emit('log', { kind: 'progress', frame: 100, fps: 24, bitrateKbps: 2500, speed: 1 });
  assert.deepEqual(orch.restartGapsMs, []); // ilk başlangıç restart değil
  t = 50000;
  encoder.emit('exit', 0, null);
  t = 50100;
  encoder.emit('log', { kind: 'progress', frame: 0, fps: 0, bitrateKbps: null, speed: null }); // henüz frame yok
  t = 50230;
  encoder.emit('log', { kind: 'progress', frame: 5, fps: 0, bitrateKbps: 1600, speed: 2.4 });
  encoder.emit('log', { kind: 'progress', frame: 20, fps: 24, bitrateKbps: 2500, speed: 1.3 });
  assert.deepEqual(orch.restartGapsMs, [230]);
  assert.ok(lines.some((l) => l.m.startsWith('restart boşluğu: 230 ms')));
});

test('encoder logları düzeylere dağıtılır, ilerleme 5 sn\'de bir', async () => {
  let t = 0;
  const { encoder, orch, lines } = setup({ now: () => t });
  await orch.start();
  encoder.emit('log', { kind: 'command', args: ['-i', 'x'] });
  encoder.emit('log', { kind: 'stderr', line: 'Stream mapping:' });
  encoder.emit('log', { kind: 'error', message: 'olmadı' });
  for (t = 0; t <= 12000; t += 500) {
    encoder.emit('log', { kind: 'progress', frame: t / 40, fps: 24, bitrateKbps: 2500, speed: 1 });
  }
  const progress = lines.filter((l) => l.m.startsWith('frame='));
  assert.equal(progress.length, 3); // t=0, 5000, 10000
  assert.ok(lines.some((l) => l.level === 'debug' && l.m === 'Stream mapping:'));
  assert.ok(lines.some((l) => l.level === 'error' && l.m === 'olmadı'));
  assert.ok(lines.some((l) => l.level === 'info' && l.m === 'ffmpeg başlatılıyor: -i x'));
});

// Overlay: TRACKS 60'ar sn. Başlık dosyaları playlist başında yazılır, encoder'a parça başına
// zaman aralığıyla verilir — zamanlama ffmpeg'de, Node tarafında frame takibi yok.
function setupOverlay(opts) {
  const batches = [];
  const nowPlayingWriter = {
    writeAll: (titles) => { batches.push(titles); return titles.map((t) => `C:/rt/overlay/${t}.txt`); },
  };
  return { ...setup({ ...opts, nowPlayingWriter }), batches };
}

test('overlay: başlıklar playlist başında yazılır, encoder\'a parça başına aralıkla verilir', async () => {
  const { encoder, orch, batches } = setupOverlay({ batchSize: 3 });
  await orch.start();
  assert.deepEqual(batches, [['a', 'b', 'c']]);
  assert.deepEqual(encoder.starts[0].overlayTexts, [
    { textFile: 'C:/rt/overlay/a.txt', start: 0, end: 60 },
    { textFile: 'C:/rt/overlay/b.txt', start: 60, end: 120 },
    { textFile: 'C:/rt/overlay/c.txt', start: 120, end: null }, // son parça açık uçlu
  ]);
});

test('overlay: her restart\'ta yeni playlist\'in başlıkları yazılır, zaman 0\'dan başlar', async () => {
  const { encoder, orch, batches } = setupOverlay({ batchSize: 2 });
  await orch.start();
  encoder.emit('exit', 0, null);
  assert.deepEqual(batches, [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(encoder.starts[1].overlayTexts.map((o) => [o.start, o.end]), [[0, 60], [60, null]]);
});

test('overlay: writer verilmezse (overlay kapalı) encoder\'a overlayTexts geçmez', async () => {
  const { encoder, orch } = setup();
  await orch.start();
  assert.deepEqual(encoder.starts[0], { playlistPath: 'C:/runtime/playlist.txt', runNumber: 1, backgroundPath: BG });
});

test('overlay: restart\'ta başlıklar yazılamazsa hata loglanır, beklenmeyen çıkış bildirilir', async () => {
  let fail = false;
  const nowPlayingWriter = { writeAll: (titles) => { if (fail) throw new Error('EACCES'); return titles; } };
  const { encoder, orch, lines } = setup({ nowPlayingWriter });
  const exits = [];
  orch.on('exit', (e) => exits.push(e));
  await orch.start();
  fail = true;
  encoder.emit('exit', 0, null);
  assert.ok(lines.some((l) => l.level === 'error' && /yeniden başlatılamadı: EACCES/.test(l.m)));
  assert.deepEqual(exits, [{ expected: false, code: 0, signal: null }]);
});

test('hız penceresi: uyarı sadece durum değişince (bir kez), normale dönüş bilgi olarak; restart ısınmaya döner', async () => {
  const { SpeedWindow } = require('../../src/domain/speed-window');
  let t = 0;
  const speedWindow = new SpeedWindow({ fps: 24 });
  const encoder = new FakeEncoder();
  const { log, lines } = fakeLog();
  const orch = new StreamOrchestrator({
    encoder, log, albumRepository: oneAlbum(TRACKS), queue: { mode: 'sequential', batchSize: 2 },
    playlistPath: 'p', writeFile: () => {}, speedWindow, now: () => t,
  });
  await orch.start();
  let frame = 0;
  const run = (untilMs, speed) => {
    for (; t <= untilMs; t += 500) {
      encoder.emit('log', { kind: 'progress', frame: Math.round(frame), fps: 24, bitrateKbps: 2500, speed: 1 });
      frame += speed * 12;
    }
  };
  run(70000, 1);
  run(110000, 0.8); // yavaşlama
  run(160000, 1); // toparlanma
  const warns = lines.filter((l) => l.level === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0].m, /^encode yetişemiyor: hız\(30sn\)=0\.\d+x < 0.95$/);
  assert.equal(lines.filter((l) => /^hız normale döndü/.test(l.m)).length, 1);
  assert.ok(lines.some((l) => /hız\(30sn\)=ısınıyor/.test(l.m)));
  assert.ok(lines.some((l) => /hız\(30sn\)=1\.0\d\dx|hız\(30sn\)=0\.99\dx/.test(l.m)));
  encoder.emit('exit', 0, null); // restart: pencere sıfırlanır
  assert.equal(speedWindow.samples.length, 0);
});

test('application katmanı child_process, fs ya da infrastructure import etmez', () => {
  const dir = path.join(__dirname, '..', '..', 'src', 'application');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(src, /require\(['"](node:)?child_process['"]\)/, `${file} child_process import ediyor`);
    assert.doesNotMatch(src, /require\(['"](node:)?fs(\/promises)?['"]\)/, `${file} fs import ediyor (dosya I/O infrastructure'ın işi)`);
    assert.doesNotMatch(src, /require\(['"][^'"]*infrastructure/, `${file} infrastructure import ediyor`);
  }
});

test('albümler: her playlist tek albüm, arkaplan albümle değişir; çökmede aynı albümle devam', async () => {
  const bg = (n) => `C:/ms/${n}/background.mp4`;
  const albums = [
    new Album({ name: 'A', backgroundPath: bg('A'), tracks: ['a1', 'a2', 'a3'].map(track) }),
    new Album({ name: 'B', backgroundPath: bg('B'), tracks: ['b1'].map(track) }),
  ];
  const encoder = new FakeEncoder();
  const { log } = fakeLog();
  const playlists = [];
  const orch = new StreamOrchestrator({
    encoder, log, albumRepository: { list: async () => albums }, queue: { mode: 'sequential', batchSize: 2 },
    playlistPath: 'p', writeFile: (p, c) => playlists.push(c.trim().split('\n').map((l) => l.match(/\/(\w+)\.m4a'$/)[1]).join(',')),
  });
  await orch.start();
  encoder.emit('exit', 0, null); // playlist bitti → sıradaki albüm
  encoder.emit('exit', 0, null);
  assert.deepEqual(playlists, ['a1,a2', 'b1', 'a3,a1']); // albüm kısa ise batch albüm kadar; A kaldığı yerden
  assert.deepEqual(encoder.starts.map((s) => s.backgroundPath), [bg('A'), bg('B'), bg('A')]);

  encoder.emit('exit', 1, null); // çökme: aynı albümün arkaplanıyla devam
  await orch.resume();
  assert.equal(encoder.starts.at(-1).backgroundPath, bg('A'));
});
