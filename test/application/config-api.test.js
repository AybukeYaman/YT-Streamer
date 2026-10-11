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

// ─── Başlık / açıklama / kapak ─────────────────────────────────────────────

function serviceWithCovers(covers, plan) {
  return { ...fakeConfigService({ plan }), listCovers: () => covers };
}

test('form(): kapak adaylarını da döner', async () => {
  const api = new ConfigApi({ configService: serviceWithCovers(['/c/a.jpg']), log: { warn() {} } });
  const { covers } = await api.form();
  assert.deepEqual(covers, ['/c/a.jpg']);
});

test('save: başlık, açıklama ve listedeki kapak plana yazılır', async () => {
  const configService = serviceWithCovers(['/c/a.jpg', '/c/b.jpg']);
  const api = new ConfigApi({ configService, log: { warn() {} } });
  const result = await api.save({ title: '  Yeni Başlık ', description: 'satır1\r\nsatır2', cover: '/c/b.jpg' });
  assert.equal(result.ok, true);
  assert.equal(result.plan.broadcast.title, 'Yeni Başlık');
  assert.equal(result.plan.broadcast.description, 'satır1\nsatır2');
  assert.equal(result.plan.cover, '/c/b.jpg');
});

test('save: boş başlık/açıklama/kapak "varsayılan"a (null) döner', async () => {
  const current = new StreamPlan({ cover: '/c/a.jpg', broadcast: { title: 'x', description: 'y' } });
  const api = new ConfigApi({ configService: serviceWithCovers(['/c/a.jpg'], current), log: { warn() {} } });
  const result = await api.save({ title: '', description: '  ', cover: '' });
  assert.equal(result.plan.broadcast.title, null);
  assert.equal(result.plan.broadcast.description, null);
  assert.equal(result.plan.cover, null);
});

test('save: alan verilmezse başlık/açıklama/kapak korunur', async () => {
  const current = new StreamPlan({ cover: '/c/a.jpg', broadcast: { title: 'x', description: 'y' } });
  const api = new ConfigApi({ configService: serviceWithCovers([], current), log: { warn() {} } });
  const result = await api.save({});
  assert.equal(result.plan.broadcast.title, 'x');
  assert.equal(result.plan.broadcast.description, 'y');
  assert.equal(result.plan.cover, '/c/a.jpg');
});

test('save: listede olmayan kapak reddedilir, plan YAZILMAZ; mevcut kapak listede olmasa da korunabilir', async () => {
  const configService = serviceWithCovers(['/c/a.jpg'], new StreamPlan({ cover: '/elle/yazilmis.jpg' }));
  const api = new ConfigApi({ configService, log: { warn() {} } });
  const bad = await api.save({ cover: '/etc/passwd' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /listede olmayan kapak/);
  assert.equal(configService.applied.length, 0);
  const keep = await api.save({ cover: '/elle/yazilmis.jpg' });
  assert.equal(keep.ok, true);
});

test('save: çok uzun başlık hata olarak döner, plan YAZILMAZ', async () => {
  const configService = serviceWithCovers([]);
  const api = new ConfigApi({ configService, log: { warn() {} } });
  const result = await api.save({ title: 'a'.repeat(101) });
  assert.equal(result.ok, false);
  assert.match(result.error, /en fazla 100/);
  assert.equal(configService.applied.length, 0);
});

// ─── Yayın başlat / durdur ─────────────────────────────────────────────────

function fakeStreamControl({ state = 'running', fail = null } = {}) {
  const calls = [];
  return {
    calls,
    start: async () => { calls.push('start'); if (fail) throw new Error(fail); },
    stop: async () => { calls.push('stop'); if (fail) throw new Error(fail); },
    status: async () => state,
  };
}

test('form(): streamControl varsa yayın durumunu döner, yoksa null', async () => {
  const withCtl = new ConfigApi({ configService: fakeConfigService(), streamControl: fakeStreamControl({ state: 'stopped' }), log: {} });
  assert.equal((await withCtl.form()).streamState, 'stopped');
  const without = new ConfigApi({ configService: fakeConfigService(), log: {} });
  assert.equal((await without.form()).streamState, null);
});

test('form(): status() hata fırlatırsa unknown (sayfa açılır)', async () => {
  const ctl = { ...fakeStreamControl(), status: async () => { throw new Error('x'); } };
  const api = new ConfigApi({ configService: fakeConfigService(), streamControl: ctl, log: {} });
  assert.equal((await api.form()).streamState, 'unknown');
});

test('control: start/stop streamControl çağrılır, planı YAZMAZ', async () => {
  const configService = fakeConfigService();
  const ctl = fakeStreamControl();
  const api = new ConfigApi({ configService, streamControl: ctl, log: {} });
  assert.equal((await api.control('start')).ok, true);
  assert.equal((await api.control('stop')).ok, true);
  assert.deepEqual(ctl.calls, ['start', 'stop']);
  assert.equal(configService.applied.length, 0);
});

test('control: hata mesajla döner; bilinmeyen işlem ve streamControl yokluğu reddedilir', async () => {
  const api = new ConfigApi({ configService: fakeConfigService(), streamControl: fakeStreamControl({ fail: 'izin yok' }), log: {} });
  const failed = await api.control('stop');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /durdurulamadı: izin yok/);
  assert.equal((await api.control('reboot')).ok, false);
  const none = new ConfigApi({ configService: fakeConfigService(), log: {} });
  assert.equal((await none.control('start')).ok, false);
});

// ─── Galeriden kapak yükleme ───────────────────────────────────────────────

test('uploadCover: saveCover yoksa reddedilir', async () => {
  const api = new ConfigApi({ configService: fakeConfigService(), log: {} });
  const r = await api.uploadCover(Buffer.from('x'));
  assert.equal(r.ok, false);
  assert.match(r.error, /desteklemiyor/);
});

test('uploadCover: kaydedilen yol döner ve plana DOKUNULMAZ', async () => {
  const configService = fakeConfigService();
  const api = new ConfigApi({ configService, saveCover: async (buf) => `/assets/covers/${buf.length}.jpg`, log: {} });
  const r = await api.uploadCover(Buffer.alloc(7));
  assert.deepEqual(r, { ok: true, path: '/assets/covers/7.jpg' });
  assert.equal(configService.applied.length, 0);
});

test('uploadCover: saveCover hata fırlatırsa mesajla ok:false', async () => {
  const api = new ConfigApi({
    configService: fakeConfigService(), saveCover: async () => { throw new Error('desteklenmeyen biçim'); }, log: {},
  });
  const r = await api.uploadCover(Buffer.from('x'));
  assert.equal(r.ok, false);
  assert.match(r.error, /görsel yüklenemedi: desteklenmeyen biçim/);
});
