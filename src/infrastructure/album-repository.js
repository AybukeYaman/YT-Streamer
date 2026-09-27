// Albümleri diskten yükler. İki kaynak:
//   AlbumRepository        — music-source/<albüm>/{background.mp4, music/*.m4a} (Faz 8 ön işleme çıktısı)
//   SingleAlbumRepository  — eski düzen: tek music/ klasörü + tek arkaplan (config'de paths.albums yoksa)
// Parça okuma (ffprobe, önbellek) TrackRepository'de; albüm başına bir tane tutulur.
// Eksik ya da parçası okunamayan albüm listeye eklenmez, uyarı loglanır.
const fs = require('fs');
const path = require('path');
const { Album } = require('../domain/album');
const { TrackRepository } = require('./track-repository');

const BACKGROUND_FILE = 'background.mp4';
const MUSIC_DIR = 'music';

class AlbumRepository {
  // probeDuration: TrackRepository'ye geçer — testlerde sahte verilir
  constructor({ dir, log, probeDuration }) {
    this.dir = dir;
    this.log = log;
    this.probeDuration = probeDuration;
    this.trackRepos = new Map(); // albüm adı → TrackRepository (önbellek albüm başına)
  }

  async list() {
    const names = fs.readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));

    const albums = [];
    for (const name of names) {
      const albumDir = path.join(this.dir, name);
      const backgroundPath = path.join(albumDir, BACKGROUND_FILE);
      const musicDir = path.join(albumDir, MUSIC_DIR);
      if (!fs.existsSync(backgroundPath) || !fs.existsSync(musicDir)) {
        this.log.warn(`albüm atlandı: ${name} — ${BACKGROUND_FILE} ya da ${MUSIC_DIR}/ yok`);
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
      albums.push(new Album({ name, backgroundPath, tracks }));
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
