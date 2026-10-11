// ffmpeg'in "Error submitting packet to decoder" satırlarını SAYAR, tek tek loglamaz ve
// sürekli sürerse bildirim gönderir. Saf mantık: zamanı ve bildirim kanalını dışarıdan alır.
//
// NEDEN GEREKLİ (11 Ekim 2026): yayında bozuk bir klip girişi saniyede yüzlerce bu satırı
// üretti (30 dakikada 411 bin). Her satır ayrı bir WARN olarak yazıldığı için hem log
// boğuldu (journald "Suppressed 4475 messages") hem de kimse haberdar olmadı: encoder kalp
// atışı, ingest ve hız kontrolü yeşildi, izleyici ise kekeleyen yayın gördü. Mevcut kontrol
// setinin bir kör noktası daha (bkz. speed-alarm.js'teki aynı gerekçe).
//
// Davranış:
//   - İlk satır HEMEN loglanır (hangi giriş, ne hata) — teşhis için gereken tek şey bu.
//   - Sonraki satırlar sayılır; summaryEveryMs'de bir tek özet satırı yazılır.
//   - Sayı alertThreshold'u pencere içinde aşarsa tek bildirim gider (alertCooldownMs'de bir).
const DECODER_ERROR = /error submitting packet to decoder|error while decoding|invalid data found when processing input/i;

const DEFAULT_SUMMARY_EVERY_MS = 30000;
const DEFAULT_ALERT_THRESHOLD = 100; // summaryEveryMs içinde bu kadar hata → alarm
const DEFAULT_ALERT_COOLDOWN_MS = 10 * 60000;

class DecoderErrorWatch {
  // alerter: { alert({ level, title, message }) }; log: { warn, error }
  constructor({
    alerter, log,
    summaryEveryMs = DEFAULT_SUMMARY_EVERY_MS,
    alertThreshold = DEFAULT_ALERT_THRESHOLD,
    alertCooldownMs = DEFAULT_ALERT_COOLDOWN_MS,
  }) {
    this.alerter = alerter;
    this.log = log;
    this.summaryEveryMs = summaryEveryMs;
    this.alertThreshold = alertThreshold;
    this.alertCooldownMs = alertCooldownMs;
    this.windowStart = null;
    this.windowCount = 0;
    this.total = 0;
    this.lastAlertAt = -Infinity;
  }

  static matches(line) {
    return DECODER_ERROR.test(line);
  }

  // Satır DecoderErrorWatch'a aitse true döner (çağıran ayrıca loglamasın).
  record(line, now) {
    if (!DecoderErrorWatch.matches(line)) return false;
    this.total += 1;
    if (this.windowStart === null) {
      // Pencerenin ilk hatası: ayrıntıyla, hemen.
      this.windowStart = now;
      this.windowCount = 1;
      this.log.warn(`ffmpeg decoder hatası: ${line} — tekrarlayanlar ${Math.round(this.summaryEveryMs / 1000)} sn'de bir özetlenecek`);
      return true;
    }
    this.windowCount += 1;
    if (now - this.windowStart >= this.summaryEveryMs) this.#flush(now);
    return true;
  }

  #flush(now) {
    const count = this.windowCount;
    const seconds = Math.round((now - this.windowStart) / 1000);
    this.windowStart = now;
    this.windowCount = 0;
    this.log.warn(`ffmpeg decoder hatası sürüyor: son ${seconds} sn'de ${count} hata (toplam ${this.total})`);
    if (count < this.alertThreshold || now - this.lastAlertAt < this.alertCooldownMs) return;
    this.lastAlertAt = now;
    const message = `BOZUK GİRİŞ: ffmpeg son ${seconds} sn'de ${count} paket çözemedi — bir klip/arkaplan dosyası `
      + 'bozuk olabilir, yayın kekeliyor. Düzeltme: runtime/study-*.mp4 ve break-*.mp4 dosyalarını (ve '
      + '.json eşlerini) sil, yt-streamer\'ı yeniden başlat; klipler temiz yeniden üretilir.';
    // Bildirim ASLA yayını etkilemez ve beklenmez (SpeedAlarm ile aynı ilke).
    Promise.resolve()
      .then(() => this.alerter.alert({ level: 'error', title: 'YAYIN SORUNU: bozuk giriş', message }))
      .catch((err) => this.log.warn(`bildirim gönderilemedi (${err.message}) — yayın etkilenmedi`));
  }
}

module.exports = { DecoderErrorWatch, DECODER_ERROR };
