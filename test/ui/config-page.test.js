const test = require('node:test');
const assert = require('node:assert/strict');

const { renderConfigPage, esc } = require('../../src/ui/config-page');
const { StreamPlan } = require('../../src/domain/stream-plan');

test('esc: HTML özel karakterleri kaçışlar', () => {
  assert.equal(esc(`a < b & "c" 'd'`), 'a &lt; b &amp; &quot;c&quot; &#39;d&#39;');
});

test('mobil viewport ve karakter kümesi doğru', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't' });
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
});

test('mevcut ayarlar formu doldurur: pomodoro açık, tür, seçili klipler', () => {
  const plan = new StreamPlan({
    name: 'Cozy',
    pomodoro: {
      enabled: true, type: '45+15',
      studyVideos: ['X:/clips/a.mp4'], breakVideos: ['X:/clips/b.mp4'],
    },
  });
  const html = renderConfigPage({ plan, clips: ['X:/clips/a.mp4', 'X:/clips/b.mp4'], token: 't' });
  assert.match(html, /name="pomodoroEnabled"[^>]*checked/);
  assert.match(html, /value="45\+15"/);
  assert.match(html, /name="studyVideos" value="X:\/clips\/a\.mp4" checked/);
  assert.match(html, /name="breakVideos" value="X:\/clips\/b\.mp4" checked/);
  // Seçili OLMAYAN klip işaretli olmamalı.
  assert.doesNotMatch(html, /name="studyVideos" value="X:\/clips\/b\.mp4" checked/);
});

test('token form action\'ına query olarak eklenir', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 'abc123' });
  assert.match(html, /action="\/config\?token=abc123"/);
});

test('dosya adındaki özel karakterler kaçışlanır (XSS kapatılır)', () => {
  const plan = new StreamPlan({});
  const evil = 'X:/clips/<script>alert(1)</script>.mp4';
  const html = renderConfigPage({ plan, clips: [evil], token: 't' });
  assert.ok(!html.includes('<script>alert(1)</script>.mp4'), 'kaçışsız script etiketi sayfada olmamalı');
  assert.match(html, /&lt;script&gt;/);
});

test('klip yoksa bilgilendirici mesaj gösterilir', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't' });
  assert.match(html, /Klip bulunamadı/);
});

test('notice ve error gösterilir', () => {
  const html1 = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', notice: 'kaydedildi' });
  assert.match(html1, /class="notice">kaydedildi/);
  const html2 = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', error: 'hata oldu' });
  assert.match(html2, /class="error">hata oldu/);
});

test('her klip satırında önizleme <img> var, token ile', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: ['X:/clips/a.mp4'], token: 'tkn',
  });
  assert.match(html, /<img class="thumb" src="\/config\/thumb\?token=tkn&amp;file=X%3A%2Fclips%2Fa\.mp4"/);
  assert.match(html, /onerror="this\.style\.display='none'"/);
});

test('dokunma hedefleri en az 44px (CSS min-height)', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't' });
  assert.match(html, /min-height:\s*44px/);
});

test('başlık ve açıklama mevcut plandan doldurulur, kaçışlanır', () => {
  const plan = new StreamPlan({ broadcast: { title: 'A "B" <i>', description: 'x </textarea> y' } });
  const html = renderConfigPage({ plan, clips: [], token: 't' });
  assert.match(html, /name="title" value="A &quot;B&quot; &lt;i&gt;"/);
  assert.match(html, /<textarea name="description"[^>]*>x &lt;\/textarea&gt; y<\/textarea>/);
});

test('kapak: tek seçimli radyo, önizlemeli; seçili olan işaretli, varsayılan satırı var', () => {
  const plan = new StreamPlan({ cover: 'X:/c/b.jpg' });
  const html = renderConfigPage({ plan, clips: [], covers: ['X:/c/a.jpg', 'X:/c/b.jpg'], token: 'tk' });
  assert.match(html, /type="radio"[^>]*name="cover" value="X:\/c\/b\.jpg" checked/);
  assert.doesNotMatch(html, /name="cover" value="X:\/c\/a\.jpg" checked/);
  assert.match(html, /name="cover" value=""/);
  assert.match(html, /src="\/config\/thumb\?token=tk&amp;file=X%3A%2Fc%2Fa\.jpg"/);
});

test('kapak seçilmemişse varsayılan satırı işaretli', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], covers: ['X:/c/a.jpg'], token: 't' });
  assert.match(html, /name="cover" value="" checked/);
});

test('planda olup listede olmayan kapak ek satır olarak görünür (kaybolmaz)', () => {
  const html = renderConfigPage({ plan: new StreamPlan({ cover: 'X:/elle.jpg' }), clips: [], covers: [], token: 't' });
  assert.match(html, /name="cover" value="X:\/elle\.jpg" checked/);
});

test('streamState verilmezse başlat/durdur düğmeleri çıkmaz', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't' });
  assert.doesNotMatch(html, /value="start"/);
  assert.doesNotMatch(html, /value="stop"/);
});

test('çalışırken: durum görünür, Başlat kapalı, Durdur açık ve onay ister', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', streamState: 'running' });
  assert.match(html, /Durum: <strong>Çalışıyor<\/strong>/);
  assert.match(html, /value="start" disabled/);
  assert.match(html, /value="stop" >/);
  assert.match(html, /onsubmit="return confirm\(/);
});

test('durmuşken: Durdur kapalı, Başlat açık', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', streamState: 'stopped' });
  assert.match(html, /Durum: <strong>Durmuş<\/strong>/);
  assert.match(html, /value="stop" disabled/);
  assert.match(html, /value="start" >/);
});

test('başlat/durdur düğmeleri ana formdan AYRI: ayar alanları onlarla gönderilmez', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', streamState: 'running' });
  const startIdx = html.indexOf('value="start"');
  const titleIdx = html.indexOf('name="title"');
  assert.ok(startIdx > 0 && startIdx < titleIdx);
  assert.ok(html.slice(startIdx, titleIdx).includes('</form>'));
});
