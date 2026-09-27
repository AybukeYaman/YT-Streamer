// Albüm: ad, arkaplan videosu, parçalar. Bir playlist (restart döngüsü) tek albümden oluşur,
// arkaplan albüm sınırında değişir. Saf veri nesnesi — I/O yok, Node modülü import etmez.

class AlbumError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AlbumError';
  }
}

class Album {
  constructor({ name, backgroundPath, tracks }) {
    if (typeof name !== 'string' || name.trim() === '') throw new AlbumError(`geçersiz albüm adı (${name})`);
    if (typeof backgroundPath !== 'string' || backgroundPath.trim() === '') {
      throw new AlbumError(`"${name}": arkaplan yolu yok`);
    }
    if (!Array.isArray(tracks) || tracks.length === 0) throw new AlbumError(`"${name}": hiç parça yok`);
    this.name = name;
    this.backgroundPath = backgroundPath;
    this.tracks = Object.freeze([...tracks]);
    Object.freeze(this);
  }
}

module.exports = { Album, AlbumError };
