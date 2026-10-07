// Albümün arkaplan rotasyonunu ffmpeg concat demuxer formatında dosyaya yazar.
// Sıralama/tekrar hesabı domain'de (background-rotation.js); burada yalnızca yazma var.
// Dosya yazımı dışarıdan verilir (infrastructure: atomik .tmp → rename) — application
// katmanı fs'e doğrudan dokunmaz, PlaylistWriter ile aynı desen.
//
// Tek arkaplanlı albümde write() null döner: liste yazılmaz, encoder eski tek dosya
// yolunu kullanır. Yani rotasyon tamamen opt-in, eski albümler hiç etkilenmez.
const { backgroundRotationPaths } = require('../domain/background-rotation');
const { concatLine } = require('./playlist-writer');

class BackgroundPlaylistWriter {
  // playlistPath: mutlak yol; writeFile: (path, content) => void (atomik);
  // rotationSeconds: her klibin ekranda kalacağı süre
  constructor({ playlistPath, writeFile, rotationSeconds }) {
    if (!Number.isFinite(rotationSeconds) || rotationSeconds <= 0) {
      throw new Error(`rotationSeconds pozitif olmalı (${rotationSeconds})`);
    }
    this.playlistPath = playlistPath;
    this.writeFile = writeFile;
    this.rotationSeconds = rotationSeconds;
  }

  // Dönüş: { path, lineCount, backgroundCount } ya da null (rotasyon gerekmiyor).
  write(album) {
    if (!album.rotates) return null;
    const paths = backgroundRotationPaths({
      backgrounds: album.backgrounds,
      rotationSeconds: this.rotationSeconds,
    });
    this.writeFile(this.playlistPath, paths.map(concatLine).join('\n') + '\n');
    return {
      path: this.playlistPath,
      lineCount: paths.length,
      backgroundCount: album.backgrounds.length,
    };
  }
}

module.exports = { BackgroundPlaylistWriter };
