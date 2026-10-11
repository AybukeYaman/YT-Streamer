// Albüm: ad, arkaplan(lar), parçalar. Bir playlist (restart döngüsü) tek albümden oluşur,
// arkaplan albüm sınırında değişir. Saf veri nesnesi — I/O yok, Node modülü import etmez.
//
// Arkaplan iki biçimde verilebilir:
//   backgroundPath: 'x.mp4'                              tek arkaplan (eski düzen)
//   backgrounds: [{ path, durationSeconds }, ...]         çoğul — yayında saatlik rotasyon
// İkisi de aynı yere normalize edilir: this.backgrounds her zaman dizi, this.backgroundPath
// her zaman ilk klip. Böylece tek arkaplanlı eski albümleri okuyan kod değişmeden çalışır.
// Rotasyon yalnızca birden çok klip varken devreye girer (bkz. background-rotation.js).

class AlbumError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AlbumError';
  }
}

// Girişi tek biçime indirger. Süre yalnızca çoğul düzende gerekli (rotasyon hesabı);
// tek arkaplanda null kalır — ffprobe çağrısı boşa yapılmasın.
function normalizeBackgrounds({ name, backgroundPath, backgrounds }) {
  if (backgrounds !== undefined) {
    if (!Array.isArray(backgrounds) || backgrounds.length === 0) {
      throw new AlbumError(`"${name}": arkaplan listesi boş`);
    }
    return backgrounds.map((bg) => {
      if (!bg || typeof bg.path !== 'string' || bg.path.trim() === '') {
        throw new AlbumError(`"${name}": arkaplan yolu yok`);
      }
      const duration = bg.durationSeconds;
      if (duration !== null && duration !== undefined
        && (!Number.isFinite(duration) || duration <= 0)) {
        throw new AlbumError(`"${name}": geçersiz arkaplan süresi (${bg.path}: ${duration})`);
      }
      return Object.freeze({ path: bg.path, durationSeconds: duration ?? null });
    });
  }
  if (typeof backgroundPath !== 'string' || backgroundPath.trim() === '') {
    throw new AlbumError(`"${name}": arkaplan yolu yok`);
  }
  return [Object.freeze({ path: backgroundPath, durationSeconds: null })];
}

class Album {
  constructor({ name, backgroundPath, backgrounds, tracks, loopPath = null }) {
    if (typeof name !== 'string' || name.trim() === '') throw new AlbumError(`geçersiz albüm adı (${name})`);
    if (!Array.isArray(tracks) || tracks.length === 0) throw new AlbumError(`"${name}": hiç parça yok`);
    this.name = name;
    this.backgrounds = Object.freeze(normalizeBackgrounds({ name, backgroundPath, backgrounds }));
    // Tek arkaplan bekleyen çağrı yolları için (rotasyon kapalıyken encoder bunu kullanır).
    this.backgroundPath = this.backgrounds[0].path;
    // Hazır döngü (loop.mp4, Saf mod): yoksa null. Arkaplandan bağımsız, yalnızca video.mode=copy kullanır.
    if (loopPath !== null && (typeof loopPath !== 'string' || loopPath.trim() === '')) {
      throw new AlbumError(`"${name}": geçersiz döngü yolu`);
    }
    this.loopPath = loopPath;
    this.tracks = Object.freeze([...tracks]);
    Object.freeze(this);
  }

  // Rotasyon ancak birden çok klip varsa anlamlı; tek klipte liste yazmanın faydası yok.
  get rotates() {
    return this.backgrounds.length > 1;
  }
}

module.exports = { Album, AlbumError };
