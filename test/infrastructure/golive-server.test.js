// GoLiveServer testleri: gerçek node:http, port 0 (işletim sistemi boş port verir).
const test = require('node:test');
const assert = require('node:assert/strict');

const { GoLiveServer } = require('../../src/infrastructure/golive-server');

const TOKEN = 'u7qN2xKpR9sL4vB8mZ3cW6yD1aF5gH0jT2eQ4rU7iO9';

function fakeLog() {
  const lines = [];
  const rec = (level) => (m) => lines.push({ level, m });
  return { lines, log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') } };
}

function fakeService({ goLiveResult, goLiveError, status = { broadcastId: null } } = {}) {
  const calls = [];
  return {
    calls,
    // requestGoLive: uzun is arka planda surer, istek hemen doner (Faz 2).
    requestGoLive: async () => {
      calls.push(['requestGoLive']);
      if (goLiveError) throw goLiveError;
      return goLiveResult ?? { action: 'accepted', startedAt: '2026-10-02T10:00:00.000Z' };
    },
    getStatus: async (opts) => { calls.push(['getStatus', opts]); return status; },
  };
}

// Her test kendi sunucusunu port 0'da açar, sonunda kapatır.
async function withServer(options, body) {
  const { log, lines } = fakeLog();
  const server = new GoLiveServer({ authToken: TOKEN, log, port: 0, ...options });
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  const call = async (path, { method = 'GET', token = TOKEN, headers = {}, ...rest } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...rest,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  try {
    return await body({ call, base, lines, server });
  } finally {
    await server.close();
  }
}

test('token yoksa ya da 32 karakterden kısaysa sunucu başlamaz (fail-closed)', () => {
  const { log } = fakeLog();
  for (const bad of ['', '   ', 'kisa-token', undefined, null]) {
    assert.throws(() => new GoLiveServer({ goLiveService: fakeService(), authToken: bad, log }),
      /GOLIVE_AUTH_TOKEN eksik ya da 32 karakterden kısa/);
  }
});

// Uzun ingest beklemesi arka planda: istek 202 ile HEMEN doner (iOS Shortcuts timeout'u).
test('POST /go-live: kabul edilen istek 202 döner', () => withServer(
  { goLiveService: fakeService() },
  async ({ call }) => {
    const res = await call('/go-live', { method: 'POST' });
    assert.equal(res.status, 202);
    assert.equal(res.json.action, 'accepted');
    assert.equal(res.json.ok, true);
  },
));

test('POST /go-live: zaten canlıysa 202 değil 200 (yapılacak iş yok)', () => withServer(
  { goLiveService: fakeService({ goLiveResult: { action: 'already-live', broadcastId: 'bid-9' } }) },
  async ({ call }) => {
    const res = await call('/go-live', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, action: 'already-live', broadcastId: 'bid-9' });
  },
));

// Encoder basmiyorken ingest beklemek bosuna: senkron, gorunur ret.
test('POST /go-live: encoder yayın yapmıyorsa 409', () => withServer(
  {
    goLiveService: fakeService({
      goLiveError: Object.assign(new Error('encoder yayın yapmıyor: ENCODER DURMUŞ'), {
        code: 'encoder_not_streaming', details: { ageSeconds: 7200 },
      }),
    }),
  },
  async ({ call, lines }) => {
    const res = await call('/go-live', { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'encoder_not_streaming');
    assert.deepEqual(res.json.details, { ageSeconds: 7200 });
    assert.ok(lines.some((l) => l.level === 'error'));
  },
));

test('POST /go-live: stale broadcast 409 (başarı gibi görünmesin)', () => withServer(
  {
    goLiveService: fakeService({
      goLiveError: Object.assign(new Error('ingest veri almıyor'), {
        code: 'stale_broadcast', details: { broadcastId: 'b' },
      }),
    }),
  },
  async ({ call }) => {
    const res = await call('/go-live', { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'stale_broadcast');
  },
));

test('token yanlışsa 401 ve servis HİÇ çağrılmaz', () => {
  const service = fakeService();
  return withServer({ goLiveService: service }, async ({ call, lines }) => {
    const res = await call('/go-live', { method: 'POST', token: 'yanlis-token-ama-yeterince-uzun-abcdefgh' });
    assert.equal(res.status, 401);
    assert.deepEqual(service.calls, []);
    // Token asla loglanmaz.
    assert.ok(lines.some((l) => /yetkisiz istek/.test(l.m)));
    assert.ok(!lines.some((l) => l.m.includes('yanlis-token')));
  });
});

test('token hiç yoksa 401', () => withServer(
  { goLiveService: fakeService() },
  async ({ call }) => {
    assert.equal((await call('/go-live', { method: 'POST', token: null })).status, 401);
  },
));

// iOS'ta Safari'den tek dokunuşla tetikleme için: header eklemek Shortcuts gerektiriyor.
test('token URL parametresiyle de kabul edilir (Safari yolu)', () => withServer(
  { goLiveService: fakeService() },
  async ({ call }) => {
    const res = await call(`/go-live?token=${TOKEN}`, { method: 'POST', token: null });
    assert.equal(res.status, 202); // kabul edildi (Faz 2: uzun iş arka planda)
  },
));

test('GET /go-live → 405 (yanlış metot)', () => withServer(
  { goLiveService: fakeService() },
  async ({ call }) => {
    const res = await call('/go-live');
    assert.equal(res.status, 405);
    assert.equal(res.json.hint, 'POST /go-live');
  },
));

test('eşzamanlı istek (busy) → 409', () => withServer(
  { goLiveService: fakeService({ goLiveError: Object.assign(new Error('go-live şu an sürüyor'), { code: 'busy' }) }) },
  async ({ call }) => {
    const res = await call('/go-live', { method: 'POST' });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'busy');
  },
));

test('go-live hatası → 502 ve hata kodu gövdede', () => withServer(
  {
    goLiveService: fakeService({
      goLiveError: Object.assign(new Error('ingest aktif olmadı'), { code: 'ingest_not_active' }),
    }),
  },
  async ({ call }) => {
    const res = await call('/go-live', { method: 'POST' });
    assert.equal(res.status, 502);
    assert.equal(res.json.error, 'ingest_not_active');
    assert.match(res.json.message, /ingest aktif olmadı/);
  },
));

test('GET /status: varsayılan refresh=false (kota korunur)', () => {
  const service = fakeService({ status: { broadcastId: 'b', status: 'live' } });
  return withServer({ goLiveService: service }, async ({ call }) => {
    const res = await call('/status');
    assert.equal(res.status, 200);
    assert.equal(res.json.broadcastId, 'b');
    assert.deepEqual(service.calls, [['getStatus', { refresh: false }]]);
  });
});

test('GET /status?refresh=1 → refresh=true', () => {
  const service = fakeService();
  return withServer({ goLiveService: service }, async ({ call }) => {
    await call('/status?refresh=1');
    assert.deepEqual(service.calls, [['getStatus', { refresh: true }]]);
  });
});

test('/healthz auth\'suz çalışır ve bilgi sızdırmaz', () => withServer(
  { goLiveService: fakeService() },
  async ({ call }) => {
    const res = await call('/healthz', { token: null });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
  },
));

test('bilinmeyen route → 404', () => withServer(
  { goLiveService: fakeService() },
  async ({ call }) => {
    assert.equal((await call('/baska-sey')).status, 404);
  },
));

test('sondaki slash yoksayılır (/go-live/ = /go-live)', () => withServer(
  { goLiveService: fakeService() },
  async ({ call }) => {
    assert.equal((await call('/go-live/', { method: 'POST' })).status, 202);
  },
));

test('çok büyük gövde reddedilir (413)', () => withServer(
  { goLiveService: fakeService() },
  async ({ call }) => {
    const res = await call('/go-live', { method: 'POST', body: 'x'.repeat(20000) });
    assert.equal(res.status, 413);
  },
));

test('hız sınırı aşılınca 429', () => withServer(
  { goLiveService: fakeService(), now: () => 1000 }, // sabit zaman: pencere ilerlemiyor
  async ({ call }) => {
    const codes = [];
    for (let i = 0; i < 62; i++) codes.push((await call('/status')).status);
    assert.ok(codes.includes(429), 'bir noktada 429 dönmeli');
    assert.equal(codes[0], 200);
  },
));

// 10 Ekim 2026: tek global sayaç vardı ve /status yoklaması /go-live'ı kilitliyordu.
test('sık /status yoklaması /go-live bütçesini YEMEZ (ayrı kovalar)', () => withServer(
  { goLiveService: fakeService(), now: () => 1000 },
  async ({ call }) => {
    for (let i = 0; i < 61; i++) await call('/status'); // kendi kovasını doldur
    assert.equal((await call('/status')).status, 429, '/status kovası dolmuş olmalı');
    assert.equal((await call('/go-live', { method: 'POST' })).status, 202, 'yayın açma hâlâ çalışmalı');
  },
));

test('yetkisiz istekler meşru kullanıcının bütçesini YEMEZ', () => withServer(
  { goLiveService: fakeService(), now: () => 1000 },
  async ({ call }) => {
    const codes = [];
    for (let i = 0; i < 25; i++) codes.push((await call('/status', { token: 'yanlis-token' })).status);
    assert.ok(codes.includes(401), 'yetkisiz istek 401 almalı');
    assert.ok(codes.includes(429), 'yetkisiz istekler de kendi kovasında sınırlı');
    assert.equal((await call('/status')).status, 200, 'tokenı olanın yolu açık kalmalı');
  },
));

test('/go-live kendi (dar) bütçesinde sınırlanır', () => withServer(
  { goLiveService: fakeService(), now: () => 1000 },
  async ({ call }) => {
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await call('/go-live', { method: 'POST' })).status);
    assert.equal(codes[0], 202);
    assert.ok(codes.includes(429));
    assert.equal((await call('/status')).status, 200, 'durum sorgusu etkilenmemeli');
  },
));

