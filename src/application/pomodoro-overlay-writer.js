// Pomodoro'nun ekranda görünen iki metnini dosyaya yazar ve ffmpeg'in isteyeceği
// drawtext tarifini üretir:
//   durum  — faz başına bir dosya (STUDY / BREAK), kendi zaman aralığında görünür
//   etiket — tek dosya (POMODORO 50+10), çalıştırma boyunca hep ekranda
//
// NowPlayingWriter ile aynı desen: dosyalar ffmpeg başlamadan yazılır, ffmpeg açılışta
// bir kez okur (reload yok). Parça başlıkları ayrı dosyalarda, ayrı drawtext'lerde —
// Pomodoro durumu müzik adının yerini almaz, yanında durur.
//
// Dosya yazımı dışarıdan verilir (infrastructure: atomik .tmp → rename).
const { STUDY } = require('../domain/pomodoro');

const STATUS_TEXT = { [STUDY]: 'STUDY', break: 'BREAK' };

class PomodoroOverlayWriter {
  // dir: mutlak klasör yolu; writeFile: (path, content) => void (atomik, klasörü oluşturur)
  // fontSize / statusPosition / labelPosition: durum yazısının görünümü — parça
  // başlığından ayrı tutulur ki ikisi üst üste binmesin.
  constructor({ dir, writeFile, fontSize, statusPosition = 'center', labelPosition = 'top-right' }) {
    if (!Number.isFinite(fontSize) || fontSize <= 0) throw new Error(`fontSize pozitif olmalı (${fontSize})`);
    this.dir = dir;
    this.writeFile = writeFile;
    this.fontSize = fontSize;
    this.statusPosition = statusPosition;
    this.labelPosition = labelPosition;
  }

  // cycle: PomodoroCycle; segments: cycle.segmentsFor(...) çıktısı
  // Dönüş: ffmpeg encoder'ın beklediği pomodoro tarifi.
  write(cycle, segments) {
    const statusTexts = segments.map((segment, i) => {
      const file = `${this.dir}/pomodoro-${String(i + 1).padStart(3, '0')}.txt`;
      this.writeFile(file, STATUS_TEXT[segment.phase]);
      return { textFile: file, start: segment.start, end: segment.end };
    });
    const labelTextFile = `${this.dir}/pomodoro-label.txt`;
    this.writeFile(labelTextFile, cycle.label);

    return {
      statusTexts,
      labelTextFile,
      fontSize: this.fontSize,
      statusPosition: this.statusPosition,
      labelPosition: this.labelPosition,
    };
  }
}

module.exports = { PomodoroOverlayWriter, STATUS_TEXT };
