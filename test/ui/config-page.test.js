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

// ─── Yayın seçici + galeri yükleme ─────────────────────────────────────────

const PB1 = {
  id: 'b1', title: 'Canlı <Yayın>', description: 'açıklama', privacyStatus: 'public', lifeCycleStatus: 'live', finished: false,
};
const PB2 = {
  id: 'b2', title: 'Eski', description: '', privacyStatus: 'private', lifeCycleStatus: 'complete', finished: true,
};

test('broadcasts verilmezse yayın seçici hiç çıkmaz', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't' });
  assert.doesNotMatch(html, /YouTube Yayınları/);
});

test('seçici: aktif ve biten yayınlar ayrı gruplarda, durum+görünürlük etiketli, seçili işaretli', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 'tk', broadcasts: { items: [PB1, PB2] }, selectedId: 'b1',
  });
  assert.match(html, /<p class="pickgroup">Aktif \/ yaklaşan<\/p>/);
  assert.match(html, /<p class="pickgroup">Biten<\/p>/);
  assert.match(html, /Canlı &lt;Yayın&gt; · Canlı · Herkese açık/);
  assert.match(html, /Eski · Bitti · Gizli/);
  assert.match(html, /<a class="pickrow sel" href="\/config\?token=tk&amp;broadcast=b1">/);
  assert.match(html, /<details class="dd"><summary class="pickrow">/);
  assert.doesNotMatch(html, /<select class="picker"/, "yerel select değil: içinde resim gösterilemez");
});

test('seçili yayının MEVCUT başlığı/açıklaması/görünürlüğü formda dolu (kaçışlı)', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 't', broadcasts: { items: [PB1] }, selectedId: 'b1',
  });
  assert.match(html, /name="broadcastId" value="b1"/);
  assert.match(html, /name="title" value="Canlı &lt;Yayın&gt;"/);
  assert.match(html, />açıklama<\/textarea>/);
  assert.match(html, /<option value="public" selected>Herkese açık<\/option>/);
  assert.match(html, /action="\/config\/broadcast\?token=t&amp;broadcast=b1"/);
});

test('Yayını Bitir yalnızca canlı/test yayında çıkar ve onay ister', () => {
  const live = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', broadcasts: { items: [PB1] }, selectedId: 'b1' });
  assert.match(live, /value="end"/);
  assert.match(live, /confirm\('Bu yayın BİTİRİLSİN mi\?/);
  const done = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', broadcasts: { items: [PB2] }, selectedId: 'b2' });
  assert.doesNotMatch(done, /value="end"/);
});

test('kapak seçeneği: "Değiştirme" varsayılan, kapak adayları listelenir', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], covers: ['X:/c/a.jpg'], token: 't', broadcasts: { items: [PB1] }, selectedId: 'b1',
  });
  assert.match(html, /<select name="cover"><option value="">Değiştirme<\/option><option value="X:\/c\/a\.jpg">/);
});

test('seçici: hata ve boş liste durumunda kısa not', () => {
  const err = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', broadcasts: { error: true } });
  assert.match(err, /Yayın listesi şu an okunamadı/);
  const empty = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', broadcasts: { items: [] } });
  assert.match(empty, /Kanalda henüz yayın yok/);
});

test('seçili yayın diğer formların action\'ına taşınır (kaydet sonrası seçim bozulmaz)', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 'tk', broadcasts: { items: [PB1] }, selectedId: 'b1', streamState: 'running',
  });
  assert.match(html, /<form method="post" action="\/config\?token=tk&amp;broadcast=b1">/);
  assert.match(html, /action="\/config\/upload\?token=tk&amp;broadcast=b1"/);
});

test('galeri yükleme: multipart form ana formun DIŞINDA, dosya alanı form= ile bağlı', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 'tk' });
  assert.match(html, /<form id="coverUpload" method="post" enctype="multipart\/form-data" action="\/config\/upload\?token=tk"><\/form>/);
  assert.match(html, /<input type="file" name="coverFile" accept="image\/jpeg,image\/png,image\/webp" form="coverUpload"/);
  assert.match(html, /<button class="secondary" type="submit" form="coverUpload">Yükle<\/button>/);
});

test('yüklenen kapak (pendingCover) listede işaretli gelir', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], covers: ['X:/c/a.jpg', 'X:/c/galeri-1.jpg'], token: 't', pendingCover: 'X:/c/galeri-1.jpg',
  });
  assert.match(html, /name="cover" value="X:\/c\/galeri-1\.jpg" checked/);
  assert.doesNotMatch(html, /name="cover" value="X:\/c\/a\.jpg" checked/);
});

