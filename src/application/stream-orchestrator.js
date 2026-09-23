// Yayını yöneten beyin. Encoder'ı sadece Encoder sözleşmesi üzerinden kullanır —
// child_process'i ya da ffmpeg'i bilmez (Faz 7'de infrastructure değişince burası aynı kalır).
//
// Şimdilik tek sabit parça çalar; kuyruk Faz 3'ün işi.
//
// Olaylar:
//   'exit' ({ expected, code, signal }) — encoder kapandı; expected=false ise stop() istenmeden
const { EventEmitter } = require('events');

const PROGRESS_LOG_INTERVAL_MS = 5000;

class StreamOrchestrator extends EventEmitter {
  // encoder: Encoder sözleşmesine uyan nesne; log: { debug, info, warn, error }
  constructor({ encoder, log, trackPath, now = () => Date.now() }) {
    super();
    this.encoder = encoder;
    this.log = log;
    this.trackPath = trackPath;
    this.now = now;
    this.running = false;
    this.stopping = false;
    this.lastProgressLog = -Infinity;

    this.encoder.on('log', (entry) => this.#onEncoderLog(entry));
    this.encoder.on('exit', (code, signal) => this.#onEncoderExit(code, signal));
  }

  start() {
    if (this.running) throw new Error('StreamOrchestrator zaten çalışıyor');
    this.running = true;
    this.stopping = false;
    this.log.info(`yayın başlıyor, parça: ${this.trackPath}`);
    this.encoder.start({ audioPath: this.trackPath });
  }

  async stop() {
    if (!this.running) return;
    this.stopping = true;
    this.log.info('yayın durduruluyor');
    await this.encoder.stop();
  }

  // ffmpeg'in ham stderr'i sadece dosyaya (debug); ilerleme ~2/sn geldiği için 5 sn'de bir.
  #onEncoderLog(entry) {
    switch (entry.kind) {
      case 'command':
        this.log.info(`ffmpeg başlatılıyor: ${entry.args.join(' ')}`);
        break;
      case 'progress':
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
    const expected = this.stopping;
    this.running = false;
    this.stopping = false;
    const message = `ffmpeg kapandı (code=${code}, signal=${signal})`;
    if (expected) this.log.info(message);
    else this.log.error(`${message} — beklenmeyen kapanış`);
    this.emit('exit', { expected, code, signal });
  }
}

module.exports = { StreamOrchestrator };
