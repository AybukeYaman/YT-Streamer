// Albümleri diskten yükler. İki kaynak:
//   AlbumRepository        — music-source/<albüm>/{background.mp4, music/*.m4a} (Faz 8 ön işleme çıktısı)
//   SingleAlbumRepository  — eski düzen: tek music/ klasörü + tek arkaplan (config'de paths.albums yoksa)
// Parça okuma (ffprobe, önbellek) TrackRepository'de; albüm başına bir tane tutulur.
// Eksik ya da parçası okunamayan albüm listeye eklenmez, uyarı loglanır.
const fs = require('fs');
const path = require('path');
const { Album } = require('../domain/album');
const { TrackRepository, ffprobeDuration } = require('./track-repository');

const BACKGROUND_FILE = 'background.mp4';
const BACKGROUNDS_DIR = 'backgrounds';
const MUSIC_DIR = 'music';
const BACKGROUND_EXT = '.mp4';

// Arkaplan kaynağı: backgrounds/ klasörü varsa çoğul (yayında rotasyon), yoksa tek
// background.mp4 (eski düzen). İkisi birden varsa backgrounds/ kazanır — geçiş döneminde
// eski dosya albümde kalmış olabilir, yeni düzen açıkça tercih edilir.
// Çoğul düzende her klibin süresi okunur: rotasyon tekrar sayısını süreden hesaplıyor.
// Tek düzende ffprobe HİÇ çağrılmaz, süre gerekmiyor.
async function readBackgrounds({ albumDir, probe, log, name }) {
  const dir = path.join(albumDir, BACKGROUNDS_DIR);
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir)
      .filter((f) => path.extname(f).toLowerCase() === BACKGROUND_EXT)
      .sort((a, b) => a.localeCompare(b))
      .map((f) => path.join(dir, f));
    const backgrounds = [];
    for (const file of files) {
      try {
        backgrounds.push({ path: file, durationSeconds: await probe(file) });
      } catch (err) {
        // Okunamayan klip listeye girmez: rotasyon süresi hesaplanamayan bir klip
        // yüzünden albümün tamamını atlamak gereğinden sert olur.
        log.warn(`${name}: arkaplan atlandı — ${path.basename(file)}: ${err.message}`);
      }
    }
    if (backgrounds.length) return { backgrounds };
    log.warn(`${name}: ${BACKGROUNDS_DIR}/ içinde okunabilir arkaplan yok — ${BACKGROUND_FILE}'a düşülüyor`);
  }
  const single = path.join(albumDir, BACKGROUND_FILE);
  return fs.existsSync(single) ? { backgroundPath: single } : null;
}

class AlbumRepository {
  // probeDuration: TrackRepository'ye geçer — testlerde sahte verilir
  constructor({ dir, log, probeDuration }) {
    this.dir = dir;
    this.log = log;
    this.probeDuration = probeDuration;
    // Arkaplan sürelerini okumak için: parçalarla aynı ffprobe yolu, testlerde sahte verilir.
    this.probe = probeDuration || ((f) => ffprobeDuration(f));
    this.trackRepos = new Map(); // albüm adı → TrackRepository (önbellek albüm başına)
  }

  // only: yalnızca bu adlı albümleri yükle (verilmezse hepsi). Plan birkaç albüm seçmişse
  // kütüphanenin geri kalanını taramak (her parça için ffprobe) açılışı dakikalarca geciktiriyordu.
  async list({ only = null } = {}) {
    const wanted = Array.isArray(only) ? new Set(only) : null;
    // Nokta ile başlayan klasörler albüm değildir: paketi üreten taraf yarım yazımı
    // music-source/.staging/ altında tutuyor (atomik rename sözleşmesi). Bunları
    // "albüm atlandı" uyarısıyla raporlamak her taramada gereksiz gürültü.
    const names = fs.readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .filter((n) => !wanted || wanted.has(n))
      .sort((a, b) => a.localeCompare(b));

    const albums = [];
    for (const name of names) {
      const albumDir = path.join(this.dir, name);
      const musicDir = path.join(albumDir, MUSIC_DIR);
      const background = fs.existsSync(musicDir)
        ? await readBackgrounds({ albumDir, probe: this.probe, log: this.log, name })
        : null;
      if (!background) {
        this.log.warn(`albüm atlandı: ${name} — ${BACKGROUND_FILE}/${BACKGROUNDS_DIR}/ ya da ${MUSIC_DIR}/ yok`);
        continue;
      }
      if (!this.trackRepos.has(name)) {
        this.trackRepos.set(name, new TrackRepository({
          dir: musicDir, log: this.log, ...(this.probeDuration && { probeDuration: this.probeDuration }),
        }));
      }
      const tracks = await this.trackRepos.get(name).list();
      if (!tracks.length) {
        this.log.warn(`albüm atlandı: ${name} — okunabilir parça yok`);
        continue;
      }
      albums.push(new Album({ name, ...background, tracks }));
    }
    this.log.info(`${albums.length}/${names.length} albüm yüklendi (${this.dir})`);
    return albums;
  }
}

class SingleAlbumRepository {
  constructor({ musicDir, backgroundPath, log, probeDuration }) {
    this.backgroundPath = backgroundPath;
    this.trackRepository = new TrackRepository({ dir: musicDir, log, ...(probeDuration && { probeDuration }) });
  }

  async list() {
    const tracks = await this.trackRepository.list();
    return tracks.length ? [new Album({ name: 'music', backgroundPath: this.backgroundPath, tracks })] : [];
  }
}

module.exports = { AlbumRepository, SingleAlbumRepository };
