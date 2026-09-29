// UI-agnostic kontrol katmanı: StreamOrchestrator, Supervisor ve Encoder'ın iç detaylarını
// soyutlar. Gelecekte hem TUI hem Web UI bu servis üzerinden yayın durumunu sorgular ve
// başlatma/durdurma komutları verir — Orchestrator'a veya Supervisor'a doğrudan erişmez.
//
// Mevcut hiçbir davranışı değiştirmez: sadece okuma (getStatus, getCurrentTrack, getUpcomingQueue)
// ve delegasyon (start → Supervisor.start, stop → Supervisor.stop) yapar.
//
// Public getter'lar üzerinden çalışır:
//   orchestrator.getPlaybackState() — çalma durumu snapshot'ı
//   supervisor.getSnapshot()        — supervisor durumu snapshot'ı (pendingRestart dahil)
//   encoder 'log' olayları          — progress verisi (fps, bitrate, speed)

const { PlaybackTimeline } = require('../domain/playback-timeline');

class StreamControlService {
  // orchestrator: { getPlaybackState(), start(), resume(), stop() }
  // supervisor: { getSnapshot(), start(), stop() }
  // encoder: EventEmitter — 'log' olayları (command, progress, stderr, error)
  // log: { info, warn, error }
  // now: () => number — testlerde sahte zaman için
  constructor({ orchestrator, supervisor, encoder, log, now = () => Date.now() }) {
    this.orchestrator = orchestrator;
    this.supervisor = supervisor;
    this.encoder = encoder;
    this.log = log;
    this.now = now;

    // Son progress değerleri — encoder'ın 'log' olayından güncellenir.
    // Yeni FFmpeg süreci başladığında (command) veya stop() sonrası sıfırlanır.
    this.lastProgress = null;

    // stop() çağrıldıktan sonra encoder kapanana kadar gelen progress'leri yoksay.
    this.suppressProgress = false;

    this.encoder.on('log', (entry) => this.#onEncoderLog(entry));
  }

  // ── Sorgulama ────────────────────────────────────────────────

  /**
   * Yayın durumunu döndürür.
   * @returns {{ state: string, uptime: number, fps: number|null, bitrateKbps: number|null,
   *             speed: number|null, runNumber: number }}
   */
  getStatus() {
    const pb = this.orchestrator.getPlaybackState();
    const sup = this.supervisor.getSnapshot();
    const state = this.#resolveState(pb, sup);
    const uptime = this.#calculateUptime(pb, sup);
    return {
      state,
      uptime,
      fps: this.lastProgress?.fps ?? null,
      bitrateKbps: this.lastProgress?.bitrateKbps ?? null,
      speed: this.lastProgress?.speed ?? null,
      runNumber: pb.runNumber,
    };
  }

  /**
   * Şu anda çalan parçayı döndürür. Yayın çalışmıyorsa null.
   * @returns {{ albumName: string, trackTitle: string, trackDuration: number,
   *             elapsedSeconds: number, remainingSeconds: number } | null}
   */
  getCurrentTrack() {
    const pb = this.orchestrator.getPlaybackState();
    if (!pb.running || !pb.currentTracks) return null;

    const tracks = pb.currentTracks;
    const album = pb.currentAlbum;

    // İlk kare gelmeden (playStartedAt === null) henüz gerçekten çalmıyor; ilk parçayı 0 sn ile göster.
    const totalElapsed = pb.playStartedAt === null ? 0 : (this.now() - pb.playStartedAt) / 1000;

    const timeline = new PlaybackTimeline(tracks);
    const index = timeline.indexAt(totalElapsed);
    const track = tracks[index];

    // Bu parçanın playlist içindeki başlangıç anı
    const trackStart = index === 0 ? 0 : timeline.boundaries[index - 1];
    const elapsedInTrack = Math.max(0, totalElapsed - trackStart);
    const remainingInTrack = Math.max(0, track.durationSeconds - elapsedInTrack);

    return {
      albumName: album.name,
      trackTitle: track.title,
      trackDuration: track.durationSeconds,
      elapsedSeconds: Math.round(elapsedInTrack * 10) / 10, // 0.1 sn hassasiyet
      remainingSeconds: Math.round(remainingInTrack * 10) / 10,
    };
  }

  /**
   * Sıradaki parçaları döndürür. Yayın çalışmıyorsa veya kuyruk yoksa boş dizi.
   * Mevcut playlist'te kalan parçaları (çalandan sonrakiler) gösterir.
   * @param {number} limit - En fazla kaç parça döndürülsün (varsayılan 10)
   * @returns {Array<{ albumName: string, trackTitle: string, duration: number }>}
   */
  getUpcomingQueue(limit = 10) {
    const pb = this.orchestrator.getPlaybackState();
    if (!pb.running || !pb.currentTracks) return [];

    const tracks = pb.currentTracks;
    const album = pb.currentAlbum;

    const totalElapsed = pb.playStartedAt === null ? 0 : (this.now() - pb.playStartedAt) / 1000;
    const timeline = new PlaybackTimeline(tracks);
    const currentIndex = timeline.indexAt(totalElapsed);

    // Çalandan sonraki parçalar (aynı playlist içinde)
    const upcoming = tracks.slice(currentIndex + 1, currentIndex + 1 + limit);

    return upcoming.map((t) => ({
      albumName: album.name,
      trackTitle: t.title,
      duration: t.durationSeconds,
    }));
  }

  // ── Komutlar ─────────────────────────────────────────────────

  /**
   * Yayını başlatır. Supervisor'a delege eder.
   * Zaten çalışıyorsa hata fırlatır (Supervisor → Orchestrator.start() zaten fırlatıyor).
   */
  async start() {
    this.log.info('yayın başlatma komutu alındı');
    this.suppressProgress = false;
    await this.supervisor.start();
  }

  /**
   * Yayını durdurur. Supervisor'a delege eder.
   * Çalışmıyorsa sessizce döner (Supervisor → Orchestrator.stop() zaten idempotent).
   *
   * FIX: stop() sırasında encoder hâlâ birkaç progress yayabilir. suppressProgress bayrağı
   * ile bu progress'ler yoksayılır, supervisor.stop() resolve olduktan sonra state temizlenir.
   */
  async stop() {
    this.log.info('yayın durdurma komutu alındı');
    this.suppressProgress = true;
    await this.supervisor.stop();
    this.lastProgress = null;
    this.suppressProgress = false;
  }

  /**
   * Yayını yeniden başlatır: önce durdurur, sonra baştan başlatır.
   * stop() + start() üzerinden gider (Supervisor'a delege) — orchestrator'ın iç durumuna
   * doğrudan dokunmaz. Supervisor'ın çökme-geri-çekilme mantığından bağımsız, elle restart.
   */
  async restart() {
    this.log.info('yayın yeniden başlatma komutu alındı');
    await this.stop();
    await this.start();
  }

  // ── Dahili ───────────────────────────────────────────────────

  // FIX: Supervisor timer bekliyorken (crash → restart arası) 'restarting' döner.
  // Önceki versiyon bu aralıkta yanlış 'stopped' dönerdi.
  #resolveState(pb, sup) {
    if (sup.gaveUp) return 'error';
    if (pb.stopping) return 'stopped'; // stop() istendi, encoder kapanıyor
    if (!pb.running) {
      // Çalışmıyor ama Supervisor yeniden başlatma timer'ı bekliyor → restarting
      return sup.pendingRestart ? 'restarting' : 'stopped';
    }
    // Çalışıyor ama henüz ilk kare gelmemiş — yeni FFmpeg başlatılıyor
    if (pb.playStartedAt === null) return 'restarting';
    return 'running';
  }

  #calculateUptime(pb, sup) {
    if (!sup.lastStartAt) return 0;
    if (!pb.running) return 0;
    return Math.round((this.now() - sup.lastStartAt) / 1000);
  }

  #onEncoderLog(entry) {
    // FIX: Yeni FFmpeg süreci başladığında eski progress'i sıfırla.
    // 'command' olayı her encoder.start() çağrısında yayılır (bkz. FfmpegEncoder satır 170).
    if (entry.kind === 'command') {
      this.lastProgress = null;
      return;
    }
    if (entry.kind !== 'progress') return;
    // FIX: stop() çağrıldıktan sonra encoder kapanana kadar gelen progress'leri yoksay.
    if (this.suppressProgress) return;
    this.lastProgress = {
      fps: entry.fps,
      bitrateKbps: entry.bitrateKbps,
      speed: entry.speed,
    };
  }
}

module.exports = { StreamControlService };
