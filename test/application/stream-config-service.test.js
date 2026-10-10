const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StreamConfigService } = require('../../src/application/stream-config-service');
const { StreamPlan } = require('../../src/domain/stream-plan');

// ─── Sahte bağımlılıklar ─────────────────────────────────────────────────

const silentLog = { info() {}, warn() {} };

function fakePlanStore(initial = null) {
  return {
    active: initial,
    presets: [],
    saved: 0,
    loadActive() { return this.active; },
    saveActive(plan) { this.saved += 1; this.active = StreamPlan.from(plan); return this.active; },
    listPresets() { return this.presets; },
    savePreset(plan) {
      const entry = { slug: plan.name.toLowerCase().replace(/\s+/g, '-'), plan: StreamPlan.from(plan) };
      this.presets.push(entry);
      return entry;
    },
    deletePreset(slug) {
      const before = this.presets.length;
      this.presets = this.presets.filter((p) => p.slug !== slug);
      return this.presets.length < before;
    },
  };
}

// Album benzeri saf nesne — depo sözleşmesi yalnızca name/backgrounds/tracks okuyor.
function fakeAlbum(name, tracks, backgrounds = [`X:/bg/${name}.mp4`]) {
  return {
    name,
    backgrounds: backgrounds.map((p) => ({ path: p, durationSeconds: 10 })),
    tracks,
  };
}

function fakeAlbumRepository(albums) {
  return { list: async () => albums };
}

function fakeControlService() {
  return { calls: [], async restart() { this.calls.push('restart'); } };
}

const baseConfig = {
  paths: { runtime: 'X:/stream/runtime', albums: 'X:/stream/music-source' },
  broadcast: { thumbnailPath: null },
};

function makeService(overrides = {}) {
  return new StreamConfigService({
    planStore: fakePlanStore(),
    albumRepository: fakeAlbumRepository([]),
    controlService: fakeControlService(),
    config: baseConfig,
    log: silentLog,
    ...overrides,
  });
}

// ─── Sağlayıcılar ────────────────────────────────────────────────────────

test('plansız kurulumda sağlayıcılar boş liste döner (mevcut davranış korunur)', () => {
  const service = makeService();
  assert.equal(service.planProvider(), null);
  assert.deepEqual(service.studyClipsProvider(), []);
  assert.deepEqual(service.breakClipsProvider(), []);
});

test('diskteki aktif plan açılışta yüklenir', () => {
  const stored = new StreamPlan({ name: 'Gece Yağmuru' });
  const service = makeService({ planStore: fakePlanStore(stored) });
  assert.equal(service.planProvider().name, 'Gece Yağmuru');
});

// ─── Katalog ─────────────────────────────────────────────────────────────

test('albüm kataloğu süzülmemiş depodan okunur, parça ve arkaplan yollarıyla', async () => {
  const albums = [
    fakeAlbum('mimi', [{ path: 'X:/a/1.m4a', title: 'Bir', durationSeconds: 120 }]),
    fakeAlbum('video1', [{ path: 'X:/b/2.m4a', title: 'İki', durationSeconds: 60 }]),
  ];
  const service = makeService({ albumRepository: fakeAlbumRepository(albums) });

  const catalog = await service.listAlbums();
  assert.deepEqual(catalog.map((a) => a.name), ['mimi', 'video1']);
  assert.deepEqual(catalog[0].tracks, [{ path: 'X:/a/1.m4a', title: 'Bir', durationSeconds: 120 }]);
  assert.deepEqual(catalog[0].backgrounds, ['X:/bg/mimi.mp4']);
});

test('klip adayları albüm arkaplanlarını tekrarsız toplar', async () => {
  const shared = 'X:/bg/ortak.mp4';
  const albums = [
    fakeAlbum('a', [{ path: 'X:/1.m4a', title: '1', durationSeconds: 10 }], [shared]),
    fakeAlbum('b', [{ path: 'X:/2.m4a', title: '2', durationSeconds: 10 }], [shared, 'X:/bg/ek.mp4']),
  ];
  const service = makeService({ albumRepository: fakeAlbumRepository(albums) });
  assert.deepEqual(await service.listClips(), [shared, 'X:/bg/ek.mp4']);
});

