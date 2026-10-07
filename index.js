// Giriş noktası (composition root): config'i yükler, somut bağımlılıkları kurar ve
// birbirine bağlar, Ctrl+C'de temiz kapanışı başlatır. Uygulama mantığı burada değil.
const path = require('path');
const { loadConfig } = require('./src/config/load-config');
const { parseArgs, instanceLabel } = require('./src/config/parse-args');
const { acquireLock } = require('./src/infrastructure/instance-lock');
const { StreamProfile } = require('./src/domain/stream-profile');
const { SpeedWindow } = require('./src/domain/speed-window');
const { StreamOrchestrator } = require('./src/application/stream-orchestrator');
const { NowPlayingWriter } = require('./src/application/now-playing-writer');
const { BackgroundPlaylistWriter } = require('./src/application/background-playlist-writer');
const { PomodoroPlanner } = require('./src/application/pomodoro-planner');
const { PomodoroOverlayWriter } = require('./src/application/pomodoro-overlay-writer');
const { PomodoroStore } = require('./src/infrastructure/pomodoro-store');
const { DurationCache } = require('./src/infrastructure/duration-cache');
const { ffprobeDuration } = require('./src/infrastructure/track-repository');
const { Supervisor } = require('./src/application/supervisor');
const { StreamControlService } = require('./src/application/stream-control-service');
const { NullAlerter } = require('./src/application/alerter');
const { SpeedAlarm } = require('./src/application/speed-alarm');
const { FfmpegEncoder } = require('./src/infrastructure/ffmpeg-encoder');
const { WebhookAlerter } = require('./src/infrastructure/webhook-alerter');
const { loadAlertChannel } = require('./src/infrastructure/youtube-credentials');
const { AlbumRepository, SingleAlbumRepository } = require('./src/infrastructure/album-repository');
const { writeFileAtomic } = require('./src/infrastructure/atomic-file');
const { Logger } = require('./src/infrastructure/logger');
const { StateStore } = require('./src/infrastructure/state-store');
const { StreamTui } = require('./src/ui/stream-tui');
const { LogBuffer } = require('./src/ui/log-buffer');

