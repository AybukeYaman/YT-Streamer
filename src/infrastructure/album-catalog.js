// Albüm kataloğu: yalnızca DİSK TARAMASI, ffprobe YOK. /config'teki "Yeni yayın" formunda
// "hangi albümler girsin" listesini göstermek için.
//
// NEDEN AlbumRepository DEĞİL: o her parça için ffprobe çalıştırır (498 parçada ~2 dk) ve
// süre önbelleğine yazar. /config (go-live süreci) bunu yapınca hem sayfa yavaşlar hem de
// iki süreç aynı önbelleğe yazar (bkz. config-wiring.js'teki "v1 sadeleştirmesi"). Katalog
// yalnızca dosya adlarını okur: ad, parça yolları (plan müzik seçimi bunu bekler) ve
// arkaplan klipleri (önizleme için).
//
// Albüm düzeni AlbumRepository ile AYNI sözleşme: <albums>/<albüm>/music/*.m4a ve
// backgrounds/*.mp4 (yoksa background.mp4). Nokta ile başlayan klasörler albüm değildir.
const fs = require('fs');
const path = require('path');

const AUDIO_EXT = '.m4a';
const VIDEO_EXT = '.mp4';

const filesWith = (dir, ext) => {
  try {
    return fs.readdirSync(dir)
      .filter((f) => path.extname(f).toLowerCase() === ext)
      .sort((a, b) => a.localeCompare(b))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
};

class AlbumCatalog {
  // dir: config.paths.albums (null olabilir → boş katalog)
  constructor({ dir }) {
    this.dir = dir;
  }

  // [{ name, trackPaths, backgrounds, trackCount, loopPath }] — ada göre sıralı. Parçası ya da
  // arkaplanı olmayan klasör atlanır (AlbumRepository da onu atlıyor).
  list() {
    if (!this.dir) return [];
    let entries;
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const albumDir = path.join(this.dir, name);
        const trackPaths = filesWith(path.join(albumDir, 'music'), AUDIO_EXT);
        let backgrounds = filesWith(path.join(albumDir, 'backgrounds'), VIDEO_EXT);
        if (!backgrounds.length) backgrounds = filesWith(albumDir, VIDEO_EXT).filter((f) => path.basename(f).toLowerCase() === 'background.mp4');
        // Saf mod için hazır döngü (scripts/prepare-loops.js): yoksa null.
        const loop = path.join(albumDir, 'loop.mp4');
        return {
          name, trackPaths, backgrounds, trackCount: trackPaths.length, loopPath: fs.existsSync(loop) ? loop : null,
        };
      })
      .filter((a) => a.trackPaths.length > 0 && a.backgrounds.length > 0);
  }
}

module.exports = { AlbumCatalog };
