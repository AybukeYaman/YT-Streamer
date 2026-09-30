// liveBroadcasts + liveStreams uç noktaları. Yalnızca HTTP çağrısı ve alan seçimi;
// karar mantığı (idempotans, sıra, yoklama) GoLiveService'te.
const { apiRequest, listLiveStreams } = require('./youtube-oauth');

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

module.exports = {
  insertBroadcast, bindBroadcast, transitionBroadcast, getBroadcast,
  findStreamIdByKey, getStreamStatus,
};
