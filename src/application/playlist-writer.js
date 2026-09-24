// Kuyruktan batchSize kadar parça çekip ffmpeg concat demuxer formatında playlist yazar.
// Dosya yazımı dışarıdan verilir (infrastructure: atomik .tmp → rename) — application
// katmanı fs'e doğrudan dokunmaz.

// concat formatı: file '<yol>' — Windows'ta düz bölü (Faz 3.1'de doğrulandı).
// Yoldaki tek tırnak concat'in kaçış kuralıyla yazılır: ' → '\''
function concatLine(filePath) {
  const p = filePath.replace(/\\/g, '/').replace(/'/g, "'\\''");
  return `file '${p}'`;
}

class PlaylistWriter {
  // queue: Queue; writeFile: (path, content) => void (atomik); playlistPath: mutlak yol
  constructor({ queue, batchSize, playlistPath, writeFile }) {
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`batchSize pozitif tam sayı olmalı (${batchSize})`);
    this.queue = queue;
    this.batchSize = batchSize;
    this.playlistPath = playlistPath;
    this.writeFile = writeFile;
  }

  // Yazılan parçaları ve toplam süreyi döndürür (loglama / restart zamanı tahmini için).
  writeNext() {
    const tracks = Array.from({ length: this.batchSize }, () => this.queue.next());
    const content = tracks.map((t) => concatLine(t.path)).join('\n') + '\n';
    this.writeFile(this.playlistPath, content);
    return {
      path: this.playlistPath,
      tracks,
      totalDurationSeconds: tracks.reduce((sum, t) => sum + t.durationSeconds, 0),
    };
  }
}

module.exports = { PlaylistWriter, concatLine };
