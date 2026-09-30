const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { StreamControlService } = require('../../src/application/stream-control-service');

// ─── Sahte bağımlılıklar ─────────────────────────────────────────────────

// Minimal sahte Encoder: progress ve command olayları yayar.
class FakeEncoder extends EventEmitter {
  constructor() { super(); this.running = false; }
  emitProgress({ frame = 100, fps = 30, bitrateKbps = 3500, speed = 1.0 } = {}) {
    this.emit('log', { kind: 'progress', frame, fps, bitrateKbps, speed });
  }
  emitCommand(args = ['-i', 'test']) {
    this.emit('log', { kind: 'command', args });
  }
}

// Minimal sahte Orchestrator: getPlaybackState() döndürür (StreamControlService buna bağımlı).
function fakeOrchestrator(overrides = {}) {
  const state = {
    running: false,
    stopping: false,
    runNumber: 0,
    currentTracks: null,
    currentAlbum: null,
    playStartedAt: null,
    ...overrides,
  };
  return {
    ...state,
    getPlaybackState() {
      return Object.freeze({
        running: this.running,
        stopping: this.stopping,
        stopRequested: this.stopRequested,
        runNumber: this.runNumber,
        currentTracks: this.currentTracks,
        currentAlbum: this.currentAlbum,
        playStartedAt: this.playStartedAt,
      });
    },
  };
}

// Minimal sahte Supervisor: getSnapshot() döndürür, start/stop çağrılarını kaydeder.
function fakeSupervisor(overrides = {}) {
  return {
    lastStartAt: null,
    gaveUp: false,
    pendingRestart: false, // test senaryolarında ayarlanır
    calls: [],
    async start() { this.calls.push('start'); },
    async stop() { this.calls.push('stop'); },
    getSnapshot() {
      return Object.freeze({
        lastStartAt: this.lastStartAt,
        gaveUp: this.gaveUp,
        pendingRestart: this.pendingRestart,
      });
    },
    ...overrides,
  };
}

function fakeLog() {
  const lines = [];
  return {
    lines,
    info: (m) => lines.push({ level: 'info', m }),
    warn: (m) => lines.push({ level: 'warn', m }),
    error: (m) => lines.push({ level: 'error', m }),
  };
}

// Sahte parçalar ve albüm
function makeTracks(durations) {
  return durations.map((d, i) => ({
    path: `/music/track${i + 1}.mp3`,
    title: `Track ${i + 1}`,
    durationSeconds: d,
  }));
}

function makeAlbum(name, trackDurations) {
  const tracks = makeTracks(trackDurations);
  return { name, backgroundPath: `/bg/${name}.mp4`, tracks: Object.freeze(tracks) };
}

// Standart test kurulumu
function setup({ orchOverrides = {}, supOverrides = {}, nowValue = 1000000 } = {}) {
  const encoder = new FakeEncoder();
  const orchestrator = fakeOrchestrator(orchOverrides);
  const supervisor = fakeSupervisor(supOverrides);
  const log = fakeLog();
  const now = () => nowValue;
  const svc = new StreamControlService({ orchestrator, supervisor, encoder, log, now });
  return { svc, encoder, orchestrator, supervisor, log };
}

// ═══════════════════════════════════════════════════════════════════════════
// getStatus
// ═══════════════════════════════════════════════════════════════════════════

test('getStatus: yayın çalışmıyorken stopped döner', () => {
  const { svc } = setup();
  const status = svc.getStatus();
  assert.equal(status.state, 'stopped');
  assert.equal(status.uptime, 0);
  assert.equal(status.fps, null);
  assert.equal(status.bitrateKbps, null);
  assert.equal(status.speed, null);
  assert.equal(status.runNumber, 0);
});

test('getStatus: yayın çalışırken running döner', () => {
  const { svc } = setup({
    orchOverrides: { running: true, playStartedAt: 990000, runNumber: 3 },
    supOverrides: { lastStartAt: 980000 },
    nowValue: 1000000,
  });
  const status = svc.getStatus();
  assert.equal(status.state, 'running');
  assert.equal(status.uptime, 20); // (1000000 - 980000) / 1000
  assert.equal(status.runNumber, 3);
});

