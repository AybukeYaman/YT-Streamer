// SALT OKUMA doğrulama: refresh token çalışıyor mu, ve yayının kullandığı stream key
// hangi stream id'ye karşılık geliyor?
//
//   node scripts/youtube/verify-access.js
//   node scripts/youtube/verify-access.js --env .env.stream2   # başka bir instance'ın key'i
//
// Hiçbir şey oluşturmaz/değiştirmez (yalnızca liveStreams.list). Aşama 2'deki
// liveBroadcasts.bind tam olarak burada bulunan stream id'ye yapılacak.
//
// Stream'i BAŞLIKTAN tahmin etmez: cdn.ingestionInfo.streamName alanını .env'deki
// YOUTUBE_STREAM_KEY ile karşılaştırır — "Default stream key" başlığı dile/kanala göre
// değişebilir, ama key'in kendisi kesin eşleşmedir.
//
// Stream key hiçbir çıktıda GEÇMEZ (maskelenir).
const fs = require('fs');
const path = require('path');
const { parseEnv } = require('util');

const { loadYoutubeCredentials, CredentialsError } = require('../../src/infrastructure/youtube-credentials');
const { getAccessToken, listLiveStreams } = require('../../src/infrastructure/youtube-oauth');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const args = { envFile: '.env' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env') {
      args.envFile = argv[++i];
      if (!args.envFile) throw new Error('--env bir dosya adı bekliyor');
    } else if (argv[i] === '-h' || argv[i] === '--help') args.help = true;
    else throw new Error(`bilinmeyen argüman: ${argv[i]}`);
  }
  return args;
}

// Yayının stream key'i (varsa). Yoksa uyarılır ama doğrulama sürer: refresh token'ın
// çalıştığını görmek key olmadan da değerli.
function readStreamKey(envFile) {
  const file = path.isAbsolute(envFile) ? envFile : path.join(PROJECT_ROOT, envFile);
  try {
    const env = parseEnv(fs.readFileSync(file, 'utf8'));
    const key = env.YOUTUBE_STREAM_KEY;
    return typeof key === 'string' && key.trim() !== '' ? key.trim() : null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Key'i asla tam basmayız: son 4 hane eşleşmeyi gözle doğrulamaya yeter.
const maskKey = (key) => (key.length <= 4 ? '***' : `***${key.slice(-4)}`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Kullanım: node scripts/youtube/verify-access.js [--env <dosya>]');
    return;
  }

  const { clientId, clientSecret, refreshToken, credentialsPath } = loadYoutubeCredentials();
  console.log('== YouTube erişim doğrulama (salt okuma) ==');
  console.log(`kimlik kaynağı: ${credentialsPath}`);

  const { accessToken, expiresInSeconds, scope } = await getAccessToken({ clientId, clientSecret, refreshToken });
  console.log(`ok: refresh token çalışıyor (access token ${expiresInSeconds ?? '?'} sn geçerli)`);
  console.log(`scope: ${scope ?? '(yanıtta yok)'}`);

  const streamKey = readStreamKey(args.envFile);
  if (streamKey) console.log(`${args.envFile} içindeki stream key: ${maskKey(streamKey)}`);
  else console.log(`bilgi: ${args.envFile} içinde YOUTUBE_STREAM_KEY yok — eşleştirme yapılamayacak.`);

  const data = await listLiveStreams({ accessToken });
  const streams = data.items ?? [];

  console.log('');
  if (!streams.length) {
    console.log('UYARI: kanalda hiç kalıcı stream yok.');
    console.log('       YouTube Studio → Canlı Yayına Geç → Stream sekmesi bir kez açılmalı');
    console.log('       (kalıcı "Default stream key" orada oluşur).');
    return;
  }

  console.log(`kanaldaki kalıcı stream'ler (${streams.length}):`);
  let matched = null;
  for (const s of streams) {
    const ingestKey = s.cdn?.ingestionInfo?.streamName ?? '';
    const isMatch = Boolean(streamKey) && ingestKey === streamKey;
    if (isMatch) matched = s;
    console.log(`  ${isMatch ? '→' : ' '} id=${s.id}`);
    console.log(`      başlık : ${s.snippet?.title ?? '(yok)'}`);
    console.log(`      durum  : ${s.status?.streamStatus ?? '?'} / ${s.status?.healthStatus?.status ?? '?'}`);
    console.log(`      key    : ${ingestKey ? maskKey(ingestKey) : '(yok)'}${isMatch ? '  ← yayının kullandığı key' : ''}`);
  }

  console.log('');
  if (matched) {
    console.log('== SONUÇ ==');
    console.log(`Yayının stream key'i şu stream id'ye ait: ${matched.id}`);
    console.log('Aşama 2\'de liveBroadcasts.bind bu id\'ye yapılacak (kalıcı key korunur,');
    console.log('her yayın için yeni stream AÇILMAZ — restart dayanıklılığı buna dayanıyor).');
  } else if (streamKey) {
    console.log('UYARI: .env\'deki stream key kanaldaki hiçbir stream ile eşleşmedi.');
    console.log('       Olası sebep: key başka bir kanala ait, ya da OAuth izni farklı bir');
    console.log('       Google hesabıyla verildi. Aşama 2 bu haliyle yanlış kanala yayın açar.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  const where = err instanceof CredentialsError ? '' : ` (${path.basename(__filename)})`;
  console.error(`\nHATA${where}: ${err.message}`);
  process.exitCode = 1;
});
