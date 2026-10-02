// GoLiveService testleri: ağ yok, fs yok. Sahte api + sahte stateStore.
const test = require('node:test');
const assert = require('node:assert/strict');

const { GoLiveService, GoLiveError } = require('../../src/application/go-live-service');

const STREAM_KEY = 'abcd-efgh-ijkl-mnop-qrst';
const STREAM_ID = 'jw_Xpcey4RaYu-AvmRXSSw1790716683112799';
const BROADCAST_CONFIG = {
  title: '24/7 Cozy Lofi Radio ☕ Chill Beats to Study / Work / Sleep to...',
  description: '',
  privacyStatus: 'unlisted',
  latencyPreference: 'normal',
  streamId: null,
  thumbnailPath: '/root/YT-Streamer/assets/thumbnail.jpg',
};

// Çağrı sırasını kaydeden sahte API. streamStatuses: getStreamStatus'un sırayla
// döneceği durumlar (son değer tekrar eder).
function fakeApi({
  broadcasts = {}, streams = [{ streamStatus: 'active', healthStatus: 'good' }],
  insertId = 'bid-1', streamIdByKey = STREAM_ID, failOn = {},
  thumbnail = { skipped: false },
} = {}) {
  const calls = [];
  const queue = [...streams];
  const store = { ...broadcasts };
  const maybeFail = (name) => { if (failOn[name]) throw failOn[name]; };
  return {
    calls,
    store,
    getAccessToken: async () => { calls.push(['getAccessToken']); return { accessToken: 'at' }; },
    findStreamIdByKey: async ({ streamKey }) => {
      calls.push(['findStreamIdByKey', streamKey]);
      maybeFail('findStreamIdByKey');
      return streamIdByKey;
    },
    getBroadcast: async ({ broadcastId }) => {
      calls.push(['getBroadcast', broadcastId]);
      return store[broadcastId] ?? null;
    },
    insertBroadcast: async (opts) => {
      calls.push(['insertBroadcast', opts.title, opts.privacyStatus, opts.scheduledStartTime]);
      maybeFail('insertBroadcast');
      store[insertId] = { id: insertId, snippet: { title: opts.title }, status: { lifeCycleStatus: 'ready' } };
      return store[insertId];
    },
    setThumbnail: async ({ broadcastId, filePath }) => {
      calls.push(['setThumbnail', broadcastId, filePath]);
      maybeFail('setThumbnail');
      return thumbnail;
    },
    bindBroadcast: async ({ broadcastId, streamId }) => {
      calls.push(['bindBroadcast', broadcastId, streamId]);
      maybeFail('bindBroadcast');
      return { id: broadcastId };
    },
    getStreamStatus: async ({ streamId }) => {
      calls.push(['getStreamStatus', streamId]);
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    updateVideoPrivacy: async ({ videoId, privacyStatus }) => {
      calls.push(['updateVideoPrivacy', videoId, privacyStatus]);
      maybeFail('updateVideoPrivacy');
      const prev = store[videoId]?.status?.privacyStatus ?? 'public';
      if (prev === privacyStatus) return { skipped: true, reason: 'zaten öyle', privacyStatus };
      return { skipped: false, previous: prev, privacyStatus };
    },
    transitionBroadcast: async ({ broadcastId, status }) => {
      calls.push(['transitionBroadcast', broadcastId, status]);
      maybeFail('transitionBroadcast');
      store[broadcastId] = { ...store[broadcastId], status: { lifeCycleStatus: 'live' } };
      return store[broadcastId];
    },
  };
}

function fakeStateStore(initial = null, { failWrite = false } = {}) {
  let state = initial;
  const saves = [];
  return {
    saves,
    get state() { return state; },
    load: () => state,
    save: (s) => {
      if (failWrite) throw new Error('disk dolu');
      saves.push(s);
      state = s;
    },
    clear: () => { state = null; },
  };
}

function fakePendingVods(initial = [], { failWrite = false, failRead = false } = {}) {
  let pending = [...initial];
  return {
    get pending() { return pending; },
    list: () => { if (failRead) throw new Error('okunamadı'); return [...pending]; },
    add: (entry) => {
      if (failWrite) throw new Error('disk dolu');
      if (!pending.some((e) => e.broadcastId === entry.broadcastId)) pending.push(entry);
      return [...pending];
    },
    remove: (ids) => {
      const drop = new Set(ids);
      pending = pending.filter((e) => !drop.has(e.broadcastId));
      return [...pending];
    },
  };
}

function fakeLog() {
  const lines = [];
  const rec = (level) => (m) => lines.push({ level, m });
  return { lines, log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') } };
}

function setup({ api = fakeApi(), stateStore = fakeStateStore(), broadcastConfig = BROADCAST_CONFIG, ...rest } = {}) {
  const { log, lines } = fakeLog();
  const service = new GoLiveService({
    api, stateStore, log, broadcastConfig, streamKey: STREAM_KEY,
    pollIntervalMs: 1, ingestTimeoutMs: 50, sleep: async () => {},
    now: () => 1_700_000_000_000,
    ...rest,
  });
  return { service, api, stateStore, lines };
}

const names = (calls) => calls.map((c) => c[0]);

test('mutlu yol: sıra ingest kontrolü → insert → bind → transition(live)', async () => {
  const { service, api, stateStore } = setup();
  const result = await service.goLive();

  assert.equal(result.action, 'went-live');
  assert.equal(result.broadcastId, 'bid-1');
  assert.equal(result.streamId, STREAM_ID);
  // Sıra ZORUNLU. ingest kontrolü insert'ten ÖNCE: ffmpeg basmıyorken broadcast
  // oluşturmak kanalda çöp yayın bırakır (duman testinde görüldü).
  assert.deepEqual(names(api.calls), [
    'getAccessToken', 'findStreamIdByKey', 'getStreamStatus',
    'insertBroadcast', 'setThumbnail', 'bindBroadcast', 'transitionBroadcast',
  ]);
  assert.equal(stateStore.state.status, 'live');
  assert.equal(stateStore.state.broadcastId, 'bid-1');
});

test('insert config\'teki başlık ve privacyStatus ile çağrılır', async () => {
  const { service, api } = setup();
  await service.goLive();
  const insert = api.calls.find((c) => c[0] === 'insertBroadcast');
  assert.equal(insert[1], BROADCAST_CONFIG.title);
  assert.equal(insert[2], 'unlisted'); // ilk otomatik broadcast herkese açık olmasın
  assert.match(insert[3], /^\d{4}-\d{2}-\d{2}T/); // scheduledStartTime ISO (insert için zorunlu)
});

// İDEMPOTANS — bu özelliğin asıl sebebi: crash-loop / çift tetik çöp broadcast açmasın.
test('zaten canlıysa insert YAPILMAZ', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'bid-eski', streamId: STREAM_ID, status: 'live', title: 't' });
  const api = fakeApi({ broadcasts: { 'bid-eski': { id: 'bid-eski', status: { lifeCycleStatus: 'live' } } } });
  const { service, lines } = setup({ api, stateStore });

  const result = await service.goLive();
  assert.equal(result.action, 'already-live');
  assert.equal(result.broadcastId, 'bid-eski');
  assert.ok(!names(api.calls).includes('insertBroadcast'));
  assert.ok(!names(api.calls).includes('transitionBroadcast'));
  assert.ok(lines.some((l) => /zaten canlı/.test(l.m)));
});

