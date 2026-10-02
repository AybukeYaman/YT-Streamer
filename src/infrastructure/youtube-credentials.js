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

function resolveCredentialsPath(rootDir, file) {
  return path.isAbsolute(file) ? file : path.join(rootDir, file);
}

// Ortam değişkeni dosyayı ezer; boş/boşluk değer "yok" sayılır.
function reader(credentialsPath, env) {
  const fileEnv = readFileEnv(credentialsPath);
  return (key) => {
    const value = env[key] ?? fileEnv[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };
}

// Yalnızca bildirim kanalları — ZORUNLU KEY YOK, bu yüzden asla atmaz (dosya hiç yoksa da).
//
// Neden ayrı giriş: yayın süreci (index.js) YouTube kimliğini tanımıyor ve tanımamalı
// (bkz. scripts/golive-server.js başlığı). loadYoutubeCredentials() ise CLIENT_ID/SECRET/
// REFRESH_TOKEN eksikse atıyor — onu çağırmak yayını YouTube kimliğine bağımlı hale
// getirirdi. Dosya ayrıştırması yine tek yerde (reader) kalsın diye aynı modülde duruyor.
function loadAlertChannel({ rootDir = PROJECT_ROOT, file = CREDENTIALS_FILE, env = process.env } = {}) {
  const credentialsPath = resolveCredentialsPath(rootDir, file);
  let pick;
  try {
    pick = reader(credentialsPath, env);
  } catch {
    // Dosya okunamıyorsa (izin, bozuk) bildirim kanalı yok sayılır: yayın etkilenmemeli.
    pick = () => undefined;
  }
  return { alertWebhookUrl: pick('ALERT_WEBHOOK_URL'), credentialsPath };
}

// requireRefreshToken: refresh token alma script'i onu henüz ÜRETMEDİĞİ için orada false.
// Okuma/yazma yapan komutlarda (verify-access, ileride go-live) true.
function loadYoutubeCredentials({
  rootDir = PROJECT_ROOT,
  file = CREDENTIALS_FILE,
  env = process.env,
  requireRefreshToken = true,
} = {}) {
  const credentialsPath = resolveCredentialsPath(rootDir, file);
  const pick = reader(credentialsPath, env);

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

  // go-live HTTP servisinin ayarları da aynı dosyadan gelir (ikisi de kanal seviyesi ve
  // sır niteliğinde). Burada OPSİYONEL: refresh token alma ve verify komutları bunlara
  // ihtiyaç duymuyor, sunucu kendi kontrolünü yapıyor (token yoksa başlamayı reddediyor).
  const goLivePortRaw = pick('GOLIVE_PORT');
  const goLivePort = goLivePortRaw === undefined ? undefined : Number(goLivePortRaw);
  if (goLivePort !== undefined && (!Number.isInteger(goLivePort) || goLivePort < 1 || goLivePort > 65535)) {
    throw new CredentialsError(`GOLIVE_PORT geçersiz: "${goLivePortRaw}" (1-65535 arası bir sayı olmalı)`);
  }

  return {
    clientId: pick('YOUTUBE_CLIENT_ID'),
    clientSecret: pick('YOUTUBE_CLIENT_SECRET'),
    refreshToken: pick('YOUTUBE_REFRESH_TOKEN'),
    goLiveAuthToken: pick('GOLIVE_AUTH_TOKEN'),
    goLivePort,
    // Sağlık izleme kanalları — ikisi de OPSİYONEL. Yoksa izleme yalnızca log'a yazar
    // (bugünkü davranış), hiçbir şey kırılmaz.
    alertWebhookUrl: pick('ALERT_WEBHOOK_URL'),
    heartbeatPingUrl: pick('HEARTBEAT_PING_URL'),
    credentialsPath,
  };
}

module.exports = { loadYoutubeCredentials, loadAlertChannel, CredentialsError, CREDENTIALS_FILE };
