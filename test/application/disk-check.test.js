const test = require('node:test');
const assert = require('node:assert/strict');
const { DiskCheck } = require('../../src/application/checks/disk-check');

const GB = 1024 ** 3;
// bsize 4096 ile istenen GB'ı veren sahte statfs
const fakeStatfs = ({ freeGb, totalGb }) => async () => ({
  bsize: 4096,
  blocks: (totalGb * GB) / 4096,
  bavail: (freeGb * GB) / 4096,
  bfree: (freeGb * GB) / 4096,
});

test('eşiğin üstünde sağlıklı, boş alanı raporlar', async () => {
  const check = new DiskCheck({ path: '/runtime', minFreeGb: 2, statfs: fakeStatfs({ freeGb: 10, totalGb: 40 }) });
  const result = await check.run();
  assert.equal(check.name, 'disk');
  assert.equal(result.status, 'healthy');
  assert.equal(result.detail.freeGb, 10);
  assert.equal(result.detail.percentFree, 25);
  assert.match(result.message, /10 GB boş/);
});

test('eşiğin altında sağlıksız, düzeltme talimatı verir', async () => {
  const check = new DiskCheck({ path: '/runtime', minFreeGb: 2, statfs: fakeStatfs({ freeGb: 1, totalGb: 40 }) });
  const result = await check.run();
  assert.equal(result.status, 'unhealthy');
  assert.match(result.message, /DİSK DOLUYOR/);
  assert.match(result.message, /eşik 2 GB/);
  assert.equal(result.detail.freeGb, 1);
});

test('tam eşikte sağlıklı (sınır dahil)', async () => {
  const check = new DiskCheck({ path: '/runtime', minFreeGb: 2, statfs: fakeStatfs({ freeGb: 2, totalGb: 40 }) });
  assert.equal((await check.run()).status, 'healthy');
});

test('ölçülemezse atlanır — alarm üretmez', async () => {
  const check = new DiskCheck({
    path: '/yok',
    statfs: async () => { throw new Error('ENOENT'); },
  });
  const result = await check.run();
  assert.equal(result.status, 'skipped');
  assert.match(result.message, /okunamadı/);
});

test('geçersiz kurulum hemen yakalanır', () => {
  assert.throws(() => new DiskCheck({ path: '' }), /path gerekli/);
  assert.throws(() => new DiskCheck({ path: '/x', minFreeGb: 0 }), /minFreeGb/);
});

test('gerçek dosya sistemiyle çalışır (statfs enjekte edilmeden)', async () => {
  const result = await new DiskCheck({ path: process.cwd(), minFreeGb: 0.001 }).run();
  assert.equal(result.status, 'healthy');
  assert.ok(result.detail.totalGb > 0, 'toplam boyut okunmalı');
});
