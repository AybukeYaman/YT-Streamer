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
