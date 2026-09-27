// Faz 8.1 — Arkaplan ön işleme (bir kerelik ön işleme aracı)
// videolar/<albüm>/ klasörlerini okur (değiştirmez), her geçerli albüm için
// music-source/<albüm>/background.mp4 yazar. Çalışma zamanı mimarisinin (src/) parçası değildir.
//
// Albüm geçerliliği isme değil içeriğe bakar: project.json var, audio/ içinde ses dosyası var,
// klip (video ya da görsel) bulunabiliyor. Biri eksikse albüm gerekçesiyle atlanır.
//
// Dönüşüm: alttan cropBottom piksel kes (üretici logosu) → en-boy oranını koruyarak 1280×720'yi
// kaplayacak kadar ölçekle → taşan kısmı ortadan kırp (esnetme yok, siyah bant yok).
// Görsel kaynaklı albümde (project.json video.source = "image") aynı dönüşüm tek kareye
// uygulanır ve IMAGE_LOOP_SECONDS'lık sabit bir video üretilir — çıktı formatı aynı.
//
// cropBottom albüm bazında scripts/background-overrides.json ile ezilebilir
// ({ "<albüm>": { "cropBottom": 0 } }) — project.json'daki değer toptan uygulanmış olabiliyor,
// logosu olmayan klipte gerçek görüntü kesiliyor (bkz. KARARLAR.md, Faz 8.1).
//
// Kullanım:
//   node scripts/prepare-backgrounds.js                 tüm geçerli albümleri işle
//   node scripts/prepare-backgrounds.js <albüm> ...     sadece adı verilenleri işle
//   node scripts/prepare-backgrounds.js --analyze       sadece raporla, hiçbir şey yazma
//   node scripts/prepare-backgrounds.js --force         güncel çıktıları da yeniden üret
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.resolve(ROOT, '..', 'videolar');
const OUT_DIR = path.join(ROOT, 'music-source');
const OVERRIDES_FILE = path.join(__dirname, 'background-overrides.json');

const TARGET = { width: 1280, height: 720, fps: 24 };
const IMAGE_LOOP_SECONDS = 10;
const AUDIO_EXT = new Set(['.m4a', '.mp3', '.wav', '.flac', '.aac', '.ogg', '.opus']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

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

const listFiles = (dir, exts) => (fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => exts.has(path.extname(f).toLowerCase())).sort()
  : []);
const lastLines = (text, n) => text.trim().split(/\r?\n/).slice(-n).join(' | ');

function loadOverrides() {
  if (!fs.existsSync(OVERRIDES_FILE)) return {};
  return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
}

// Albümün geçerliliğini ve arkaplan kaynağını çözer. Geçersizse { skip: gerekçe }.
function inspectAlbum(name, overrides) {
  const dir = path.join(SOURCE_DIR, name);
  const pjPath = path.join(dir, 'project.json');
  if (!fs.existsSync(pjPath)) return { name, skip: 'project.json yok' };
  let pj;
  try {
    pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  } catch (err) {
    return { name, skip: `project.json okunamadı: ${err.message}` };
  }
  const tracks = listFiles(path.join(dir, 'audio'), AUDIO_EXT);
  if (!tracks.length) return { name, skip: 'audio/ içinde ses dosyası yok' };

  // Öncelik project.json'daki clip; yoksa videolar/'da tek video varsa o.
  let clip = pj.clip ? path.resolve(dir, pj.clip) : null;
  if (clip && !fs.existsSync(clip)) return { name, skip: `clip bulunamadı: ${pj.clip}` };
  if (!clip) {
    const vids = listFiles(path.join(dir, 'videolar'), VIDEO_EXT);
    if (vids.length !== 1) return { name, skip: `clip belirtilmemiş, videolar/'da ${vids.length} video var` };
    clip = path.join(dir, 'videolar', vids[0]);
  }
  const ext = path.extname(clip).toLowerCase();
  const kind = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null;
  if (!kind) return { name, skip: `clip türü desteklenmiyor: ${ext}` };

  const own = overrides[name] || {};
  const overridden = own.cropBottom !== undefined;
  const cropBottom = Number(overridden ? own.cropBottom : (pj.video && pj.video.cropBottom) || 0);
  return { name, dir, pjPath, clip, kind, cropBottom, overridden, trackCount: tracks.length };
}

async function probeVideo(file) {
  const r = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', file,
  ]);
  if (r.code !== 0) return null;
  const j = JSON.parse(r.stdout);
  const s = (j.streams || [])[0];
  if (!s) return null;
  return { width: s.width, height: s.height, fps: s.r_frame_rate, duration: parseFloat(j.format.duration) || null };
}

// Logo kesildikten sonra 16:9'a kırpmada kaybedilen pay (analiz raporu için).
function geometry(width, height, cropBottom) {
  const h = height - cropBottom;
  const aspect = width / h;
  const target = TARGET.width / TARGET.height;
  const loss = aspect > target
    ? `yanlardan %${((1 - target / aspect) * 100).toFixed(1)}`
    : aspect < target ? `üst+alttan %${((1 - aspect / target) * 100).toFixed(1)}` : 'yok';
  return { afterCrop: `${width}×${h}`, aspect: aspect.toFixed(3), loss };
}

