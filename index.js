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
const { ReconfigurablePomodoroPlanner, plannerFactory } = require('./src/application/reconfigurable-pomodoro-planner');
const { PlanAlbumRepository } = require('./src/application/plan-album-repository');
const { StreamConfigService } = require('./src/application/stream-config-service');
const { StreamPlanStore } = require('./src/infrastructure/stream-plan-store');
const { MediaLibrary } = require('./src/infrastructure/media-library');
const { ensureStreamClip } = require('./src/infrastructure/break-clip');
const { PomodoroOverlayWriter } = require('./src/application/pomodoro-overlay-writer');
const { PomodoroStore } = require('./src/infrastructure/pomodoro-store');
const { DurationCache } = require('./src/infrastructure/duration-cache');
const { ffprobeDuration } = require('./src/infrastructure/track-repository');
const { Supervisor } = require('./src/application/supervisor');
const { StreamControlService } = require('./src/application/stream-control-service');
const { PlanOnlyControlService } = require('./src/application/plan-only-control-service');
const { NullAlerter } = require('./src/application/alerter');
const { SpeedAlarm } = require('./src/application/speed-alarm');
const { DecoderErrorWatch } = require('./src/application/decoder-error-watch');
const { FfmpegEncoder } = require('./src/infrastructure/ffmpeg-encoder');
const { WebhookAlerter } = require('./src/infrastructure/webhook-alerter');
const { loadAlertChannel } = require('./src/infrastructure/youtube-credentials');
const { AlbumRepository, SingleAlbumRepository } = require('./src/infrastructure/album-repository');
const { writeFileAtomic } = require('./src/infrastructure/atomic-file');
const { Logger } = require('./src/infrastructure/logger');
const { StateStore } = require('./src/infrastructure/state-store');
const { StreamTui } = require('./src/ui/stream-tui');
const { LogBuffer } = require('./src/ui/log-buffer');
const { spawnSync } = require('child_process');

// --plan-only (--restart ile): plan kaydedilince devreye almak için.
// Unit adı sabit — ileride --service bayrağıyla değiştirilebilir, bugün gerek yok.
const STREAM_UNIT = 'yt-streamer.service';

// Temiz kapanıştan sonra sürecin kendi kendine kapanması için tanınan süre. systemd'nin
// TimeoutStopSec=30'unun belirgin altında: kesme kararı bizde kalsın, sebebi loglanabilsin.
const SHUTDOWN_WATCHDOG_MS = 5000;

