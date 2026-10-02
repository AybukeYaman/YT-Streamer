// Kontrol testleri: ağ yok, fs yok. Sahte goLiveService / sahte mtime okuyucu.
const test = require('node:test');
const assert = require('node:assert/strict');

const { IngestCheck } = require('../../src/application/checks/ingest-check');
const { EncoderHeartbeatCheck } = require('../../src/application/checks/encoder-heartbeat-check');

// ── IngestCheck ─────────────────────────────────────────────────────────────
test('IngestCheck: sağlıklı ingest', async () => {
  const check = new IngestCheck({
    goLiveService: {
      checkIngestHealth: async () => ({
        skipped: false, healthy: true, broadcastId: 'b',
        ingest: { streamStatus: 'active', healthStatus: 'good' },
      }),
    },
  });
  const r = await check.run();
  assert.equal(check.name, 'ingest');
  assert.equal(r.status, 'healthy');
  assert.match(r.message, /active\/good/);
});

test('IngestCheck: broadcast canlı ama veri yok → unhealthy + ne yapılacağı yazılı', async () => {
  const check = new IngestCheck({
    goLiveService: {
      checkIngestHealth: async () => ({
        skipped: false, healthy: false, broadcastId: 'hSqzx1FiX_k',
        ingest: { streamStatus: 'inactive', healthStatus: 'noData' },
      }),
    },
  });
  const r = await check.run();
  assert.equal(r.status, 'unhealthy');
  assert.match(r.message, /YAYIN ÖLÜ/);
  assert.match(r.message, /hSqzx1FiX_k/);
  assert.match(r.message, /systemctl restart yt-streamer/);
  assert.deepEqual(r.detail, { streamStatus: 'inactive', healthStatus: 'noData' });
});

test('IngestCheck: kayıtlı yayın yoksa skipped (sağlıksızlık değil)', async () => {
  const check = new IngestCheck({
    goLiveService: { checkIngestHealth: async () => ({ skipped: true, reason: 'kayıtlı yayın yok' }) },
  });
  const r = await check.run();
  assert.equal(r.status, 'skipped');
  assert.match(r.message, /kayıtlı yayın yok/);
});

// ── EncoderHeartbeatCheck ───────────────────────────────────────────────────
// state.json mtime = canlı yayının nabzı (orchestrator her 5 sn yazıyor).
const NOW = 1_700_000_000_000;

function heartbeat({ mtime, maxAgeMs }) {
  return new EncoderHeartbeatCheck({
    statePath: '/srv/runtime/state.json',
    readMtimeMs: () => mtime,
    now: () => NOW,
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
  });
}

test('EncoderHeartbeatCheck: taze yazma → healthy', async () => {
  const check = heartbeat({ mtime: NOW - 7000 });
  const r = await check.run();
  assert.equal(check.name, 'encoder');
  assert.equal(r.status, 'healthy');
  assert.equal(r.detail.ageSeconds, 7);
});

test('EncoderHeartbeatCheck: eşiğin hemen altı hâlâ healthy (albüm geçişi payı)', async () => {
  const r = await heartbeat({ mtime: NOW - 119_000 }).run();
  assert.equal(r.status, 'healthy');
});

test('EncoderHeartbeatCheck: 2 saatlik sessizlik → unhealthy (1 Ekim olayı)', async () => {
  const r = await heartbeat({ mtime: NOW - 7_200_000 }).run();
  assert.equal(r.status, 'unhealthy');
  assert.match(r.message, /ENCODER DURMUŞ/);
  assert.match(r.message, /120 dk/);
  assert.match(r.message, /status\.sh/);
  assert.equal(r.detail.ageSeconds, 7200);
});

test('EncoderHeartbeatCheck: dosya yoksa skipped (yeni kurulum / bilerek kapalı)', async () => {
  const r = await heartbeat({ mtime: null }).run();
  assert.equal(r.status, 'skipped');
  assert.match(r.message, /hiç başlamamış/);
});

test('EncoderHeartbeatCheck: okuma hatası fırlatılır (izleyici sayacı artırmasın)', async () => {
  const check = new EncoderHeartbeatCheck({
    statePath: '/srv/runtime/state.json',
    readMtimeMs: () => { throw new Error('EACCES'); },
  });
  await assert.rejects(() => check.run(), /EACCES/);
});