test('testing durumu da canlı sayılır (insert yapılmaz)', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'b', streamId: STREAM_ID, status: 'testing' });
  const api = fakeApi({ broadcasts: { b: { id: 'b', status: { lifeCycleStatus: 'testing' } } } });
  const { service } = setup({ api, stateStore });
  assert.equal((await service.goLive()).action, 'already-live');
  assert.ok(!names(api.calls).includes('insertBroadcast'));
});

// STALE TESPİTİ (1 Ekim olayı): broadcast YouTube'da "live" ama ingest veri almıyordu;
// eski kod yalnızca lifeCycleStatus'a baktığı için "zaten canlı" deyip hiçbir şey yapmadı
// ve yayın ~2 saat ölü kaldı.
test('broadcast live ama ingest inactive: already-live DEĞİL, stale_broadcast ile reddedilir', async () => {
  const stateStore = fakeStateStore({
    broadcastId: 'hSqzx1FiX_k', streamId: STREAM_ID, status: 'live', title: 't',
    createdAt: '2026-09-30T10:00:00.000Z',
  });
  const api = fakeApi({
    broadcasts: { hSqzx1FiX_k: { id: 'hSqzx1FiX_k', status: { lifeCycleStatus: 'live' } } },
    streams: [{ streamStatus: 'inactive', healthStatus: 'noData' }],
  });
  let t = 0;
  const { service, lines } = setup({ api, stateStore, staleGraceMs: 10, now: () => (t += 10) });

  const caught = await service.goLive().then(() => null, (e) => e);
  assert.ok(caught instanceof GoLiveError);
  assert.equal(caught.code, 'stale_broadcast');
  assert.equal(caught.details.broadcastId, 'hSqzx1FiX_k');
  assert.deepEqual(caught.details.ingest, { streamStatus: 'inactive', healthStatus: 'noData' });
  // Hiçbir YouTube YAZMA çağrısı yapılmaz: broadcast'i complete'e almak ingest'i
  // diriltmez, yalnızca kanalda çöp bırakır (A fazı bilerek salt-okunur).
  assert.ok(!names(api.calls).includes('insertBroadcast'));
  assert.ok(!names(api.calls).includes('transitionBroadcast'));
  assert.ok(!names(api.calls).includes('bindBroadcast'));
  // Kayıtta iz bırakır ki getStatus() refresh olmadan da gösterebilsin.
  assert.equal(stateStore.state.health, 'stale');
  assert.ok(stateStore.state.unhealthySince);
  // Broadcast'in gerçek yaşı korunur (createdAt "şimdi" ile ezilmez).
  assert.equal(stateStore.state.createdAt, '2026-09-30T10:00:00.000Z');
  assert.ok(lines.some((l) => l.level === 'error' && /ÖLÜ/.test(l.m)));
});

