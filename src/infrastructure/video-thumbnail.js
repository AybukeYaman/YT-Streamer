// /config sayfasında (Faz N2) klip listesinin yanında küçük bir önizleme karesi
// göstermek için: ffmpeg ile TEK kare alınır, küçük ölçekte (160px genişlik) JPEG'e
// çevrilir. Kullanıcı isteği üzerine eklendi — v1 planında yoktu.
//
// Önbellek anahtarı kaynağın boyut+mtime'ı (break-clip.js ile AYNI ilke — tek kaynak
// olması gereken bir deseni ikinci kez yazmamak için buraya da KOPYALANDI, çünkü
// break-clip.js study/break klibi, bu dosya herhangi bir klip/görsel için çalışıyor,
// farklı sözleşmeler). Dosya adı kaynağın TAM YOLUNUN sha1'i: aynı ada sahip iki farklı
// klip (örn. "mimi/break.mp4" ile "assets/break.mp4") çarpışmaz, Türkçe/özel karakterli
// dosya adları da sorun çıkarmaz.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { IMAGE_EXT } = require('./media-library');
const { lowerPriority } = require('./clip-normalizer');

const THUMB_WIDTH = 160;
const SEEK_SECONDS = 1; // çoğu klip bundan uzun; daha fazlası gerekmiyor

function hashOf(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex');
}

// ffmpeg argümanlarını kurar — SAF (I/O yok), bu yüzden ffmpeg çalıştırmadan test edilir.
// Görsellerde -ss/-frames YOK: tek kareli bir girişte "1 sn'ye atla" isteği 0 kare
// üretir (görselin tek karesi t=0'da), video sorgularken olduğu gibi.
function buildThumbnailArgs(sourcePath, out) {
  const isImage = IMAGE_EXT.has(path.extname(sourcePath).toLowerCase());
  return [
    '-hide_banner', '-v', 'error', '-y', '-threads', '1',
    ...(isImage ? [] : ['-ss', String(SEEK_SECONDS)]),
    '-i', sourcePath,
    ...(isImage ? [] : ['-frames:v', '1']),
    '-vf', `scale=${THUMB_WIDTH}:-2`, // -2: en-boy oranını koru, yükseklik çift sayı olsun (mjpeg şartı)
    '-q:v', '5',
    out,
  ];
}

// spawnFn: testlerde gerçek süreç açmadan sahte bir child vermek için (ffmpeg-encoder.js
// ile aynı desen) — shell:true kullanmak yerine (dosya yollarını kaçışsız bırakıp komut
// enjeksiyonuna açardı) enjeksiyon tercih edildi.
function run(ffmpegPath, args, spawnFn) {
  return new Promise((resolve) => {
    const child = spawnFn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    lowerPriority(child); // canlı yayını aç bırakma: önizleme en düşük öncelikte çalışır
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => resolve({ ok: false, message: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, message: stderr.trim().split(/\r?\n/).slice(-1)[0] }));
  });
}

// Önizlemeler SIRAYLA üretilir (aynı anda en fazla bir ffmpeg). Eskiden sayfa açılınca her
// klip/kapak için ayrı bir ffmpeg aynı anda başlıyordu: soğuk önbellekte onlarca süreç,
// 3 çekirdekli VPS'te canlı yayını açlığa itiyordu. Aynı dosya için gelen eşzamanlı
// istekler (sayfa yenileme) tek üretimi paylaşır.
let queue = Promise.resolve();
const inFlight = new Map();

function enqueue(key, task) {
  if (inFlight.has(key)) return inFlight.get(key);
  const result = queue.then(task, task).finally(() => inFlight.delete(key));
  queue = result.catch(() => {});
  inFlight.set(key, result);
  return result;
}

// sourcePath: klip ya da görsel (MediaLibrary.videos()/covers()'tan gelen herhangi bir
// yol). runtimeDir: config.paths.runtime. Dönüş: önizleme JPEG'inin mutlak yolu,
// üretilemezse null — sayfa resimsiz kalır, KIRILMAZ (aynı ilke break-clip.js'te).
async function ensureThumbnail({ sourcePath, runtimeDir, ffmpegPath = 'ffmpeg', spawnFn = spawn, log }) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const dir = path.join(runtimeDir, 'thumbnails');
  const key = hashOf(sourcePath);
  const out = path.join(dir, `${key}.jpg`);
  const metaFile = path.join(dir, `${key}.json`);
  const stat = fs.statSync(sourcePath);
  const stamp = { source: sourcePath, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };

  if (fs.existsSync(out)) {
    try {
      const saved = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (saved.source === stamp.source && saved.size === stamp.size && saved.mtimeMs === stamp.mtimeMs) {
        return out;
      }
    } catch {
      // meta okunamadı: yeniden üret, zararı bir kare çıkarma.
    }
  }

  return enqueue(key, async () => {
    fs.mkdirSync(dir, { recursive: true });
    const result = await run(ffmpegPath, buildThumbnailArgs(sourcePath, out), spawnFn);
    if (!result.ok) {
      log.warn(`önizleme üretilemedi (${path.basename(sourcePath)}): ${result.message || 'bilinmeyen hata'}`);
      return null;
    }
    try {
      fs.writeFileSync(metaFile, JSON.stringify(stamp));
    } catch (err) {
      log.warn(`önizleme bilgisi yazılamadı: ${err.message}`);
    }
    return out;
  });
}

module.exports = { ensureThumbnail, buildThumbnailArgs, hashOf, THUMB_WIDTH };
