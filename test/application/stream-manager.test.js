const test = require('node:test');
const assert = require('node:assert/strict');

const { StreamManager } = require('../../src/application/stream-manager');

function setup({ endBroadcast } = {}) {
  const calls = [];
  const instances = {
    names: () => ['lofi3'],
    start: (n) => calls.push(['start', n]),
    stop: (n) => calls.push(['stop', n]),
  };
  const manager = new StreamManager({
    provisioner: {}, instances, catalog: {}, goLive: async () => ({}), endBroadcast, log: { warn: () => {} },
  });
  return { manager, calls };
}

test('stop: ek yayın durur ve YouTube yayını bitirilir', async () => {
  const { manager, calls } = setup({ endBroadcast: async (n) => { calls.push(['end', n]); return { ended: true }; } });
  const res = await manager.control('lofi3', 'stop');
  assert.equal(res.ok, true);
  assert.match(res.message, /durduruldu\. YouTube yayını da bitirildi/);
  assert.deepEqual(calls, [['stop', 'lofi3'], ['end', 'lofi3']]);
});

test('stop: bitirme hatası durdurmayı bozmaz, nota yazılır', async () => {
  const { manager } = setup({ endBroadcast: async () => { throw new Error('quota'); } });
  const res = await manager.control('lofi3', 'stop');
  assert.equal(res.ok, true);
  assert.match(res.message, /bitirilemedi \(quota\)/);
});

test('stop: endBroadcast verilmemişse eski davranış', async () => {
  const { manager } = setup();
  const res = await manager.control('lofi3', 'stop');
  assert.equal(res.message, '"lofi3" durduruldu.');
});

test('stop: yayın canlı değilse neden yazılır', async () => {
  const { manager } = setup({ endBroadcast: async () => ({ ended: false, reason: 'kayıtlı yayın yok' }) });
  const res = await manager.control('lofi3', 'stop');
  assert.match(res.message, /bitirilmedi: kayıtlı yayın yok/);
});

test('golive: "busy" başarısızlık sayılmaz', async () => {
  const instances = { names: () => ['lofi3'], start() {}, stop() {} };
  const busy = Object.assign(new Error('go-live şu an sürüyor'), { code: 'busy' });
  const manager = new StreamManager({
    provisioner: {}, instances, catalog: {}, goLive: async () => { throw busy; }, log: { warn: () => {} },
  });
  const res = await manager.control('lofi3', 'golive');
  assert.equal(res.ok, true);
  assert.match(res.message, /zaten sürüyor/);
});

test('golive: başka hata hâlâ başarısız', async () => {
  const instances = { names: () => ['lofi3'], start() {}, stop() {} };
  const manager = new StreamManager({
    provisioner: {}, instances, catalog: {}, goLive: async () => { throw new Error('x'); }, log: { warn: () => {} },
  });
  assert.equal((await manager.control('lofi3', 'golive')).ok, false);
});
