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
//   POST /config    → sayfadaki formu uygular (ya da action=start|stop: yayını başlat/durdur)
//   POST /config/upload → telefon galerisinden kapak yükler (multipart, coverFile alanı)
//   POST /config/broadcast → YouTube'daki SEÇİLİ yayına işlem (action=apply|end)
//   POST /config/new       → yeni (eşzamanlı) yayın kur: YouTube stream + sistemde servis
//   POST /config/instance  → kurulu ek yayına işlem (start|stop|golive)
//   (GET /config?broadcast=<id> yayın seçiciyi o yayına açar)
//   GET  /config/thumb  → klip/kapak önizleme JPEG'i
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { renderConfigPage } = require('../ui/config-page');
const { parseMultipart } = require('./multipart');

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
  // Galeriden kapak yükleme: her istek ffmpeg çalıştırır ve 15 MB'a kadar bellek tutar.
  '/config/upload': { windowMs: 60000, max: 6 },
  // YouTube'a yazan işlemler (her biri 50 kota birimi): dar bütçe.
  '/config/broadcast': { windowMs: 60000, max: 10 },
  // Yeni yayın kurma: YouTube'a yazar, sistemde servis kurar. Çok dar bütçe.
  '/config/new': { windowMs: 60000, max: 3 },
  '/config/instance': { windowMs: 60000, max: 20 },
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

// Galeri yüklemesi (ham fotoğraf): telefon fotoğrafı birkaç MB, 48MP çekimler 10+ MB olabilir.
const CONFIG_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

