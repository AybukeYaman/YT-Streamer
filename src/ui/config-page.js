// Mobil yapılandırma sayfası (Faz N2): saf fonksiyon, veri → HTML metni. fs/http YOK —
// bu yüzden kolayca test edilir (bkz. test/ui/config-page.test.js). HTML'i basan
// golive-server.js, veriyi hazırlayan ise src/application/config-api.js.
//
// Neden bu sayfa var: yayın VPS'te systemd altında çalışırken TUI sihirbazını SSH'sız
// kullanmanın tek yolu buydu (bkz. PLAN-yapilandirma-ui.md Faz N1 — --plan-only SSH
// gerektiriyor, bu sayfa SSH bile gerektirmiyor, telefondan tailscale üzerinden açılıyor).
//
// Yeniden tasarım (mobile-ux-redesign-plan.md): görev sırasına göre tek sayfa —
// "Şu an → YouTube'daki yayın → Sonraki yayın". Rotalar ve form alan adları DEĞİŞMEDİ
// (golive-server.js ve ConfigApi aynen çalışır); yalnızca sunum katmanı yenilendi.
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
// scope: aynı ad+değerin birden çok formda tekrarında (kapak) id çakışmasın.
function checkbox(name, value, checked, label, thumbSrc, type = 'checkbox', scope = '') {
  const id = `${scope}${name}-${esc(value).replace(/[^a-zA-Z0-9]/g, '_')}`;
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
    return checkbox('cover', c, c === selected, shortPath(c), thumbSrc, 'radio', 'p-');
  });
  const none = checkbox('cover', '', !selected, 'Varsayılan (config.json)', null, 'radio', 'p-');
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

// Katlanabilir bölüm (<details>): JS gerektirmez. Kapalıyken de içindeki alanlar forma
// dahildir ve GÖNDERİLİR (tarayıcı kapalı <details> içindeki kontrolleri atlamaz);
// summary'deki özet, kapalı bölümün durumunu gösterir.
function fold(title, summaryNote, bodyHtml, { open = false, cls = '' } = {}) {
  const note = summaryNote ? ` <span class="sumnote">· ${esc(summaryNote)}</span>` : '';
  return `<details class="fold${cls ? ` ${cls}` : ''}"${open ? ' open' : ''}><summary>${esc(title)}${note}</summary><div class="foldbody">${bodyHtml}</div></details>`;
}

const STATE_LABELS = { running: 'Çalışıyor', stopped: 'Durmuş', unknown: 'Bilinmiyor' };
const STATE_TONE = { running: 'ok', stopped: 'idle', unknown: 'warn' };
const dot = (tone) => `<span class="dot ${tone}" aria-hidden="true"></span>`;

// Ana yayın süreci (streamState null ise hiç çıkmaz: özellik opsiyonel). AYRI formlar:
// ana formun alanlarını (başlık, klipler…) göndermez, yani başlat/durdur ayarları kaydetmez.
// Tek BAĞLAMSAL düğme: çalışıyorsa yalnızca Durdur (onaylı — canlı yayını keser),
// durmuşsa yalnızca Başlat; durum bilinmiyorsa ikisi de (hangisinin doğru olduğu belli değil).
function streamControls(streamState, action) {
  if (!streamState) return '';
  const state = STATE_LABELS[streamState] ? streamState : 'unknown';
  const start = `<form method="post" action="${esc(action)}">
        <button class="${state === 'stopped' ? 'primary' : 'secondary'}" type="submit" name="action" value="start">Başlat</button>
      </form>`;
  const stop = `<form method="post" action="${esc(action)}" onsubmit="return confirm('Yayın durdurulsun mu? Canlı yayın kesilir.')">
        <button class="danger" type="submit" name="action" value="stop">Durdur</button>
      </form>`;
  const buttons = { running: stop, stopped: start, unknown: `${start}${stop}` }[state];
  return `<div class="card">
    <h3>Ana yayın</h3>
    <p class="state">${dot(STATE_TONE[state])}Durum: <strong>${esc(STATE_LABELS[state])}</strong></p>
    <div class="btnrow">
      ${buttons}
    </div>
    ${state === 'running' ? '' : '<p class="hint">Başlattıktan 30-60 sn sonra canlıya almak için go-live tetikle (Shortcuts).</p>'}
  </div>`;
}

