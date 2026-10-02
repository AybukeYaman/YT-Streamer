// go-live tetikleyicisi için minimal HTTP sunucusu (node:http, bağımlılık yok).
//
// Neden HTTP: canlıya alma adımı yalnızca VPS terminalinden değil, iOS'tan da
// tetiklenebilmeli (Safari linki ya da Shortcuts). Ayrıntı: KARARLAR.md
//
// GÜVENLİK:
//   - Varsayılan bind 127.0.0.1. Dışarıya açılması `tailscale serve` ile yapılır:
//     tailnet içinde geçerli sertifikayla HTTPS verir, arkada loopback'e proxy'ler.
//     Düz HTTP üzerinden bearer token göndermek onu sızdırır — canlı yayın
//     başlatabilen bir endpoint için kabul edilemez.
//   - Bearer token SHA-256 özetleri üzerinden timingSafeEqual ile karşılaştırılır
//     (uzunluk farkı bile sızmasın).
//   - Token hiçbir log satırına girmez.
//
// Route'lar:
//   POST /go-live   → yayını canlıya al (idempotent; süren istek varsa 409)
//   GET  /status    → durum (?refresh=1 API'den taze bilgi; varsayılan diskten)
//   GET  /healthz   → auth'suz, yalnızca "ayakta mıyım" (izleme/uptime içinmuş)
const http = require('http');
const crypto = require('crypto');

const MAX_BODY_BYTES = 4096;
// Kaba hız sınırı: canlı yayın açan bir endpoint için istek hacmi zaten çok düşük.
const RATE_LIMIT = { windowMs: 60000, max: 20 };

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

// Gövde okunur ama KULLANILMAZ: sınırsız gövdeyi bellekte tutmamak ve iOS
// Shortcuts'ın gönderdiği boş/küçük gövdeleri sorunsuz yutmak için.
function drainBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Soketi burada KAPATMA: istemci yanıt yerine "other side closed" görür.
        // Okumayı durdur, hatayı yukarı ver; yanıtı (413) handler gönderir ve
        // bağlantıyı Connection: close ile kapatır.
        req.pause();
        reject(Object.assign(new Error('gövde çok büyük'), { statusCode: 413 }));
      }
    });
    req.on('end', () => resolve());
    req.on('error', reject);
  });
}

