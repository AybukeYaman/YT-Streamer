// Kontrol: YouTube ingest gerçekten veri alıyor mu?
//
// 1 Ekim olayı: broadcast YouTube'da "live" ama ingest "inactive/noData" — yayın ölüydü,
// sistem "her şey yolunda" sanıyordu. Bu kontrol o durumu tetik beklemeden yakalar.
//
// Kota: yoklama başına 1 birim (liveStreams.list). Kayıtta canlı broadcast yoksa
// checkIngestHealth hiç API çağrısı yapmaz → yayın kapalıyken kota harcanmaz.
class IngestCheck {
  // goLiveService: { checkIngestHealth() }
  constructor({ goLiveService }) {
    this.goLiveService = goLiveService;
  }

  get name() {
    return 'ingest';
  }

  async run() {
    const result = await this.goLiveService.checkIngestHealth();
    if (result.skipped) return { status: 'skipped', message: result.reason };

    const ingest = `${result.ingest?.streamStatus ?? 'bilinmiyor'}/${result.ingest?.healthStatus ?? 'bilinmiyor'}`;
    if (result.healthy) return { status: 'healthy', message: `ingest ${ingest}`, detail: result.ingest };
    return {
      status: 'unhealthy',
      message:
        `YAYIN ÖLÜ: broadcast ${result.broadcastId} YouTube'da canlı görünüyor ama ingest veri ` +
        `almıyor (${ingest}). Düzeltme: Studio'dan yayını sonlandır VE encoder'ı yeniden ` +
        'başlat (systemctl restart yt-streamer), sonra go-live\'ı tekrar tetikle.',
      detail: result.ingest,
    };
  }
}

module.exports = { IngestCheck };