const PRIVACY_LABELS = { public: 'Herkese açık', unlisted: 'Liste dışı', private: 'Gizli' };
const LIFECYCLE_LABELS = {
  created: 'Oluşturuldu', ready: 'Hazır', testing: 'Test', liveStarting: 'Canlıya geçiyor',
  live: 'Canlı', complete: 'Bitti', revoked: 'İptal edildi',
};

const ENDABLE_STATES = new Set(['live', 'testing', 'liveStarting']);

// Sunucu UTC'de çalışır; kullanıcı Türkiye saatiyle okur. Geçersiz/eksik tarih sessizce boş.
const DISPLAY_TZ = 'Europe/Istanbul';
const dateFormat = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: DISPLAY_TZ,
});
function formatStart(iso) {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? dateFormat.format(date) : '';
}

const shorten = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// Yayın küçük resmi: YouTube'un kendi CDN'inden (i.ytimg.com). Yalnızca https ve ytimg.com
// adresleri kabul edilir: API yanıtı beklenmedik bir şey içerse bile sayfaya rastgele adres
// (http, javascript:, başka alan adı) girmez. Yüklenemezse (ağ/silinmiş) sessizce gizlenir.
const SAFE_THUMB = /^https:\/\/[a-z0-9.-]+\.ytimg\.com\//i;