test('seçici: başlangıç tarihi Türkiye saatiyle etikette ve durum satırında görünür', () => {
  // 13:05 UTC = 16:05 Türkiye saati
  const started = {
    id: 's1', title: 'Başlamış', description: '', privacyStatus: 'public', lifeCycleStatus: 'live', finished: false,
    startAt: '2026-10-11T13:05:00Z', started: true,
  };
  const planned = {
    id: 's2', title: 'Planlı', description: '', privacyStatus: 'private', lifeCycleStatus: 'ready', finished: false,
    startAt: '2026-10-12T09:30:00Z', started: false,
  };
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 't', broadcasts: { items: [started, planned] }, selectedId: 's1',
  });
  assert.match(html, /● Başlamış · Canlı · Herkese açık · 11 Eki.*16:05/);
  assert.match(html, /Planlı · Hazır · Gizli · 12 Eki.*12:30/);
  assert.match(html, /Başladı: <strong>11 Eki.*16:05<\/strong>/);
  const plannedHtml = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 't', broadcasts: { items: [started, planned] }, selectedId: 's2',
  });
  assert.match(plannedHtml, /Planlanan: <strong>12 Eki.*12:30<\/strong>/);
});

test('seçici: tarih yok ya da geçersizse etiket bozulmaz (tarih sessizce atlanır)', () => {
  const bad = {
    id: 'x', title: 'Tarihsiz', description: '', privacyStatus: 'public', lifeCycleStatus: 'ready', finished: false, startAt: 'bozuk-tarih',
  };
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', broadcasts: { items: [bad] }, selectedId: 'x' });
  assert.match(html, /Tarihsiz · Hazır · Herkese açık<\/span>/);
  assert.doesNotMatch(html, /Invalid Date|NaN/);
});

// ─── Yeni yayın formu + ek yayınlar ────────────────────────────────────────

const ALBUM_CAT = [
  { name: 'mimi', trackCount: 12, backgrounds: ['X:/m/mimi/bg.mp4'] },
  { name: 'zen', trackCount: 3, backgrounds: [] },
];

test('canCreate yoksa "+ Yeni yayın" seçeneği çıkmaz', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 't', broadcasts: { items: [PB1] }, selectedId: 'b1',
  });
  assert.doesNotMatch(html, /Yeni yayın aç/);
});

test('canCreate ile dropdown\'un ilk seçeneği "+ Yeni yayın aç…" ve ?new=1\'e gider', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 'tk', canCreate: true, broadcasts: { items: [PB1] }, selectedId: 'b1',
  });
  assert.match(html, /<div class="picklist"><a class="pickrow" href="\/config\?token=tk&amp;new=1"><span class="thumb"><\/span><span>\+ Yeni yayın aç…<\/span><\/a>/);
  // Yeni yayın modunda değilken mevcut yayın seçili kalır.
  assert.match(html, /class="pickrow sel" href="[^"]*broadcast=b1"/);
  assert.doesNotMatch(html, /name="goLiveNow"/);
});

test('newMode: form açılır (ad, başlık, açıklama, görünürlük, kapak, albümler, otomatik canlıya al); yayın paneli gizlenir', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], covers: ['X:/c/a.jpg'], token: 'tk', canCreate: true, newMode: true,
    broadcasts: { items: [PB1] }, selectedId: 'b1', catalogAlbums: ALBUM_CAT,
  });
  assert.match(html, /\+ Yeni yayın aç…<\/span>/);
  assert.match(html, /<a class="pickrow sel" href="\/config\?token=tk&amp;new=1">/);
  assert.doesNotMatch(html, /class="pickrow sel" href="[^"]*broadcast=b1"/, 'yeni yayın modunda mevcut yayın seçili görünmemeli');
  assert.match(html, /action="\/config\/new\?token=tk"/);
  for (const field of ['name="name"', 'name="title"', 'name="description"', 'name="privacy"', 'name="cover"', 'name="goLiveNow"']) {
    assert.ok(html.includes(field), field);
  }
  assert.match(html, /<option value="unlisted" selected>Liste dışı<\/option>/, 'güvenli varsayılan: liste dışı');
  assert.match(html, /name="albums" value="mimi"[^>]*>/);
  assert.match(html, /mimi · 12 parça/);
  assert.match(html, /src="\/config\/thumb\?token=tk&amp;file=X%3A%2Fm%2Fmimi%2Fbg\.mp4"/);
  assert.match(html, /<option value="X:\/c\/a\.jpg">/);
  assert.match(html, /name="goLiveNow" checked/);
  // Mevcut yayının Bu Yayına Uygula formu görünmemeli.
  assert.doesNotMatch(html, /value="apply"/);
});

test('newMode: hata sonrası girdiler korunur (draft), kaçışlıdır', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], covers: ['X:/c/a.jpg'], token: 't', canCreate: true, newMode: true, broadcasts: { items: [] },
    catalogAlbums: ALBUM_CAT,
    draft: {
      name: 'lofi2', title: 'Gece "yayını" <b>', description: 'açıklama', privacy: 'private', cover: 'X:/c/a.jpg', albums: ['zen'], goLiveNow: false,
    },
    error: 'kapasite dolu',
  });
  assert.match(html, /name="name" value="lofi2"/);
  assert.match(html, /name="title" value="Gece &quot;yayını&quot; &lt;b&gt;"/);
  assert.match(html, /<option value="private" selected>Gizli<\/option>/);
  assert.match(html, /<option value="X:\/c\/a\.jpg" selected>/);
  assert.match(html, /name="albums" value="zen" checked/);
  assert.doesNotMatch(html, /name="albums" value="mimi" checked/);
  assert.doesNotMatch(html, /name="goLiveNow" checked/);
  assert.match(html, /class="error">kapasite dolu/);
});

