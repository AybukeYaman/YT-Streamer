// liveBroadcasts + liveStreams uç noktaları. Yalnızca HTTP çağrısı ve alan seçimi;
// karar mantığı (idempotans, sıra, yoklama) GoLiveService'te.
const fs = require('fs');
const path = require('path');

const { apiRequest, uploadMedia, listLiveStreams } = require('./youtube-oauth');

const THUMBNAIL_CONTENT_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

// insert ile oluşturulan broadcast'te monitorStream KAPALI:
// açıkken transition önce 'testing', sonra 'live' gerektiriyor — iki adım, iki hata
// yüzeyi. Kapalıyken tek transition('live') yeterli. Studio önizlemesini kaybediyoruz,
// 7/24 müzik yayını için gereksiz. Ayrıntı: KARARLAR.md
async function insertBroadcast({
  accessToken, title, description, privacyStatus, latencyPreference, scheduledStartTime,
}) {
  return apiRequest({
    accessToken,
    method: 'POST',
    path: 'liveBroadcasts',
    params: { part: 'id,snippet,status,contentDetails' },
    body: {
      snippet: {
        title,
        description,
        // scheduledStartTime insert için ZORUNLU (API reddediyor).
        scheduledStartTime,
      },
      status: {
        privacyStatus,
        // selfDeclaredMadeForKids da zorunlu; verilmezse insert hata veriyor.
        selfDeclaredMadeForKids: false,
      },
      contentDetails: {
        monitorStream: { enableMonitorStream: false },
        enableAutoStart: false,
        enableAutoStop: false,
        latencyPreference,
      },
    },
  });
}

// Broadcast'e sabit bir küçük resim yükler (thumbnails.set; videoId = broadcastId).
//
// Dosya yoksa ATMAZ, { skipped: true } döner: küçük resim kritik değil ve dosya VPS'te
// elle konuyor (repo'ya girmiyor) — yokluğu normal bir durum, hata değil. "Var mı?"
// kontrolü burada, çünkü GoLiveService fs bilmiyor (katman ayrımı) ve çağrı öncesi
// kontrol, boşa bir API çağrısı + kota harcamasını da önlüyor.
async function setThumbnail({ accessToken, broadcastId, filePath }) {
  let body;
  try {
    body = fs.readFileSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return { skipped: true, reason: 'not_found', filePath };
    throw err;
  }
  // Boş dosya (yarı kopyalanmış/truncate edilmiş): API zaten reddeder, çağrıya girmeyelim.
  if (body.length === 0) return { skipped: true, reason: 'empty', filePath };

  await uploadMedia({
    accessToken,
    path: 'thumbnails/set',
    params: { videoId: broadcastId },
    body,
    contentType: THUMBNAIL_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'image/jpeg',
  });
  return { skipped: false, filePath, bytes: body.length };
}

// Kalıcı stream'e bağlar. streamId boş verilirse bağ KOPARILIR (bu kodda kullanılmıyor).
function bindBroadcast({ accessToken, broadcastId, streamId }) {
  return apiRequest({
    accessToken,
    method: 'POST',
    path: 'liveBroadcasts/bind',
    params: { part: 'id,status,contentDetails', id: broadcastId, streamId },
  });
}

function transitionBroadcast({ accessToken, broadcastId, status = 'live' }) {
  return apiRequest({
    accessToken,
    method: 'POST',
    path: 'liveBroadcasts/transition',
    params: { part: 'id,status', id: broadcastId, broadcastStatus: status },
  });
}

async function getBroadcast({ accessToken, broadcastId }) {
  const data = await apiRequest({
    accessToken,
    path: 'liveBroadcasts',
    params: { part: 'id,snippet,status,contentDetails', id: broadcastId },
  });
  return data.items?.[0] ?? null;
}

// Yayının kullandığı stream key'in stream id'si. Başlıktan ("Default stream key")
// tahmin edilmez: başlık dile/kanala göre değişir, key kesin eşleşmedir.
async function findStreamIdByKey({ accessToken, streamKey }) {
  const data = await listLiveStreams({ accessToken });
  const match = (data.items ?? []).find((s) => s.cdn?.ingestionInfo?.streamName === streamKey);
  return match ? match.id : null;
}

// ingest durumu: 'active' olmadan transition('live') hata verir.
async function getStreamStatus({ accessToken, streamId }) {
  const data = await apiRequest({
    accessToken,
    path: 'liveStreams',
    params: { part: 'id,status', id: streamId },
  });
  const item = data.items?.[0];
  return {
    streamStatus: item?.status?.streamStatus ?? null,
    healthStatus: item?.status?.healthStatus?.status ?? null,
  };
}

// Bitmiş bir yayının VOD'unun gizliliğini değiştirir (broadcast = video, aynı id).
//
// NEDEN ÖNCE OKUYOR: videos.update, part'ta GÖNDERİLEN bölümü bir BÜTÜN olarak
// değiştiriyor — status gönderip içine yalnızca privacyStatus koyarsan
// selfDeclaredMadeForKids, license, embeddable gibi kardeş alanlar varsayılana döner.
// Bu yüzden mevcut status okunur, üzerine privacyStatus yazılır, hepsi geri gönderilir.
// Maliyet 1 ek birim (videos.list) — bir alanı sessizce sıfırlamanın bedelinden ucuz.
//
// Video yoksa (elle silinmiş) { skipped: true } döner, ATMAZ: silinmiş bir video için
// bekleyen iş sonsuza kadar tekrar denenmemeli, kuyruktan düşmesi gerekiyor.
// Gizlilik zaten istenen değerdeyse de çağrı yapılmaz (idempotans + kota).
async function updateVideoPrivacy({ accessToken, videoId, privacyStatus }) {
  const current = await apiRequest({
    accessToken,
    path: 'videos',
    params: { part: 'status', id: videoId },
  });
  const status = current.items?.[0]?.status;
  if (!status) return { skipped: true, reason: 'video bulunamadı' };
  if (status.privacyStatus === privacyStatus) {
    return { skipped: true, reason: `gizlilik zaten "${privacyStatus}"`, privacyStatus };
  }
  const previous = status.privacyStatus ?? null;
  await apiRequest({
    accessToken,
    method: 'PUT',
    path: 'videos',
    params: { part: 'status' },
    body: { id: videoId, status: { ...status, privacyStatus } },
  });
  return { skipped: false, previous, privacyStatus };
}

module.exports = {
  insertBroadcast, bindBroadcast, transitionBroadcast, getBroadcast, setThumbnail,
  findStreamIdByKey, getStreamStatus, updateVideoPrivacy,
};
