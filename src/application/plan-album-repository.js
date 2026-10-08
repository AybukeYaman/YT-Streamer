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
// Plan yoksa, müzik seçimi boşsa ve study klibi verilmemişse iç depo ne döndürüyorsa
// O döner (referansı bile değişmez) — plansız kurulumda davranış birebir aynı.
//
// Hiçbir şey eşleşmezse (albüm silinmiş, parçalar yeniden adlandırılmış) plana rağmen
// TÜM kütüphaneye düşülür ve uyarı loglanır: yayın 7/24 akmak zorunda, eski bir seçim
// yüzünden susmaktan iyidir (aynı ilke: StreamOrchestrator'da kayıtlı durumun kurtarılması).
const { Album } = require('../domain/album');
const { pathIndex } = require('../domain/stream-plan');

class PlanAlbumRepository {
  // inner: { list(): Promise<Album[]> } — AlbumRepository ya da SingleAlbumRepository
  // planProvider: () => StreamPlan|null — aktif plan (her çağrıda okunur)
  // studyClipProvider: () => string|null — hazırlanmış study klibinin yolu (yayın
  //   formatına çevrilmiş; dönüşüm StreamConfigService'te, burada I/O yok)
  // log: { info, warn }
  constructor({ inner, planProvider, studyClipProvider = () => null, log }) {
    if (!inner) throw new Error('PlanAlbumRepository: inner depo gerekli');
    this.inner = inner;
    this.planProvider = typeof planProvider === 'function' ? planProvider : () => null;
    this.studyClipProvider = typeof studyClipProvider === 'function' ? studyClipProvider : () => null;
    this.log = log;
  }

  async list() {
    const albums = await this.inner.list();
    const plan = this.planProvider();
    const studyClip = this.studyClipProvider();
    if (!plan || (plan.usesWholeLibrary && !studyClip)) return albums;

    const selected = plan.usesWholeLibrary ? albums : this.#select(albums, plan);
    if (!selected.length) {
      this.log.warn('plandaki müzik seçimi diskte bulunamadı — tüm kütüphaneye düşülüyor');
      return studyClip ? albums.map((a) => this.#withStudyClip(a, studyClip)) : albums;
    }
    const withBackground = studyClip ? selected.map((a) => this.#withStudyClip(a, studyClip)) : selected;
    const trackCount = withBackground.reduce((n, a) => n + a.tracks.length, 0);
    this.log.info(
      `plan "${plan.name}": ${withBackground.length} albüm, ${trackCount} parça`
      + (studyClip ? ' (study arkaplanı plandan)' : ''),
    );
    return withBackground;
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

  // Study klibi: albümün arkaplan(lar)ının yerine TEK klip. Rotasyon da kendiliğinden
  // devre dışı kalır (Album.rotates tek klipte false) — "çalışma fanında şu video olsun"
  // demek, arkaplanın değişmemesi demek.
  #withStudyClip(album, clipPath) {
    return new Album({ name: album.name, backgroundPath: clipPath, tracks: [...album.tracks] });
  }
}

module.exports = { PlanAlbumRepository };