class GoLiveServer {
  // goLiveService: { goLive(), getStatus({refresh}) }; log: { info, warn, error }
  // healthProvider: () => ({ <kontrol>: { status, message, ... } }) — periyodik izlemenin
  // son gördüğü durum; /status'a eklenir. Verilmezse /status eskisi gibi döner.
  constructor({
    goLiveService, authToken, log,
    host = '127.0.0.1', port = 8787,
    now = () => Date.now(),
    healthProvider = null,
  }) {
    if (typeof authToken !== 'string' || authToken.trim().length < 32) {
      // Fail-closed: auth'suz ayağa kalkmak sessiz bir güvenlik açığı olurdu.
      throw new Error('GOLIVE_AUTH_TOKEN eksik ya da 32 karakterden kısa — sunucu başlatılmadı.\n' +
        '  Üret:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"\n' +
        '  Yaz:   .env.youtube → GOLIVE_AUTH_TOKEN=<değer>');
    }
    this.goLiveService = goLiveService;
    this.authToken = authToken.trim();
    this.log = log;
    this.host = host;
    this.port = port;
    this.now = now;
    this.healthProvider = healthProvider;
    this.hits = [];
    this.server = http.createServer((req, res) => this.#handle(req, res));
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        const { address, port } = this.server.address();
        this.log.info(`go-live sunucusu dinliyor: http://${address}:${port}`);
        resolve({ address, port });
      });
    });
  }

  close() {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  get boundPort() {
    return this.server.address()?.port ?? null;
  }

  #json(res, statusCode, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(body);
  }

  #authorized(req) {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    // Token URL'de de kabul edilir: iOS'ta Safari'den tek dokunuşla tetiklemek için
    // (header eklemek Shortcuts gerektirir). URL'deki token tarayıcı geçmişine düşer,
    // bu yüzden Shortcuts + header tercih edilmeli — README bunu söylüyor.
    const url = new URL(req.url, `http://${this.host}`);
    const candidate = m ? m[1].trim() : (url.searchParams.get('token') ?? '');
    if (!candidate) return false;
    try {
      return safeEqual(candidate, this.authToken);
    } catch {
      return false;
    }
  }

  #rateLimited() {
    const cutoff = this.now() - RATE_LIMIT.windowMs;
    this.hits = this.hits.filter((t) => t > cutoff);
    if (this.hits.length >= RATE_LIMIT.max) return true;
    this.hits.push(this.now());
    return false;
  }

  async #handle(req, res) {
    const url = new URL(req.url, `http://${this.host}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // healthz auth'suz: yalnızca sürecin ayakta olduğunu söyler, hiçbir bilgi vermez.
      if (route === '/healthz') {
        if (req.method !== 'GET') return this.#json(res, 405, { error: 'method_not_allowed' });
        return this.#json(res, 200, { ok: true });
      }

      if (this.#rateLimited()) {
        this.log.warn(`hız sınırı aşıldı (${route})`);
        return this.#json(res, 429, { error: 'rate_limited' });
      }

      if (!this.#authorized(req)) {
        // Hangi yolun denendiği loglanır, token ASLA loglanmaz.
        this.log.warn(`yetkisiz istek: ${req.method} ${route}`);
        return this.#json(res, 401, { error: 'unauthorized' });
      }

      if (route === '/go-live') {
        if (req.method !== 'POST') {
          return this.#json(res, 405, { error: 'method_not_allowed', hint: 'POST /go-live' });
        }
        await drainBody(req);
        try {
          // requestGoLive: uzun ingest beklemesi ARKA PLANDA sürer, istek hemen döner.
          // iOS Shortcuts'ın HTTP timeout'u 120 sn'lik beklemeden kısa — senkron akış
          // zaman aşımına uğruyordu, oysa iş doğru çalışıyordu. Sonuç: /status → lastRun.
          const result = await this.goLiveService.requestGoLive();
          const code = result.action === 'accepted' ? 202 : 200;
          return this.#json(res, code, { ok: true, ...result });
        } catch (err) {
          if (err.code === 'busy') return this.#json(res, 409, { error: 'busy', message: err.message });
          // Encoder basmıyorken ingest beklemek boşuna: hemen ve GÖRÜNÜR şekilde reddet.
          if (err.code === 'encoder_not_streaming') {
            this.log.error(`go-live reddedildi: ${err.message}`);
            return this.#json(res, 409, {
              error: 'encoder_not_streaming', message: err.message, details: err.details ?? null,
            });
          }
          // stale_broadcast 409: 200 + action:'stale' dönmek telefon kestirmesinde
          // (Shortcuts durum kodunu özel olarak kontrol etmedikçe) başarı gibi görünür.
          // Bu arıza elle müdahale istiyor, görünür olmalı.
          if (err.code === 'stale_broadcast') {
            this.log.error(`go-live reddedildi: ${err.message}`);
            return this.#json(res, 409, {
              error: 'stale_broadcast', message: err.message, details: err.details ?? null,
            });
          }
          this.log.error(`go-live başarısız: ${err.message}`);
          return this.#json(res, 502, { error: err.code ?? 'go_live_failed', message: err.message });
        }
      }

      if (route === '/status') {
        if (req.method !== 'GET') return this.#json(res, 405, { error: 'method_not_allowed' });
        const refresh = url.searchParams.get('refresh') === '1';
        const status = await this.goLiveService.getStatus({ refresh });
        // Sağlık özeti hiçbir API çağrısı yapmaz (izlemenin son turundan okunur), bu
        // yüzden refresh=0 çağrısına da eklenir — telefon sık yoklayabilsin.
        const health = this.healthProvider ? this.healthProvider() : undefined;
        return this.#json(res, 200, { ok: true, ...status, ...(health ? { health } : {}) });
      }

      return this.#json(res, 404, { error: 'not_found' });
    } catch (err) {
      const statusCode = err.statusCode ?? 500;
      this.log.error(`istek işlenemedi (${req.method} ${route}): ${err.message}`);
      if (statusCode === 413) {
        // Gövdenin kalanı okunmadı; keep-alive'da soket kirli kalır — kapat.
        return this.#json(res, 413, { error: 'payload_too_large' }, { Connection: 'close' });
      }
      return this.#json(res, statusCode, { error: 'internal_error', message: err.message });
    }
  }
}

module.exports = { GoLiveServer, MAX_BODY_BYTES, RATE_LIMIT };
