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

const thumbUrl = (token, file) => `/config/thumb?token=${encodeURIComponent(token)}&file=${encodeURIComponent(file)}`;

// Seçilebilir küçük resim kartı (radyo ya da onay kutusu). Giriş gerçek bir <input>:
// klavye/ekran okuyucu çalışır; görsel olarak gizlenir, seçili durum kenarlık + ✓ ile
// gösterilir (yalnızca renge bağlı değil). thumbSrc yoksa yazılı yer tutucu çıkar.
function tile(name, value, checked, label, thumbSrc, type, scope, placeholder = '—') {
  const id = `${scope}${name}-${esc(value).replace(/[^a-zA-Z0-9]/g, '_')}`;
  const thumb = thumbSrc
    ? `<img class="thumb" src="${esc(thumbSrc)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<span class="ph" aria-hidden="true">${esc(placeholder)}</span>`;
  return `<label class="tile" for="${id}"><input type="${type}" id="${id}" name="${esc(name)}" value="${esc(value)}"${checked ? ' checked' : ''} class="tin"><span class="tw">${thumb}</span><span class="tn">${esc(label)}</span></label>`;
}

// Kapak: tek seçim (radyo kartları). İlk kart "varsayılan/değiştirme" (value=""). Plandaki kapak
// listede yoksa (elle yazılmış yol) ek kart olarak gösterilir (keepUnknown), böylece kaydedince
// sessizce kaybolmaz.
function coverGrid({
  covers, selected, token, scope, noneLabel, keepUnknown = false,
}) {
  const known = keepUnknown && selected && !covers.includes(selected) ? [selected, ...covers] : covers;
  const current = known.includes(selected) ? selected : '';
  const none = tile('cover', '', current === '', noneLabel, null, 'radio', scope);
  const rows = known.map((c) => tile('cover', c, c === current, shortPath(c), thumbUrl(token, c), 'radio', scope));
  return `<div class="tilegrid">${none}${rows.join('')}</div>`;
}

function clipGrid(name, clips, selected, token) {
  if (!clips.length) return '<p class="muted">Klip bulunamadı — albüm arkaplanı ya da assets/ altına video ekleyin.</p>';
  const set = new Set(selected);
  return `<div class="tilegrid two">${clips.map((c) => tile(name, c, set.has(c), shortPath(c), thumbUrl(token, c), 'checkbox', '')).join('')}</div>`;
}

// Katlanabilir bölüm (<details>): JS gerektirmez. Kapalıyken de içindeki alanlar forma
// dahildir ve GÖNDERİLİR (tarayıcı kapalı <details> içindeki kontrolleri atlamaz);
// summary'deki özet, kapalı bölümün durumunu gösterir. countFor: özetteki "N seçili"
// yazısı, o adlı işaretli kutuların sayısını (JS varsa) canlı tutar.
function fold(title, summaryNote, bodyHtml, { open = false, cls = '', countFor = '' } = {}) {
  const attr = countFor ? ` data-count-for="${esc(countFor)}"` : '';
  const note = summaryNote ? ` <span class="sumnote"${attr}>· ${esc(summaryNote)}</span>` : '';
  return `<details class="fold${cls ? ` ${cls}` : ''}"${open ? ' open' : ''}><summary>${esc(title)}${note}</summary><div class="foldbody">${bodyHtml}</div></details>`;
}

// Bölmeli seçim (segmented control): az sayıda seçenek tek bakışta, tek dokunuşla. Gerçek
// radyo girişleri: form alanı adı/değeri önceki <select> ile AYNI (name="privacy" value="public"…).
function segmented({
  id, name, label, options, current,
}) {
  const items = options.map(([value, text]) => {
    const oid = `${id}-${value}`;
    return `<input type="radio" id="${oid}" name="${esc(name)}" value="${esc(value)}"${value === current ? ' checked' : ''}><label for="${oid}">${esc(text)}</label>`;
  }).join('');
  return `<p class="lbl" id="${id}-l">${esc(label)}</p>
      <div class="seg" role="radiogroup" aria-labelledby="${id}-l">${items}</div>`;
}

// Aç/kapa anahtarı: gerçek onay kutusu (name/değer aynı), yalnızca görünümü anahtar.
function switchInput(id, name, checked, text) {
  return `<input type="checkbox" id="${id}" name="${name}"${checked ? ' checked' : ''} class="sw"><label for="${id}" class="swl"><span class="track" aria-hidden="true"></span><span>${esc(text)}</span></label>`;
}

