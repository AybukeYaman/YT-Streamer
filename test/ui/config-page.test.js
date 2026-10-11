const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderConfigPage, esc } = require('../../src/ui/config-page');
const { StreamPlan } = require('../../src/domain/stream-plan');
const { canonicalForms } = require('./helpers/form-data');
const { scenarios } = require('./helpers/scenarios');

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

test('dokunma hedefleri en az 44px (CSS --tap token\'ı)', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't' });
  assert.match(html, /--tap:\s*(4[4-9]|[5-9]\d)px/);
  assert.match(html, /button\s*\{[^}]*min-height:\s*var\(--tap\)/);
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

test('çalışırken: durum görünür, yalnızca Durdur çizilir ve onay ister (pasif Başlat yok)', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', streamState: 'running' });
  assert.match(html, /Durum: <strong>Çalışıyor<\/strong>/);
  assert.match(html, /name="action" value="stop">Durdur/);
  assert.doesNotMatch(html, /value="start"/);
  assert.doesNotMatch(html, /<button[^>]*\bdisabled\b/);
  assert.match(html, /onsubmit="return confirm\('Yayın durdurulsun mu\?/);
});

test('durmuşken: yalnızca Başlat çizilir (birincil), Durdur yok; sonraki adım ipucu var', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', streamState: 'stopped' });
  assert.match(html, /Durum: <strong>Durmuş<\/strong>/);
  assert.match(html, /<button class="primary" type="submit" name="action" value="start">Başlat/);
  assert.doesNotMatch(html, /value="stop"/);
  assert.match(html, /canlıya al/);
});

test('durum bilinmiyorken ikisi de çizilir (hangisinin doğru olduğu belli değil)', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', streamState: 'unknown' });
  assert.match(html, /Durum: <strong>Bilinmiyor<\/strong>/);
  assert.match(html, /value="start"/);
  assert.match(html, /value="stop"/);
});

test('başlat/durdur düğmeleri ana formdan AYRI: ayar alanları onlarla gönderilmez', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', streamState: 'stopped' });
  const startIdx = html.indexOf('value="start"');
  const titleIdx = html.indexOf('name="title"');
  assert.ok(startIdx > 0 && startIdx < titleIdx);
  assert.ok(html.slice(startIdx, titleIdx).includes('</form>'));
  // Ana yayın kartı "Şu an" bölümünde, plan formundan ÖNCE.
  assert.ok(html.indexOf('<h2>Şu an</h2>') < html.indexOf('id="planForm"'));
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
  assert.doesNotMatch(html, /YouTube'daki yayın/);
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
  assert.match(html, /<input type="radio" id="b-privacy-public" name="privacy" value="public" checked><label for="b-privacy-public">Herkese açık<\/label>/);
  assert.doesNotMatch(html, /name="privacy" value="private" checked/);
  assert.match(html, /action="\/config\/broadcast\?token=t&amp;broadcast=b1"/);
});

test('Yayını Bitir yalnızca canlı/test yayında çıkar, katlı tehlike bölgesinde ve onay ister', () => {
  const live = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', broadcasts: { items: [PB1] }, selectedId: 'b1' });
  assert.match(live, /value="end"/);
  assert.match(live, /confirm\('Bu yayın BİTİRİLSİN mi\?/);
  assert.match(live, /<details class="fold dangerzone"><summary>Yayını bitir…/, 'varsayılan kapalı: yanlışlıkla dokunulmasın');
  const done = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', broadcasts: { items: [PB2] }, selectedId: 'b2' });
  assert.doesNotMatch(done, /value="end"/);
});

test('kapak seçeneği: "Değiştirme" varsayılan, kapak adayları listelenir', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], covers: ['X:/c/a.jpg'], token: 't', broadcasts: { items: [PB1] }, selectedId: 'b1',
  });
  const form = html.slice(html.indexOf('value="apply"') - 3000, html.indexOf('value="apply"'));
  // İlk kart "Değiştirme" ve varsayılan olarak işaretli; kapak adayı seçili DEĞİL.
  assert.match(form, /name="cover" value="" checked class="tin"><span class="tw"><span class="ph" aria-hidden="true">—<\/span><\/span><span class="tn">Değiştirme<\/span>/);
  assert.match(form, /id="b-cover-X__c_a_jpg" name="cover" value="X:\/c\/a\.jpg" class="tin">/);
  assert.match(form, /src="\/config\/thumb\?token=t&amp;file=X%3A%2Fc%2Fa\.jpg"/);
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
  assert.match(html, /<form id="planForm" method="post" action="\/config\?token=tk&amp;broadcast=b1" data-guard>/);
  assert.match(html, /action="\/config\/upload\?token=tk&amp;broadcast=b1"/);
});

