// Playlist'teki her parçanın başlığını ayrı bir dosyaya yazar (runtime/overlay/track-001.txt …).
// ffmpeg her parça için bir drawtext kurar: textfile=<bu dosya>, enable=<parçanın zaman aralığı>.
// Dosyalar ffmpeg başlamadan yazılır ve ffmpeg onları açılışta bir kez okur (reload yok) —
// yazma sırasında dosya açık değildir.
// Dosya yazımı dışarıdan verilir (infrastructure: atomik .tmp → rename) — application
// katmanı fs'e doğrudan dokunmaz.
//
// Başlık metni text= yerine dosyadan okunur: başlıktaki : ' , % gibi karakterler için
// drawtext metin kaçışı gerekmez.
//
// Uzun başlık drawtext'te ekrandan taşar ve dinamik font küçültme pratik değil; bu yüzden
// sınırı aşan başlık … ile kısaltılır.

const DEFAULT_MAX_LENGTH = 40;
const ELLIPSIS = '…';

// Uzunluk karakter (code point) olarak sayılır — çok baytlı karakter ortadan bölünmez.
// Kısaltılmış metin, … dahil tam maxLength karakterdir.
function truncateTitle(title, maxLength = DEFAULT_MAX_LENGTH) {
  const chars = [...title];
  if (chars.length <= maxLength) return title;
  return chars.slice(0, maxLength - 1).join('').trimEnd() + ELLIPSIS;
}

class NowPlayingWriter {
  // dir: mutlak klasör yolu; writeFile: (path, content) => void (atomik, klasörü oluşturur)
  constructor({ dir, writeFile, maxLength = DEFAULT_MAX_LENGTH }) {
    if (!Number.isInteger(maxLength) || maxLength < 2) throw new Error(`maxLength en az 2 olmalı (${maxLength})`);
    this.dir = dir;
    this.writeFile = writeFile;
    this.maxLength = maxLength;
  }

  // Başlıkları sırayla track-001.txt, track-002.txt … olarak yazar; dosya yollarını döndürür.
  // Önceki playlist'in fazla dosyaları kalabilir — ffmpeg sadece kendisine verilenleri okur.
  writeAll(titles) {
    return titles.map((title, i) => {
      const file = `${this.dir}/track-${String(i + 1).padStart(3, '0')}.txt`;
      this.writeFile(file, truncateTitle(title, this.maxLength));
      return file;
    });
  }
}

module.exports = { NowPlayingWriter, truncateTitle };
