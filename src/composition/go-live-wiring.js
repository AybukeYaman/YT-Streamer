// go-live bağımlılıklarını kuran ortak yer (composition root): hem HTTP servisi
// (scripts/golive-server.js) hem CLI (scripts/youtube/go-live.js) aynı kurulumu kullanır —
// iki yerde kopyalanırsa zamanla ayrışır (check-env.sh ile aynı gerekçe).
//
// Neden src/application ALTINDA DEĞİL: application katmanı infrastructure import etmez
// (mimari testi bunu zorluyor). Somut bağımlılıkları bağlamak index.js gibi bir
// composition root'un işi.
const path = require('path');

const { loadConfig } = require('../config/load-config');
const { loadYoutubeCredentials } = require('../infrastructure/youtube-credentials');
const { getAccessToken } = require('../infrastructure/youtube-oauth');
const broadcasts = require('../infrastructure/youtube-broadcasts');
const { BroadcastStateStore } = require('../infrastructure/broadcast-state-store');
const { PendingVodStore } = require('../infrastructure/pending-vod-store');
const { writeFileAtomic } = require('../infrastructure/atomic-file');
const { StreamPlanStore } = require('../infrastructure/stream-plan-store');
const { GoLiveService } = require('../application/go-live-service');

// Yayın süreci değil: kilit (instance-lock) ALINMAZ. Aksi halde go-live, çalışan
// yayının runtime kilidine çarpar ve hiç başlamaz.
// encoderCheck / alerter: OPSİYONEL (HTTP sunucusu verir, CLI vermez). encoderCheck
// requestGoLive'ın hızlı ön kontrolünde "ffmpeg basıyor mu" sorusunu yanıtlar; alerter
// arka planda biten işin sonucunu bildirir. İkisi de HealthMonitor'daki AYNI nesneler —
// iki ayrı bildirim politikası / iki ayrı eşik oluşmasın.
function buildGoLive({
  configFile = 'config.json', envFile = '.env', logger, env = process.env,
  encoderCheck = null, alerter = null,
}) {
  const config = loadConfig({ configFile, envFile, env });
  const credentials = loadYoutubeCredentials({ env });

  const api = {
    getAccessToken: () => getAccessToken({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      refreshToken: credentials.refreshToken,
    }),
    ...broadcasts,
  };

  const stateStore = new BroadcastStateStore({
    file: path.join(config.paths.runtime, 'broadcast.json'),
    writeFile: writeFileAtomic,
    log: logger.child('broadcast-durum'),
  });

  // Bitmiş yayınların VOD gizliliği için bekleyen iş kuyruğu. broadcast.json'dan AYRI
  // dosya: o dosya yayın bitince siliniyor (bkz. pending-vod-store.js).
  const pendingVods = new PendingVodStore({
    file: path.join(config.paths.runtime, 'vod-pending.json'),
    writeFile: writeFileAtomic,
    log: logger.child('vod-gizlilik'),
  });

  // Kapak (küçük resim) TUI'da seçiliyor ve yayın planında duruyor. go-live AYRI bir
  // süreç; planı açılışta bir kez okumak, TUI'da kapak değiştirildikten sonra açılan
  // broadcast'e eski resmi koymak olurdu. Bu yüzden getter: plan dosyası broadcast
  // oluşturulduğu anda okunur (nadir bir işlem, maliyeti küçük bir JSON okuması).
  // Plan yoksa ya da kapak seçilmemişse config.json'daki değer geçerli — mevcut davranış.
  const planStore = new StreamPlanStore({
    runtimeDir: config.paths.runtime, writeFile: writeFileAtomic, log: logger.child('plan'),
  });
  // Başlık/açıklama da aynı gerekçeyle getter: /config'ten değiştirilince bir sonraki
  // YENİ broadcast yeni metni alır (açık olan broadcast'e dokunulmaz — insert anında okunur).
  const broadcastConfig = {
    ...config.broadcast,
    get title() {
      return planStore.loadActive()?.broadcast?.title || config.broadcast.title;
    },
    get description() {
      const fromPlan = planStore.loadActive()?.broadcast?.description;
      return fromPlan ?? config.broadcast.description;
    },
    get thumbnailPath() {
      const cover = planStore.loadActive()?.cover;
      if (!cover) return config.broadcast.thumbnailPath;
      return path.isAbsolute(cover) ? cover : path.resolve(__dirname, '..', '..', cover);
    },
  };

  const service = new GoLiveService({
    api,
    stateStore,
    pendingVods,
    log: logger.child('go-live'),
    broadcastConfig,
    // local modda stream key yok; o durumda streamId config'ten gelmeli.
    streamKey: config.output.mode === 'rtmp' ? config.output.streamKey : null,
    encoderCheck,
    alerter,
  });

  // api: /config'teki yayın seçici (BroadcastAdmin) de aynı YouTube istemcisini kullanır —
  // ikinci bir OAuth/istek katmanı kurulmasın.
  return { service, config, credentials, api };
}

module.exports = { buildGoLive };
