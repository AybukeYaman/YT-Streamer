// Faz 2.5 — Ses normalizasyonu (bir kerelik ön işleme aracı)
// raw/ içindeki parçaları okur (değiştirmez), music/ altına hedef parametrede .m4a yazar.
// Çalışma zamanı mimarisinin (src/) parçası değildir.
//
// Yöntem (bkz. KARARLAR.md, Faz 2.5): loudnorm ile ölç → sabit kazanç (volume) →
// alimiter ile tepe kırpma. loudnorm linear=true bu parçalarda koşulu sağlamadığı için
// sessizce dinamik moda düşüyordu; kazanç ve limitleme bu yüzden ayrı adımlar.
//
// Kullanım:
//   node scripts/normalize.js             raw/ → music/ normalize et
//   node scripts/normalize.js --analyze   raw/'u sadece analiz eder, hiçbir şey yazmaz
//
// normalizeFile albüm bazlı normalizasyonda (normalize-albums.js) da kullanılıyor.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'raw');
const MUSIC_DIR = path.join(ROOT, 'music');

const TARGET = {
  sampleRate: 48000,
  channels: 2,
  codec: 'aac',
  bitrate: '192k',
  loudness: { I: -14, TP: -1.5, LRA: 11 },
};
// -1.5 dBTP'nin doğrusal karşılığı: 10^(-1.5/20) ≈ 0.841
const LIMITER_CEILING = Math.pow(10, TARGET.loudness.TP / 20).toFixed(3);

const AUDIO_EXT = new Set(['.m4a', '.mp3', '.wav', '.flac', '.aac', '.ogg', '.opus']);

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function listRaw() {
  return fs.readdirSync(RAW_DIR)
    .filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

// ffprobe: ilk ses akışının parametreleri + süre. Okunamazsa null.
async function probe(file) {
  const r = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels,bit_rate:format=duration,bit_rate',
    '-of', 'json', file,
  ]);
  if (r.code !== 0) return null;
  const j = JSON.parse(r.stdout);
  const s = (j.streams || [])[0];
  const duration = parseFloat(j.format && j.format.duration);
  if (!s || !Number.isFinite(duration)) return null;
  return {
    codec: s.codec_name,
    sampleRate: Number(s.sample_rate),
    channels: s.channels,
    bitrate: Number(s.bit_rate || j.format.bit_rate) || null,
    duration,
  };
}

// loudnorm ölçüm geçişi: dosyaya yazmaz, stderr'deki JSON'u döndürür.
async function measureLoudness(file) {
  const { I, TP, LRA } = TARGET.loudness;
  const r = await run('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file,
    '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`,
    '-f', 'null', '-',
  ]);
  const m = r.stderr.match(/\{[\s\S]*?"target_offset"[\s\S]*?\}/);
  if (r.code !== 0 || !m) return null;
  return JSON.parse(m[0]);
}

function matchesTargetFormat(p) {
  return p.codec === TARGET.codec && p.sampleRate === TARGET.sampleRate && p.channels === TARGET.channels;
}

const stem = (f) => path.basename(f, path.extname(f));
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
const lastLines = (text, n) => text.trim().split(/\r?\n/).slice(-n).join(' | ');

async function analyze() {
  const files = listRaw();
  console.log(`raw/: ${files.length} ses dosyası\n`);
  console.log('| # | Dosya | Codec | Hz | Kanal | kbps | Süre | LUFS | TP | LRA | Format hedefte? |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [i, f] of files.entries()) {
    const full = path.join(RAW_DIR, f);
    const p = await probe(full);
    if (!p) {
      console.log(`| ${i + 1} | ${f} | OKUNAMADI | | | | | | | | |`);
      continue;
    }
    const l = await measureLoudness(full);
    const mmss = `${Math.floor(p.duration / 60)}:${String(Math.round(p.duration % 60)).padStart(2, '0')}`;
    console.log(`| ${i + 1} | ${f} | ${p.codec} | ${p.sampleRate} | ${p.channels} | ` +
      `${p.bitrate ? Math.round(p.bitrate / 1000) : '?'} | ${mmss} | ` +
      `${l ? l.input_i : '?'} | ${l ? l.input_tp : '?'} | ${l ? l.input_lra : '?'} | ` +
      `${matchesTargetFormat(p) ? 'evet' : 'hayır'} |`);
  }
}

