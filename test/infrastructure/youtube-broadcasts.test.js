// setThumbnail testleri: ağ yok (global fetch sahte), dosya sistemi gerçek (geçici dizin).
// Küçük resim yolu "dosya yoksa atla" davranışı üzerine kurulu; bunu fs'i sahteleyerek
// değil gerçek dosyayla doğrulamak, ENOENT kodunun gerçekten yakalandığını gösterir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  setThumbnail, insertBroadcast, updateVideoPrivacy, listBroadcasts, updateVideoDetails,
} = require('../../src/infrastructure/youtube-broadcasts');

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

// ── insert gövdesi ──────────────────────────────────────────────────────────
// recordFromStart KASITEN YOK: bu kanal kaydı kapatmaya yetkili değil
// (API: "The user is not permitted to disable recording", disableRecordingNotAllowed).
// Gönderilirse insert 403 döner ve yayın HİÇ açılmaz. Sonda ile doğrulandı — KARARLAR.md.
test('insert gövdesi: monitorStream kapalı, otomatik başlat/durdur kapalı, recordFromStart GÖNDERİLMEZ', async () => {
  await withFetch([{ body: { id: 'bid-1' } }], async (calls) => {
    await insertBroadcast({
      accessToken: 'at', title: 'T', description: 'D',
      privacyStatus: 'public', latencyPreference: 'normal',
      scheduledStartTime: '2026-10-02T00:00:00.000Z',
    });
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.status.privacyStatus, 'public');
    assert.equal(body.status.selfDeclaredMadeForKids, false);
    assert.deepEqual(body.contentDetails.monitorStream, { enableMonitorStream: false });
    assert.equal(body.contentDetails.enableAutoStart, false);
    assert.equal(body.contentDetails.enableAutoStop, false);
    // 403 sebebi: bu iki alan gövdeye GİRMEMELİ.
    assert.ok(!('recordFromStart' in body.contentDetails));
    assert.ok(!('enableDvr' in body.contentDetails));
  });
});

// ── updateVideoPrivacy ──────────────────────────────────────────────────────
const statusResponse = (status) => ({ body: { items: [{ id: 'v1', status }] } });

test('gizlilik çevirme: mevcut status okunur, kardeş alanlar KORUNARAK geri yazılır', async () => {
  await withFetch([
    statusResponse({ privacyStatus: 'public', selfDeclaredMadeForKids: false, license: 'youtube', embeddable: true }),
    { body: {} },
  ], async (calls) => {
    const result = await updateVideoPrivacy({ accessToken: 'at', videoId: 'v1', privacyStatus: 'unlisted' });

    assert.deepEqual(result, { skipped: false, previous: 'public', privacyStatus: 'unlisted' });
    // 1. çağrı okuma, 2. çağrı yazma.
    assert.equal(calls[0].options.method ?? 'GET', 'GET');
    assert.equal(calls[1].options.method, 'PUT');
    const body = JSON.parse(calls[1].options.body);
    assert.equal(body.status.privacyStatus, 'unlisted');
    // Kritik: videos.update gönderilen part'ı BÜTÜN olarak değiştiriyor — bu alanlar
    // gövdede olmasa varsayılana dönerdi.
    assert.equal(body.status.selfDeclaredMadeForKids, false);
    assert.equal(body.status.license, 'youtube');
    assert.equal(body.status.embeddable, true);
  });
});

test('gizlilik zaten istenen değerdeyse yazma çağrısı YAPILMAZ (idempotans + kota)', async () => {
  await withFetch([statusResponse({ privacyStatus: 'unlisted' })], async (calls) => {
    const result = await updateVideoPrivacy({ accessToken: 'at', videoId: 'v1', privacyStatus: 'unlisted' });
    assert.equal(result.skipped, true);
    assert.equal(calls.length, 1); // yalnızca okuma
  });
});

test('video yoksa (elle silinmiş) ATMAZ, skipped döner — kuyrukta sonsuza takılmasın', async () => {
  await withFetch([{ body: { items: [] } }], async (calls) => {
    const result = await updateVideoPrivacy({ accessToken: 'at', videoId: 'yok', privacyStatus: 'unlisted' });
    assert.equal(result.skipped, true);
    assert.match(result.reason, /bulunamadı/);
    assert.equal(calls.length, 1);
  });
});

// ── listBroadcasts / updateVideoDetails ─────────────────────────────────────

