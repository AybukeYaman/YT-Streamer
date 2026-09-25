// Bir playlist'in zaman çizelgesi: parça sürelerinden her parçanın başlangıç/bitiş anı.
// Saf domain — I/O yok, Node modülü import etmez.
//
// Overlay bu aralıkları ffmpeg'e drawtext enable (başlangıç ≤ t < bitiş) olarak verir;
// zamanlama ffmpeg'in kendi video zaman damgasına (t) bağlı olduğu için sesle senkrondur.
// (Node tarafında frame sayısından hesaplayıp dosya güncellemek ~12 sn geç kalıyordu:
// ffmpeg videoyu kuyrukta önden işliyor — Faz 4.4'te ölçüldü, KARARLAR.md.)

class PlaybackTimeline {
  // tracks: Track[] — playlist sırasıyla
  constructor(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) throw new Error('zaman çizelgesi için en az bir parça gerekli');
    this.tracks = tracks;
    let total = 0;
    this.boundaries = tracks.map((t) => (total += t.durationSeconds)); // kümülatif: [d1, d1+d2, ...]
  }

  // Geçen saniyede çalan parçanın indeksi; son sınırdan sonrası son parça.
  // Supervisor çökmeden sonra kaldığı parçadan devam etmek için kullanır.
  indexAt(elapsedSeconds) {
    const i = this.boundaries.findIndex((end) => elapsedSeconds < end);
    return i === -1 ? this.tracks.length - 1 : i;
  }

  // [{ track, start, end }] — aralık yarı açık [start, end): sınır anı bir sonraki parçaya ait,
  // tam sınıra denk gelen karede iki başlık üst üste binmez.
  // Son parçanın bitişi null: -shortest'in video kuyruğunda (~1.7 sn) da yazı kalsın.
  segments() {
    return this.tracks.map((track, i) => ({
      track,
      start: i === 0 ? 0 : this.boundaries[i - 1],
      end: i === this.tracks.length - 1 ? null : this.boundaries[i],
    }));
  }
}

module.exports = { PlaybackTimeline };
