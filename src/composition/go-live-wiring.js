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
const { writeFileAtomic } = require('../infrastructure/atomic-file');
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

  const service = new GoLiveService({
    api,
    stateStore,
    log: logger.child('go-live'),
    broadcastConfig: config.broadcast,
    // local modda stream key yok; o durumda streamId config'ten gelmeli.
    streamKey: config.output.mode === 'rtmp' ? config.output.streamKey : null,
    encoderCheck,
    alerter,
  });

  return { service, config, credentials };
}

module.exports = { buildGoLive };
