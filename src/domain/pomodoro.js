// Pomodoro döngüsü: çalışma/mola fazlarının gerçek zamana bağlı çizelgesi.
// Saf domain — I/O yok, Node modülü import etmez, Date.now() okumaz (zaman dışarıdan gelir).
//
// NEDEN ÖNCEDEN HESAPLANIYOR: overlay zamanlaması ffmpeg'in kendi video zaman damgasına (t)
// bağlı. Node tarafından çalışırken metin güncellemek ~12 sn geç kalıyor — ffmpeg videoyu
// kuyrukta önden işliyor (KARARLAR.md, Faz 4.4). Bu yüzden parça başlıklarında olduğu gibi
// burada da fazlar ffmpeg başlamadan önce hesaplanıp drawtext enable aralığı olarak veriliyor.
//
// ffmpeg her playlist'te yeniden başlıyor ve t her seferinde 0'dan sayıyor; Pomodoro ise
// gerçek zamanda akmalı. Köprü `startedAt`: döngünün başladığı an (epoch ms). Her çalıştırmada
// "şu an döngünün kaçıncı saniyesindeyiz" hesaplanır ve çizelge oradan üretilir. Yeniden
// başlatma, çökme, deploy — hiçbiri döngüyü kaydırmaz, çünkü tek kaynak duvar saati.

class PomodoroError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PomodoroError';
  }
}

// Yeni tür eklemek: buraya bir satır. Başka hiçbir yere dokunmak gerekmiyor —
// etiket ve süreler buradan türüyor.
const POMODORO_TYPES = Object.freeze({
  '50+10': Object.freeze({ studyMinutes: 50, breakMinutes: 10 }),
  '30+10': Object.freeze({ studyMinutes: 30, breakMinutes: 10 }),
});

// Hazır listede olmayan tür: "<calisma>+<mola>" (dakika) biçiminde SERBEST süre.
// Neden ayrı bir "custom" alanı YOK: tür zaten "50+10" gibi okunabilir bir metin, yani
// serbest süreler aynı anahtarın içine sığıyor. Böylece config doğrulaması, PomodoroStore
// (tür değişince döngü sıfırlanır), etiket ("POMODORO 45+15") ve TUI tek kaynaktan
// (resolvePomodoroType) besleniyor — serbest süre için ikinci bir yol açılmıyor.
const CUSTOM_TYPE_RE = /^(\d{1,3})\+(\d{1,3})$/;

// Tür → { studyMinutes, breakMinutes }. Tanınmayan tür için null (çağıran hata üretir).
function resolvePomodoroType(type) {
  if (typeof type !== 'string') return null;
  const key = type.trim();
  if (POMODORO_TYPES[key]) return POMODORO_TYPES[key];
  const m = CUSTOM_TYPE_RE.exec(key);
  if (!m) return null;
  const studyMinutes = Number(m[1]);
  const breakMinutes = Number(m[2]);
  if (studyMinutes <= 0 || breakMinutes <= 0) return null;
  return Object.freeze({ studyMinutes, breakMinutes });
}

// Hata/yardım metinlerinde tek biçim kullanılsın diye.
const POMODORO_TYPE_HINT = `${Object.keys(POMODORO_TYPES).join(', ')} ya da "<calisma>+<mola>" (ornek "45+15")`;

const STUDY = 'study';
const BREAK = 'break';

// Session başlamadan ÖNCE çalan uyarı bipleri: 3 bip, aralarında BEEP_GAP_SECONDS.
// Sonuncusu session başlangıcından BEEP_GAP_SECONDS önce biter.
const BEEP_COUNT = 3;
const BEEP_GAP_SECONDS = 0.6;

class PomodoroCycle {
  // type: POMODORO_TYPES anahtarı ya da serbest "<calisma>+<mola>"; startedAt: döngünün
  // başladığı an (epoch ms)
  constructor({ type, startedAt }) {
    const preset = resolvePomodoroType(type);
    if (!preset) {
      throw new PomodoroError(`bilinmeyen pomodoro türü "${type}" — ${POMODORO_TYPE_HINT}`);
    }
    if (!Number.isFinite(startedAt)) throw new PomodoroError(`geçersiz startedAt (${startedAt})`);
    this.type = String(type).trim();
    this.startedAt = startedAt;
    this.studySeconds = preset.studyMinutes * 60;
    this.breakSeconds = preset.breakMinutes * 60;
    Object.freeze(this);
  }