test('galeri yükleme: multipart form ana formun DIŞINDA, dosya alanı form= ile bağlı', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 'tk' });
  assert.match(html, /<form id="coverUpload" method="post" enctype="multipart\/form-data" action="\/config\/upload\?token=tk"><\/form>/);
  assert.match(html, /<input type="file" id="coverFile" name="coverFile" accept="image\/jpeg,image\/png,image\/webp" form="coverUpload"/);
  assert.match(html, /<button class="secondary nojs-only" type="submit" form="coverUpload">Yükle<\/button>/);
  assert.match(html, /<label class="filebtn" for="coverFile">\+ Galeriden görsel ekle<\/label>/);
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
  // Sayfa sonunda da keşfedilebilir bir bağlantı var (menünün içine gömülü kalmasın).
  assert.match(html, /<a class="newlink" href="\/config\?token=tk&amp;new=1">/);
});

test('newMode: form açılır (ad, başlık, açıklama, görünürlük, kapak, albümler, otomatik canlıya al); yayın paneli gizlenir', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], covers: ['X:/c/a.jpg'], token: 'tk', canCreate: true, newMode: true,
    broadcasts: { items: [PB1] }, selectedId: 'b1', catalogAlbums: ALBUM_CAT,
  });
  assert.match(html, /\+ Yeni yayın aç…<\/span>/);
  assert.match(html, /<a class="pickrow sel" href="\/config\?token=tk&amp;new=1">/);
  assert.doesNotMatch(html, /class="pickrow sel" href="[^"]*broadcast=b1"/, 'yeni yayın modunda mevcut yayın seçili görünmemeli');
  assert.match(html, /action="\/config\/new\?token=tk&amp;broadcast=b1"/, 'seçili yayın yeni-yayın formunda da taşınır');
  for (const field of ['name="name"', 'name="title"', 'name="description"', 'name="privacy"', 'name="cover"', 'name="goLiveNow"']) {
    assert.ok(html.includes(field), field);
  }
  assert.match(html, /name="privacy" value="unlisted" checked/, 'güvenli varsayılan: liste dışı');
  assert.doesNotMatch(html, /name="privacy" value="public" checked/);
  assert.match(html, /name="albums" value="mimi"[^>]*>/);
  assert.match(html, /mimi · 12 parça/);
  assert.match(html, /src="\/config\/thumb\?token=tk&amp;file=X%3A%2Fm%2Fmimi%2Fbg\.mp4"/);
  assert.match(html, /id="n-cover-X__c_a_jpg" name="cover" value="X:\/c\/a\.jpg" class="tin">/);
  assert.match(html, /name="goLiveNow" checked class="sw"/);
  // Mevcut yayının Bu Yayına Uygula formu görünmemeli.
  assert.doesNotMatch(html, /value="apply"/);
  // Albümler katlı bölümde ama FORM İÇİNDE (tarayıcı kapalı <details> alanlarını da gönderir).
  assert.match(html, /<details class="fold"><summary>Kapak ve albümler <span class="sumnote">· tüm kütüphane çalar/);
});

