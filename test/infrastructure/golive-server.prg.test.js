// Post/Redirect/Get (Faz 4): POST /config* → 303 → GET /config?flash=…, tekrar gönderim engeli.
// Yönlendirme TAKİP EDİLMEZ (redirect: 'manual'); sonuç sayfası ayrıca GET ile okunur.
const test = require('node:test');
const assert = require('node:assert/strict');

const { GoLiveServer } = require('../../src/infrastructure/golive-server');
const { FlashStore } = require('../../src/infrastructure/flash-store');
const { ActionDedupe } = require('../../src/infrastructure/action-dedupe');

const TOKEN = 'u7qN2xKpR9sL4vB8mZ3cW6yD1aF5gH0jT2eQ4rU7iO9';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const N1 = 'a'.repeat(32);
const N2 = 'b'.repeat(32);

const log = { debug() {}, info() {}, warn() {}, error() {} };

function fakeApi({ saveGate = null } = {}) {
  const calls = { save: [], control: [], upload: [] };
  return {
    calls,
    form: async () => ({
      plan: { name: 'adsız', pomodoro: { enabled: false, type: '50+10', studyVideos: [], breakVideos: [] } },
      clips: [],
      covers: ['/c/a.jpg', '/c/galeri-1.jpg'],
    }),
    save: async (fields) => {
      calls.save.push(fields);
      if (saveGate) await saveGate;
      return { ok: true, plan: {}, warnings: [], restarted: Boolean(fields.restart), restartError: null };
    },
    control: async (action) => { calls.control.push(action); return { ok: true, message: `yayın ${action}` }; },
    uploadCover: async (buf) => { calls.upload.push(buf.length); return { ok: true, path: '/c/galeri-1.jpg' }; },
  };
}

function fakeManager({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    list: () => [{ name: 'lofi2', state: 'running' }],
    albums: () => [{ name: 'mimi', trackCount: 2, backgrounds: [] }],
    create: async (input) => { calls.push(['create', input]); return fail ? { ok: false, error: 'kapasite dolu' } : { ok: true, message: 'kuruldu' }; },
    control: async (name, action) => { calls.push(['control', name, action]); return { ok: true, message: `${name} ${action}` }; },
  };
}

const admin = {
  list: async () => [{ id: 'b1', title: 'Y', description: '', privacyStatus: 'public', lifeCycleStatus: 'live', finished: false }],
  get: async () => ({ id: 'b1', title: 'Y', description: '', privacyStatus: 'public' }),
  end: async () => {},
};

async function withServer(options, body) {
  const server = new GoLiveServer({
    authToken: TOKEN, log, port: 0, goLiveService: { getStatus: async () => ({ broadcastId: null }) }, ...options,
  });
  await server.listen();
  const base = `http://127.0.0.1:${server.boundPort}`;
  try {
    return await body({ base, server });
  } finally {
    await server.close();
  }
}

const post = (base, path, body = '', headers = FORM) => fetch(`${base}${path}`, {
  method: 'POST', headers, body, redirect: 'manual',
});
const flashOf = (res) => /[?&]flash=([0-9a-f]{32})/.exec(res.headers.get('location') ?? '')?.[1];

// ── birim: FlashStore / ActionDedupe ───────────────────────────────────────

test('FlashStore: put/get; get silmez; süre dolunca ve biçimsiz id → null; kapasite sınırı', () => {
  let t = 1000;
  const store = new FlashStore({ now: () => t, ttlMs: 100, max: 2 });
  const id = store.put({ notice: 'x' });
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.deepEqual(store.get(id), { notice: 'x' });
  assert.deepEqual(store.get(id), { notice: 'x' }, 'ikinci okuma da çalışır');
  assert.equal(store.get('../etc'), null);
  assert.equal(store.get(undefined), null);
  t += 101;
  assert.equal(store.get(id), null, 'süresi doldu');
  const a = store.put(1); const b = store.put(2); const c = store.put(3);
  assert.equal(store.get(a), null, 'kapasite aşımında en eskisi atılır');
  assert.equal(store.get(b), 2);
  assert.equal(store.get(c), 3);
});