test('ingest grace penceresinde toparlanırsa already-live (albüm geçişi yanlış alarm vermez)', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'b', streamId: STREAM_ID, status: 'live' });
  const api = fakeApi({
    broadcasts: { b: { id: 'b', status: { lifeCycleStatus: 'live' } } },
    // ffmpeg albüm geçişinde yeniden bağlanıyor: iki yoklama inactive, sonra active.
    streams: [
      { streamStatus: 'inactive', healthStatus: 'noData' },
      { streamStatus: 'inactive', healthStatus: 'noData' },
      { streamStatus: 'active', healthStatus: 'good' },
    ],
  });
  let t = 0;
  const { service, lines } = setup({ api, stateStore, staleGraceMs: 10_000, now: () => (t += 10) });

  const result = await service.goLive();
  assert.equal(result.action, 'already-live');
  assert.ok(!names(api.calls).includes('insertBroadcast'));
  assert.ok(lines.some((l) => /ingest geri döndü/.test(l.m)));
});

// 'bad' veri GELİYOR ama sorunlu demek — bunun için canlı yayını reddetmek yanlış olur.
test('ingest active + healthStatus bad: canlı sayılır, yalnızca uyarı', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'b', streamId: STREAM_ID, status: 'live' });
  const api = fakeApi({
    broadcasts: { b: { id: 'b', status: { lifeCycleStatus: 'live' } } },
    streams: [{ streamStatus: 'active', healthStatus: 'bad' }],
  });
  const { service, lines } = setup({ api, stateStore });

  assert.equal((await service.goLive()).action, 'already-live');
  assert.ok(lines.some((l) => l.level === 'warn' && /bad/.test(l.m)));
});

test('getStatus(refresh): broadcast live + ingest inactive → healthy false', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'b', streamId: STREAM_ID, status: 'live' });
  const api = fakeApi({
    broadcasts: { b: { id: 'b', status: { lifeCycleStatus: 'live' } } },
    streams: [{ streamStatus: 'inactive', healthStatus: 'noData' }],
  });
  const { service } = setup({ api, stateStore });

  const status = await service.getStatus({ refresh: true });
  assert.equal(status.liveStatus, 'live');
  assert.equal(status.healthy, false);
  assert.deepEqual(status.ingest, { streamStatus: 'inactive', healthStatus: 'noData' });
});

test('checkIngestHealth: yalnız liveStreams sorgulanır (broadcast çekilmez)', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'b', streamId: STREAM_ID, status: 'live' });
  const api = fakeApi({
    broadcasts: { b: { id: 'b', status: { lifeCycleStatus: 'live' } } },
    streams: [{ streamStatus: 'active', healthStatus: 'good' }],
  });
  const { service } = setup({ api, stateStore });

  const result = await service.checkIngestHealth();
  assert.equal(result.healthy, true);
  assert.equal(result.broadcastId, 'b');
  assert.deepEqual(names(api.calls), ['getAccessToken', 'getStreamStatus']);
});

test('checkIngestHealth: kayıt canlı değilse hiç API çağrısı yapılmaz (kota)', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'b', streamId: STREAM_ID, status: 'complete' });
  const api = fakeApi();
  const { service } = setup({ api, stateStore });

  const result = await service.checkIngestHealth();
  assert.equal(result.skipped, true);
  assert.deepEqual(api.calls, []);
});

test('kayıtlı broadcast YouTube\'da yoksa kayıt temizlenir ve yenisi açılır', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'silinmis', status: 'live' });
  const api = fakeApi({ broadcasts: {} }); // getBroadcast → null
  const { service, lines } = setup({ api, stateStore });

  const result = await service.goLive();
  assert.equal(result.action, 'went-live');
  assert.equal(result.broadcastId, 'bid-1');
  assert.ok(lines.some((l) => l.level === 'warn' && /YouTube'da yok/.test(l.m)));
});

test('kayıtlı broadcast sonlanmışsa (complete) yenisi açılır', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'bitti', status: 'live' });
  const api = fakeApi({ broadcasts: { bitti: { id: 'bitti', status: { lifeCycleStatus: 'complete' } } } });
  const { service, lines } = setup({ api, stateStore });
  assert.equal((await service.goLive()).action, 'went-live');
  assert.ok(lines.some((l) => l.level === 'warn' && /kullanılamaz durumda \(complete\)/.test(l.m)));
});

test('ingest aktif olana kadar yoklar, sonra transition eder', async () => {
  const api = fakeApi({
    streams: [
      { streamStatus: 'inactive', healthStatus: 'noData' },
      { streamStatus: 'ready', healthStatus: 'noData' },
      { streamStatus: 'active', healthStatus: 'good' },
    ],
  });
  const { service } = setup({ api, ingestTimeoutMs: 10000 });
  await service.goLive();
  const statusCalls = api.calls.filter((c) => c[0] === 'getStreamStatus');
  assert.equal(statusCalls.length, 3);
  // transition en sonda, yoklamalardan SONRA.
  assert.equal(names(api.calls).at(-1), 'transitionBroadcast');
});

test('ingest aktif olmazsa transition denenmez ve anlaşılır hata verir', async () => {
  let t = 0;
  const api = fakeApi({ streams: [{ streamStatus: 'inactive', healthStatus: 'noData' }] });
  const { service } = setup({ api, ingestTimeoutMs: 5, now: () => (t += 10) });

  await assert.rejects(() => service.goLive(), (err) => {
    assert.ok(err instanceof GoLiveError);
    assert.equal(err.code, 'ingest_not_active');
    assert.match(err.message, /ffmpeg gerçekten yayın yapıyor mu/);
    return true;
  });
  assert.ok(!names(api.calls).includes('transitionBroadcast'));
});