test('getStatus: ilk kare gelmeden restarting döner', () => {
  const { svc } = setup({
    orchOverrides: { running: true, playStartedAt: null, runNumber: 1 },
    supOverrides: { lastStartAt: 999000 },
    nowValue: 1000000,
  });
  assert.equal(svc.getStatus().state, 'restarting');
});

test('getStatus: supervisor vazgeçmişse error döner', () => {
  const { svc } = setup({
    orchOverrides: { running: false },
    supOverrides: { gaveUp: true },
  });
  assert.equal(svc.getStatus().state, 'error');
});

test('getStatus: stopping true iken stopped döner', () => {
  const { svc } = setup({
    orchOverrides: { running: true, stopping: true },
  });
  assert.equal(svc.getStatus().state, 'stopped');
});

test('getStatus: encoder progress olayından fps/bitrate/speed güncellenir', () => {
  const { svc, encoder } = setup({
    orchOverrides: { running: true, playStartedAt: 990000, runNumber: 1 },
    supOverrides: { lastStartAt: 980000 },
  });
  assert.equal(svc.getStatus().fps, null);
  encoder.emitProgress({ fps: 29.97, bitrateKbps: 4200, speed: 1.01 });
  const status = svc.getStatus();
  assert.equal(status.fps, 29.97);
  assert.equal(status.bitrateKbps, 4200);
  assert.equal(status.speed, 1.01);
});

test('getStatus: sadece progress olayları yakalanır, stderr/error yoksayılır', () => {
  const { svc, encoder } = setup();
  encoder.emit('log', { kind: 'stderr', line: 'some ffmpeg output' });
  encoder.emit('log', { kind: 'error', message: 'hata' });
  assert.equal(svc.getStatus().fps, null);
});

test('getStatus: uptime yayın çalışmıyorken 0 döner (lastStartAt olsa bile)', () => {
  const { svc } = setup({
    orchOverrides: { running: false },
    supOverrides: { lastStartAt: 900000 },
    nowValue: 1000000,
  });
  assert.equal(svc.getStatus().uptime, 0);
});

// ─── FIX 1: crash → restart timer arasında restarting state ──────────────

test('getStatus: crash sonrası supervisor timer bekliyorken restarting döner (stopped değil)', () => {
  // Senaryo: FFmpeg code=1 ile düştü, orchestrator.running=false,
  // supervisor 3 sn timer kurdu (pendingRestart=true)
  const { svc } = setup({
    orchOverrides: { running: false, stopping: false },
    supOverrides: { gaveUp: false, pendingRestart: true },
  });
  assert.equal(svc.getStatus().state, 'restarting');
});

test('getStatus: supervisor timer yoksa ve running=false ise stopped döner', () => {
  const { svc } = setup({
    orchOverrides: { running: false, stopping: false },
    supOverrides: { gaveUp: false, pendingRestart: false },
  });
  assert.equal(svc.getStatus().state, 'stopped');
});

test('getStatus: gaveUp true iken pendingRestart true olsa bile error döner (gaveUp öncelikli)', () => {
  const { svc } = setup({
    orchOverrides: { running: false },
    supOverrides: { gaveUp: true, pendingRestart: true },
  });
  assert.equal(svc.getStatus().state, 'error');
});

// ═══════════════════════════════════════════════════════════════════════════
// getCurrentTrack
// ═══════════════════════════════════════════════════════════════════════════

test('getCurrentTrack: yayın çalışmıyorken null döner', () => {
  const { svc } = setup();
  assert.equal(svc.getCurrentTrack(), null);
});

test('getCurrentTrack: currentTracks null iken null döner', () => {
  const { svc } = setup({ orchOverrides: { running: true, currentTracks: null } });
  assert.equal(svc.getCurrentTrack(), null);
});

test('getCurrentTrack: ilk parça çalıyorken doğru bilgiyi döndürür', () => {
  const album = makeAlbum('LoFi Beats', [180, 240, 200]);
  const { svc } = setup({
    orchOverrides: {
      running: true, currentTracks: album.tracks, currentAlbum: album,
      playStartedAt: 1000000 - 60000,
    },
    nowValue: 1000000,
  });
  const track = svc.getCurrentTrack();
  assert.equal(track.albumName, 'LoFi Beats');
  assert.equal(track.trackTitle, 'Track 1');
  assert.equal(track.trackDuration, 180);
  assert.equal(track.elapsedSeconds, 60);
  assert.equal(track.remainingSeconds, 120);
});

