// Test yardımcısı: üretilen sayfayı GERÇEK bir tarayıcı DOM'unda (headless Chrome/Edge) çalıştırır.
// Yeni bağımlılık yok: makinedeki tarayıcı `--dump-dom` ile çağrılır. Tarayıcı bulunamazsa
// findBrowser() null döner ve çağıran testler atlanır (CHROME_PATH ile elle gösterilebilir).
//
// runInPage(html, scriptBody): scriptBody sayfa betikleri çalıştıktan sonra, sayfa içinde
// çalışır; `return <JSON'a çevrilebilir değer>` ile sonuç döner. Sayfadaki confirm() hep
// "Tamam" döner ve form gönderimleri kaydedilip iptal edilir (gezinme olmaz): window.__submits
// her gönderimi { id, action, submitter, entries } olarak, validasyon engellemediyse içerir.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

let cached;
function findBrowser() {
  if (cached === undefined) cached = CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
  return cached;
}

const PRELUDE = `<script>window.confirm = function () { return true; };</script>`;

function runInPage(html, scriptBody) {
  const browser = findBrowser();
  if (!browser) throw new Error('tarayıcı yok');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgpage-'));
  try {
    const runner = `<script>
(function () {
  window.__submits = [];
  // Sayfanın kendi dinleyicilerinden SONRA kayıtlı: sonucu kaydeder, gezinmeyi iptal eder.
  document.addEventListener('submit', function (e) {
    window.__submits.push({ id: e.target.id || null, prevented: e.defaultPrevented, submitter: e.submitter ? e.submitter.value : null });
    e.preventDefault();
  });
  var out;
  try { out = { ok: true, value: (function () { ${scriptBody}\n})() }; }
  catch (err) { out = { ok: false, error: String(err && err.stack || err) }; }
  var el = document.createElement('div');
  el.id = '__result';
  el.setAttribute('data-b64', btoa(unescape(encodeURIComponent(JSON.stringify(out)))));
  document.body.appendChild(el);
})();
</script>`;
    const page = html.replace('<script>document.documentElement', `${PRELUDE}<script>document.documentElement`)
      .replace('</body>', `${runner}</body>`);
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, page);
    const res = spawnSync(browser, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
      `--user-data-dir=${path.join(dir, 'profile')}`, '--virtual-time-budget=3000', '--dump-dom',
      `file:///${file.replace(/\\/g, '/')}`,
    ], { encoding: 'utf8', timeout: 60000 });
    const m = /id="__result"[^>]*data-b64="([^"]+)"/.exec(res.stdout || '') ?? /data-b64="([^"]+)"[^>]*id="__result"/.exec(res.stdout || '');
    if (!m) throw new Error(`tarayıcı sonuç üretmedi (kod ${res.status}): ${(res.stderr || '').slice(0, 300)}`);
    const out = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    if (!out.ok) throw new Error(`sayfa betiği hata verdi: ${out.error}`);
    return out.value;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { findBrowser, runInPage };
