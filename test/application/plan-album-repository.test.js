const test = require('node:test');
const assert = require('node:assert/strict');

const { PlanAlbumRepository } = require('../../src/application/plan-album-repository');
const { Album } = require('../../src/domain/album');
const { Track } = require('../../src/domain/track');
const { StreamPlan } = require('../../src/domain/stream-plan');

const track = (p, d = 60) => new Track({ path: p, durationSeconds: d });

function albums() {
  return [
    new Album({
      name: 'mimi',
      backgrounds: [{ path: 'X:/mimi/bg1.mp4', durationSeconds: 10 }, { path: 'X:/mimi/bg2.mp4', durationSeconds: 10 }],
      tracks: [track('X:/mimi/1.m4a'), track('X:/mimi/2.m4a'), track('X:/mimi/3.m4a')],
    }),
    new Album({ name: 'gece', backgroundPath: 'X:/gece/bg.mp4', tracks: [track('X:/gece/1.m4a')] }),
  ];
}

function fakeLog() {
  const warnings = [];
  return { log: { info() {}, warn: (m) => warnings.push(m) }, warnings };
}

function make({ plan = null, studyClip = null, inner = { list: async () => albums() } } = {}) {
  const { log, warnings } = fakeLog();
  return {
    repo: new PlanAlbumRepository({
      inner,
      planProvider: () => plan,
      studyClipProvider: () => studyClip,
      log,
    }),
    warnings,
  };
}

test('plan yoksa iç deponun listesi AYNEN döner (referans bile değişmez)', async () => {
  const list = albums();
  const { repo } = make({ inner: { list: async () => list } });
  assert.equal(await repo.list(), list);
});

test('seçim yoksa ve study klibi verilmemişse liste değişmez', async () => {
  const list = albums();
  const { repo } = make({ plan: new StreamPlan({}), inner: { list: async () => list } });
  assert.equal(await repo.list(), list);
});

test('seçili parçalar plandaki SIRADA süzülür', async () => {
  const plan = new StreamPlan({
    music: { albums: [{ name: 'mimi', trackPaths: ['X:/mimi/3.m4a', 'X:/mimi/1.m4a'] }] },
  });
  const { repo } = make({ plan });
  const out = await repo.list();
  assert.deepEqual(out.map((a) => a.name), ['mimi']);
  assert.deepEqual(out[0].tracks.map((t) => t.path), ['X:/mimi/3.m4a', 'X:/mimi/1.m4a']);
});

test('albüm sırası da plandan gelir', async () => {
  const plan = new StreamPlan({
    music: {
      albums: [
        { name: 'gece', trackPaths: ['X:/gece/1.m4a'] },
        { name: 'mimi', trackPaths: ['X:/mimi/1.m4a'] },
      ],
    },
  });
  const { repo } = make({ plan });
  assert.deepEqual((await repo.list()).map((a) => a.name), ['gece', 'mimi']);
});

test('süzülen albüm arkaplanlarını korur (rotasyon bozulmaz)', async () => {
  const plan = new StreamPlan({ music: { albums: [{ name: 'mimi', trackPaths: ['X:/mimi/1.m4a'] }] } });
  const { repo } = make({ plan });
  const out = await repo.list();
  assert.deepEqual(out[0].backgrounds.map((b) => b.path), ['X:/mimi/bg1.mp4', 'X:/mimi/bg2.mp4']);
  assert.equal(out[0].rotates, true);
});

test('diskte olmayan parça atlanır ve uyarılır', async () => {
  const plan = new StreamPlan({
    music: { albums: [{ name: 'mimi', trackPaths: ['X:/mimi/1.m4a', 'X:/mimi/yok.m4a'] }] },
  });
  const { repo, warnings } = make({ plan });
  const out = await repo.list();
  assert.deepEqual(out[0].tracks.map((t) => t.path), ['X:/mimi/1.m4a']);
  assert.ok(warnings.some((w) => /1 parça diskte yok/.test(w)));
});

test('planda olmayan albüm atlanır ve uyarılır', async () => {
  const plan = new StreamPlan({ music: { albums: [{ name: 'silinmis', trackPaths: ['X:/x.m4a'] }] } });
  const { repo, warnings } = make({ plan });
  // Hiçbir şey eşleşmedi → tüm kütüphaneye düşülür: yayın susmaz.
  assert.deepEqual((await repo.list()).map((a) => a.name), ['mimi', 'gece']);
  assert.ok(warnings.some((w) => /artık yok/.test(w)));
  assert.ok(warnings.some((w) => /tüm kütüphaneye düşülüyor/.test(w)));
});

test('study klibi albümün arkaplanının yerine geçer ve rotasyonu kapatır', async () => {
  const { repo } = make({ plan: new StreamPlan({}), studyClip: 'X:/runtime/study.mp4' });
  const out = await repo.list();
  for (const album of out) {
    assert.deepEqual(album.backgrounds.map((b) => b.path), ['X:/runtime/study.mp4']);
    assert.equal(album.rotates, false);
  }
  // Parçalara dokunulmaz.
  assert.deepEqual(out[0].tracks.map((t) => t.path), ['X:/mimi/1.m4a', 'X:/mimi/2.m4a', 'X:/mimi/3.m4a']);
});

test('study klibi seçimle birlikte de uygulanır', async () => {
  const plan = new StreamPlan({ music: { albums: [{ name: 'gece', trackPaths: ['X:/gece/1.m4a'] }] } });
  const { repo } = make({ plan, studyClip: 'X:/runtime/study.mp4' });
  const out = await repo.list();
  assert.equal(out.length, 1);
  assert.equal(out[0].backgroundPath, 'X:/runtime/study.mp4');
});

test('iç depo gerekli', () => {
  assert.throws(() => new PlanAlbumRepository({ planProvider: () => null, log: fakeLog().log }), /inner depo gerekli/);
});
