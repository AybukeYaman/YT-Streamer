// Yayın planı: TUI'da yapılan seçimlerin TEK kaynağı (kapak, müzik seçimi/sırası,
// Pomodoro, study/break görüntüsü). Saf veri nesnesi — I/O yok, Node modülü import etmez.
//
// NEDEN AYRI BİR NESNE ve config.json'a yazılmıyor: config.json MAKİNEYE özel teknik
// yapılandırma (font yolu, runtime klasörü, profil, çıkış, kimlik). Plan ise YAYININ
// İÇERİĞİ ve her yayında/restart'ta değişiyor. İkisi aynı dosyada olsa, TUI'nın her
// "START STREAM"ı makine ayarlarını yeniden yazmak zorunda kalırdı.
//
// Plan config'i EZMEZ, ÜZERİNE BİNER: her alan mevcut sistemdeki bir alanın
// karşılığıdır ve ikinci bir yerde tutulmaz. Eşlemenin yapıldığı yerler:
//   cover               → broadcast.thumbnailPath   go-live-wiring.js (getter)
//   music.albums        → albüm listesinin süzgeci   PlanAlbumRepository
//   music.order         → queue.mode                 index.js (queue.mode getter)
//   pomodoro.enabled    → planner kurulur/kurulmaz   ReconfigurablePomodoroPlanner
//   pomodoro.type       → PomodoroCycle              ReconfigurablePomodoroPlanner
//   pomodoro.breakVideo → encoder breakBackground    StreamConfigService (klip hazırlar)
//   pomodoro.studyVideo → albümün arkaplanı yerine   PlanAlbumRepository + StreamConfigService
//
// Hepsi YAYIN BAŞLARKEN okunur (getter / her list() çağrısı): böylece süreci yeniden
// başlatmadan "restart with new configuration" mümkün olur.
//
// BOŞ ALAN = "MEVCUT DAVRANIŞ". music.albums boşsa tüm kütüphane çalar, studyVideo
// null'sa albümün kendi arkaplan(lar)ı kullanılır, cover null'sa config'deki kalır.
// Böylece plan dosyası olmayan bir kurulum (VPS'te çalışan yayın) hiç etkilenmez.

// NOT: domain dosyaları birbirini bile import ETMEZ (mimari kuralı, bkz.
// test/domain/stream-profile.test.js). Bu yüzden tür doğrulaması burada pomodoro.js'ten
// çağrılmıyor, AYNI GÖSTERİM kuralıyla sınanıyor: tür her zaman "<calisma>+<mola>"
// biçiminde bir metin ve hazır türler ('50+10', '30+10') bu gösterimin birer örneği —
// yani kural tek, iki ayrı tür listesi yok. Süreleri dakikaya çeviren tek yer
// domain/pomodoro.js'teki resolvePomodoroType; plan yalnızca biçimi doğrular.
const TYPE_NOTATION = /^(\d{1,3})\+(\d{1,3})$/;

function validType(type) {
  if (typeof type !== 'string') return false;
  const m = TYPE_NOTATION.exec(type.trim());
  return Boolean(m) && Number(m[1]) > 0 && Number(m[2]) > 0;
}

// Plandaki parça yolunu diskteki yolla eşleştirmek için anahtar.
//
// NEDEN GEREKLİ: plan JSON'da duruyor ve yolları ileri bölüyle yazmak doğal (elle
// düzenleme, başka makineden kopyalama, JSON kaçışından kurtulma). Diskten okunan
// yollar ise path.join çıktısı — Windows'ta TERS bölü. Düz metin karşılaştırması bu
// yüzden sessizce başarısız oluyor ve seçim yok sayılıp tüm kütüphane çalıyordu
// (8 Ekim 2026 duman testinde yakalandı).
//
// İki aşama: önce bölü ayracı normalleştirilmiş TAM eşleşme, sonra küçük harfe
// indirilmiş eşleşme. Harf duyarsız karşılaştırmayı yedek tutmak kasıtlı: Linux'ta
// yalnızca büyük/küçük harfle ayrılan iki dosya birbirine karışmasın.
function pathKey(filePath) {
  return String(filePath).split('\\').join('/');
}

function pathKeyLoose(filePath) {
  return pathKey(filePath).toLowerCase();
}

// Yol → öğe sözlüğü; lookup(yol) iki aşamalı eşleşmeyi uygular.
function pathIndex(items, getPath) {
  const exact = new Map();
  const loose = new Map();
  for (const item of items) {
    const file = getPath(item);
    exact.set(pathKey(file), item);
    loose.set(pathKeyLoose(file), item);
  }
  return (file) => exact.get(pathKey(file)) ?? loose.get(pathKeyLoose(file));
}