async function main() {
  // Çoklu yayın: her instance kendi config/env dosyasıyla çalışır (--config / --env).
  // Bayraksız çağrı varsayılanları kullanır → mevcut tek-yayın davranışı değişmez.
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ configFile: args.configFile, envFile: args.envFile });

  // --plan-only: sihirbazı yayın motoru kurmadan açar (VPS'te yayın ÇALIŞIRKEN SSH'tan
  // plan düzenlemek için — bkz. PLAN-yapilandirma-ui.md Faz N1). Kilit ALINMAZ: bu süreç
  // ffmpeg başlatmaz, playlist/state/pomodoro dosyalarına dokunmaz, yalnızca
  // stream-plan.json ve hazırlanan klipleri yazar. Klip dosyalarını çalışan ffmpeg açık
  // tutuyor olabilir ama Linux'ta rename yeni bir inode oluşturur — çalışan süreç eski
  // içeriği görmeye devam eder, yeni içerik bir sonraki başlatmada devreye girer. Bu
  // zararsız ve zaten istenen davranış (plan ayrı, motor ayrı süreç).
  if (args.planOnly) return runPlanOnly(args, config);

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

  // ── Yayın planı (TUI'nın yapılandırdığı içerik) ──────────────────────────────
  //
  // Plan TEK kaynaktır: hangi parçalar, hangi sırayla, Pomodoro açık mı, study/break
  // görüntüsü ne. Aşağıdaki sağlayıcılar (planProvider/clip) her yayın başlangıcında
  // OKUNUR — böylece TUI'da "restart with new configuration" demek, süreci yeniden
  // başlatmadan yeni planın devreye girmesi demek.
  //
  // Plan dosyası yoksa config.json'dan türetilen plan geçerli olur (fallbackPlan):
  // TUI'yi hiç kullanmayan kurulumda davranış birebir bugünküyle aynı kalır.
  const planStore = new StreamPlanStore({
    runtimeDir: config.paths.runtime, writeFile: writeFileAtomic, log: logger.child('plan'),
  });
  const baseAlbumRepository = config.paths.albums
    // paths.albums: albüm düzeni (her playlist tek albüm, arkaplan albümle değişir); yoksa tek albüm
    ? new AlbumRepository({ dir: config.paths.albums, log: logger.child('albums'), probeDuration })
    : new SingleAlbumRepository({
      musicDir: config.paths.music, backgroundPath: config.paths.background, log: logger.child('tracks'), probeDuration,
    });

  // configService aşağıda (controlService'ten sonra) kurulur; motor tarafı ona bu
  // kapaklardan bakar. Erken okuma null döner ve plansız davranış geçerli olur.
  let configService = null;
  const planProvider = () => (configService ? configService.planProvider() : null);
  const studyClipsProvider = () => (configService ? configService.studyClipsProvider() : []);
  const breakClipsProvider = () => (configService ? configService.breakClipsProvider() : []);

  const orchestrator = new StreamOrchestrator({
    encoder,
    log: logger.child('orchestrator'),
    // Depo plan süzgecinden geçer: seçili parçalar ve plandaki sıra. Study/break klipleri
    // artık (N3) arkaplanın YERİNE geçmiyor, overlay olarak ReconfigurablePomodoroPlanner
    // üzerinden encoder'a gidiyor — bu depo yalnızca MÜZİK seçimini süzer.
    // Plan boşsa iç deponun döndürdüğü liste aynen geçer.
    albumRepository: new PlanAlbumRepository({
      inner: baseAlbumRepository, planProvider, log: logger.child('plan'),
    }),
    // mode planın alanı (TUI'da seçilen sıralama); batchSize makine ayarı olarak kalır.
    // Getter: her start() güncel değeri okur, yeniden başlatmada eski mod'a saplanmaz.
    queue: { get mode() { return planProvider()?.music.order ?? config.queue.mode; }, batchSize: config.queue.batchSize },
    playlistPath: path.join(config.paths.runtime, 'playlist.txt'),
    writeFile: writeFileAtomic,
    nowPlayingWriter: overlayEnabled
      ? new NowPlayingWriter({ dir: path.join(config.paths.runtime, 'overlay'), writeFile: writeFileAtomic })
      : null,
    // Pomodoro: açık/kapalı kararı ARTIK PLANDA. Overlay kapalıyken hiç kurulmaz
    // (eskiden olduğu gibi): STUDY/BREAK yazısı drawtext'e, drawtext de
    // overlay.fontFile'a bağlı. Plan "kapalı" diyorsa sarmalayıcı null döndürür ve
    // orchestrator encoder'a bugünküyle AYNI argümanları geçer.
    pomodoroPlanner: overlayEnabled
      ? new ReconfigurablePomodoroPlanner({
        planProvider,
        studyClipsProvider,
        breakClipsProvider,
        log: logger.child('pomodoro'),
        createPlanner: plannerFactory({
          overlayWriter: new PomodoroOverlayWriter({
            dir: path.join(config.paths.runtime, 'overlay'),
            writeFile: writeFileAtomic,
            fontSize: config.pomodoro.fontSize,
            statusPosition: config.pomodoro.statusPosition,
          }),
          store: new PomodoroStore({
            file: path.join(config.paths.runtime, 'pomodoro.json'),
            writeFile: writeFileAtomic,
            log: logger.child('pomodoro'),
          }),
          log: logger.child('pomodoro'),
        }),
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
    // Bozuk klip/giriş: her bozuk paket ayrı WARN olup logu boğmasın, sürerse bildirim gitsin.
    decoderWatch: new DecoderErrorWatch({ alerter, log: logger.child('decoder') }),
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

  // Yapılandırma katmanı: TUI'nın tek muhatabı. Yayın motoru kurmaz — planı tutar,
  // kütüphaneyi listeler, klipleri hazırlar ve restart'ı controlService'e delege eder.
  configService = new StreamConfigService({
    planStore,
    albumRepository: baseAlbumRepository, // TUI süzülmemiş kütüphaneyi listeler
    controlService,
    config,
    log: logger.child('plan'),
    // Dosya tarama ve klip dönüşümü infrastructure'da; application katmanı ikisini de
    // import etmiyor (mimari kuralı), bağlama burada yapılır.
    mediaLibrary: new MediaLibrary({
      albumsDir: config.paths.albums ?? null,
      assetsDir: path.join(__dirname, 'assets'),
      rootDir: __dirname,
    }),
    prepareClip: ensureStreamClip,
    // Plan dosyası yoksa geçerli olan plan: config.json'daki pomodoro ayarları ve kuyruk
    // modu. Overlay kapalıysa pomodoro da kapalı sayılır (drawtext'e bağlı).
    fallbackPlan: {
      name: 'config.json',
      music: { order: config.queue.mode, albums: [] },
      pomodoro: {
        enabled: config.pomodoro.enabled && overlayEnabled,
        type: config.pomodoro.type,
        breakVideo: config.pomodoro.breakBackground,
      },
    },
  });
  // Aktif planın study/break kliplerini hazırla. Yayın başlamadan ÖNCE olmalı: klip
  // hazır değilken ilk döngüde görüntü eksik kalırdı.
  await configService.prepareActive();

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
    // Süre önbelleği gecikmeli yazılıyor (son eklemeden 1 sn sonra) ve zamanlayıcısı
    // unref'li: kapanış o pencereye denk gelirse ölçümler diske HİÇ yazılmıyordu ve
    // sonraki açılış boşuna yeniden ffprobe'luyordu. Kapanışta bekleyeni boşalt.
    durationCache.flush();
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
      // [C] yayın yapılandırma sihirbazını açar; aynı controlService ile restart eder.
      configService,
      logBuffer,
      onQuit: () => shutdown('TUI çıkış'),
    });
    await tui.open(); // Ink'i (ESM) dynamic import ile yükler ve mount eder
    // --configure: yayın OTOMATİK BAŞLAMAZ, önce sihirbaz açılır. Yayını sihirbazdaki
    // "START STREAM" başlatır (configService.apply → controlService.restart; yayın
    // durmuşken restart = sadece start). İptal edilirse pano durmuş halde kalır ve
    // [S] ile elle başlatılabilir.
    if (args.configure) await tui.openWizard();
  }

  log.info(`çıkış: ${config.output.mode === 'local' ? config.output.localPath : 'rtmp'}`);
  try {
    // 24/7 varsayılanı: yayın kendiliğinden başlar. Tek istisna --configure — orada
    // başlatma kararı kullanıcının elinde.
    //
    // Başlatma düşerse burada HATA GELMEZ: supervisor onu çökme sayıp geri çekilmeli
    // yeniden denemeye alır ve süreç ayakta kalır. Eskiden hata buraya geliyordu, süreç
    // 1 ile düşüyordu ve tek kurtarıcı systemd'nin Restart=always'iydi — systemd'siz
    // çalıştırmada (yerel, --tui) yayın hiç dönmüyordu.
    if (!args.configure) await controlService.start();
    // Açılış taraması bitti: önbelleğin işe yarayıp yaramadığı logda görünsün.
    // Sağlıklı tabloda isabet = kütüphane boyutu, ölçüm = yalnızca yeni/değişen dosyalar.
    logger.child('süre').info(durationCache.summary());
  } catch (err) {
    // Başlatma (ya da bu aşamadaki başka bir hata) düşerse: TUI açıksa terminali geri yükle
    // (imleç, raw mode, stdin) — yoksa hata main().catch'te konsol yerine bozuk panele yazılırdı.
    // close() idempotent; shutdown zaten çağırdıysa zararsız. Sonra hatayı yukarı ilet.
    if (tui) tui.close();
    lock.release();
    throw err;
  }
}

