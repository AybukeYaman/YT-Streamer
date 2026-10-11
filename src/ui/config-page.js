// Mobil yapılandırma sayfası (Faz N2): saf fonksiyon, veri → HTML metni. fs/http YOK —
// bu yüzden kolayca test edilir (bkz. test/ui/config-page.test.js). HTML'i basan
// golive-server.js, veriyi hazırlayan ise src/application/config-api.js.
//
// Neden bu sayfa var: yayın VPS'te systemd altında çalışırken TUI sihirbazını SSH'sız
// kullanmanın tek yolu buydu (bkz. PLAN-yapilandirma-ui.md Faz N1 — --plan-only SSH
// gerektiriyor, bu sayfa SSH bile gerektirmiyor, telefondan tailscale üzerinden açılıyor).
const { shortPath } = require('./config-wizard');
const { MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH } = require('../domain/stream-plan');

// HTML'e gömülecek her metin kaçışlanır — dosya adlarında <, &, " olabilir (örn.
// "AC/DC <live>.mp4" gibi uç bir ad bile sayfayı bozmamalı).
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// thumbSrc: /config/thumb URL'i ya da null (token yoksa/istenmiyorsa resim basılmaz —
// sayfa resimsiz de ÇALIŞIR, bkz. golive-server.js'teki thumbnailProvider opsiyonel notu).
// onerror: üretilemeyen/henüz üretilmemiş bir önizlemede kırık resim ikonu yerine
// elemanı GİZLER — sessiz bozulma yerine sessizce eksik kalma (break-clip.js'teki "görsel
// hazırlanamazsa yayın sürer" ilkesiyle aynı ruh).
function checkbox(name, value, checked, label, thumbSrc, type = 'checkbox') {
  const id = `${name}-${esc(value).replace(/[^a-zA-Z0-9]/g, '_')}`;
  const thumb = thumbSrc
    ? `<img class="thumb" src="${esc(thumbSrc)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : '';
  return `
    <label class="row" for="${id}">
      <input type="${type}" id="${id}" name="${esc(name)}" value="${esc(value)}" ${checked ? 'checked' : ''}>
      ${thumb}
      <span>${esc(label)}</span>
    </label>`;
}

// Kapak: tek seçim (radyo). İlk satır "varsayılan" (value="" → plan.cover null → config.json'daki
// kapak). Plandaki kapak listede yoksa (elle yazılmış yol) ek satır olarak gösterilir,
// böylece kaydedince sessizce kaybolmaz.
function coverList(covers, selected, token) {
  const known = covers.includes(selected) || !selected ? covers : [selected, ...covers];
  const rows = known.map((c) => {
    const thumbSrc = `/config/thumb?token=${encodeURIComponent(token)}&file=${encodeURIComponent(c)}`;
    return checkbox('cover', c, c === selected, shortPath(c), thumbSrc, 'radio');
  });
  const none = checkbox('cover', '', !selected, 'Varsayılan (config.json)', null, 'radio');
  return `<div class="checklist">${none}${rows.join('')}</div>`;
}

function clipList(name, clips, selected, token) {
  if (!clips.length) return '<p class="muted">Klip bulunamadı — albüm arkaplanı ya da assets/ altına video ekleyin.</p>';
  const set = new Set(selected);
  return `<div class="checklist">${clips.map((c) => {
    const thumbSrc = `/config/thumb?token=${encodeURIComponent(token)}&file=${encodeURIComponent(c)}`;
    return checkbox(name, c, set.has(c), shortPath(c), thumbSrc);
  }).join('')}</div>`;
}

// Yayın süreci düğmeleri (streamState null ise hiç çıkmaz: özellik opsiyonel). AYRI formlar:
// ana formun alanlarını (başlık, klipler…) göndermez, yani başlat/durdur ayarları kaydetmez.
// Durdurma onay ister — telefonda yanlışlıkla dokunulabilir ve canlı yayını keser.
function streamControls(streamState, action) {
  if (!streamState) return '';
  const labels = { running: 'Çalışıyor', stopped: 'Durmuş', unknown: 'Bilinmiyor' };
  const label = labels[streamState] ?? labels.unknown;
  return `<section>
    <h2>Yayın</h2>
    <p class="state">Durum: <strong>${esc(label)}</strong></p>
    <p class="hint">Başlattıktan 30-60 sn sonra canlıya almak için go-live tetikle (Shortcuts).</p>
    <div class="btnrow">
      <form method="post" action="${esc(action)}">
        <button class="secondary" type="submit" name="action" value="start" ${streamState === 'running' ? 'disabled' : ''}>Başlat</button>
      </form>
      <form method="post" action="${esc(action)}" onsubmit="return confirm('Yayın durdurulsun mu? Canlı yayın kesilir.')">
        <button class="danger" type="submit" name="action" value="stop" ${streamState === 'stopped' ? 'disabled' : ''}>Durdur</button>
      </form>
    </div>
  </section>`;
}

const PRIVACY_LABELS = { public: 'Herkese açık', unlisted: 'Liste dışı', private: 'Gizli' };
const LIFECYCLE_LABELS = {
  created: 'Oluşturuldu', ready: 'Hazır', testing: 'Test', liveStarting: 'Canlıya geçiyor',
  live: 'Canlı', complete: 'Bitti', revoked: 'İptal edildi',
};

const ENDABLE_STATES = new Set(['live', 'testing', 'liveStarting']);

const shorten = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// Yayın seçici + seçili yayının işlem paneli. YouTube'daki VAR OLAN yayınlar üzerinde çalışır
// (plandaki "sonraki yayın" ayarlarından ayrı). broadcasts: { items } | { error: true } | null.
//   - null: özellik kapalı (broadcastAdmin yok) → bölüm hiç çıkmaz.
//   - { error }: YouTube listesi okunamadı → kısa not, sayfanın geri kalanı çalışır.
// Seçim URL'de taşınır (?broadcast=<id>): <select> değişince o adrese gider, JS'siz de çalışan
// düz bir GET. İşlem formları ana plan formundan AYRI (iç içe form olmaz, planı kaydetmez).
function broadcastPicker({
  broadcasts, selectedId, token, covers,
}) {
  if (!broadcasts) return '';
  const head = '<section>\n    <h2>YouTube Yayınları</h2>';
  if (broadcasts.error) return `${head}\n    <p class="muted">Yayın listesi şu an okunamadı (YouTube'a ulaşılamadı).</p>\n  </section>`;
  const items = broadcasts.items ?? [];
  if (!items.length) {
    return `${head}\n    <p class="muted">Kanalda henüz yayın yok. Canlıya alınca burada görünür.</p>\n  </section>`;
  }

  const t = encodeURIComponent(token);
  const label = (b) => `${shorten(b.title, 40)} · ${LIFECYCLE_LABELS[b.lifeCycleStatus] ?? b.lifeCycleStatus ?? '?'} · ${PRIVACY_LABELS[b.privacyStatus] ?? b.privacyStatus ?? '?'}`;
  const option = (b) => `<option value="${esc(`/config?token=${t}&broadcast=${encodeURIComponent(b.id)}`)}"${b.id === selectedId ? ' selected' : ''}>${esc(label(b))}</option>`;
  const active = items.filter((b) => !b.finished);
  const finished = items.filter((b) => b.finished);
  const group = (name, list) => (list.length ? `<optgroup label="${name}">${list.map(option).join('')}</optgroup>` : '');
  const picker = `<select class="picker" onchange="location.href=this.value">${group('Aktif / yaklaşan', active)}${group('Biten', finished)}</select>`;

  const b = items.find((x) => x.id === selectedId) ?? items[0];
  const act = `/config/broadcast?token=${t}&broadcast=${encodeURIComponent(b.id)}`;
  const privacyOptions = Object.entries(PRIVACY_LABELS)
    .map(([value, text]) => `<option value="${value}"${value === b.privacyStatus ? ' selected' : ''}>${text}</option>`).join('');
  const coverOptions = covers
    .map((c) => `<option value="${esc(c)}">${esc(shortPath(c))}</option>`).join('');
  const canEnd = ENDABLE_STATES.has(b.lifeCycleStatus);

  return `${head}
    ${picker}
    <p class="state">Durum: <strong>${esc(LIFECYCLE_LABELS[b.lifeCycleStatus] ?? b.lifeCycleStatus ?? 'Bilinmiyor')}</strong> · Görünürlük: <strong>${esc(PRIVACY_LABELS[b.privacyStatus] ?? b.privacyStatus ?? 'Bilinmiyor')}</strong></p>
    <form method="post" action="${esc(act)}">
      <input type="hidden" name="broadcastId" value="${esc(b.id)}">
      <p class="hint">Başlık (YouTube'da şu an yazan)</p>
      <input type="text" name="title" value="${esc(b.title)}" maxlength="${MAX_TITLE_LENGTH}">
      <p class="hint">Açıklama (YouTube'da şu an yazan)</p>
      <textarea name="description" maxlength="${MAX_DESCRIPTION_LENGTH}">${esc(b.description)}</textarea>
      <p class="hint">Görünürlük</p>
      <select name="privacy">${privacyOptions}</select>
      <p class="hint">Kapak — "Değiştirme" seçiliyse kapağa dokunulmaz${covers.length ? '' : ' (kapak adayı yok)'}</p>
      <select name="cover"><option value="">Değiştirme</option>${coverOptions}</select>
      <button class="primary" type="submit" name="action" value="apply">Bu Yayına Uygula</button>
    </form>
    ${canEnd ? `<form method="post" action="${esc(act)}" onsubmit="return confirm('Bu yayın BİTİRİLSİN mi? Geri alınamaz.')">
      <input type="hidden" name="broadcastId" value="${esc(b.id)}">
      <button class="danger" type="submit" name="action" value="end">Yayını Bitir</button>
    </form>` : ''}
    <p class="hint">Yalnızca değiştirdiğin alanlar YouTube'a gönderilir. Aşağıdaki "Sonraki Yayın" ayarları ise bir SONRAKİ canlıya almada oluşacak yeni yayın içindir.</p>
  </section>`;
}

// plan: StreamPlan — currentPlan() hiç null dönmez, form her zaman bir taslakla açılır.
// clips: string[] — ConfigApi#form()'dan (MediaLibrary.videos(), v1'de albüm taraması yok).
// token: URL'deki ?token= değeri — form action'ına aynen eklenir (POST da aynı şekilde
//   yetkilensin diye; gövdeden token okumak auth'tan ÖNCE gövdeyi okumayı gerektirirdi).
// notice/error: POST sonrası aynı sayfaya basılan sonuç mesajı.
function renderConfigPage({
  plan, clips, covers = [], token, notice = null, error = null, streamState = null,
  broadcasts = null, selectedId = null, pendingCover = null,
}) {
  const p = plan.pomodoro;
  // Seçili yayın URL'de taşınır: kaydet/yükle/başlat sonrası seçim bozulmasın.
  const keep = selectedId ? `&broadcast=${encodeURIComponent(selectedId)}` : '';
  const action = `/config?token=${encodeURIComponent(token)}${keep}`;
  const uploadAction = `/config/upload?token=${encodeURIComponent(token)}${keep}`;
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yayın Yapılandırması</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px 16px 48px; background: #1c0f17; color: #fbe6f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    max-width: 480px; margin-inline: auto;
  }
  h1 { font-size: 20px; margin: 4px 0 16px; color: #ffd3ea; }
  section { margin-bottom: 28px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: #e79fc4; margin: 0 0 10px; }
  .hint { font-size: 13px; color: #c98cae; margin: 4px 0 12px; }
  .row {
    display: flex; align-items: center; gap: 12px; padding: 12px 8px;
    border-bottom: 1px solid #3a2130; min-height: 44px;
  }
  .row input[type=checkbox], .row input[type=radio] { width: 22px; height: 22px; flex-shrink: 0; accent-color: #ec4899; }
  .row .thumb {
    width: 56px; height: 32px; object-fit: cover; border-radius: 4px;
    background: #2a1620; flex-shrink: 0;
  }
  .row span { overflow-wrap: anywhere; }
  .checklist { border: 1px solid #3a2130; border-radius: 8px; overflow: hidden; background: #241320; }
  input[type=text], textarea {
    width: 100%; padding: 12px; font-size: 16px; border-radius: 8px;
    border: 1px solid #4a2a3c; background: #241320; color: #fbe6f0;
    font-family: inherit;
  }
  textarea { min-height: 140px; resize: vertical; }
  button {
    width: 100%; padding: 14px; font-size: 16px; border-radius: 8px; border: none;
    margin-top: 10px; min-height: 44px;
  }
  .primary { background: #ec4899; color: #fff; font-weight: 600; }
  .secondary { background: #3a2130; color: #fbe6f0; }
  .danger { background: #7a1f3d; color: #fff; font-weight: 600; }
  button:disabled { opacity: .4; }
  .state { padding: 10px 12px; border-radius: 8px; background: #241320; border: 1px solid #3a2130; margin-bottom: 4px; }
  select { width: 100%; padding: 12px; font-size: 16px; border-radius: 8px; border: 1px solid #4a2a3c; background: #241320; color: #fbe6f0; margin-bottom: 8px; }
  .picker { border-color: #ec4899; }
  input[type=file] { width: 100%; padding: 10px 0; color: #fbe6f0; }
  .btnrow { display: flex; gap: 10px; }
  .btnrow form { flex: 1; margin: 0; }
  .muted { color: #c98cae; font-size: 14px; }
  .notice { background: #3a1430; border: 1px solid #d6459b; padding: 12px; border-radius: 8px; margin-bottom: 16px; }
  .error { background: #3a1420; border: 1px solid #c2447a; padding: 12px; border-radius: 8px; margin-bottom: 16px; }
</style>
</head>
<body>
<h1>Yayın Yapılandırması — ${esc(plan.name)}</h1>
${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
${error ? `<div class="error">${esc(error)}</div>` : ''}
${broadcastPicker({ broadcasts, selectedId, token, covers })}
${streamControls(streamState, action)}
<!-- Galeri yüklemesi: ana formun DIŞINDA (iç içe form olmaz); cover bölümündeki dosya
     alanı ve düğme form="coverUpload" ile buna bağlanır. -->
<form id="coverUpload" method="post" enctype="multipart/form-data" action="${esc(uploadAction)}"></form>
<form method="post" action="${esc(action)}">
  <section>
    <h2>Sonraki Yayın</h2>
    <p class="hint">Bu bölümün ayarları yeni oluşturulacak yayın içindir; yukarıda seçili yayına dokunmaz.</p>
    <h2>Yayın Başlığı</h2>
    <p class="hint">Boş bırakırsan config.json'daki başlık kullanılır. En fazla ${MAX_TITLE_LENGTH} karakter.</p>
    <input type="text" name="title" value="${esc((plan.broadcast?.title) ?? '')}" maxlength="${MAX_TITLE_LENGTH}" placeholder="Başlık">
  </section>

  <section>
    <h2>Açıklama</h2>
    <p class="hint">Boş bırakırsan config.json'daki açıklama kullanılır. Başlık ve açıklama yalnızca bir SONRAKİ canlıya almada oluşan yayına uygulanır — şu an açık olan yayına dokunulmaz.</p>
    <textarea name="description" maxlength="${MAX_DESCRIPTION_LENGTH}" placeholder="Açıklama">${esc((plan.broadcast?.description) ?? '')}</textarea>
  </section>

  <section>
    <h2>Kapak (Küçük Resim)</h2>
    <p class="hint">Tek seçim — bir sonraki canlıya almada yayının kapağı olur.</p>
    ${coverList(covers, pendingCover ?? plan.cover, token)}
    <p class="hint">Galeriden ekle (JPEG/PNG/WebP). Görsel 1280x720'ye kırpılıp küçültülür. Yüklemek sayfayı yeniler — önce yaptığın değişiklikleri Kaydet.</p>
    <input type="file" name="coverFile" accept="image/jpeg,image/png,image/webp" form="coverUpload" onchange="document.getElementById('coverUpload').submit()">
    <button class="secondary" type="submit" form="coverUpload">Yükle</button>
  </section>

  <section>
    <h2>Pomodoro</h2>
    <label class="row" for="pomodoroEnabled">
      <input type="checkbox" id="pomodoroEnabled" name="pomodoroEnabled" ${p.enabled ? 'checked' : ''}>
      <span>Açık</span>
    </label>
    <p class="hint">Süre: "<calisma>+<mola>" dakika (örn. 50+10, 30+10, 45+15)</p>
    <input type="text" name="pomodoroType" value="${esc(p.type)}" inputmode="text" placeholder="50+10">
  </section>

  <section>
    <h2>Çalışma Görselleri</h2>
    <p class="hint">Çoklu seçim — her çalışma session'ı havuzdan rastgele bir klip kullanır, ardışık iki session aynı klibi tekrarlamaz.</p>
    ${clipList('studyVideos', clips, p.studyVideos, token)}
  </section>

  <section>
    <h2>Mola Görselleri</h2>
    <p class="hint">Çoklu seçim — her mola session'ı havuzdan rastgele bir klip kullanır, ardışık iki session aynı klibi tekrarlamaz.</p>
    ${clipList('breakVideos', clips, p.breakVideos, token)}
  </section>

  <section class="muted">
    <p>Müzik seçimi bu sayfada yok — tüm kütüphane çalmaya devam eder. Albüm seçimi için sihirbazı kullanın (<code>npm run plan</code>).</p>
  </section>

  <button class="secondary" type="submit" name="action" value="save">Kaydet</button>
  <button class="primary" type="submit" name="action" value="save_restart">Kaydet ve Yeniden Başlat</button>
</form>
</body>
</html>`;
}

module.exports = { renderConfigPage, esc };