test('newMode: hata sonrası girdiler korunur (draft), kaçışlıdır; seçili albüm bölümü açık gelir', () => {
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
  assert.match(html, /name="privacy" value="private" checked/);
  assert.match(html, /name="cover" value="X:\/c\/a\.jpg" checked/);
  assert.match(html, /name="albums" value="zen" checked/);
  assert.doesNotMatch(html, /name="albums" value="mimi" checked/);
  assert.doesNotMatch(html, /name="goLiveNow" checked/);
  assert.match(html, /class="error">kapasite dolu/);
  assert.match(html, /<details class="fold" open><summary>Kapak ve albümler <span class="sumnote">· 1 albüm seçili/);
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

test('Ek yayınlar: durum + bağlamsal ana düğme; durdur "Diğer işlemler" altında ve onay ister', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 'tk',
    instances: [
      { name: 'lofi2', state: 'running' }, { name: 'zen2', state: 'stopped' }, { name: 'kim', state: 'unknown' },
    ],
  });
  assert.match(html, /<h3>Ek yayınlar<\/h3>/);
  assert.match(html, /<strong>lofi2<\/strong> · Çalışıyor/);
  assert.match(html, /<strong>zen2<\/strong> · Durmuş/);
  assert.match(html, /action="\/config\/instance\?token=tk"/);
  assert.match(html, /name="name" value="lofi2"/);
  assert.match(html, /confirm\('Bu yayın durdurulsun mu\?'\)/);
  assert.doesNotMatch(html, /<button[^>]*\bdisabled\b/);
  const card =(name) => {
    const i = html.indexOf(`<strong>${name}</strong>`);
    const next = Math.min(
      ...['<div class="card">', '</section>'].map((m) => html.indexOf(m, i)).filter((n) => n !== -1),
    );
    return html.slice(i, next);
  };
  const actions = (name) => [...card(name).matchAll(/name="action" value="(\w+)"/g)].map((m) => m[1]);
  // Eskiden SUNUCUDA GEÇERLİ olan her işlem hâlâ erişilebilir; yalnızca anlamsız olanlar kalktı.
  assert.deepEqual(actions('lofi2'), ['golive', 'stop'], 'çalışıyor: Canlıya Al ana, Durdur diğer işlemlerde');
  assert.deepEqual(actions('zen2'), ['start'], 'durmuş: yalnızca Başlat');
  assert.deepEqual(actions('kim'), ['start', 'stop'], 'bilinmiyor: Başlat ana, Durdur diğer işlemlerde');
  assert.match(card('lofi2'), /<details class="fold more"><summary>Diğer işlemler/);
  assert.doesNotMatch(card('zen2'), /<details/);
});

test('ek yayın yoksa Ek yayınlar bölümü çıkmaz', () => {
  assert.doesNotMatch(renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', instances: [] }), /Ek yayınlar/);
  assert.doesNotMatch(renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't' }), /Ek yayınlar/);
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

// ─── Yeniden tasarım (mobile-ux-redesign-plan.md): eşdeğerlik ve erişilebilirlik ───

test('FORM EŞDEĞERLİĞİ: yeni sayfa, eski sürümle aynı alan/değer çiftlerini gönderir (altın örnekler)', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'config-page.form-golden.json'), 'utf8'));
  for (const [name, make] of Object.entries(scenarios)) {
    const actual = canonicalForms(renderConfigPage(make())).map((f) => JSON.parse(f));
    assert.deepEqual(actual, golden[name], `senaryo "${name}": gönderilen form verisi eski sürümden farklı`);
  }
});

test('sayfa sırası: Şu an → YouTube\'daki yayın → Sonraki yayın; Kaydet düğmeleri formun sonunda', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 't', streamState: 'running', broadcasts: { items: [PB1] }, selectedId: 'b1',
  });
  const order = ['<h2>Şu an</h2>', "<h2>YouTube'daki yayın</h2>", '<h2>Sonraki yayın</h2>', 'value="save"', 'value="save_restart"'];
  const idx = order.map((s) => html.indexOf(s));
  assert.ok(idx.every((i) => i > 0), `eksik bölüm: ${JSON.stringify(idx)}`);
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'bölümler beklenen sırada değil');
  // Implicit submit (Enter) formdaki İLK gönder düğmesini kullanır: bu Kaydet olmalı, yeniden başlatma değil.
  const planForm = html.slice(html.indexOf('id="planForm"'));
  assert.ok(planForm.indexOf('value="save"') < planForm.indexOf('value="save_restart"'));
});