// insert sonrası çökme: broadcast "kayıp" kalmamalı, sonraki tetik onu bulmalı.
test('insert\'ten hemen sonra durum diske yazılır (bind\'den önce)', async () => {
  const api = fakeApi({ failOn: { bindBroadcast: new Error('ağ koptu') } });
  const stateStore = fakeStateStore();
  const { service } = setup({ api, stateStore });

  await assert.rejects(() => service.goLive(), /ağ koptu/);
  assert.equal(stateStore.state.broadcastId, 'bid-1');
  assert.equal(stateStore.state.status, 'created'); // bind olmadı ama kayıt var
});

test('durum yazılamazsa akış durur (idempotans kaybolmasın)', async () => {
  const stateStore = fakeStateStore(null, { failWrite: true });
  const api = fakeApi();
  const { service } = setup({ api, stateStore });

  await assert.rejects(() => service.goLive(), (err) => {
    assert.equal(err.code, 'state_write_failed');
    return true;
  });
  // transition yapılmadı: yazamadığımız bir broadcast'i canlıya almak, sonraki tetikte
  // ikinci bir broadcast açılması demek olurdu.
  assert.ok(!names(api.calls).includes('transitionBroadcast'));
});

test('bind hedefi: config.streamId boşsa key\'den çözülür', async () => {
  const { service, api } = setup();
  await service.goLive();
  assert.deepEqual(api.calls.find((c) => c[0] === 'findStreamIdByKey'), ['findStreamIdByKey', STREAM_KEY]);
  assert.deepEqual(api.calls.find((c) => c[0] === 'bindBroadcast'), ['bindBroadcast', 'bid-1', STREAM_ID]);
});

test('bind hedefi: config.streamId verilmişse API\'ye sorulmaz', async () => {
  const { service, api } = setup({ broadcastConfig: { ...BROADCAST_CONFIG, streamId: 'sabit-id' } });
  await service.goLive();
  assert.ok(!names(api.calls).includes('findStreamIdByKey'));
  assert.deepEqual(api.calls.find((c) => c[0] === 'bindBroadcast'), ['bindBroadcast', 'bid-1', 'sabit-id']);
});

test('key kanaldaki hiçbir stream ile eşleşmezse açık hata (yanlış kanala yayın açılmasın)', async () => {
  const api = fakeApi({ streamIdByKey: null });
  const { service } = setup({ api });
  await assert.rejects(() => service.goLive(), (err) => {
    assert.equal(err.code, 'stream_not_found');
    assert.match(err.message, /başka bir Google hesabıyla/);
    return true;
  });
  assert.ok(!names(api.calls).includes('insertBroadcast'));
});

test('streamId de key de yoksa anlaşılır hata', async () => {
  const { service } = setup({ broadcastConfig: { ...BROADCAST_CONFIG, streamId: null }, streamKey: null });
  await assert.rejects(() => service.goLive(), (err) => {
    assert.equal(err.code, 'stream_not_resolved');
    return true;
  });
});

// iOS'ta çift dokunma: ikinci istek sessizce aynı sonucu almaz, açıkça reddedilir.
test('eşzamanlı ikinci goLive reddedilir (tek-uçuş kilidi)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const api = fakeApi();
  const original = api.insertBroadcast;
  api.insertBroadcast = async (opts) => { await gate; return original(opts); };
  const { service } = setup({ api });

  const first = service.goLive();
  await assert.rejects(() => service.goLive(), (err) => {
    assert.equal(err.code, 'busy');
    return true;
  });
  assert.equal(service.busy, true);
  release();
  await first;
  assert.equal(service.busy, false);
  // Yalnızca BİR insert yapıldı.
  assert.equal(api.calls.filter((c) => c[0] === 'insertBroadcast').length, 1);
});

test('hata sonrası kilit serbest kalır', async () => {
  const api = fakeApi({ streamIdByKey: null });
  const { service } = setup({ api });
  await assert.rejects(() => service.goLive());
  assert.equal(service.busy, false);
});

test('getStatus: varsayılan olarak API\'ye GİTMEZ (kota korunur)', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'b', streamId: STREAM_ID, status: 'live', title: 't' });
  const api = fakeApi({ broadcasts: { b: { id: 'b', status: { lifeCycleStatus: 'live' } } } });
  const { service } = setup({ api, stateStore });

  const status = await service.getStatus();
  assert.equal(status.broadcastId, 'b');
  assert.equal(status.status, 'live');
  assert.deepEqual(api.calls, []); // hiç API çağrısı yok
});

test('getStatus refresh=true: API\'den canlı durum ve ingest bilgisi', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'b', streamId: STREAM_ID, status: 'bound' });
  const api = fakeApi({ broadcasts: { b: { id: 'b', status: { lifeCycleStatus: 'live' } } } });
  const { service } = setup({ api, stateStore });

  const status = await service.getStatus({ refresh: true });
  assert.equal(status.liveStatus, 'live');
  assert.equal(status.ingest.streamStatus, 'active');
  assert.ok(names(api.calls).includes('getBroadcast'));
});

test('getStatus: kayıt yoksa boş ama çökmeyen yanıt', async () => {
  const { service } = setup();
  const status = await service.getStatus({ refresh: true });
  assert.equal(status.broadcastId, null);
  assert.equal(status.busy, false);
});

