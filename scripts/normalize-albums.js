// Faz 8.2 — Albüm bazlı müzik normalizasyonu ve başlık temizliği (bir kerelik ön işleme aracı)
// videolar/<albüm>/audio/ içindeki dosyaları okur (değiştirmez), normalize edip
// music-source/<albüm>/music/<temiz başlık>.m4a yazar. Normalizasyon Faz 2.5'teki
// yöntemle aynı (normalize.js: loudnorm ölçümü → sabit kazanç → alimiter).
//
// Hangi albümler: music-source/ altında klasörü olanlar — yani prepare-backgrounds.js'in
// geçerli bulup arkaplanını ürettikleri. Parça listesi project.json'dan değil audio/ klasörünün
// gerçek içeriğinden gelir (project.json'daki liste güvenilir değil).
//
// Başlık = dosya adı (Track.title dosya adından türetiliyor). Üretici imzaları ([usesuno.com]
// gibi köşeli parantez içindeki alan adları) temizlenir; (Take 2) gibi etiketler korunur.
// Sondaki _1, _2 versiyon ekleri: başlığın tek versiyonu varsa ek düşer; birden fazlaysa
// ek sırasına göre ilki düz başlık, sonrakiler (II), (III) ... olur (eksiz olan en önde).
// Artık plana karşılık gelmeyen eski çıktılar (örn. önceki _1 adlı dosya) silinir.
//
// Kullanım:
//   node scripts/normalize-albums.js                 tüm albümler
//   node scripts/normalize-albums.js <albüm> ...     sadece adı verilenler
const fs = require('fs');
const path = require('path');
const { normalizeFile, AUDIO_EXT, kb } = require('./normalize');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.resolve(ROOT, '..', 'videolar');
const OUT_DIR = path.join(ROOT, 'music-source');

// Köşeli parantez içinde alan adı: [usesuno.com], [udio.ai] ...
const SIGNATURE = /\s*\[[^\]]*\.(?:com|ai|io|net|org|app)\]/gi;

const VERSION_SUFFIX = /_(\d+)$/;
const ROMAN = ['', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

function cleanTitle(stemName) {
  return stemName.replace(SIGNATURE, '').replace(/\s{2,}/g, ' ').trim();
}

// İmzası temizlenmiş başlığı taban ada ve versiyon numarasına ayırır (eksiz = 0).
function splitVersion(title) {
  const m = title.match(VERSION_SUFFIX);
  return m ? { base: title.slice(0, m.index).trim(), version: Number(m[1]) } : { base: title, version: 0 };
}

// Dosyaları hedef başlıklara eşler. Taban adı aynı olanlar tek grup (Windows büyük/küçük harf
// duyarsız → lowercase). Boş başlık ve aynı versiyon numarasının iki kez geçmesi atlanır.
function planAlbum(files) {
  const groups = new Map();
  for (const f of files) {
    const { base, version } = splitVersion(cleanTitle(path.basename(f, path.extname(f))));
    const key = base.toLowerCase();
    groups.set(key, [...(groups.get(key) || []), { file: f, base, version }]);
  }
  const plan = [];
  const rejected = [];
  for (const [key, g] of groups) {
    const dupVersion = g.some((x, i) => g.findIndex((y) => y.version === x.version) !== i);
    if (!key) rejected.push(...g.map((x) => ({ file: x.file, reason: 'temizlik sonrası başlık boş' })));
    else if (dupVersion || g.length > ROMAN.length) {
      rejected.push(...g.map((x) => ({ file: x.file, reason: `çakışma: "${x.base}"` })));
    } else {
      g.sort((a, b) => a.version - b.version);
      g.forEach((x, i) => plan.push({ file: x.file, title: i ? `${x.base} (${ROMAN[i]})` : x.base }));
    }
  }
  return { plan, rejected };
}

function albums(only) {
  const all = fs.readdirSync(OUT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  if (!only.length) return all.sort();
  const unknown = only.filter((n) => !all.includes(n));
  if (unknown.length) throw new Error(`music-source/'ta olmayan albüm (önce prepare-backgrounds.js): ${unknown.join(', ')}`);
  return only;
}

async function normalizeAlbum(name) {
  const audioDir = path.join(SOURCE_DIR, name, 'audio');
  const outDir = path.join(OUT_DIR, name, 'music');
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs.readdirSync(audioDir).filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase())).sort();
  const { plan, rejected } = planAlbum(files);

  console.log(`\n## ${name}: ${files.length} dosya, işlenecek ${plan.length}, atlanan ${rejected.length}`);
  for (const r of rejected) console.log(`  ATLANDI ${r.file} — ${r.reason}`);

  const counts = { ok: 0, skipped: 0, error: 0, renamed: 0 };
  for (const [i, { file, title }] of plan.entries()) {
    const renamed = title !== path.basename(file, path.extname(file));
    if (renamed) counts.renamed++;
    const tag = `  [${String(i + 1).padStart(3)}/${plan.length}] ${file}${renamed ? `  →  ${title}.m4a` : ''}`;
    const res = await normalizeFile(path.join(audioDir, file), path.join(outDir, `${title}.m4a`));
    counts[res.status]++;
    if (res.status === 'ok') {
      console.log(`${tag} — OK ${res.inputI.toFixed(2)} LUFS → ${res.gainDb >= 0 ? '+' : ''}${res.gainDb} dB, ` +
        `${kb(res.newSize)}, ${res.seconds.toFixed(1)} sn`);
    } else if (res.status === 'skipped') console.log(`${tag} — güncel`);
    else console.log(`${tag} — HATA: ${res.message}`);
  }

  // Bu script'in ürettiği klasör: plana karşılık gelmeyen .m4a eski adlandırmadan kalmıştır.
  const expected = new Set(plan.map((p) => `${p.title}.m4a`.toLowerCase()));
  for (const f of fs.readdirSync(outDir)) {
    if (f.toLowerCase().endsWith('.m4a') && !expected.has(f.toLowerCase())) {
      fs.rmSync(path.join(outDir, f));
      console.log(`  SİLİNDİ (eski çıktı) ${f}`);
    }
  }
  return { ...counts, rejected: rejected.length };
}

async function main() {
  const t0 = Date.now();
  const total = { ok: 0, skipped: 0, error: 0, renamed: 0, rejected: 0 };
  for (const name of albums(process.argv.slice(2).filter((a) => !a.startsWith('--')))) {
    const c = await normalizeAlbum(name);
    for (const k of Object.keys(total)) total[k] += c[k];
  }
  console.log(`\nÖZET: işlenen ${total.ok}, güncel ${total.skipped}, hata ${total.error}, ` +
    `başlığı temizlenen ${total.renamed}, atlanan ${total.rejected}, ${((Date.now() - t0) / 1000).toFixed(1)} sn`);
  if (total.error) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { cleanTitle, planAlbum };
