// Elle arkaplan ekleme aracı. Ham video/görselleri yayın sözleşmesine uygun kliplere
// çevirip music-source/<albüm>/backgrounds/ altına yazar. Çalışma zamanı mimarisinin
// (src/) parçası değildir — prepare-backgrounds.js ile aynı statüde, bir kerelik araç.
//
// Normalde paketi Automation tarafı üretir; bu araç elde hazır duran dosyaları
// beklemeden eklemek için. Çıktı formatı birebir aynı olduğu için iki taraf çakışmaz.
//
// Sözleşme (concat demuxer girdilerin BİREBİR aynı olmasını şart koşar):
//   h264, 1280x720, 24 fps, yuv420p, SAR 1:1, ses YOK, süre 10-60 sn
//
// Dönüşüm: en-boy oranını koruyarak 1280x720'yi kaplayacak kadar ölçekle → taşanı
// ortadan kırp (esnetme yok, siyah bant yok) → sesi at → SAR'ı 1:1'e sabitle.
//   kısa klip (<10 sn): bant alt sınırına kadar döngüye sokulur
//   görsel: yavaş ileri-geri zoom (Ken Burns) ile 15 sn'lik klip — durağan kare bir
//           saat boyunca "yayın dondu" gibi duruyor. Zoom kosinüs eğrisiyle başladığı
//           yere döner, yani klip kendi içinde dikişsiz: her 15 sn'de sıçrama olmaz.
//
// Yazma atomik: önce .staging-backgrounds/, bitince tek rename. music-source/ canlı
// okunan bir dizin — yarım yazılmış klasör yayına eksik albüm olarak girebilir.
//
// Kullanım:
//   node scripts/add-backgrounds.js <kaynak> <albüm>        kaynak: dosya ya da klasör
//   node scripts/add-backgrounds.js <kaynak> <albüm> --analyze    sadece raporla
const fs = require('fs');
const path = require('path');
const {
  TARGET, IMAGE_SECONDS, VIDEO_EXT, IMAGE_EXT, probe, convertVideo, convertImage, isImage,
} = require('../src/infrastructure/clip-normalizer');

const ROOT = path.resolve(__dirname, '..');
const ALBUMS_DIR = path.join(ROOT, 'music-source');

const lastLines = (text, n) => text.trim().split(/\r?\n/).slice(-n).join(' | ');

// Üretim sonrası denetim: mutlak değerlerden çok BİRBİRİYLE tutarlılık önemli —
// concat'i kıran sapmadır. Sapan varsa hata, uyarı değil.
async function verifyConsistency(files) {
  const key = (p) => `${p.width}x${p.height} ${p.pixelFormat} SAR=${p.sar} ${p.fps}`;
  const seen = new Map();
  for (const file of files) {
    const info = await probe(file);
    if (!info) return { ok: false, reason: `${path.basename(file)}: okunamadı` };
    if (info.hasAudio) return { ok: false, reason: `${path.basename(file)}: ses var` };
    if (info.width !== TARGET.width || info.height !== TARGET.height) {
      return { ok: false, reason: `${path.basename(file)}: ${info.width}x${info.height}` };
    }
    seen.set(key(info), [...(seen.get(key(info)) || []), path.basename(file)]);
  }
  if (seen.size > 1) {
    const groups = [...seen.entries()].map(([k, v]) => `${k} → ${v.join(', ')}`).join(' // ');
    return { ok: false, reason: `klipler birbiriyle tutarsız: ${groups}` };
  }
  return { ok: true, shape: [...seen.keys()][0] };
}

function listSources(target) {
  const stat = fs.statSync(target);
  const files = stat.isDirectory()
    ? fs.readdirSync(target).map((f) => path.join(target, f)).sort((a, b) => a.localeCompare(b))
    : [target];
  return files.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return VIDEO_EXT.has(ext) || IMAGE_EXT.has(ext);
  });
}

// Çıktı adı: NN-<sadeleştirilmiş kaynak adı>.mp4. Ekranda görünmüyor (parça adlarından
// farklı), sıralama deterministik olsun diye numaralı.
const outputName = (index, src) => `${String(index + 1).padStart(2, '0')}-${
  path.basename(src, path.extname(src))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}.mp4`;

async function main() {
  const [, , source, album, ...rest] = process.argv;
  const analyzeOnly = rest.includes('--analyze');
  if (!source || !album) {
    console.error('kullanım: node scripts/add-backgrounds.js <kaynak> <albüm> [--analyze]');
    process.exit(2);
  }
  if (!fs.existsSync(source)) {
    console.error(`kaynak yok: ${source}`);
    process.exit(2);
  }
  const albumDir = path.join(ALBUMS_DIR, album);
  if (!fs.existsSync(albumDir)) {
    console.error(`albüm yok: ${albumDir}`);
    process.exit(2);
  }

  const sources = listSources(source);
  if (!sources.length) {
    console.error('işlenecek video/görsel bulunamadı');
    process.exit(2);
  }

  console.log(`kaynak: ${sources.length} dosya → albüm "${album}"\n`);
  const plans = [];
  for (const src of sources) {
    const ext = path.extname(src).toLowerCase();
    const isImage = IMAGE_EXT.has(ext);
    const info = await probe(src);
    if (!info) {
      console.log(`  ATLANDI  ${path.basename(src)} — okunamadı`);
      continue;
    }
    plans.push({ src, isImage, info });
    const dur = isImage ? `${IMAGE_SECONDS} sn üretilecek` : `${info.durationSeconds.toFixed(1)} sn`;
    console.log(`  ${path.basename(src)}`);
    console.log(`     ${info.width}x${info.height} ${info.pixelFormat} SAR=${info.sar} ${dur}${info.hasAudio ? ' (ses atılacak)' : ''}`);
  }
  if (!plans.length) process.exit(1);
  if (analyzeOnly) {
    console.log('\n--analyze: hiçbir şey yazılmadı.');
    return;
  }

  // Atomik yazma: canlı okunan dizine yarım klasör düşmesin.
  const staging = path.join(albumDir, '.staging-backgrounds');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  console.log('\ndönüştürülüyor…');
  const written = [];
  for (const [i, plan] of plans.entries()) {
    const out = path.join(staging, outputName(i, plan.src));
    const result = plan.isImage
      ? await convertImage(plan.src, out)
      : await convertVideo(plan.src, out, plan.info);
    if (!result.ok) {
      console.error(`  HATA  ${path.basename(plan.src)} — ${lastLines(result.stderr, 2)}`);
      fs.rmSync(staging, { recursive: true, force: true });
      process.exit(1);
    }
    written.push(out);
    const size = (fs.statSync(out).size / 1e6).toFixed(1);
    console.log(`  ✓ ${path.basename(out)} — ${result.seconds} sn, ${size} MB (${result.note})`);
  }

  const check = await verifyConsistency(written);
  if (!check.ok) {
    console.error(`\nDENETİM BAŞARISIZ: ${check.reason}`);
    fs.rmSync(staging, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`\ndenetim tamam — hepsi aynı: ${check.shape}, ses yok`);

  const final = path.join(albumDir, 'backgrounds');
  // Var olan backgrounds/ yerine geçerken önce yedek adına al: rename başarısız olursa
  // albüm arkaplansız kalmasın.
  const backup = `${final}.eski`;
  if (fs.existsSync(final)) fs.renameSync(final, backup);
  fs.renameSync(staging, final);
  if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
  console.log(`yazıldı: ${final} (${written.length} klip)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