function filterChain(cropBottom) {
  const { width, height, fps } = TARGET;
  return [
    cropBottom > 0 ? `crop=iw:ih-${cropBottom}:0:0` : null,
    // out_range=tv: tam aralıklı (yuvj420p) kaynak da sınırlı aralığa çevrilsin, çıktılar tek formatta
    `scale=${width}:${height}:force_original_aspect_ratio=increase:out_range=tv`,
    `crop=${width}:${height}`,
    'setsar=1',
    `fps=${fps}`,
    'format=yuv420p',
  ].filter(Boolean).join(',');
}

function isUpToDate(album, out) {
  if (!fs.existsSync(out)) return false;
  const outTime = fs.statSync(out).mtimeMs;
  const inputs = [album.clip, album.pjPath, OVERRIDES_FILE].filter((f) => fs.existsSync(f));
  return inputs.every((f) => outTime > fs.statSync(f).mtimeMs);
}

async function prepare(album, force) {
  const outDir = path.join(OUT_DIR, album.name);
  const out = path.join(outDir, 'background.mp4');
  const tmp = `${out}.tmp`;
  if (!force && isUpToDate(album, out)) return { status: 'skipped' };

  fs.mkdirSync(outDir, { recursive: true });
  const input = album.kind === 'image'
    ? ['-loop', '1', '-framerate', String(TARGET.fps), '-t', String(IMAGE_LOOP_SECONDS), '-i', album.clip]
    : ['-i', album.clip];
  const started = Date.now();
  const r = await run('ffmpeg', [
    '-hide_banner', '-nostats', '-y', ...input,
    '-map', '0:v:0', '-an',
    '-vf', filterChain(album.cropBottom),
    '-color_range', 'tv',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-movflags', '+faststart',
    '-f', 'mp4', tmp, // .tmp uzantısından format çıkarılamaz
  ]);
  if (r.code !== 0) {
    fs.rmSync(tmp, { force: true });
    return { status: 'error', message: `ffmpeg code=${r.code}: ${lastLines(r.stderr, 3)}` };
  }
  fs.renameSync(tmp, out);
  return { status: 'ok', out, seconds: (Date.now() - started) / 1000 };
}

function scan() {
  if (!fs.existsSync(SOURCE_DIR)) throw new Error(`kaynak klasör yok: ${SOURCE_DIR}`);
  const overrides = loadOverrides();
  const unknown = Object.keys(overrides).filter((n) => !fs.existsSync(path.join(SOURCE_DIR, n)));
  if (unknown.length) console.log(`UYARI: override'da kaynakta olmayan albüm: ${unknown.join(', ')}
`);
  return fs.readdirSync(SOURCE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => inspectAlbum(d.name, overrides))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function analyze(albums) {
  console.log(`kaynak: ${SOURCE_DIR}\n`);
  console.log('| Albüm | Parça | Kaynak | Boyut | cropBottom | Logo sonrası | Oran | 16:9 kırpma kaybı |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const a of albums.filter((x) => !x.skip)) {
    const p = await probeVideo(a.clip);
    if (!p) {
      console.log(`| ${a.name} | ${a.trackCount} | ${a.kind} | OKUNAMADI | | | | |`);
      continue;
    }
    const g = geometry(p.width, p.height, a.cropBottom);
    const src = a.kind === 'image' ? 'görsel' : `video ${p.duration ? p.duration.toFixed(1) + ' sn' : ''}`;
    console.log(`| ${a.name} | ${a.trackCount} | ${src} | ${p.width}×${p.height} | ${a.cropBottom} | ` +
      `${g.afterCrop} | ${g.aspect} | ${g.loss} |`);
  }
  const skipped = albums.filter((x) => x.skip);
  if (skipped.length) {
    console.log('\nATLANAN:');
    for (const s of skipped) console.log(`  ${s.name}: ${s.skip}`);
  }
}

async function prepareAll(albums, only, force) {
  const t0 = Date.now();
  let todo = albums.filter((a) => !a.skip);
  if (only.length) {
    const unknown = only.filter((n) => !albums.some((a) => a.name === n));
    if (unknown.length) throw new Error(`bilinmeyen albüm: ${unknown.join(', ')}`);
    todo = todo.filter((a) => only.includes(a.name));
  }
  for (const s of albums.filter((a) => a.skip && (!only.length || only.includes(a.name)))) {
    console.log(`${s.name} — ATLANDI (geçersiz): ${s.skip}`);
  }

  const counts = { ok: 0, skipped: 0, error: 0 };
  for (const [i, a] of todo.entries()) {
    const tag = `[${i + 1}/${todo.length}] ${a.name} (${a.kind}, cropBottom=${a.cropBottom}${a.overridden ? ' override' : ''})`;
    const res = await prepare(a, force);
    counts[res.status]++;
    if (res.status === 'ok') console.log(`${tag} — OK ${path.relative(ROOT, res.out)}, ${res.seconds.toFixed(1)} sn`);
    else if (res.status === 'skipped') console.log(`${tag} — ATLANDI (güncel çıktı var)`);
    else console.log(`${tag} — HATA: ${res.message}`);
  }
  console.log(`\nÖZET: işlenen ${counts.ok}, güncel ${counts.skipped}, hata ${counts.error}, ` +
    `toplam ${((Date.now() - t0) / 1000).toFixed(1)} sn`);
  if (counts.error) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const albums = scan();
  if (args.includes('--analyze')) return analyze(albums);
  return prepareAll(albums, args.filter((a) => !a.startsWith('--')), args.includes('--force'));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
