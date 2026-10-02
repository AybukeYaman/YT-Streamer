// Canlı yayının ingest sağlığını periyodik yoklar (Faz 9 A′).
//
// NEDEN VAR: go-live'ın stale tespiti yalnızca TETİKLEDİĞİNDE çalışır. 1 Ekim olayında
// kimse tetiklemedi ve kimse bakmadı — yayın ~2 saat ölü kaldı, kanalda "live" görünerek.
// Tetikler arasındaki bu körlüğü kapatan tek şey periyodik kontroldür.
//
// Kota: her yoklama 1 birim (liveStreams.list), 60 sn aralıkla 1440 birim/gün —
// 10.000 birimlik günlük kotanın ~%14'ü, iki yayında ~%29'u. Kayıtta canlı bir broadcast
// yokken hiç API çağrısı yapılmaz (checkIngestHealth erken döner), yani yayın kapalıyken
// kota harcanmaz.
//
// Zamanlayıcı setInterval DEĞİL setTimeout zinciri: bir yoklama (ağ yavaşlığı) aralıktan
// uzun sürerse setInterval çağrıları üst üste bindirir; zincir bir sonrakini ancak
// önceki bittikten sonra kurar.
const DEFAULT_INTERVAL_MS = 60000;
// Kaç ARDIŞIK sağlıksız örnekten sonra alarm verilsin. Tek örnek yetmez: her albüm
// geçişinde ffmpeg yeniden başlıyor (RTMP oturumu yenilenir) ve ingest kısa süre
// 'inactive' görünebilir; ayrıca API tek bir yoklamada tekleyebilir. 3 × 60 sn ≈ 3 dk
// gerçek bir kesinti için kısa, geçici dip için uzun.
const DEFAULT_UNHEALTHY_THRESHOLD = 3;

class IngestHealthMonitor {
  // goLiveService: { checkIngestHealth() }; log: { info, warn, error }
  constructor({
    goLiveService, log,
    intervalMs = DEFAULT_INTERVAL_MS,
    unhealthyThreshold = DEFAULT_UNHEALTHY_THRESHOLD,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }) {
    this.goLiveService = goLiveService;
    this.log = log;
    this.intervalMs = intervalMs;
    this.unhealthyThreshold = unhealthyThreshold;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.timer = null;
    this.stopped = false;
    this.consecutiveUnhealthy = 0;
    this.alerted = false; // eşik aşıldığında error bir kez; sonrası warn (log seli olmasın)
  }

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.log.info(
      `ingest sağlık kontrolü açık: her ${Math.round(this.intervalMs / 1000)} sn, ` +
      `${this.unhealthyThreshold} ardışık sağlıksız örnekte alarm`,
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
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      // tick() kendi hatalarını yutar; zincir her koşulda sürer.
      // Promise DÖNDÜRÜLÜYOR: setTimeout yoksayar ama çağıran (test, ileride kapanış)
      // yoklamanın bitmesini bekleyebilir.
      return this.tick().finally(() => this.#schedule());
    }, this.intervalMs);
    // Node'un kapanışını bu zamanlayıcı geciktirmesin (sunucu kapanırken stop() çağrılır,
    // ama arada SIGTERM gelirse süreç timer yüzünden ayakta kalmasın).
    if (typeof this.timer?.unref === 'function') this.timer.unref();
  }

  // Tek yoklama. Dışarıya açık: testler zamanlayıcı kurmadan çağırabiliyor.
  async tick() {
    let result;
    try {
      result = await this.goLiveService.checkIngestHealth();
    } catch (err) {
      // Ağ/kota hatası sağlıksızlık KANITI DEĞİL: sayaç artırılmaz, yoksa YouTube API
      // teklediğinde ölü olmayan bir yayın için alarm verilir.
      this.log.warn(`ingest sağlığı okunamadı (${err.message}) — sayaç değişmedi`);
      return { ok: false };
    }
    if (result.skipped) {
      // Yayın yok: sayaç sıfırlanır, yoksa yayın kapalıyken birikip ilk açılışta patlar.
      this.consecutiveUnhealthy = 0;
      this.alerted = false;
      return { skipped: true };
    }

    if (result.healthy) {
      if (this.consecutiveUnhealthy > 0 || this.alerted) {
        this.log.info(`ingest tekrar sağlıklı (${this.#describe(result)}) — yayın akıyor`);
      }
      this.consecutiveUnhealthy = 0;
      this.alerted = false;
      return { healthy: true };
    }

    this.consecutiveUnhealthy += 1;
    const n = this.consecutiveUnhealthy;
    if (n < this.unhealthyThreshold) {
      this.log.warn(
        `ingest sağlıksız (${this.#describe(result)}) — ${n}/${this.unhealthyThreshold}, ` +
        'geçici kesinti olabilir (albüm geçişi), izleniyor',
      );
      return { healthy: false, alerted: false };
    }
    const dakika = Math.round((n * this.intervalMs) / 60000);
    const message =
      `YAYIN ÖLÜ: broadcast ${result.broadcastId} YouTube'da canlı görünüyor ama ingest ` +
      `${n} ardışık yoklamada (~${dakika} dk) veri almıyor (${this.#describe(result)}). ` +
      'Düzeltme: Studio\'dan yayını sonlandır VE encoder\'ı yeniden başlat ' +
      '(systemctl restart yt-streamer), sonra go-live\'ı tekrar tetikle.';
    // İlk eşik aşımı error; sonraki her yoklama warn — tek olay logu doldurmasın ama
    // sorunun sürdüğü de görünsün.
    if (this.alerted) this.log.warn(message);
    else this.log.error(message);
    this.alerted = true;
    return { healthy: false, alerted: true };
  }

  #describe(result) {
    return `${result.ingest?.streamStatus ?? 'bilinmiyor'}/${result.ingest?.healthStatus ?? 'bilinmiyor'}`;
  }
}

module.exports = { IngestHealthMonitor, DEFAULT_INTERVAL_MS, DEFAULT_UNHEALTHY_THRESHOLD };
