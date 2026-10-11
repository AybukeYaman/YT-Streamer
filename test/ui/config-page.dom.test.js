// Pomodoro süre doğrulaması (istemci) ve bilinmeyen görünürlük davranışı.
// Pomodoro testleri GERÇEK DOM'da çalışır (headless Chrome/Edge, bkz. helpers/browser-dom.js);
// tarayıcı yoksa atlanır. Görünürlük testleri HTML düzeyinde olduğundan her yerde çalışır.
const test = require('node:test');
const assert = require('node:assert/strict');

const { renderConfigPage } = require('../../src/ui/config-page');
const { StreamPlan } = require('../../src/domain/stream-plan');
const { findBrowser, runInPage } = require('./helpers/browser-dom');
const { extractForms } = require('./helpers/form-data');

const NOTE = 'Görünürlük okunamadı; bu işlemde değiştirilmez.';
const noBrowser = findBrowser() ? false : 'headless Chrome/Edge bulunamadı (CHROME_PATH ile gösterilebilir)';

const page = (pomodoro = {}) => renderConfigPage({
  plan: new StreamPlan({
    pomodoro: {
      enabled: true, type: '50+10', studyVideos: ['X:/clips/a.mp4'], breakVideos: ['X:/clips/b.mp4'], ...pomodoro,
    },
  }),
  clips: ['X:/clips/a.mp4', 'X:/clips/b.mp4'],
  token: 't',
});

// Sayfa içinde: alanı doldur, gerçek düğmeye tıkla, durumu geri döndür.
const SUBMIT = (typeValue, { enabled = true, button = 'save' } = {}) => `
  var toggle = document.getElementById('pomodoroEnabled');
  var input = document.getElementById('pomodoroType');
  var title = document.getElementById('p-title');
  title.value = 'Elle yazılan başlık';
  toggle.checked = ${enabled};
  input.value = ${JSON.stringify(typeValue)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('button[value="${button}"]').click();
  var err = document.getElementById('pomodoroTypeErr');
  return {
    submits: window.__submits,
    errHidden: err.hidden, errText: err.textContent, errRole: err.getAttribute('role'),
    invalid: input.getAttribute('aria-invalid'), describedby: input.getAttribute('aria-describedby'),
    value: input.value, enabled: toggle.checked, title: title.value,
    study: document.querySelector('input[name="studyVideos"]:checked').value,
    focused: document.activeElement === input,
    busy: document.querySelectorAll('button.busy').length,
  };`;

for (const bad of ['', 'abc', '50', '50+', '+10', '50+10+5', '1000+10', '50+1000', '50 + 10', '-5+10', '5.5+10']) {
  test(`pomodoro açık + geçersiz süre ${JSON.stringify(bad)}: gönderim durur, hata alanın altında, seçimler korunur`, { skip: noBrowser }, () => {
    const r = runInPage(page(), SUBMIT(bad));
    assert.equal(r.submits.filter((s) => !s.prevented).length, 0, 'hiçbir gönderim geçmemeli (tıklama durdurulur)');
    assert.equal(r.errHidden, false);
    assert.match(r.errText, /Geçersiz süre/);
    assert.equal(r.errRole, 'alert', 'ekran okuyucu duyursun');
    assert.equal(r.invalid, 'true');
    assert.equal(r.describedby, 'pomodoroTypeErr');
    assert.equal(r.focused, true, 'odak hatalı alana gider');
    assert.equal(r.value, bad, 'girilen değer olduğu gibi kalır');
    assert.equal(r.enabled, true, 'anahtar durumu korunur');
    assert.equal(r.title, 'Elle yazılan başlık', 'diğer alanlar korunur');
    assert.equal(r.study, 'X:/clips/a.mp4');
    assert.equal(r.busy, 0, 'işlem durumu (bekleyen düğme) başlamamalı');
  });
}

for (const good of ['50+10', '30+10', '45+15', '7+3', '120+999', ' 25+5 ']) {
  test(`pomodoro açık + geçerli süre ${JSON.stringify(good)}: gönderim geçer, hata yok`, { skip: noBrowser }, () => {
    const r = runInPage(page(), SUBMIT(good));
    assert.equal(r.submits.length, 1);
    assert.equal(r.submits[0].prevented, false);
    assert.equal(r.submits[0].submitter, 'save');
    assert.equal(r.errHidden, true);
    assert.equal(r.invalid, null);
  });
}

