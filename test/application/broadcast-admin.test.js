const test = require('node:test');
const assert = require('node:assert/strict');

const { BroadcastAdmin, BroadcastAdminError } = require('../../src/application/broadcast-admin');

const raw = (id, title, lifeCycleStatus, privacyStatus = 'unlisted', description = '') => ({
  id, snippet: { title, description }, status: { lifeCycleStatus, privacyStatus },
});

function setup({ items = [], now = () => 1000, cacheMs = 30000 } = {}) {
  const calls = [];
  const state = { items };
  const api = {
    getAccessToken: async () => { calls.push(['token']); return { accessToken: 'at' }; },
    listBroadcasts: async () => { calls.push(['list']); return state.items; },
    updateVideoDetails: async (o) => { calls.push(['details', o.videoId, o.title, o.description]); return { skipped: false }; },
    updateVideoPrivacy: async (o) => { calls.push(['privacy', o.videoId, o.privacyStatus]); return { skipped: false }; },
    setThumbnail: async (o) => { calls.push(['thumb', o.broadcastId, o.filePath]); return { skipped: false }; },
    transitionBroadcast: async (o) => { calls.push(['transition', o.broadcastId, o.status]); return {}; },
  };
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
  const admin = new BroadcastAdmin({ api, log, now, cacheMs });
  return { admin, calls, state, logs };
}

const names = (calls) => calls.map((c) => c[0]);

test('list: normalize eder, aktifler önce biten yayınlar sonra (kararlı sıra)', async () => {
  const { admin } = setup({
    items: [raw('c1', 'Bitti 1', 'complete'), raw('l1', 'Canlı', 'live', 'public'), raw('c2', 'Bitti 2', 'complete'), raw('r1', 'Hazır', 'ready')],
  });
  const list = await admin.list();
  assert.deepEqual(list.map((b) => b.id), ['l1', 'r1', 'c1', 'c2']);
  assert.equal(list[0].privacyStatus, 'public');
  assert.equal(list[2].finished, true);
  assert.equal(list[0].finished, false);
});

test('list: önbellek süresi içinde API\'ye tekrar gitmez, süre dolunca gider; fresh zorlar', async () => {
  let t = 0;
  const { admin, calls } = setup({ items: [raw('a', 'A', 'live')], now: () => t, cacheMs: 1000 });
  await admin.list();
  await admin.list();
  assert.equal(names(calls).filter((n) => n === 'list').length, 1);
  t = 2000;
  await admin.list();
  assert.equal(names(calls).filter((n) => n === 'list').length, 2);
  await admin.list({ fresh: true });
  assert.equal(names(calls).filter((n) => n === 'list').length, 3);
});

test('updateDetails: id listede olmalı, başlık/açıklama doğrulanır, sonra API çağrılır', async () => {
  const { admin, calls } = setup({ items: [raw('a', 'Eski', 'live', 'unlisted', 'x')] });
  await admin.updateDetails('a', { title: '  Yeni  ', description: 'satır1\r\nsatır2 ' });
  assert.deepEqual(calls.find((c) => c[0] === 'details'), ['details', 'a', 'Yeni', 'satır1\nsatır2']);
  // Önbellek yerinde güncellendi: ek list() çağrısı olmadan yeni değer görünür.
  const again = await admin.get('a');
  assert.equal(again.title, 'Yeni');
  assert.equal(names(calls).filter((n) => n === 'list').length, 1);
});

test('updateDetails: listede olmayan id reddedilir, API\'ye YAZILMAZ', async () => {
  const { admin, calls } = setup({ items: [raw('a', 'A', 'live')] });
  await assert.rejects(admin.updateDetails('baska-video', { title: 'x', description: '' }), BroadcastAdminError);
  assert.ok(!names(calls).includes('details'));
});

test('updateDetails: boş/uzun başlık ve çok uzun açıklama reddedilir', async () => {
  const { admin, calls } = setup({ items: [raw('a', 'A', 'live')] });
  await assert.rejects(admin.updateDetails('a', { title: '  ', description: '' }), /boş olamaz/);
  await assert.rejects(admin.updateDetails('a', { title: 'a'.repeat(101), description: '' }), /en fazla 100/);
  await assert.rejects(admin.updateDetails('a', { title: 'ok', description: 'a'.repeat(5001) }), /en fazla 5000/);
  assert.ok(!names(calls).includes('details'));
});

test('updateDetails: video artık yoksa (skipped) anlaşılır hata', async () => {
  const { admin, state } = setup({ items: [raw('a', 'A', 'live')] });
  admin.api.updateVideoDetails = async () => ({ skipped: true, reason: 'video bulunamadı' });
  await assert.rejects(admin.updateDetails('a', { title: 'x', description: '' }), /video bulunamadı/);
  assert.ok(state);
});

test('setPrivacy: yalnızca public/unlisted/private; geçerliyse API çağrılır ve önbellek güncellenir', async () => {
  const { admin, calls } = setup({ items: [raw('a', 'A', 'live', 'unlisted')] });
  await assert.rejects(admin.setPrivacy('a', 'herkes'), /geçersiz görünürlük/);
  await admin.setPrivacy('a', 'public');
  assert.deepEqual(calls.find((c) => c[0] === 'privacy'), ['privacy', 'a', 'public']);
  assert.equal((await admin.get('a')).privacyStatus, 'public');
});