const ORDER_MODES = ['sequential', 'shuffle'];
const DEFAULT_ROUNDS = 4;
const DEFAULT_TYPE = '50+10';

class StreamPlanError extends Error {
  constructor(problems) {
    super(`Geçersiz yayın planı:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'StreamPlanError';
    this.problems = problems;
  }
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

// Seçimi tek biçime indirger: [{ name, trackPaths: [...] }]. Parçası kalmayan albüm düşer
// (TUI'da tüm işaretler kaldırılmış olabilir); sıra TUI'daki sıradır.
function normalizeAlbums(raw, problems) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push('"music.albums" dizi olmalı');
    return [];
  }
  const out = [];
  const seen = new Set();
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      problems.push(`"music.albums[${i}]" nesne olmalı`);
      return;
    }
    if (!isNonEmptyString(entry.name)) {
      problems.push(`"music.albums[${i}].name" eksik`);
      return;
    }
    if (!Array.isArray(entry.trackPaths)) {
      problems.push(`"music.albums[${i}].trackPaths" dizi olmalı`);
      return;
    }
    if (entry.trackPaths.some((p) => !isNonEmptyString(p))) {
      problems.push(`"music.albums[${i}].trackPaths" içinde geçersiz yol var`);
      return;
    }
    if (seen.has(entry.name.trim())) {
      problems.push(`"music.albums" içinde "${entry.name}" iki kez var`);
      return;
    }
    seen.add(entry.name.trim());
    // Aynı parçanın iki kez seçilmesi kuyruk mantığını bozar (Queue tekil liste bekler).
    const trackPaths = [...new Set(entry.trackPaths.map((p) => p.trim()))];
    if (trackPaths.length) {
      out.push(Object.freeze({ name: entry.name.trim(), trackPaths: Object.freeze(trackPaths) }));
    }
  });
  return out;
}

function normalizePomodoro(raw, problems) {
  const p = raw === undefined || raw === null ? {} : raw;
  if (typeof p !== 'object') {
    problems.push('"pomodoro" bölümü nesne olmalı');
    return {
      enabled: false, type: DEFAULT_TYPE, rounds: DEFAULT_ROUNDS, studyVideo: null, breakVideo: null,
    };
  }
  if (p.enabled !== undefined && typeof p.enabled !== 'boolean') {
    problems.push('"pomodoro.enabled" true ya da false olmalı');
  }
  const type = p.type === undefined || p.type === null ? DEFAULT_TYPE : p.type;
  if (!validType(type)) {
    problems.push(`"pomodoro.type" "${type}" — "<calisma>+<mola>" biçiminde olmalı (ornek "50+10")`);
  }
  // rounds: null "sınırsız" demek (7/24 yayının doğal hali, bkz. aşağıdaki not).
  const rounds = p.rounds === undefined ? DEFAULT_ROUNDS : p.rounds;
  if (rounds !== null && !isPositiveInt(rounds)) {
    problems.push('"pomodoro.rounds" pozitif tam sayı ya da null olmalı');
  }
  for (const key of ['studyVideo', 'breakVideo']) {
    if (p[key] !== undefined && p[key] !== null && !isNonEmptyString(p[key])) {
      problems.push(`"pomodoro.${key}" dosya yolu (metin) ya da null olmalı`);
    }
  }
  return {
    enabled: p.enabled === true,
    type: typeof type === 'string' ? type.trim() : type,
    rounds,
    studyVideo: isNonEmptyString(p.studyVideo) ? p.studyVideo.trim() : null,
    breakVideo: isNonEmptyString(p.breakVideo) ? p.breakVideo.trim() : null,
  };
}

class StreamPlan {
  // Normal yol StreamPlan.from(raw) — tüm sorunları tek hatada listeler (load-config'in
  // davranışı: sessizce varsayılana düşmek yok).
  constructor(raw = {}) {
    if (raw === null || typeof raw !== 'object') throw new StreamPlanError(['plan nesne olmalı']);
    const problems = [];

    const name = raw.name === undefined || raw.name === null ? 'adsız' : raw.name;
    if (!isNonEmptyString(name)) problems.push('"name" boş olamaz');

    if (raw.cover !== undefined && raw.cover !== null && !isNonEmptyString(raw.cover)) {
      problems.push('"cover" dosya yolu (metin) ya da null olmalı');
    }

    const rawMusic = raw.music === undefined || raw.music === null ? {} : raw.music;
    if (typeof rawMusic !== 'object') problems.push('"music" bölümü nesne olmalı');
    const order = rawMusic.order === undefined ? 'sequential' : rawMusic.order;
    if (!ORDER_MODES.includes(order)) {
      problems.push(`"music.order" "${order}" — ${ORDER_MODES.map((m) => `"${m}"`).join(' ya da ')} olmalı`);
    }
    const albums = normalizeAlbums(rawMusic.albums, problems);
    const pomodoro = normalizePomodoro(raw.pomodoro, problems);

    if (problems.length) throw new StreamPlanError(problems);

    this.name = String(name).trim();
    this.cover = isNonEmptyString(raw.cover) ? raw.cover.trim() : null;
    this.music = Object.freeze({ order, albums: Object.freeze(albums) });
    this.pomodoro = Object.freeze(pomodoro);
    // Serbest bilgi alanı (kaydedilme zamanı, preset adı). Yayın akışı okumaz.
    this.metadata = Object.freeze({ ...(raw.metadata || {}) });
    Object.freeze(this);
  }

  static from(raw) {
    return raw instanceof StreamPlan ? raw : new StreamPlan(raw);
  }

  // Hiç seçim yapılmamış plan: müzik süzgeci yok → tüm kütüphane (mevcut davranış).
  get usesWholeLibrary() {
    return this.music.albums.length === 0;
  }

  get selectedTrackCount() {
    return this.music.albums.reduce((n, a) => n + a.trackPaths.length, 0);
  }

  // Pomodoro döngüsünün kimliği. Değişirse PomodoroStore'daki başlangıç geçersizleşir ve
  // döngü baştan başlar (yarım kalmış 50 dakikanın 30'luk düzende karşılığı yok).
  get pomodoroSignature() {
    return this.pomodoro.enabled ? this.pomodoro.type : 'off';
  }

  // Plan donmuş: değişiklik yeni bir plan üretir (TUI'nın "Edit" adımı bunu kullanır).
  with(patch = {}) {
    return new StreamPlan({ ...this.toJSON(), ...patch });
  }

  toJSON() {
    return {
      name: this.name,
      cover: this.cover,
      music: {
        order: this.music.order,
        albums: this.music.albums.map((a) => ({ name: a.name, trackPaths: [...a.trackPaths] })),
      },
      pomodoro: { ...this.pomodoro },
      metadata: { ...this.metadata },
    };
  }
}

// Planın özeti: yayına GERÇEKTEN çıkacak parça sayısı ve toplam süre.
//
// Neden burada (saf işlev): aynı hesabı iki yerin yapması gerekiyor — StreamConfigService
// (log ve dış tüketiciler için) ve sihirbazın özet ekranı. İkisi ayrı ayrı hesaplasa
// ekranda yazan süre ile loga düşen süre bir gün birbirinden ayrılırdı.
//
// albums: [{ name, tracks: [{ path, durationSeconds }], totalSeconds }] — katalog.
// Seçim yoksa TÜM kütüphane sayılır: yayına çıkacak olan o. Katalogda bulunamayan parça
// sayılmaz, çünkü depo da onu atlıyor (bkz. PlanAlbumRepository).
function summarizePlan(plan, albums = [], { defaultCover = null } = {}) {
  const p = StreamPlan.from(plan);
  let trackCount = 0;
  let totalSeconds = 0;
  if (p.usesWholeLibrary) {
    for (const album of albums) {
      trackCount += album.tracks.length;
      totalSeconds += album.totalSeconds ?? album.tracks.reduce((n, t) => n + t.durationSeconds, 0);
    }
  } else {
    const findTrack = pathIndex(albums.flatMap((a) => a.tracks), (t) => t.path);
    for (const entry of p.music.albums) {
      for (const trackPath of entry.trackPaths) {
        const track = findTrack(trackPath);
        if (!track) continue;
        trackCount += 1;
        totalSeconds += track.durationSeconds;
      }
    }
  }
  return {
    name: p.name,
    cover: p.cover ?? defaultCover ?? null,
    usesWholeLibrary: p.usesWholeLibrary,
    order: p.music.order,
    albums: p.music.albums.map((a) => ({ name: a.name, trackPaths: [...a.trackPaths] })),
    trackCount,
    totalSeconds,
    pomodoro: { ...p.pomodoro },
  };
}

module.exports = {
  StreamPlan, StreamPlanError, ORDER_MODES, DEFAULT_ROUNDS, DEFAULT_TYPE,
  pathKey, pathKeyLoose, pathIndex, summarizePlan,
};