test('varsayılan bind 127.0.0.1 (dışarıya açılmaz)', () => {
  const { log } = fakeLog();
  const server = new GoLiveServer({ goLiveService: fakeService(), authToken: TOKEN, log });
  assert.equal(server.host, '127.0.0.1');
  assert.equal(server.port, 8787);
});

// ─── /config (Faz N2) ──────────────────────────────────────────────────────

function fakeConfigApi({ saveResult = { ok: true, plan: {}, warnings: [], restarted: false, restartError: null } } = {}) {
  const saveCalls = [];
  return {
    saveCalls,
    form: async () => ({ plan: { name: 'adsız', pomodoro: { enabled: false, type: '50+10', studyVideos: [], breakVideos: [] } }, clips: ['/clips/a.mp4'] }),
    save: async (fields) => { saveCalls.push(fields); return saveResult; },
  };
}

test('configApi verilmezse /config 404 döner (mevcut kurulumlar etkilenmez)', () => withServer(
  { goLiveService: fakeService() },
  async ({ call }) => {
    const res = await call('/config');
    assert.equal(res.status, 404);
  },
));

test('GET /config: HTML döner, configApi.form() çağrılır', () => withServer(
  { goLiveService: fakeService(), configApi: fakeConfigApi() },
  async ({ base }) => {
    const res = await fetch(`${base}/config?token=${TOKEN}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /<!doctype html>/i);
  },
));

test('GET /config: token olmadan 401 (auth diğer route\'larla aynı)', () => withServer(
  { goLiveService: fakeService(), configApi: fakeConfigApi() },
  async ({ call }) => {
    const res = await call('/config', { token: null });
    assert.equal(res.status, 401);
  },
));

test('/config kendi hız sınırı kovasında', () => withServer(
  { goLiveService: fakeService(), configApi: fakeConfigApi(), now: () => 1000 },
  async ({ base }) => {
    const codes = [];
    for (let i = 0; i < 32; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${base}/config?token=${TOKEN}`);
      codes.push(res.status);
    }
    assert.ok(codes.includes(429), '30 isteklik sınır aşılmalı');
  },
));

