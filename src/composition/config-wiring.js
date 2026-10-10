// StreamConfigService'i kuran ortak yer (composition root): hem index.js (--plan-only)
// hem scripts/golive-server.js (/config route'u) aynı kurulumu kullanır — iki yerde
// kopyalanırsa zamanla ayrışır (go-live-wiring.js ile aynı gerekçe).
//
// v1 SADELEŞTİRMESİ (bkz. PLAN-yapilandirma-ui.md Faz N2): go-live sürecinde ALBÜM
// taraması YAPILMAZ. StreamConfigService#listClips() albüm arkaplanlarını da listeliyor
// ve bu AlbumRepository.list() → ffprobe zinciri demek. go-live süreci için bunun iki
// sakıncası var:
//   1. her /config açılışında kütüphaneyi tarar (yavaş — 498 parçada ~2 dk),
//   2. runtime/durations.json ÖNBELLEĞİNE İKİ SÜREÇ (yayın + go-live) yazar.
// Bu yüzden albümRepository burada boş bir sahte depo (`list` → []): klip adayları
// yalnızca MediaLibrary.videos() (ffprobe GEREKTİRMEZ, yalnızca dosya tarar).
const path = require('path');
const { StreamConfigService } = require('../application/stream-config-service');
const { StreamPlanStore } = require('../infrastructure/stream-plan-store');
const { MediaLibrary } = require('../infrastructure/media-library');
const { ensureStreamClip } = require('../infrastructure/break-clip');
const { writeFileAtomic } = require('../infrastructure/atomic-file');

// controlService: { restart() } — yayın sürecine YOK, çağıran (go-live sunucusu)
//   systemctl restart saran bir nesne geçer; index.js'teki PlanOnlyControlService ile
//   aynı sözleşme (bkz. src/application/plan-only-control-service.js).
function buildConfigService({
  config, logger, controlService = { async restart() {} },
}) {
  const planStore = new StreamPlanStore({
    runtimeDir: config.paths.runtime, writeFile: writeFileAtomic, log: logger.child('plan'),
  });
  return new StreamConfigService({
    planStore,
    albumRepository: { list: async () => [] }, // bkz. dosya başlığındaki "v1 sadeleştirmesi"
    controlService,
    config,
    log: logger.child('plan'),
    mediaLibrary: new MediaLibrary({
      albumsDir: config.paths.albums ?? null,
      assetsDir: path.join(__dirname, '..', '..', 'assets'),
      rootDir: path.join(__dirname, '..', '..'),
    }),
    prepareClip: ensureStreamClip,
    fallbackPlan: {
      name: 'config.json',
      music: { order: config.queue.mode, albums: [] },
      pomodoro: {
        enabled: config.pomodoro.enabled && config.overlay.enabled,
        type: config.pomodoro.type,
        breakVideo: config.pomodoro.breakBackground,
      },
    },
  });
}

module.exports = { buildConfigService };