test('pomodoro KAPALI: geçersiz süre bile gönderimi engellemez (mevcut davranış)', { skip: noBrowser }, () => {
  const r = runInPage(page({ enabled: false }), SUBMIT('abc', { enabled: false }));
  assert.equal(r.submits.length, 1);
  assert.equal(r.submits[0].prevented, false);
  assert.equal(r.errHidden, true);
  assert.equal(r.invalid, null);
});

test('"Kaydet ve Yeniden Başlat": geçersiz süre onay penceresini açmadan durdurur', { skip: noBrowser }, () => {
  const r = runInPage(page(), `
    var asked = 0;
    window.confirm = function () { asked += 1; return true; };
    var res = (function () { ${SUBMIT('xx', { button: 'save_restart' })} })();
    res.asked = asked;
    return res;`);
  assert.equal(r.asked, 0, 'confirm çağrılmamalı');
  assert.equal(r.submits.filter((s) => !s.prevented).length, 0, 'hiçbir gönderim geçmemeli');
  assert.equal(r.errHidden, false);
});

test('"Kaydet ve Yeniden Başlat": geçerli süre onaydan sonra gönderilir', { skip: noBrowser }, () => {
  const r = runInPage(page(), `
    var asked = 0;
    window.confirm = function () { asked += 1; return true; };
    var res = (function () { ${SUBMIT('45+15', { button: 'save_restart' })} })();
    res.asked = asked;
    return res;`);
  assert.equal(r.asked, 1);
  assert.equal(r.submits.length, 1);
  assert.equal(r.submits[0].prevented, false);
  assert.equal(r.submits[0].submitter, 'save_restart');
});

test('Enter ile gönderim (requestSubmit, düğmesiz): geçersiz süre durdurulur', { skip: noBrowser }, () => {
  const r = runInPage(page(), `
    document.getElementById('pomodoroType').value = '9';
    document.getElementById('planForm').requestSubmit();
    return { submits: window.__submits, errHidden: document.getElementById('pomodoroTypeErr').hidden };`);
  assert.equal(r.submits.length, 1);
  assert.equal(r.submits[0].prevented, true);
  assert.equal(r.errHidden, false);
});

test('kısayol düğmeleri (50+10, 30+10, 45+15) alanı doldurur ve gönderim geçer', { skip: noBrowser }, () => {
  for (const preset of ['50+10', '30+10', '45+15']) {
    const r = runInPage(page({ type: '12+3' }), `
      document.querySelector('#pomoPresets button[data-type="${preset}"]').click();
      var input = document.getElementById('pomodoroType');
      var pressed = document.querySelector('#pomoPresets button[aria-pressed="true"]').getAttribute('data-type');
      document.querySelector('button[value="save"]').click();
      return { value: input.value, pressed: pressed, submits: window.__submits };`);
    assert.equal(r.value, preset);
    assert.equal(r.pressed, preset);
    assert.equal(r.submits[0].prevented, false);
  }
});

test('hata sonrası düzeltme: yazmaya başlayınca hata temizlenir, tekrar gönderilebilir', { skip: noBrowser }, () => {
  const r = runInPage(page(), `
    var input = document.getElementById('pomodoroType');
    input.value = 'bozuk';
    document.querySelector('button[value="save"]').click();
    var err = document.getElementById('pomodoroTypeErr');
    var shown = !err.hidden;
    input.value = '25+5';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    var cleared = err.hidden && input.getAttribute('aria-invalid') === null;
    document.querySelector('button[value="save"]').click();
    return { shown: shown, cleared: cleared, submits: window.__submits };`);
  assert.equal(r.shown, true);
  assert.equal(r.cleared, true);
  assert.equal(r.submits.length, 1, 'ilk tıklama submit üretmeden durur; ikincisi geçer');
  assert.equal(r.submits[0].prevented, false);
});

test('hata gösterilirken özel süre alanı görünür kalır ("Özel" açılır)', { skip: noBrowser }, () => {
  const r = runInPage(page(), `
    document.getElementById('pomodoroType').value = 'x';
    document.querySelector('button[value="save"]').click();
    return document.getElementById('ptCustom').className;`);
  assert.match(r, /\bshow\b/);
});

// ── Görünürlük: bilinmiyorsa değiştirilmez ─────────────────────────────────

const broadcastPage = (privacyStatus) => renderConfigPage({
  plan: new StreamPlan({}),
  clips: [],
  token: 't',
  broadcasts: { items: [{ id: 'b1', title: 'Yayın', description: '', privacyStatus, lifeCycleStatus: 'live', finished: false }] },
  selectedId: 'b1',
});

const applyEntries = (html) => extractForms(html).find((f) => f.action.startsWith('/config/broadcast')).entries;