test('POST /config: form alanları configApi.save\'e doğru şekilde taşınır', async () => {
  const { log } = fakeLog();
  const api = fakeConfigApi();
  const server = new GoLiveServer({ authToken: TOKEN, log, port: 0, goLiveService: fakeService(), configApi: api });
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const body = new URLSearchParams();
    body.append('pomodoroEnabled', 'on');
    body.append('pomodoroType', '45+15');
    body.append('studyVideos', '/clips/a.mp4');
    body.append('studyVideos', '/clips/b.mp4');
    body.append('breakVideos', '/clips/c.mp4');
    body.append('action', 'save_restart');
    const res = await fetch(`${base}/config?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    assert.equal(res.status, 200);
    assert.equal(api.saveCalls.length, 1);
    assert.deepEqual(api.saveCalls[0], {
      pomodoroEnabled: true,
      pomodoroType: '45+15',
      studyVideos: ['/clips/a.mp4', '/clips/b.mp4'],
      breakVideos: ['/clips/c.mp4'],
      restart: true,
    });
  } finally {
    await server.close();
  }
});

test('POST /config: başarısız save hatayla aynı sayfayı basar, 200 döner', async () => {
  const { log } = fakeLog();
  const api = fakeConfigApi({ saveResult: { ok: false, error: 'listede olmayan klip yolu reddedildi: /etc/passwd' } });
  const server = new GoLiveServer({ authToken: TOKEN, log, port: 0, goLiveService: fakeService(), configApi: api });
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const res = await fetch(`${base}/config?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'studyVideos=%2Fetc%2Fpasswd',
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /listede olmayan klip yolu reddedildi/);
  } finally {
    await server.close();
  }
});