// Pomodoro süre kısayolları. Sunucu her "<çalışma>+<mola>" biçimini kabul eder; "Özel" metin
// alanını açar, bu yüzden kısayol listesi hiçbir değeri kısıtlamaz.
const POMO_PRESETS = ['50+10', '30+10', '45+15'];

const STATE_LABELS ={ running: 'Çalışıyor', stopped: 'Durmuş', unknown: 'Bilinmiyor' };
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

const privacyControl = (id, current) => segmented({
  id, name: 'privacy', label: 'Görünürlük', options: Object.entries(PRIVACY_LABELS), current,
});

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
  const canEnd = ENDABLE_STATES.has(b.lifeCycleStatus);
  const tone = b.lifeCycleStatus === 'live' ? 'ok' : (b.finished ? 'idle' : 'warn');
  const detailsBody = `
        <label class="lbl" for="b-desc">Açıklama</label>
        <textarea name="description" id="b-desc" maxlength="${MAX_DESCRIPTION_LENGTH}">${esc(b.description)}</textarea>
        <p class="lbl">Kapak</p>
        <p class="hint">"Değiştirme" seçiliyse kapağa dokunulmaz${covers.length ? '' : ' (kapak adayı yok)'}</p>
        ${coverGrid({
    covers, selected: '', token, scope: 'b-', noneLabel: 'Değiştirme',
  })}`;

  return `${head}
    ${picker}
    <p class="state">${dot(tone)}Durum: <strong>${esc(LIFECYCLE_LABELS[b.lifeCycleStatus] ?? b.lifeCycleStatus ?? 'Bilinmiyor')}</strong> · Görünürlük: <strong>${esc(PRIVACY_LABELS[b.privacyStatus] ?? b.privacyStatus ?? 'Bilinmiyor')}</strong>${formatStart(b.startAt) ? ` · ${b.started ? 'Başladı' : 'Planlanan'}: <strong>${esc(formatStart(b.startAt))}</strong>` : ''}</p>
    <form method="post" action="${esc(act)}" data-guard>
      <input type="hidden" name="broadcastId" value="${esc(b.id)}">
      <label class="lbl" for="b-title">Başlık</label>
      <input type="text" id="b-title" name="title" value="${esc(b.title)}" maxlength="${MAX_TITLE_LENGTH}">
      ${privacyControl('b-privacy', b.privacyStatus)}
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
      <p class="lbl">Kapak</p>
      ${coverGrid({
    covers, selected: draft.cover ?? '', token, scope: 'n-', noneLabel: 'Varsayılan',
  })}
      <p class="lbl">Hangi albümler çalsın?</p>
      <p class="hint">Müzik + arkaplan; boş bırakırsan kütüphanedeki her şey çalar.</p>
      ${albumRows}`;

  return `<form method="post" action="${esc(`/config/new?token=${t}${keep}`)}" data-guard>
      <p class="hint">Aynı anda ikinci bir yayın açar: YouTube'da yeni bir yayın anahtarı oluşturulur ve sunucuda ayrı bir yayın süreci kurulur. Sunucu CPU'su en fazla birkaç yayına yeter; doluysa reddedilir.</p>
      <label class="lbl" for="n-name">Yayın adı</label>
      <p class="hint">Sunucudaki ad: küçük harf, rakam, - _</p>
      <input type="text" id="n-name" name="name" value="${esc(draft.name ?? '')}" maxlength="20" placeholder="lofi2" autocapitalize="none" autocorrect="off">
      <label class="lbl" for="n-title">Başlık</label>
      <input type="text" id="n-title" name="title" value="${esc(draft.title ?? '')}" maxlength="${MAX_TITLE_LENGTH}" placeholder="Başlık">
      <label class="lbl" for="n-desc">Açıklama</label>
      <textarea name="description" id="n-desc" maxlength="${MAX_DESCRIPTION_LENGTH}" placeholder="Açıklama">${esc(draft.description ?? '')}</textarea>
      ${privacyControl('n-privacy', privacy)}
      ${fold('Kapak ve albümler', chosenCount ? `${chosenCount} albüm seçili` : 'tüm kütüphane çalar', advancedBody, { open: Boolean(chosenCount || draft.cover) })}
      <div class="switchrow">${switchInput('goLiveNow', 'goLiveNow', draft.goLiveNow !== false, 'Kurulunca otomatik canlıya al')}</div>
      <button class="primary" type="submit" data-busy="Yayın kuruluyor (birkaç sn sürebilir)…">Yayını Kur ve Başlat</button>
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

  /* Bölmeli seçim (segmented): gerçek radyo girişleri, yalnızca görünüm */
  .seg { display: flex; position: relative; border: 1px solid var(--border-strong); border-radius: 10px; overflow: hidden; background: var(--surface); margin-bottom: 8px; }
  .seg input { position: absolute; opacity: 0; pointer-events: none; }
  .seg label, .seg button {
    flex: 1; display: flex; align-items: center; justify-content: center; text-align: center;
    min-height: var(--tap); padding: 8px 4px; margin: 0; width: auto; font-size: 14px; font-weight: 600;
    cursor: pointer; border: 0; border-left: 1px solid var(--line); border-radius: 0; background: transparent; color: var(--text);
  }
  .seg > :first-child, .seg > input + label:first-of-type { border-left: 0; }
  .seg input:checked + label, .seg button[aria-pressed=true] { background: var(--accent-strong); color: #fff; }
  .seg input:checked + label::before, .seg button[aria-pressed=true]::before { content: '✓ '; white-space: pre; }
  .seg input:focus-visible + label { outline: 3px solid var(--focus); outline-offset: -3px; }

  /* Aç/kapa anahtarı: gerçek onay kutusu */
  .sw { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .swl { display: flex; align-items: center; gap: 12px; min-height: var(--tap); cursor: pointer; font-weight: 600; }
  .track { position: relative; width: 48px; height: 28px; flex-shrink: 0; border-radius: 14px; border: 2px solid var(--border-strong); background: var(--surface-2); }
  .track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: var(--text); }
  .sw:checked + .swl .track { background: var(--accent); border-color: var(--accent); }
  .sw:checked + .swl .track::after { transform: translateX(20px); background: #fff; }
  .sw:focus-visible + .swl .track { outline: 3px solid var(--focus); outline-offset: 2px; }
  .switchrow { margin: 12px 0 4px; }
  .pomo { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 4px 12px 12px; }
  .sw:not(:checked) ~ .pomo-body { display: none; }

  /* Küçük resim kartları (kapak, klip): seçili = kenarlık + ✓ */
  .tilegrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .tilegrid.two { grid-template-columns: repeat(2, 1fr); }
  @media (max-width: 360px) { .tilegrid { grid-template-columns: repeat(2, 1fr); } }
  @media (min-width: 640px) { .tilegrid { grid-template-columns: repeat(4, 1fr); } .tilegrid.two { grid-template-columns: repeat(3, 1fr); } }
  .tile { position: relative; display: flex; flex-direction: column; gap: 6px; cursor: pointer; min-width: 0; }
  .tin { position: absolute; opacity: 0; pointer-events: none; }
  .tw { display: flex; align-items: center; justify-content: center; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 8px; border: 2px solid var(--line); background: var(--surface-2); }
  .tw .thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tw .ph { color: var(--muted); font-size: 18px; }
  .tn { font-size: 12px; line-height: 1.25; color: var(--muted); overflow-wrap: anywhere; }
  .tin:checked ~ .tw { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
  .tin:checked ~ .tn { color: var(--text); }
  .tin:checked ~ .tn::before { content: '✓ '; color: var(--ok); font-weight: 700; }
  .tin:focus-visible ~ .tw { outline: 3px solid var(--focus); outline-offset: 2px; }

  /* JS varsa Pomodoro süre kısayolları görünür; yoksa yalnızca metin alanı */
  .js-only { display: none; }
  html.js .js-only { display: flex; }
  html.js .pt-custom { display: none; }
  html.js .pt-custom.show { display: block; }

  /* Kaydet çubuğu: JS varken ve değişiklik varsa ekranın altına yapışır (yalnızca o zaman) */
  .savebar { display: flex; flex-wrap: wrap; gap: 10px; }
  .savebar button { flex: 1 1 140px; margin-top: 0; }
  .dirtynote { display: none; flex-basis: 100%; margin: 0; font-size: 13px; }
  form.dirty .dirtynote { display: block; }
  html.js form.dirty .savebar {
    position: sticky; bottom: 0; z-index: 5; margin: 8px -16px 0; padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
    background: var(--bg); border-top: 1px solid var(--border-strong);
  }
  button.wait { opacity: .55; pointer-events: none; }
  button.busy { opacity: .9; cursor: progress; }

  @media (min-width: 640px) { body { max-width: 720px; } }

  @media (prefers-reduced-motion: no-preference) {
    @keyframes spin { to { transform: rotate(360deg); } }
    button.busy::after { content: ''; display: inline-block; width: 14px; height: 14px; margin-left: 8px; vertical-align: -2px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
    .track, .track::after, .seg label, .seg button, .tw, button { transition: background-color .15s, border-color .15s, transform .15s, box-shadow .15s; }
    button:active { transform: scale(.98); }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  }
`;

