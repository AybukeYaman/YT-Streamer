// Yayını yöneten beyin. Encoder'ı sadece Encoder sözleşmesi üzerinden kullanır —
// child_process'i, ffmpeg'i ya da dosya sistemini bilmez (Faz 7'de infrastructure değişince
// burası aynı kalır).
//
// B yaklaşımı (KARARLAR.md, Faz 3.1): uzun bir playlist yazılır, encoder playlist modunda
// başlar; playlist bitince encoder code=0 ile kapanır, orchestrator kuyruğun kaldığı yerden
// yeni playlist yazıp encoder'ı hemen yeniden başlatır.
//
// code !== 0 (gerçek çökme) burada ele alınmaz: loglanır, 'exit' (expected=false) yayılır.
// Yeniden başlatma kararı (üstel geri çekilme, crash loop koruması) Supervisor'da; o da
// resume() ile kaldığı yerden devam ettirir.
//
// Olaylar:
//   'exit' ({ expected, code, signal }) — yayın durdu; expected=false ise stop() istenmeden
const { EventEmitter } = require('events');
const { Queue } = require('../domain/queue');
const { PlaybackTimeline } = require('../domain/playback-timeline');
const { PlaylistWriter } = require('./playlist-writer');

const PROGRESS_LOG_INTERVAL_MS = 5000;

const minutes = (s) => `${(s / 60).toFixed(1)} dk`;

class StreamOrchestrator extends EventEmitter {
  // encoder: Encoder sözleşmesi; log: { debug, info, warn, error }
  // trackRepository: { list(): Promise<Track[]> }
  // queue: { mode, batchSize }; playlistPath: mutlak yol; writeFile: atomik yazma
  // nowPlayingWriter: { writeAll(titles): string[] } — verilirse (overlay açık) her playlist'te
  // parça başlıkları yazılır ve encoder'a parça başına zaman aralığıyla verilir
  constructor({
    encoder, log, trackRepository, queue, playlistPath, writeFile,
    nowPlayingWriter = null, speedWindow = null,
    now = () => Date.now(), random = Math.random,
  }) {
    super();
    // speedWindow: SpeedWindow — anlık hızın 30 sn pencere ortalaması; eşik dışına çıkınca
    // uyarı loglanır (sadece görünürlük, otomatik aksiyon yok)
    this.speedWindow = speedWindow;
    this.speedState = 'warming';
    this.encoder = encoder;
    this.log = log;
    this.trackRepository = trackRepository;
    this.queueOptions = queue;
    this.playlistPath = playlistPath;
    this.writeFile = writeFile;
    this.nowPlayingWriter = nowPlayingWriter;
    this.now = now;
    this.random = random;

    this.running = false;
    this.stopping = false;
    this.runNumber = 0;
    this.playlistWriter = null;
    this.lastProgressLog = -Infinity;
    this.restartStartedAt = null; // önceki ffmpeg'in kapandığı an; ilk frame gelince boşluk ölçülür
    this.restartGapsMs = [];
    this.currentTracks = null; // çalan playlist'in parçaları (çökme sonrası kaldığı yer için)
    this.playStartedAt = null; // bu playlist'in ilk karesinin geldiği an
    this.crashedAt = null;

    this.encoder.on('log', (entry) => this.#onEncoderLog(entry));
    this.encoder.on('exit', (code, signal) => this.#onEncoderExit(code, signal));
  }

  async start() {
    if (this.running) throw new Error('StreamOrchestrator zaten çalışıyor');
    this.running = true;
    this.stopping = false;
    try {
      const tracks = await this.trackRepository.list();
      const queue = new Queue({ tracks, mode: this.queueOptions.mode, random: this.random });
      this.playlistWriter = new PlaylistWriter({
        queue, batchSize: this.queueOptions.batchSize, playlistPath: this.playlistPath, writeFile: this.writeFile,
      });
      this.log.info(`yayın başlıyor: ${tracks.length} parça, mod=${queue.mode}, batchSize=${this.queueOptions.batchSize}`);
      this.#startNextPlaylist();
    } catch (err) {
      this.running = false;
      throw err;
    }
  }

  // Çökme sonrası yeniden başlatma (Supervisor çağırır). Kuyruk korunur; yarım kalan
  // playlist o an çalan parçadan itibaren yeniden yazılır — o parça baştan çalar ama
  // kalan parçalar atlanmaz (batchSize=50'de onlarca parça kaybolurdu).
  // Hiç başlamamışsa (start() de düştüyse) sıfırdan start().
  async resume() {
    if (this.running) throw new Error('StreamOrchestrator zaten çalışıyor');
    if (!this.playlistWriter) return this.start();
    this.running = true;
    this.stopping = false;
    try {
      const remaining = this.#remainingTracks();
      this.#startNextPlaylist(remaining && this.playlistWriter.write(remaining), remaining ? ' (kaldığı parçadan devam)' : '');
    } catch (err) {
      this.running = false;
      throw err;
    }
  }

  async stop() {
    if (!this.running) return;
    this.stopping = true;
    this.log.info('yayın durduruluyor');
    await this.encoder.stop();
  }

  // Çöken playlist'te çökme anında çalan parça ve sonrası. Konum duvar saatinden (ilk
  // karenin geldiği andan çökmeye) — speed ≈ 1x olduğu için parça seçmeye yeter.
  #remainingTracks() {
    if (!this.currentTracks) return null;
    const elapsed = this.playStartedAt === null ? 0 : (this.crashedAt - this.playStartedAt) / 1000;
    return this.currentTracks.slice(new PlaybackTimeline(this.currentTracks).indexAt(elapsed));
  }

  #startNextPlaylist(playlist = this.playlistWriter.writeNext(), note = '') {
    this.runNumber++;
    this.currentTracks = playlist.tracks;
    this.playStartedAt = null;
    this.speedWindow?.reset(this.now()); // yeni süreç: ilk 30 sn pencereye girmez
    this.speedState = 'warming';
    this.log.info(
      `playlist #${this.runNumber}${note}: ${playlist.tracks.length} parça, ${minutes(playlist.totalDurationSeconds)} — ` +
      playlist.tracks.map((t) => t.title).join(' | '),
    );
    const overlayTexts = this.nowPlayingWriter ? this.#writeOverlayTexts(playlist.tracks) : undefined;
    this.encoder.start({ playlistPath: playlist.path, runNumber: this.runNumber, ...(overlayTexts && { overlayTexts }) });
  }

