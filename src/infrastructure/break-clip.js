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
// Pomodoro'nun ÇALIŞMA fanında gösterilecek klip de aynı yoldan geçer (TUI'da "study
// video"): sözleşme birebir aynı (1280x720/24/SAR 1:1, sessiz) ve önbellek mantığı da.
// İki ayrı dönüşüm yazmak, bir gün birinin kaymasına ve concat'in sessizce bozulmasına
// yol açardı — o yüzden tek işlev, farkı yalnızca çıktı dosyasının adı.
const STUDY_OUTPUT_NAME = 'study-background.mp4';

// Dönüşümü gerekiyorsa yapar, hazır klibin yolunu döndürür. Hazırlanamazsa null —
// görsel olmaması yayını ENGELLEMEZ (molada/çalışmada normal arkaplan kalır).
// name: çıktı dosyasının adı (uzantısız); meta dosyası aynı adı kullanır.
// Çıktı adı → log etiketi. Çağıranın ayrıca etiket geçmesi gerekmesin: StreamConfigService
// yalnızca 'name' biliyor ve iki klibi aynı işlevle hazırlıyor; etiket burada çözülmezse
// çalışma klibi loga "mola görseli" diye düşüyordu.
const CLIP_LABELS = Object.freeze({
  'break-background': 'mola görseli',
  'study-background': 'çalışma görseli',
});

async function ensureStreamClip({ sourcePath, runtimeDir, log, name = 'break-background', label = null }) {
  const clipLabel = label ?? CLIP_LABELS[name] ?? name;
  if (!sourcePath) return null;
  if (!fs.existsSync(sourcePath)) {
    log.warn(`${clipLabel} bulunamadı: ${sourcePath} — normal arkaplan kalacak`);
    return null;
  }
  if (!isSupported(sourcePath)) {
    log.warn(`${clipLabel} desteklenmeyen tür: ${path.basename(sourcePath)} — normal arkaplan kalacak`);
    return null;
  }

  const out = path.join(runtimeDir, `${name}.mp4`);
  const metaFile = path.join(runtimeDir, `${name}.json`);
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

  log.info(`${clipLabel} hazırlanıyor: ${path.basename(sourcePath)}`);
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
    log.warn(`${clipLabel} bilgisi yazılamadı: ${err.message}`);
  }
  log.info(`${clipLabel} hazır: ${result.seconds} sn (${result.note})`);
  return out;
}

// Mevcut çağıranlar (index.js, testler) için ince sarmalayıcı — davranış değişmedi.
const ensureBreakClip = (args) => ensureStreamClip({ ...args, name: 'break-background' });

// Pomodoro çalışma fanının arkaplanı.
const ensureStudyClip = (args) => ensureStreamClip({ ...args, name: 'study-background' });

module.exports = {
  ensureStreamClip, ensureBreakClip, ensureStudyClip, CLIP_LABELS,
  OUTPUT_NAME, STUDY_OUTPUT_NAME, META_NAME,
};
