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
