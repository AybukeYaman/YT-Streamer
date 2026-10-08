// TUI ile mevcut yayın sistemi arasındaki TEK köprü.
//
// Görevi dar: aktif planı tutmak, sihirbazın listeleyeceği kataloğu vermek, bir planı
// uygulamak (klipleri hazırla → diske yaz → istenirse yayını yeniden başlat) ve
// preset'leri yönetmek. Yayın motoru YOK: başlatma/durdurma StreamControlService'e,
// albüm okuma AlbumRepository'ye, klip dönüşümü ve dosya tarama infrastructure'a,
// kalıcılık StreamPlanStore'a gider.
//
// Planı okuyan motor tarafları (PlanAlbumRepository, ReconfigurablePomodoroPlanner)
// buradaki *Provider kapaklarına bakar — plan TEK yerde durur ve yeniden başlatmada
// hepsi aynı anda yeni planı görür.
//
// KLİPLER NİÇİN BURADA HAZIRLANIYOR: study/break görüntüsü yayın formatına çevrilmek
// zorunda (1280x720/24/SAR 1:1) ve dönüşüm ffmpeg çağrısı, yani ASENKRON.
// Orchestrator'ın plan() yolu senkron; oraya asenkron iş sokmak yayın akışını
// bekletirdi. Bu yüzden dönüşüm "START STREAM" anında (ya da açılışta) bir kez yapılır,
// sonucu önbelleğe alınır, motor yalnızca hazır dosyanın yolunu görür.
//
// Katman kuralı (test/application/stream-orchestrator.test.js): burada fs/child_process
// ya da infrastructure import'u YOK. Dosya tarayan ve ffmpeg çağıran bağımlılıklar
// (mediaLibrary, prepareClip) composition root'tan enjekte edilir.
const { StreamPlan, summarizePlan } = require('../domain/stream-plan');

// Hazırlanan kliplerin runtime'daki adları. İsim break-clip.js'in sözleşmesi;
// burada yalnızca hangi klibin hangi ada yazılacağı seçiliyor.
const STUDY_CLIP = 'study-background';
const BREAK_CLIP = 'break-background';

class StreamConfigService {
  // planStore: { loadActive, saveActive, listPresets, savePreset, deletePreset }
  // albumRepository: SÜZÜLMEMİŞ depo — sihirbaz tüm kütüphaneyi listeler
  // controlService: { restart() }
  // config: yüklenmiş config (paths.runtime, broadcast.thumbnailPath okunur)
  // mediaLibrary: { covers(), videos(), inspect(input, kind) } — dosya tarama
  //   (infrastructure). Verilmezse kapak/video listeleri boş döner: sihirbaz yine
  //   çalışır, kullanıcı yolu elle girer.
  // prepareClip: ({ sourcePath, runtimeDir, name, log }) => Promise<string|null>
  //   Verilmezse klip dönüşümü hiç denenmez (klip gerektirmeyen kullanım ve testler).
  // fallbackPlan: plan dosyası YOKKEN geçerli olan plan. index.js bunu config.json'dan
  //   üretir — böylece "plan" sistemin TEK okuma biçimi olur ve TUI'yi hiç kullanmayan
  //   kurulum da aynı yoldan geçer, ikinci bir kod yolu doğmaz.
  constructor({
    planStore, albumRepository, controlService, config, log,
    mediaLibrary = null, prepareClip = null, fallbackPlan = null,
  }) {
    this.planStore = planStore;
    this.albumRepository = albumRepository;
    this.controlService = controlService;
    this.config = config;
    this.log = log;
    this.mediaLibrary = mediaLibrary;
    this.prepareClip = prepareClip;
    this.fallbackPlan = fallbackPlan ? StreamPlan.from(fallbackPlan) : null;

    // Aktif plan kurulumda okunur (senkron): motor tarafı ilk start()'ta hazır bulmalı.
    this.plan = this.planStore.loadActive() || this.fallbackPlan;
    // Hazırlanmış klipler: { source, clip }. Kaynak değişmediyse yeniden dönüştürülmez.
    this.studyClip = null;
    this.breakClip = null;
    this.albumsCache = null;
  }

  // ── Motorun baktığı kapaklar ─────────────────────────────────

  planProvider() {
    return this.plan || null;
  }