test('setThumbnail: API\'ye iletilir; dosya yok/boş ise hata', async () => {
  const { admin, calls } = setup({ items: [raw('a', 'A', 'live')] });
  await admin.setThumbnail('a', '/assets/covers/k.jpg');
  assert.deepEqual(calls.find((c) => c[0] === 'thumb'), ['thumb', 'a', '/assets/covers/k.jpg']);
  admin.api.setThumbnail = async () => ({ skipped: true, reason: 'not_found' });
  await assert.rejects(admin.setThumbnail('a', '/yok.jpg'), /bulunamadı/);
});

test('end: yalnızca canlı/test yayın bitirilir (complete); hazır/biten reddedilir', async () => {
  const { admin, calls } = setup({
    items: [raw('live1', 'L', 'live'), raw('ready1', 'R', 'ready'), raw('done1', 'D', 'complete')],
  });
  await assert.rejects(admin.end('ready1'), /canlı değil/);
  await assert.rejects(admin.end('done1'), /canlı değil/);
  assert.ok(!names(calls).includes('transition'));
  await admin.end('live1');
  assert.deepEqual(calls.find((c) => c[0] === 'transition'), ['transition', 'live1', 'complete']);
});

test('end: bitirince önbellek sıfırlanır (sonraki liste taze)', async () => {
  const { admin, calls } = setup({ items: [raw('a', 'A', 'live')] });
  await admin.list();
  await admin.end('a');
  await admin.list();
  assert.equal(names(calls).filter((n) => n === 'list').length, 2);
});

test('önbellekte olmayan id için bir kez taze liste denenir (yeni açılan yayın)', async () => {
  const { admin, state, calls } = setup({ items: [raw('a', 'A', 'live')] });
  await admin.list();
  state.items = [raw('a', 'A', 'live'), raw('yeni', 'Yeni', 'ready')];
  await admin.setPrivacy('yeni', 'private');
  assert.deepEqual(calls.find((c) => c[0] === 'privacy'), ['privacy', 'yeni', 'private']);
});

test('list: başlangıç tarihi — gerçek başlangıç > planlanan > oluşturulma; started işareti doğru', async () => {
  const withSnippet = (id, snippet, lifeCycleStatus) => ({ id, snippet: { title: id, ...snippet }, status: { lifeCycleStatus, privacyStatus: 'public' } });
  const { admin } = setup({
    items: [
      withSnippet('a', { actualStartTime: '2026-10-11T13:00:00Z', scheduledStartTime: '2026-10-11T12:00:00Z' }, 'live'),
      withSnippet('b', { scheduledStartTime: '2026-10-12T09:00:00Z', publishedAt: '2026-10-10T00:00:00Z' }, 'ready'),
      withSnippet('c', { publishedAt: '2026-10-10T00:00:00Z' }, 'created'),
      withSnippet('d', {}, 'created'),
    ],
  });
  const byId = Object.fromEntries((await admin.list()).map((b) => [b.id, b]));
  assert.deepEqual([byId.a.startAt, byId.a.started], ['2026-10-11T13:00:00Z', true]);
  assert.deepEqual([byId.b.startAt, byId.b.started], ['2026-10-12T09:00:00Z', false]);
  assert.deepEqual([byId.c.startAt, byId.c.started], ['2026-10-10T00:00:00Z', false]);
  assert.deepEqual([byId.d.startAt, byId.d.started], [null, false]);
});

test('list: canlı yayın en üstte; biten yayınlar en yeni 5 ile sınırlı', async () => {
  const items = [
    raw('r1', 'Hazır', 'ready'),
    raw('l1', 'Canlı', 'live'),
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => raw(`c${n}`, `Bitti ${n}`, 'complete')),
  ];
  const { admin } = setup({ items });
  const list = await admin.list();
  assert.deepEqual(list.slice(0, 2).map((b) => b.id), ['l1', 'r1']);
  assert.deepEqual(list.slice(2).map((b) => b.id), ['c1', 'c2', 'c3', 'c4', 'c5']);
});

test('list: küçük resim adresi default > medium > null sırasıyla alınır', async () => {
  const withThumbs = (id, thumbnails) => ({
    id, snippet: { title: id, thumbnails }, status: { lifeCycleStatus: 'live', privacyStatus: 'public' },
  });
  const { admin } = setup({
    items: [
      withThumbs('a', { default: { url: 'https://i.ytimg.com/a-default.jpg' }, medium: { url: 'https://i.ytimg.com/a-medium.jpg' } }),
      withThumbs('b', { medium: { url: 'https://i.ytimg.com/b-medium.jpg' } }),
      withThumbs('c', {}),
      { id: 'd', snippet: { title: 'd' }, status: { lifeCycleStatus: 'ready' } },
    ],
  });
  const byId = Object.fromEntries((await admin.list()).map((b) => [b.id, b.thumbnailUrl]));
  assert.deepEqual(byId, {
    a: 'https://i.ytimg.com/a-default.jpg', b: 'https://i.ytimg.com/b-medium.jpg', c: null, d: null,
  });
});