// ─── /config/thumb ─────────────────────────────────────────────────────────

test('thumbnailProvider yoksa /config/thumb 404 döner', () => withServer(
  { goLiveService: fakeService(), configApi: fakeConfigApi() },
  async ({ call }) => {
    const res = await call('/config/thumb?file=%2Fclips%2Fa.mp4');
    assert.equal(res.status, 404);
  },
));

test('GET /config/thumb: listedeki klip için thumbnailProvider çağrılır, JPEG döner', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { log } = fakeLog();
  const api = fakeConfigApi();
  let requestedFile = null;
  const fakeJpg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yt-thumbtest-')), 'x.jpg');
  fs.writeFileSync(fakeJpg, Buffer.from([0xff, 0xd8, 0xff]));
  const server = new GoLiveServer({
    authToken: TOKEN, log, port: 0, goLiveService: fakeService(), configApi: api,
    thumbnailProvider: async (file) => { requestedFile = file; return fakeJpg; },
  });
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const res = await fetch(`${base}/config/thumb?token=${TOKEN}&file=${encodeURIComponent('/clips/a.mp4')}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/jpeg/);
    assert.equal(requestedFile, '/clips/a.mp4');
  } finally {
    await server.close();
  }
});

test('GET /config/thumb: listede olmayan yol reddedilir (404, traversal kapalı)', async () => {
  const { log } = fakeLog();
  const api = fakeConfigApi();
  let called = false;
  const server = new GoLiveServer({
    authToken: TOKEN, log, port: 0, goLiveService: fakeService(), configApi: api,
    thumbnailProvider: async () => { called = true; return 'ignored'; },
  });
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const res = await fetch(`${base}/config/thumb?token=${TOKEN}&file=${encodeURIComponent('/etc/passwd')}`);
    assert.equal(res.status, 404);
    assert.equal(called, false, 'listede olmayan yol için thumbnailProvider hiç çağrılmamalı');
  } finally {
    await server.close();
  }
});

test('GET /config/thumb: thumbnailProvider null dönerse 404 (üretilemedi)', async () => {
  const { log } = fakeLog();
  const api = fakeConfigApi();
  const server = new GoLiveServer({
    authToken: TOKEN, log, port: 0, goLiveService: fakeService(), configApi: api,
    thumbnailProvider: async () => null,
  });
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const res = await fetch(`${base}/config/thumb?token=${TOKEN}&file=${encodeURIComponent('/clips/a.mp4')}`);
    assert.equal(res.status, 404);
  } finally {
    await server.close();
  }
});

test('POST /config: başarılı restart notice\'ta görünür', async () => {
  const { log } = fakeLog();
  const api = fakeConfigApi({
    saveResult: { ok: true, plan: {}, warnings: [], restarted: true, restartError: null },
  });
  const server = new GoLiveServer({ authToken: TOKEN, log, port: 0, goLiveService: fakeService(), configApi: api });
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const res = await fetch(`${base}/config?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'action=save_restart',
    });
    const html = await res.text();
    assert.match(html, /yeniden başlatıldı/);
  } finally {
    await server.close();
  }
});

test('POST /config action=start/stop: control çağrılır, save ÇAĞRILMAZ', async () => {
  const { log } = fakeLog();
  const api = fakeConfigApi();
  const controls = [];
  api.control = async (a) => { controls.push(a); return { ok: true, message: `tamam-${a}` }; };
  const server = new GoLiveServer({ authToken: TOKEN, log, port: 0, goLiveService: fakeService(), configApi: api });
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    for (const action of ['start', 'stop']) {
      const res = await fetch(`${base}/config?token=${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `action=${action}`,
      });
      assert.equal(res.status, 200);
      assert.match(await res.text(), new RegExp(`tamam-${action}`));
    }
    assert.deepEqual(controls, ['start', 'stop']);
    assert.equal(api.saveCalls.length, 0, 'başlat/durdur plan kaydetmemeli');
  } finally {
    await server.close();
  }
});

test('POST /config action=start: control hata dönerse hata sayfada görünür', async () => {
  const { log } = fakeLog();
  const api = fakeConfigApi();
  api.control = async () => ({ ok: false, error: 'systemctl yok' });
  const server = new GoLiveServer({ authToken: TOKEN, log, port: 0, goLiveService: fakeService(), configApi: api });
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    const res = await fetch(`${base}/config?token=${TOKEN}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=start',
    });
    assert.match(await res.text(), /systemctl yok/);
  } finally {
    await server.close();
  }
});