// Dosya taraması application katmanının işi DEĞİL (bu katman fs import etmez — bkz.
// test/application/stream-orchestrator.test.js'teki mimari testi): tarayıcı
// infrastructure'daki MediaLibrary ve dışarıdan enjekte edilir. Burada servisin onu
// doğru yerden okuduğu ve yalnızca yolları dışarı verdiği sınanıyor; taramanın kendisi
// test/infrastructure/media-library.test.js'te.
test('kapak listesi dosya tarayıcıdan gelir, yalnızca yollar dışa verilir', () => {
  const service = makeService({
    mediaLibrary: {
      covers: () => [
        { path: 'X:/assets/kapak.jpg', label: 'kapak.jpg', sizeBytes: 1 },
        { path: 'X:/assets/covers/gece.png', label: 'covers/gece.png', sizeBytes: 1 },
      ],
      videos: () => [],
      inspect: () => ({ ok: false, reason: 'yok' }),
    },
  });
  assert.deepEqual(service.listCovers(), ['X:/assets/kapak.jpg', 'X:/assets/covers/gece.png']);
});

test('dosya tarayıcı kurulmadıysa listeler boş döner (sihirbaz yine çalışır)', () => {
  const service = makeService();
  assert.deepEqual(service.listCovers(), []);
  assert.equal(service.inspectPath('X:/bir.jpg').ok, false);
});

// ─── Uygulama ────────────────────────────────────────────────────────────

test('apply: havuzdaki klipleri hazırlar, planı yazar ve sağlayıcılara yansıtır', async () => {
  const planStore = fakePlanStore();
  const prepared = [];
  const service = makeService({
    planStore,
    prepareClip: async ({ sourcePath, name }) => {
      prepared.push(name);
      return `X:/runtime/${name}.mp4|${path.basename(sourcePath)}`;
    },
  });

  await service.apply({
    name: 'Cozy Study',
    pomodoro: {
      enabled: true, type: '50+10',
      studyVideos: ['X:/s1.mp4', 'X:/s2.mp4'], breakVideos: ['X:/b.jpg'],
    },
  });

  assert.deepEqual(prepared, ['study-1', 'study-2', 'break-1']);
  assert.deepEqual(service.studyClipsProvider(), [
    'X:/runtime/study-1.mp4|s1.mp4', 'X:/runtime/study-2.mp4|s2.mp4',
  ]);
  assert.deepEqual(service.breakClipsProvider(), ['X:/runtime/break-1.mp4|b.jpg']);
  assert.equal(planStore.saved, 1);
  assert.equal(service.planProvider().name, 'Cozy Study');
});

test('klip hazırlanamazsa plan yine uygulanır, o klip havuzdan düşer (yayın durmaz)', async () => {
  const service = makeService({
    prepareClip: async () => { throw new Error('ffmpeg düştü'); },
  });
  const { warnings } = await service.apply({ name: 'x', pomodoro: { enabled: true, studyVideos: ['X:/yok.mp4'] } });
  assert.deepEqual(service.studyClipsProvider(), []);
  assert.equal(service.planProvider().name, 'x');
  assert.ok(warnings.some((w) => /çalışma görüntüleri hazırlanamadı/.test(w)));
});

test('klip verilmemişse dönüştürücü hiç çağrılmaz', async () => {
  let calls = 0;
  const service = makeService({ prepareClip: async () => { calls += 1; return 'x'; } });
  await service.apply({ name: 'x' });
  assert.equal(calls, 0);
});

test('applyAndRestart planı uygular ve yayını yeniden başlatır', async () => {
  const controlService = fakeControlService();
  const service = makeService({ controlService });
  await service.applyAndRestart({ name: 'Deep Focus' });
  assert.deepEqual(controlService.calls, ['restart']);
  assert.equal(service.planProvider().name, 'Deep Focus');
});

