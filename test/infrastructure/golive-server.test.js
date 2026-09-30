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
    goLive: async () => {
      calls.push(['goLive']);
      if (goLiveError) throw goLiveError;
      return goLiveResult ?? { action: 'went-live', broadcastId: 'bid-1' };
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

test('POST /go-live: geçerli token ile 200 ve sonuç', () => withServer(
  { goLiveService: fakeService({ goLiveResult: { action: 'went-live', broadcastId: 'bid-9' } }) },
  async ({ call }) => {
    const res = await call('/go-live', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, action: 'went-live', broadcastId: 'bid-9' });
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
    assert.equal(res.status, 200);
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
    assert.equal((await call('/go-live/', { method: 'POST' })).status, 200);
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
    for (let i = 0; i < 22; i++) codes.push((await call('/status')).status);
    assert.ok(codes.includes(429), 'bir noktada 429 dönmeli');
    assert.equal(codes[0], 200);
  },
));

test('varsayılan bind 127.0.0.1 (dışarıya açılmaz)', () => {
  const { log } = fakeLog();
  const server = new GoLiveServer({ goLiveService: fakeService(), authToken: TOKEN, log });
  assert.equal(server.host, '127.0.0.1');
  assert.equal(server.port, 8787);
});