// ─── Yayın seçici ve /config/broadcast ─────────────────────────────────────

function fakeAdmin(items, { failList = false } = {}) {
  const calls = [];
  const byId = (id) => items.find((b) => b.id === id) ?? null;
  return {
    calls,
    list: async () => { if (failList) throw new Error('kota doldu'); return items; },
    get: async (id) => byId(id),
    updateDetails: async (id, v) => { calls.push(['details', id, v.title, v.description]); },
    setPrivacy: async (id, p) => { calls.push(['privacy', id, p]); },
    setThumbnail: async (id, f) => { calls.push(['thumb', id, f]); },
    end: async (id) => { calls.push(['end', id]); },
  };
}

const B1 = {
  id: 'b1', title: 'Canlı Yayın', description: 'açıklama 1', privacyStatus: 'unlisted', lifeCycleStatus: 'live', finished: false,
};
const B2 = {
  id: 'b2', title: 'Hazır Yayın', description: 'açıklama 2', privacyStatus: 'private', lifeCycleStatus: 'ready', finished: false,
};

function apiWithCovers(covers = ['/c/a.jpg']) {
  const api = fakeConfigApi();
  const base = api.form;
  api.form = async () => ({ ...(await base()), covers });
  return api;
}

async function postBroadcast(base, query, fields) {
  return fetch(`${base}/config/broadcast?token=${TOKEN}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

test('GET /config: yayın seçici listeyi gösterir, kayıtlı (go-live) yayın seçili gelir', () => withServer(
  {
    goLiveService: fakeService({ status: { broadcastId: 'b2' } }),
    configApi: apiWithCovers(),
    broadcastAdmin: fakeAdmin([B1, B2]),
  },
  async ({ base }) => {
    const html = await (await fetch(`${base}/config?token=${TOKEN}`)).text();
    assert.match(html, /Canlı Yayın/);
    assert.match(html, /Hazır Yayın/);
    assert.match(html, /class="pickrow sel" href="[^"]*broadcast=b2"/);
    // Seçili yayının YouTube'daki mevcut değerleri formda dolu.
    assert.match(html, /name="title" value="Hazır Yayın"/);
    assert.match(html, />açıklama 2<\/textarea>/);
  },
));

test('GET /config?broadcast=b1: istenen yayın seçilir', () => withServer(
  {
    goLiveService: fakeService({ status: { broadcastId: 'b2' } }),
    configApi: apiWithCovers(),
    broadcastAdmin: fakeAdmin([B1, B2]),
  },
  async ({ base }) => {
    const html = await (await fetch(`${base}/config?token=${TOKEN}&broadcast=b1`)).text();
    assert.match(html, /name="title" value="Canlı Yayın"/);
    assert.match(html, /Yayını Bitir/); // canlı → bitirilebilir
  },
));

test('GET /config: listede olmayan broadcast id yok sayılır (kayıtlı/ilk aktif yayına düşer)', () => withServer(
  { goLiveService: fakeService(), configApi: apiWithCovers(), broadcastAdmin: fakeAdmin([B2, B1]) },
  async ({ base }) => {
    const html = await (await fetch(`${base}/config?token=${TOKEN}&broadcast=baskasinin`)).text();
    assert.doesNotMatch(html, /baskasinin/);
    assert.match(html, /name="title" value="Hazır Yayın"/); // ilk aktif
  },
));

test('GET /config: YouTube listesi okunamazsa sayfa yine açılır, kısa not gösterilir', () => withServer(
  { goLiveService: fakeService(), configApi: apiWithCovers(), broadcastAdmin: fakeAdmin([], { failList: true }) },
  async ({ base }) => {
    const res = await fetch(`${base}/config?token=${TOKEN}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Yayın listesi şu an okunamadı/);
  },
));

