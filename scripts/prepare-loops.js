// Faz 5.1 — Hazır döngü hazırlama aracı (bir kerelik ön işleme; çalışma zamanı mimarisinin parçası değildir).
// music-source/<albüm>/ içindeki arkaplanı "Saf" görüntü modunun kullanacağı loop.mp4'e çevirir:
// 1280x720, 24 fps, H.264 Main, kapalı GOP (2 sn), B-kare yok, ses yok, süre 2 sn katı.
// Şartname ve doğrulama: scripts/lib/loop-spec.js. Canlı yayına etkisi yok (yalnızca ek dosya yazar).
//
// Kaynak: albümde background.mp4 varsa o, yoksa backgrounds/ içindeki ilk video.
//
// Kullanım:
//   node scripts/prepare-loops.js                       tüm albümler (güncel olanlar atlanır)
//   node scripts/prepare-loops.js <albüm> ...           yalnızca adı verilenler
//   node scripts/prepare-loops.js --analyze             yazmaz, durumu raporlar
//   node scripts/prepare-loops.js --force               güncel çıktıları da yeniden üret
//   node scripts/prepare-loops.js --from <video|resim> --album <ad>
//                                                       orijinal videoyu/resmi doğrudan döngüye çevirir
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const spec = require('./lib/loop-spec');

const ROOT = path.resolve(__dirname, '..');
const MUSIC_DIR = path.join(ROOT, 'music-source');
const LOOP_FILE = 'loop.mp4';
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

const lastLines = (text, n) => text.trim().split(/\r?\n/).slice(-n).join(' | ');
const mtime = (f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : null);

function findSource(albumDir) {
  const single = path.join(albumDir, 'background.mp4');
  if (fs.existsSync(single)) return single;
  const dir = path.join(albumDir, 'backgrounds');
  if (!fs.existsSync(dir)) return null;
  const first = fs.readdirSync(dir).filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase())).sort()[0];
  return first ? path.join(dir, first) : null;
}