for (const unknown of [null, undefined, '', 'bilinmeyen']) {
  test(`yayın görünürlüğü okunamadı (${JSON.stringify(unknown)}): not gösterilir, "privacy" alanı gönderilmez`, () => {
    const html = broadcastPage(unknown);
    assert.ok(html.includes(NOTE), 'not görünmeli');
    assert.doesNotMatch(html, /name="privacy"/, 'seçenekler çizilmemeli');
    assert.deepEqual(applyEntries(html).filter(([name]) => name === 'privacy'), []);
    // Diğer alanlar (başlık vb.) normal gönderilir.
    assert.ok(applyEntries(html).some(([name]) => name === 'title'));
  });
}

test('görünürlük bilinen yayında not yok, mevcut seçim işaretli (davranış değişmedi)', () => {
  for (const known of ['public', 'unlisted', 'private']) {
    const html = broadcastPage(known);
    assert.ok(!html.includes(NOTE));
    assert.deepEqual(applyEntries(html).filter(([name]) => name === 'privacy'), [['privacy', known]]);
  }
});

test('yeni yayın formunun varsayılan görünürlüğü değişmedi (liste dışı)', () => {
  const html = renderConfigPage({
    plan: new StreamPlan({}), clips: [], token: 't', canCreate: true, newMode: true, broadcasts: { items: [] }, catalogAlbums: [],
  });
  assert.match(html, /name="privacy" value="unlisted" checked/);
  assert.ok(!html.includes(NOTE));
});

// ── Galeriden kapak: dosya seçilince yükleme formu gerçekten gönderilir ─────
test('galeriden dosya seçilince (change) coverUpload formu gönderilir; yükleme sırasında düğme "Yükleniyor…"', { skip: noBrowser }, () => {
  const r = runInPage(renderConfigPage({ plan: new StreamPlan({}), clips: [], token: 't', nonce: 'a'.repeat(32) }), `
    var sent = [];
    HTMLFormElement.prototype.submit = function () { sent.push({ id: this.id, action: this.getAttribute('action') }); };
    var input = document.getElementById('coverFile');
    var dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([255, 216, 255, 1])], 'a.jpg', { type: 'image/jpeg' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    var label = document.querySelector('label.filebtn');
    return { sent: sent, labelFor: label && label.getAttribute('for'), labelVisible: label && getComputedStyle(label).display };`);
  assert.equal(r.labelFor, 'coverFile');
  assert.equal(r.labelVisible, 'flex');
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].id, 'coverUpload');
  assert.match(r.sent[0].action, /^\/config\/upload\?token=t&n=a{32}$/);
});

// ── Kademeli sayfa + seçili yayına galeriden kapak ──────────────────────────
const tiered = (extra = {}) => renderConfigPage({
  plan: new StreamPlan({}), clips: [], token: 't', covers: ['X:/c/a.jpg', 'X:/c/galeri-1.jpg'],
  broadcasts: { items: [{ id: 'b1', title: 'Y', description: '', privacyStatus: 'public', lifeCycleStatus: 'live', finished: false }] },
  selectedId: 'b1', nonce: 'a'.repeat(32), ...extra,
});

const disp = (id) => `getComputedStyle(document.getElementById('${id}')).display`;

test('adımlar: JS varken tek adım görünür; sekmeye basınca geçilir; düzenleme katları kendiliğinden açık', { skip: noBrowser }, () => {
  const r = runInPage(tiered(), `
    var tabs = [].map.call(document.querySelectorAll('#steps button'), function (b) { return b.getAttribute('data-step'); });
    var first = { bc: ${disp('step-bc')}, next: ${disp('step-next')}, sel: document.querySelector('#steps [aria-selected=true]').getAttribute('data-step') };
    document.getElementById('tab-next').click();
    var second = { bc: ${disp('step-bc')}, next: ${disp('step-next')}, bar: getComputedStyle(document.querySelector('.savebar')).display,
      open: document.querySelector('details.planfold').open, sumHidden: getComputedStyle(document.querySelector('details.planfold > summary')).display,
      stored: sessionStorage.getItem('yt-step') };
    return { tabs: tabs, first: first, second: second };`);
  assert.deepEqual(r.tabs, ['bc', 'next'], 'boş "Şu an" adımı için sekme çıkmaz');
  assert.equal(r.first.sel, 'bc');
  assert.notEqual(r.first.bc, 'none');
  assert.equal(r.first.next, 'none');
  assert.equal(r.second.bc, 'none');
  assert.notEqual(r.second.next, 'none');
  assert.equal(r.second.bar, 'flex', 'Kaydet çubuğu plan adımında görünür');
  assert.equal(r.second.open, true);
  assert.equal(r.second.sumHidden, 'none', 'adım içinde ekstra "düzenle" satırı yok');
  assert.equal(r.second.stored, 'next');
});

