// BİR KERELİK: YouTube Data API için refresh token alır.
//
//   node scripts/youtube/get-refresh-token.js
//   node scripts/youtube/get-refresh-token.js --manual   # dinleyici açmadan, elle kod yapıştırma
//   node scripts/youtube/get-refresh-token.js --port 9123
//
// NEREDE ÇALIŞTIRILIR: tarayıcısı olan makinede (Windows/Mac), VPS'te DEĞİL. Refresh token
// makineye bağlı değil; VPS'e taşınacak tek şey o token. Böylece "VPS'te tarayıcı yok"
// problemi ortadan kalkar ve authorization code hiç taşınmaz.
//
// AKIŞ: loopback redirect (http://127.0.0.1:<port>) + PKCE. OOB akışı
// (urn:ietf:wg:oauth:2.0:oob) Ekim 2022'den beri engelli, invalid_request döner.
//
// TELEFONDAN izin vermek: consent URL'i telefonda aç. İzin sonrası Safari
// http://127.0.0.1:<port>/?code=... adresine gider ve "bağlanılamadı" der — ama KOD ADRES
// ÇUBUĞUNDA DURUR. O URL'i (ya da sadece code değerini) buraya yapıştır. --manual bunun için.
//
// Bu script refresh token'ı YALNIZCA ekrana basar: hiçbir dosyaya, log'a yazmaz.
const http = require('http');
const readline = require('readline');
const path = require('path');

const {
  createPkcePair, buildConsentUrl, exchangeCodeForTokens, SCOPE,
} = require('../../src/infrastructure/youtube-oauth');
const { loadYoutubeCredentials, CredentialsError } = require('../../src/infrastructure/youtube-credentials');

const DEFAULT_PORT = 8765;

function parseArgs(argv) {
  const args = { manual: false, port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manual') args.manual = true;
    else if (a === '--port') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1024 || value > 65535) {
        throw new Error(`--port geçersiz: ${argv[i]} (1024-65535)`);
      }
      args.port = value;
    } else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`bilinmeyen argüman: ${a}`);
  }
  return args;
}

const ask = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
});

// Kullanıcı ya tam redirect URL'ini ya da sadece kodu yapıştırabilir; ikisini de kabul et.
function extractCode(input) {
  if (!input) return null;
  if (input.includes('code=')) {
    try {
      const url = new URL(input.startsWith('http') ? input : `http://127.0.0.1/?${input.replace(/^\?/, '')}`);
      const error = url.searchParams.get('error');
      if (error) throw new Error(`Google izin vermedi: ${error}`);
      return url.searchParams.get('code');
    } catch (err) {
      if (err.message.startsWith('Google')) throw err;
      const m = input.match(/[?&]code=([^&\s]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    }
  }
  return input;
}

// Loopback dinleyici: kodu tarayıcıdan doğrudan yakalar. İlk isteği alıp kapanır.
function waitForLoopbackCode({ port, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(code
        ? '<h1>Izin alindi</h1><p>Bu sekmeyi kapatabilirsin, terminale don.</p>'
        : `<h1>Izin alinamadi</h1><p>${error || 'code yok'}</p>`);
      cleanup();
      if (code) resolve(code);
      else reject(new Error(`Google izin vermedi: ${error || 'code parametresi gelmedi'}`));
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('5 dakika içinde izin tamamlanmadı (dinleyici kapatıldı) — --manual ile tekrar dene'));
    }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); server.close(); };
    server.on('error', (err) => { cleanup(); reject(new Error(`dinleyici açılamadı (port ${port}): ${err.message}`)); });
    server.listen(port, '127.0.0.1');
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Kullanım: node scripts/youtube/get-refresh-token.js [--manual] [--port <1024-65535>]');
    return;
  }

  // Refresh token'ı bu script ÜRETİYOR, dolayısıyla burada zorunlu değil.
  const { clientId, clientSecret, credentialsPath } = loadYoutubeCredentials({ requireRefreshToken: false });
  const redirectUri = `http://127.0.0.1:${args.port}`;
  const { verifier, challenge } = createPkcePair();
  const consentUrl = buildConsentUrl({ clientId, redirectUri, codeChallenge: challenge });

  console.log('== YouTube refresh token alma (bir kerelik) ==');
  console.log(`kimlik kaynağı: ${credentialsPath}`);
  console.log(`redirect_uri  : ${redirectUri}`);
  console.log(`scope         : ${SCOPE}`);
  console.log('');
  console.log('1) Aşağıdaki adresi bir tarayıcıda aç (bilgisayar ya da telefon) ve izin ver:');
  console.log('');
  console.log(consentUrl);
  console.log('');

  let code;
  if (args.manual) {
    console.log('2) İzinden sonra tarayıcı http://127.0.0.1:.../?code=... adresine gidip');
    console.log('   "bağlanılamadı" diyecek. SORUN DEĞİL — adres çubuğundaki URL\'i (ya da');
    console.log('   sadece code değerini) buraya yapıştır.');
    console.log('');
    code = extractCode(await ask('Authorization code (ya da tam URL): '));
  } else {
    console.log(`2) Bu makinede ${redirectUri} dinleniyor — izin verince kod otomatik yakalanacak.`);
    console.log('   (Telefondan izin vereceksen bu script\'i --manual ile çalıştır.)');
    console.log('');
    console.log('bekleniyor...');
    code = await waitForLoopbackCode({ port: args.port });
  }
  if (!code) throw new Error('authorization code alınamadı');

  const tokens = await exchangeCodeForTokens({
    clientId, clientSecret, code, codeVerifier: verifier, redirectUri,
  });
  if (!tokens.refresh_token) {
    throw new Error(
      'Yanıtta refresh_token YOK. Genelde bu client\'a daha önce izin verilmiş olmasından olur.\n' +
      '  Çözüm: https://myaccount.google.com/permissions adresinden uygulamanın erişimini kaldır,\n' +
      '  sonra bu script\'i tekrar çalıştır (script prompt=consent gönderiyor, ama iptal gerekebilir).',
    );
  }

  console.log('');
  console.log('== REFRESH TOKEN (bir kez gösterilir, hiçbir dosyaya yazılmadı) ==');
  console.log('');
  console.log(tokens.refresh_token);
  console.log('');
  console.log('3) VPS\'te .env.youtube dosyasına yaz:');
  console.log('     nano .env.youtube      → YOUTUBE_REFRESH_TOKEN=<yukarıdaki değer>');
  console.log('     chmod 600 .env.youtube');
  console.log('');
  console.log('4) Doğrula:  node scripts/youtube/verify-access.js');
  console.log('');
  console.log('ÖNEMLİ: OAuth consent screen "Testing" modundaysa bu token 7 GÜNDE expire olur.');
  console.log('        7/24 yayın için Google Cloud Console → OAuth consent screen → "In production".');
  if (tokens.scope && !tokens.scope.includes(SCOPE)) {
    console.log(`UYARI: verilen scope beklenenden farklı: ${tokens.scope}`);
  }
}

main().catch((err) => {
  const where = err instanceof CredentialsError ? '' : ` (${path.basename(__filename)})`;
  console.error(`\nHATA${where}: ${err.message}`);
  process.exitCode = 1;
});
