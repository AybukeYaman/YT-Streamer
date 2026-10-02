// WebhookAlerter testleri: gerçek ağ yok, sahte fetch.
const test = require('node:test');
const assert = require('node:assert/strict');

const { WebhookAlerter, createAlivePinger } = require('../../src/infrastructure/webhook-alerter');

const URL_NTFY = 'https://ntfy.sh/yt-gizli-konu-123';

function fakeLog() {
  const lines = [];
  const rec = (level) => (m) => lines.push({ level, m });
  return { lines, log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') } };
}

function fakeFetch(responses = [{ ok: true, status: 200 }]) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      const r = queue.length > 1 ? queue.shift() : queue[0];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

test('url olmadan kurulamaz (sessizce bildirim yutan alerter olmasın)', () => {
  const { log } = fakeLog();
  assert.throws(() => new WebhookAlerter({ url: '', log }), /url olmadan/);
});

test('ntfy POST: başlık, öncelik ve etiket gönderilir', async () => {
  const { calls, fetchFn } = fakeFetch();
  const { log } = fakeLog();
  const alerter = new WebhookAlerter({ url: URL_NTFY, label: 'main', log, fetchFn });

  await alerter.alert({ level: 'error', title: 'YAYIN SORUNU: encoder', message: 'ENCODER DURMUŞ: 120 dk' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL_NTFY);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Priority, 'high');
  assert.equal(calls[0].options.headers.Tags, 'rotating_light');
  assert.match(calls[0].options.body, /\[main\] ENCODER DURMUŞ/);
});

// HTTP başlıkları ASCII dışı karakter taşıyamaz: başlık sadeleştirilir, gövde korunur.
test('başlıktaki Türkçe harfler ASCII’ye çevrilir, gövde olduğu gibi kalır', async () => {
  const { calls, fetchFn } = fakeFetch();
  const { log } = fakeLog();
  const alerter = new WebhookAlerter({ url: URL_NTFY, log, fetchFn });

  await alerter.alert({ level: 'info', title: 'düzeldi: çalışıyor', message: 'ingest tekrar sağlıklı' });

  assert.equal(calls[0].options.headers.Title, 'duzeldi: calisiyor');
  assert.match(calls[0].options.body, /sağlıklı/);
  assert.equal(calls[0].options.headers.Priority, 'default');
});

test('instance etiketi verilmezse öneksiz gönderilir', async () => {
  const { calls, fetchFn } = fakeFetch();
  const { log } = fakeLog();
  await new WebhookAlerter({ url: URL_NTFY, log, fetchFn }).alert({ title: 't', message: 'm' });
  assert.equal(calls[0].options.body, 'm');
});

// Bildirim kanalı bozuksa ASLA fırlatmaz: izleme sürmeli.
test('HTTP hatası yutulur, yalnızca uyarı loglanır', async () => {
  const { fetchFn } = fakeFetch([{ ok: false, status: 500 }]);
  const { log, lines } = fakeLog();
  await new WebhookAlerter({ url: URL_NTFY, log, fetchFn }).alert({ title: 't', message: 'm' });
  assert.ok(lines.some((l) => l.level === 'warn' && /HTTP 500/.test(l.m)));
});

test('ağ hatası yutulur', async () => {
  const { fetchFn } = fakeFetch([new Error('ECONNREFUSED')]);
  const { log, lines } = fakeLog();
  await new WebhookAlerter({ url: URL_NTFY, log, fetchFn }).alert({ title: 't', message: 'm' });
  assert.ok(lines.some((l) => l.level === 'warn' && /ECONNREFUSED/.test(l.m)));
});

// ntfy konu adı bir sırdır: loglara yalnızca host düşer.
test('loglarda konu adı geçmez, yalnızca host', async () => {
  const { fetchFn } = fakeFetch();
  const { log, lines } = fakeLog();
  await new WebhookAlerter({ url: URL_NTFY, log, fetchFn }).alert({ title: 't', message: 'm' });
  const all = lines.map((l) => l.m).join('\n');
  assert.ok(all.includes('ntfy.sh'));
  assert.ok(!all.includes('yt-gizli-konu-123'), 'konu adı loglanmamalı');
});

// ── Ölü adam anahtarı ───────────────────────────────────────────────────────
test('createAlivePinger: url yoksa null döner (ping atlanır)', () => {
  const { log } = fakeLog();
  assert.equal(createAlivePinger({ url: undefined, log }), null);
});

test('createAlivePinger: GET atar', async () => {
  const { calls, fetchFn } = fakeFetch();
  const { log } = fakeLog();
  const ping = createAlivePinger({ url: 'https://hc-ping.com/abc', log, fetchFn });
  await ping();
  assert.equal(calls[0].url, 'https://hc-ping.com/abc');
  assert.equal(calls[0].options.method, 'GET');
});

test('createAlivePinger: hata fırlatmaz (izleme turunu düşürmesin)', async () => {
  const { fetchFn } = fakeFetch([new Error('ağ yok')]);
  const { log, lines } = fakeLog();
  const ping = createAlivePinger({ url: 'https://hc-ping.com/abc', log, fetchFn });
  await ping(); // fırlatmamalı
  assert.ok(lines.some((l) => /ping/.test(l.m)));
});