test('hiç yayın yokken de yalnızca "+ Yeni yayın" ile seçici görünür', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 't', canCreate: true, broadcasts: { items: [] },
  });
  assert.match(html, /Yayın yok/);
  assert.match(html, /\+ Yeni yayın aç…/);
  assert.match(html, /Kanalda henüz yayın yok/);
  // YouTube hatasında da yeni yayın açılabilir.
  const err = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', canCreate: true, broadcasts: { error: true } });
  assert.match(err, /\+ Yeni yayın aç…/);
  assert.match(err, /okunamadı/);
});

test('albüm yoksa form "boş bırakırsan hepsi" notunu gösterir', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 't', canCreate: true, newMode: true, broadcasts: { items: [] }, catalogAlbums: [],
  });
  assert.match(html, /Albüm bulunamadı/);
});

test('Ek Yayınlar: durum + başlat/canlıya al/durdur; durdur onay ister; duruma göre pasif', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 'tk',
    instances: [{ name: 'lofi2', state: 'running' }, { name: 'zen2', state: 'stopped' }],
  });
  assert.match(html, /<h2>Ek Yayınlar<\/h2>/);
  assert.match(html, /<strong>lofi2<\/strong> · Çalışıyor/);
  assert.match(html, /<strong>zen2<\/strong> · Durmuş/);
  assert.match(html, /action="\/config\/instance\?token=tk"/);
  assert.match(html, /name="name" value="lofi2"/);
  assert.match(html, /confirm\('Bu yayın durdurulsun mu\?'\)/);
  // lofi2 çalışıyor: Başlat pasif; zen2 durmuş: Canlıya Al ve Durdur pasif.
  assert.match(html, /name="name" value="lofi2">\s*<button class="secondary" type="submit" name="action" value="start" disabled>/);
  assert.match(html, /name="name" value="zen2">\s*<button class="secondary" type="submit" name="action" value="golive" disabled>/);
  assert.match(html, /name="name" value="zen2">\s*<button class="danger" type="submit" name="action" value="stop" disabled>/);
});

test('ek yayın yoksa Ek Yayınlar bölümü çıkmaz', () => {
  assert.doesNotMatch(renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', instances: [] }), /Ek Yayınlar/);
  assert.doesNotMatch(renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't' }), /Ek Yayınlar/);
});

// ─── Dropdown küçük resimleri ──────────────────────────────────────────────

const THUMB_OK = 'https://i.ytimg.com/vi/abc123/default_live.jpg';

test('dropdown satırlarında ve kapalı (seçili) satırda YouTube küçük resmi görünür', () => {
  const withThumb = { ...PB1, thumbnailUrl: THUMB_OK };
  const other = { ...PB2, thumbnailUrl: 'https://i9.ytimg.com/vi/zzz/default.jpg' };
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 't', broadcasts: { items: [withThumb, other] }, selectedId: 'b1',
  });
  // Seçili satır (summary) + listedeki satırı: aynı resim iki kez.
  assert.equal(html.split(`src="${THUMB_OK}"`).length - 1, 2);
  assert.match(html, /<img class="thumb" src="https:\/\/i9\.ytimg\.com\/vi\/zzz\/default\.jpg" alt="" loading="lazy" onerror="this\.style\.display='none'">/);
  assert.match(html, /<summary class="pickrow"><img class="thumb"/);
});

test('küçük resim adresi yoksa ya da güvensizse resim BASILMAZ, yer tutucu çıkar (XSS/izleme yok)', () => {
  const bad = [
    null, '', 'http://i.ytimg.com/vi/x/default.jpg', 'javascript:alert(1)', 'https://evil.example/x.jpg',
    'https://i.ytimg.com.evil.example/x.jpg', 'https://evil.example/ytimg.com/x.jpg', '"><script>alert(1)</script>',
  ];
  for (const thumbnailUrl of bad) {
    const html = renderConfigPage({
      plan: new StreamPlan({}), clips: [], token: 't', broadcasts: { items: [{ ...PB1, thumbnailUrl }] }, selectedId: 'b1',
    });
    assert.doesNotMatch(html, /<img class="thumb" src="(?!\/config\/thumb)/, `güvensiz adres basılmamalı: ${thumbnailUrl}`);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /<summary class="pickrow"><span class="thumb"><\/span>/);
  }
});

test('"+ Yeni yayın aç…" satırı resimsiz yer tutucuyla gelir ve ilk sırada durur', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 't', canCreate: true, broadcasts: { items: [{ ...PB1, thumbnailUrl: THUMB_OK }] }, selectedId: 'b1',
  });
  const list = html.slice(html.indexOf('<div class="picklist">'));
  assert.ok(list.indexOf('Yeni yayın aç…') < list.indexOf('Canlı &lt;Yayın&gt;'));
});