test('getCurrentTrack: ikinci parça çalıyorken doğru bilgiyi döndürür', () => {
  const album = makeAlbum('Jazz', [100, 200, 150]);
  const { svc } = setup({
    orchOverrides: {
      running: true, currentTracks: album.tracks, currentAlbum: album,
      playStartedAt: 1000000 - 130000,
    },
    nowValue: 1000000,
  });
  const track = svc.getCurrentTrack();
  assert.equal(track.trackTitle, 'Track 2');
  assert.equal(track.trackDuration, 200);
  assert.equal(track.elapsedSeconds, 30);
  assert.equal(track.remainingSeconds, 170);
});

test('getCurrentTrack: son parça çalıyorken doğru bilgiyi döndürür', () => {
  const album = makeAlbum('Ambient', [100, 100, 300]);
  const { svc } = setup({
    orchOverrides: {
      running: true, currentTracks: album.tracks, currentAlbum: album,
      playStartedAt: 1000000 - 250000,
    },
    nowValue: 1000000,
  });
  const track = svc.getCurrentTrack();
  assert.equal(track.trackTitle, 'Track 3');
  assert.equal(track.trackDuration, 300);
  assert.equal(track.elapsedSeconds, 50);
  assert.equal(track.remainingSeconds, 250);
});

test('getCurrentTrack: playStartedAt null iken ilk parça 0 sn ile döner', () => {
  const album = makeAlbum('Chill', [180, 200]);
  const { svc } = setup({
    orchOverrides: {
      running: true, currentTracks: album.tracks, currentAlbum: album,
      playStartedAt: null,
    },
  });
  const track = svc.getCurrentTrack();
  assert.equal(track.trackTitle, 'Track 1');
  assert.equal(track.elapsedSeconds, 0);
  assert.equal(track.remainingSeconds, 180);
});

test('getCurrentTrack: tek parçalı playlist', () => {
  const album = makeAlbum('Single', [300]);
  const { svc } = setup({
    orchOverrides: {
      running: true, currentTracks: album.tracks, currentAlbum: album,
      playStartedAt: 1000000 - 120000,
    },
    nowValue: 1000000,
  });
  const track = svc.getCurrentTrack();
  assert.equal(track.trackTitle, 'Track 1');
  assert.equal(track.elapsedSeconds, 120);
  assert.equal(track.remainingSeconds, 180);
});

