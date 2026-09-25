// Gerçek çökmelerde yayını yeniden başlatan gözetmen. Orchestrator'ın 'exit' olayını dinler:
//   - expected=true (stop() istendi) → karışmaz
//   - expected=false → çökme: ffmpeg code≠0 ile düştü (ya da playlist bitişinde yeniden
//     başlatılamadı). code=0'lı normal playlist bitişi zaten orchestrator'ın içinde ele alınıyor,
//     'exit' bile yaymıyor — supervisor onu hiç görmez.
//
// Üstel geri çekilme: 3 → 6 → 12 → 24 → 48 → 60 sn (tavan). Son (yeniden) başlatmadan beri
// resetAfterMs (5 dk) çökmeden çalıştıysa sayaç başa döner.
// Crash loop koruması: crashWindowMs (5 dk) içinde maxCrashes (5) çökme → yeniden başlatmayı
// bırakır, açık bir alarm loglar, 'gave-up' yayar (sonsuz döngü yok).
//
// Olaylar:
//   'gave-up' ({ crashes }) — crash loop, supervisor vazgeçti
const { EventEmitter } = require('events');

const DEFAULT_DELAYS_MS = [3000, 6000, 12000, 24000, 48000, 60000];
const FIVE_MINUTES = 5 * 60 * 1000;

const seconds = (ms) => `${ms / 1000} sn`;

class Supervisor extends EventEmitter {
  // orchestrator: { start(), resume(), stop(), on('exit') }; log: { info, warn, error }
  // setTimer/clearTimer/now: testlerde sahte zaman için
  constructor({
    orchestrator, log,
    delaysMs = DEFAULT_DELAYS_MS, resetAfterMs = FIVE_MINUTES,
    crashWindowMs = FIVE_MINUTES, maxCrashes = 5,
    now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  }) {
    super();
    Object.assign(this, { orchestrator, log, delaysMs, resetAfterMs, crashWindowMs, maxCrashes, now, setTimer, clearTimer });
    this.attempt = 0; // sıradaki gecikmenin delaysMs indeksi
    this.crashTimes = [];
    this.lastStartAt = null;
    this.timer = null;
    this.stopping = false;
    this.gaveUp = false;
    this.orchestrator.on('exit', (e) => this.#onExit(e));
  }

  async start() {
    this.stopping = false;
    this.lastStartAt = this.now();
    await this.orchestrator.start();
  }

  // Bekleyen yeniden başlatmayı iptal eder, yayın çalışıyorsa temiz kapatır.
  async stop() {
    this.stopping = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
      this.log.info('bekleyen yeniden başlatma iptal edildi');
    }
    await this.orchestrator.stop();
  }

  #onExit({ expected, code, signal }) {
    if (expected || this.stopping) return;
    const t = this.now();

    this.crashTimes = this.crashTimes.filter((c) => t - c < this.crashWindowMs);
    this.crashTimes.push(t);
    if (this.crashTimes.length >= this.maxCrashes) {
      this.gaveUp = true;
      this.log.error(
        `CRASH LOOP: ${seconds(this.crashWindowMs)} içinde ${this.crashTimes.length} çökme — ` +
        'yeniden başlatma bırakıldı, yayın DURDU. Elle müdahale gerekiyor.',
      );
      this.emit('gave-up', { crashes: this.crashTimes.length });
      return;
    }

    const uptime = this.lastStartAt === null ? 0 : t - this.lastStartAt;
    if (uptime >= this.resetAfterMs) this.attempt = 0;
    const delay = this.delaysMs[Math.min(this.attempt, this.delaysMs.length - 1)];
    this.attempt++;
    this.log.warn(
      `çökme (code=${code}, signal=${signal}, ${seconds(Math.round(uptime / 100) * 100)} çalıştı) — ` +
      `${seconds(delay)} sonra yeniden başlatılacak (deneme ${this.attempt}, son ${seconds(this.crashWindowMs)}: ` +
      `${this.crashTimes.length}/${this.maxCrashes} çökme)`,
    );
    this.timer = this.setTimer(() => this.#restart(), delay);
  }

  async #restart() {
    this.timer = null;
    if (this.stopping) return;
    this.lastStartAt = this.now();
    try {
      await this.orchestrator.resume();
      this.log.info(`yeniden başlatıldı (deneme ${this.attempt})`);
    } catch (err) {
      // Başlatma da düşerse (örn. playlist yazılamadı) aynı çökme mantığından geçer.
      this.log.error(`yeniden başlatılamadı: ${err.message}`);
      this.#onExit({ expected: false, code: null, signal: null });
    }
  }
}

module.exports = { Supervisor };