function broadcastThumb(url) {
  return SAFE_THUMB.test(String(url ?? ''))
    ? `<img class="thumb" src="${esc(url)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : '<span class="thumb"></span>';
}

// Özel açılır menü satırı. Neden <select> değil: tarayıcıların yerel menüsü (özellikle
// telefonda) seçenek içine resim koymaya izin vermez. <details> + bağlantı satırları JS
// gerektirmez; her satır düz bir GET bağlantısı (seçim URL'de: ?broadcast=<id>), açılıp
// kapanma <details>'in işi. tag='summary': menünün kapalı halinde görünen (seçili) satır.
function pickRow(href, thumbHtml, text, { selected = false, tag = 'a' } = {}) {
  const attrs = tag === 'a' ? ` href="${esc(href)}"` : '';
  return `<${tag} class="pickrow${selected ? ' sel' : ''}"${attrs}>${thumbHtml}<span>${esc(text)}</span></${tag}>`;
}

const dropdown = (summaryRow, rowsHtml) => `<details class="dd">${summaryRow}<div class="picklist">${rowsHtml}</div></details>`;

const privacySelect = (id, current) => `<select id="${id}" name="privacy">${Object.entries(PRIVACY_LABELS)
  .map(([value, text]) => `<option value="${value}"${value === current ? ' selected' : ''}>${text}</option>`).join('')}</select>`;

// Yayın seçici + seçili yayının işlem paneli. YouTube'daki VAR OLAN yayınlar üzerinde çalışır
// (plandaki "sonraki yayın" ayarlarından ayrı). broadcasts: { items } | { error: true } | null.
//   - null ve canCreate yok: özellik kapalı → bölüm hiç çıkmaz.
//   - { error }: YouTube listesi okunamadı → kısa not, sayfanın geri kalanı çalışır.
// İşlem formları ana plan formundan AYRI (iç içe form olmaz, planı kaydetmez).
// canCreate: "+ Yeni yayın" satırı (eşzamanlı ikinci yayın kurma formu, ?new=1).
function broadcastPicker({
  broadcasts, selectedId, token, covers, canCreate = false, newMode = false, newFormHtml = '',
}) {
  if (!broadcasts && !canCreate) return '';
  const head = '<section>\n    <h2>YouTube\'daki yayın</h2>';
  const t = encodeURIComponent(token);
  const NEW_TEXT = '+ Yeni yayın aç…';
  const newRow = canCreate
    ? pickRow(`/config?token=${t}&new=1`, '<span class="thumb"></span>', NEW_TEXT, { selected: newMode })
    : '';

  const items = broadcasts?.items ?? [];
  // Liste yok/boş/hata: yine de "+ Yeni yayın" seçilebilsin diye tek satırlı menü.
  if (!items.length) {
    const note = broadcasts?.error
      ? 'Yayın listesi şu an okunamadı (YouTube\'a ulaşılamadı).'
      : 'Kanalda henüz yayın yok. Canlıya alınca burada görünür.';
    if (!canCreate) return `${head}\n    <p class="muted">${note}</p>\n  </section>`;
    const summary = newMode
      ? pickRow(null, '<span class="thumb"></span>', NEW_TEXT, { tag: 'summary' })
      : pickRow(null, '<span class="thumb"></span>', 'Yayın yok', { tag: 'summary' });
    return `${head}
    ${dropdown(summary, newRow)}
    ${newMode ? newFormHtml : `<p class="muted">${note}</p>`}
  </section>`;
  }

  const label = (b) => [
    `${b.lifeCycleStatus === 'live' ? '● ' : ''}${shorten(b.title, 40)}`,
    LIFECYCLE_LABELS[b.lifeCycleStatus] ?? b.lifeCycleStatus ?? '?',
    PRIVACY_LABELS[b.privacyStatus] ?? b.privacyStatus ?? '?',
    formatStart(b.startAt),
  ].filter(Boolean).join(' · ');
  const row = (b) => pickRow(
    `/config?token=${t}&broadcast=${encodeURIComponent(b.id)}`,
    broadcastThumb(b.thumbnailUrl),
    label(b),
    { selected: !newMode && b.id === selectedId },
  );
  const active = items.filter((b) => !b.finished);
  const finished = items.filter((b) => b.finished);
  const group = (name, list) => (list.length ? `<p class="pickgroup">${name}</p>${list.map(row).join('')}` : '');
  const current = items.find((b) => b.id === selectedId) ?? items[0];
  const summary = newMode
    ? pickRow(null, '<span class="thumb"></span>', NEW_TEXT, { tag: 'summary' })
    : pickRow(null, broadcastThumb(current.thumbnailUrl), label(current), { tag: 'summary' });
  const picker = dropdown(summary, `${newRow}${group('Aktif / yaklaşan', active)}${group('Biten', finished)}`);

  if (newMode) return `${head}\n    ${picker}\n    ${newFormHtml}\n  </section>`;

  const b = items.find((x) => x.id === selectedId) ?? items[0];
  const act = `/config/broadcast?token=${t}&broadcast=${encodeURIComponent(b.id)}`;
  const coverOptions = covers
    .map((c) => `<option value="${esc(c)}">${esc(shortPath(c))}</option>`).join('');
  const canEnd = ENDABLE_STATES.has(b.lifeCycleStatus);
  const tone = b.lifeCycleStatus === 'live' ? 'ok' : (b.finished ? 'idle' : 'warn');
  const detailsBody = `
        <label class="lbl" for="b-desc">Açıklama</label>
        <textarea name="description" id="b-desc" maxlength="${MAX_DESCRIPTION_LENGTH}">${esc(b.description)}</textarea>
        <label class="lbl" for="b-cover">Kapak</label>
        <p class="hint">"Değiştirme" seçiliyse kapağa dokunulmaz${covers.length ? '' : ' (kapak adayı yok)'}</p>
        <select id="b-cover" name="cover"><option value="">Değiştirme</option>${coverOptions}</select>`;

  return `${head}
    ${picker}
    <p class="state">${dot(tone)}Durum: <strong>${esc(LIFECYCLE_LABELS[b.lifeCycleStatus] ?? b.lifeCycleStatus ?? 'Bilinmiyor')}</strong> · Görünürlük: <strong>${esc(PRIVACY_LABELS[b.privacyStatus] ?? b.privacyStatus ?? 'Bilinmiyor')}</strong>${formatStart(b.startAt) ? ` · ${b.started ? 'Başladı' : 'Planlanan'}: <strong>${esc(formatStart(b.startAt))}</strong>` : ''}</p>
    <form method="post" action="${esc(act)}">
      <input type="hidden" name="broadcastId" value="${esc(b.id)}">
      <label class="lbl" for="b-title">Başlık</label>
      <input type="text" id="b-title" name="title" value="${esc(b.title)}" maxlength="${MAX_TITLE_LENGTH}">
      <label class="lbl" for="b-privacy">Görünürlük</label>
      ${privacySelect('b-privacy', b.privacyStatus)}
      ${fold('Açıklama ve kapak', `açıklama ${b.description.length} karakter`, detailsBody)}
      <button class="primary" type="submit" name="action" value="apply">Bu Yayına Uygula</button>
      <p class="hint">Yalnızca değiştirdiğin alanlar YouTube'a gönderilir. "Sonraki yayın" ayarlarından bağımsızdır.</p>
    </form>
    ${canEnd ? fold('Yayını bitir…', null, `<p class="hint">Yayını YouTube'da sonlandırır; geri alınamaz.</p>
        <form method="post" action="${esc(act)}" onsubmit="return confirm('Bu yayın BİTİRİLSİN mi? Geri alınamaz.')">
          <input type="hidden" name="broadcastId" value="${esc(b.id)}">
          <button class="danger" type="submit" name="action" value="end">Yayını Bitir</button>
        </form>`, { cls: 'dangerzone' }) : ''}
  </section>`;
}

// "+ Yeni yayın aç…" formu: ikinci (eşzamanlı) yayını sunucuda kurar. draft: hata sonrası
// girdiler korunsun diye önceki form değerleri. albums: katalog [{ name, trackCount, backgrounds }].
// Albüm seçimi boşsa tüm kütüphane çalar (mevcut davranış). Pomodoro klipleri kapalı açılır:
// ölçümde klip girişleri CPU'yu ~2x yapıyor, ikinci yayını hafif tutmak için.
function newStreamForm({
  token, covers, albums, draft = {}, keep = '',
}) {
  const t = encodeURIComponent(token);
  const chosen = new Set(draft.albums ?? []);
  const privacy = draft.privacy || 'unlisted';
  const coverOptions = covers
    .map((c) => `<option value="${esc(c)}"${c === draft.cover ? ' selected' : ''}>${esc(shortPath(c))}</option>`).join('');
  const albumRows = albums.length
    ? `<div class="checklist">${albums.map((a) => {
      const thumb = a.backgrounds[0]
        ? `/config/thumb?token=${t}&file=${encodeURIComponent(a.backgrounds[0])}`
        : null;
      return checkbox('albums', a.name, chosen.has(a.name), `${a.name} · ${a.trackCount} parça`, thumb, 'checkbox', 'n-');
    }).join('')}</div>`
    : '<p class="muted">Albüm bulunamadı — boş bırakırsan kütüphanedeki her şey çalar.</p>';
  const chosenCount = chosen.size;
  const advancedBody = `
      <label class="lbl" for="n-cover">Kapak</label>
      <select id="n-cover" name="cover"><option value="">Varsayılan</option>${coverOptions}</select>
      <p class="lbl">Hangi albümler çalsın?</p>
      <p class="hint">Müzik + arkaplan; boş bırakırsan kütüphanedeki her şey çalar.</p>
      ${albumRows}`;

  return `<form method="post" action="${esc(`/config/new?token=${t}${keep}`)}">
      <p class="hint">Aynı anda ikinci bir yayın açar: YouTube'da yeni bir yayın anahtarı oluşturulur ve sunucuda ayrı bir yayın süreci kurulur. Sunucu CPU'su en fazla birkaç yayına yeter; doluysa reddedilir.</p>
      <label class="lbl" for="n-name">Yayın adı</label>
      <p class="hint">Sunucudaki ad: küçük harf, rakam, - _</p>
      <input type="text" id="n-name" name="name" value="${esc(draft.name ?? '')}" maxlength="20" placeholder="lofi2" autocapitalize="none" autocorrect="off">
      <label class="lbl" for="n-title">Başlık</label>
      <input type="text" id="n-title" name="title" value="${esc(draft.title ?? '')}" maxlength="${MAX_TITLE_LENGTH}" placeholder="Başlık">
      <label class="lbl" for="n-desc">Açıklama</label>
      <textarea name="description" id="n-desc" maxlength="${MAX_DESCRIPTION_LENGTH}" placeholder="Açıklama">${esc(draft.description ?? '')}</textarea>
      <label class="lbl" for="n-privacy">Görünürlük</label>
      ${privacySelect('n-privacy', privacy)}
      ${fold('Kapak ve albümler', chosenCount ? `${chosenCount} albüm seçili` : 'tüm kütüphane çalar', advancedBody, { open: Boolean(chosenCount || draft.cover) })}
      <label class="row" for="goLiveNow">
        <input type="checkbox" id="goLiveNow" name="goLiveNow" ${draft.goLiveNow === false ? '' : 'checked'}>
        <span>Kurulunca otomatik canlıya al</span>
      </label>
      <button class="primary" type="submit" onclick="this.disabled=true;this.form.submit()">Yayını Kur ve Başlat</button>
    </form>`;
}

// Kurulu ek yayınlar: durum + başlat/durdur/canlıya al. Ana yayın burada YOK (kendi bölümü var).
// Her kartta TEK bağlamsal ana düğme; geri kalan geçerli işlem "Diğer işlemler" altında:
//   durmuş/bilinmiyor → Başlat (Durdur diğer işlemlerde, bilinmiyorken); çalışıyor → Canlıya Al
//   (Durdur diğer işlemlerde). Eskiden pasif görünen (çalışırken Başlat, durmuşken Canlıya Al/
//   Durdur) düğmeler artık hiç çizilmez — o durumlarda sunucuda da anlamsızdı.
function instancesSection(instances, token) {
  if (!instances || !instances.length) return '';
  const t = encodeURIComponent(token);
  const btn = (name, a) => {
    const text = { start: 'Başlat', golive: 'Canlıya Al', stop: 'Durdur' }[a];
    const confirmAttr = a === 'stop' ? ' onsubmit="return confirm(\'Bu yayın durdurulsun mu?\')"' : '';
    const cls = { start: 'primary', golive: 'primary', stop: 'danger' }[a];
    return `<form method="post" action="${esc(`/config/instance?token=${t}`)}"${confirmAttr}>
          <input type="hidden" name="name" value="${esc(name)}">
          <button class="${cls}" type="submit" name="action" value="${a}">${text}</button>
        </form>`;
  };
  const rows = instances.map((i) => {
    const state = STATE_LABELS[i.state] ? i.state : 'unknown';
    const main = state === 'running' ? 'golive' : 'start';
    const extra = state === 'stopped' ? '' : fold('Diğer işlemler', null, btn(i.name, 'stop'), { cls: 'more' });
    return `<div class="card">
      <p class="state">${dot(STATE_TONE[state])}<strong>${esc(i.name)}</strong> · ${esc(STATE_LABELS[state])}</p>
      <div class="btnrow">
        ${btn(i.name, main)}
      </div>
      ${extra}
    </div>`;
  }).join('');
  return `<h3>Ek yayınlar</h3>
    ${rows}`;
}

const STYLE = `
  :root {
    color-scheme: dark;
    --bg: #1c0f17; --surface: #241320; --surface-2: #2e1a28; --line: #3a2130;
    --border-strong: #9d5b80; --text: #fbe6f0; --muted: #c98cae; --head: #ffd3ea;
    --accent: #ec4899; --accent-strong: #be185d; --focus: #f472b6;
    --danger: #7a1f3d; --danger-edge: #e0699f; --ok: #34d399; --warn: #fbbf24; --idle: #a38a99;
    --radius: 12px; --tap: 48px;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; padding: 16px 16px 48px; background: var(--bg); color: var(--text);
    font: 16px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    max-width: 480px; margin-inline: auto;
  }
  header { margin: 4px 0 20px; }
  h1 { font-size: 22px; line-height: 1.2; margin: 0 0 4px; color: var(--head); }
  .sub { margin: 0; color: var(--muted); font-size: 14px; }
  section { margin-bottom: 28px; }
  h2 { font-size: 17px; font-weight: 600; margin: 0 0 12px; color: var(--head); }
  h3 { font-size: 14px; font-weight: 600; margin: 18px 0 8px; color: #f3b7d6; }
  .card h3 { margin-top: 0; }
  .lbl { display: block; font-size: 14px; font-weight: 600; margin: 14px 0 6px; }
  .hint { font-size: 13px; color: var(--muted); margin: 4px 0 10px; }
  .muted { color: var(--muted); font-size: 14px; }
  .row {
    display: flex; align-items: center; gap: 12px; padding: 12px 8px;
    border-bottom: 1px solid var(--line); min-height: var(--tap);
  }
  .row input[type=checkbox], .row input[type=radio] { width: 22px; height: 22px; flex-shrink: 0; accent-color: var(--accent); }
  .row .thumb {
    width: 56px; height: 32px; object-fit: cover; border-radius: 4px;
    background: var(--surface-2); flex-shrink: 0;
  }
  .row span { overflow-wrap: anywhere; }
  .checklist { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--surface); }
  input[type=text], textarea, select {
    width: 100%; padding: 12px; font-size: 16px; border-radius: 8px; min-height: var(--tap);
    border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
    font-family: inherit;
  }
  textarea { min-height: 140px; resize: vertical; }
  select { margin-bottom: 8px; }
  :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  button {
    width: 100%; padding: 12px 16px; font: inherit; font-weight: 600; border-radius: 10px;
    border: 1px solid transparent; margin-top: 10px; min-height: var(--tap); cursor: pointer; color: var(--text);
  }
  .primary { background: var(--accent-strong); color: #fff; }
  .secondary { background: transparent; border-color: var(--border-strong); color: var(--text); }
  .danger { background: var(--danger); border-color: var(--danger-edge); color: #fff; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .card, .state { padding: 12px; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--line); }
  .card { margin-bottom: 10px; }
  .card .state { padding: 0; border: 0; background: none; margin: 0 0 4px; }
  .state { margin: 0 0 8px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; background: var(--idle); }
  .dot.ok { background: var(--ok); }
  .dot.warn { background: var(--warn); }
  .btnrow { display: flex; gap: 10px; }
  .btnrow form { flex: 1; margin: 0; }
  .fold { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); margin: 14px 0 4px; }
  .fold > summary {
    list-style: none; cursor: pointer; padding: 12px; min-height: var(--tap);
    display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 15px;
  }
  .fold > summary::-webkit-details-marker { display: none; }
  .fold > summary::after { content: '▾'; margin-left: auto; color: var(--muted); }
  .fold[open] > summary::after { content: '▴'; }
  .sumnote { font-weight: 400; color: var(--muted); font-size: 13px; }
  .foldbody { padding: 0 12px 12px; }
  .fold.more { border: 0; background: none; margin: 6px 0 0; }
  .fold.more > summary { padding: 8px 4px; min-height: var(--tap); font-size: 14px; color: var(--muted); font-weight: 400; }
  .fold.dangerzone { border-color: var(--danger-edge); margin-top: 18px; }
  .dd { border: 1px solid var(--accent); border-radius: 8px; background: var(--surface); margin-bottom: 10px; overflow: hidden; }
  .dd summary { list-style: none; cursor: pointer; }
  .dd summary::-webkit-details-marker { display: none; }
  .dd summary::after { content: '▾'; margin-left: auto; color: var(--muted); padding-left: 8px; }
  .dd[open] summary::after { content: '▴'; }
  .picklist { border-top: 1px solid var(--line); max-height: 60vh; overflow-y: auto; }
  .pickrow { display: flex; align-items: center; gap: 12px; padding: 10px 12px; min-height: 52px; color: var(--text); text-decoration: none; }
  .picklist .pickrow { border-bottom: 1px solid var(--line); }
  .pickrow.sel { background: #3a1430; }
  .pickrow span:not(.thumb) { overflow-wrap: anywhere; flex: 1; font-size: 15px; }
  .pickrow .thumb { width: 64px; height: 36px; object-fit: cover; border-radius: 4px; background: var(--surface-2); flex-shrink: 0; display: inline-block; }
  .pickgroup { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0; padding: 8px 12px; background: var(--bg); }
  input[type=file] { width: 100%; padding: 10px 0; color: var(--text); }
  .notice { background: #3a1430; border: 1px solid #d6459b; padding: 12px; border-radius: var(--radius); margin-bottom: 16px; }
  .error { background: #3a1420; border: 1px solid #e0699f; padding: 12px; border-radius: var(--radius); margin-bottom: 16px; }
  .savebar { margin-top: 8px; }
  .newlink {
    display: flex; align-items: center; justify-content: center; min-height: var(--tap);
    border: 1px solid var(--border-strong); border-radius: 10px; color: var(--text);
    text-decoration: none; font-weight: 600;
  }
`;

// plan: StreamPlan — currentPlan() hiç null dönmez, form her zaman bir taslakla açılır.
// clips: string[] — ConfigApi#form()'dan (MediaLibrary.videos(), v1'de albüm taraması yok).
// token: URL'deki ?token= değeri — form action'ına aynen eklenir (POST da aynı şekilde
//   yetkilensin diye; gövdeden token okumak auth'tan ÖNCE gövdeyi okumayı gerektirirdi).
// notice/error: POST sonrası aynı sayfaya basılan sonuç mesajı.
function renderConfigPage({
  plan, clips, covers = [], token, notice = null, error = null, streamState = null,
  broadcasts = null, selectedId = null, pendingCover = null,
  canCreate = false, newMode = false, draft = {}, catalogAlbums = [], instances = null,
}) {
  const p = plan.pomodoro;
  // Seçili yayın URL'de taşınır: kaydet/yükle/başlat sonrası seçim bozulmasın.
  const keep = selectedId ? `&broadcast=${encodeURIComponent(selectedId)}` : '';
  const action = `/config?token=${encodeURIComponent(token)}${keep}`;
  const uploadAction = `/config/upload?token=${encodeURIComponent(token)}${keep}`;
  const nowSection = streamControls(streamState, action) + instancesSection(instances, token);
  const musicNote = plan.usesWholeLibrary
    ? 'Müzik: kütüphanedeki tüm parçalar çalıyor.'
    : `Müzik: ${plan.selectedTrackCount} parça seçili (bu sayfadan değiştirilmez).`;
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yayın Yönetimi</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>Yayın Yönetimi</h1>
  <p class="sub">Plan: ${esc(plan.name)}</p>
</header>
${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
${error ? `<div class="error">${esc(error)}</div>` : ''}
${nowSection ? `<section>
  <h2>Şu an</h2>
  ${nowSection}
</section>` : ''}
${broadcastPicker({
  broadcasts, selectedId, token, covers, canCreate, newMode, newFormHtml: newMode ? newStreamForm({ token, covers, albums: catalogAlbums, draft }) : '',
})}
<!-- Galeri yüklemesi: ana formun DIŞINDA (iç içe form olmaz); cover bölümündeki dosya
     alanı ve düğme form="coverUpload" ile buna bağlanır. -->
<form id="coverUpload" method="post" enctype="multipart/form-data" action="${esc(uploadAction)}"></form>
<form id="planForm" method="post" action="${esc(action)}">
  <section>
    <h2>Sonraki yayın</h2>
    <p class="hint">Bir SONRAKİ canlıya almada oluşacak yayın içindir; yukarıda seçili yayına dokunmaz. Boş bıraktığın alan için config.json'daki değer kullanılır.</p>

    <label class="lbl" for="p-title">Başlık</label>
    <input type="text" id="p-title" name="title" value="${esc((plan.broadcast?.title) ?? '')}" maxlength="${MAX_TITLE_LENGTH}" placeholder="Başlık">

    ${fold('Açıklama', (plan.broadcast?.description) ? `${plan.broadcast.description.length} karakter` : 'config.json\'daki', `
      <label class="lbl" for="p-desc">Açıklama</label>
      <p class="hint">En fazla ${MAX_DESCRIPTION_LENGTH} karakter.</p>
      <textarea name="description" id="p-desc" maxlength="${MAX_DESCRIPTION_LENGTH}" placeholder="Açıklama">${esc((plan.broadcast?.description) ?? '')}</textarea>`)}

    <h3>Kapak (küçük resim)</h3>
    <p class="hint">Tek seçim — bir sonraki canlıya almada yayının kapağı olur.</p>
    ${coverList(covers, pendingCover ?? plan.cover, token)}
    <p class="hint">Galeriden ekle (JPEG/PNG/WebP): görsel 1280x720'ye kırpılıp küçültülür. Yüklemek sayfayı yeniler — önce yaptığın değişiklikleri Kaydet.</p>
    <label class="lbl" for="coverFile">Galeriden görsel seç</label>
    <input type="file" id="coverFile" name="coverFile" accept="image/jpeg,image/png,image/webp" form="coverUpload" onchange="document.getElementById('coverUpload').submit()">
    <button class="secondary" type="submit" form="coverUpload">Yükle</button>

    <h3>Pomodoro</h3>
    <label class="row" for="pomodoroEnabled">
      <input type="checkbox" id="pomodoroEnabled" name="pomodoroEnabled" ${p.enabled ? 'checked' : ''}>
      <span>Açık</span>
    </label>
    <label class="lbl" for="pomodoroType">Süre</label>
    <p class="hint">"&lt;çalışma&gt;+&lt;mola&gt;" dakika (örn. 50+10, 30+10, 45+15)</p>
    <input type="text" id="pomodoroType" name="pomodoroType" value="${esc(p.type)}" inputmode="text" placeholder="50+10">

    ${fold('Çalışma görselleri', `${p.studyVideos.length} seçili`, `
      <p class="hint">Çoklu seçim — her çalışma session'ı havuzdan rastgele bir klip kullanır, ardışık iki session aynı klibi tekrarlamaz.</p>
      ${clipList('studyVideos', clips, p.studyVideos, token)}`)}
    ${fold('Mola görselleri', `${p.breakVideos.length} seçili`, `
      <p class="hint">Çoklu seçim — her mola session'ı havuzdan rastgele bir klip kullanır, ardışık iki session aynı klibi tekrarlamaz.</p>
      ${clipList('breakVideos', clips, p.breakVideos, token)}`)}

    <p class="muted">${esc(musicNote)}</p>
  </section>

  <div class="savebar">
    <button class="primary" type="submit" name="action" value="save">Kaydet</button>
    <button class="secondary" type="submit" name="action" value="save_restart">Kaydet ve Yeniden Başlat</button>
  </div>
</form>
${canCreate && !newMode ? `<section>
  <a class="newlink" href="${esc(`/config?token=${encodeURIComponent(token)}&new=1`)}">+ Eşzamanlı yeni yayın aç…</a>
</section>` : ''}
</body>
</html>`;
}

module.exports = { renderConfigPage, esc };
