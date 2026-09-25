// Encode hızının kayan pencere ortalaması. Saf domain — I/O yok, Node modülü import etmez.
//
// Neden ffmpeg'in speed= alanı değil: o değer sürecin BAŞINDAN beri ortalama (Faz 1/2'de
// gözlendi) — saatler sonra ani bir yavaşlamayı neredeyse hiç göstermez, başta da sıçrar.
// Burada ardışık iki ilerleme satırından anlık hız hesaplanır:
//   hız = (Δframe / fps) / Δduvar_saati   (1.0 = gerçek zaman)
// ve son windowMs'in ortalaması alınır — toplam medya süresi / toplam duvar süresi
// (tek tek hızların ortalaması değil: aralıklar eşit değilse bu daha doğru).
// Her yeni sürecin ilk warmupMs'i sayılmaz (başlangıç sıçraması normal, Faz 4'te de görüldü).
//
// Durum: 'warming' (pencere henüz dolmadı) | 'ok' | 'slow' (< low) | 'fast' (> high)

class SpeedWindow {
  constructor({ fps, windowMs = 30000, warmupMs = 30000, low = 0.95, high = 1.1 }) {
    if (!(fps > 0)) throw new Error(`fps pozitif olmalı (${fps})`);
    Object.assign(this, { fps, windowMs, warmupMs, low, high });
    this.reset(0);
  }

  // Yeni ffmpeg süreci: frame 0'dan başlar, önceki sürecin örnekleri geçersiz.
  reset(now) {
    this.runStartedAt = now;
    this.prev = null;
    this.samples = []; // { at, media, wall } — at: aralığın bitiş anı (ms)
  }

  // İlerleme satırı: frame (süreç başından beri) ve geldiği an (ms).
  add(frame, now) {
    const prev = this.prev;
    this.prev = { frame, now };
    if (!prev || now <= prev.now || frame < prev.frame) return;
    if (prev.now - this.runStartedAt < this.warmupMs) return; // aralık ısınma içinde başladı
    this.samples.push({ at: now, media: (frame - prev.frame) / this.fps, wall: (now - prev.now) / 1000 });
    while (this.samples.length && now - this.samples[0].at >= this.windowMs) this.samples.shift();
  }

  // Pencere dolmadıysa (ısınma sonrası windowMs kadar veri yoksa) average null.
  status(now) {
    const covered = now - this.runStartedAt - this.warmupMs;
    if (covered < this.windowMs || this.samples.length === 0) return { state: 'warming', average: null };
    const media = this.samples.reduce((s, x) => s + x.media, 0);
    const wall = this.samples.reduce((s, x) => s + x.wall, 0);
    const average = media / wall;
    const state = average < this.low ? 'slow' : average > this.high ? 'fast' : 'ok';
    return { state, average };
  }
}

module.exports = { SpeedWindow };