test('erişilebilirlik: her metin/textarea/select/dosya alanı gerçek bir <label for> ile bağlı', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: ['X:/a.mp4'], covers: ['X:/c.jpg'], token: 't', canCreate: true, newMode: true,
    broadcasts: { items: [PB1] }, selectedId: 'b1', catalogAlbums: ALBUM_CAT, instances: [{ name: 'x', state: 'running' }],
  });
  const withBroadcast = renderConfigPage({
    plan: new StreamPlan({}), clips: ['X:/a.mp4'], covers: ['X:/c.jpg'], token: 't', broadcasts: { items: [PB1] }, selectedId: 'b1',
  });
  for (const page of [html, withBroadcast]) {
    const labelFor = new Set([...page.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]));
    const controls = [...page.matchAll(/<(input|textarea|select)\b([^>]*)>/g)]
      .map((m) => ({ tag: m[1], attrs: m[2] }))
      .filter((c) => !/type="(hidden|submit|button)"/.test(c.attrs));
    assert.ok(controls.length > 5);
    for (const c of controls) {
      const id = /\bid="([^"]+)"/.exec(c.attrs)?.[1];
      assert.ok(id, `id'siz kontrol: <${c.tag}${c.attrs}>`);
      assert.ok(labelFor.has(id), `<label for="${id}"> yok`);
    }
    // id'ler benzersiz (aynı kapak/albüm iki formda tekrarlansa bile).
    const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'tekrarlanan id var');
  }
});

test('D5: arayüzde SSH/terminal gerektiren metin yok; müzik notu gerçek duruma göre', () => {
  const states = [
    renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't' }),
    renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', streamState: 'stopped', canCreate: true }),
  ];
  const picked = new StreamPlan({ music: { albums: [{ name: 'a', trackPaths: ['x/1.mp3', 'x/2.mp3'] }] } });
  states.push(renderConfigPage({ plan: picked, clips: [], token: 't' }));
  for (const html of states) assert.doesNotMatch(html, /npm run|SSH|sihirbaz/i);
  assert.match(states[0], /Müzik: kütüphanedeki tüm parçalar çalıyor/);
  assert.match(states[2], /Müzik: 2 parça seçili/);
});

test('katlı bölümler varsayılan kapalı ama alanları formda (kapalı <details> alanları da gönderilir)', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({ pomodoro: { enabled: true, studyVideos: ['X:/a.mp4'] } }), clips: ['X:/a.mp4'], token: 't',
  });
  assert.match(html, /<details class="fold"><summary>Çalışma görselleri <span class="sumnote" data-count-for="studyVideos">· 1 seçili/);
  assert.match(html, /<details class="fold"><summary>Mola görselleri <span class="sumnote" data-count-for="breakVideos">· 0 seçili/);
  const plan = canonicalForms(html).map((f) => JSON.parse(f)).find((f) => f.action === '/config?token=t');
  assert.ok(plan.entries.some(([k, v]) => k === 'studyVideos' && v === 'X:/a.mp4'));
});

// ─── Faz 2: seçim kontrolleri ──────────────────────────────────────────────

test('görünürlük: 3 seçenekli bölmeli seçim (radyo), etiketli grup; sayfada hiç <select> kalmadı', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], covers: ['X:/c/a.jpg'], token: 't', canCreate: true,
    broadcasts: { items: [{ ...PB1, privacyStatus: 'unlisted' }] }, selectedId: 'b1', catalogAlbums: ALBUM_CAT,
  });
  assert.match(html, /<div class="seg" role="radiogroup" aria-labelledby="b-privacy-l">/);
  assert.match(html, /<p class="lbl" id="b-privacy-l">Görünürlük<\/p>/);
  const values = [...html.matchAll(/id="b-privacy-\w+" name="privacy" value="(\w+)"( checked)?/g)].map((m) => [m[1], Boolean(m[2])]);
  assert.deepEqual(values, [['public', false], ['unlisted', true], ['private', false]]);
  assert.doesNotMatch(html, /<select/);
  const newPage = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 't', canCreate: true, newMode: true, broadcasts: { items: [] }, catalogAlbums: [],
  });
  assert.doesNotMatch(newPage, /<select/);
});

