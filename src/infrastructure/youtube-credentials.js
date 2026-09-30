// YouTube Data API kimlik bilgilerini .env.youtube'dan okur.
//
// Neden AYRI dosya (.env / .env.<isim> değil): OAuth kimliği KANAL seviyesinde, yayın
// instance'ı seviyesinde değil. Üç yayın varsa üç kopya client secret tutmak anlamsız.
// Ayrıca scripts/deploy/check-env.sh, .env.example'ı sözleşme kabul edip oradaki HER
// key'i zorunlu sayıyor: bu üç key'i .env.example'a koymak, VPS'te dosyalar doldurulana
// kadar deploy'u durdururdu ve her .env.<isim> instance'ını "eksik env" diye atlardı
// (add-stream.sh yeni instance'lara yalnızca YOUTUBE_STREAM_KEY yazıyor). Ayrıntı: KARARLAR.md
//
// Ortam değişkeni dosyayı EZER: systemd/CI'da dosya olmadan da çalışabilsin.
const fs = require('fs');
const path = require('path');
const { parseEnv } = require('util');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CREDENTIALS_FILE = '.env.youtube';
const REQUIRED = ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'];

class CredentialsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CredentialsError';
  }
}

function readFileEnv(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new CredentialsError(`${path.basename(file)} okunamadı: ${err.code || err.message}`);
  }
}

// requireRefreshToken: refresh token alma script'i onu henüz ÜRETMEDİĞİ için orada false.
// Okuma/yazma yapan komutlarda (verify-access, ileride go-live) true.
function loadYoutubeCredentials({
  rootDir = PROJECT_ROOT,
  file = CREDENTIALS_FILE,
  env = process.env,
  requireRefreshToken = true,
} = {}) {
  const credentialsPath = path.isAbsolute(file) ? file : path.join(rootDir, file);
  const fileEnv = readFileEnv(credentialsPath);
  const pick = (key) => {
    const value = env[key] ?? fileEnv[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  const keys = requireRefreshToken ? [...REQUIRED, 'YOUTUBE_REFRESH_TOKEN'] : REQUIRED;
  const missing = keys.filter((k) => pick(k) === undefined);
  if (missing.length) {
    throw new CredentialsError(
      `Eksik YouTube kimlik bilgisi: ${missing.join(', ')}\n` +
      `      Kaynak: ${credentialsPath} (ya da ortam değişkeni)\n` +
      '      Oluştur:  cp .env.youtube.example .env.youtube  &&  chmod 600 .env.youtube\n' +
      (missing.includes('YOUTUBE_REFRESH_TOKEN')
        ? '      Refresh token almak için:  node scripts/youtube/get-refresh-token.js\n'
        : ''),
    );
  }

  return {
    clientId: pick('YOUTUBE_CLIENT_ID'),
    clientSecret: pick('YOUTUBE_CLIENT_SECRET'),
    refreshToken: pick('YOUTUBE_REFRESH_TOKEN'),
    credentialsPath,
  };
}

module.exports = { loadYoutubeCredentials, CredentialsError, CREDENTIALS_FILE };
