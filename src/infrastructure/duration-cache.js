// Parça/klip sürelerinin DİSK önbelleği (runtime/durations.json).
//
// Neden var: TrackRepository süreleri yalnızca bellekte tutuyor, süreç ölünce gidiyor.
// Her başlangıçta tüm kütüphane yeniden ffprobe'dan geçiyordu — 498 parçada 2 dk 12 sn
// ölçüldü (7 Ekim, VPS). Bu süre boyunca yayın akmıyor ve encoder-durdu kontrolü
// 2 dakikada tetiklendiği için eşiğe değiyor: kütüphane biraz daha büyüseydi her
// deploy telefona YANLIŞ ALARM gönderecekti.
//
// Geçerlilik: dosya yolu + boyut + mtime. Üçü de aynıysa süre değişmiş olamaz.
// Dosya yeniden üretilirse (paket yeniden yazıldı) mtime değişir ve yeniden ölçülür.
// Yani önbellek "eskimiş süre" riski taşımıyor.
//
// Bozuk/okunamayan önbellek dosyası yayını ENGELLEMEZ: boş önbellekle devam edilir,
// tek kayıp o açılışın yavaş olmasıdır.
const fs = require('fs');

// Yazma gecikmesi: açılışta yüzlerce giriş arka arkaya ekleniyor, her birinde dosyayı
// baştan yazmak anlamsız. Son eklemeden bu kadar sonra tek seferde yazılır.
const FLUSH_DELAY_MS = 1000;

const keyOf = (file, stat) => `${file}|${stat.size}|${Math.round(stat.mtimeMs)}`;

class DurationCache {
  // file: mutlak yol (runtime/durations.json); writeFile: atomik yazma
  constructor({ file, writeFile, log, flushDelayMs = FLUSH_DELAY_MS }) {
    this.file = file;
    this.writeFile = writeFile;
    this.log = log;
    this.flushDelayMs = flushDelayMs;
    this.entries = this.#read();
    this.dirty = false;
    this.timer = null;
    this.hits = 0;
    this.misses = 0;
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') return new Map(Object.entries(parsed));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`süre önbelleği okunamadı, boş başlanıyor: ${err.message}`);
    }
    return new Map();
  }

  #scheduleFlush() {
    this.dirty = true;
    if (this.timer) return;
    // unref: açık zamanlayıcı sürecin kapanmasını geciktirmesin.
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushDelayMs);
    this.timer.unref?.();
  }

  flush() {
    if (!this.dirty) return;
    try {
      this.writeFile(this.file, JSON.stringify(Object.fromEntries(this.entries)));
      this.dirty = false;
    } catch (err) {
      // Yazılamazsa yayın sürmeli: yalnızca sonraki açılış yavaş olur.
      this.log.warn(`süre önbelleği yazılamadı: ${err.message}`);
    }
  }

  // probeDuration'ı saran önbellekli sürüm. Repository'ler değişmiyor — onlara
  // zaten dışarıdan bir ölçüm fonksiyonu veriliyor, burada o fonksiyon sarılıyor.
  wrap(probeDuration) {
    return async (file) => {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        // Dosya okunamıyorsa önbelleği atla; hatayı ölçüm fonksiyonu üretsin.
        return probeDuration(file);
      }
      const key = keyOf(file, stat);
      const cached = this.entries.get(key);
      if (typeof cached === 'number') {
        this.hits++;
        return cached;
      }
      const duration = await probeDuration(file);
      this.misses++;
      this.entries.set(key, duration);
      this.#scheduleFlush();
      return duration;
    };
  }

  // Açılış sonrası tek satır özet: önbelleğin işe yarayıp yaramadığı görünsün.
  summary() {
    return `süre önbelleği: ${this.hits} isabet, ${this.misses} ölçüm`;
  }
}

module.exports = { DurationCache };
