// Gerçek çökmelerde yayını yeniden başlatan gözetmen. Orchestrator'ın 'exit' olayını dinler:
//   - expected=true (stop() istendi) → karışmaz
//   - expected=false → çökme: ffmpeg code≠0 ile düştü (ya da playlist bitişinde yeniden
//     başlatılamadı). code=0'lı normal playlist bitişi zaten orchestrator'ın içinde ele alınıyor,
//     'exit' bile yaymıyor — supervisor onu hiç görmez.
//
// Üstel geri çekilme: 3 → 6 → 12 → 24 → 48 → 60 sn (tavan). Son (yeniden) başlatmadan beri
// resetAfterMs (5 dk) çökmeden çalıştıysa sayaç başa döner.
//
// TEKRARLAYAN ÇÖKME: crashWindowMs (5 dk) içinde maxCrashes (5) çökme → ALARM verilir ama
// yeniden başlatma ASLA kesilmez. Eskiden burada vazgeçiliyordu ('gave-up'); o davranış iki
// nedenle kaldırıldı (2 Ekim 2026, KARARLAR.md):
//   1. Üretimde hiç işe yaramıyordu: unit'te Restart=always + RestartSec=15 var, süreç
//      çıkınca systemd 15 sn sonra yenisini açıyor ve sayaçlar sıfırdan başlıyordu. Yani
//      "kalıcı durma" gerçekleşmiyor, yalnızca backoff ve pencere mantığı boşa çıkıyordu.
//   2. İstenen davranış tersi: uzun bir ağ kesintisinde (modem reseti) yayın kendiliğinden
//      dönmeli, geri çekilme süreleri de uzatılmamalı — toparlanma hızından ödün yok.
// Gecikme tavanı 60 sn'de bırakıldı: sürekli çöken bir yayında bile dakikada bir deneme olur.
//
// Alarm politikası HealthMonitor'daki ile aynı: eşik aşımında BİR kez bildirim, sonraki
// çökmelerde yalnızca log (telefona her dakika bildirim gitmesin). Yeniden başlatmadan sonra
// resetAfterMs boyunca yeni çökme olmazsa "düzeldi" bildirimi gider ve durum temizlenir.
//
// Olaylar:
//   'crash-loop' ({ crashes }) — tekrarlayan çökme eşiği aşıldı (yayın BIRAKILMADI)
const { EventEmitter } = require('events');
const { NullAlerter } = require('./alerter');

const DEFAULT_DELAYS_MS = [3000, 6000, 12000, 24000, 48000, 60000];
const FIVE_MINUTES = 5 * 60 * 1000;

const seconds = (ms) => `${ms / 1000} sn`;