test('Pomodoro: anahtar (gerçek onay kutusu) + bağımlı gövde; kapalıyken gövde gizlenir ama alanlar formda kalır', () => {
  const on = renderConfigPage({ plan: new StreamPlan({ pomodoro: { enabled: true, type: '30+10' } }), clips: ['X:/a.mp4'], token: 't' });
  const off = renderConfigPage({ plan: new StreamPlan({}), clips: ['X:/a.mp4'], token: 't' });
  assert.match(on, /<input type="checkbox" id="pomodoroEnabled" name="pomodoroEnabled" checked class="sw"><label for="pomodoroEnabled" class="swl">/);
  assert.doesNotMatch(off, /name="pomodoroEnabled" checked/);
  // Gizleme YALNIZCA CSS ile (display:none): `disabled` kullanılsaydı alanlar gönderilmezdi.
  assert.match(off, /\.sw:not\(:checked\) ~ \.pomo-body \{ display: none; \}/);
  assert.doesNotMatch(off, /pomo-body"[^>]*disabled/);
  // Süre ve klipler gövdenin İÇİNDE ve anahtardan SONRA (kardeş seçici çalışsın).
  const sw = off.indexOf('class="swl"');
  const body = off.indexOf('class="pomo-body"');
  assert.ok(sw > 0 && body > sw);
  for (const marker of ['name="pomodoroType"', 'name="studyVideos"', 'name="breakVideos"']) {
    assert.ok(off.indexOf(marker) > body, `${marker} gövdenin içinde olmalı`);
  }
  const entries = canonicalForms(off).map((f) => JSON.parse(f)).find((f) => f.action === '/config?token=t').entries;
  assert.ok(entries.some(([k, v]) => k === 'pomodoroType' && v === '50+10'), 'kapalıyken de süre gönderilir (eski davranış)');
});

test('Pomodoro süre kısayolları: yalnızca type="button" (asla gönderme), tek bir pomodoroType alanı, JS yoksa metin alanı görünür', () => {
  const html = renderConfigPage({ plan: new StreamPlan({ pomodoro: { enabled: true, type: '45+15' } }), clips: [], token: 't' });
  const presets = html.slice(html.indexOf('id="pomoPresets"'), html.indexOf('id="ptCustom"'));
  const buttons = [...presets.matchAll(/<button type="button" data-type="([^"]*)" aria-pressed="false">([^<]+)<\/button>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(buttons, [['50+10', '50+10'], ['30+10', '30+10'], ['45+15', '45+15'], ['', 'Özel']]);
  assert.doesNotMatch(presets, /type="submit"/);
  assert.equal(html.split('name="pomodoroType"').length - 1, 1, 'pomodoroType tek alan olmalı (çift gönderim olmasın)');
  assert.match(html, /\.js-only \{ display: none; \}/);
  assert.match(html, /html\.js \.pt-custom \{ display: none; \}/, 'metin alanı yalnızca JS varken gizlenir');
  assert.match(html, /<script>document\.documentElement\.className \+= ' js';<\/script>/);
});

test('kapak kartları: tek seçim, işaretli kart + ✓ biçimi, id\'ler formlar arası benzersiz', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({ cover: 'X:/c/b.jpg' }), clips: [], covers: ['X:/c/a.jpg', 'X:/c/b.jpg'], token: 't',
    broadcasts: { items: [PB1] }, selectedId: 'b1',
  });
  const groups = [...html.matchAll(/<div class="tilegrid">(.*?)<\/div>/g)].map((m) => m[1]);
  assert.equal(groups.length, 2, 'mevcut yayın + sonraki yayın kapak ızgaraları');
  for (const g of groups) assert.equal([...g.matchAll(/type="radio"/g)].length, 3, 'varsayılan + 2 kapak');
  assert.match(groups[1], /value="X:\/c\/b\.jpg" checked class="tin"/);
  assert.match(html, /\.tin:checked ~ \.tn::before \{ content: '✓ '/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('klip havuzları: 2 sütunlu kart ızgarası, canlı "N seçili" özeti için işaretli', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({ pomodoro: { enabled: true, studyVideos: ['X:/a.mp4', 'X:/b.mp4'] } }), clips: ['X:/a.mp4', 'X:/b.mp4', 'X:/c.mp4'], token: 't',
  });
  const study = html.slice(html.indexOf('Çalışma görselleri'), html.indexOf('Mola görselleri'));
  assert.match(study, /<div class="tilegrid two">/);
  assert.equal([...study.matchAll(/type="checkbox"[^>]*name="studyVideos"/g)].length, 3);
  assert.equal([...study.matchAll(/name="studyVideos" value="[^"]+" checked/g)].length, 2);
  assert.match(study, /data-count-for="studyVideos">· 2 seçili/);
});

test('betik: yalnızca kolaylık (JS yoksa da çalışır); HTML etiketi benzeri dize ve kapanış etiketi içermez', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't' });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2);
  for (const s of scripts) assert.doesNotMatch(s, /<\w|<\//, 'betik HTML etiketi içermemeli');
});

