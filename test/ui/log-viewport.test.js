const test = require('node:test');
const assert = require('node:assert/strict');

const { LogViewport } = require('../../src/ui/log-viewport');

test('başlangıçta LIVE: en yeni satırlar görünür (dibe sabit)', () => {
  const vp = new LogViewport({ height: 10 });
  const v = vp.view(100);
  assert.equal(v.live, true);
  assert.equal(v.start, 90); // 100 - 10
  assert.equal(v.end, 100);
  assert.equal(v.atBottom, true);
});

test('LIVE iken toplam artınca görünüm dibi takip eder (auto-follow)', () => {
  const vp = new LogViewport({ height: 10 });
  assert.equal(vp.view(50).start, 40);
  assert.equal(vp.view(80).start, 70); // yeni loglar → takip
});

test('yukarı scroll LIVE\'ı kapatır ve konumu sabitler', () => {
  const vp = new LogViewport({ height: 10 });
  vp.lineUp(100); // LIVE'dan çık: top = 90 → 89
  assert.equal(vp.isLive, false);
  assert.equal(vp.view(100).start, 89);
});

test('geçmişe bakarken yeni loglar gelince görünüm zıplamaz', () => {
  const vp = new LogViewport({ height: 10 });
  vp.pageUp(100); // top = 90 - 10 = 80
  assert.equal(vp.view(100).start, 80);
  // 50 yeni log eklendi (total 150) — kullanıcı hâlâ aynı satırlarda
  assert.equal(vp.view(150).start, 80);
  assert.equal(vp.view(150).live, false);
});

test('en alta inince LIVE tekrar açılır (lineDown)', () => {
  const vp = new LogViewport({ height: 10 });
  vp.pageUp(100); // top 80
  for (let i = 0; i < 20; i++) vp.lineDown(100); // dibe kadar
  assert.equal(vp.isLive, true);
  assert.equal(vp.view(100).start, 90);
});

test('pageDown dibe ulaşınca LIVE açılır', () => {
  const vp = new LogViewport({ height: 10 });
  vp.pageUp(100); // 80
  vp.pageDown(100); // 90 → dip → LIVE
  assert.equal(vp.isLive, true);
});

test('End (toLive) LIVE moduna döndürür', () => {
  const vp = new LogViewport({ height: 10 });
  vp.pageUp(100);
  assert.equal(vp.isLive, false);
  vp.toLive();
  assert.equal(vp.isLive, true);
  assert.equal(vp.view(100).start, 90);
});

test('setHeight (resize) görünümü yeniden hesaplar', () => {
  const vp = new LogViewport({ height: 10 });
  assert.equal(vp.view(100).start, 90);
  vp.setHeight(20);
  assert.equal(vp.view(100).start, 80);
});

test('toplam yükseklikten küçükse start 0 ve atBottom', () => {
  const vp = new LogViewport({ height: 10 });
  const v = vp.view(5);
  assert.equal(v.start, 0);
  assert.equal(v.end, 5);
  assert.equal(v.atTop, true);
  assert.equal(v.atBottom, true);
});

test('yukarı scroll üst sınırda 0\'da durur (atTop)', () => {
  const vp = new LogViewport({ height: 10 });
  for (let i = 0; i < 200; i++) vp.lineUp(100);
  const v = vp.view(100);
  assert.equal(v.start, 0);
  assert.equal(v.atTop, true);
  assert.equal(v.live, false);
});
