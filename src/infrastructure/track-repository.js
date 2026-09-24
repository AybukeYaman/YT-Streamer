// music/ klasöründeki .m4a dosyalarını bulur, ffprobe ile sürelerini okuyup Track üretir.
// Sonuçlar önbelleğe alınır; klasördeki dosya sayısı değişince yeniden taranır.
// Okunamayan/bozuk dosya listeye eklenmez, uyarı loglanır.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Track } = require('../domain/track');

const AUDIO_EXT = '.m4a';

// Süreyi saniye olarak döndürür; okunamazsa hata fırlatır.
function ffprobeDuration(file, ffprobePath = 'ffprobe') {
  return new Promise((resolve, reject) => {
    execFile(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { windowsHide: true }, (err, stdout, stderr) => {
        // ffprobe hatası çok satırlı olabilir; log kaydı tek satır kalsın.
        if (err) return reject(new Error((stderr || err.message).trim().split(/\r?\n/).join(' | ')));
        const seconds = parseFloat(stdout);
        if (!Number.isFinite(seconds)) return reject(new Error(`süre okunamadı: "${stdout.trim()}"`));
        resolve(seconds);
      });
  });
}

class TrackRepository {
  // probeDuration: (file) => Promise<number> — testlerde sahte verilir
  constructor({ dir, log, probeDuration = (f) => ffprobeDuration(f) }) {
    this.dir = dir;
    this.log = log;
    this.probeDuration = probeDuration;
    this.cache = null; // { fileCount, tracks }
  }

  #audioFiles() {
    return fs.readdirSync(this.dir)
      .filter((f) => path.extname(f).toLowerCase() === AUDIO_EXT)
      .sort((a, b) => a.localeCompare(b))
      .map((f) => path.join(this.dir, f));
  }

  async list() {
    const files = this.#audioFiles();
    if (this.cache && this.cache.fileCount === files.length) return this.cache.tracks;

    const tracks = [];
    for (const file of files) {
      try {
        tracks.push(new Track({ path: file, durationSeconds: await this.probeDuration(file) }));
      } catch (err) {
        this.log.warn(`atlandı: ${path.basename(file)} — ${err.message}`);
      }
    }
    this.log.info(`${tracks.length}/${files.length} parça yüklendi (${this.dir})`);
    this.cache = { fileCount: files.length, tracks };
    return tracks;
  }
}

module.exports = { TrackRepository };