// Duman testinin ortaya çıkardığı kusur: ffmpeg basmıyorken insert yapılıyordu ve her
// deneme kanalda 'ready' durumunda bir çöp broadcast bırakıyordu.
test('ingest aktif değilse insert HİÇ yapılmaz (çöp broadcast bırakmaz)', async () => {
  let t = 0;
  const api = fakeApi({ streams: [{ streamStatus: 'inactive', healthStatus: 'noData' }] });
  const stateStore = fakeStateStore();
  const { service } = setup({ api, stateStore, ingestTimeoutMs: 5, now: () => (t += 10) });

  await assert.rejects(() => service.goLive(), (err) => {
    assert.equal(err.code, 'ingest_not_active');
    return true;
  });
  assert.ok(!names(api.calls).includes('insertBroadcast'));
  assert.ok(!names(api.calls).includes('bindBroadcast'));
  assert.equal(stateStore.state, null); // kanalda da diskte de iz yok
});

test('yarım kalan broadcast (ready) yeniden kullanılır, yenisi açılmaz', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'yarim', streamId: STREAM_ID, status: 'created', title: 't' });
  const api = fakeApi({ broadcasts: { yarim: { id: 'yarim', status: { lifeCycleStatus: 'ready' } } } });
  const { service, lines } = setup({ api, stateStore });

  const result = await service.goLive();
  assert.equal(result.action, 'went-live');
  assert.equal(result.broadcastId, 'yarim'); // aynı broadcast
  assert.ok(!names(api.calls).includes('insertBroadcast'));
  assert.deepEqual(api.calls.find((c) => c[0] === 'transitionBroadcast'), ['transitionBroadcast', 'yarim', 'live']);
  assert.ok(lines.some((l) => /yarım kalan broadcast yeniden kullanılıyor/.test(l.m)));
});

// Toplam senaryo: ffmpeg yokken dene → başarısız → ffmpeg başlasın → tekrar dene.
// Sonuçta kanalda TEK broadcast olmalı.
test('başarısız deneme sonrası ikinci deneme yeni broadcast AÇMAZ', async () => {
  let ingest = 'inactive';
  let t = 0;
  const stateStore = fakeStateStore();
  const api = fakeApi();
  api.getStreamStatus = async () => ({ streamStatus: ingest, healthStatus: 'good' });
  const { service } = setup({ api, stateStore, ingestTimeoutMs: 5, now: () => (t += 10) });

  await assert.rejects(() => service.goLive(), /ingest/);
  ingest = 'active';
  const result = await service.goLive();

  assert.equal(result.action, 'went-live');
  assert.equal(api.calls.filter((c) => c[0] === 'insertBroadcast').length, 1); // TEK insert
});

// ── küçük resim (thumbnails.set) ─────────────────────────────────────────────
// Kritik DEĞİL: hiçbir başarısızlığı yayının canlıya geçmesini engellememeli.

test('küçük resim: insert sonrası, bind öncesi yüklenir', async () => {
  const { service, api } = setup();
  await service.goLive();
  const order = names(api.calls);
  assert.deepEqual(
    api.calls.find((c) => c[0] === 'setThumbnail'),
    ['setThumbnail', 'bid-1', BROADCAST_CONFIG.thumbnailPath],
  );
  assert.ok(order.indexOf('setThumbnail') > order.indexOf('insertBroadcast'));
  assert.ok(order.indexOf('setThumbnail') < order.indexOf('bindBroadcast'));
});

test('dosya yoksa (skipped) akış aynen canlıya geçer', async () => {
  const api = fakeApi({ thumbnail: { skipped: true, reason: 'not_found' } });
  const stateStore = fakeStateStore();
  const { service, lines } = setup({ api, stateStore });

  const result = await service.goLive();
  assert.equal(result.action, 'went-live');
  assert.equal(stateStore.state.status, 'live');
  assert.ok(lines.some((l) => l.level === 'info' && /küçük resim atlandı \(dosya yok\)/.test(l.m)));
  // "atlandı" bir hata değil: uyarı bile loglanmıyor.
  assert.ok(!lines.some((l) => l.level === 'warn'));
});

// Asıl korunan davranış: bir thumbnail yüzünden yayın canlıya geçmezse kabul edilemez.
test('küçük resim yüklemesi ATARSA go-live yine canlıya geçer', async () => {
  const api = fakeApi({ failOn: { setThumbnail: new Error('quotaExceeded') } });
  const stateStore = fakeStateStore();
  const { service, lines } = setup({ api, stateStore });

  const result = await service.goLive();
  assert.equal(result.action, 'went-live');
  assert.equal(result.broadcastId, 'bid-1');
  assert.equal(stateStore.state.status, 'live');
  assert.ok(names(api.calls).includes('transitionBroadcast'));
  assert.ok(lines.some((l) => l.level === 'warn' && /küçük resim yüklenemedi \(quotaExceeded\)/.test(l.m)));
});

test('thumbnailPath null ise hiç denenmez', async () => {
  const api = fakeApi();
  const { service } = setup({ api, broadcastConfig: { ...BROADCAST_CONFIG, thumbnailPath: null } });
  assert.equal((await service.goLive()).action, 'went-live');
  assert.ok(!names(api.calls).includes('setThumbnail'));
});

