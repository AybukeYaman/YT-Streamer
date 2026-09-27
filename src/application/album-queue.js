// Albüm-farkında sonsuz çalma sırası. I/O yok; domain'deki Queue'ları birleştirdiği için
// application katmanında (domain dosyaları birbirini de import etmez).
//
// Her batch (playlist) tek bir albümün parçalarından oluşur: arkaplan bir restart döngüsü
// boyunca sabit kalır. Albüm sırası da parça sırası da Queue ile (aynı mod): shuffle'da aynı
// albüm arka arkaya gelmez (albüm sayısı 1'den büyükse). Her albümün kendi parça kuyruğu var —
// albüm tekrar sırası geldiğinde kaldığı yerden devam eder.
const { Queue, QueueError } = require('../domain/queue');

class AlbumQueue {
  // random: () => [0,1) — testlerde deterministik vermek için
  constructor({ albums, mode, random = Math.random }) {
    if (!Array.isArray(albums) || albums.length === 0) {
      throw new QueueError('hiç albüm yok — albüm klasörü boş ya da hiçbir albüm okunamadı');
    }
    this.mode = mode;
    this.order = new Queue({ tracks: albums, mode, random });
    this.trackQueues = new Map(albums.map((a) => [a, new Queue({ tracks: a.tracks, mode, random })]));
  }

  // Sıradaki albüm ve ondan en fazla maxTracks parça (albüm daha kısaysa albüm uzunluğu kadar —
  // aynı parça bir playlist'te tekrarlanmasın).
  nextBatch(maxTracks) {
    const album = this.order.next();
    const queue = this.trackQueues.get(album);
    const count = Math.min(maxTracks, album.tracks.length);
    return { album, tracks: Array.from({ length: count }, () => queue.next()) };
  }
}

module.exports = { AlbumQueue };
