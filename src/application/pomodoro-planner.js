// Pomodoro'nun tek merkezi: bir ffmpeg çalıştırması için faz çizelgesini, overlay
// metinlerini ve bip zamanlarını üretir. Orchestrator yalnızca plan() çağırır —
// Pomodoro mantığı başka hiçbir yere dağılmaz.
//
// Döngünün başlangıç anı ilk plan()'da belirlenir ve diske yazılır; sonraki her
// çalıştırma (playlist bitişi, çökme sonrası restart, deploy) aynı başlangıcı okur.
// Böylece Pomodoro müziğin değil DUVAR SAATİNİN hızında ilerler: parça süreleri,
// playlist uzunluğu ve ffmpeg yeniden başlatmaları döngüyü kaydırmaz.
//
// N3 — ÇOKLU study/break klibi: her segmentin klibi seededShuffle(havuz, seed,
// segment.phaseIndex) ile DETERMİNİSTİK seçilir (bkz. src/domain/seeded-shuffle.js).
// seed de startedAt gibi diske yazılır ve bir kez belirlenir — restart/çökme/deploy
// seçimi KAYDIRMAZ, aynı faz hep aynı klibe düşer (PLAN-yapilandirma-ui.md Faz N3,
// "Seçim RESTART'A DAYANIKLI olmalı").
const { PomodoroCycle, STUDY } = require('../domain/pomodoro');
const { shuffledAt } = require('../domain/seeded-shuffle');

// Bir çalıştırmada en fazla bu kadar FARKLI klip ffmpeg girişi açabilir. Her ek giriş
// -stream_loop ile sürekli decode edilir; VPS 2 vCPU'da encode zaten ~1.000x sınırına
// yakın (bkz. PLAN-yapilandirma-ui.md Faz N3 "CPU" notu). Sınırı aşan fazlar, bu
// çalıştırmada ZATEN kullanılan kliplerden birine deterministik olarak düşürülür.
const MAX_CLIPS_PER_RUN = 4;

function capClipsPerRun(entries, max) {
  const distinct = [];
  for (const e of entries) if (!distinct.includes(e.path)) distinct.push(e.path);
  if (distinct.length <= max) return entries.map(({ path, start, end }) => ({ path, start, end }));
  const allowed = distinct.slice(0, max);
  return entries.map((e) => ({
    path: allowed.includes(e.path) ? e.path : allowed[e.phaseIndex % allowed.length],
    start: e.start,
    end: e.end,
  }));
}

class PomodoroPlanner {
  // type: '50+10' | '30+10'; overlayWriter: PomodoroOverlayWriter; store: PomodoroStore
  // studyClips/breakClips: hazırlanmış (yayın formatına çevrilmiş) klip yolu HAVUZU —
  //   boşsa o fazda hiç klip overlay'i yok (albümün kendi arkaplanı görünür).
  // randomSeed: () => number — yalnızca döngü İLK başladığında çağrılır (testte sahte
  //   vermek için); varsayılan Math.random tabanlı, çünkü seed'in kendisi deterministik
  //   olmak ZORUNDA değil, sadece bir kez belirlenip SONRASINDA sabit kalması gerekiyor.
  constructor({
    type, overlayWriter, store, log, studyClips = [], breakClips = [],
    now = () => Date.now(), randomSeed = () => Math.floor(Math.random() * 0x7fffffff),
  }) {
    this.type = type;
    this.studyClips = studyClips;
    this.breakClips = breakClips;
    this.overlayWriter = overlayWriter;
    this.store = store;
    this.log = log;
    this.now = now;
    this.randomSeed = randomSeed;
    this.cycle = null;
    this.seed = null;
  }

  // Döngüyü bir kez çözer: diskte geçerli kayıt varsa oradan, yoksa şimdi başlatıp yazar.
  #resolveCycle() {
    if (this.cycle) return this.cycle;
    const saved = this.store.load(this.type);
    const startedAt = saved ? saved.startedAt : this.now();
    const seed = saved ? saved.seed : this.randomSeed();
    if (!saved) {
      this.store.save({ type: this.type, startedAt, seed });
      this.log.info(`pomodoro döngüsü başladı: ${this.type}`);
    } else {
      const dakika = Math.round((this.now() - saved.startedAt) / 60000);
      this.log.info(`pomodoro döngüsü sürüyor: ${this.type}, ${dakika} dk önce başlamış`);
    }
    this.cycle = new PomodoroCycle({ type: this.type, startedAt });
    this.seed = seed;
    return this.cycle;
  }

  // durationSeconds: bu çalıştırmanın (playlist'in) uzunluğu.
  // Dönüş: { pomodoro, beepTimes, phase, phaseBackgrounds } — encoder'a olduğu gibi geçer.
  plan({ durationSeconds }) {
    const cycle = this.#resolveCycle();
    const nowMs = this.now();
    const segments = cycle.segmentsFor({ nowMs, durationSeconds });
    // Geri sayım da aynı nowMs'ten: sayaç ile STUDY/BREAK yazısı tek kaynaktan geldiği
    // için birbirinden kayamaz (mevcut ilke, klip atamasında da aynısı geçerli: her
    // segmentin klibi KENDİ phaseIndex'inden, tek kaynaktan türüyor).
    const pomodoro = this.overlayWriter.write(segments, cycle.countdownFor({ nowMs }));
    const beepTimes = cycle.beepTimesFor({ nowMs, durationSeconds });

    const assigned = [];
    for (const seg of segments) {
      const pool = seg.phase === STUDY ? this.studyClips : this.breakClips;
      const clip = shuffledAt(pool, this.seed, seg.phaseIndex);
      if (clip) assigned.push({ path: clip, start: seg.start, end: seg.end, phaseIndex: seg.phaseIndex });
    }
    const phaseBackgrounds = capClipsPerRun(assigned, MAX_CLIPS_PER_RUN);

    const { phase, remainingSeconds } = cycle.phaseAt(nowMs);
    this.log.info(
      `pomodoro: ${cycle.label}, şu an ${phase.toUpperCase()} `
      + `(${Math.round(remainingSeconds / 60)} dk kaldı), bu çalıştırmada `
      + `${segments.length} faz / ${beepTimes.length} bip`
      + (phaseBackgrounds.length ? `, ${phaseBackgrounds.length} klip penceresi` : ''),
    );
    return { pomodoro, beepTimes, phase, phaseBackgrounds };
  }
}

module.exports = { PomodoroPlanner, MAX_CLIPS_PER_RUN };