  get cycleSeconds() {
    return this.studySeconds + this.breakSeconds;
  }

  // Ekranın köşesinde duran sabit etiket: "POMODORO 50+10"
  get label() {
    return `POMODORO ${this.type}`;
  }

  // Döngü başlangıcından bu yana geçen saniye. Negatif olamaz: startedAt geleceğe
  // ayarlanmışsa (saat kayması) döngü henüz başlamamış sayılır, 0 döner.
  elapsedAt(nowMs) {
    return Math.max(0, (nowMs - this.startedAt) / 1000);
  }

  // Verilen ana denk gelen faz ve o fazın döngü içindeki bitişine kalan süre.
  phaseAt(nowMs) {
    const intoCycle = this.elapsedAt(nowMs) % this.cycleSeconds;
    return intoCycle < this.studySeconds
      ? { phase: STUDY, remainingSeconds: this.studySeconds - intoCycle }
      : { phase: BREAK, remainingSeconds: this.cycleSeconds - intoCycle };
  }

  // Bir ffmpeg çalıştırması için faz çizelgesi — zamanlar ÇALIŞTIRMAYA GÖRELİ (t=0 başlangıç).
  // İlk faz genelde yarıda yakalanır: start 0'a kırpılır, bitişi gerçek faz sonudur.
  // Son fazın bitişi null: çalıştırma faz ortasında biterse yazı sona kadar kalsın
  // (parça başlıklarındaki aynı kural, PlaybackTimeline.segments).
  segmentsFor({ nowMs, durationSeconds }) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new PomodoroError(`durationSeconds pozitif olmalı (${durationSeconds})`);
    }
    const intoCycle = this.elapsedAt(nowMs) % this.cycleSeconds;
    const segments = [];
    // Çalıştırma başlangıcını içeren fazın, çalıştırmaya göreli başlangıcı (≤ 0).
    let cursor = intoCycle < this.studySeconds ? -intoCycle : -(intoCycle - this.studySeconds);
    let phase = intoCycle < this.studySeconds ? STUDY : BREAK;

    while (cursor < durationSeconds) {
      const length = phase === STUDY ? this.studySeconds : this.breakSeconds;
      const end = cursor + length;
      segments.push({ phase, start: Math.max(0, cursor), end });
      cursor = end;
      phase = phase === STUDY ? BREAK : STUDY;
    }
    // Son segmentin bitişi açık bırakılır.
    segments[segments.length - 1].end = null;
    return segments;
  }

  // Session geçişlerindeki uyarı bipleri — zamanlar yine ÇALIŞTIRMAYA GÖRELİ.
  // Yalnızca bu çalıştırma içinde kalan geçişler döner; çalıştırma ortasında başlayan
  // ilk faz için bip YOKTUR (o geçiş önceki çalıştırmada olmuş ya da hiç olmamıştır).
  beepTimesFor({ nowMs, durationSeconds }) {
    const times = [];
    for (const segment of this.segmentsFor({ nowMs, durationSeconds })) {
      // start === 0 iki anlama gelebilir: faz tam burada başlıyor ya da yarıda yakalandı.
      // Yarıda yakalanan fazın bip zamanları negatif olur ve aşağıda elenir.
      for (let i = 0; i < BEEP_COUNT; i++) {
        const at = segment.start - (BEEP_COUNT - i) * BEEP_GAP_SECONDS;
        if (at >= 0 && at < durationSeconds) times.push(+at.toFixed(3));
      }
    }
    return times;
  }
}

module.exports = {
  PomodoroCycle, PomodoroError, POMODORO_TYPES, POMODORO_TYPE_HINT, resolvePomodoroType,
  STUDY, BREAK, BEEP_COUNT, BEEP_GAP_SECONDS,
};