test('hareket azaltma: prefers-reduced-motion destekli (geçişler yalnızca no-preference\'ta)', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't' });
  assert.match(html, /@media \(prefers-reduced-motion: no-preference\)/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)[^{]*\{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important/);
});

// ─── Faz 3: geri bildirim ve güvenlik ağı (D1-D4) ──────────────────────────

test('D1: "Kaydet ve Yeniden Başlat" her durumda açık onay ister; metin duruma göre', () => {
  const confirmOf = (streamState) => {
    const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', streamState });
    const m = /value="save_restart" onclick="return confirm\('([^']+)'\)"/.exec(html);
    assert.ok(m, `onay yok (durum: ${streamState})`);
    return m[1];
  };
  assert.match(confirmOf('running'), /ÇALIŞIYOR.*KESER.*Devam edilsin mi\?/);
  assert.match(confirmOf('stopped'), /durmuş.*BAŞLATIR/);
  assert.match(confirmOf('unknown'), /KESİLİR/);
  assert.match(confirmOf(null), /yeniden başlatır/);
  // Onay yalnızca yeniden başlatma düğmesinde; "Kaydet" onaysız ve formdaki İLK gönder düğmesi.
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', streamState: 'running' });
  assert.match(html, /<button class="primary" type="submit" name="action" value="save">Kaydet<\/button>/);
  assert.match(html, /Kaydet yalnızca planı kaydeder, çalışan yayına dokunmaz/);
});

test('D2/D3: kaydedilmemiş değişiklik koruması — düzenleme formları data-guard ile işaretli, yükleme uyarılı', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 't', canCreate: true, broadcasts: { items: [PB1] }, selectedId: 'b1',
  });
  const guardedForms = [...html.matchAll(/<form [^>]*data-guard>/g)].map((m) => m[0]);
  assert.equal(guardedForms.length, 2, 'plan formu + seçili yayın formu');
  assert.ok(guardedForms.some((f) => f.includes('id="planForm"')));
  assert.ok(guardedForms.some((f) => f.includes('/config/broadcast')));
  const newMode = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 't', canCreate: true, newMode: true, broadcasts: { items: [] }, catalogAlbums: [],
  });
  assert.ok(/<form [^>]*\/config\/new[^>]*data-guard>/.test(newMode), 'yeni yayın formu da korunur');
  // Yükleme: betik uyarır; betik yoksa eski davranış (doğrudan gönder). "Yükle" düğmesi her durumda var.
  assert.match(html, /onchange="if\(window\.uploadPick\)\{uploadPick\(this\)\}else\{document\.getElementById\('coverUpload'\)\.submit\(\)\}"/);
  const script = html.match(/<script>(?!document)([\s\S]*?)<\/script>/)[1];
  assert.match(script, /askDiscard\('Görsel yüklenince sayfa yenilenir ve'\)/);
  assert.match(script, /askDiscard\('Başka bir yayına ya da sayfaya geçersen'\)/);
  assert.match(script, /Tamam: değişiklikleri at ve devam et\\nİptal: sayfada kal/);
  assert.match(script, /addEventListener\('beforeunload'/);
});

