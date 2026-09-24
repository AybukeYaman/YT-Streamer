// Giriş noktası (composition root): config'i yükler, somut bağımlılıkları kurar ve
// birbirine bağlar, Ctrl+C'de temiz kapanışı başlatır. Uygulama mantığı burada değil.
const path = require('path');
const { loadConfig } = require('./src/config/load-config');
const { StreamProfile } = require('./src/domain/stream-profile');
const { StreamOrchestrator } = require('./src/application/stream-orchestrator');
const { FfmpegEncoder } = require('./src/infrastructure/ffmpeg-encoder');
const { TrackRepository } = require('./src/infrastructure/track-repository');
const { writeFileAtomic } = require('./src/infrastructure/atomic-file');
const { Logger } = require('./src/infrastructure/logger');

async function main() {
  const config = loadConfig();
  const logger = new Logger({ dir: path.join(config.paths.runtime, 'logs') });
  const log = logger.child('main');

  const encoder = new FfmpegEncoder({
    profile: new StreamProfile(config.profile),
    backgroundPath: config.paths.background,
    output: config.output,
  });
  const orchestrator = new StreamOrchestrator({
    encoder,
    log: logger.child('orchestrator'),
    trackRepository: new TrackRepository({ dir: config.paths.music, log: logger.child('tracks') }),
    queue: config.queue,
    playlistPath: path.join(config.paths.runtime, 'playlist.txt'),
    writeFile: writeFileAtomic,
  });

  // Kapanış istenmeden durduysa (çökme) hata koduyla çık.
  orchestrator.on('exit', ({ expected, code }) => {
    if (!expected) process.exitCode = code === 0 ? 0 : 1;
  });

  let shuttingDown = false;
  process.on('SIGINT', async () => {
    if (shuttingDown) return; // ikinci Ctrl+C: kapanış zaten sürüyor, encoder'ın 5 sn sınırı geçerli
    shuttingDown = true;
    log.info('SIGINT alındı');
    await orchestrator.stop();
    log.info('temiz kapanış tamamlandı');
    process.exitCode = 0;
  });

  log.info(`çıkış: ${config.output.mode === 'local' ? config.output.localPath : 'rtmp'}`);
  await orchestrator.start();
}

main().catch((err) => {
  // Logger kurulmadan (örn. config hatası) ya da başlangıçta (örn. music/ boş) düşebilir.
  console.error(`[main] başlatılamadı: ${err.message}`);
  process.exitCode = 1;
});