  studyClipProvider() {
    return this.studyClip ? this.studyClip.clip : null;
  }

  breakClipProvider() {
    return this.breakClip ? this.breakClip.clip : null;
  }

  // Sihirbazın düzenlemeye başlayacağı plan: aktif plan ya da boş plan (tüm kütüphane,
  // pomodoro kapalı). null DÖNMEZ — sihirbaz her zaman bir taslakla başlamalı.
  currentPlan() {
    return this.plan || new StreamPlan({});
  }

  // Açılışta bir kez: aktif planın kliplerini hazırlar. Plan okuma kurulumda yapıldı;
  // burada yalnızca asenkron olan kısım (ffmpeg dönüşümü) var.
  async prepareActive() {
    if (!this.plan) {
      this.log.info('aktif yayın planı yok — tüm kütüphane ve config.json ayarları geçerli');
      return null;
    }
    await this.#prepareClips(this.plan);
    this.log.info(
      `aktif yayın planı: "${this.plan.name}" — `
      + `${this.plan.usesWholeLibrary ? 'tüm kütüphane' : `${this.plan.selectedTrackCount} parça`}, `
      + `pomodoro ${this.plan.pomodoro.enabled ? this.plan.pomodoro.type : 'kapalı'}`,
    );
    return this.plan;
  }

  // ── Katalog (sihirbazın listeleri) ───────────────────────────

  // [{ name, backgrounds: [yol], tracks: [{ path, title, durationSeconds }], totalSeconds }]
  // Süreler AlbumRepository'nin disk önbelleğinden gelir — burada ikinci bir ffprobe yok.
  async listAlbums({ reload = false } = {}) {
    if (reload || !this.albumsCache) {
      const albums = await this.albumRepository.list();
      this.albumsCache = albums.map((album) => ({
        name: album.name,
        backgrounds: album.backgrounds.map((b) => b.path),
        tracks: album.tracks.map((t) => ({
          path: t.path, title: t.title, durationSeconds: t.durationSeconds,
        })),
        totalSeconds: album.tracks.reduce((n, t) => n + t.durationSeconds, 0),
      }));
    }
    return this.albumsCache;
  }

  // Study/break görüntüsü olarak kullanılabilecek klipler: albümlerin arkaplanları
  // (tekrarsız, albüm sırasında) + varsa assets/ altındaki videolar. Kullanıcının
  // zaten yayın formatında olan dosyaları ilk sırada görmesi kasıtlı.
  async listClips() {
    const out = [];
    const seen = new Set();
    for (const album of await this.listAlbums()) {
      for (const bg of album.backgrounds) {
        if (!seen.has(bg)) { seen.add(bg); out.push(bg); }
      }
    }
    for (const video of this.mediaLibrary ? this.mediaLibrary.videos() : []) {
      if (!seen.has(video.path)) { seen.add(video.path); out.push(video.path); }
    }
    return out;
  }

  // Kapak adayları (mutlak yollar). Tarama infrastructure'da (MediaLibrary).
  listCovers() {
    return this.mediaLibrary ? this.mediaLibrary.covers().map((c) => c.path) : [];
  }

  // Kullanıcının elle girdiği yol geçerli mi? { ok, file } | { ok: false, reason }
  inspectPath(input, kind = 'any') {
    if (!this.mediaLibrary) return { ok: false, reason: 'dosya tarayıcı kurulmadı' };
    return this.mediaLibrary.inspect(input, kind);
  }

  // ── Özet ─────────────────────────────────────────────────────

  /**
   * Planın özeti. Parça sayısı/süre KATALOGDAN hesaplanır: plan yalnızca yol tutuyor,
   * süre bilgisi albüm deposunda.
   *
   * Hesabın kendisi domain'de (summarizePlan) ve SAF: sihirbazın özet ekranı aynı işlevi
   * kendi önbelleğindeki katalogla çağırıyor. İkisi ayrı ayrı hesaplasa ekranda yazan
   * süre ile loga düşen süre bir gün birbirinden ayrılırdı.
   */
  async summarize(plan) {
    return summarizePlan(plan, await this.listAlbums(), {
      defaultCover: this.config.broadcast.thumbnailPath,
    });
  }

  // ── Uygulama ─────────────────────────────────────────────────

