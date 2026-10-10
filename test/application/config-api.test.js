const test = require('node:test');
const assert = require('node:assert/strict');

const { ConfigApi } = require('../../src/application/config-api');
const { StreamPlan } = require('../../src/domain/stream-plan');

function fakeConfigService({ plan = new StreamPlan({}), clips = ['/clips/a.mp4', '/clips/b.mp4'] } = {}) {
  const applied = [];
  return {
    applied,
    currentPlan: () => plan,
    listClips: async () => clips,
    apply: async (p) => { applied.push(p); return { plan: p, warnings: [] }; },
  };
}

test('form(): mevcut plan ve klip adaylarını döner', async () => {
  const configService = fakeConfigService();
  const api = new ConfigApi({ configService, log: { warn() {} } });
  const { plan, clips } = await api.form();
  assert.equal(plan.usesWholeLibrary, true);
  assert.deepEqual(clips, ['/clips/a.mp4', '/clips/b.mp4']);
});

test('save: listedeki klipler kabul edilir, music/cover/metadata korunur', async () => {
  const current = new StreamPlan({
    name: 'Cozy', cover: 'X:/kapak.jpg',
    music: { albums: [{ name: 'a', trackPaths: ['x.m4a'] }] },
  });
  const configService = fakeConfigService({ plan: current });
  const api = new ConfigApi({ configService, log: { warn() {} } });

  const result = await api.save({
    pomodoroEnabled: true, pomodoroType: '50+10',
    studyVideos: ['/clips/a.mp4'], breakVideos: ['/clips/b.mp4'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan.pomodoro.enabled, true);
  assert.deepEqual(result.plan.pomodoro.studyVideos, ['/clips/a.mp4']);
  assert.deepEqual(result.plan.pomodoro.breakVideos, ['/clips/b.mp4']);
  // Form bunlara hiç dokunmadı — korunmalı.
  assert.equal(result.plan.cover, 'X:/kapak.jpg');
  assert.equal(result.plan.music.albums[0].name, 'a');
  assert.equal(configService.applied.length, 1);
});

test('save: listede olmayan yol reddedilir, plan YAZILMAZ', async () => {
  const configService = fakeConfigService();
  const api = new ConfigApi({ configService, log: { warn() {} } });
  const result = await api.save({ studyVideos: ['/etc/passwd'] });
  assert.equal(result.ok, false);
  assert.match(result.error, /listede olmayan klip yolu/);
  assert.equal(configService.applied.length, 0);
});

test('save: pomodoro açıkken geçersiz tür reddedilir, plan YAZILMAZ', async () => {
  const configService = fakeConfigService();
  const api = new ConfigApi({ configService, log: { warn() {} } });
  const result = await api.save({ pomodoroEnabled: true, pomodoroType: 'elli' });
  assert.equal(result.ok, false);
  assert.match(result.error, /geçersiz pomodoro türü/);
  assert.equal(configService.applied.length, 0);
});

test('save: pomodoro kapalıyken geçersiz tür reddedilmez (tür anlamsız)', async () => {
  const configService = fakeConfigService();
  const api = new ConfigApi({ configService, log: { warn() {} } });
  const result = await api.save({ pomodoroEnabled: false, pomodoroType: '' });
  assert.equal(result.ok, true);
  assert.equal(result.plan.pomodoro.enabled, false);
});

test('save: restart istenmezse restartStream çağrılmaz', async () => {
  const configService = fakeConfigService();
  let called = false;
  const api = new ConfigApi({ configService, restartStream: async () => { called = true; return { ok: true }; }, log: { warn() {} } });
  const result = await api.save({});
  assert.equal(result.restarted, false);
  assert.equal(called, false);
});

test('save: restart istenir ve restartStream verilmişse çağrılır', async () => {
  const configService = fakeConfigService();
  const api = new ConfigApi({
    configService, restartStream: async () => ({ ok: true, message: 'yeniden başlatıldı' }), log: { warn() {} },
  });
  const result = await api.save({ restart: true });
  assert.equal(result.ok, true);
  assert.equal(result.restarted, true);
  assert.equal(result.restartError, null);
});

test('save: restart istenir ama restartStream verilmemişse plan yine kaydedilir, hata mesajla belirtilir', async () => {
  const configService = fakeConfigService();
  const api = new ConfigApi({ configService, log: { warn() {} } });
  const result = await api.save({ restart: true });
  assert.equal(result.ok, true);
  assert.equal(configService.applied.length, 1, 'plan kaydedilmeli');
  assert.equal(result.restarted, false);
  assert.match(result.restartError, /elle systemctl restart/);
});

test('save: restartStream hata fırlatırsa ok bozulmaz, yalnızca restartError dolar', async () => {
  const configService = fakeConfigService();
  const api = new ConfigApi({
    configService, restartStream: async () => { throw new Error('ECONNREFUSED'); }, log: { warn() {} },
  });
  const result = await api.save({ restart: true });
  assert.equal(result.ok, true);
  assert.equal(result.restarted, false);
  assert.match(result.restartError, /ECONNREFUSED/);
});

test('save: tekrarlı klip yolları tekilleştirilir', async () => {
  const configService = fakeConfigService();
  const api = new ConfigApi({ configService, log: { warn() {} } });
  const result = await api.save({ studyVideos: ['/clips/a.mp4', '/clips/a.mp4'] });
  assert.deepEqual(result.plan.pomodoro.studyVideos, ['/clips/a.mp4']);
});
