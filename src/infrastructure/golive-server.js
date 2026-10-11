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
//   GET  /config    → mobil yapılandırma sayfası (configApi verilmişse; Faz N2)
//   POST /config    → sayfadaki formu uygular
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { renderConfigPage } = require('../ui/config-page');

const MAX_BODY_BYTES = 4096;
// /config formu: çok sayıda klip yolu (checkbox) taşıyabilir — /go-live'ın boş gövdesinden
// çok daha büyük olabilir, o yüzden ayrı (daha geniş) bir sınır.
const CONFIG_MAX_BODY_BYTES = 65536;
// Hız sınırı ROUTE BAŞINA ve yetkilendirmeden SONRA (10 Ekim 2026). Eskiden tek bir
// global sayaç vardı (60 sn'de 20 istek) ve auth'tan ÖNCE işliyordu; iki ayrı sorun:
//   1. /status'un yorumu "telefon sık yoklayabilsin" diyor ama 3 sn'de bir yoklayan bir
//      Shortcuts/widget dakikada 20'yi aşıyor ve AYNI pencerede /go-live 429 alıyordu —
//      yani sık yoklamak yayını açma yeteneğini kilitliyordu.
//   2. Sayaç auth'tan önce olduğu için yetkisiz istekler de onu dolduruyordu: tokenı
//      olmayan biri sahibi kilitleyebiliyordu.
// Çözüm: /go-live kendi (dar) bütçesinde, /status kendi (geniş) bütçesinde. Yetkisiz
// istekler ayrı bir kovada sayılır — kaba kuvvet denemesi yine sınırlı ama meşru
// kullanıcının bütçesinden yemiyor.
const RATE_LIMITS = Object.freeze({
  // Canlı yayın açan endpoint: hacim zaten çok düşük, dar tutulur.
  '/go-live': { windowMs: 60000, max: 10 },
  // Salt okuma ve API'ye gitmiyor (diskten): telefon rahatça yoklayabilsin.
  '/status': { windowMs: 60000, max: 60 },
  // Yapılandırma sayfası: telefondan elle doldurulan bir form, /go-live kadar sık değil
  // ama /status kadar da okuma-ağırlıklı değil — kendi (orta) kovası.
  '/config': { windowMs: 60000, max: 30 },
  // Sayfa açılışında klip sayısı kadar önizleme isteği gider (onlarca olabilir) — /config
  // sayfasından çok daha geniş bir bütçe gerekiyor.
  '/config/thumb': { windowMs: 60000, max: 120 },
  // Yetkisiz denemeler: tek kova, tüm route'lar ortak.
  unauthorized: { windowMs: 60000, max: 20 },
});

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