function listAlbums() {
  if (!fs.existsSync(MUSIC_DIR)) throw new Error(`music-source klasörü yok: ${MUSIC_DIR}`);
  return fs.readdirSync(MUSIC_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.')) // .staging gibi ara klasörler albüm değildir
    .map((d) => ({ name: d.name, dir: path.join(MUSIC_DIR, d.name), source: findSource(path.join(MUSIC_DIR, d.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function probe(file) {
  const r = await run('ffprobe', spec.PROBE_ARGS(file));
  if (r.code !== 0) return null;
  try { return spec.summarizeProbe(JSON.parse(r.stdout)); } catch { return null; }
}

// Dikişte son kare ile ilk kare benzerliği (düşükse döngü fark edilebilir; hata değil, uyarı).
async function seamSsim(file) {
  const r = await run('ffmpeg', spec.SEAM_ARGS(file));
  return spec.parseSsim(r.stderr);
}

function state(album, out) {
  if (!album.source) return 'KAYNAK YOK';
  const outTime = mtime(out);
  if (outTime == null) return 'YOK';
  return spec.isUpToDate(outTime, [mtime(album.source)]) ? 'GÜNCEL' : 'BAYAT';
}

// Kaynaktan loop.mp4 üretir; şartnameyi doğrulayamazsa çıktıyı yazmaz.
async function build({ input, kind, outDir }) {
  const out = path.join(outDir, LOOP_FILE);
  const tmp = `${out}.tmp`;
  let seconds = spec.SPEC.imageLoopSeconds;
  if (kind === 'video') {
    const src = await probe(input);
    if (!src || !src.duration) return { status: 'error', message: 'kaynak okunamadı' };
    seconds = spec.loopSeconds({ kind, duration: src.duration });
    if (seconds < spec.SPEC.gopSeconds) return { status: 'error', message: `kaynak çok kısa (${src.duration.toFixed(2)} sn)` };
  }
  const started = Date.now();
  const r = await run('ffmpeg', spec.buildLoopArgs({ input, output: tmp, kind, seconds }));
  if (r.code !== 0) {
    fs.rmSync(tmp, { force: true });
    return { status: 'error', message: `ffmpeg code=${r.code}: ${lastLines(r.stderr, 3)}` };
  }
  const problems = spec.validateLoop(await probe(tmp));
  if (problems.length) {
    fs.rmSync(tmp, { force: true });
    return { status: 'error', message: `şartnameye uymuyor: ${problems.join('; ')}` };
  }
  fs.renameSync(tmp, out);
  const ssim = await seamSsim(out);
  return { status: 'ok', out, seconds, took: (Date.now() - started) / 1000, ssim };
}

function reportResult(tag, res) {
  if (res.status === 'error') return console.log(`${tag} — HATA: ${res.message}`);
  const warn = res.ssim != null && res.ssim < spec.SPEC.seamSsimWarn
    ? ` UYARI: dikiş benzerliği ${res.ssim.toFixed(3)} < ${spec.SPEC.seamSsimWarn}, döngü fark edilebilir` : '';
  const ssim = res.ssim != null ? `, dikiş SSIM ${res.ssim.toFixed(3)}` : '';
  console.log(`${tag} — OK ${path.relative(ROOT, res.out)}, ${res.seconds} sn döngü, ${res.took.toFixed(1)} sn${ssim}${warn}`);
}

async function analyze(albums) {
  console.log(`klasör: ${MUSIC_DIR}\n`);
  console.log('| Albüm | Kaynak | loop.mp4 | Şartname |');
  console.log('|---|---|---|---|');
  for (const a of albums) {
    const out = path.join(a.dir, LOOP_FILE);
    const st = state(a, out);
    let verdict = '';
    if (st !== 'YOK' && st !== 'KAYNAK YOK' && fs.existsSync(out)) {
      const problems = spec.validateLoop(await probe(out));
      verdict = problems.length ? `UYMUYOR: ${problems.join('; ')}` : 'uygun';
    }
    console.log(`| ${a.name} | ${a.source ? path.relative(a.dir, a.source) : '-'} | ${st} | ${verdict} |`);
  }
}

async function prepareAll(albums, only, force) {
  const unknown = only.filter((n) => !albums.some((a) => a.name === n));
  if (unknown.length) throw new Error(`bilinmeyen albüm: ${unknown.join(', ')}`);
  const todo = albums.filter((a) => !only.length || only.includes(a.name));
  const counts = { ok: 0, skipped: 0, error: 0 };
  const t0 = Date.now();
  for (const [i, a] of todo.entries()) {
    const tag = `[${i + 1}/${todo.length}] ${a.name}`;
    if (!a.source) {
      counts.error++;
      console.log(`${tag} — HATA: kaynak yok (background.mp4 / backgrounds/*.mp4)`);
      continue;
    }
    if (!force && state(a, path.join(a.dir, LOOP_FILE)) === 'GÜNCEL') {
      counts.skipped++;
      console.log(`${tag} — ATLANDI (güncel loop.mp4 var)`);
      continue;
    }
    const res = await build({ input: a.source, kind: 'video', outDir: a.dir });
    counts[res.status]++;
    reportResult(tag, res);
  }
  console.log(`\nÖZET: işlenen ${counts.ok}, güncel ${counts.skipped}, hata ${counts.error}, toplam ${((Date.now() - t0) / 1000).toFixed(1)} sn`);
  if (counts.error) process.exitCode = 1;
}

async function fromFile(file, albumName) {
  if (!file || !albumName) throw new Error('--from <dosya> ile birlikte --album <ad> gerekli');
  const input = path.resolve(file);
  if (!fs.existsSync(input)) throw new Error(`dosya yok: ${input}`);
  const ext = path.extname(input).toLowerCase();
  const kind = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null;
  if (!kind) throw new Error(`desteklenmeyen tür: ${ext}`);
  const outDir = path.join(MUSIC_DIR, albumName);
  if (!fs.existsSync(outDir)) throw new Error(`albüm yok: ${outDir}`);
  const res = await build({ input, kind, outDir });
  reportResult(`${albumName} (${kind})`, res);
  if (res.status === 'error') process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes('--from')) return fromFile(value('--from'), value('--album'));
  const albums = listAlbums();
  if (args.includes('--analyze')) return analyze(albums);
  const names = args.filter((a) => !a.startsWith('--'));
  return prepareAll(albums, names, args.includes('--force'));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