class Supervisor extends EventEmitter {
  // orchestrator: { start(), resume(), stop(), on('exit') }; log: { info, warn, error }
  // alerter: { alert({ level, title, message }) } — eşik aşımında telefona bildirim.
  //   Varsayılan NullAlerter: bildirim kanalı kurulmamışsa her şey yalnızca log'a gider
  //   (çağıranda "alerter var mı?" dalı açılmasın).
  // setTimer/clearTimer/now: testlerde sahte zaman için
  constructor({
    orchestrator, log, alerter = new NullAlerter(),
    delaysMs = DEFAULT_DELAYS_MS, resetAfterMs = FIVE_MINUTES,
    crashWindowMs = FIVE_MINUTES, maxCrashes = 5,
    now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  }) {
    super();
    Object.assign(this, {
      orchestrator, log, alerter, delaysMs, resetAfterMs, crashWindowMs, maxCrashes, now, setTimer, clearTimer,
    });
    this.attempt = 0; // sıradaki gecikmenin delaysMs indeksi
    this.crashTimes = [];
    this.lastStartAt = null;
    this.timer = null;
    this.stopping = false;
    // crashLoop: eşik aşıldı ve henüz toparlanmadı. Yeniden başlatmayı DURDURMAZ — yalnızca
    // "bu yayın sağlıklı değil" işareti (TUI'de ERROR) ve alarmın tekrarlanmasını engeller.
    this.crashLoop = false;
    // Toparlanma kontrolü: crashLoop'tayken başarılı bir restart'tan resetAfterMs sonra hâlâ
    // ayaktaysa durum temizlenir. Yalnızca crashLoop'ta kurulur — normal çalışmada fazladan
    // zamanlayıcı yok.
    this.recoveryTimer = null;
    this.orchestrator.on('exit', (e) => this.#onExit(e));
  }

  // Dış okuyucular (StreamControlService, TUI, Web UI) için supervisor durumu snapshot'ı.
  // pendingRestart: çökme sonrası yeniden başlatma timer'ı bekliyor mu?
  // crashLoop: eşik aşıldı; yayın hâlâ yeniden başlatılıyor ama sağlıklı değil.
  // Mevcut lifecycle/backoff mantığına dokunmaz, salt okunur kopya döner.
  getSnapshot() {
    return Object.freeze({
      lastStartAt: this.lastStartAt,
      crashLoop: this.crashLoop,
      pendingRestart: this.timer !== null && !this.stopping,
    });
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
    this.#cancelRecoveryCheck();
    await this.orchestrator.stop();
  }

  #onExit({ expected, code, signal }) {
    if (expected || this.stopping) return;
    const t = this.now();
    // Yeni çökme: bekleyen toparlanma kontrolü artık geçersiz.
    this.#cancelRecoveryCheck();

    this.crashTimes = this.crashTimes.filter((c) => t - c < this.crashWindowMs);
    this.crashTimes.push(t);
    // Eşik aşıldı: alarm ver — ama aşağıdaki yeniden başlatmaya dokunma.
    if (this.crashTimes.length >= this.maxCrashes) this.#onRepeatedCrashes();

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
      // Tekrarlayan çökme halindeyken: bu başlatma resetAfterMs boyunca ayakta kalırsa
      // toparlandık sayılır. Araya yeni bir çökme girerse kontrol iptal edilir.
      if (this.crashLoop) this.#scheduleRecoveryCheck();
    } catch (err) {
      // Başlatma da düşerse (örn. playlist yazılamadı) aynı çökme mantığından geçer.
      this.log.error(`yeniden başlatılamadı: ${err.message}`);
      this.#onExit({ expected: false, code: null, signal: null });
    }
  }

  // Eşik aşımı. İlk kez: ERROR + bildirim + 'crash-loop'. Sonraki çökmelerde yalnızca WARN —
  // tek olay logu doldurmasın ve telefona her dakika bildirim gitmesin.
  #onRepeatedCrashes() {
    const crashes = this.crashTimes.length;
    const detail = `${seconds(this.crashWindowMs)} içinde ${crashes} çökme`;
    if (this.crashLoop) {
      this.log.warn(`TEKRARLAYAN ÇÖKME sürüyor (${detail}) — yeniden başlatma devam ediyor, alarm tekrarlanmıyor`);
      return;
    }
    this.crashLoop = true;
    const message =
      `TEKRARLAYAN ÇÖKME: ${detail}. Yayın BIRAKILMIYOR, yeniden başlatma sürüyor ` +
      `(gecikme tavanı ${seconds(this.delaysMs[this.delaysMs.length - 1])}) — ama bu yayın ` +
      'sağlıklı değil. Kontrol: bash scripts/deploy/status.sh';
    this.log.error(message);
    this.emit('crash-loop', { crashes });
    this.#notify({ level: 'error', title: 'YAYIN SORUNU: tekrarlayan çökme', message });
  }

  #scheduleRecoveryCheck() {
    this.recoveryTimer = this.setTimer(() => this.#onRecovered(), this.resetAfterMs);
  }

  #cancelRecoveryCheck() {
    if (this.recoveryTimer === null) return;
    this.clearTimer(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  // resetAfterMs boyunca çökmeden çalıştı: durum temizlenir, bir kez "düzeldi" bildirimi gider.
  #onRecovered() {
    this.recoveryTimer = null;
    if (this.stopping || !this.crashLoop) return;
    this.crashLoop = false;
    this.attempt = 0;
    this.crashTimes = [];
    const message = `tekrarlayan çökme bitti: ${seconds(this.resetAfterMs)} boyunca çökmeden çalıştı`;
    this.log.info(message);
    this.#notify({ level: 'info', title: 'yayın düzeldi', message });
  }

  // Bildirim ASLA gözetmeni düşürmez: alarm kanalı bozuksa yeniden başlatma devam eder.
  // Bilerek await EDİLMEZ — çökme anında bir webhook isteği backoff'u geciktirmemeli.
  #notify(payload) {
    Promise.resolve()
      .then(() => this.alerter.alert(payload))
      .catch((err) => this.log.warn(`bildirim gönderilemedi (${err.message}) — gözetmen etkilenmedi`));
  }
}

module.exports = { Supervisor };