// Yeniden kullanılan broadcast'te resim zaten yüklenmişti; tekrarı boşa kota.
test('yeniden kullanılan broadcast için küçük resim tekrar yüklenmez', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'yarim', streamId: STREAM_ID, status: 'created', title: 't' });
  const api = fakeApi({ broadcasts: { yarim: { id: 'yarim', status: { lifeCycleStatus: 'ready' } } } });
  const { service } = setup({ api, stateStore });

  assert.equal((await service.goLive()).broadcastId, 'yarim');
  assert.ok(!names(api.calls).includes('setThumbnail'));
});

test('zaten canlıysa küçük resim yüklenmez', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'b', streamId: STREAM_ID, status: 'live', title: 't' });
  const api = fakeApi({ broadcasts: { b: { id: 'b', status: { lifeCycleStatus: 'live' } } } });
  const { service } = setup({ api, stateStore });

  assert.equal((await service.goLive()).action, 'already-live');
  assert.ok(!names(api.calls).includes('setThumbnail'));
});

test('getStatus(refresh=false): stale izi API’ye gitmeden görünür', async () => {
  const stateStore = fakeStateStore({
    broadcastId: 'b', streamId: STREAM_ID, status: 'live',
    health: 'stale', unhealthySince: '2026-10-01T12:00:00.000Z',
  });
  const api = fakeApi();
  const { service } = setup({ api, stateStore });

  const status = await service.getStatus();
  assert.equal(status.health, 'stale');
  assert.equal(status.unhealthySince, '2026-10-01T12:00:00.000Z');
  assert.deepEqual(api.calls, []); // kota harcanmaz
});

// ── Faz 2: requestGoLive — hızlı dönüş + arka plan ─────────────────────────
// iOS Shortcuts'ın HTTP timeout'u 120 sn'lik ingest beklemesinden kısa: istek zaman
// aşımına uğruyordu, oysa iş doğru çalışıyordu. Artık uzun kısım arka planda.

const fakeEncoderCheck = (status, message = 'test') => ({
  name: 'encoder',
  run: async () => ({ status, message, detail: { ageSeconds: 7200 } }),
});

function fakeAlerter() {
  const sent = [];
  return { sent, alert: async (p) => { sent.push(p); } };
}

test('requestGoLive: uzun iş arka planda, çağrı hemen accepted döner', async () => {
  const api = fakeApi();
  const { service } = setup({ api });

  const result = await service.requestGoLive();
  assert.equal(result.action, 'accepted');
  assert.ok(result.startedAt);
  // Arka plan henüz bitmiş olmayabilir: lastRun 'running' ile başlar.
  const during = await service.getStatus();
  assert.ok(['running', 'done'].includes(during.lastRun.phase));

  await service.inFlight; // arka planı bekle
  const after = await service.getStatus();
  assert.equal(after.lastRun.phase, 'done');
  assert.equal(after.lastRun.action, 'went-live');
  assert.ok(names(api.calls).includes('transitionBroadcast'));
});

test('requestGoLive: arka plan hatası lastRun’a yazılır ve BİLDİRİM gönderilir', async () => {
  // 202 döndükten sonra hatayı gören kimse olmayabilir: bildirim bu yüzden şart.
  const api = fakeApi({ failOn: { insertBroadcast: new Error('kota doldu') } });
  const alerter = fakeAlerter();
  const { service } = setup({ api, alerter });

  assert.equal((await service.requestGoLive()).action, 'accepted');
  await service.inFlight;

  const status = await service.getStatus();
  assert.equal(status.lastRun.phase, 'failed');
  assert.match(status.lastRun.error.message, /kota doldu/);
  assert.equal(alerter.sent.length, 1);
  assert.equal(alerter.sent[0].level, 'error');
  assert.match(alerter.sent[0].title, /go-live başarısız/);
});

// ÖN KONTROL 1: encoder basmıyorsa ingest beklemek boşuna — senkron, görünür ret.
test('requestGoLive: encoder kalp atışı durmuşsa encoder_not_streaming (API’ye hiç gitmez)', async () => {
  const api = fakeApi();
  const { service } = setup({ api, encoderCheck: fakeEncoderCheck('unhealthy', 'ENCODER DURMUŞ: 120 dk') });

  const err = await service.requestGoLive().then(() => null, (e) => e);
  assert.ok(err instanceof GoLiveError);
  assert.equal(err.code, 'encoder_not_streaming');
  assert.match(err.message, /ENCODER DURMUŞ/);
  assert.match(err.message, /systemctl restart yt-streamer/);
  assert.deepEqual(api.calls, [], 'encoder ölüyken kota harcanmamalı');
  assert.equal(service.busy, false);
});

test('requestGoLive: encoder sağlıklıysa akış sürer', async () => {
  const api = fakeApi();
  const { service } = setup({ api, encoderCheck: fakeEncoderCheck('healthy') });
  assert.equal((await service.requestGoLive()).action, 'accepted');
  await service.inFlight;
});

test('requestGoLive: encoder ‘skipped’ ise (yayın hiç başlamamış) akış sürer', async () => {
  const api = fakeApi();
  const { service } = setup({ api, encoderCheck: fakeEncoderCheck('skipped') });
  assert.equal((await service.requestGoLive()).action, 'accepted');
  await service.inFlight;
});