// --plan-only: yayın motoru YOK (ffmpeg, orchestrator, supervisor, StateStore,
// WebhookAlerter, SpeedAlarm, pomodoro planlayıcı/overlay kurulmaz) — sihirbaz yalnızca
// plan kaydetmek için. Kilit alınmaz (bkz. main() içindeki gerekçe).
async function runPlanOnly(args, config) {
  const logBuffer = new LogBuffer({ capacity: 500 });
  const logger = new Logger({ dir: path.join(config.paths.runtime, 'logs'), out: logBuffer });
  const log = logger.child('plan-only');

  const durationCache = new DurationCache({
    file: path.join(config.paths.runtime, 'durations.json'),
    writeFile: writeFileAtomic,
    log: logger.child('süre'),
  });
  const probeDuration = durationCache.wrap((f) => ffprobeDuration(f));

  const albumRepository = config.paths.albums
    ? new AlbumRepository({ dir: config.paths.albums, log: logger.child('albums'), probeDuration })
    : new SingleAlbumRepository({
      musicDir: config.paths.music, backgroundPath: config.paths.background, log: logger.child('tracks'), probeDuration,
    });
  const planStore = new StreamPlanStore({
    runtimeDir: config.paths.runtime, writeFile: writeFileAtomic, log: logger.child('plan'),
  });

  // --restart: plan kaydedilince systemctl ile devreye al. systemctl yoksa/başarısızsa
  // sonuç PlanOnlyControlService üzerinden sihirbazın uyarı satırına düşer — hata atılmaz.
  const runRestart = args.restartService
    ? async () => {
      const res = spawnSync('systemctl', ['restart', STREAM_UNIT], { encoding: 'utf8' });
      if (res.error) return { ok: false, message: `systemctl çalıştırılamadı: ${res.error.message}` };
      if (res.status !== 0) {
        return { ok: false, message: `systemctl restart başarısız (kod ${res.status}): ${(res.stderr || '').trim()}` };
      }
      return { ok: true, message: `${STREAM_UNIT} yeniden başlatıldı` };
    }
    : null;

  const configService = new StreamConfigService({
    planStore,
    albumRepository,
    controlService: new PlanOnlyControlService({ runRestart, log: logger.child('control') }),
    config,
    log: logger.child('plan'),
    mediaLibrary: new MediaLibrary({
      albumsDir: config.paths.albums ?? null,
      assetsDir: path.join(__dirname, 'assets'),
      rootDir: __dirname,
    }),
    prepareClip: ensureStreamClip,
    fallbackPlan: {
      name: 'config.json',
      music: { order: config.queue.mode, albums: [] },
      pomodoro: {
        // Overlay kapalıysa pomodoro da kapalı sayılır (drawtext'e bağlı) — main()
        // yolundaki aynı kural (bkz. yukarıdaki fallbackPlan).
        enabled: config.pomodoro.enabled && config.overlay.enabled,
        type: config.pomodoro.type,
        breakVideo: config.pomodoro.breakBackground,
      },
    },
  });
  await configService.prepareActive();

  const tui = new StreamTui({
    controlService: configService.controlService,
    configService,
    logBuffer,
    onQuit: () => {
      tui.close();
      durationCache.flush();
      process.exitCode = 0;
    },
  });
  await tui.open();
  await tui.openWizard(); // --plan-only her zaman doğrudan sihirbazla açılır (pano gösterecek yayın yok)
}

main().catch((err) => {
  // Logger kurulmadan (örn. config hatası) ya da başlangıçta (örn. music/ boş) düşebilir.
  console.error(`[main] başlatılamadı: ${err.message}`);
  process.exitCode = 1;
});
