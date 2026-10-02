// scripts/deploy/lib/mask.sh testleri: sahte .env dizini (MASK_ENV_DIR) verilir.
//
// Asıl koruduğumuz şey: key hiçbir yoldan maskesiz geçmesin — ne URL içinde, ne çıplak,
// ne rotasyondan sonra kalan eski bir değer olarak. Ve maske çalışmıyorsa çıktı
// BASILMASIN (mask_require fail-closed).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '../../scripts/deploy/lib/mask.sh');
const BASH = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';

// envFiles: { '.env': 'YOUTUBE_STREAM_KEY=...' } — sahte env dizinine yazılır.
function mask(input, envFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mask-test-'));
  for (const [name, content] of Object.entries(envFiles)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  const inputFile = path.join(dir, 'input.txt');
  fs.writeFileSync(inputFile, input);
  const script = [
    `MASK_ENV_DIR="${dir}"`,
    `. "${LIB}"`,
    'mask_require || exit 9',
    `mask < "${inputFile}"`,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `bash hata verdi (${r.status}): ${r.stderr}`);
  return r.stdout;
}

// ── Kalıp katmanı: .env okunamasa bile çalışır ──────────────────────────────
test('RTMP URL’sindeki key maskelenir', { skip: !BASH }, () => {
  const out = mask("Output #0, flv, to 'rtmps://a.rtmps.youtube.com/live2/abcd-efgh-ijkl-mnop-qrst':\n");
  assert.ok(out.includes('***MASKED***'));
  assert.ok(!out.includes('abcd-efgh-ijkl-mnop-qrst'));
  // Tırnak ve iki nokta korunur: çıktı okunabilir kalmalı.
  assert.match(out, /live2\/\*\*\*MASKED\*\*\*':/);
});

test('ps çıktısındaki ffmpeg komut satırı maskelenir', { skip: !BASH }, () => {
  const out = mask('1234 1 10:00 ffmpeg -i bg.mp4 -f flv rtmps://a.rtmps.youtube.com/live2/SeCrEt_KEY-99\n');
  assert.ok(!out.includes('SeCrEt_KEY-99'));
  assert.ok(out.includes('ffmpeg -i bg.mp4'));
});

test('rotasyondan ÖNCEKİ key de maskelenir (.env’de olmasa bile)', { skip: !BASH }, () => {
  const out = mask('eski: rtmps://a.rtmps.youtube.com/live2/eski-key-1234\n', {
    '.env': 'YOUTUBE_STREAM_KEY=yeni-key-5678-uzun\n',
  });
  assert.ok(!out.includes('eski-key-1234'));
});

test('YOUTUBE_*=deger satırları maskelenir (KEY, TOKEN, SECRET)', { skip: !BASH }, () => {
  const out = mask([
    'YOUTUBE_STREAM_KEY=abcd-1234-efgh-5678',
    'YOUTUBE_REFRESH_TOKEN=1//04abcdefghijklmnop',
    'YOUTUBE_CLIENT_SECRET=GOCSPX-abcdefghijklmn',
  ].join('\n') + '\n');
  assert.equal(out.match(/\*\*\*MASKED\*\*\*/g).length, 3);
  assert.ok(!out.includes('GOCSPX-abcdefghijklmn'));
});

// ── Değer katmanı: key URL dışında, çıplak geçse de yakalanır ──────────────
test('.env’deki key çıplak geçse de maskelenir', { skip: !BASH }, () => {
  const out = mask('ffmpeg: Failed to publish stream abcd-1234-efgh-5678 to server\n', {
    '.env': 'YOUTUBE_STREAM_KEY=abcd-1234-efgh-5678\n',
  });
  assert.ok(!out.includes('abcd-1234-efgh-5678'));
});

test('tüm instance env dosyaları okunur (.env.stream2)', { skip: !BASH }, () => {
  const out = mask('key2: stream2-key-abcdefgh\n', {
    '.env': 'YOUTUBE_STREAM_KEY=main-key-abcdefgh\n',
    '.env.stream2': 'YOUTUBE_STREAM_KEY=stream2-key-abcdefgh\n',
  });
  assert.ok(!out.includes('stream2-key-abcdefgh'));
});

test('bildirim kanalı sırları da maskelenir (ntfy konusu, healthchecks, auth token)', { skip: !BASH }, () => {
  const out = mask([
    'kanal: https://ntfy.sh/yt-gizli-konu-abc',
    'ping: https://hc-ping.com/uuid-gizli-123456',
    'token: cokUzunBirAuthTokenDegeri123456',
  ].join('\n') + '\n', {
    '.env.youtube': [
      'ALERT_WEBHOOK_URL=https://ntfy.sh/yt-gizli-konu-abc',
      'HEARTBEAT_PING_URL=https://hc-ping.com/uuid-gizli-123456',
      'GOLIVE_AUTH_TOKEN=cokUzunBirAuthTokenDegeri123456',
    ].join('\n') + '\n',
  });
  assert.ok(!out.includes('yt-gizli-konu-abc'));
  assert.ok(!out.includes('uuid-gizli-123456'));
  assert.ok(!out.includes('cokUzunBirAuthTokenDegeri123456'));
});

// ── Yanlış pozitif / bozma kontrolleri ─────────────────────────────────────
test('normal satırlar değişmez', { skip: !BASH }, () => {
  const line = 'frame= 2880 fps= 24 speed=1x — yayin saglikli\n';
  assert.equal(mask(line), line);
});

// Boş ya da yer tutucu değer için kural üretilirse çıktının her yeri bozulurdu.
test('boş/kısa env değeri kural üretmez', { skip: !BASH }, () => {
  const line = 'bu satir aynen kalmali\n';
  assert.equal(mask(line, { '.env': 'YOUTUBE_STREAM_KEY=\nYOUTUBE_CLIENT_SECRET=kisa\n' }), line);
});

test('.env.example ve .disabled dosyaları okunmaz', { skip: !BASH }, () => {
  const line = 'ornek-degerdir-uzun\n';
  assert.equal(mask(line, {
    '.env.example': 'YOUTUBE_STREAM_KEY=ornek-degerdir-uzun\n',
    '.env.stream2.disabled': '',
  }), line);
});

test('env dizini hiç yoksa kalıp katmanı yine çalışır', { skip: !BASH }, () => {
  const r = spawnSync('bash', ['-c', [
    'MASK_ENV_DIR="/olmayan/dizin/xyz"',
    `. "${LIB}"`,
    'mask_require || exit 9',
    "printf 'rtmps://x/live2/gizli-key-123\\n' | mask",
  ].join('\n')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('gizli-key-123'));
});

// ── Fail-closed ────────────────────────────────────────────────────────────
test('mask_require maske çalışıyorsa 0 döner', { skip: !BASH }, () => {
  const r = spawnSync('bash', ['-c', `. "${LIB}"\nmask_require`], { encoding: 'utf8' });
  assert.equal(r.status, 0);
});

// Maske bozuksa (sed yok gibi) mask_require başarısız olmalı — çağıran o çıktıyı basmaz.
test('sed bulunamazsa mask_require başarısız olur (çıktı basılmaz)', { skip: !BASH }, () => {
  const r = spawnSync('bash', ['-c', [
    `. "${LIB}"`,
    'sed() { return 127; }', // sed yokmuş gibi davran
    'MASK_SED_SCRIPT=""',
    'if mask_require; then echo "MASKESIZ BASARDI"; else echo "reddedildi"; fi',
  ].join('\n')], { encoding: 'utf8' });
  assert.match(r.stdout, /reddedildi/);
});