test('broadcastAdmin yoksa /config/broadcast 404, sayfada seçici yok', () => withServer(
  { goLiveService: fakeService(), configApi: apiWithCovers() },
  async ({ base }) => {
    assert.equal((await postBroadcast(base, '', { action: 'end', broadcastId: 'b1' })).status, 404);
    assert.doesNotMatch(await (await fetch(`${base}/config?token=${TOKEN}`)).text(), /YouTube Yayınları/);
  },
));

test('POST /config/broadcast apply: yalnızca DEĞİŞEN alanlar API\'ye gider', () => {
  const admin = fakeAdmin([B1]);
  return withServer(
    { goLiveService: fakeService(), configApi: apiWithCovers(), broadcastAdmin: admin },
    async ({ base }) => {
      const res = await postBroadcast(base, '&broadcast=b1', {
        action: 'apply', broadcastId: 'b1', title: 'Canlı Yayın', description: 'açıklama 1', privacy: 'unlisted', cover: '',
      });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /Değişiklik yok/);
      assert.deepEqual(admin.calls, []);

      await postBroadcast(base, '&broadcast=b1', {
        action: 'apply', broadcastId: 'b1', title: 'Yeni Başlık', description: 'açıklama 1', privacy: 'public', cover: '/c/a.jpg',
      });
      assert.deepEqual(admin.calls, [
        ['details', 'b1', 'Yeni Başlık', 'açıklama 1'],
        ['privacy', 'b1', 'public'],
        ['thumb', 'b1', '/c/a.jpg'],
      ]);
    },
  );
});

test('POST /config/broadcast apply: kapak listesinde olmayan dosya REDDEDİLİR', () => {
  const admin = fakeAdmin([B1]);
  return withServer(
    { goLiveService: fakeService(), configApi: apiWithCovers(['/c/a.jpg']), broadcastAdmin: admin },
    async ({ base }) => {
      const res = await postBroadcast(base, '', {
        action: 'apply', broadcastId: 'b1', title: 'Canlı Yayın', description: 'açıklama 1', privacy: 'unlisted', cover: '/etc/passwd',
      });
      assert.match(await res.text(), /listede olmayan dosya reddedildi/);
      assert.deepEqual(admin.calls, []);
    },
  );
});

test('POST /config/broadcast apply: bir adım hata verirse diğerleri uygulanır, sonuç özetlenir', () => {
  const admin = fakeAdmin([B1]);
  admin.setPrivacy = async () => { throw new Error('YouTube reddetti'); };
  return withServer(
    { goLiveService: fakeService(), configApi: apiWithCovers(), broadcastAdmin: admin },
    async ({ base }) => {
      const res = await postBroadcast(base, '', {
        action: 'apply', broadcastId: 'b1', title: 'Yeni', description: 'açıklama 1', privacy: 'public', cover: '',
      });
      const html = await res.text();
      assert.match(html, /görünürlük: YouTube reddetti/);
      assert.match(html, /uygulananlar: başlık\/açıklama/);
      assert.equal(admin.calls[0][0], 'details');
    },
  );
});

test('POST /config/broadcast end: yayın bitirilir; hata sayfada görünür', () => {
  const admin = fakeAdmin([B1]);
  return withServer(
    { goLiveService: fakeService(), configApi: apiWithCovers(), broadcastAdmin: admin },
    async ({ base }) => {
      const ok = await postBroadcast(base, '', { action: 'end', broadcastId: 'b1' });
      assert.match(await ok.text(), /Yayın bitirildi/);
      assert.deepEqual(admin.calls, [['end', 'b1']]);

      admin.end = async () => { throw new Error('yayın şu an canlı değil'); };
      const bad = await postBroadcast(base, '', { action: 'end', broadcastId: 'b1' });
      assert.match(await bad.text(), /canlı değil/);
    },
  );
});

test('POST /config/broadcast: bilinmeyen işlem reddedilir; GET 405; yetkisiz 401', () => withServer(
  { goLiveService: fakeService(), configApi: apiWithCovers(), broadcastAdmin: fakeAdmin([B1]) },
  async ({ base, call }) => {
    assert.match(await (await postBroadcast(base, '', { action: 'sil', broadcastId: 'b1' })).text(), /bilinmeyen işlem/);
    assert.equal((await call('/config/broadcast')).status, 405);
    assert.equal((await call('/config/broadcast', { method: 'POST', token: null })).status, 401);
  },
));

// ─── /config/upload ────────────────────────────────────────────────────────