// drainBody'nin tersine gövdeyi METİN olarak döndürür — /config formu
// (application/x-www-form-urlencoded) bunu OKUMAK zorunda.
function readBody(req, limit = CONFIG_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        reject(Object.assign(new Error('gövde çok büyük'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

class GoLiveServer {
  // goLiveService: { goLive(), getStatus({refresh}) }; log: { info, warn, error }
  // healthProvider: () => ({ <kontrol>: { status, message, ... } }) — periyodik izlemenin
  // son gördüğü durum; /status'a eklenir. Verilmezse /status eskisi gibi döner.
  // configApi: ConfigApi — verilmezse /config 404 döner (mevcut kurulumlar etkilenmez,
  // projenin "özellik opsiyonel" deseni — bkz. ReconfigurablePomodoroPlanner).
  // thumbnailProvider: (clipPath) => Promise<string|null> — klip için önizleme JPEG'inin
  // yerel yolu (ensureThumbnail'i sarar, composition root enjekte eder). Verilmezse
  // /config/thumb 404 döner, sayfa resimsiz (ama ÇALIŞIR) kalır.
  constructor({
    goLiveService, authToken, log,
    host = '127.0.0.1', port = 8787,
    now = () => Date.now(),
    healthProvider = null,
    configApi = null,
    thumbnailProvider = null,
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
    this.configApi = configApi;
    this.thumbnailProvider = thumbnailProvider;
    this.hits = new Map(); // kova adı → istek zaman damgaları
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

  #html(res, statusCode, body) {
    res.writeHead(statusCode, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  // Önizleme JPEG'i: ensureThumbnail zaten DİSK seviyesinde önbelleğe alıyor (kaynak
  // değişmedikçe ffmpeg yeniden çalışmaz), bu yüzden tarayıcı tarafında da kısa süreli
  // önbellekleme güvenli — telefon aynı sayfayı birkaç kez açınca veri boşa harcanmasın.
  #image(res, buffer) {
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': buffer.length,
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(buffer);
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

  // bucket: RATE_LIMITS anahtarı. Her kovanın kendi penceresi ve sayacı var; bir kovanın
  // dolması diğerlerini etkilemez.
  #rateLimited(bucket) {
    const limit = RATE_LIMITS[bucket];
    if (!limit) return false; // sınırı olmayan route (ör. /healthz)
    const cutoff = this.now() - limit.windowMs;
    const kept = (this.hits.get(bucket) ?? []).filter((t) => t > cutoff);
    this.hits.set(bucket, kept);
    if (kept.length >= limit.max) return true;
    kept.push(this.now());
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

      // Sıra önemli: önce auth. Yetkisiz istekler meşru kullanıcının route bütçesini
      // yemesin, ama kendi kovalarında yine sınırlı kalsın (kaba kuvvet).
      if (!this.#authorized(req)) {
        if (this.#rateLimited('unauthorized')) {
          this.log.warn(`yetkisiz istek hız sınırına takıldı (${route})`);
          return this.#json(res, 429, { error: 'rate_limited' });
        }
        // Hangi yolun denendiği loglanır, token ASLA loglanmaz.
        this.log.warn(`yetkisiz istek: ${req.method} ${route}`);
        return this.#json(res, 401, { error: 'unauthorized' });
      }

      if (this.#rateLimited(route)) {
        this.log.warn(`hız sınırı aşıldı (${route})`);
        return this.#json(res, 429, { error: 'rate_limited' });
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

      if (route === '/config/thumb') {
        if (!this.configApi || !this.thumbnailProvider) return this.#json(res, 404, { error: 'not_found' });
        if (req.method !== 'GET') return this.#json(res, 405, { error: 'method_not_allowed' });
        const file = url.searchParams.get('file') || '';
        // Yalnızca configApi'nin bildiği klip adaylarından biri istenebilir — rastgele bir
        // yol verip sunucudaki herhangi bir dosyanın küçük resmini çıkarmak İSTENMEZ
        // (aynı "listede olmayan yol reddedilir" kuralı ConfigApi#save'de de var).
        const { clips, covers = [] } = await this.configApi.form();
        if (!clips.includes(file) && !covers.includes(file)) return this.#json(res, 404, { error: 'not_found' });
        const thumbPath = await this.thumbnailProvider(file);
        if (!thumbPath) return this.#json(res, 404, { error: 'not_found' });
        return this.#image(res, fs.readFileSync(thumbPath));
      }

      if (route === '/config') {
        if (!this.configApi) return this.#json(res, 404, { error: 'not_found' });
        // Token form action'ına query olarak gömülür — gövdeden okumak auth'tan ÖNCE
        // gövdeyi okumayı gerektirirdi (bkz. dosya başındaki route listesi notu).
        const token = url.searchParams.get('token') ?? '';
        if (req.method === 'GET') {
          const form = await this.configApi.form();
          return this.#html(res, 200, renderConfigPage({ ...form, token }));
        }
        if (req.method === 'POST') {
          const text = await readBody(req);
          const params = new URLSearchParams(text);
          // Başlat/durdur: plana dokunmayan ayrı işlem, kaydetme yoluna GİRMEZ.
          const action = params.get('action');
          if ((action === 'start' || action === 'stop') && typeof this.configApi.control === 'function') {
            const result = await this.configApi.control(action);
            const form = await this.configApi.form();
            return this.#html(res, 200, renderConfigPage({
              ...form, token, ...(result.ok ? { notice: result.message } : { error: result.error }),
            }));
          }
          const fields = {
            pomodoroEnabled: params.has('pomodoroEnabled'),
            pomodoroType: params.get('pomodoroType') || '',
            studyVideos: params.getAll('studyVideos'),
            breakVideos: params.getAll('breakVideos'),
            restart: params.get('action') === 'save_restart',
          };
          // Başlık/açıklama/kapak yalnızca formda varsa taşınır: eski/başka istemciler
          // (alan göndermeyenler) bu alanları sessizce SİLMESİN.
          if (params.has('title')) fields.title = params.get('title');
          if (params.has('description')) fields.description = params.get('description');
          if (params.has('cover')) fields.cover = params.get('cover');
          const result = await this.configApi.save(fields);
          if (!result.ok) {
            const form = await this.configApi.form();
            return this.#html(res, 200, renderConfigPage({ ...form, token, error: result.error }));
          }
          const notice = result.restarted
            ? 'Plan kaydedildi ve yayın yeniden başlatıldı.'
            : result.restartError
              ? `Plan kaydedildi — ${result.restartError}`
              : 'Plan kaydedildi.';
          const form = await this.configApi.form();
          return this.#html(res, 200, renderConfigPage({ ...form, token, notice }));
        }
        return this.#json(res, 405, { error: 'method_not_allowed' });
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

module.exports = { GoLiveServer, MAX_BODY_BYTES, RATE_LIMITS };