test('adımlar: sunucu zorlarsa (yüklenen kapak) kayıtlı adım yok sayılır; JS yokken hepsi görünür', { skip: noBrowser }, () => {
  const html = tiered({ pendingCover: 'X:/c/galeri-1.jpg', pendingFor: 'p' });
  const r = runInPage(html, `
    sessionStorage.setItem('yt-step', 'bc');
    return 1;`);
  assert.equal(r, 1);
  // Zorlama özniteliği sunucu çıktısında: JS betiği açılışta bunu kayıtlı adımdan önce uygular.
  assert.match(html, /<nav class="steps" id="steps"[^>]*data-start="next" data-force="1">/);
  assert.doesNotMatch(tiered(), /data-force="1"/);
  assert.match(html, /\.steps \{ display: none; \}/, 'sekme çubuğu JS yokken gizli');
  assert.match(html, /html\.js \.step:not\(\.on\) \{ display: none; \}/, 'adım gizleme yalnızca JS varken');
});

test('tema seçici: tek palet ikonu; açılınca 4 nokta; seçince tema değişir, hatırlanır, pencere kapanır', { skip: noBrowser }, () => {
  const r = runInPage(tiered(), `
    var pop = document.querySelector('details.themes');
    var closedAtStart = !pop.open;
    pop.querySelector('summary').click();
    var before = getComputedStyle(document.body).backgroundColor;
    var opened = pop.open;
    document.querySelector('.tdot[data-theme=kagit]').click();
    var after = getComputedStyle(document.body).backgroundColor;
    return {
      before: before, after: after, theme: document.documentElement.getAttribute('data-theme'),
      stored: localStorage.getItem('yt-theme'), closedAtStart: closedAtStart, opened: opened, closedAfter: !pop.open,
      pressed: [].map.call(document.querySelectorAll('.tdot[aria-pressed=true]'), function (b) { return b.getAttribute('data-theme'); }),
      count: document.querySelectorAll('.tdot').length, visible: getComputedStyle(pop).display,
    };`);
  assert.equal(r.count, 4);
  assert.equal(r.visible, 'block');
  assert.equal(r.closedAtStart, true, 'pencere kapalı başlar (üst çubukta yalnızca ikon)');
  assert.equal(r.opened, true);
  assert.equal(r.closedAfter, true);
  assert.equal(r.theme, 'kagit');
  assert.equal(r.stored, 'kagit');
  assert.deepEqual(r.pressed, ['kagit']);
  assert.notEqual(r.before, r.after, 'zemin rengi değişmeli');
});

test('seçili yayının kapağı: galeriden dosya seçilince coverUploadB (for=b) gönderilir', { skip: noBrowser }, () => {
  const r = runInPage(tiered(), `
    var sent = [];
    HTMLFormElement.prototype.submit = function () { sent.push({ id: this.id, action: this.getAttribute('action') }); };
    var input = document.getElementById('b-coverFile');
    var dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([255, 216, 255, 1])], 'a.jpg', { type: 'image/jpeg' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return sent;`);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'coverUploadB');
  assert.match(r[0].action, /^\/config\/upload\?token=t&broadcast=b1&for=b&n=a{32}$/);
});

test('yükleme seçili yayından yapıldıysa kapak yalnızca yayın panelinde seçili gelir ve panel açılır', () => {
  const html = tiered({ pendingCover: 'X:/c/galeri-1.jpg', pendingFor: 'b' });
  assert.match(html, /name="cover" value="X:\/c\/galeri-1\.jpg" checked/);
  assert.equal([...html.matchAll(/name="cover" value="X:\/c\/galeri-1\.jpg" checked/g)].length, 1);
  assert.match(html, /id="b-cover-X__c_galeri-1_jpg"|id="b-cover-[^"]*galeri[^"]*" name="cover" value="X:\/c\/galeri-1\.jpg" checked/);
  assert.match(html, /<details class="fold autoopen" open><summary>Yayını düzenle/);
  assert.doesNotMatch(html, /<details class="fold planfold autoopen" open>/);
});

test('yükleme "Sonraki yayın"dan yapıldıysa plan kapağı seçili gelir ve plan açılır', () => {
  const html = tiered({ pendingCover: 'X:/c/galeri-1.jpg', pendingFor: 'p' });
  assert.match(html, /id="p-cover-[^"]*" name="cover" value="X:\/c\/galeri-1\.jpg" checked/);
  assert.match(html, /<details class="fold planfold autoopen" open>/);
});