function multipartBody(parts) {
  const boundary = '----testboundary123';
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename ?? 'a.jpg'}"\r\nContent-Type: image/jpeg\r\n\r\n`));
    chunks.push(p.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}

test('POST /config/upload: görsel uploadCover\'a iletilir ve yeni kapak seçili gelir', () => {
  const api = apiWithCovers(['/c/a.jpg', '/c/galeri-1.jpg']);
  let received = null;
  api.uploadCover = async (buf) => { received = buf; return { ok: true, path: '/c/galeri-1.jpg' }; };
  return withServer(
    { goLiveService: fakeService(), configApi: api },
    async ({ base }) => {
      const data = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x0d, 0x0a, 0x01]);
      const { body, type } = multipartBody([{ name: 'coverFile', data }]);
      const res = await fetch(`${base}/config/upload?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': type }, body });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.deepEqual([...received], [...data], 'ikili veri bozulmadan ulaşmalı');
      assert.match(html, /Görsel eklendi/);
      assert.match(html, /name="cover" value="\/c\/galeri-1\.jpg" checked/);
    },
  );
});

test('POST /config/upload: dosya seçilmemişse / uploadCover hata verirse mesajla aynı sayfa', () => {
  const api = apiWithCovers();
  api.uploadCover = async () => ({ ok: false, error: 'görsel yüklenemedi: desteklenmeyen biçim' });
  return withServer(
    { goLiveService: fakeService(), configApi: api },
    async ({ base }) => {
      const empty = multipartBody([{ name: 'coverFile', data: Buffer.alloc(0) }]);
      const r1 = await fetch(`${base}/config/upload?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': empty.type }, body: empty.body });
      assert.match(await r1.text(), /görsel seçilmedi/);
      const some = multipartBody([{ name: 'coverFile', data: Buffer.from('x') }]);
      const r2 = await fetch(`${base}/config/upload?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': some.type }, body: some.body });
      assert.match(await r2.text(), /desteklenmeyen biçim/);
    },
  );
});

test('POST /config/upload: uploadCover yoksa 404; yetkisiz 401; GET 405', () => withServer(
  { goLiveService: fakeService(), configApi: apiWithCovers() },
  async ({ call }) => {
    assert.equal((await call('/config/upload', { method: 'POST' })).status, 404);
    assert.equal((await call('/config/upload', { method: 'POST', token: null })).status, 401);
    assert.equal((await call('/config/upload')).status, 405);
  },
));

// ─── Yeni yayın ve ek yayınlar (/config/new, /config/instance) ─────────────

function fakeManager({ instances = [], create = async () => ({ ok: true, message: 'kuruldu' }), control = async () => ({ ok: true, message: 'tamam' }) } = {}) {
  const calls = [];
  return {
    calls,
    list: () => instances,
    albums: () => [{ name: 'mimi', trackCount: 5, backgrounds: ['/m/mimi/bg.mp4'] }],
    create: async (input) => { calls.push(['create', input]); return create(input); },
    control: async (name, action) => { calls.push(['control', name, action]); return control(name, action); },
  };
}

test('GET /config: streamManager varsa dropdown\'da "+ Yeni yayın" ve Ek Yayınlar görünür; albüm kataloğu SADECE yeni modda okunur', () => {
  let albumReads = 0;
  const mgr = fakeManager({ instances: [{ name: 'lofi2', state: 'running' }] });
  mgr.albums = () => { albumReads += 1; return []; };
  return withServer(
    { goLiveService: fakeService(), configApi: apiWithCovers(), broadcastAdmin: fakeAdmin([B1]), streamManager: mgr },
    async ({ base }) => {
      const html = await (await fetch(`${base}/config?token=${TOKEN}`)).text();
      assert.match(html, /\+ Yeni yayın aç…/);
      assert.match(html, /<strong>lofi2<\/strong> · Çalışıyor/);
      assert.equal(albumReads, 0, 'normal sayfada albüm kataloğu diskten okunmamalı');
      const form = await (await fetch(`${base}/config?token=${TOKEN}&new=1`)).text();
      assert.equal(albumReads, 1);
      assert.match(form, /action="\/config\/new\?token=/);
      assert.match(form, /name="goLiveNow"/);
    },
  );
});

test('GET /config?new=1: streamManager yoksa normal sayfa açılır (form yok)', () => withServer(
  { goLiveService: fakeService(), configApi: apiWithCovers(), broadcastAdmin: fakeAdmin([B1]) },
  async ({ base }) => {
    const html = await (await fetch(`${base}/config?token=${TOKEN}&new=1`)).text();
    assert.doesNotMatch(html, /\/config\/new/);
    assert.match(html, /value="apply"/);
  },
));

test('POST /config/new: alanlar create\'e taşınır; başarıda mesaj ve normal sayfa', () => {
  const mgr = fakeManager();
  return withServer(
    { goLiveService: fakeService(), configApi: apiWithCovers(), broadcastAdmin: fakeAdmin([B1]), streamManager: mgr },
    async ({ base }) => {
      const body = new URLSearchParams();
      body.set('name', 'lofi2'); body.set('title', 'Gece'); body.set('description', 'açıklama');
      body.set('privacy', 'public'); body.set('cover', '/c/a.jpg'); body.set('goLiveNow', 'on');
      body.append('albums', 'mimi'); body.append('albums', 'zen');
      const res = await fetch(`${base}/config/new?token=${TOKEN}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
      });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /class="notice">kuruldu/);
      assert.doesNotMatch(html, /name="goLiveNow"/, 'başarıdan sonra form kapanır');
      assert.deepEqual(mgr.calls[0][1], {
        name: 'lofi2', title: 'Gece', description: 'açıklama', privacy: 'public', cover: '/c/a.jpg', albums: ['mimi', 'zen'], goLiveNow: true,
      });
    },
  );
});

