const test = require('node:test');
const assert = require('node:assert/strict');

const { PlanOnlyControlService } = require('../../src/application/plan-only-control-service');

function makeLog() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
  };
}

test('getStatus: panoyu bozmayan "durmuş" görünümü döner', () => {
  const svc = new PlanOnlyControlService({ log: makeLog() });
  assert.deepEqual(svc.getStatus(), {
    state: 'stopped', uptime: 0, fps: null, bitrateKbps: null, speed: null, runNumber: 0,
  });
});

test('getCurrentTrack null, getUpcomingQueue boş dizi', () => {
  const svc = new PlanOnlyControlService({ log: makeLog() });
  assert.equal(svc.getCurrentTrack(), null);
  assert.deepEqual(svc.getUpcomingQueue(), []);
});

test('start/stop hata fırlatmaz, bilgilendirici log yazar', async () => {
  const log = makeLog();
  const svc = new PlanOnlyControlService({ log });
  await svc.start();
  await svc.stop();
  assert.equal(log.lines.info.length, 2);
});

test('restart: runRestart yoksa elle restart talimatı loglanır, hata atılmaz', async () => {
  const log = makeLog();
  const svc = new PlanOnlyControlService({ log });
  await assert.doesNotReject(() => svc.restart());
  assert.match(log.lines.info[0], /systemctl restart yt-streamer/);
});

test('restart: runRestart başarılı sonuç döndürürse info loglanır', async () => {
  const log = makeLog();
  const svc = new PlanOnlyControlService({
    log,
    runRestart: async () => ({ ok: true, message: 'yeniden başlatıldı' }),
  });
  await svc.restart();
  assert.deepEqual(log.lines.info, ['yeniden başlatıldı']);
});

test('restart: runRestart başarısız sonuç döndürürse warn loglanır, hata atılmaz', async () => {
  const log = makeLog();
  const svc = new PlanOnlyControlService({
    log,
    runRestart: async () => ({ ok: false, message: 'systemctl bulunamadı' }),
  });
  await assert.doesNotReject(() => svc.restart());
  assert.deepEqual(log.lines.warn, ['systemctl bulunamadı']);
});

test('restart: runRestart hata fırlatırsa yakalanır, dışarı sızmaz', async () => {
  const log = makeLog();
  const svc = new PlanOnlyControlService({
    log,
    runRestart: async () => { throw new Error('ECONNREFUSED'); },
  });
  await assert.doesNotReject(() => svc.restart());
  assert.match(log.lines.warn[0], /ECONNREFUSED/);
});
