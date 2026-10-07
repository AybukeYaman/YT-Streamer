// Pomodoro'nun tek merkezi: bir ffmpeg çalıştırması için faz çizelgesini, overlay
// metinlerini ve bip zamanlarını üretir. Orchestrator yalnızca plan() çağırır —
// Pomodoro mantığı başka hiçbir yere dağılmaz.
//
// Döngünün başlangıç anı ilk plan()'da belirlenir ve diske yazılır; sonraki her
// çalıştırma (playlist bitişi, çökme sonrası restart, deploy) aynı başlangıcı okur.
// Böylece Pomodoro müziğin değil DUVAR SAATİNİN hızında ilerler: parça süreleri,
// playlist uzunluğu ve ffmpeg yeniden başlatmaları döngüyü kaydırmaz.
const { PomodoroCycle, BREAK } = require('../domain/pomodoro');

class PomodoroPlanner {
  // type: '50+10' | '30+10'; overlayWriter: PomodoroOverlayWriter; store: PomodoroStore
  // breakClipPath: molada gösterilecek hazır klip (yoksa molada normal arkaplan kalır)
  constructor({ type, overlayWriter, store, log, breakClipPath = null, now = () => Date.now() }) {
    this.type = type;
    this.breakClipPath = breakClipPath;
    this.overlayWriter = overlayWriter;
    this.store = store;
    this.log = log;
    this.now = now;
    this.cycle = null;
  }

  // Döngüyü bir kez çözer: diskte geçerli kayıt varsa oradan, yoksa şimdi başlatıp yazar.
  #resolveCycle() {
    if (this.cycle) return this.cycle;
    const saved = this.store.load(this.type);
    const startedAt = saved ?? this.now();
    if (saved === null) {
      this.store.save({ type: this.type, startedAt });
      this.log.info(`pomodoro döngüsü başladı: ${this.type}`);
    } else {
      const dakika = Math.round((this.now() - saved) / 60000);
      this.log.info(`pomodoro döngüsü sürüyor: ${this.type}, ${dakika} dk önce başlamış`);
    }
    this.cycle = new PomodoroCycle({ type: this.type, startedAt });
    return this.cycle;
  }

  // durationSeconds: bu çalıştırmanın (playlist'in) uzunluğu.
  // Dönüş: { pomodoro, beepTimes, phase } — encoder'a olduğu gibi geçer.
  plan({ durationSeconds }) {
    const cycle = this.#resolveCycle();
    const nowMs = this.now();
    const segments = cycle.segmentsFor({ nowMs, durationSeconds });
    const pomodoro = this.overlayWriter.write(cycle, segments);
    const beepTimes = cycle.beepTimesFor({ nowMs, durationSeconds });
    // Mola arkaplanı: molanın zaman pencereleri BREAK yazısıyla aynı segmentlerden
    // türüyor — görsel ile yazı tek kaynaktan geldiği için birbirinden kayamaz.
    const breakWindows = segments
      .filter((s) => s.phase === BREAK)
      .map(({ start, end }) => ({ start, end }));
    const breakBackground = this.breakClipPath && breakWindows.length
      ? { path: this.breakClipPath, windows: breakWindows }
      : null;
    const { phase, remainingSeconds } = cycle.phaseAt(nowMs);
    this.log.info(
      `pomodoro: ${cycle.label}, şu an ${phase.toUpperCase()} `
      + `(${Math.round(remainingSeconds / 60)} dk kaldı), bu çalıştırmada `
      + `${segments.length} faz / ${beepTimes.length} bip`,
    );
    return { pomodoro, beepTimes, phase, breakBackground };
  }
}

module.exports = { PomodoroPlanner };