// ÖN KONTROL 2: kayıtta stale izi varsa grace önceki turda harcandı, tekrar beklenmez.
test('requestGoLive: kayıtta stale izi + ingest hâlâ ölü → senkron stale_broadcast', async () => {
  const stateStore = fakeStateStore({
    broadcastId: 'b', streamId: STREAM_ID, status: 'live', health: 'stale',
    unhealthySince: '2026-10-01T12:00:00.000Z',
  });
  const api = fakeApi({ streams: [{ streamStatus: 'inactive', healthStatus: 'noData' }] });
  const { service } = setup({ api, stateStore });

  const err = await service.requestGoLive().then(() => null, (e) => e);
  assert.equal(err.code, 'stale_broadcast');
  // Tek örnek yeter: grace beklenmedi (uzun yola girilmedi).
  assert.ok(!names(api.calls).includes('insertBroadcast'));
  assert.equal(names(api.calls).filter((n) => n === 'getStreamStatus').length, 1);
});

test('requestGoLive: stale izi var ama ingest toparlanmışsa akış sürer', async () => {
  const stateStore = fakeStateStore({
    broadcastId: 'b', streamId: STREAM_ID, status: 'live', health: 'stale',
  });
  const api = fakeApi({
    broadcasts: { b: { id: 'b', status: { lifeCycleStatus: 'live' } } },
    streams: [{ streamStatus: 'active', healthStatus: 'good' }],
  });
  const { service, lines } = setup({ api, stateStore });

  const result = await service.requestGoLive();
  assert.equal(result.action, 'already-live');
  assert.ok(lines.some((l) => /stale izi geçersiz/.test(l.m)));
});

// ÖN KONTROL 3: zaten sağlıklı akıyorsa telefon arka planı beklemesin.
test('requestGoLive: zaten canlı + ingest sağlıklı → senkron already-live', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'b', streamId: STREAM_ID, status: 'live', title: 't' });
  const api = fakeApi({
    broadcasts: { b: { id: 'b', status: { lifeCycleStatus: 'live' } } },
    streams: [{ streamStatus: 'active', healthStatus: 'good' }],
  });
  const { service } = setup({ api, stateStore });

  const result = await service.requestGoLive();
  assert.equal(result.action, 'already-live');
  assert.equal(result.broadcastId, 'b');
  assert.ok(!names(api.calls).includes('insertBroadcast'));
  assert.equal(service.busy, false);
});

// Tek örnek sağlıksızsa KARAR VERİLMEZ: albüm geçişinde ingest kısa süre inactive
// görünür, senkron ret yanlış alarm olurdu — uzun yol grace ile bakar.
test('requestGoLive: canlı + ilk örnek sağlıksız (stale izi yok) → accepted, grace arka planda', async () => {
  const stateStore = fakeStateStore({ broadcastId: 'b', streamId: STREAM_ID, status: 'live' });
  const api = fakeApi({
    broadcasts: { b: { id: 'b', status: { lifeCycleStatus: 'live' } } },
    streams: [
      { streamStatus: 'inactive', healthStatus: 'noData' }, // ön kontrol örneği
      { streamStatus: 'active', healthStatus: 'good' }, // grace içinde toparlandı
    ],
  });
  let t = 0;
  const { service } = setup({ api, stateStore, staleGraceMs: 10_000, now: () => (t += 10) });

  assert.equal((await service.requestGoLive()).action, 'accepted');
  await service.inFlight;
  const status = await service.getStatus();
  assert.equal(status.lastRun.action, 'already-live');
});

test('requestGoLive: sürerken ikinci istek busy ile reddedilir (çift dokunma)', async () => {
  const api = fakeApi();
  const { service } = setup({ api });

  await service.requestGoLive();
  const err = await service.requestGoLive().then(() => null, (e) => e);
  assert.equal(err.code, 'busy');
  await service.inFlight;
});

test('goLive (CLI yolu) hâlâ senkron: sonucu bekler', async () => {
  const api = fakeApi();
  const { service } = setup({ api });
  const result = await service.goLive();
  assert.equal(result.action, 'went-live');
});

// ── VOD gizliliği: yayın bitince kaydı liste dışına al ───────────────────────
//
// Bu sistemde "yayın bitti" OLAYI yok (transition('complete') hiç çağrılmıyor).
// Bitiş yalnızca kayıtlı broadcast'in lifeCycleStatus'u 'complete' görülünce anlaşılır —
// ve orası broadcast.json'ı siliyor. Kuyruğa yazma o silmeden ÖNCE olmalı.

const VOD_CONFIG = { ...BROADCAST_CONFIG, vodPrivacy: 'unlisted' };

// Kayıtta 'live' duran ama YouTube'da bitmiş bir broadcast: keşif yolunu tetikler.
function endedSetup(extra = {}) {
  const api = fakeApi({
    broadcasts: { 'old-1': { id: 'old-1', snippet: { title: 'Eski yayın' }, status: { lifeCycleStatus: 'complete', privacyStatus: 'public' } } },
  });
  const stateStore = fakeStateStore({ broadcastId: 'old-1', streamId: STREAM_ID, status: 'live', title: 'Eski yayın' });
  const pendingVods = fakePendingVods();
  return { ...setup({ api, stateStore, broadcastConfig: VOD_CONFIG, pendingVods, ...extra }), pendingVods };
}

