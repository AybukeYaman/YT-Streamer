// go-live HTTP servisinin giriş noktası (yt-golive.service bunu çalıştırır).
//
//   node scripts/golive-server.js
//   node scripts/golive-server.js --config config.stream2.json --env .env.stream2
//
// Yayın sürecinden (index.js) TAMAMEN AYRI süreç. index.js YouTube API'yi hiç tanımaz:
// broadcast oluşturma yayın başlangıcına girerse, Restart=always + supervisor retry'ları
// yüzünden her restart yeni bir broadcast yaratır (kanalda çöp yayınlar, kota tükenir).
// Ayrıntı: KARARLAR.md
//
// Varsayılan bind 127.0.0.1. Dışarıya açmak `tailscale serve` ile yapılır — bkz.
// scripts/deploy/README.md.
const path = require('path');

const { Logger } = require('../src/infrastructure/logger');
const { loadConfig } = require('../src/config/load-config');
const { loadYoutubeCredentials } = require('../src/infrastructure/youtube-credentials');
const { buildGoLive } = require('../src/composition/go-live-wiring');
const { GoLiveServer } = require('../src/infrastructure/golive-server');

const DEFAULT_PORT = 8787;

function parseArgs(argv) {
  const args = { configFile: 'config.json', envFile: '.env' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.configFile = argv[++i];
    else if (a === '--env') args.envFile = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--host') args.host = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`bilinmeyen argüman: ${a}`);
  }
  if (!args.configFile || !args.envFile) throw new Error('--config ve --env bir dosya adı bekliyor');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Kullanım: node scripts/golive-server.js [--config <dosya>] [--env <dosya>] [--port N] [--host H]');
    return;
  }

  // Config'i önce yükle: loglar instance'ın kendi runtime klasörüne gitsin (çoklu yayında
  // her instance ayrı). Kimlik/ayar dosyası (.env.youtube) kanal seviyesinde, ortak.
  const config = loadConfig({ configFile: args.configFile, envFile: args.envFile });
  const logger = new Logger({ dir: path.join(config.paths.runtime, 'logs') });
  const log = logger.child('golive-http');

  const credentials = loadYoutubeCredentials();
  // Öncelik: komut satırı > .env.youtube > varsayılan.
  const port = args.port ?? credentials.goLivePort ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port geçersiz: ${port}`);

  const { service } = buildGoLive({ configFile: args.configFile, envFile: args.envFile, logger });

  const server = new GoLiveServer({
    goLiveService: service,
    authToken: credentials.goLiveAuthToken ?? '',
    log,
    host: args.host ?? '127.0.0.1',
    port,
  });

  await server.listen();
  log.info(`yayın başlığı: "${config.broadcast.title}" (${config.broadcast.privacyStatus})`);
  log.info('POST /go-live · GET /status · GET /healthz');

  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) {
      log.warn(`${reason} — kapanış zaten sürüyordu, zorla çıkılıyor`);
      process.exit(1);
    }
    shuttingDown = true;
    log.info(`${reason} alındı, sunucu kapatılıyor`);
    await server.close();
    log.info('temiz kapanış tamamlandı');
    process.exitCode = 0;
  };
  // Yayın sürecindeki dersin aynısı: hem SIGINT hem SIGTERM temiz kapanıştan geçer.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[golive-server] başlatılamadı: ${err.message}`);
  process.exitCode = 1;
});
