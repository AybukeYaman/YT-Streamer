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

  // Sıradaki albüm ve ondan en fazla maxTracks parça. Aynı parça bir playlist'te
  // TEKRARLANMAZ: ilk tekrarda batch kesilir, yani playlist kısalır.
  //
  // Neden gerekiyordu (10 Ekim 2026): albümün parça kuyruğu kaldığı yerden devam ediyor.
  // Turda 2 parça kalmışken 50'lik bir batch istenirse kuyruk "kalan 2 + YENİ turdan 48"
  // veriyor ve yeni tur o 2 parçayı da içerebiliyordu — aynı şarkı aynı playlist'te iki
  // kez, üstelik birkaç dakika arayla. Eski kod bunu "aynı parça tekrarlanmasın" diye
  // yorumluyordu ama yalnızca albümden KISA batch'leri koruyordu.
  //
  // Neden kesmek (atlamak/karıştırmak değil): kuyruğun sırası bozulmaz, hiçbir parça
  // atlanmaz — yalnızca tur sınırına denk gelen playlist kısa olur. Bedeli bir restart
  // boşluğu (~225 ms, Faz 3.1 ölçümü), kazancı sıranın bozulmaması.
  nextBatch(maxTracks) {
    const album = this.order.next();
    const queue = this.trackQueues.get(album);
    const count = Math.min(maxTracks, album.tracks.length);
    // peek(n), next()'in döndüreceği parçaların ta kendisini verir (Queue sözleşmesi):
    // tekrar aramak için kuyruğu tüketmek gerekmiyor.
    const upcoming = queue.peek(count);
    const seen = new Set();
    let take = 0;
    for (const track of upcoming) {
      if (seen.has(track)) break;
      seen.add(track);
      take++;
    }
    return { album, tracks: Array.from({ length: take }, () => queue.next()) };
  }
}

module.exports = { AlbumQueue };
