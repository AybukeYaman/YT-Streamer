const test = require('node:test');
const assert = require('node:assert/strict');

const { StreamPlan, StreamPlanError, ORDER_MODES } = require('../../src/domain/stream-plan');

test('boş plan: tüm kütüphane, pomodoro kapalı (mevcut davranış)', () => {
  const p = new StreamPlan({});
  assert.equal(p.usesWholeLibrary, true);
  assert.equal(p.selectedTrackCount, 0);
  assert.equal(p.cover, null);
  assert.equal(p.music.order, 'sequential');
  assert.equal(p.pomodoro.enabled, false);
  assert.equal(p.pomodoroSignature, 'off');
});

test('seçim ve sıra plandaki haliyle korunur', () => {
  const p = new StreamPlan({
    name: 'Cozy',
    music: { order: 'shuffle', albums: [{ name: 'mimi', trackPaths: ['b.m4a', 'a.m4a'] }] },
  });
  assert.deepEqual(p.music.albums[0].trackPaths, ['b.m4a', 'a.m4a']);
  assert.equal(p.selectedTrackCount, 2);
  assert.equal(p.usesWholeLibrary, false);
});

test('aynı parça iki kez seçilse bir kez sayılır (kuyruk tekil liste bekler)', () => {
  const p = new StreamPlan({ music: { albums: [{ name: 'a', trackPaths: ['x', 'x', 'y'] }] } });
  assert.deepEqual(p.music.albums[0].trackPaths, ['x', 'y']);
});

test('parçası kalmayan albüm listeden düşer', () => {
  const p = new StreamPlan({ music: { albums: [{ name: 'a', trackPaths: [] }] } });
  assert.equal(p.usesWholeLibrary, true);
});

test('pomodoro imzası türden türer: tür değişince döngü geçersizleşir', () => {
  const a = new StreamPlan({ pomodoro: { enabled: true, type: '50+10' } });
  const b = a.with({ pomodoro: { enabled: true, type: '30+10' } });
  assert.notEqual(a.pomodoroSignature, b.pomodoroSignature);
  assert.equal(a.with({ pomodoro: { enabled: false, type: '50+10' } }).pomodoroSignature, 'off');
});

test('serbest süre türü kabul edilir, biçimsiz tür reddedilir', () => {
  assert.equal(new StreamPlan({ pomodoro: { type: '45+15' } }).pomodoro.type, '45+15');
  for (const type of ['0+10', '10+0', '50-10', 'elli', '']) {
    assert.throws(() => new StreamPlan({ pomodoro: { type } }), StreamPlanError, `kabul edilmemeli: ${type}`);
  }
});

test('tüm sorunlar tek hatada listelenir (sessizce varsayılana düşmek yok)', () => {
  try {
    new StreamPlan({ cover: 5, music: { order: 'rastgele' }, pomodoro: { type: 'x', rounds: 0 } });
    assert.fail('StreamPlanError bekleniyordu');
  } catch (err) {
    assert.ok(err instanceof StreamPlanError);
    assert.equal(err.problems.length, 4);
  }
});

test('plan donmuş: with() yeni plan üretir, eskisi değişmez', () => {
  const a = new StreamPlan({ name: 'a' });
  const b = a.with({ name: 'b' });
  assert.equal(a.name, 'a');
  assert.equal(b.name, 'b');
  a.name = 'c'; // donmuş: atama etkisizdir (sessiz, çünkü test dosyası strict değil)
  assert.equal(a.name, 'a');
});

test('toJSON → from turu kayıpsız', () => {
  const a = new StreamPlan({
    name: 'Gece', cover: 'k.jpg',
    music: { order: 'shuffle', albums: [{ name: 'm', trackPaths: ['1', '2'] }] },
    pomodoro: {
      enabled: true, type: '45+15', rounds: 6, studyVideos: ['s.mp4'], breakVideos: ['b.mp4'],
    },
  });
  assert.deepEqual(StreamPlan.from(a.toJSON()).toJSON(), a.toJSON());
});

// Geriye uyumluluk: VPS'te ŞU AN çalışan plan tek değerli studyVideo/breakVideo yazıyor
// (bkz. PLAN-yapilandirma-ui.md Faz N3) — bu düzeltmeyle hiç bozulmamalı.
test('eski tekil studyVideo/breakVideo tek elemanlı listeye çevrilir', () => {
  const p = new StreamPlan({ pomodoro: { enabled: true, studyVideo: 's.mp4', breakVideo: 'b.mp4' } });
  assert.deepEqual(p.pomodoro.studyVideos, ['s.mp4']);
  assert.deepEqual(p.pomodoro.breakVideos, ['b.mp4']);
  // toJSON HER ZAMAN liste biçimini yazar.
  assert.deepEqual(p.toJSON().pomodoro.studyVideos, ['s.mp4']);
});

test('studyVideos/breakVideos verilmişse tekil alan yoksayılır, tekrarlar atılır', () => {
  const p = new StreamPlan({
    pomodoro: { studyVideos: ['a.mp4', 'b.mp4', 'a.mp4'], breakVideos: ['c.mp4'] },
  });
  assert.deepEqual(p.pomodoro.studyVideos, ['a.mp4', 'b.mp4']);
  assert.deepEqual(p.pomodoro.breakVideos, ['c.mp4']);
});

test('ikisi de yoksa boş liste (mevcut davranış: albümün kendi arkaplanı)', () => {
  const p = new StreamPlan({ pomodoro: { enabled: true } });
  assert.deepEqual(p.pomodoro.studyVideos, []);
  assert.deepEqual(p.pomodoro.breakVideos, []);
});

test('geçersiz studyVideos/breakVideos reddedilir', () => {
  assert.throws(() => new StreamPlan({ pomodoro: { studyVideos: 'x.mp4' } }), StreamPlanError);
  assert.throws(() => new StreamPlan({ pomodoro: { studyVideos: [''] } }), StreamPlanError);
  assert.throws(() => new StreamPlan({ pomodoro: { studyVideo: 5 } }), StreamPlanError);
});

test('from: StreamPlan verilirse aynı örnek döner (gereksiz kopya yok)', () => {
  const a = new StreamPlan({});
  assert.equal(StreamPlan.from(a), a);
});

test('ORDER_MODES Queue modlarıyla aynı isimleri kullanır', () => {
  assert.deepEqual(ORDER_MODES, ['sequential', 'shuffle']);
});
