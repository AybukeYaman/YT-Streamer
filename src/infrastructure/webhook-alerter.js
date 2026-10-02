// Alerter'ın webhook implementasyonu — ntfy.sh için ayarlı, sıfır bağımlılık (yerleşik
// fetch). ntfy seçimi: hesap gerektirmiyor, telefona uygulama + bir konu adı yeterli,
// gövde düz metin.
//
//   ALERT_WEBHOOK_URL=https://ntfy.sh/<tahmin-edilemez-konu-adi>
//
// Konu adı bir sırdır (herkes yayınlayıp dinleyebilir), bu yüzden .env.youtube'da
// (chmod 600) tutuluyor ve loglara URL'nin tamamı YAZILMIYOR — yalnızca host.
//
// Başlık ve öncelik ntfy'nin HTTP başlıklarıyla gönderilir. Başlıkta ASCII dışı karakter
// olamaz (HTTP başlık kısıtı): Türkçe harfler sadeleştirilir, mesaj gövdesi olduğu gibi
// kalır (UTF-8 gövde sorunsuz).
const { Alerter } = require('../application/alerter');

const DEFAULT_TIMEOUT_MS = 10000;

const ASCII_MAP = {
  ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U',
};
const toAscii = (text) => text.replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => ASCII_MAP[c]).replace(/[^\x20-\x7E]/g, '');

class WebhookAlerter extends Alerter {
  // url: ntfy konu URL'si; label: hangi yayın (çoklu instance'ta ayırt etmek için)
  constructor({ url, label = null, log, timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = fetch }) {
    super();
    if (!url) throw new Error('WebhookAlerter url olmadan kurulamaz');
    this.url = url;
    this.label = label;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
  }

  async alert({ level = 'error', title, message }) {
    const prefix = this.label ? `[${this.label}] ` : '';
    // AbortSignal.timeout: yanıt vermeyen bir webhook izleme turunu askıda bırakmasın.
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: {
          Title: toAscii(`${prefix}${title}`),
          Priority: level === 'error' ? 'high' : 'default',
          Tags: level === 'error' ? 'rotating_light' : 'white_check_mark',
        },
        body: `${prefix}${message}`,
        signal,
      });
      if (!res.ok) {
        // Yutulur: bildirim gönderilemedi diye izleme durmaz.
        this.log.warn(`bildirim gönderilemedi (HTTP ${res.status}) — kanal: ${this.#host()}`);
        return;
      }
      this.log.info(`bildirim gönderildi (${level}) — kanal: ${this.#host()}`);
    } catch (err) {
      this.log.warn(`bildirim gönderilemedi (${err.name === 'TimeoutError' ? 'zaman aşımı' : err.message}) — kanal: ${this.#host()}`);
    }
  }

  // URL'nin tamamı loglanmaz: ntfy konu adı bir sırdır.
  #host() {
    try {
      return new URL(this.url).host;
    } catch {
      return 'geçersiz-url';
    }
  }
}

// Ölü adam anahtarı (healthchecks.io): sağlıklı her turda ping. Ping SUSARSA dış servis
// haber verir — yt-golive çökerse ya da VPS tamamen giderse alarm verecek tek mekanizma
// budur, çünkü yerel izleyici kendi ölümünü bildiremez.
function createAlivePinger({ url, log, timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = fetch }) {
  if (!url) return null;
  const host = (() => { try { return new URL(url).host; } catch { return 'geçersiz-url'; } })();
  let lastWarnAt = 0;
  return async () => {
    try {
      const res = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Her dakikada bir uyarı log'u doldurur: en fazla saatte bir yaz. Ping'in
      // başarısızlığı yayının sorunu değil, izleme kanalının sorunu.
      const now = Date.now();
      if (now - lastWarnAt > 3600000) {
        lastWarnAt = now;
        log.warn(`ölü adam anahtarı ping'i başarısız (${err.message}) — kanal: ${host}`);
      }
    }
  };
}

module.exports = { WebhookAlerter, createAlivePinger, DEFAULT_TIMEOUT_MS };
