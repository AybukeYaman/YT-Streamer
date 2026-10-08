// Planı HER çalıştırmada okuyan Pomodoro planlayıcı sarmalayıcısı.
//
// NEDEN: PomodoroPlanner tür'ü (50+10) kurulumda alıp döngüyü bir kez çözüyor — doğru
// davranış, çünkü döngü duvar saatine bağlı ve yeniden başlatmalarda kaymaması gerekiyor.
// Ama TUI'da "restart with new configuration" dendiğinde süreç ayakta kalırken Pomodoro
// ayarı DEĞİŞİYOR. Bu sarmalayıcı o tek noktayı çözer: plan imzası (açık/kapalı + tür)
// değiştiyse altındaki gerçek planlayıcıyı YENİDEN kurar, değişmediyse aynısını kullanır.
//
// Pomodoro mantığının kendisi burada YOK — tamamı PomodoroPlanner ve domain/pomodoro'da.
// Burası sadece "hangi planlayıcı geçerli" sorusunu cevaplar.
//
// plan() null döndürürse orchestrator encoder'a hiçbir Pomodoro argümanı geçmez; yani
// "Pomodoro kapalı" durumu, özelliğin hiç kurulmamış hâliyle BİREBİR aynı komutu üretir.
const { PomodoroPlanner } = require('./pomodoro-planner');

class ReconfigurablePomodoroPlanner {
  // planProvider: () => StreamPlan|null — aktif plan
  // breakClipProvider: () => string|null — hazırlanmış mola klibi (dönüşüm dışarıda)
  // createPlanner: ({ type, breakClipPath }) => PomodoroPlanner — testte sahte verilir
  constructor({ planProvider, breakClipProvider = () => null, createPlanner, log }) {
    this.planProvider = typeof planProvider === 'function' ? planProvider : () => null;
    this.breakClipProvider = typeof breakClipProvider === 'function' ? breakClipProvider : () => null;
    this.createPlanner = createPlanner;
    this.log = log;
    this.signature = null;
    this.planner = null;
  }

  plan({ durationSeconds }) {
    const streamPlan = this.planProvider();
    if (!streamPlan || !streamPlan.pomodoro.enabled) {
      if (this.planner) this.log.info('pomodoro kapatıldı — bu çalıştırmada devre dışı');
      this.planner = null;
      this.signature = 'off';
      return null;
    }
    const breakClipPath = this.breakClipProvider();
    // İmzaya mola klibi de girer: yalnızca mola görseli değiştiğinde de yeniden kurulmalı
    // (döngü başlangıcı korunur — PomodoroStore aynı tür için kayıtlı startedAt'ı döndürür).
    const signature = `${streamPlan.pomodoro.type}|${breakClipPath ?? ''}`;
    if (!this.planner || this.signature !== signature) {
      this.planner = this.createPlanner({ type: streamPlan.pomodoro.type, breakClipPath });
      this.signature = signature;
      const rounds = streamPlan.pomodoro.rounds;
      this.log.info(
        `pomodoro yapılandırması uygulandı: ${streamPlan.pomodoro.type}`
        + (rounds ? ` (planda ${rounds} tur)` : '')
        + (breakClipPath ? ', mola klibi var' : ''),
      );
    }
    return this.planner.plan({ durationSeconds });
  }
}

// index.js'in kurduğu fabrika için yardımcı: bağımlılıkları sabitleyip yalnızca tür ve
// mola klibini değişken bırakır. Böylece sarmalayıcı PomodoroOverlayWriter/PomodoroStore
// gibi altyapı nesnelerini hiç tanımaz.
function plannerFactory({ overlayWriter, store, log, now }) {
  return ({ type, breakClipPath }) => new PomodoroPlanner({
    type, overlayWriter, store, log, breakClipPath, ...(now && { now }),
  });
}

module.exports = { ReconfigurablePomodoroPlanner, plannerFactory };
