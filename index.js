// Giriş noktası (composition root): config'i yükler, somut bağımlılıkları kurar ve
// birbirine bağlar, Ctrl+C'de temiz kapanışı başlatır. Uygulama mantığı burada değil.
const path = require('path');
const { loadConfig } = require('./src/config/load-config');
const { parseArgs } = require('./src/config/parse-args');
const { acquireLock } = require('./src/infrastructure/instance-lock');
const { StreamProfile } = require('./src/domain/stream-profile');
const { SpeedWindow } = require('./src/domain/speed-window');
const { StreamOrchestrator } = require('./src/application/stream-orchestrator');
const { NowPlayingWriter } = require('./src/application/now-playing-writer');
const { Supervisor } = require('./src/application/supervisor');
const { StreamControlService } = require('./src/application/stream-control-service');
const { FfmpegEncoder } = require('./src/infrastructure/ffmpeg-encoder');
const { AlbumRepository, SingleAlbumRepository } = require('./src/infrastructure/album-repository');
const { writeFileAtomic } = require('./src/infrastructure/atomic-file');
const { Logger } = require('./src/infrastructure/logger');
const { StateStore } = require('./src/infrastructure/state-store');
const { StreamTui } = require('./src/ui/stream-tui');
const { LogBuffer } = require('./src/ui/log-buffer');

async function main() {
  // Çoklu yayın: her instance kendi config/env dosyasıyla çalışır (--config / --env).
  // Bayraksız çağrı varsayılanları kullanır → mevcut tek-yayın davranışı değişmez.
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ configFile: args.configFile, envFile: args.envFile });
  // --tui: aynı engine'i yöneten terminal paneli.
  const useTui = args.tui;

  // İki instance aynı runtime'ı paylaşırsa playlist/state dosyaları çakışır ve aynı
  // YouTube key'ine iki bağlantı gider. Sessiz bozulma yerine açıkça reddet.
  const lock = acquireLock({ runtimeDir: config.paths.runtime });
  // TUI modunda loglar konsolu bozmasın diye ring tampona yazılır; panel bunu gösterir.
  // Dosyaya yazma normalde olduğu gibi sürer (Logger). Headless modda out = console.
  const logBuffer = useTui ? new LogBuffer({ capacity: 500 }) : null;
  const logger = new Logger({
    dir: path.join(config.paths.runtime, 'logs'),
    ...(logBuffer ? { out: logBuffer } : {}),
  });
  const log = logger.child('main');

  const profile = new StreamProfile(config.profile);
  // Overlay kapalıysa ne drawtext ne başlık dosyaları: ikisi de null.
  const { enabled: overlayEnabled, ...overlayStyle } = config.overlay;
  const encoder = new FfmpegEncoder({
    profile,
    backgroundPath: config.paths.background,
    output: config.output,
    overlay: overlayEnabled ? overlayStyle : null,
  });
  const orchestrator = new StreamOrchestrator({
    encoder,
    log: logger.child('orchestrator'),
    // paths.albums: albüm düzeni (her playlist tek albüm, arkaplan albümle değişir); yoksa tek albüm
    albumRepository: config.paths.albums
      ? new AlbumRepository({ dir: config.paths.albums, log: logger.child('albums') })
      : new SingleAlbumRepository({
        musicDir: config.paths.music, backgroundPath: config.paths.background, log: logger.child('tracks'),
      }),
    queue: config.queue,
    playlistPath: path.join(config.paths.runtime, 'playlist.txt'),
    writeFile: writeFileAtomic,
    nowPlayingWriter: overlayEnabled
      ? new NowPlayingWriter({ dir: path.join(config.paths.runtime, 'overlay'), writeFile: writeFileAtomic })
      : null,
    speedWindow: new SpeedWindow({ fps: profile.fps }),
    // Süreç öldürülse bile (kill, elektrik) yeniden başlarken kaldığı parçadan devam.
    stateStore: new StateStore({
      file: path.join(config.paths.runtime, 'state.json'),
      writeFile: writeFileAtomic,
      log: logger.child('durum'),
    }),
  });

  // Çökmede yeniden başlatma kararı supervisor'da; crash loop'ta vazgeçerse hata koduyla çık.
  const supervisor = new Supervisor({ orchestrator, log: logger.child('supervisor') });
  supervisor.on('gave-up', () => { process.exitCode = 1; });

  // Tek kontrol katmanı: start/stop bundan sonra buradan geçer, durum/parça sorguları da.
  // Aynı (tek) supervisor/orchestrator/encoder örneklerini sarar — ikinci engine kurmaz.
  // İleride TUI ve Web UI bu aynı örneği kullanacak.
  const controlService = new StreamControlService({
    orchestrator, supervisor, encoder, log: logger.child('control'),
  });

  let tui = null;
  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) return; // ikinci Ctrl+C: kapanış zaten sürüyor, encoder'ın 5 sn sınırı geçerli
    shuttingDown = true;
    log.info(`${reason} alındı`);
    await controlService.stop(); // supervisor.stop()'a delege eder: bekleyen yeniden başlatma da iptal
    if (tui) tui.close(); // terminali eski haline getir (imleç, raw mode, stdin serbest)
    lock.release(); // runtime kilidini bırak (idempotent)
    log.info('temiz kapanış tamamlandı');
    process.exitCode = 0;
    if (process.connected) process.disconnect(); // IPC kanalı açıkken süreç kapanmaz
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  // Başka bir Node süreci tarafından (fork, IPC) yönetiliyorsa: Windows'ta alt sürece SIGINT
  // gönderilemiyor (kill doğrudan sonlandırır), temiz kapanış için 'stop' mesajı.
  process.on('message', (m) => { if (m === 'stop') shutdown('stop mesajı'); });

  // TUI: aynı controlService örneğini kullanır; Q/Ctrl+C normal shutdown lifecycle'ını tetikler.
  if (useTui) {
    tui = new StreamTui({
      controlService,
      logBuffer,
      onQuit: () => shutdown('TUI çıkış'),
    });
    await tui.open(); // Ink'i (ESM) dynamic import ile yükler ve mount eder
  }

  log.info(`çıkış: ${config.output.mode === 'local' ? config.output.localPath : 'rtmp'}`);
  try {
    await controlService.start(); // her iki modda da yayın otomatik başlar (24/7)
  } catch (err) {
    // Başlatma (ya da bu aşamadaki başka bir hata) düşerse: TUI açıksa terminali geri yükle
    // (imleç, raw mode, stdin) — yoksa hata main().catch'te konsol yerine bozuk panele yazılırdı.
    // close() idempotent; shutdown zaten çağırdıysa zararsız. Sonra hatayı yukarı ilet.
    if (tui) tui.close();
    lock.release();
    throw err;
  }
}

main().catch((err) => {
  // Logger kurulmadan (örn. config hatası) ya da başlangıçta (örn. music/ boş) düşebilir.
  console.error(`[main] başlatılamadı: ${err.message}`);
  process.exitCode = 1;
});
