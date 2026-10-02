// Periyodik sağlık izleyicisi: takılabilir kontrolleri aynı tempoda çalıştırır, eşik
// aşımında alarm verir ve dışarıya "ben yaşıyorum" sinyali gönderir.
//
// NEDEN GENEL: önce yalnızca ingest'i yoklayan özel bir sınıf vardı
// (IngestHealthMonitor). İkinci bir kontrol (encoder kalp atışı) eklemek ikinci bir
// timer, ikinci eşik mantığı ve ikinci tekrar-bastırma politikası demekti. Kontroller
// ayrı nesneler olunca yeni kontrol eklemek bu dosyayı DEĞİŞTİRMİYOR.
//
// Kontrol sözleşmesi:  { name, async run() -> { status, message?, detail? } }
//   status: 'healthy' | 'unhealthy' | 'skipped'
//   'skipped' = ölçülecek bir şey yok (yayın hiç başlamamış gibi) — sağlıksızlık DEĞİL.
//
// ÖLÜ ADAM ANAHTARI: tüm kontroller sağlıklıyken dışarıdaki bir izleme servisine
// (healthchecks.io) ping atılır. Sağlıksızlıkta ping KESİLİR, dış servis haber verir.
// Neden şart: yerel izleyici kendi ölümünü bildiremez — yt-golive süreci çökerse ya da
// VPS tamamen giderse alarm verecek kimse kalmaz. Ping'in susması o durumda tek sinyal.
const DEFAULT_INTERVAL_MS = 60000;
// Kaç ARDIŞIK sağlıksız örnekten sonra alarm. Tek örnek yetmez: albüm geçişinde ffmpeg
// yeniden başlıyor (RTMP oturumu yenilenir), API tek yoklamada tekleyebilir.
// 3 × 60 sn ≈ 3 dk — gerçek kesinti için kısa, geçici dip için uzun.
const DEFAULT_UNHEALTHY_THRESHOLD = 3;

class HealthMonitor {
  constructor({
    checks, log,
    alerter = null, // { alert({ level, title, message }) } — yoksa yalnızca log
    pingAlive = null, // async () => void — ölü adam anahtarı; yoksa atlanır
    // paused: () => boolean — true ise bu tur hiçbir kontrol ÇALIŞTIRILMAZ (hepsi
    // 'skipped' sayılır). Yayın bilerek park edildiğinde (.env.<isim>.disabled) alarm
    // üretmemek için: aksi halde kapattığın yayın için her 3 dakikada bildirim gelirdi.
    paused = null,
    intervalMs = DEFAULT_INTERVAL_MS,
    unhealthyThreshold = DEFAULT_UNHEALTHY_THRESHOLD,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }) {
    if (!Array.isArray(checks) || checks.length === 0) throw new Error('en az bir kontrol gerekli');
    this.checks = checks;
    this.log = log;
    this.alerter = alerter;
    this.pingAlive = pingAlive;
    this.paused = paused;
    this.intervalMs = intervalMs;
    this.unhealthyThreshold = unhealthyThreshold;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.timer = null;
    this.stopped = false;
    // Kontrol adı → { consecutive, alerted, last }
    this.state = new Map(checks.map((c) => [c.name, { consecutive: 0, alerted: false, last: null }]));
  }

  get running() {
    return this.timer !== null;
  }

  // /status için: her kontrolün son görülen durumu (API'ye gitmeden okunur).
  snapshot() {
    const out = {};
    for (const [name, s] of this.state) {
      out[name] = {
        status: s.last?.status ?? null,
        message: s.last?.message ?? null,
        detail: s.last?.detail ?? null,
        consecutiveUnhealthy: s.consecutive,
        alerted: s.alerted,
      };
    }
    return out;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.log.info(
      `sağlık izleme açık: ${this.checks.map((c) => c.name).join(', ')} — her ` +
      `${Math.round(this.intervalMs / 1000)} sn, ${this.unhealthyThreshold} ardışık sağlıksız örnekte alarm` +
      (this.alerter ? '' : ' (bildirim kanalı yok, yalnızca log)'),
    );
    this.#schedule();
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }

