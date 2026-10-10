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
