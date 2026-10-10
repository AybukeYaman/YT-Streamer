// Albüm deposunu yayın planıyla SÜZEN sarmalayıcı (decorator).
//
// Mevcut AlbumRepository diskteki her şeyi döndürür; TUI'da seçilen parçalar ise bir
// alt küme ve belirli bir SIRA. Bu sarmalayıcı aradaki tek fark noktasıdır: kuyruk
// (AlbumQueue), playlist yazıcı ve orchestrator bugünküyle AYNI kalır — onlar yine
// "albüm listesi" görür, sadece liste planın söylediği liste olur.
//
// Plan HER list() çağrısında yeniden okunur (planProvider). Bunun nedeni restart akışı:
// TUI'da yeni yapılandırma yapıp "START STREAM" dendiğinde controlService.restart()
// orchestrator.start()'a, o da list()'e gidiyor — yani süreci yeniden başlatmadan yeni
// seçim devreye giriyor.
//
// Plan yoksa ya da müzik seçimi boşsa iç depo ne döndürüyorsa O döner (referansı bile
// değişmez) — plansız kurulumda davranış birebir aynı.
//
// Hiçbir şey eşleşmezse (albüm silinmiş, parçalar yeniden adlandırılmış) plana rağmen
// TÜM kütüphaneye düşülür ve uyarı loglanır: yayın 7/24 akmak zorunda, eski bir seçim
// yüzünden susmaktan iyidir (aynı ilke: StreamOrchestrator'da kayıtlı durumun kurtarılması).
//
// N3 NOTU: study klibi eskiden burada albümün arkaplanının YERİNE geçiyordu
// (#withStudyClip). Çoklu klip havuzunda bu çalışmaz — klip artık faza göre değişiyor,
// taban arkaplan sabit kalmalı. Study/break klipleri şimdi birer OVERLAY: taban katman
// hep albümün kendi arkaplanı, study/break pencerelerinde üstüne biniyor (bkz.
// pomodoro-planner.js phaseBackgrounds, ffmpeg-encoder.js). Bu depo artık yalnızca MÜZİK
// seçimini süzüyor.
const { pathIndex } = require('../domain/stream-plan');
const { Album } = require('../domain/album');

class PlanAlbumRepository {
  // inner: { list(): Promise<Album[]> } — AlbumRepository ya da SingleAlbumRepository
  // planProvider: () => StreamPlan|null — aktif plan (her çağrıda okunur)
  // log: { info, warn }
  constructor({ inner, planProvider, log }) {
    if (!inner) throw new Error('PlanAlbumRepository: inner depo gerekli');
    this.inner = inner;
    this.planProvider = typeof planProvider === 'function' ? planProvider : () => null;
    this.log = log;
  }

  async list() {
    const albums = await this.inner.list();
    const plan = this.planProvider();
    if (!plan || plan.usesWholeLibrary) return albums;

    const selected = this.#select(albums, plan);
    if (!selected.length) {
      this.log.warn('plandaki müzik seçimi diskte bulunamadı — tüm kütüphaneye düşülüyor');
      return albums;
    }
    const trackCount = selected.reduce((n, a) => n + a.tracks.length, 0);
    this.log.info(`plan "${plan.name}": ${selected.length} albüm, ${trackCount} parça`);
    return selected;
  }

  // Plandaki sıraya göre albümleri ve içlerindeki parçaları seçer.
  #select(albums, plan) {
    const byName = new Map(albums.map((a) => [a.name, a]));
    const out = [];
    for (const entry of plan.music.albums) {
      const album = byName.get(entry.name);
      if (!album) {
        this.log.warn(`plandaki albüm atlandı: "${entry.name}" artık yok`);
        continue;
      }
      // Eşleştirme pathIndex ile: plan ileri bölü, diskten okunan yol Windows'ta ters
      // bölü kullanıyor ve düz metin karşılaştırması sessizce başarısız oluyordu.
      const findTrack = pathIndex(album.tracks, (t) => t.path);
      // Sıra PLANDAN gelir: TUI'da kullanıcı ne sıraladıysa o. queue.mode 'sequential'
      // olduğunda bu sıra birebir yayına çıkar (bkz. domain/stream-plan: music.order).
      const tracks = entry.trackPaths.map((p) => findTrack(p)).filter(Boolean);
      const missing = entry.trackPaths.length - tracks.length;
      if (missing) this.log.warn(`"${entry.name}": plandaki ${missing} parça diskte yok, atlandı`);
      if (!tracks.length) {
        this.log.warn(`plandaki albüm atlandı: "${entry.name}" — seçili parçaların hiçbiri yok`);
        continue;
      }
      out.push(new Album({ name: album.name, backgrounds: album.backgrounds.map((b) => ({ ...b })), tracks }));
    }
    return out;
  }
}

module.exports = { PlanAlbumRepository };