// Küçük istemci betiği (ilerleyen geliştirme): sayfa JS OLMADAN da tam çalışır — bu betik
// yalnızca kolaylık ekler. Form alan adları/değerleri ve gönderim davranışı değişmez.
// DİKKAT: bu metinde HTML etiketi benzeri dize bulunmamalı (testler HTML'i ayrıştırır).
const SCRIPT = `
(function () {
  var d = document;

  // Pomodoro süre kısayolları: kısayol metin alanını doldurur; "Özel" alanı açar.
  var typeInput = d.getElementById('pomodoroType');
  var presets = d.getElementById('pomoPresets');
  var custom = d.getElementById('ptCustom');
  if (typeInput && presets && custom) {
    var buttons = [].slice.call(presets.querySelectorAll('button'));
    var sync = function (forceCustom) {
      var value = typeInput.value.trim();
      var hit = false;
      buttons.forEach(function (b) {
        var t = b.getAttribute('data-type');
        var on = !forceCustom && t !== '' && t === value;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on) hit = true;
      });
      var isCustom = forceCustom || !hit;
      buttons.forEach(function (b) { if (b.getAttribute('data-type') === '') b.setAttribute('aria-pressed', isCustom ? 'true' : 'false'); });
      custom.className = isCustom ? 'pt-custom show' : 'pt-custom';
    };
    presets.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      var t = b.getAttribute('data-type');
      if (t === '') { sync(true); typeInput.focus(); return; }
      typeInput.value = t;
      typeInput.dispatchEvent(new Event('input', { bubbles: true }));
      sync(false);
    });
    typeInput.addEventListener('input', function () { sync(true); });
    sync(false);
  }

  // Katlı bölümlerin "N seçili" özeti canlı kalsın.
  [].forEach.call(d.querySelectorAll('[data-count-for]'), function (el) {
    var name = el.getAttribute('data-count-for');
    var update = function () {
      var n = 0;
      [].forEach.call(d.getElementsByName(name), function (i) { if (i.checked) n += 1; });
      el.textContent = '· ' + n + ' seçili';
    };
    d.addEventListener('change', function (e) { if (e.target && e.target.name === name) update(); });
  });

  // ── Kaydedilmemiş değişiklik koruması (D2, D3) ──────────────────────────
  // Düzenleme formları (data-guard): ana plan, seçili yayın, yeni yayın. Başlangıç görüntüsü
  // alınır; değişiklik varken sayfayı yenileyecek bir işlem (başka yayın, yükleme, başka form)
  // önce AÇIK bir onay ister. Onay: "Tamam" = değişiklikleri at, "İptal" = sayfada kal.
  var guarded = [].slice.call(d.querySelectorAll('form[data-guard]'));
  var snapshot = function (f) {
    var parts = [];
    [].forEach.call(f.elements, function (el) {
      if (!el.name || el.disabled) return;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) return;
      parts.push(el.name + '=' + el.value);
    });
    return parts.join('&');
  };
  var initial = guarded.map(snapshot);
  // Galeriden yeni yüklenen kapak seçili gelir ama plana HENÜZ yazılmadı (data-pending):
  // sayfa baştan "kaydedilmemiş değişiklik var" saymalı.
  var planIndex = guarded.indexOf(d.getElementById('planForm'));
  if (planIndex >= 0 && guarded[planIndex].hasAttribute('data-pending')) initial[planIndex] = 'bekleyen-kapak';
  var dirtyForms = function () { return guarded.filter(function (f, i) { return snapshot(f) !== initial[i]; }); };
  var leaving = false;
  var planForm = d.getElementById('planForm');
  var note = d.getElementById('dirtyNote');
  var refresh = function () {
    if (!planForm) return;
    var dirty = snapshot(planForm) !== initial[guarded.indexOf(planForm)];
    planForm.className = dirty ? 'dirty' : '';
    if (note) note.textContent = dirty ? 'Kaydedilmemiş değişiklik var' : '';
  };
  d.addEventListener('input', refresh);
  d.addEventListener('change', refresh);
  var askDiscard = function (what) {
    return window.confirm('Kaydedilmemiş değişikliklerin var. ' + what + ' bu değişiklikler kaybolur.\\n\\nTamam: değişiklikleri at ve devam et\\nİptal: sayfada kal (önce Kaydet düğmesine bas)');
  };
  // Başka yayına geçme / başka sayfaya gitme (bağlantılar).
  d.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.target === '_blank' || (a.getAttribute('href') || '').charAt(0) === '#') return;
    if (dirtyForms().length === 0) return;
    if (!askDiscard('Başka bir yayına ya da sayfaya geçersen')) { e.preventDefault(); return; }
    leaving = true;
  });
  // Tarayıcıdan çıkma / geri / yenileme için son güvenlik ağı.
  window.addEventListener('beforeunload', function (e) {
    if (leaving || dirtyForms().length === 0) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ── İşlem durumu ve çift gönderim engeli (D4) ───────────────────────────
  // Düğmeler PASİFLEŞTİRİLMEZ (pasif düğmenin name/value'su gönderilmez, işlem bozulur);
  // yerine ikinci gönderim engellenir, düğme "…yapılıyor" yazar ve diğerleri sönükleşir.
  var BUSY_BY_ACTION = {
    start: 'Başlatılıyor…', stop: 'Durduruluyor…', golive: 'Canlıya alınıyor…', apply: 'Uygulanıyor…',
    end: 'Bitiriliyor…', save: 'Kaydediliyor…', save_restart: 'Kaydedilip yeniden başlatılıyor…'
  };
  var busy = false;
  var busyLabel = function (btn, form) {
    if (btn.getAttribute('data-busy')) return btn.getAttribute('data-busy');
    if (BUSY_BY_ACTION[btn.value]) return BUSY_BY_ACTION[btn.value];
    if (form && form.id === 'coverUpload') return 'Yükleniyor…';
    return 'İşleniyor…';
  };
  var startBusy = function (btn, form) {
    busy = true;
    leaving = true;
    [].forEach.call(d.querySelectorAll('button'), function (b) {
      if (b === btn) return;
      b.className += ' wait';
    });
    if (btn) {
      btn.setAttribute('data-label', btn.textContent);
      btn.setAttribute('aria-busy', 'true');
      btn.textContent = busyLabel(btn, form);
      btn.className += ' busy';
    }
  };
  var resetBusy = function () {
    busy = false;
    leaving = false;
    [].forEach.call(d.querySelectorAll('button'), function (b) {
      b.className = b.className.replace(/ (wait|busy)/g, '');
      if (b.hasAttribute('data-label')) { b.textContent = b.getAttribute('data-label'); b.removeAttribute('data-label'); }
      b.removeAttribute('aria-busy');
    });
  };
  d.addEventListener('submit', function (e) {
    var form = e.target;
    if (e.defaultPrevented) return; // satır içi onay (confirm) iptal edildi
    if (busy) { e.preventDefault(); return; }
    var others = dirtyForms().filter(function (f) { return f !== form; });
    if (others.length && !askDiscard('Bu işlem sayfayı yeniler ve')) { e.preventDefault(); return; }
    startBusy(e.submitter || null, form);
  });
  // Galeri dosyası seçilince (D2): kaydedilmemiş değişiklik varsa önce sor; sonra gönder.
  window.uploadPick = function (input) {
    if (!input.files || !input.files.length || busy) return;
    if (dirtyForms().length && !askDiscard('Görsel yüklenince sayfa yenilenir ve')) { input.value = ''; return; }
    var form = d.getElementById('coverUpload');
    startBusy(d.querySelector('button[form="coverUpload"]'), form);
    form.submit();
  };
  refresh();
  // Geri tuşuyla önbellekten dönülürse işlem durumu takılı kalmasın.
  window.addEventListener('pageshow', function (e) { if (e.persisted) resetBusy(); });
})();
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
  // D1: yeniden başlatma canlı yayını keser — her durumda net bir onay (metin duruma göre).
  const restartConfirm = {
    running: 'Yayın şu an ÇALIŞIYOR. Yeniden başlatma yayını kısa süreliğine KESER ve yeni planla baştan başlatır. Devam edilsin mi?',
    stopped: 'Yayın şu an durmuş. Bu işlem planı kaydeder ve yayını BAŞLATIR. Devam edilsin mi?',
  }[streamState] ?? 'Bu işlem planı kaydeder ve yayını yeniden başlatır; çalışan yayın varsa kısa süreliğine KESİLİR. Devam edilsin mi?';
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
<script>document.documentElement.className += ' js';</script>
</head>
<body>
<header>
  <h1>Yayın Yönetimi</h1>
  <p class="sub">Plan: ${esc(plan.name)}</p>
</header>
${notice ? `<div role="status" class="notice">${esc(notice)}</div>` : ''}
${error ? `<div role="alert" class="error">${esc(error)}</div>` : ''}
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
<form id="planForm" method="post" action="${esc(action)}" data-guard${pendingCover ? ' data-pending' : ''}>
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
    ${coverGrid({
    covers, selected: pendingCover ?? plan.cover ?? '', token, scope: 'p-', noneLabel: 'Varsayılan', keepUnknown: true,
  })}
    <p class="hint">Galeriden ekle (JPEG/PNG/WebP): görsel 1280x720'ye kırpılıp küçültülür. Yüklemek sayfayı yeniler — önce yaptığın değişiklikleri Kaydet.</p>
    <label class="lbl" for="coverFile">Galeriden görsel seç</label>
    <input type="file" id="coverFile" name="coverFile" accept="image/jpeg,image/png,image/webp" form="coverUpload" onchange="if(window.uploadPick){uploadPick(this)}else{document.getElementById('coverUpload').submit()}">
    <button class="secondary" type="submit" form="coverUpload">Yükle</button>

    <h3>Pomodoro</h3>
    <div class="pomo">
      ${switchInput('pomodoroEnabled', 'pomodoroEnabled', p.enabled, 'Pomodoro açık')}
      <div class="pomo-body">
        <p class="lbl" id="pomoPresets-l">Süre (çalışma + mola, dakika)</p>
        <div class="seg js-only" id="pomoPresets" role="group" aria-labelledby="pomoPresets-l">${POMO_PRESETS.map((t) => `<button type="button" data-type="${t}" aria-pressed="false">${t}</button>`).join('')}<button type="button" data-type="" aria-pressed="false">Özel</button></div>
        <div class="pt-custom" id="ptCustom">
          <label class="lbl" for="pomodoroType">Süre</label>
          <p class="hint">"&lt;çalışma&gt;+&lt;mola&gt;" dakika (örn. 50+10, 30+10, 45+15)</p>
          <input type="text" id="pomodoroType" name="pomodoroType" value="${esc(p.type)}" inputmode="text" placeholder="50+10">
        </div>

        ${fold('Çalışma görselleri', `${p.studyVideos.length} seçili`, `
          <p class="hint">Çoklu seçim — her çalışma session'ı havuzdan rastgele bir klip kullanır, ardışık iki session aynı klibi tekrarlamaz.</p>
          ${clipGrid('studyVideos', clips, p.studyVideos, token)}`, { countFor: 'studyVideos' })}
        ${fold('Mola görselleri', `${p.breakVideos.length} seçili`, `
          <p class="hint">Çoklu seçim — her mola session'ı havuzdan rastgele bir klip kullanır, ardışık iki session aynı klibi tekrarlamaz.</p>
          ${clipGrid('breakVideos', clips, p.breakVideos, token)}`, { countFor: 'breakVideos' })}
      </div>
    </div>

    <p class="muted">${esc(musicNote)}</p>
  </section>

  <div class="savebar">
    <p class="dirtynote" id="dirtyNote" role="status" aria-live="polite"></p>
    <button class="primary" type="submit" name="action" value="save">Kaydet</button>
    <button class="secondary" type="submit" name="action" value="save_restart" onclick="return confirm('${esc(restartConfirm)}')">Kaydet ve Yeniden Başlat</button>
  </div>
  <p class="hint">Kaydet yalnızca planı kaydeder, çalışan yayına dokunmaz. "Kaydet ve Yeniden Başlat" ise kaydeder ve yayını kısa süreliğine keserek yeni planla yeniden başlatır.</p>
</form>
${canCreate && !newMode ? `<section>
  <a class="newlink" href="${esc(`/config?token=${encodeURIComponent(token)}&new=1`)}">+ Eşzamanlı yeni yayın aç…</a>
</section>` : ''}
<script>${SCRIPT}</script>
</body>
</html>`;
}

module.exports = { renderConfigPage, esc };