  #schedule() {
    if (this.stopped) return;
    // setInterval DEĞİL setTimeout zinciri: bir tur aralıktan uzun sürerse (ağ yavaşlığı)
    // setInterval çağrıları üst üste bindirir. Promise döndürülüyor — setTimeout yoksayar
    // ama çağıran (test) turun bitmesini bekleyebilir.
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      return this.tick().finally(() => this.#schedule());
    }, this.intervalMs);
    if (typeof this.timer?.unref === 'function') this.timer.unref();
  }

  // Tek tur: tüm kontroller çalışır. Dışarıya açık — testler timer kurmadan çağırabiliyor.
  async tick() {
    const results = {};
    // Park edilmiş yayın: kontrol çalıştırmanın anlamı yok (encoder bilerek kapalı,
    // broadcast kaydı eski olabilir). Sayaçlar sıfırlanır ve ping ATILIR — park etmek
    // bilinçli bir karar, dış izleme servisi de alarm çalmasın.
    if (this.paused && this.paused()) {
      for (const check of this.checks) {
        results[check.name] = { status: 'skipped', message: 'yayın park edilmiş (izleme duraklatıldı)' };
        const s = this.state.get(check.name);
        s.last = results[check.name];
        s.consecutive = 0;
        s.alerted = false;
      }
      await this.#ping();
      return results;
    }
    for (const check of this.checks) {
      results[check.name] = await this.#runCheck(check);
    }
    // Ping yalnızca HER ŞEY yolundayken: 'skipped' (yayın yok) ping'i engellemez, yoksa
    // yayını bilerek kapattığında dış servis sürekli alarm verirdi.
    const anyUnhealthy = Object.values(results).some((r) => r.status === 'unhealthy');
    if (!anyUnhealthy) await this.#ping();
    return results;
  }

  async #runCheck(check) {
    const s = this.state.get(check.name);
    let result;
    try {
      result = await check.run();
    } catch (err) {
      // Kontrolün kendi hatası (ağ, kota, dosya) SAĞLIKSIZLIK KANITI DEĞİL: sayaç
      // artırılmaz. Aksi halde YouTube API teklediğinde ölü olmayan bir yayın için
      // alarm verilirdi.
      this.log.warn(`${check.name} kontrolü okunamadı (${err.message}) — sayaç değişmedi`);
      return { status: 'error', message: err.message };
    }

    s.last = result;
    if (result.status === 'skipped') {
      // Ölçülecek şey yok: sayaç sıfırlanır, yoksa yayın kapalıyken birikip ilk
      // açılışta patlar.
      s.consecutive = 0;
      s.alerted = false;
      return result;
    }
    if (result.status === 'healthy') {
      if (s.consecutive > 0 || s.alerted) {
        const message = `${check.name}: tekrar sağlıklı — ${result.message ?? 'ok'}`;
        this.log.info(message);
        if (s.alerted) await this.#notify({ level: 'info', title: `${check.name} düzeldi`, message });
      }
      s.consecutive = 0;
      s.alerted = false;
      return result;
    }

    s.consecutive += 1;
    const n = s.consecutive;
    if (n < this.unhealthyThreshold) {
      this.log.warn(
        `${check.name}: sağlıksız (${result.message}) — ${n}/${this.unhealthyThreshold}, ` +
        'geçici olabilir, izleniyor',
      );
      return result;
    }
    const dakika = Math.round((n * this.intervalMs) / 60000);
    const message = `${result.message} (${n} ardışık yoklama, ~${dakika} dk)`;
    // İlk eşik aşımında error + bildirim; sonraki turlarda yalnızca warn — tek olay
    // logu doldurmasın ve telefona her dakika bildirim gitmesin.
    if (s.alerted) {
      this.log.warn(message);
    } else {
      this.log.error(message);
      await this.#notify({ level: 'error', title: `YAYIN SORUNU: ${check.name}`, message });
      s.alerted = true;
    }
    return result;
  }

  // Bildirim ve ping ASLA tur'u düşürmez: alarm kanalı bozuksa izleme sürmeli.
  async #notify(payload) {
    if (!this.alerter) return;
    try {
      await this.alerter.alert(payload);
    } catch (err) {
      this.log.warn(`bildirim gönderilemedi (${err.message}) — izleme sürüyor`);
    }
  }

  async #ping() {
    if (!this.pingAlive) return;
    try {
      await this.pingAlive();
    } catch (err) {
      this.log.warn(`ölü adam anahtarı ping'i başarısız (${err.message}) — izleme sürüyor`);
    }
  }
}

module.exports = { HealthMonitor, DEFAULT_INTERVAL_MS, DEFAULT_UNHEALTHY_THRESHOLD };
