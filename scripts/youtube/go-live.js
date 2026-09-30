// Yayını YouTube'da canlıya alır — terminalden (HTTP servisi olmadan).
//
//   node scripts/youtube/go-live.js                  # canlıya al (idempotent)
//   node scripts/youtube/go-live.js --status         # sadece durum (diskten, API'ye gitmez)
//   node scripts/youtube/go-live.js --status --refresh   # durumu API'den taze al
//   node scripts/youtube/go-live.js --config config.stream2.json --env .env.stream2
//
// Aynı GoLiveService'i HTTP servisi de kullanıyor (src/composition/go-live-wiring.js):
// iki tetikleme yolu, tek mantık.
//
// ÖN KOŞUL: ffmpeg zaten yayın yapıyor olmalı. transition, ingest 'active' değilken hata
// verir — bu komut yayını BAŞLATMAZ, canlıya ALIR.
const path = require('path');

const { Logger } = require('../../src/infrastructure/logger');
const { loadConfig } = require('../../src/config/load-config');
const { buildGoLive } = require('../../src/composition/go-live-wiring');
const { CredentialsError } = require('../../src/infrastructure/youtube-credentials');

function parseArgs(argv) {
  const args = { configFile: 'config.json', envFile: '.env', status: false, refresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.configFile = argv[++i];
    else if (a === '--env') args.envFile = argv[++i];
    else if (a === '--status') args.status = true;
    else if (a === '--refresh') args.refresh = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`bilinmeyen argüman: ${a}`);
  }
  if (!args.configFile || !args.envFile) throw new Error('--config ve --env bir dosya adı bekliyor');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Kullanım: node scripts/youtube/go-live.js [--status [--refresh]] [--config <dosya>] [--env <dosya>]');
    return;
  }

  const config = loadConfig({ configFile: args.configFile, envFile: args.envFile });
  // Konsola da bas: elle çalıştırılan bir komutun çıktısı görünür olmalı.
  const logger = new Logger({ dir: path.join(config.paths.runtime, 'logs') });
  const { service } = buildGoLive({ configFile: args.configFile, envFile: args.envFile, logger });

  if (args.status) {
    const status = await service.getStatus({ refresh: args.refresh });
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  const result = await service.goLive();
  console.log('');
  if (result.action === 'already-live') {
    console.log(`Zaten canlı: ${result.broadcastId} (${result.status}) — yeni broadcast AÇILMADI.`);
  } else {
    console.log(`CANLI: ${result.broadcastId}`);
    console.log(`  başlık : ${result.title}`);
    console.log(`  stream : ${result.streamId}`);
    console.log(`  izle   : https://www.youtube.com/watch?v=${result.broadcastId}`);
  }
}

main().catch((err) => {
  const prefix = err instanceof CredentialsError ? 'HATA' : `HATA${err.code ? ` [${err.code}]` : ''}`;
  console.error(`\n${prefix}: ${err.message}`);
  process.exitCode = 1;
});