  /**
   * Planı uygular: klipleri hazırlar ve diske yazar. Yayına DOKUNMAZ — yalnızca
   * kaydetmek isteyen çağıran (ya da henüz başlamamış yayın) için.
   * @returns {Promise<{ plan: StreamPlan, warnings: string[] }>}
   */
  async apply(plan, { onProgress = () => {} } = {}) {
    const p = StreamPlan.from(plan);
    const warnings = [];

    onProgress('görüntüler hazırlanıyor…');
    const prepared = await this.#prepareClips(p);
    if (p.pomodoro.enabled && p.pomodoro.studyVideo && !prepared.study) {
      warnings.push('çalışma görüntüsü hazırlanamadı — albümün kendi arkaplanı kullanılacak');
    }
    if (p.pomodoro.enabled && p.pomodoro.breakVideo && !prepared.break) {
      warnings.push('mola görüntüsü hazırlanamadı — molada normal arkaplan kalacak');
    }

    onProgress('plan kaydediliyor…');
    this.plan = StreamPlan.from(this.planStore.saveActive(p));
    return { plan: this.plan, warnings };
  }

  /**
   * Planı uygular ve yayını yeniden başlatır — sihirbazdaki "START STREAM".
   * restart = stop + start; start albüm listesini YENİDEN okur ve PlanAlbumRepository
   * o anda aktif planı görür, yani süreci yeniden başlatmak gerekmez. Yayın durmuşsa
   * stop etkisizdir ve restart basitçe başlatır.
   */
  async applyAndRestart(plan, { onProgress = () => {} } = {}) {
    const result = await this.apply(plan, { onProgress });
    onProgress('yayın yeniden başlatılıyor…');
    await this.controlService.restart();
    return { ...result, restarted: true };
  }

  // Planı DEĞİŞTİRMEDEN yeniden başlatma — "restart with current configuration".
  async restart() {
    await this.controlService.restart();
    return { plan: this.plan, restarted: true };
  }

  // ── Preset'ler ───────────────────────────────────────────────

  listPresets() {
    return this.planStore.listPresets();
  }

  savePreset(plan) {
    return this.planStore.savePreset(StreamPlan.from(plan));
  }

  // Preset'i yüklemek aktif planı DEĞİŞTİRMEZ: sihirbaz onu taslak olarak alıp
  // düzenlemeye başlar, yayına ancak "START STREAM" ile çıkar.
  loadPreset(slug) {
    const found = this.listPresets().find((p) => p.slug === slug);
    return found ? found.plan : null;
  }

  deletePreset(slug) {
    return this.planStore.deletePreset(slug);
  }

  // ── Dahili ───────────────────────────────────────────────────

  // Pomodoro kapalıysa klipler hiç hazırlanmaz: study/break görüntüsü yalnızca Pomodoro
  // fazlarında anlamlı, kapalıyken boşa ffmpeg çalıştırmanın (ve açılışı geciktirmenin)
  // sebebi yok.
  async #prepareClips(plan) {
    if (!plan.pomodoro.enabled || !this.prepareClip) {
      this.studyClip = null;
      this.breakClip = null;
      return { study: null, break: null };
    }
    const study = await this.#ensure('studyClip', STUDY_CLIP, plan.pomodoro.studyVideo);
    const brk = await this.#ensure('breakClip', BREAK_CLIP, plan.pomodoro.breakVideo);
    return { study, break: brk };
  }

  // Dönüşüm hatası yayını DURDURMAZ: klip null kalır, arkaplan normal akışına döner.
  // (Aynı ilke break-clip.js'te: görsel hazırlanamazsa yayın sürer.)
  async #ensure(field, name, source) {
    if (!source) {
      this[field] = null;
      return null;
    }
    const cached = this[field];
    if (cached && cached.source === source) return cached.clip;
    let clip = null;
    try {
      clip = await this.prepareClip({
        sourcePath: source, runtimeDir: this.config.paths.runtime, name, log: this.log,
      });
    } catch (err) {
      this.log.warn(`${name} hazırlanamadı: ${err.message}`);
    }
    this[field] = clip ? { source, clip } : null;
    return clip;
  }
}

module.exports = { StreamConfigService, STUDY_CLIP, BREAK_CLIP };