// readBody'nin ikili hali: multipart gövdede baytlar utf8'e çevrilirse bozulur.
function readBodyBuffer(req, limit) {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
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
    broadcastAdmin = null,
    streamManager = null,
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
    this.broadcastAdmin = broadcastAdmin;
    // streamManager: StreamManager — ek yayınlar (yeni yayın kur, başlat/durdur/canlıya al). Yoksa özellik kapalı.
    this.streamManager = streamManager;
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

  // YouTube'daki yayın listesi (yayın seçici). Opsiyonel ve HATA-TOLERANSLI: broadcastAdmin
  // yoksa null; API hata verirse { error: true } — yapılandırma ekranı YouTube API'sine
  // bağımlı olmamalı, sayfa seçicisiz de açılır.
  async #broadcastList() {
    if (!this.broadcastAdmin) return null;
    try {
      return { items: await this.broadcastAdmin.list() };
    } catch (err) {
      this.log.warn(`yayın listesi okunamadı (${err.message}) — sayfa seçicisiz açıldı`);
      return { error: true };
    }
  }

  // Seçili yayın: istenen id (listede varsa) > kayıtlı (go-live'ın açtığı) yayın > ilk
  // aktif/yaklaşan yayın > listenin başı. getStatus() yalnızca diskten okur (API'ye gitmez).
  async #pickBroadcast(list, wantedId) {
    const items = list?.items;
    if (!items?.length) return null;
    if (wantedId && items.some((b) => b.id === wantedId)) return wantedId;
    try {
      const recorded = (await this.goLiveService.getStatus({ refresh: false }))?.broadcastId;
      if (recorded && items.some((b) => b.id === recorded)) return recorded;
    } catch {
      // kayıt okunamadı: sıradaki kurala düş
    }
    return (items.find((b) => !b.finished) ?? items[0]).id;
  }

  // Seçili yayına işlem uygular; { notice } ya da { error } döner (atmaz: sayfa her durumda açılır).
  // 'apply': yalnızca DEĞİŞEN alanlar API'ye gider (her yazma 50 kota birimi). Bir adım
  // başarısız olsa diğerleri denenir; sonuç tek mesajda özetlenir.
  async #broadcastAction(params, id) {
    const admin = this.broadcastAdmin;
    const action = params.get('action');
    try {
      if (action === 'end') {
        await admin.end(id);
        return { notice: 'Yayın bitirildi.' };
      }
      if (action !== 'apply') return { error: `bilinmeyen işlem: ${action}` };

      const current = await admin.get(id);
      if (!current) return { error: 'yayın bulunamadı (silinmiş olabilir)' };
      const done = [];
      const failed = [];
      const attempt = async (label, fn) => {
        try {
          await fn();
          done.push(label);
        } catch (err) {
          failed.push(`${label}: ${err.message}`);
        }
      };

      const title = params.has('title') ? params.get('title') : current.title;
      const description = params.has('description') ? params.get('description').replace(/\r\n/g, '\n').trim() : current.description;
      if (title.trim() !== current.title || description !== current.description.trim()) {
        await attempt('başlık/açıklama', () => admin.updateDetails(id, { title, description }));
      }
      const privacy = params.get('privacy');
      if (privacy && privacy !== current.privacyStatus) {
        await attempt('görünürlük', () => admin.setPrivacy(id, privacy));
      }
      const cover = params.get('cover');
      if (cover) {
        const { covers = [] } = await this.configApi.form();
        // Yalnızca kapak listesindeki dosyalar (aynı "listede olmayan yol reddedilir" kuralı).
        if (!covers.includes(cover)) failed.push('kapak: listede olmayan dosya reddedildi');
        else await attempt('kapak', () => admin.setThumbnail(id, cover));
      }

      if (!done.length && !failed.length) return { notice: 'Değişiklik yok.' };
      if (failed.length) {
        return { error: `${failed.join(' · ')}${done.length ? ` (uygulananlar: ${done.join(', ')})` : ''}` };
      }
      return { notice: `Yayına uygulandı: ${done.join(', ')}.` };
    } catch (err) {
      this.log.warn(`yayın işlemi başarısız (${action}): ${err.message}`);
      return { error: err.message };
    }
  }

  // /config sayfasının TEK basım yeri: form verisi + yayın listesi + (varsa) mesaj.
  async #configPage(res, token, extra = {}, headers = {}, wantedBroadcastId = null) {
    const form = await this.configApi.form();
    const broadcasts = await this.#broadcastList();
    const selectedId = await this.#pickBroadcast(broadcasts, wantedBroadcastId);
    const mgr = this.streamManager;
    const body = renderConfigPage({
      ...form,
      token,
      broadcasts,
      selectedId,
      canCreate: Boolean(mgr),
      instances: mgr ? mgr.list() : null,
      // Albüm kataloğu yalnızca "Yeni yayın" formu açıkken okunur (diske her sayfada gitme).
      catalogAlbums: mgr && extra.newMode ? mgr.albums() : [],
      ...extra,
    });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...headers,
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
        // Seçili yayın URL'de taşınır (?broadcast=<id>): kaydet/başlat/durdur sonrası seçim bozulmaz.
        const wanted = url.searchParams.get('broadcast');
        if (req.method === 'GET') {
          const newMode = url.searchParams.get('new') === '1' && Boolean(this.streamManager);
          return this.#configPage(res, token, newMode ? { newMode: true } : {}, {}, wanted);
        }
        if (req.method === 'POST') {
          const text = await readBody(req);
          const params = new URLSearchParams(text);
          // Başlat/durdur: plana dokunmayan ayrı işlem, kaydetme yoluna GİRMEZ.
          const action = params.get('action');
          if ((action === 'start' || action === 'stop') && typeof this.configApi.control === 'function') {
            const result = await this.configApi.control(action);
            return this.#configPage(res, token, result.ok ? { notice: result.message } : { error: result.error }, {}, wanted);
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
          if (!result.ok) return this.#configPage(res, token, { error: result.error }, {}, wanted);
          const notice = result.restarted
            ? 'Plan kaydedildi ve yayın yeniden başlatıldı.'
            : result.restartError
              ? `Plan kaydedildi — ${result.restartError}`
              : 'Plan kaydedildi.';
          return this.#configPage(res, token, { notice }, {}, wanted);
        }
        return this.#json(res, 405, { error: 'method_not_allowed' });
      }

      // Yeni (eşzamanlı) yayın kur: YouTube stream + sunucuda servis. Yavaş olabilir (add-stream.sh,
      // ~10 sn); başarısızsa form girdileri korunarak aynı sayfa hatayla döner.
      if (route === '/config/new') {
        if (!this.configApi || !this.streamManager) return this.#json(res, 404, { error: 'not_found' });
        if (req.method !== 'POST') return this.#json(res, 405, { error: 'method_not_allowed' });
        const token = url.searchParams.get('token') ?? '';
        const params = new URLSearchParams(await readBody(req));
        const input = {
          name: params.get('name') ?? '',
          title: params.get('title') ?? '',
          description: params.get('description') ?? '',
          privacy: params.get('privacy') ?? '',
          cover: params.get('cover') ?? '',
          albums: params.getAll('albums'),
          goLiveNow: params.has('goLiveNow'),
        };
        const result = await this.streamManager.create(input);
        if (!result.ok) return this.#configPage(res, token, { newMode: true, draft: input, error: result.error });
        return this.#configPage(res, token, { notice: result.message });
      }

      // Kurulu EK yayına işlem (başlat/durdur/canlıya al). Ana yayın bu yoldan yönetilmez.
      if (route === '/config/instance') {
        if (!this.configApi || !this.streamManager) return this.#json(res, 404, { error: 'not_found' });
        if (req.method !== 'POST') return this.#json(res, 405, { error: 'method_not_allowed' });
        const token = url.searchParams.get('token') ?? '';
        const params = new URLSearchParams(await readBody(req));
        const result = await this.streamManager.control(params.get('name') ?? '', params.get('action') ?? '');
        return this.#configPage(res, token, result.ok ? { notice: result.message } : { error: result.error });
      }

      // YouTube'daki SEÇİLİ yayın üzerinde işlem: başlık/açıklama, görünürlük, kapak, bitirme.
      // Plan (sonraki yayın ayarları) ile ilgisi YOK; ayrı form, ayrı route. İşlem yapılabilen
      // id'ler yalnızca kanalın kendi listesindekiler (bkz. BroadcastAdmin).
      if (route === '/config/broadcast') {
        if (!this.configApi || !this.broadcastAdmin) return this.#json(res, 404, { error: 'not_found' });
        if (req.method !== 'POST') return this.#json(res, 405, { error: 'method_not_allowed' });
        const token = url.searchParams.get('token') ?? '';
        const params = new URLSearchParams(await readBody(req));
        const id = params.get('broadcastId') ?? '';
        const outcome = await this.#broadcastAction(params, id);
        return this.#configPage(res, token, outcome, {}, id);
      }

      // Telefon galerisinden kapak yükleme (multipart). Ham dosya sınırı CONFIG_UPLOAD_MAX_BYTES;
      // aşılırsa JSON 413 yerine aynı sayfa hata mesajıyla döner (telefonda ham JSON anlamsız).
      if (route === '/config/upload') {
        if (!this.configApi) return this.#json(res, 404, { error: 'not_found' });
        if (req.method !== 'POST') return this.#json(res, 405, { error: 'method_not_allowed' });
        const token = url.searchParams.get('token') ?? '';
        const wanted = url.searchParams.get('broadcast');
        if (typeof this.configApi.uploadCover !== 'function') return this.#json(res, 404, { error: 'not_found' });
        let body;
        try {
          body = await readBodyBuffer(req, CONFIG_UPLOAD_MAX_BYTES);
        } catch (err) {
          if (err.statusCode !== 413) throw err;
          return this.#configPage(res, token, {
            error: `dosya çok büyük (en fazla ${Math.round(CONFIG_UPLOAD_MAX_BYTES / 1048576)} MB)`,
          }, { Connection: 'close' }, wanted);
        }
        const part = parseMultipart(body, req.headers['content-type']).find((p) => p.name === 'coverFile');
        if (!part || part.data.length === 0) return this.#configPage(res, token, { error: 'görsel seçilmedi' }, {}, wanted);
        const result = await this.configApi.uploadCover(part.data);
        if (!result.ok) return this.#configPage(res, token, { error: result.error }, {}, wanted);
        return this.#configPage(res, token, {
          notice: 'Görsel eklendi ve listede seçildi. Kapağı uygulamak için Kaydet\'e bas.',
          pendingCover: result.path,
        }, {}, wanted);
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