// Aynı gövde ada (uzantı hariç) sahip dosyalar aynı music/<ad>.m4a hedefine düşer.
// Windows dosya sistemi büyük/küçük harf duyarsız olduğu için karşılaştırma lowercase.
function findCollisions(files) {
  const groups = new Map();
  for (const f of files) {
    const key = stem(f).toLowerCase();
    groups.set(key, [...(groups.get(key) || []), f]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

// Çıktı hedef formatta ve kaynaktan yeniyse tekrar işlemeye gerek yok.
async function isUpToDate(src, out) {
  if (!fs.existsSync(out)) return false;
  if (fs.statSync(src).mtimeMs >= fs.statSync(out).mtimeMs) return false;
  const p = await probe(out);
  return p !== null && matchesTargetFormat(p);
}

// src'yi out'a (.m4a) normalize eder; out güncelse atlar.
async function normalizeFile(src, out) {
  const tmp = `${out}.tmp`;

  if (await isUpToDate(src, out)) return { status: 'skipped' };

  const started = Date.now();
  if (!(await probe(src))) return { status: 'error', message: 'ffprobe süre/ses akışı okuyamadı (bozuk dosya?)' };

  const loud = await measureLoudness(src);
  if (!loud) return { status: 'error', message: 'loudnorm ölçümü başarısız' };
  const inputI = Number(loud.input_i);
  const gainDb = (TARGET.loudness.I - inputI).toFixed(2);

  const r = await run('ffmpeg', [
    '-hide_banner', '-nostats', '-y', '-i', src,
    '-map', '0:a:0',
    '-af', `volume=${gainDb}dB,alimiter=limit=${LIMITER_CEILING}:level=false`,
    '-ar', String(TARGET.sampleRate), '-ac', String(TARGET.channels),
    '-c:a', TARGET.codec, '-b:a', TARGET.bitrate,
    '-f', 'mp4', tmp, // .tmp uzantısından format çıkarılamaz, açıkça veriliyor
  ]);
  if (r.code !== 0) {
    fs.rmSync(tmp, { force: true });
    return { status: 'error', message: `ffmpeg code=${r.code}: ${lastLines(r.stderr, 3)}` };
  }
  fs.renameSync(tmp, out);

  return {
    status: 'ok',
    oldSize: fs.statSync(src).size,
    newSize: fs.statSync(out).size,
    inputI,
    inputTP: Number(loud.input_tp),
    gainDb,
    seconds: (Date.now() - started) / 1000,
  };
}

async function normalizeAll() {
  const t0 = Date.now();
  fs.mkdirSync(MUSIC_DIR, { recursive: true });

  const files = listRaw();
  const collisions = findCollisions(files);
  const colliding = new Set(collisions.flat());
  if (collisions.length) {
    console.log('ÇAKIŞMA — aynı hedefe düşen dosyalar atlanıyor:');
    for (const g of collisions) console.log(`  ${g.join('  <->  ')}  →  music/${stem(g[0])}.m4a`);
    console.log('');
  }

  const counts = { ok: 0, skipped: 0, error: 0 };
  const errors = [];
  const todo = files.filter((f) => !colliding.has(f));
  console.log(`raw/: ${files.length} dosya, işlenecek: ${todo.length}, çakışma nedeniyle atlanan: ${colliding.size}\n`);

  for (const [i, f] of todo.entries()) {
    const tag = `[${String(i + 1).padStart(2)}/${todo.length}] ${f}`;
    const res = await normalizeFile(path.join(RAW_DIR, f), path.join(MUSIC_DIR, `${stem(f)}.m4a`));
    counts[res.status]++;
    if (res.status === 'ok') {
      console.log(`${tag} — OK  ${res.inputI.toFixed(2)} LUFS (TP ${res.inputTP.toFixed(2)}) ` +
        `→ kazanç ${res.gainDb >= 0 ? '+' : ''}${res.gainDb} dB, ${kb(res.oldSize)} → ${kb(res.newSize)}, ${res.seconds.toFixed(1)} sn`);
    } else if (res.status === 'skipped') {
      console.log(`${tag} — ATLANDI (music/'te güncel çıktı var)`);
    } else {
      console.log(`${tag} — HATA: ${res.message}`);
      errors.push({ file: f, message: res.message });
    }
  }

  console.log(`\nÖZET: işlenen ${counts.ok}, atlanan ${counts.skipped}, hata ${counts.error}, ` +
    `çakışma ${colliding.size}, toplam ${((Date.now() - t0) / 1000).toFixed(1)} sn`);
  if (errors.length) {
    console.log('\nHATA LİSTESİ (elle kontrol edilmeli):');
    for (const e of errors) console.log(`  ${e.file}: ${e.message}`);
  }
}

async function main() {
  if (process.argv.includes('--analyze')) return analyze();
  return normalizeAll();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { normalizeFile, AUDIO_EXT, kb };
