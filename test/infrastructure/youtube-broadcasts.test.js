// setThumbnail testleri: ağ yok (global fetch sahte), dosya sistemi gerçek (geçici dizin).
// Küçük resim yolu "dosya yoksa atla" davranışı üzerine kurulu; bunu fs'i sahteleyerek
// değil gerçek dosyayla doğrulamak, ENOENT kodunun gerçekten yakalandığını gösterir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { setThumbnail } = require('../../src/infrastructure/youtube-broadcasts');

const BROADCAST_ID = 'bid-1';

function withFetch(responses, body) {
  const calls = [];
  const queue = [...responses];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = queue.shift();
    if (!next) throw new Error('beklenmeyen fetch çağrısı');
    return {
      ok: next.status === undefined ? true : next.status < 400,
      status: next.status ?? 200,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
    };
  };
  return Promise.resolve(body(calls)).finally(() => { global.fetch = original; });
}

// Her senaryo kendi geçici dizininde; dosya adı içerik tipini de belirliyor.
function withFile(name, content, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-thumb-test-'));
  const file = path.join(dir, name);
  if (content !== null) fs.writeFileSync(file, content);
  return Promise.resolve(body(file)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('dosya varsa upload uç noktasına videoId ve ham gövdeyle yüklenir', async () => {
  await withFile('thumbnail.jpg', Buffer.from('JPEGBYTES'), (file) => withFetch([{ body: { kind: 'youtube#thumbnailSetResponse' } }], async (calls) => {
    const result = await setThumbnail({ accessToken: 'at', broadcastId: BROADCAST_ID, filePath: file });

    assert.deepEqual(result, { skipped: false, filePath: file, bytes: 9 });
    assert.equal(calls.length, 1);
    const { url, options } = calls[0];
    // upload tabanı (API_BASE değil) ve uploadType=media zorunlu.
    assert.ok(url.startsWith('https://www.googleapis.com/upload/youtube/v3/thumbnails/set'), url);
    assert.match(url, /uploadType=media/);
    assert.match(url, new RegExp(`videoId=${BROADCAST_ID}`));
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer at');
    assert.equal(options.headers['Content-Type'], 'image/jpeg');
    // Gövde JSON'a sarılmadan ham baytlar olarak gider.
    assert.ok(Buffer.isBuffer(options.body));
    assert.equal(options.body.toString(), 'JPEGBYTES');
  }));
});

test('.png uzantısı image/png olarak gönderilir', async () => {
  await withFile('thumbnail.PNG', Buffer.from('PNG'), (file) => withFetch([{ body: {} }], async (calls) => {
    await setThumbnail({ accessToken: 'at', broadcastId: BROADCAST_ID, filePath: file });
    assert.equal(calls[0].options.headers['Content-Type'], 'image/png');
  }));
});

// Asıl beklenen durum: dosya repo'da yok, VPS'te elle konuyor. Yokluğu hata değil.
test('dosya yoksa ATMAZ, API\'ye hiç gitmez', async () => {
  await withFile('thumbnail.jpg', null, (file) => withFetch([], async (calls) => {
    const result = await setThumbnail({ accessToken: 'at', broadcastId: BROADCAST_ID, filePath: file });
    assert.deepEqual(result, { skipped: true, reason: 'not_found', filePath: file });
    assert.equal(calls.length, 0); // boşa kota harcanmadı
  }));
});

test('yol bir dizinse de atlanır', async () => {
  await withFile('thumbnail.jpg', null, (file) => withFetch([], async (calls) => {
    fs.mkdirSync(file);
    const result = await setThumbnail({ accessToken: 'at', broadcastId: BROADCAST_ID, filePath: file });
    assert.equal(result.skipped, true);
    assert.equal(calls.length, 0);
  }));
});

// Yarı kopyalanmış/truncate dosya: API zaten reddederdi, çağrıya hiç girmiyoruz.
test('dosya boşsa atlanır', async () => {
  await withFile('thumbnail.jpg', Buffer.alloc(0), (file) => withFetch([], async (calls) => {
    const result = await setThumbnail({ accessToken: 'at', broadcastId: BROADCAST_ID, filePath: file });
    assert.deepEqual(result, { skipped: true, reason: 'empty', filePath: file });
    assert.equal(calls.length, 0);
  }));
});

test('API hatası yukarı taşınır (reason dahil) — çağıran karar verir', async () => {
  await withFile('thumbnail.jpg', Buffer.from('x'), (file) => withFetch([{
    status: 403,
    body: { error: { message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } },
  }], async () => {
    await assert.rejects(
      () => setThumbnail({ accessToken: 'at', broadcastId: BROADCAST_ID, filePath: file }),
      /thumbnails\/set.*exceeded your quota.*reason=quotaExceeded/s,
    );
  }));
});
