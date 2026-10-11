// /config sayfasından (telefon galerisinden) yüklenen kapak görselini işler ve assets/covers/
// altına yayın formatında kaydeder.
//
// NEDEN YENİDEN KODLANIYOR (olduğu gibi kaydedilmiyor):
//   - YouTube thumbnails.set yalnızca JPEG/PNG kabul eder ve 2 MB'ın üstünü reddeder. Telefon
//     fotoğrafı 3-8 MB; olduğu gibi kaydedilse go-live küçük resmi sessizce yükleyemezdi
//     (küçük resim kritik değil: yalnızca uyarı loglanır, yayın küçük resimsiz çıkardı).
//   - WebP YouTube'a gitmez; JPEG'e çevrilir. Tek biçim = tek davranış.
//   - Çıktı her zaman 1280x720 JPEG (YouTube'un önerdiği küçük resim boyutu).
// Dosya türü UZANTIDAN/Content-Type'tan DEĞİL ilk baytlardan (magic bytes) anlaşılır: istemci
// beyanı güvenilmez, ffmpeg'e yalnızca gerçekten görsel olan dosya verilir.
const fs = require('fs');
const path = require('path');
const { run } = require('./clip-normalizer');

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // yükleme sınırı (ham dosya)
const MAX_OUTPUT_BYTES = 1900 * 1024; // YouTube sınırı 2 MB; payı bırak
const QUALITIES = [3, 6, 10]; // ffmpeg mjpeg -q:v (küçük = kaliteli); sığana kadar düşer

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

class CoverUploadError extends Error {}

// buffer: ham dosya. dir: assets/covers. Dönüş: kaydedilen JPEG'in mutlak yolu.
// Atar: CoverUploadError (kullanıcıya gösterilecek Türkçe mesaj).
async function saveUploadedCover({
  buffer, dir, now = () => Date.now(), runFn = run, log = null,
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new CoverUploadError('dosya boş');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new CoverUploadError(`dosya çok büyük (en fazla ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB)`);
  }
  const type = detectImageType(buffer);
  if (!type) {
    throw new CoverUploadError('desteklenmeyen biçim — JPEG, PNG ya da WebP görsel seç (iPhone HEIC ise "En Uyumlu" biçimde çek)');
  }

  fs.mkdirSync(dir, { recursive: true });
  const stamp = now();
  const input = path.join(dir, `.yukleme-${stamp}.${type}`);
  const out = path.join(dir, `galeri-${stamp}.jpg`);
  const tmpOut = path.join(dir, `.galeri-${stamp}.tmp.jpg`);
  fs.writeFileSync(input, buffer);
  try {
    for (const q of QUALITIES) {
      const result = await runFn('ffmpeg', [
        '-hide_banner', '-v', 'error', '-y', '-threads', '1',
        '-i', input, '-frames:v', '1',
        '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1',
        '-pix_fmt', 'yuvj420p', '-q:v', String(q), tmpOut,
      ]);
      if (result.code !== 0) {
        log?.warn?.(`kapak dönüştürülemedi: ${(result.stderr || '').trim().split(/\r?\n/).slice(-1)[0]}`);
        throw new CoverUploadError('görsel işlenemedi — dosya bozuk olabilir');
      }
      if (fs.statSync(tmpOut).size <= MAX_OUTPUT_BYTES) {
        fs.renameSync(tmpOut, out);
        return out;
      }
    }
    throw new CoverUploadError('görsel küçültülemedi (YouTube sınırı 2 MB) — daha sade bir görsel dene');
  } finally {
    fs.rmSync(input, { force: true });
    fs.rmSync(tmpOut, { force: true });
  }
}

module.exports = {
  saveUploadedCover, detectImageType, CoverUploadError, MAX_UPLOAD_BYTES, MAX_OUTPUT_BYTES,
};
