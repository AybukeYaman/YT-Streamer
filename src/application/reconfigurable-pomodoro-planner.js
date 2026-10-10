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
  // studyClipsProvider/breakClipsProvider: () => string[] — hazırlanmış klip havuzu
  //   (dönüşüm dışarıda, StreamConfigService'te; N3 çoklu klip)
  // createPlanner: ({ type, studyClips, breakClips }) => PomodoroPlanner — testte sahte verilir
  constructor({
    planProvider, studyClipsProvider = () => [], breakClipsProvider = () => [], createPlanner, log,
  }) {
    this.planProvider = typeof planProvider === 'function' ? planProvider : () => null;
    this.studyClipsProvider = typeof studyClipsProvider === 'function' ? studyClipsProvider : () => [];
    this.breakClipsProvider = typeof breakClipsProvider === 'function' ? breakClipsProvider : () => [];
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
    const studyClips = this.studyClipsProvider();
    const breakClips = this.breakClipsProvider();
    // İmzaya klip havuzları da girer: yalnızca görseller değiştiğinde de yeniden kurulmalı
    // (döngü başlangıcı korunur — PomodoroStore aynı tür için kayıtlı startedAt/seed'i
    // döndürür, bkz. pomodoro-planner.js).
    const signature = `${streamPlan.pomodoro.type}|${studyClips.join(',')}|${breakClips.join(',')}`;
    if (!this.planner || this.signature !== signature) {
      this.planner = this.createPlanner({ type: streamPlan.pomodoro.type, studyClips, breakClips });
      this.signature = signature;
      const rounds = streamPlan.pomodoro.rounds;
      this.log.info(
        `pomodoro yapılandırması uygulandı: ${streamPlan.pomodoro.type}`
        + (rounds ? ` (planda ${rounds} tur)` : '')
        + (studyClips.length ? `, ${studyClips.length} çalışma klibi` : '')
        + (breakClips.length ? `, ${breakClips.length} mola klibi` : ''),
      );
    }
    return this.planner.plan({ durationSeconds });
  }
}

// index.js'in kurduğu fabrika için yardımcı: bağımlılıkları sabitleyip yalnızca tür ve
// klip havuzlarını değişken bırakır. Böylece sarmalayıcı PomodoroOverlayWriter/
// PomodoroStore gibi altyapı nesnelerini hiç tanımaz.
function plannerFactory({ overlayWriter, store, log, now }) {
  return ({ type, studyClips, breakClips }) => new PomodoroPlanner({
    type, overlayWriter, store, log, studyClips, breakClips, ...(now && { now }),
  });
}

module.exports = { ReconfigurablePomodoroPlanner, plannerFactory };
