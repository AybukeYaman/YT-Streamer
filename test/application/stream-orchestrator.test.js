const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { StreamOrchestrator } = require('../../src/application/stream-orchestrator');
const { Encoder } = require('../../src/application/encoder');
const { Track } = require('../../src/domain/track');

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

// Playlist yazımlarını bellekte tutar; her yazılan içerikten parça başlıklarını çıkarır.
function setup({ tracks = TRACKS, batchSize = 2, now } = {}) {
  const encoder = new FakeEncoder();
  const { log, lines } = fakeLog();
  const playlists = [];
  const orch = new StreamOrchestrator({
    encoder,
    log,
    trackRepository: { list: async () => tracks },
    queue: { mode: 'sequential', batchSize },
    playlistPath: 'C:/runtime/playlist.txt',
    writeFile: (p, content) => playlists.push(content.trim().split('\n').map((l) => l.match(/\/(\w+)\.m4a'$/)[1]).join('')),
    ...(now ? { now } : {}),
  });
  return { encoder, orch, lines, playlists };
}

test('start: parçaları yükler, ilk playlist\'i yazar, encoder\'ı playlist modunda başlatır', async () => {
  const { encoder, orch, playlists } = setup();
  await orch.start();
  assert.deepEqual(playlists, ['ab']);
  assert.deepEqual(encoder.starts, [{ playlistPath: 'C:/runtime/playlist.txt', runNumber: 1 }]);
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

test('code!==0: loglanır, restart denenmez, beklenmeyen çıkış bildirilir', async () => {
  const { encoder, orch, lines } = setup();
  const exits = [];
  orch.on('exit', (e) => exits.push(e));
  await orch.start();
  encoder.emit('exit', 1, null);
  assert.equal(encoder.starts.length, 1);
  assert.deepEqual(exits, [{ expected: false, code: 1, signal: null }]);
  assert.equal(orch.running, false);
  assert.ok(lines.some((l) => l.level === 'error' && /restart denenmiyor/.test(l.m)));
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

test('application katmanı child_process, fs ya da infrastructure import etmez', () => {
  const dir = path.join(__dirname, '..', '..', 'src', 'application');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(src, /require\(['"](node:)?child_process['"]\)/, `${file} child_process import ediyor`);
    assert.doesNotMatch(src, /require\(['"](node:)?fs(\/promises)?['"]\)/, `${file} fs import ediyor (dosya I/O infrastructure'ın işi)`);
    assert.doesNotMatch(src, /require\(['"][^'"]*infrastructure/, `${file} infrastructure import ediyor`);
  }
});