test('ActionDedupe: new → inflight → done; release yeniden denemeye izin verir; n yoksa hep new', () => {
  let t = 0;
  const d = new ActionDedupe({ now: () => t, ttlMs: 1000 });
  assert.equal(d.begin(N1), 'new');
  assert.equal(d.begin(N1), 'inflight');
  d.finish(N1);
  assert.equal(d.begin(N1), 'done');
  assert.equal(d.begin(N2), 'new');
  d.release(N2);
  assert.equal(d.begin(N2), 'new');
  assert.equal(d.begin(null), 'new');
  assert.equal(d.begin('kısa'), 'new');
  assert.equal(d.begin('kısa'), 'new', 'biçimsiz n dedupe edilmez');
  t += 1001;
  assert.equal(d.begin(N1), 'new', 'bitmiş kayıt süre sonunda unutulur');
});

// ── sunucu: 303 sözleşmesi ─────────────────────────────────────────────────

test('POST /config (save): 303, göreli Location, token + broadcast korunur, flash\'ta mesaj', () => withServer(
  { configApi: fakeApi() },
  async ({ base }) => {
    const res = await post(base, `/config?token=${TOKEN}&broadcast=b1`, 'pomodoroType=50%2B10&action=save');
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), new RegExp(`^/config\\?token=${TOKEN}&broadcast=b1&flash=[0-9a-f]{32}$`));
    assert.equal(await res.text(), '');
    const page = await (await fetch(`${base}${res.headers.get('location')}`)).text();
    assert.match(page, /class="notice">Plan kaydedildi\./);
  },
));

test('hata da 303: mesaj role="alert" kutusunda GET ile görünür', () => withServer(
  { configApi: { ...fakeApi(), save: async () => ({ ok: false, error: 'geçersiz pomodoro türü' }) } },
  async ({ base }) => {
    const res = await post(base, `/config?token=${TOKEN}`, 'action=save');
    assert.equal(res.status, 303);
    const page = await (await fetch(`${base}${res.headers.get('location')}`)).text();
    assert.match(page, /class="error">geçersiz pomodoro türü/);
  },
));

test('start/stop: control çağrılır, 303', () => withServer(
  { configApi: fakeApi() },
  async ({ base, server }) => {
    const res = await post(base, `/config?token=${TOKEN}`, 'action=stop');
    assert.equal(res.status, 303);
    assert.ok(server.flash.get(flashOf(res)).notice.includes('stop'));
  },
));

test('GET: bilinmeyen/biçimsiz flash sessizce yok sayılır; mesajsız açılır', () => withServer(
  { configApi: fakeApi() },
  async ({ base }) => {
    for (const f of ['0'.repeat(32), 'kötü', '<script>']) {
      const res = await fetch(`${base}/config?token=${TOKEN}&flash=${encodeURIComponent(f)}`);
      assert.equal(res.status, 200);
      assert.doesNotMatch(await res.text(), /class="(notice|error)"/);
    }
  },
));

test('/config/broadcast: 303, seçim gövdedeki id ile korunur', () => withServer(
  { configApi: fakeApi(), broadcastAdmin: admin },
  async ({ base }) => {
    const res = await post(base, `/config/broadcast?token=${TOKEN}`, 'broadcastId=b1&action=end');
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /&broadcast=b1&flash=/);
  },
));

test('/config/new: başarıda 303 (new=1 yok); hatada 303 + new=1 + taslak korunur', async () => {
  await withServer(
    { configApi: fakeApi(), broadcastAdmin: admin, streamManager: fakeManager() },
    async ({ base }) => {
      const res = await post(base, `/config/new?token=${TOKEN}`, 'name=lofi2&title=Gece');
      assert.equal(res.status, 303);
      assert.doesNotMatch(res.headers.get('location'), /new=1/);
    },
  );
  await withServer(
    { configApi: fakeApi(), broadcastAdmin: admin, streamManager: fakeManager({ fail: true }) },
    async ({ base }) => {
      const res = await post(base, `/config/new?token=${TOKEN}&broadcast=b1`, 'name=lofi2&title=Gece+%3Cb%3E&albums=mimi');
      assert.equal(res.status, 303);
      assert.match(res.headers.get('location'), /&broadcast=b1&new=1&flash=/);
      const page = await (await fetch(`${base}${res.headers.get('location')}`)).text();
      assert.match(page, /class="error">kapasite dolu/);
      assert.match(page, /name="name" value="lofi2"/);
      assert.match(page, /name="title" value="Gece &lt;b&gt;"/);
      assert.match(page, /name="albums" value="mimi" checked/);
    },
  );
});

