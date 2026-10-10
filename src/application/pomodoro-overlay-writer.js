// Pomodoro'nun ekranda görünen iki satırını hazırlar ve ffmpeg'in isteyeceği drawtext
// tarifini üretir. İkisi de SAĞ ÜSTTE, alt alta:
//   1. satır  geri sayım (12:34) — fazın bitişine kalan süre
//   2. satır  durum (STUDY / BREAK) — faz başına bir dosya, kendi zaman aralığında
//
// Geri sayım DOSYAYA YAZILMAZ: saniyede bir değiştiği için metin dosyası yöntemi
// (ffmpeg dosyayı açılışta bir kez okur) burada işlemiyor. Kalan süreyi ffmpeg kendi
// zaman damgasından hesaplıyor; buradan geçen tek şey döngünün ölçüleri
// (PomodoroCycle.countdownFor). Zamanlama yine ffmpeg'in elinde — overlay'in geri
// kalanıyla aynı ilke.
//
// "POMODORO 50+10" etiketi KALDIRILDI (10 Ekim 2026): sağ üst artık sayacın ve durum
// yazısının yeri; türü ekranda tekrarlamanın bilgi değeri yok.
//
// NowPlayingWriter ile aynı desen: dosyalar ffmpeg başlamadan yazılır, ffmpeg açılışta
// bir kez okur (reload yok). Parça başlıkları ayrı dosyalarda, ayrı drawtext'lerde —
// Pomodoro durumu müzik adının yerini almaz (o sol altta kalır).
//
// Dosya yazımı dışarıdan verilir (infrastructure: atomik .tmp → rename).
const { STUDY } = require('../domain/pomodoro');

const STATUS_TEXT = { [STUDY]: 'STUDY', break: 'BREAK' };

// İki satır arasındaki boşluk, punto'ya oranlı: font büyüdükçe satırlar birbirine
// girmesin, küçüldükçe aralarında boşluk kalmasın.
const LINE_GAP_RATIO = 0.25;

class PomodoroOverlayWriter {
  // dir: mutlak klasör yolu; writeFile: (path, content) => void (atomik, klasörü oluşturur)
  // fontSize / position: sayaç ve durum yazısının görünümü — parça başlığından ayrı
  // tutulur ki ikisi üst üste binmesin.
  constructor({ dir, writeFile, fontSize, statusPosition = 'top-right' }) {
    if (!Number.isFinite(fontSize) || fontSize <= 0) throw new Error(`fontSize pozitif olmalı (${fontSize})`);
    this.dir = dir;
    this.writeFile = writeFile;
    this.fontSize = fontSize;
    this.statusPosition = statusPosition;
  }

  // segments: cycle.segmentsFor(...) çıktısı; countdown: cycle.countdownFor(...) çıktısı
  // Dönüş: ffmpeg encoder'ın beklediği pomodoro tarifi.
  write(segments, countdown) {
    const statusTexts = segments.map((segment, i) => {
      const file = `${this.dir}/pomodoro-${String(i + 1).padStart(3, '0')}.txt`;
      this.writeFile(file, STATUS_TEXT[segment.phase]);
      return { textFile: file, start: segment.start, end: segment.end };
    });

    return {
      statusTexts,
      countdown: countdown ?? null,
      fontSize: this.fontSize,
      statusPosition: this.statusPosition,
      lineGap: Math.round(this.fontSize * LINE_GAP_RATIO),
    };
  }
}

module.exports = { PomodoroOverlayWriter, STATUS_TEXT, LINE_GAP_RATIO };
