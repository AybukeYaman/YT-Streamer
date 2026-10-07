// Arkaplan rotasyonu: albümün arkaplan kliplerini, ffmpeg'in video girişine verilecek
// concat listesinin satır sırasına çevirir. Saf — I/O yok, Node modülü import etmez.
//
// Liste TEK bir tur içerir: her klip rotationSeconds'ı dolduracak kadar tekrar edilir.
// Turu sonsuza uzatmak ffmpeg'in işi (-stream_loop -1), bu yüzden yayının ne kadar
// süreceğini bilmemize gerek yok — liste bitince baştan alınır, rotasyon 7/24 döner.
// Aynı dosya tekrar tekrar gösterildiği için diskte çoğaltma da yok.
//
// Tekrar sayısı YUVARLANIR (floor/ceil değil): geçişin klibin ortasına değil döngü
// sınırına düşmesi için. Ortada kesilen bir döngü göze belirgin biçimde batıyor.
// Geçiş sert kesme — yumuşak geçiş concat ile yapılamaz, filtre zinciri gerektirir ve
// 2 vCPU'luk VPS'te encode maliyeti riskli (bkz. KARARLAR.md, arkaplan rotasyonu).

// Klip başına üst sınır. Çok kısa bir klip (2-3 sn) saatlik rotasyonda binlerce satır
// üretir; liste dosyası büyümesin ve concat sınır sayısı kontrolsüz artmasın diye
// tavan var. Tavana vuran klip saatini tam doldurmaz, o kadar — yayın bozulmaz.
const MAX_REPEATS_PER_BACKGROUND = 2000;

class BackgroundRotationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackgroundRotationError';
  }
}

// Bir klibin rotationSeconds'ı doldurması için kaç kez tekrar edileceği. En az 1:
// klip rotasyon süresinden uzunsa bir kez oynar (kırpma YOK — içerik atmanın anlamı yok,
// o klip sadece payına düşenden uzun kalır).
function repeatsFor(durationSeconds, rotationSeconds) {
  const exact = rotationSeconds / durationSeconds;
  return Math.min(MAX_REPEATS_PER_BACKGROUND, Math.max(1, Math.round(exact)));
}

// backgrounds: [{ path, durationSeconds }] — süresi bilinmeyen (null) klip kabul edilmez,
// tekrar sayısı hesaplanamaz. rotationSeconds: her klibin ekranda kalacağı süre.
// Dönüş: concat listesine yazılacak yolların sırası (aynı yol birden çok kez geçer).
function backgroundRotationPaths({ backgrounds, rotationSeconds }) {
  if (!Array.isArray(backgrounds) || backgrounds.length === 0) {
    throw new BackgroundRotationError('arkaplan listesi boş');
  }
  if (!Number.isFinite(rotationSeconds) || rotationSeconds <= 0) {
    throw new BackgroundRotationError(`rotationSeconds pozitif olmalı (${rotationSeconds})`);
  }

  const lines = [];
  for (const bg of backgrounds) {
    if (!bg || typeof bg.path !== 'string' || bg.path.trim() === '') {
      throw new BackgroundRotationError('arkaplan yolu yok');
    }
    if (!Number.isFinite(bg.durationSeconds) || bg.durationSeconds <= 0) {
      throw new BackgroundRotationError(`"${bg.path}": süre bilinmiyor, rotasyon hesaplanamaz`);
    }
    const repeats = repeatsFor(bg.durationSeconds, rotationSeconds);
    for (let i = 0; i < repeats; i++) lines.push(bg.path);
  }
  return lines;
}

module.exports = {
  backgroundRotationPaths,
  repeatsFor,
  BackgroundRotationError,
  MAX_REPEATS_PER_BACKGROUND,
};