test('getCurrentTrack: toplam süreden fazla zaman geçmişse son parça, remaining 0', () => {
  const album = makeAlbum('Short', [60, 60]);
  const { svc } = setup({
    orchOverrides: {
      running: true, currentTracks: album.tracks, currentAlbum: album,
      playStartedAt: 1000000 - 180000,
    },
    nowValue: 1000000,
  });
  const track = svc.getCurrentTrack();
  assert.equal(track.trackTitle, 'Track 2');
  assert.equal(track.remainingSeconds, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// getUpcomingQueue
// ═══════════════════════════════════════════════════════════════════════════

test('getUpcomingQueue: yayın çalışmıyorken boş dizi döner', () => {
  const { svc } = setup();
  assert.deepEqual(svc.getUpcomingQueue(), []);
});

test('getUpcomingQueue: currentTracks null iken boş dizi döner', () => {
  const { svc } = setup({ orchOverrides: { running: true, currentTracks: null } });
  assert.deepEqual(svc.getUpcomingQueue(), []);
});

test('getUpcomingQueue: ilk parça çalıyorken sonraki parçaları döndürür', () => {
  const album = makeAlbum('LoFi', [180, 240, 200, 150]);
  const { svc } = setup({
    orchOverrides: {
      running: true, currentTracks: album.tracks, currentAlbum: album,
      playStartedAt: 1000000 - 60000,
    },
    nowValue: 1000000,
  });
  const queue = svc.getUpcomingQueue();
  assert.equal(queue.length, 3);
  assert.equal(queue[0].trackTitle, 'Track 2');
  assert.equal(queue[0].albumName, 'LoFi');
  assert.equal(queue[0].duration, 240);
  assert.equal(queue[1].trackTitle, 'Track 3');
  assert.equal(queue[2].trackTitle, 'Track 4');
});

test('getUpcomingQueue: son parça çalıyorken boş dizi döner', () => {
  const album = makeAlbum('End', [100, 100]);
  const { svc } = setup({
    orchOverrides: {
      running: true, currentTracks: album.tracks, currentAlbum: album,
      playStartedAt: 1000000 - 150000,
    },
    nowValue: 1000000,
  });
  assert.deepEqual(svc.getUpcomingQueue(), []);
});

test('getUpcomingQueue: limit parametresi sonuç sayısını kısıtlar', () => {
  const album = makeAlbum('Long', [60, 60, 60, 60, 60, 60, 60, 60, 60, 60]);
  const { svc } = setup({
    orchOverrides: {
      running: true, currentTracks: album.tracks, currentAlbum: album,
      playStartedAt: 1000000 - 10000,
    },
    nowValue: 1000000,
  });
  const queue = svc.getUpcomingQueue(3);
  assert.equal(queue.length, 3);
  assert.equal(queue[0].trackTitle, 'Track 2');
  assert.equal(queue[2].trackTitle, 'Track 4');
});

test('getUpcomingQueue: limit toplam kalan parçalardan büyükse mümkün kadarını döndürür', () => {
  const album = makeAlbum('Short', [60, 60, 60]);
  const { svc } = setup({
    orchOverrides: {
      running: true, currentTracks: album.tracks, currentAlbum: album,
      playStartedAt: 1000000 - 10000,
    },
    nowValue: 1000000,
  });
  assert.equal(svc.getUpcomingQueue(100).length, 2);
});

test('getUpcomingQueue: varsayılan limit 10', () => {
  const durations = Array.from({ length: 15 }, () => 60);
  const album = makeAlbum('Big', durations);
  const { svc } = setup({
    orchOverrides: {
      running: true, currentTracks: album.tracks, currentAlbum: album,
      playStartedAt: 1000000 - 10000,
    },
    nowValue: 1000000,
  });
  assert.equal(svc.getUpcomingQueue().length, 10);
});

test('getUpcomingQueue: playStartedAt null iken ilk parçadan sonrakiler döner', () => {
  const album = makeAlbum('Fresh', [180, 240, 200]);
  const { svc } = setup({
    orchOverrides: {
      running: true, currentTracks: album.tracks, currentAlbum: album,
      playStartedAt: null,
    },
  });
  const queue = svc.getUpcomingQueue();
  assert.equal(queue.length, 2);
  assert.equal(queue[0].trackTitle, 'Track 2');
});

// ═══════════════════════════════════════════════════════════════════════════
// start
// ═══════════════════════════════════════════════════════════════════════════

test('start: supervisor.start() çağrılır', async () => {
  const { svc, supervisor, log } = setup();
  await svc.start();
  assert.deepEqual(supervisor.calls, ['start']);
  assert.ok(log.lines.some((l) => l.level === 'info' && /başlatma komutu/.test(l.m)));
});

test('start: supervisor.start() hata fırlatırsa hata iletilir', async () => {
  const { svc } = setup({
    supOverrides: {
      lastStartAt: null,
      gaveUp: false,
      pendingRestart: false,
      calls: [],
      async start() { throw new Error('zaten çalışıyor'); },
      async stop() {},
      getSnapshot() {
        return Object.freeze({ lastStartAt: this.lastStartAt, gaveUp: this.gaveUp, pendingRestart: false });
      },
    },
  });
  await assert.rejects(() => svc.start(), { message: 'zaten çalışıyor' });
});

// ═══════════════════════════════════════════════════════════════════════════
// stop
// ═══════════════════════════════════════════════════════════════════════════

test('stop: supervisor.stop() çağrılır ve lastProgress sıfırlanır', async () => {
  const { svc, supervisor, encoder, log } = setup({
    orchOverrides: { running: true, playStartedAt: 990000 },
    supOverrides: { lastStartAt: 980000 },
  });
  encoder.emitProgress({ fps: 30, bitrateKbps: 3500, speed: 1.0 });
  assert.notEqual(svc.lastProgress, null);

  await svc.stop();
  assert.deepEqual(supervisor.calls, ['stop']);
  assert.equal(svc.lastProgress, null);
  assert.ok(log.lines.some((l) => l.level === 'info' && /durdurma komutu/.test(l.m)));
});

test('stop: yayın çalışmıyorken de güvenli (idempotent)', async () => {
  const { svc, supervisor } = setup();
  await svc.stop();
  assert.deepEqual(supervisor.calls, ['stop']);
});

// ─── FIX 3: stop race condition — progress encoder kapanana kadar yoksayılır ─

test('stop: supervisor.stop() bekleme sırasında gelen progress yoksayılır', async () => {
  let resolveStop;
  const encoder = new FakeEncoder();
  const orchestrator = fakeOrchestrator({ running: true, playStartedAt: 990000 });
  const supervisor = {
    lastStartAt: 980000,
    gaveUp: false,
    pendingRestart: false,
    calls: [],
    async start() { this.calls.push('start'); },
    // stop() resolve olmadan önce encoder birkaç progress daha yayar
    async stop() {
      this.calls.push('stop');
      // Encoder henüz kapanmadı — birkaç progress daha gönderiyor
      encoder.emitProgress({ fps: 28, bitrateKbps: 3200, speed: 0.98 });
      encoder.emitProgress({ fps: 27, bitrateKbps: 3100, speed: 0.97 });
    },
    getSnapshot() {
      return Object.freeze({ lastStartAt: this.lastStartAt, gaveUp: false, pendingRestart: false });
    },
  };
  const log = fakeLog();
  const svc = new StreamControlService({ orchestrator, supervisor, encoder, log, now: () => 1000000 });

  // Önce progress gelsin
  encoder.emitProgress({ fps: 30, bitrateKbps: 3500, speed: 1.0 });
  assert.equal(svc.lastProgress.fps, 30);

  await svc.stop();
  // stop sırasında gelen progress'ler yoksayıldı, lastProgress null
  assert.equal(svc.lastProgress, null);
});

test('stop: suppressProgress, stop() resolve olduktan sonra false döner (start tekrar çalışabilsin)', async () => {
  const { svc } = setup();
  await svc.stop();
  assert.equal(svc.suppressProgress, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// restart
// ═══════════════════════════════════════════════════════════════════════════

test('restart: önce stop sonra start çağrılır (sırasıyla)', async () => {
  const { svc, supervisor, log } = setup();
  await svc.restart();
  assert.deepEqual(supervisor.calls, ['stop', 'start']);
  assert.ok(log.lines.some((l) => l.level === 'info' && /yeniden başlatma komutu/.test(l.m)));
});

test('restart: lastProgress temizlenir ve suppressProgress false döner', async () => {
  const { svc, encoder } = setup({
    orchOverrides: { running: true, playStartedAt: 990000 },
    supOverrides: { lastStartAt: 980000 },
  });
  encoder.emitProgress({ fps: 30, bitrateKbps: 3500, speed: 1.0 });
  assert.notEqual(svc.lastProgress, null);
  await svc.restart();
  assert.equal(svc.lastProgress, null);
  assert.equal(svc.suppressProgress, false);
});

test('restart: stop hata fırlatırsa start çağrılmaz ve hata iletilir', async () => {
  const { svc, supervisor } = setup({
    supOverrides: {
      lastStartAt: null, gaveUp: false, pendingRestart: false, calls: [],
      async start() { this.calls.push('start'); },
      async stop() { this.calls.push('stop'); throw new Error('durdurma hatası'); },
      getSnapshot() { return Object.freeze({ lastStartAt: null, gaveUp: false, pendingRestart: false }); },
    },
  });
  await assert.rejects(() => svc.restart(), { message: 'durdurma hatası' });
  assert.deepEqual(supervisor.calls, ['stop']); // start'a ulaşmadı
});

// ═══════════════════════════════════════════════════════════════════════════
// FIX 2: stale progress — yeni FFmpeg süreci başladığında progress sıfırlanır
// ═══════════════════════════════════════════════════════════════════════════

test('command olayı lastProgress\'ı sıfırlar (yeni FFmpeg süreci, eski değerler geçersiz)', () => {
  const { svc, encoder } = setup({
    orchOverrides: { running: true, playStartedAt: 990000 },
    supOverrides: { lastStartAt: 980000 },
  });
  // Eski progress
  encoder.emitProgress({ fps: 30, bitrateKbps: 3500, speed: 1.0 });
  assert.equal(svc.lastProgress.fps, 30);

  // Yeni FFmpeg süreci başlıyor
  encoder.emitCommand(['-i', 'new_playlist.txt']);
  assert.equal(svc.lastProgress, null);
  assert.equal(svc.getStatus().fps, null);
  assert.equal(svc.getStatus().bitrateKbps, null);
  assert.equal(svc.getStatus().speed, null);
});

test('playlist bitip yeni playlist başladığında progress stale kalmaz', () => {
  const { svc, encoder } = setup({
    orchOverrides: { running: true, playStartedAt: 990000, runNumber: 1 },
    supOverrides: { lastStartAt: 980000 },
  });
  // Eski playlist'in son progress'i
  encoder.emitProgress({ fps: 30, bitrateKbps: 3500, speed: 1.0 });
  assert.equal(svc.lastProgress.fps, 30);

  // Playlist bitti, yeni FFmpeg başlıyor → command olayı
  encoder.emitCommand();
  assert.equal(svc.lastProgress, null);

  // Yeni progress gelince güncellenir
  encoder.emitProgress({ fps: 25, bitrateKbps: 2800, speed: 0.95 });
  assert.equal(svc.lastProgress.fps, 25);
  assert.equal(svc.lastProgress.bitrateKbps, 2800);
});

// ═══════════════════════════════════════════════════════════════════════════
// Public getter'lar doğru çalışıyor mu?
// ═══════════════════════════════════════════════════════════════════════════

test('getPlaybackState: StreamControlService getter üzerinden okur, doğrudan property erişimi yok', () => {
  // Bu test StreamControlService'in getPlaybackState() kullandığını doğrular:
  // getPlaybackState() dönmeyen bir orchestrator ile çalışmaz.
  const encoder = new FakeEncoder();
  const log = fakeLog();
  const brokenOrchestrator = { /* getPlaybackState yok — crash olmalı */ };
  const supervisor = fakeSupervisor();
  const svc = new StreamControlService({ orchestrator: brokenOrchestrator, supervisor, encoder, log });
  assert.throws(() => svc.getStatus(), /getPlaybackState is not a function/);
});

test('getSnapshot: StreamControlService getter üzerinden okur, doğrudan property erişimi yok', () => {
  const encoder = new FakeEncoder();
  const log = fakeLog();
  const orchestrator = fakeOrchestrator();
  const brokenSupervisor = {
    calls: [],
    async start() {},
    async stop() {},
    /* getSnapshot yok — crash olmalı */
  };
  const svc = new StreamControlService({ orchestrator, supervisor: brokenSupervisor, encoder, log });
  assert.throws(() => svc.getStatus(), /getSnapshot is not a function/);
});

// ═══════════════════════════════════════════════════════════════════════════
// Entegrasyon senaryoları
// ═══════════════════════════════════════════════════════════════════════════

test('tam akış: start → progress → getCurrentTrack → getUpcomingQueue → stop', async () => {
  const encoder = new FakeEncoder();
  const album = makeAlbum('Cozy Autumn', [120, 180, 240]);
  let currentTime = 1000000;

  const orchestrator = fakeOrchestrator({
    running: false, runNumber: 0, currentTracks: null, currentAlbum: null, playStartedAt: null,
  });

  const supervisor = {
    lastStartAt: null,
    gaveUp: false,
    pendingRestart: false,
    calls: [],
    async start() {
      this.calls.push('start');
      this.lastStartAt = currentTime;
      orchestrator.running = true;
      orchestrator.runNumber = 1;
      orchestrator.currentTracks = album.tracks;
      orchestrator.currentAlbum = album;
      orchestrator.playStartedAt = currentTime;
    },
    async stop() {
      this.calls.push('stop');
      orchestrator.running = false;
      orchestrator.stopping = false;
    },
    getSnapshot() {
      return Object.freeze({
        lastStartAt: this.lastStartAt, gaveUp: this.gaveUp, pendingRestart: this.pendingRestart,
      });
    },
  };

  const log = fakeLog();
  const svc = new StreamControlService({
    orchestrator, supervisor, encoder, log, now: () => currentTime,
  });

  // 1) Başlangıçta stopped
  assert.equal(svc.getStatus().state, 'stopped');
  assert.equal(svc.getCurrentTrack(), null);
  assert.deepEqual(svc.getUpcomingQueue(), []);

  // 2) Start
  await svc.start();
  assert.equal(svc.getStatus().state, 'running');

  // 3) 60 sn sonra — ilk parça çalıyor
  currentTime += 60000;
  encoder.emitProgress({ fps: 30, bitrateKbps: 3500, speed: 1.0 });
  assert.equal(svc.getStatus().fps, 30);
  assert.equal(svc.getStatus().runNumber, 1);

  const track = svc.getCurrentTrack();
  assert.equal(track.albumName, 'Cozy Autumn');
  assert.equal(track.trackTitle, 'Track 1');
  assert.equal(track.elapsedSeconds, 60);

  const queue = svc.getUpcomingQueue();
  assert.equal(queue.length, 2);
  assert.equal(queue[0].trackTitle, 'Track 2');

  // 4) 120 sn sonra — ikinci parçaya geçti
  currentTime += 60000;
  const track2 = svc.getCurrentTrack();
  assert.equal(track2.trackTitle, 'Track 2');
  assert.equal(track2.elapsedSeconds, 0);
  assert.equal(svc.getUpcomingQueue().length, 1);

  // 5) Stop
  await svc.stop();
  assert.equal(svc.getStatus().state, 'stopped');
  assert.equal(svc.getCurrentTrack(), null);
  assert.equal(svc.lastProgress, null);
});

test('crash → restarting → running tam akış', () => {
  // Senaryo: yayın çalışıyor → crash → supervisor timer bekliyor → restart → running
  const encoder = new FakeEncoder();
  const album = makeAlbum('Night', [180, 240]);

  const orchestrator = fakeOrchestrator({
    running: true, runNumber: 1, currentTracks: album.tracks,
    currentAlbum: album, playStartedAt: 990000,
  });

  const supervisor = fakeSupervisor({ lastStartAt: 980000 });
  const log = fakeLog();
  const svc = new StreamControlService({ orchestrator, supervisor, encoder, log, now: () => 1000000 });

  // 1) Çalışıyor
  encoder.emitProgress({ fps: 30, bitrateKbps: 3500, speed: 1.0 });
  assert.equal(svc.getStatus().state, 'running');
  assert.equal(svc.lastProgress.fps, 30);

  // 2) FFmpeg crash → orchestrator durdu, supervisor timer kurdu
  orchestrator.running = false;
  orchestrator.stopping = false;
  supervisor.pendingRestart = true;
  assert.equal(svc.getStatus().state, 'restarting'); // ✅ stopped değil!

  // 3) Supervisor restart etti → orchestrator yeniden başladı, ilk kare bekleniyor
  orchestrator.running = true;
  orchestrator.playStartedAt = null;
  supervisor.pendingRestart = false;
  encoder.emitCommand(); // yeni FFmpeg süreci
  assert.equal(svc.getStatus().state, 'restarting');
  assert.equal(svc.lastProgress, null); // ✅ stale progress temizlendi

  // 4) İlk kare geldi → running
  orchestrator.playStartedAt = 1001000;
  encoder.emitProgress({ fps: 24, bitrateKbps: 2800, speed: 0.95 });
  assert.equal(svc.getStatus().state, 'running');
  assert.equal(svc.lastProgress.fps, 24);
});

test('birden fazla progress olayı: son değerler korunur', () => {
  const { svc, encoder } = setup({
    orchOverrides: { running: true, playStartedAt: 990000 },
    supOverrides: { lastStartAt: 980000 },
  });
  encoder.emitProgress({ fps: 25, bitrateKbps: 3000, speed: 0.9 });
  encoder.emitProgress({ fps: 30, bitrateKbps: 3500, speed: 1.0 });
  encoder.emitProgress({ fps: 29, bitrateKbps: 4000, speed: 1.05 });
  assert.equal(svc.getStatus().fps, 29);
  assert.equal(svc.getStatus().bitrateKbps, 4000);
  assert.equal(svc.getStatus().speed, 1.05);
});

// Kapanış istendiği anda (uçuştaki başlatma beklenirken) stopping henüz false, running
// true ve playStartedAt null olur — eski mantık bu aralıkta 'restarting' diyordu, oysa
// yayın bir daha başlamayacak.
test('getStatus: stopRequested varken state stopped (restarting değil)', () => {
  const svc = new StreamControlService({
    orchestrator: fakeOrchestrator({ running: true, stopping: false, stopRequested: true, playStartedAt: null }),
    supervisor: fakeSupervisor(),
    encoder: new EventEmitter(),
    log: fakeLog(),
  });
  assert.equal(svc.getStatus().state, 'stopped');
});