test('/config/instance: 303 ve seçili yayın (?broadcast) korunur', () => withServer(
  { configApi: fakeApi(), broadcastAdmin: admin, streamManager: fakeManager() },
  async ({ base }) => {
    const res = await post(base, `/config/instance?token=${TOKEN}&broadcast=b1`, 'name=lofi2&action=stop');
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /&broadcast=b1&flash=/);
  },
));

function multipart(data) {
  const boundary = '----t';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="coverFile"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
  return { body: Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`)]), type: `multipart/form-data; boundary=${boundary}` };
}

test('/config/upload: 303; yüklenen kapak (listedeyse) seçili gelir; listede olmayan flash yolu reddedilir', () => withServer(
  { configApi: fakeApi() },
  async ({ base, server }) => {
    const { body, type } = multipart(Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    const res = await post(base, `/config/upload?token=${TOKEN}`, body, { 'Content-Type': type });
    assert.equal(res.status, 303);
    const page = await (await fetch(`${base}${res.headers.get('location')}`)).text();
    assert.match(page, /Görsel eklendi/);
    assert.match(page, /name="cover" value="\/c\/galeri-1\.jpg" checked/);

    const evil = server.flash.put({ notice: 'x', pendingCover: '/etc/passwd' });
    const page2 = await (await fetch(`${base}/config?token=${TOKEN}&flash=${evil}`)).text();
    assert.doesNotMatch(page2, /\/etc\/passwd/);
  },
));

test('/config/upload: dosya çok büyükse 303 + Connection: close ve hata mesajı', () => withServer(
  { configApi: fakeApi() },
  async ({ base, server }) => {
    const big = Buffer.alloc(15 * 1024 * 1024 + 10, 1);
    const { body, type } = multipart(big);
    let res;
    try {
      res = await post(base, `/config/upload?token=${TOKEN}`, body, { 'Content-Type': type });
    } catch {
      // Gövde bitmeden bağlantı kapanırsa istemci yanıtı alamayabilir (mevcut 413 davranışıyla aynı); flash yine yazılmış olmalı.
      return;
    }
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('connection'), 'close');
    assert.match(server.flash.get(flashOf(res)).error, /dosya çok büyük/);
  },
));

test('yetkisiz 401 / yöntem 405 / 404 JSON kalır (yönlendirme yok)', () => withServer(
  { configApi: fakeApi() },
  async ({ base }) => {
    assert.equal((await post(base, '/config?token=yanlis', 'action=save')).status, 401);
    assert.equal((await fetch(`${base}/config/upload?token=${TOKEN}`, { redirect: 'manual' })).status, 405);
    assert.equal((await post(base, `/config/new?token=${TOKEN}`, 'x=1')).status, 404, 'streamManager yok');
  },
));

test('yalnızca Authorization başlığıyla yetkilenen istemci: Location\'da token yok', () => withServer(
  { configApi: fakeApi() },
  async ({ base }) => {
    const res = await post(base, '/config', 'action=save', { ...FORM, Authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /^\/config\?flash=[0-9a-f]{32}$/);
    assert.ok(!res.headers.get('location').includes(TOKEN));
  },
));

test('GOLIVE_CONFIG_PRG kapalıyken (configPrg: false) eski davranış: aynı istekte 200 HTML', () => withServer(
  { configApi: fakeApi(), configPrg: false },
  async ({ base }) => {
    const res = await post(base, `/config?token=${TOKEN}`, 'action=save');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /class="notice">Plan kaydedildi\./);
    const page = await (await fetch(`${base}/config?token=${TOKEN}`)).text();
    assert.doesNotMatch(page, /[?&]n=/, 'kapalıyken işlem kimliği üretilmez');
  },
));

// ── tekrar gönderim engeli ─────────────────────────────────────────────────

test('sayfa her form action\'ına işlem kimliği (n) ekler; her basımda farklı', () => withServer(
  { configApi: fakeApi(), broadcastAdmin: admin, streamManager: fakeManager() },
  async ({ base }) => {
    const get = async () => (await fetch(`${base}/config?token=${TOKEN}`)).text();
    const a = await get();
    const ns = [...a.matchAll(/action="(\/config[^"]*?)&amp;n=([0-9a-f]{32})"/g)].map((m) => [m[1], m[2]]);
    const routes = ns.map(([r]) => r.split('?')[0]);
    for (const r of ['/config', '/config/upload', '/config/broadcast', '/config/instance']) assert.ok(routes.includes(r), r);
    assert.equal(new Set(ns.map(([, n]) => n)).size, 1, 'bir sayfadaki tüm formlar aynı n');
    const b = await get();
    assert.notEqual(/&amp;n=([0-9a-f]{32})/.exec(a)[1], /&amp;n=([0-9a-f]{32})/.exec(b)[1]);
  },
));

test('aynı n ile ikinci kayıt+yeniden başlatma İŞLEMİ ÇALIŞTIRMAZ; bilgi mesajıyla 303', () => {
  const api = fakeApi();
  return withServer({ configApi: api }, async ({ base, server }) => {
    const url = `/config?token=${TOKEN}&n=${N1}`;
    const r1 = await post(base, url, 'action=save_restart');
    const r2 = await post(base, url, 'action=save_restart');
    assert.equal(r1.status, 303);
    assert.equal(r2.status, 303);
    assert.equal(api.calls.save.length, 1, 'restart tek kez');
    assert.match(server.flash.get(flashOf(r2)).notice, /zaten uygulandı/);
    // Yeni n → yeni işlem (yeni sayfadan meşru ikinci restart).
    await post(base, `/config?token=${TOKEN}&n=${N2}`, 'action=save_restart');
    assert.equal(api.calls.save.length, 2);
  });
});

test('n yoksa (eski sekme / Shortcuts) işlem eskisi gibi her seferinde çalışır', () => {
  const api = fakeApi();
  return withServer({ configApi: api }, async ({ base }) => {
    await post(base, `/config?token=${TOKEN}`, 'action=save');
    await post(base, `/config?token=${TOKEN}`, 'action=save');
    assert.equal(api.calls.save.length, 2);
  });
});

test('eşzamanlı çift gönderim: ikincisi "sürüyor" der, işlem tek kez', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const api = fakeApi({ saveGate: gate });
  await withServer({ configApi: api }, async ({ base, server }) => {
    const url = `/config?token=${TOKEN}&n=${N1}`;
    const first = post(base, url, 'action=save_restart');
    while (api.calls.save.length === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await post(base, url, 'action=save_restart');
    assert.equal(second.status, 303);
    assert.match(server.flash.get(flashOf(second)).notice, /zaten sürüyor/);
    release();
    assert.equal((await first).status, 303);
    assert.equal(api.calls.save.length, 1);
  });
});

test('yükleme tekrarı: gövde işlenmez, uploadCover bir kez', () => {
  const api = fakeApi();
  return withServer({ configApi: api }, async ({ base }) => {
    const { body, type } = multipart(Buffer.from([0xff, 0xd8, 0xff, 9]));
    const url = `/config/upload?token=${TOKEN}&n=${N1}`;
    assert.equal((await post(base, url, body, { 'Content-Type': type })).status, 303);
    assert.equal((await post(base, url, body, { 'Content-Type': type })).status, 303);
    assert.equal(api.calls.upload.length, 1);
  });
});

test('işlem beklenmedik hatayla düşerse (500) aynı n yeniden denenebilir', () => {
  let fail = true;
  const api = fakeApi();
  api.save = async (f) => { if (fail) throw new Error('disk'); api.calls.save.push(f); return { ok: true }; };
  return withServer({ configApi: api }, async ({ base }) => {
    const url = `/config?token=${TOKEN}&n=${N1}`;
    assert.equal((await post(base, url, 'action=save')).status, 500);
    fail = false;
    assert.equal((await post(base, url, 'action=save')).status, 303);
    assert.equal(api.calls.save.length, 1);
  });
});

test('yeni yayın tekrarı: create bir kez', async () => {
  const mgr = fakeManager();
  await withServer({ configApi: fakeApi(), broadcastAdmin: admin, streamManager: mgr }, async ({ base }) => {
    const url = `/config/new?token=${TOKEN}&n=${N1}`;
    await post(base, url, 'name=lofi2&title=Gece');
    await post(base, url, 'name=lofi2&title=Gece');
    assert.equal(mgr.calls.filter((c) => c[0] === 'create').length, 1);
  });
});
