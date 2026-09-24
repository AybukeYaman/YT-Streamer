// Yayını yöneten beyin. Encoder'ı sadece Encoder sözleşmesi üzerinden kullanır —
// child_process'i, ffmpeg'i ya da dosya sistemini bilmez (Faz 7'de infrastructure değişince
// burası aynı kalır).
//
// B yaklaşımı (KARARLAR.md, Faz 3.1): uzun bir playlist yazılır, encoder playlist modunda
// başlar; playlist bitince encoder code=0 ile kapanır, orchestrator kuyruğun kaldığı yerden
// yeni playlist yazıp encoder'ı hemen yeniden başlatır.
//
// code !== 0 (gerçek çökme) bu fazın kapsamı dışında: sadece loglanır, restart denenmez.
// Üstel geri çekilme ve crash loop koruması Faz 5'in işi.
//
// Olaylar:
//   'exit' ({ expected, code, signal }) — yayın durdu; expected=false ise stop() istenmeden
const { EventEmitter } = require('events');
const { Queue } = require('../domain/queue');
const { PlaylistWriter } = require('./playlist-writer');

const PROGRESS_LOG_INTERVAL_MS = 5000;

const minutes = (s) => `${(s / 60).toFixed(1)} dk`;

class StreamOrchestrator extends EventEmitter {
  // encoder: Encoder sözleşmesi; log: { debug, info, warn, error }
  // trackRepository: { list(): Promise<Track[]> }
  // queue: { mode, batchSize }; playlistPath: mutlak yol; writeFile: atomik yazma
  constructor({
    encoder, log, trackRepository, queue, playlistPath, writeFile,
    now = () => Date.now(), random = Math.random,
  }) {
    super();
    this.encoder = encoder;
    this.log = log;
    this.trackRepository = trackRepository;
    this.queueOptions = queue;
    this.playlistPath = playlistPath;
    this.writeFile = writeFile;
    this.now = now;
    this.random = random;

    this.running = false;
    this.stopping = false;
    this.runNumber = 0;
    this.playlistWriter = null;
    this.lastProgressLog = -Infinity;
    this.restartStartedAt = null; // önceki ffmpeg'in kapandığı an; ilk frame gelince boşluk ölçülür
    this.restartGapsMs = [];

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

  async stop() {
    if (!this.running) return;
    this.stopping = true;
    this.log.info('yayın durduruluyor');
    await this.encoder.stop();
  }

  #startNextPlaylist() {
    this.runNumber++;
    const playlist = this.playlistWriter.writeNext();
    this.log.info(
      `playlist #${this.runNumber}: ${playlist.tracks.length} parça, ${minutes(playlist.totalDurationSeconds)} — ` +
      playlist.tracks.map((t) => t.title).join(' | '),
    );
    this.encoder.start({ playlistPath: playlist.path, runNumber: this.runNumber });
  }

  // ffmpeg'in ham stderr'i sadece dosyaya (debug); ilerleme ~2/sn geldiği için 5 sn'de bir.
  #onEncoderLog(entry) {
    switch (entry.kind) {
      case 'command':
        this.log.info(`ffmpeg başlatılıyor: ${entry.args.join(' ')}`);
        break;
      case 'progress':
        if (this.restartStartedAt !== null && entry.frame > 0) {
          const gap = this.now() - this.restartStartedAt;
          this.restartStartedAt = null;
          this.restartGapsMs.push(gap);
          this.log.info(`restart boşluğu: ${gap} ms (önceki ffmpeg'in kapanışından yeni sürecin ilk frame'ine)`);
        }
        if (this.now() - this.lastProgressLog < PROGRESS_LOG_INTERVAL_MS) return;
        this.lastProgressLog = this.now();
        this.log.info(`frame=${entry.frame} fps=${entry.fps} bitrate=${entry.bitrateKbps}kbps speed=${entry.speed}x`);
        break;
      case 'stderr':
        this.log.debug(entry.line);
        break;
      case 'error':
        this.log.error(entry.message);
        break;
    }
  }

  #onEncoderExit(code, signal) {
    const message = `ffmpeg kapandı (code=${code}, signal=${signal})`;

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

    this.log.error(`${message} — beklenmeyen kapanış; restart denenmiyor (çökme yönetimi Faz 5'in işi)`);
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