test('restart planı değiştirmeden yeniden başlatır', async () => {
  const controlService = fakeControlService();
  const planStore = fakePlanStore(new StreamPlan({ name: 'eski' }));
  const service = makeService({ controlService, planStore });
  await service.restart();
  assert.deepEqual(controlService.calls, ['restart']);
  assert.equal(planStore.saved, 0);
  assert.equal(service.planProvider().name, 'eski');
});

// ─── Özet ────────────────────────────────────────────────────────────────

test('özet: seçili parçaların sayısını ve toplam süresini katalogdan hesaplar', async () => {
  const albums = [
    fakeAlbum('mimi', [
      { path: 'X:/a/1.m4a', title: 'Bir', durationSeconds: 120 },
      { path: 'X:/a/2.m4a', title: 'İki', durationSeconds: 180 },
    ]),
    fakeAlbum('diger', [{ path: 'X:/b/3.m4a', title: 'Üç', durationSeconds: 60 }]),
  ];
  const service = makeService({ albumRepository: fakeAlbumRepository(albums) });

  const summary = await service.summarize({
    name: 'Seçim',
    music: { order: 'sequential', albums: [{ name: 'mimi', trackPaths: ['X:/a/2.m4a', 'X:/a/1.m4a'] }] },
  });

  assert.equal(summary.trackCount, 2);
  assert.equal(summary.totalSeconds, 300);
  assert.equal(summary.usesWholeLibrary, false);
  assert.equal(summary.order, 'sequential');
  // Sıra PLANDAN gelir — özet de kullanıcının gördüğü sırayı göstermeli.
  assert.deepEqual(summary.albums[0].trackPaths, ['X:/a/2.m4a', 'X:/a/1.m4a']);
});

test('özet: seçim yoksa tüm kütüphane sayılır', async () => {
  const albums = [
    fakeAlbum('mimi', [{ path: 'X:/a/1.m4a', title: 'Bir', durationSeconds: 120 }]),
    fakeAlbum('diger', [{ path: 'X:/b/3.m4a', title: 'Üç', durationSeconds: 60 }]),
  ];
  const service = makeService({ albumRepository: fakeAlbumRepository(albums) });
  const summary = await service.summarize({ name: 'Hepsi' });
  assert.equal(summary.usesWholeLibrary, true);
  assert.equal(summary.trackCount, 2);
  assert.equal(summary.totalSeconds, 180);
});

test('özet: kapak seçilmemişse config\'deki kapak gösterilir', async () => {
  const service = makeService({
    config: { ...baseConfig, broadcast: { thumbnailPath: 'X:/assets/varsayilan.jpg' } },
  });
  const summary = await service.summarize({ name: 'x' });
  assert.equal(summary.cover, 'X:/assets/varsayilan.jpg');
});

// ─── Preset'ler ──────────────────────────────────────────────────────────

test('preset kaydet / listele / yükle / sil', () => {
  const planStore = fakePlanStore();
  const service = makeService({ planStore });

  const { slug } = service.savePreset({ name: 'Cozy Study', pomodoro: { enabled: true, type: '50+10' } });
  assert.deepEqual(service.listPresets().map((p) => p.plan.name), ['Cozy Study']);

  const loaded = service.loadPreset(slug);
  assert.equal(loaded.pomodoro.type, '50+10');
  // Preset yüklemek aktif planı DEĞİŞTİRMEZ — sihirbaz düzenlemeye başlasın diye döner.
  assert.equal(service.planProvider(), null);

  assert.equal(service.loadPreset('yok-boyle-bir-sey'), null);
  assert.equal(service.deletePreset(slug), true);
  assert.deepEqual(service.listPresets(), []);
});

test('currentPlan: plan yoksa boş plan döner (tüm kütüphane, pomodoro kapalı)', () => {
  const plan = makeService().currentPlan();
  assert.equal(plan.usesWholeLibrary, true);
  assert.equal(plan.pomodoro.enabled, false);
});