test('POST /config/new: hata olursa form AÇIK kalır, girdiler korunur, hata gösterilir', () => {
  const mgr = fakeManager({ create: async () => ({ ok: false, error: 'kapasite dolu: şu an 2 yayın çalışıyor' }) });
  return withServer(
    { goLiveService: fakeService(), configApi: apiWithCovers(), broadcastAdmin: fakeAdmin([B1]), streamManager: mgr },
    async ({ base }) => {
      const res = await fetch(`${base}/config/new?token=${TOKEN}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=lofi2&title=Gece&albums=mimi',
      });
      const html = await res.text();
      assert.match(html, /class="error">kapasite dolu/);
      assert.match(html, /name="name" value="lofi2"/);
      assert.match(html, /name="title" value="Gece"/);
      assert.match(html, /name="albums" value="mimi" checked/);
      assert.doesNotMatch(html, /name="goLiveNow" checked/, 'işaretlenmemişti, işaretli gelmemeli');
    },
  );
});

test('POST /config/instance: control çağrılır; hata sayfada görünür', () => {
  const mgr = fakeManager();
  return withServer(
    { goLiveService: fakeService(), configApi: apiWithCovers(), streamManager: mgr },
    async ({ base }) => {
      const post = (fields) => fetch(`${base}/config/instance?token=${TOKEN}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
      });
      assert.match(await (await post({ name: 'lofi2', action: 'stop' })).text(), /class="notice">tamam/);
      assert.deepEqual(mgr.calls.at(-1), ['control', 'lofi2', 'stop']);
      mgr.control = async () => ({ ok: false, error: '"x" adlı ek yayın bulunamadı' });
      assert.match(await (await post({ name: 'x', action: 'start' })).text(), /ek yayın bulunamadı/);
    },
  );
});

test('/config/new ve /config/instance: streamManager yoksa 404, GET 405, yetkisiz 401', () => withServer(
  { goLiveService: fakeService(), configApi: apiWithCovers() },
  async ({ call }) => {
    assert.equal((await call('/config/new', { method: 'POST' })).status, 404);
    assert.equal((await call('/config/instance', { method: 'POST' })).status, 404);
  },
));

test('/config/new ve /config/instance: GET 405, yetkisiz 401', () => withServer(
  { goLiveService: fakeService(), configApi: apiWithCovers(), streamManager: fakeManager() },
  async ({ call }) => {
    assert.equal((await call('/config/new')).status, 405);
    assert.equal((await call('/config/instance')).status, 405);
    assert.equal((await call('/config/new', { method: 'POST', token: null })).status, 401);
    assert.equal((await call('/config/instance', { method: 'POST', token: null })).status, 401);
  },
));

test('/config/new çok dar hız sınırında: 3 istekten sonra 429', () => withServer(
  { goLiveService: fakeService(), configApi: apiWithCovers(), streamManager: fakeManager(), now: () => 1000 },
  async ({ base }) => {
    const codes = [];
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${base}/config/new?token=${TOKEN}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=a',
      });
      codes.push(res.status);
    }
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  },
));
