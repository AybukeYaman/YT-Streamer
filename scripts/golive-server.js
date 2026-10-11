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
const { spawnSync } = require('child_process');

const { Logger } = require('../src/infrastructure/logger');
const { loadConfig } = require('../src/config/load-config');
const { instanceLabel } = require('../src/config/parse-args');
const { loadYoutubeCredentials } = require('../src/infrastructure/youtube-credentials');
const { buildGoLive } = require('../src/composition/go-live-wiring');
const { buildConfigService } = require('../src/composition/config-wiring');
const { ConfigApi } = require('../src/application/config-api');
const { ensureThumbnail } = require('../src/infrastructure/video-thumbnail');
const { GoLiveServer } = require('../src/infrastructure/golive-server');
const { HealthMonitor } = require('../src/application/health-monitor');
const { IngestCheck } = require('../src/application/checks/ingest-check');
const { EncoderHeartbeatCheck } = require('../src/application/checks/encoder-heartbeat-check');
const { DiskCheck } = require('../src/application/checks/disk-check');
const { NullAlerter } = require('../src/application/alerter');
const { WebhookAlerter, createAlivePinger } = require('../src/infrastructure/webhook-alerter');
const { readMtimeMs, fileExists } = require('../src/infrastructure/file-stat');

const DEFAULT_PORT = 8787;
// /config'te "Kaydet ve Yeniden Başlat" bu unit'i hedefler. index.js'teki --plan-only
// --restart ile AYNI unit adı (bkz. plan-only-control-service.js kullanan yer) — ikisi
// de VPS'teki tek yayın birimini yeniden başlatıyor.
const STREAM_UNIT = 'yt-streamer.service';
// Park işareti ve .env yolları repo köküne göre çözülür (çalışma dizininden bağımsız,
// systemd WorkingDirectory'si değişse de doğru).
const REPO_ROOT = path.resolve(__dirname, '..');

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

  // Periyodik sağlık izleme: tetikler arasındaki körlüğü kapatır (1 Ekim olayları —
  // yayın ~2 saat ölü kaldı, kimse tetiklemediği için kimse fark etmedi).
  //   ingest  : broadcast canlı ama veri akmıyor mu?
  //   encoder : yt-streamer hâlâ yayın yapıyor mu? (state.json mtime = nabız)
  const healthLog = logger.child('saglik');
  // Çoklu yayında bildirimin hangi instance'tan geldiği anlaşılsın: config dosyası adı
  // instance'ı tanımlıyor (config.stream2.json → stream2). Yayın süreci (index.js) aynı
  // etiketi üretsin diye türetme src/config/parse-args.js'te ortak.
  const label = instanceLabel(args.configFile);
  const alerter = credentials.alertWebhookUrl
    ? new WebhookAlerter({ url: credentials.alertWebhookUrl, label, log: healthLog })
    : new NullAlerter();
  if (!credentials.alertWebhookUrl) {
    healthLog.warn('ALERT_WEBHOOK_URL boş — sorunlar yalnızca loga yazılacak, telefona bildirim GİTMEYECEK');
  }
  // Park işareti yolu: .env → .env.disabled, .env.stream2 → .env.stream2.disabled.
  // deploy.sh/add-stream.sh ile tek sözleşme (bkz. scripts/deploy/lib/instance-state.sh).
  const parkMarkerPath = path.join(REPO_ROOT, `${args.envFile}.disabled`);
  // Encoder kalp atışı kontrolü İKİ yerde kullanılıyor: periyodik izleme ve go-live'ın
  // hızlı ön kontrolü (ffmpeg basmıyorken ingest beklemek boşuna). Tek nesne, tek eşik.
  const encoderCheck = new EncoderHeartbeatCheck({
    statePath: path.join(config.paths.runtime, 'state.json'),
    readMtimeMs,
  });
  const { service } = buildGoLive({
    configFile: args.configFile, envFile: args.envFile, logger, encoderCheck, alerter,
  });

  // /config (Faz N2): yayın motorunu KURMAZ, yalnızca StreamConfigService (plan okuma/
  // yazma, klip hazırlama). restartStream systemctl sarmalıyor — index.js'teki
  // --plan-only --restart ile aynı desen (bkz. plan-only-control-service.js).
  const configService = buildConfigService({
    config,
    logger,
    controlService: {
      async restart() {
        const res = spawnSync('systemctl', ['restart', STREAM_UNIT], { encoding: 'utf8' });
        if (res.error) throw new Error(`systemctl çalıştırılamadı: ${res.error.message}`);
        if (res.status !== 0) throw new Error(`systemctl restart başarısız (kod ${res.status}): ${(res.stderr || '').trim()}`);
      },
    },
  });
  // prepareActive() BİLEREK ÇAĞRILMIYOR (11 Ekim 2026): bu süreç yayın yapmıyor, hazır klip
  // havuzunu (studyClipsProvider/breakClipsProvider) kimse bu süreçte okumuyor. Çağırınca
  // yt-streamer ile AYNI anda AYNI runtime/study-N.mp4 / break-N.mp4 dosyalarını kodluyordu:
  // iki süreç aynı dosyaya yazınca canlı ffmpeg bozuk klip okuyup duraksıyor, ayrıca küçük
  // VPS'te çift kodlama CPU'yu yiyordu. Klipleri yayın süreci kendi açılışında hazırlar;
  // /config'ten kaydedince (apply) hazırlama yine bu süreçte, ama atomik (geçici dosya+rename).
  const configApi = new ConfigApi({
    configService,
    restartStream: async () => {
      try {
        await configService.restart();
        return { ok: true, message: `${STREAM_UNIT} yeniden başlatıldı` };
      } catch (err) {
        return { ok: false, message: err.message };
      }
    },
    log: logger.child('config'),
  });
  // Kullanıcı isteği üzerine: /config sayfasında klip listesinin yanında küçük bir
  // önizleme karesi (bkz. src/infrastructure/video-thumbnail.js). Opsiyonel — ffmpeg
  // bulunamazsa ya da üretim başarısız olursa sayfa resimsiz ÇALIŞMAYA devam eder.
  const thumbnailProvider = (file) => ensureThumbnail({
    sourcePath: file, runtimeDir: config.paths.runtime, log: logger.child('thumb'),
  });
  const monitor = new HealthMonitor({
    checks: [
      new IngestCheck({ goLiveService: service }),
      encoderCheck,
      // Disk dolduğunda ffmpeg sebebi görünmeyen bir hatayla çöküyor ve yeniden
      // başlatma döngüsüne giriyor; diğer kontroller bunu göremiyor.
      new DiskCheck({ path: config.paths.runtime }),
    ],
    log: healthLog,
    alerter,
    pingAlive: createAlivePinger({ url: credentials.heartbeatPingUrl, log: healthLog }),
    // Park işareti: deploy.sh ve add-stream.sh ile AYNI dosya (.env.<isim>.disabled).
    // Bilerek kapatılmış bir yayın için alarm üretmek gürültüden başka bir şey değil.
    paused: () => fileExists(parkMarkerPath),
  });
  const server = new GoLiveServer({
    goLiveService: service,
    authToken: credentials.goLiveAuthToken ?? '',
    log,
    host: args.host ?? '127.0.0.1',
    port,
    // /status periyodik izlemenin son gördüğü durumu da gösterir: API'ye gitmeden
    // (kota harcamadan) "encoder yazıyor mu, ingest akıyor mu" sorusunun cevabı.
    healthProvider: () => monitor.snapshot(),
    configApi,
    thumbnailProvider,
  });

  await server.listen();
  log.info(`yayın başlığı: "${config.broadcast.title}" (${config.broadcast.privacyStatus})`);
  log.info('POST /go-live · GET /status · GET /healthz · GET+POST /config');

  monitor.start();


  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) {
      log.warn(`${reason} — kapanış zaten sürüyordu, zorla çıkılıyor`);
      process.exit(1);
    }
    shuttingDown = true;
    log.info(`${reason} alındı, sunucu kapatılıyor`);
    monitor.stop();
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
