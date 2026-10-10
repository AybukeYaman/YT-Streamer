// `npm run plan` (--plan-only) süreci için StreamControlService'in yerini tutan sahte.
// Bu süreçte yayın motoru (orchestrator/supervisor/encoder) kurulmuyor — sihirbaz
// kilidi almadan açılabilsin diye (bkz. PLAN-yapilandirma-ui.md Faz N1). Sözleşme aynı
// (getStatus/getCurrentTrack/getUpcomingQueue/start/stop/restart), StreamTui ve
// StreamConfigService hangi controlService'le çalıştığını bilmez.
class PlanOnlyControlService {
  // runRestart: () => Promise<{ ok, message }> | null — verilirse restart() bunu çağırır.
  //   null ise restart() yayına dokunmaz, log'a elle restart talimatı yazar.
  // log: { info, warn, error }
  constructor({ runRestart = null, log }) {
    this.runRestart = runRestart;
    this.log = log;
  }

  getStatus() {
    return { state: 'stopped', uptime: 0, fps: null, bitrateKbps: null, speed: null, runNumber: 0 };
  }

  getCurrentTrack() {
    return null;
  }

  getUpcomingQueue() {
    return [];
  }

  // Bu süreç yayın başlatmaz/durdurmaz — sihirbaz yalnızca plan kaydetmek için kullanılıyor.
  async start() {
    this.log.info('plan-only kipte yayın başlatılmaz — plan kaydedildi, devreye almak için restart gerekir');
  }

  async stop() {
    this.log.info('plan-only kipte zaten çalışan bir yayın yok');
  }

  // Hata FIRLATMAZ: applyAndRestart önce apply() ile planı ZATEN yazmıştır, restart
  // başarısız olsa bile sihirbaz "plan kaydedilemedi" demesin (10 Ekim 2026, Faz N1).
  async restart() {
    if (!this.runRestart) {
      this.log.info('plan kaydedildi; devreye almak için: systemctl restart yt-streamer');
      return;
    }
    try {
      const result = await this.runRestart();
      if (result && result.ok) {
        this.log.info(result.message || 'yayın yeniden başlatıldı');
      } else {
        this.log.warn((result && result.message) || 'yayın yeniden başlatılamadı — elle systemctl restart gerekir');
      }
    } catch (err) {
      this.log.warn(`restart denemesi başarısız: ${err.message} — elle systemctl restart gerekir`);
    }
  }
}

module.exports = { PlanOnlyControlService };