test('D4: işlem durumu — düğmeler PASİFLEŞTİRİLMEZ (name/value kaybolmasın), ikinci gönderim engellenir', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 't', canCreate: true, newMode: true, broadcasts: { items: [] }, catalogAlbums: [],
  });
  const script = html.match(/<script>(?!document)([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(script, /\.disabled\s*=/, 'gönderen düğme pasifleştirilirse formdan çıkar (action kaybolur)');
  assert.doesNotMatch(html, /this\.disabled=true/, 'eski "disabled + form.submit()" düzeni kalktı');
  assert.match(script, /if \(busy\) \{ e\.preventDefault\(\); return; \}/);
  assert.match(script, /if \(e\.defaultPrevented\) return;/, 'satır içi onay (confirm) iptali de dikkate alınır');
  assert.match(script, /save_restart: 'Kaydedilip yeniden başlatılıyor…'/);
  assert.match(script, /addEventListener\('pageshow'/);
  assert.match(html, /button\.wait \{ opacity: \.55; pointer-events: none; \}/);
  // Yeni yayın gönder düğmesi artık normal bir submit (gönderim submit olayından geçer).
  assert.match(html, /<button class="primary" type="submit" data-busy="Yayın kuruluyor[^"]*">Yayını Kur ve Başlat<\/button>/);
  assert.doesNotMatch(script, /config\/new/, 'betik, özelliği kapalı sayfada /config/new izi bırakmamalı');
});

test('geri bildirim: sonuç bandı erişilebilir rol taşır; değişiklik notu aria-live; sticky çubuk yalnızca JS + dirty', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', notice: 'tamam', error: 'olmadı' });
  assert.match(html, /<div role="status" class="notice">tamam<\/div>/);
  assert.match(html, /<div role="alert" class="error">olmadı<\/div>/);
  assert.match(html, /<p class="dirtynote" id="dirtyNote" role="status" aria-live="polite"><\/p>/);
  assert.match(html, /html\.js form\.dirty \.savebar \{\s*position: sticky; bottom: 0;/);
  assert.match(html, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(html.replace(/html\.js form\.dirty \.savebar \{[^}]*\}/, ''), /position: sticky/, 'başka sticky yok: içerik örtülmez');
});

test('duyarlı düzen: telefon tek sütun; geniş ekranda sütun genişler, ızgaralar uyarlanır', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't' });
  assert.match(html, /body \{[^}]*max-width: 480px/);
  assert.match(html, /@media \(min-width: 640px\) \{ body \{ max-width: 720px; \} \}/);
  assert.match(html, /@media \(max-width: 360px\) \{ \.tilegrid \{ grid-template-columns: repeat\(2, 1fr\); \} \}/);
  assert.doesNotMatch(html, /overflow-x:\s*scroll/);
});

test('yüklenen ama kaydedilmemiş kapak: plan formu data-pending taşır (sayfa baştan "kaydedilmemiş" sayılır)', () => {
  const pending = renderConfigPage({
    plan: new StreamPlan({}), clips: [], covers: ['X:/c/g.jpg'], token: 't', pendingCover: 'X:/c/g.jpg',
  });
  assert.match(pending, /<form id="planForm" method="post" action="\/config\?token=t" data-guard data-pending>/);
  const normal = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't' });
  assert.match(normal, /<form id="planForm" method="post" action="\/config\?token=t" data-guard>/);
  const script = pending.match(/<script>(?!document)([\s\S]*?)<\/script>/)[1];
  assert.match(script, /hasAttribute\('data-pending'\)/);
});

// ─── Renk kontrastı (WCAG) ─────────────────────────────────────────────────

function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test('kontrast: metin ≥ 4.5:1, bileşen kenarı/durum noktası ≥ 3:1 (token çiftleri)', () => {
  const html = renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't' });
  const tok = Object.fromEntries([...html.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
  const textPairs = [
    ['text', 'bg'], ['text', 'surface'], ['text', 'surface-2'], ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-2'],
    ['head', 'bg'], ['focus', 'surface'],
  ];
  for (const [fg, bg] of textPairs) assert.ok(contrast(tok[fg], tok[bg]) >= 4.5, `${fg} on ${bg}: ${contrast(tok[fg], tok[bg]).toFixed(2)}`);
  // Düğme metinleri (beyaz): birincil (accent-strong) ve tehlike.
  for (const bg of ['accent-strong', 'danger']) assert.ok(contrast('#ffffff', tok[bg]) >= 4.5, `beyaz on ${bg}`);
  // Bileşen sınırları ve durum noktaları (WCAG 1.4.11): kart yüzeyinde ve zeminde ≥ 3:1.
  // Anahtar açıkken (accent-strong dolgu) ve seçili kart kenarı (accent) kart zemininde seçilebilir kalmalı.
  assert.ok(contrast(tok.accent, tok.surface) >= 3, 'accent on surface (anahtar dolgusu, seçili kart kenarı)');
  assert.ok(contrast('#ffffff', tok.accent) >= 3, 'anahtar topuzu (beyaz) accent dolgusunda');
  for (const fg of ['border-strong', 'ok', 'warn', 'idle', 'danger-edge']) {
    for (const bg of ['bg', 'surface']) assert.ok(contrast(tok[fg], tok[bg]) >= 3, `${fg} on ${bg}: ${contrast(tok[fg], tok[bg]).toFixed(2)}`);
  }
});