  // Başlık dosyalarını yazar, her birini parçanın zaman aralığıyla eşler. Zamanlama ffmpeg'de
  // (drawtext enable, video zaman damgası t) — Node tarafında frame takibi yok.
  #writeOverlayTexts(tracks) {
    const segments = new PlaybackTimeline(tracks).segments();
    const files = this.nowPlayingWriter.writeAll(tracks.map((t) => t.title));
    return segments.map(({ start, end }, i) => ({ textFile: files[i], start, end }));
  }

  // ffmpeg'in ham stderr'i sadece dosyaya (debug); ilerleme ~2/sn geldiği için 5 sn'de bir.
  #onEncoderLog(entry) {
    switch (entry.kind) {
      case 'command':
        this.log.info(`ffmpeg başlatılıyor: ${entry.args.join(' ')}`);
        break;
      case 'progress':
        if (this.playStartedAt === null && entry.frame > 0) this.playStartedAt = this.now();
        if (this.restartStartedAt !== null && entry.frame > 0) {
          const gap = this.now() - this.restartStartedAt;
          this.restartStartedAt = null;
          this.restartGapsMs.push(gap);
          this.log.info(`restart boşluğu: ${gap} ms (önceki ffmpeg'in kapanışından yeni sürecin ilk frame'ine)`);
        }
        const speed = this.#checkSpeed(entry.frame);
        if (this.now() - this.lastProgressLog < PROGRESS_LOG_INTERVAL_MS) return;
        this.lastProgressLog = this.now();
        // speed= ffmpeg'in süreç başından ortalaması; hız(30sn) bizim pencere ortalamamız.
        const windowed = speed?.average == null ? 'ısınıyor' : `${speed.average.toFixed(3)}x`;
        this.log.info(`frame=${entry.frame} fps=${entry.fps} bitrate=${entry.bitrateKbps}kbps speed=${entry.speed}x hız(30sn)=${windowed}`);
        break;
      case 'stderr':
        this.log.debug(entry.line);
        break;
      case 'error':
        this.log.error(entry.message);
        break;
    }
  }

  // Pencereyi günceller; durum değiştiğinde (her satırda değil) uyarı/bilgi loglar.
  #checkSpeed(frame) {
    if (!this.speedWindow) return null;
    const now = this.now();
    this.speedWindow.add(frame, now);
    const status = this.speedWindow.status(now);
    if (status.state !== this.speedState && status.state !== 'warming') {
      const avg = `${status.average.toFixed(3)}x`;
      const { low, high } = this.speedWindow;
      if (status.state === 'slow') this.log.warn(`encode yetişemiyor: hız(30sn)=${avg} < ${low}`);
      else if (status.state === 'fast') this.log.warn(`anormal hız, sessiz arıza olabilir: hız(30sn)=${avg} > ${high}`);
      else if (this.speedState !== 'warming') this.log.info(`hız normale döndü: hız(30sn)=${avg}`);
      this.speedState = status.state;
    }
    return status;
  }

  #onEncoderExit(code, signal) {
    const message = `ffmpeg kapandı (code=${code}, signal=${signal})`;
    this.crashedAt = this.now();

    if (this.stopping) {
      this.log.info(message);
      this.#finish({ expected: true, code, signal });
      return;
    }

    if (code === 0) {
      // Beklenen playlist bitişi (-shortest) — kuyruğun kaldığı yerden devam et.
      this.log.info(`${message} — playlist #${this.runNumber} bitti, yeniden başlatılıyor`);
      this.restartStartedAt = this.now();
      try {
        this.#startNextPlaylist();
      } catch (err) {
        this.log.error(`yeniden başlatılamadı: ${err.message}`);
        this.#finish({ expected: false, code, signal });
      }
      return;
    }

    this.log.error(`${message} — beklenmeyen kapanış (yeniden başlatma kararı supervisor'da)`);
    this.#finish({ expected: false, code, signal });
  }

  #finish(result) {
    this.running = false;
    this.stopping = false;
    this.restartStartedAt = null;
    this.emit('exit', result);
  }
}

module.exports = { StreamOrchestrator };