// Temiz kapanıştan sonra sürecin kendi kendine kapanması için tanınan süre. systemd'nin
// TimeoutStopSec=30'unun belirgin altında: kesme kararı bizde kalsın, sebebi loglanabilsin.
const SHUTDOWN_WATCHDOG_MS = 5000;

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

  // Bildirim kanalı: tekrarlayan çökme (supervisor) ve yavaş encode (speedAlarm) buradan
  // haber veriyor. Kanal yoksa NullAlerter: her şey yalnızca log'a gider (eski davranış).
  // URL go-live servisiyle AYNI yerden (.env.youtube) okunur ama YouTube kimliği İSTENMEZ —
  // yayın süreci OAuth'a bağımlı olmamalı (bkz. scripts/golive-server.js başlığı).
  const alertLog = logger.child('bildirim');
  const { alertWebhookUrl } = loadAlertChannel();
  const alerter = alertWebhookUrl
    ? new WebhookAlerter({ url: alertWebhookUrl, label: instanceLabel(args.configFile), log: alertLog })
    : new NullAlerter();
  if (!alertWebhookUrl) {
    alertLog.warn('ALERT_WEBHOOK_URL boş — sorunlar yalnızca loga yazılacak, telefona bildirim GİTMEYECEK');
  }

  // Parça/klip süreleri disk önbelleğinden okunur: her açılışta tüm kütüphaneyi
  // yeniden ffprobe'lamak 498 parçada 2 dk sürüyordu ve bu süre boyunca yayın akmıyor.
  const durationCache = new DurationCache({
    file: path.join(config.paths.runtime, 'durations.json'),
    writeFile: writeFileAtomic,
    log: logger.child('süre'),
  });
  const probeDuration = durationCache.wrap((f) => ffprobeDuration(f));

  const orchestrator = new StreamOrchestrator({
    encoder,
    log: logger.child('orchestrator'),
    // paths.albums: albüm düzeni (her playlist tek albüm, arkaplan albümle değişir); yoksa tek albüm
    albumRepository: config.paths.albums
      ? new AlbumRepository({ dir: config.paths.albums, log: logger.child('albums'), probeDuration })
      : new SingleAlbumRepository({
        musicDir: config.paths.music, backgroundPath: config.paths.background, log: logger.child('tracks'), probeDuration,
      }),
    queue: config.queue,
    playlistPath: path.join(config.paths.runtime, 'playlist.txt'),
    writeFile: writeFileAtomic,
    nowPlayingWriter: overlayEnabled
      ? new NowPlayingWriter({ dir: path.join(config.paths.runtime, 'overlay'), writeFile: writeFileAtomic })
      : null,
    // Pomodoro: kapalıysa (varsayılan) planner hiç kurulmaz ve orchestrator encoder'a
    // bugünküyle aynı argümanları geçer. Overlay kapalıyken de kurulmaz: STUDY/BREAK
    // yazısı drawtext'e, drawtext de overlay.fontFile'a bağlı.
    pomodoroPlanner: (config.pomodoro.enabled && overlayEnabled)
      ? new PomodoroPlanner({
        type: config.pomodoro.type,
        overlayWriter: new PomodoroOverlayWriter({
          dir: path.join(config.paths.runtime, 'overlay'),
          writeFile: writeFileAtomic,
          fontSize: config.pomodoro.fontSize,
          statusPosition: config.pomodoro.statusPosition,
          labelPosition: config.pomodoro.labelPosition,
        }),
        store: new PomodoroStore({
          file: path.join(config.paths.runtime, 'pomodoro.json'),
          writeFile: writeFileAtomic,
          log: logger.child('pomodoro'),
        }),
        log: logger.child('pomodoro'),
      })
      : null,
    // Arkaplan rotasyonu: albümde backgrounds/ varsa klipler sırayla döner. Tek
    // arkaplanlı albümlerde writer null döndürür, hiçbir şey değişmez.
    backgroundPlaylistWriter: new BackgroundPlaylistWriter({
      playlistPath: path.join(config.paths.runtime, 'backgrounds.txt'),
      writeFile: writeFileAtomic,
      rotationSeconds: config.background.rotationMinutes * 60,
    }),
    speedWindow: new SpeedWindow({ fps: profile.fps }),
    // Hız eşiğinin dışına çıkıp orada KALMAK bildirim üretir. Diğer kontroller bu durumu
    // göremiyor: ffmpeg ilerleme basmaya devam ettiği için kalp atışı ve ingest sağlıklı.
    speedAlarm: new SpeedAlarm({ alerter, log: logger.child('hız') }),
    // Süreç öldürülse bile (kill, elektrik) yeniden başlarken kaldığı parçadan devam.
    stateStore: new StateStore({
      file: path.join(config.paths.runtime, 'state.json'),
      writeFile: writeFileAtomic,
      log: logger.child('durum'),
    }),
  });

  // Çökmede yeniden başlatma kararı supervisor'da. Vazgeçme YOK: eşik aşılınca alarm verir
  // ama yeniden başlatmayı sürdürür (bkz. supervisor.js başlığı, KARARLAR.md 2 Ekim 2026).
  const supervisor = new Supervisor({ orchestrator, log: logger.child('supervisor'), alerter });

  // Tek kontrol katmanı: start/stop bundan sonra buradan geçer, durum/parça sorguları da.
  // Aynı (tek) supervisor/orchestrator/encoder örneklerini sarar — ikinci engine kurmaz.
  // İleride TUI ve Web UI bu aynı örneği kullanacak.
  const controlService = new StreamControlService({
    orchestrator, supervisor, encoder, log: logger.child('control'),
  });

  let tui = null;
  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) {
      // İkinci sinyal artık yok sayılmıyor: takılı bir kapanışta tek çıkış yolu buydu ve
      // etkisiz olduğu için systemd'nin TimeoutStopSec'i doluyordu (30 Eylül 2026).
      log.warn(`${reason} — kapanış zaten sürüyordu, zorla çıkılıyor`);
      if (tui) tui.close();
      process.exit(1);
    }
    shuttingDown = true;
    log.info(`${reason} alındı`);
    await controlService.stop(); // supervisor.stop()'a delege eder: bekleyen yeniden başlatma da iptal
    if (tui) tui.close(); // terminali eski haline getir (imleç, raw mode, stdin serbest)
    lock.release(); // runtime kilidini bırak (idempotent)
    log.info('temiz kapanış tamamlandı');
    process.exitCode = 0;
    if (process.connected) process.disconnect(); // IPC kanalı açıkken süreç kapanmaz
    // Kapanış tamamlandıktan sonra süreç normalde event loop boşalınca kendi kendine
    // kapanır. Boşalmazsa (açık bir handle, bitmeyen bir ffprobe zinciri) eskiden süreç
    // sessizce ayakta kalıyor ve systemd 30 sn sonra SIGKILL ediyordu. Artık kapanışı
    // kendimiz sonlandırıyoruz ve NEDENİNİ logluyoruz — teşhis için kritik.
    const watchdog = setTimeout(() => {
      const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : '?';
      const requests = typeof process._getActiveRequests === 'function' ? process._getActiveRequests().length : '?';
      log.warn(`kapanış sonrası süreç ${SHUTDOWN_WATCHDOG_MS} ms boyunca kapanmadı ` +
        `(açık handle=${handles}, istek=${requests}) — zorla çıkılıyor`);
      process.exit(0);
    }, SHUTDOWN_WATCHDOG_MS);
    watchdog.unref(); // tek başına süreci ayakta TUTMAZ: boş loop'ta normal kapanış kazanır
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  // SIGTERM de aynı temiz kapanıştan geçer. Unit'ler KillSignal=SIGINT kullanıyor,
  // ama elle `kill <pid>` ya da ileride KillSignal'i olmayan bir unit SIGTERM
  // gönderir; handler yoksa Node anında ölür ve ffmpeg yetim kalır (PPID=1).
  process.on('SIGTERM', () => shutdown('SIGTERM'));
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
