// Giriş noktası (composition root): config'i yükler, somut bağımlılıkları kurar ve
// birbirine bağlar, Ctrl+C'de temiz kapanışı başlatır. Uygulama mantığı burada değil.
const path = require('path');
const { loadConfig } = require('./src/config/load-config');
const { StreamProfile } = require('./src/domain/stream-profile');
const { SpeedWindow } = require('./src/domain/speed-window');
const { StreamOrchestrator } = require('./src/application/stream-orchestrator');
const { NowPlayingWriter } = require('./src/application/now-playing-writer');
const { Supervisor } = require('./src/application/supervisor');
const { FfmpegEncoder } = require('./src/infrastructure/ffmpeg-encoder');
const { TrackRepository } = require('./src/infrastructure/track-repository');
const { writeFileAtomic } = require('./src/infrastructure/atomic-file');
const { Logger } = require('./src/infrastructure/logger');

async function main() {
  const config = loadConfig();
  const logger = new Logger({ dir: path.join(config.paths.runtime, 'logs') });
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
    trackRepository: new TrackRepository({ dir: config.paths.music, log: logger.child('tracks') }),
    queue: config.queue,
    playlistPath: path.join(config.paths.runtime, 'playlist.txt'),
    writeFile: writeFileAtomic,
    nowPlayingWriter: overlayEnabled
      ? new NowPlayingWriter({ dir: path.join(config.paths.runtime, 'overlay'), writeFile: writeFileAtomic })
      : null,
    speedWindow: new SpeedWindow({ fps: profile.fps }),
  });

  // Çökmede yeniden başlatma kararı supervisor'da; crash loop'ta vazgeçerse hata koduyla çık.
  const supervisor = new Supervisor({ orchestrator, log: logger.child('supervisor') });
  supervisor.on('gave-up', () => { process.exitCode = 1; });

  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) return; // ikinci Ctrl+C: kapanış zaten sürüyor, encoder'ın 5 sn sınırı geçerli
    shuttingDown = true;
    log.info(`${reason} alındı`);
    await supervisor.stop(); // geri çekilme beklerken de: bekleyen yeniden başlatma iptal
    log.info('temiz kapanış tamamlandı');
    process.exitCode = 0;
    if (process.connected) process.disconnect(); // IPC kanalı açıkken süreç kapanmaz
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  // docker stop / compose down SIGTERM gönderir; yakalanmazsa node ffmpeg'i kapatmadan ölür.
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Başka bir Node süreci tarafından (fork, IPC) yönetiliyorsa: Windows'ta alt sürece SIGINT
  // gönderilemiyor (kill doğrudan sonlandırır), temiz kapanış için 'stop' mesajı.
  process.on('message', (m) => { if (m === 'stop') shutdown('stop mesajı'); });

  log.info(`çıkış: ${config.output.mode === 'local' ? config.output.localPath : 'rtmp'}`);
  await supervisor.start();
}

main().catch((err) => {
  // Logger kurulmadan (örn. config hatası) ya da başlangıçta (örn. music/ boş) düşebilir.
  console.error(`[main] başlatılamadı: ${err.message}`);
  process.exitCode = 1;
});