test('VOD: bitmiş broadcast keşfedilince kuyruğa alınır ve hemen çevrilir', async () => {
  const { service, api, stateStore, pendingVods } = endedSetup();
  await service.goLive();

  assert.deepEqual(api.calls.filter((c) => c[0] === 'updateVideoPrivacy'), [['updateVideoPrivacy', 'old-1', 'unlisted']]);
  // Çevrildi → kuyruktan düştü.
  assert.deepEqual(pendingVods.pending, []);
  // Eski kayıt temizlendi, yeni broadcast açıldı (mevcut davranış bozulmadı).
  assert.equal(stateStore.state.broadcastId, 'bid-1');
});

test('VOD: çevirme hata verirse kayıt kuyrukta KALIR, go-live devam eder', async () => {
  const api = fakeApi({
    broadcasts: { 'old-1': { id: 'old-1', snippet: { title: 'E' }, status: { lifeCycleStatus: 'complete' } } },
    failOn: { updateVideoPrivacy: new Error('503 backend error') },
  });
  const pendingVods = fakePendingVods();
  const { service, lines } = setup({
    api,
    stateStore: fakeStateStore({ broadcastId: 'old-1', streamId: STREAM_ID, status: 'live' }),
    broadcastConfig: VOD_CONFIG,
    pendingVods,
  });
  const result = await service.goLive();

  assert.equal(result.action, 'went-live'); // bir gizlilik ayarı yayını düşürmez
  assert.deepEqual(pendingVods.pending.map((e) => e.broadcastId), ['old-1']);
  assert.ok(lines.some((l) => l.level === 'warn' && /kuyrukta kaldı/.test(l.m)));
});

test('VOD: kuyruğa yazılamazsa (disk dolu) go-live yine sürer, uyarı loglanır', async () => {
  const { service, lines } = endedSetup({ pendingVods: fakePendingVods([], { failWrite: true }) });
  const result = await service.goLive();

  assert.equal(result.action, 'went-live');
  assert.ok(lines.some((l) => l.level === 'warn' && /public kalabilir/.test(l.m)));
});

test('VOD: vodPrivacy null ise kuyruğa hiç alınmaz, çevirme çağrısı yapılmaz', async () => {
  const api = fakeApi({
    broadcasts: { 'old-1': { id: 'old-1', snippet: { title: 'E' }, status: { lifeCycleStatus: 'complete' } } },
  });
  const pendingVods = fakePendingVods();
  const { service } = setup({
    api,
    stateStore: fakeStateStore({ broadcastId: 'old-1', streamId: STREAM_ID, status: 'live' }),
    broadcastConfig: BROADCAST_CONFIG, // vodPrivacy yok
    pendingVods,
  });
  await service.goLive();

  assert.deepEqual(pendingVods.pending, []);
  assert.ok(!names(api.calls).includes('updateVideoPrivacy'));
});

test('VOD: checkIngestHealth bekleyen işleri tekrar dener (periyodik kurtarma)', async () => {
  const api = fakeApi();
  const pendingVods = fakePendingVods([{ broadcastId: 'stuck-1', title: 'T', discoveredAt: 'dün' }]);
  const { service } = setup({
    api,
    stateStore: fakeStateStore({ broadcastId: 'cur', streamId: STREAM_ID, status: 'live' }),
    broadcastConfig: VOD_CONFIG,
    pendingVods,
  });
  await service.checkIngestHealth();

  assert.deepEqual(api.calls.filter((c) => c[0] === 'updateVideoPrivacy'), [['updateVideoPrivacy', 'stuck-1', 'unlisted']]);
  assert.deepEqual(pendingVods.pending, []);
});

test('VOD: kuyruk boşken checkIngestHealth hiç çevirme çağrısı yapmaz (kota)', async () => {
  const api = fakeApi();
  const { service } = setup({
    api,
    stateStore: fakeStateStore(null), // kayıtlı yayın da yok → hiç API çağrısı olmamalı
    broadcastConfig: VOD_CONFIG,
    pendingVods: fakePendingVods(),
  });
  const result = await service.checkIngestHealth();

  assert.equal(result.skipped, true);
  assert.deepEqual(api.calls, []);
});

test('VOD: bir kaydın hatası diğerlerini engellemez', async () => {
  const api = fakeApi({ failOn: {} });
  let n = 0;
  const base = api.updateVideoPrivacy;
  api.updateVideoPrivacy = async (opts) => {
    n += 1;
    if (opts.videoId === 'bad') { api.calls.push(['updateVideoPrivacy', 'bad', opts.privacyStatus]); throw new Error('403'); }
    return base(opts);
  };
  const pendingVods = fakePendingVods([
    { broadcastId: 'ok-1' }, { broadcastId: 'bad' }, { broadcastId: 'ok-2' },
  ]);
  const { service } = setup({
    api,
    stateStore: fakeStateStore({ broadcastId: 'cur', streamId: STREAM_ID, status: 'live' }),
    broadcastConfig: VOD_CONFIG,
    pendingVods,
  });
  await service.checkIngestHealth();

  assert.equal(n, 3); // üçü de denendi
  assert.deepEqual(pendingVods.pending.map((e) => e.broadcastId), ['bad']); // yalnız hatalı kaldı
});