test('listBroadcasts: broadcastStatus=all ile çağrılır, items döner (1 kota)', async () => {
  await withFetch([{ body: { items: [{ id: 'a' }, { id: 'b' }] } }], async (calls) => {
    const items = await listBroadcasts({ accessToken: 'at' });
    assert.deepEqual(items.map((i) => i.id), ['a', 'b']);
    assert.match(calls[0].url, /liveBroadcasts\?/);
    assert.match(calls[0].url, /broadcastStatus=all/);
    assert.match(calls[0].url, /part=id%2Csnippet%2Cstatus|part=id,snippet,status/);
  });
});

test('listBroadcasts: items yoksa boş dizi', async () => {
  await withFetch([{ body: {} }], async () => {
    assert.deepEqual(await listBroadcasts({ accessToken: 'at' }), []);
  });
});

test('başlık/açıklama: mevcut snippet okunur, YAZILABİLİR alanlar korunarak geri yazılır', async () => {
  await withFetch([
    {
      body: {
        items: [{
          id: 'v1',
          snippet: {
            title: 'Eski', description: 'eski açıklama', categoryId: '10', tags: ['lofi', 'study'],
            defaultLanguage: 'tr', publishedAt: '2026-01-01T00:00:00Z', channelId: 'UC1', thumbnails: { default: {} },
          },
        }],
      },
    },
    { body: {} },
  ], async (calls) => {
    const result = await updateVideoDetails({
      accessToken: 'at', videoId: 'v1', title: 'Yeni', description: 'yeni açıklama',
    });
    assert.deepEqual(result, { skipped: false, previousTitle: 'Eski' });
    assert.equal(calls[1].options.method, 'PUT');
    const body = JSON.parse(calls[1].options.body);
    assert.equal(body.id, 'v1');
    assert.equal(body.snippet.title, 'Yeni');
    assert.equal(body.snippet.description, 'yeni açıklama');
    // videos.update part'ı BÜTÜN olarak değiştirir: bunlar gövdede olmasa silinirdi.
    assert.equal(body.snippet.categoryId, '10');
    assert.deepEqual(body.snippet.tags, ['lofi', 'study']);
    assert.equal(body.snippet.defaultLanguage, 'tr');
    // Salt-okunur alanlar GÖNDERİLMEZ.
    assert.equal(body.snippet.publishedAt, undefined);
    assert.equal(body.snippet.channelId, undefined);
    assert.equal(body.snippet.thumbnails, undefined);
  });
});

test('başlık/açıklama: video yoksa ATMAZ, skipped döner ve yazma çağrısı yapılmaz', async () => {
  await withFetch([{ body: { items: [] } }], async (calls) => {
    const result = await updateVideoDetails({
      accessToken: 'at', videoId: 'yok', title: 'x', description: 'y',
    });
    assert.equal(result.skipped, true);
    assert.equal(calls.length, 1);
  });
});

// ── createLiveStream ────────────────────────────────────────────────────────

test('createLiveStream: yeniden kullanılabilir rtmp stream ister, id ve anahtarı döndürür', async () => {
  const { createLiveStream } = require('../../src/infrastructure/youtube-broadcasts');
  await withFetch([{ body: { id: 'strm-9', cdn: { ingestionInfo: { streamName: 'k1k1-k2k2-k3k3-k4k4' } } } }], async (calls) => {
    const result = await createLiveStream({ accessToken: 'at', title: 'lofi2 — Gece' });
    assert.deepEqual(result, { id: 'strm-9', streamKey: 'k1k1-k2k2-k3k3-k4k4' });
    assert.equal(calls[0].options.method, 'POST');
    assert.match(calls[0].url, /liveStreams\?/);
    assert.match(calls[0].url, /part=id%2Csnippet%2Ccdn%2CcontentDetails|part=id,snippet,cdn,contentDetails/);
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.snippet.title, 'lofi2 — Gece');
    assert.equal(body.cdn.ingestionType, 'rtmp');
    assert.equal(body.contentDetails.isReusable, true);
  });
});

test('createLiveStream: yanıtta anahtar yoksa hata fırlatır, anahtar mesaja SIZMAZ', async () => {
  const { createLiveStream } = require('../../src/infrastructure/youtube-broadcasts');
  await withFetch([{ body: { id: 'strm-9', cdn: {} } }], async () => {
    await assert.rejects(createLiveStream({ accessToken: 'at', title: 'x' }), /anahtar döndürmedi/);
  });
});
