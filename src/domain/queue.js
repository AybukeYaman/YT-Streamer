// Sonsuz çalma sırası. Saf domain — I/O yok, Node modülü import etmez.
//
// sequential: dosya sırası, sona gelince başa sarar.
// shuffle: her tur listenin karıştırılmış bir kopyası; aynı parça arka arkaya gelmez
//          (tur sınırında da — liste 1'den büyükse).
//
// peek(n) ile gösterilen parçalar, sonraki next() çağrılarının döndüreceği parçaların
// ta kendisidir: sıra bir "gelecek" tamponunda tutulur, peek tamponu doldurur, next tüketir.

const MODES = ['sequential', 'shuffle'];

class QueueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueueError';
  }
}

class Queue {
  // random: () => [0,1) — testlerde deterministik vermek için
  constructor({ tracks, mode, random = Math.random }) {
    if (!MODES.includes(mode)) throw new QueueError(`geçersiz kuyruk modu "${mode}" — ${MODES.join(' ya da ')} olmalı`);
    if (!Array.isArray(tracks) || tracks.length === 0) {
      throw new QueueError('kuyrukta hiç parça yok — music/ klasörü boş ya da tüm dosyalar okunamadı');
    }
    this.tracks = [...tracks];
    this.mode = mode;
    this.random = random;
    this.upcoming = [];
    this.lastCycleEnd = null; // turlar tampona bütün olarak eklenir; önceki turun son parçası
  }

  next() {
    this.#fill(1);
    return this.upcoming.shift();
  }

  peek(n) {
    this.#fill(n);
    return this.upcoming.slice(0, n);
  }

  #fill(n) {
    while (this.upcoming.length < n) this.upcoming.push(...this.#nextCycle());
  }

  #nextCycle() {
    if (this.mode === 'sequential') return [...this.tracks];
    const cycle = this.#shuffled();
    // Tur sınırı: yeni turun ilki, bir önceki turun sonuncusuyla aynı olmasın.
    if (cycle.length > 1 && cycle[0] === this.lastCycleEnd) {
      const j = 1 + Math.floor(this.random() * (cycle.length - 1));
      [cycle[0], cycle[j]] = [cycle[j], cycle[0]];
    }
    this.lastCycleEnd = cycle.at(-1);
    return cycle;
  }

  // Fisher-Yates
  #shuffled() {
    const a = [...this.tracks];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

module.exports = { Queue, QueueError };
