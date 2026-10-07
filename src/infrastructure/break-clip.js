// Pomodoro mola görselini yayına hazır klibe çevirir ve runtime/break-background.mp4
// olarak saklar.
//
// Kullanıcı config'e HAM dosya veriyor (jpg, png, mp4 — ne varsa). Elle ön işleme
// yaptırmıyoruz: dönüşüm açılışta bir kez yapılır ve sonucu önbelleğe alınır.
// Böylece "mola görselini değiştir" demek, config'de yolu değiştirmekten ibaret.
//
// Önbellek geçerliliği kaynağın boyut+mtime'ı: görsel değişirse yeniden üretilir,
// değişmediyse her açılışta tekrar kodlanmaz (bir klip ~3-5 sn sürüyor, yayının
// açılışını o kadar geciktirmenin anlamı yok).
//
// Dönüşüm mantığı clip-normalizer'da — arkaplan havuzuyla BİREBİR aynı çıktı.
// Mola klibi de 1280x720/24/SAR 1:1 olmak zorunda: ffmpeg'e ikinci video girişi
// olarak giriyor ve ana arkaplanın üstüne overlay'leniyor.
const fs = require('fs');
const path = require('path');
const { convertAny, isSupported } = require('./clip-normalizer');

const OUTPUT_NAME = 'break-background.mp4';
const META_NAME = 'break-background.json';

// Dönüşümü gerekiyorsa yapar, hazır klibin yolunu döndürür. Hazırlanamazsa null —
// mola görseli olmaması yayını ENGELLEMEZ, sadece molada normal arkaplan kalır.
async function ensureBreakClip({ sourcePath, runtimeDir, log }) {
  if (!sourcePath) return null;
  if (!fs.existsSync(sourcePath)) {
    log.warn(`mola görseli bulunamadı: ${sourcePath} — molada normal arkaplan kalacak`);
    return null;
  }
  if (!isSupported(sourcePath)) {
    log.warn(`mola görseli desteklenmeyen tür: ${path.basename(sourcePath)} — molada normal arkaplan kalacak`);
    return null;
  }

  const out = path.join(runtimeDir, OUTPUT_NAME);
  const metaFile = path.join(runtimeDir, META_NAME);
  const stat = fs.statSync(sourcePath);
  const stamp = { source: sourcePath, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };

  if (fs.existsSync(out)) {
    try {
      const saved = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (saved.source === stamp.source && saved.size === stamp.size && saved.mtimeMs === stamp.mtimeMs) {
        return out;
      }
    } catch {
      // Meta okunamadı: yeniden üret, zararı bir kodlama.
    }
  }

  log.info(`mola görseli hazırlanıyor: ${path.basename(sourcePath)}`);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const result = await convertAny(sourcePath, out);
  if (!result.ok) {
    log.warn(`mola görseli hazırlanamadı: ${result.stderr.trim().split(/\r?\n/).slice(-1)[0]}`);
    return null;
  }
  try {
    fs.writeFileSync(metaFile, JSON.stringify(stamp));
  } catch (err) {
    // Meta yazılamazsa sadece her açılışta yeniden kodlanır.
    log.warn(`mola görseli bilgisi yazılamadı: ${err.message}`);
  }
  log.info(`mola görseli hazır: ${result.seconds} sn (${result.note})`);
  return out;
}

module.exports = { ensureBreakClip, OUTPUT_NAME };
