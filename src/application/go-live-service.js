// Yayını YouTube'da canlıya alma kararları. HTTP sunucusunu, fetch'i, fs'i bilmez —
// api/stateStore/log/now/sleep enjekte edilir (test edilebilirlik ve katman ayrımı).
//
// Sıra ZORUNLU (KARARLAR.md):
//   ffmpeg zaten basıyor  →  insert  →  bind  →  ingest 'active' olana kadar yokla
//   →  transition('live')
// transition, ingest aktif değilken hata verir; yani bu otomasyon yayını BAŞLATAN değil,
// yayın başladıktan SONRA çalışan adımdır.
//
// İdempotans: diskteki kayıtta canlı bir broadcast varsa insert YAPILMAZ. Aksi halde
// go-live servisi her restart'ta/her tetikte yeni broadcast yaratır — kanalda çöp
// yayınlar ve kota tükenmesi.

// ingest'in 'active' olması için tanınan süre. ffmpeg bağlandıktan sonra YouTube'un
// akışı görmesi saniyeler alır; 2 dk, yavaş bir bağlantı için bile bol.
const DEFAULT_INGEST_TIMEOUT_MS = 120000;
const DEFAULT_POLL_INTERVAL_MS = 3000;
// Canlı sayılan durumlar: bunlardan biri varsa yeni broadcast açılmaz.
const ACTIVE_STATUSES = new Set(['live', 'testing', 'liveStarting']);
// Oluşturulmuş ama canlıya alınamamış broadcast: yenisini açmak yerine YENİDEN KULLANILIR
// (yarım kalan denemeler kanalda çöp yayın bırakmasın).
const REUSABLE_STATUSES = new Set(['created', 'ready']);

class GoLiveError extends Error {
  constructor(message, { code = 'go_live_failed', details = null } = {}) {
    super(message);
    this.name = 'GoLiveError';
    this.code = code;
    this.details = details;
  }
}

class GoLiveService {
  // api: { getAccessToken, insertBroadcast, bindBroadcast, transitionBroadcast,
  //        getBroadcast, findStreamIdByKey, getStreamStatus }
  // broadcastConfig: { title, description, privacyStatus, latencyPreference, streamId|null }
  // streamKey: yayının .env'deki key'i (streamId null ise ondan çözülür)
  constructor({
    api, stateStore, log, broadcastConfig, streamKey,
    ingestTimeoutMs = DEFAULT_INGEST_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  }) {
    this.api = api;
    this.stateStore = stateStore;
    this.log = log;
    this.broadcastConfig = broadcastConfig;
    this.streamKey = streamKey;
    this.ingestTimeoutMs = ingestTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
    this.sleep = sleep;
    // Tek-uçuş kilidi: iOS'ta çift dokunma iki broadcast yaratmasın.
    this.inFlight = null;
  }

  get busy() {
    return this.inFlight !== null;
  }

  // Durum özeti. refresh=false (varsayılan): yalnızca diskten okur — telefondan sık
  // yoklamak kotayı yemesin. refresh=true: API'den canlı durumu da çeker.
  async getStatus({ refresh = false } = {}) {
    const state = this.stateStore.load();
    const base = {
      broadcastId: state?.broadcastId ?? null,
      streamId: state?.streamId ?? null,
      status: state?.status ?? null,
      title: state?.title ?? null,
      createdAt: state?.createdAt ?? null,
      wentLiveAt: state?.wentLiveAt ?? null,
      busy: this.busy,
    };
    if (!refresh || !state?.broadcastId) return base;

    const { accessToken } = await this.api.getAccessToken();
    const broadcast = await this.api.getBroadcast({ accessToken, broadcastId: state.broadcastId });
    if (!broadcast) return { ...base, status: 'missing', liveStatus: null };
    const liveStatus = broadcast.status?.lifeCycleStatus ?? null;
    const ingest = state.streamId
      ? await this.api.getStreamStatus({ accessToken, streamId: state.streamId })
      : { streamStatus: null, healthStatus: null };
    return { ...base, status: liveStatus ?? base.status, liveStatus, ingest };
  }

  // Tek giriş noktası. Eşzamanlı ikinci çağrı aynı promise'i beklemez, açıkça reddedilir:
  // çağıran (HTTP 409) "şu an sürüyor" bilgisini almalı, sessizce aynı sonucu almamalı.
  goLive() {
    if (this.inFlight) {
      return Promise.reject(new GoLiveError('go-live şu an sürüyor', { code: 'busy' }));
    }
    this.inFlight = this.#goLive().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async #goLive() {
    const { accessToken } = await this.api.getAccessToken();
    const streamId = await this.#resolveStreamId(accessToken);

    const existing = await this.#existingBroadcast(accessToken);
    if (existing?.kind === 'live') {
      this.log.info(`broadcast zaten canlı (${existing.broadcastId}, ${existing.status}) — yeni insert yapılmadı`);
      return { action: 'already-live', ...existing, kind: undefined };
    }

    // ingest kontrolü insert'ten ÖNCE: ffmpeg basmıyorken broadcast oluşturmak, kanalda
    // 'ready' durumunda çöp bir yayın bırakır ve sonraki her deneme bir tane daha ekler.
    // (Duman testinde tam olarak bu görüldü.) transition zaten ingest aktif olmadan
    // çalışmadığı için önce kontrol etmenin maliyeti yok, kazancı çöp broadcast olmaması.
    await this.#waitForIngest({ accessToken, streamId });

    const title = this.broadcastConfig.title;
    let broadcastId = existing?.broadcastId ?? null;
    if (broadcastId) {
      // Yarım kalmış broadcast (oluşturuldu ama canlıya alınamadı) yeniden kullanılır:
      // yenisini açmak kanalda çöp bırakırdı.
      this.log.info(`yarım kalan broadcast yeniden kullanılıyor: ${broadcastId} (${existing.status})`);
    } else {
      this.log.info(`broadcast oluşturuluyor: "${title}" (${this.broadcastConfig.privacyStatus})`);
      const created = await this.api.insertBroadcast({
        accessToken,
        title,
        description: this.broadcastConfig.description,
        privacyStatus: this.broadcastConfig.privacyStatus,
        latencyPreference: this.broadcastConfig.latencyPreference,
        scheduledStartTime: new Date(this.now()).toISOString(),
      });
      if (!created?.id) throw new GoLiveError('insert yanıtında broadcast id yok');
      broadcastId = created.id;
      // Kayıt HEMEN yazılır: bundan sonraki bir çökme broadcast'i "kayıp" bırakmasın —
      // sonraki tetik onu bulur ve yeniden kullanır, yeni bir tane açmaz.
      this.#saveState({ broadcastId, streamId, status: 'created', title });
      this.log.info(`broadcast oluşturuldu: ${broadcastId}`);
      // Yalnızca YENİ broadcast'te: yeniden kullanılanda küçük resim zaten yüklenmişti,
      // tekrarı boşa kota. Hiçbir koşulda akışı durdurmaz (#setThumbnail atmaz).
      await this.#setThumbnail({ accessToken, broadcastId });
    }

    await this.api.bindBroadcast({ accessToken, broadcastId, streamId });
    this.#saveState({ broadcastId, streamId, status: 'bound', title });
    this.log.info(`broadcast stream'e bağlandı: ${streamId}`);

    await this.api.transitionBroadcast({ accessToken, broadcastId, status: 'live' });
    const wentLiveAt = new Date(this.now()).toISOString();
    this.#saveState({ broadcastId, streamId, status: 'live', title, wentLiveAt });
    this.log.info(`broadcast CANLI: ${broadcastId}`);
    return { action: 'went-live', broadcastId, streamId, status: 'live', title, wentLiveAt };
  }

  // Küçük resim: kritik DEĞİL. Dosya yoksa sessizce atlanır, yükleme hata verirse
  // uyarı loglanır ve go-live devam eder — bir thumbnail yüzünden yayının canlıya
  // geçmemesi kabul edilemez (ve broadcast zaten oluşmuş durumda).
  // state'e yazılmaz: idempotans kararlarında rolü yok.
  async #setThumbnail({ accessToken, broadcastId }) {
    const filePath = this.broadcastConfig.thumbnailPath;
    if (!filePath) return;
    try {
      const result = await this.api.setThumbnail({ accessToken, broadcastId, filePath });
      if (result?.skipped) {
        this.log.info(`küçük resim atlandı (${result.reason === 'empty' ? 'dosya boş' : 'dosya yok'}): ${filePath}`);
      } else {
        this.log.info(`küçük resim yüklendi: ${filePath}`);
      }
    } catch (err) {
      this.log.warn(`küçük resim yüklenemedi (${err.message}) — kritik değil, go-live sürüyor`);
    }
  }

  // Kalıcı stream id: config'te verilmişse o, yoksa yayının key'inden çözülür.
  // Sabit id yazmak yerine çözmek, çoklu yayında her instance'ın KENDİ stream'ine
  // bağlanmasını garanti eder ve key döndürülürse id sessizce eskimez.
  async #resolveStreamId(accessToken) {
    if (this.broadcastConfig.streamId) return this.broadcastConfig.streamId;
    if (!this.streamKey) {
      throw new GoLiveError(
        'stream id çözülemedi: config.broadcast.streamId boş ve .env\'de YOUTUBE_STREAM_KEY yok',
        { code: 'stream_not_resolved' },
      );
    }
    const streamId = await this.api.findStreamIdByKey({ accessToken, streamKey: this.streamKey });
    if (!streamId) {
      throw new GoLiveError(
        'yayının stream key\'i kanaldaki hiçbir stream ile eşleşmedi — OAuth izni başka bir ' +
        'Google hesabıyla verilmiş ya da key başka kanala ait olabilir',
        { code: 'stream_not_found' },
      );
    }
    return streamId;
  }

  // Diskteki kayıt hâlâ geçerli mi? API'den doğrulanır: elle silinmiş/sonlandırılmış bir
  // broadcast yüzünden go-live sonsuza kadar "zaten canlı" demesin.
  //
  // Üç sonuç:
  //   { kind: 'live' }      → zaten canlı, hiçbir şey yapılmayacak
  //   { kind: 'reusable' }  → oluşturulmuş ama canlıya alınamamış; yeniden kullanılacak
  //   null                  → kullanılabilir kayıt yok, yeni insert gerekiyor
  async #existingBroadcast(accessToken) {
    const state = this.stateStore.load();
    if (!state?.broadcastId) return null;
    const broadcast = await this.api.getBroadcast({ accessToken, broadcastId: state.broadcastId });
    if (!broadcast) {
      this.log.warn(`kayıtlı broadcast ${state.broadcastId} YouTube'da yok (silinmiş?) — kayıt temizlendi`);
      this.stateStore.clear();
      return null;
    }
    const lifeCycle = broadcast.status?.lifeCycleStatus ?? null;
    const base = {
      broadcastId: state.broadcastId,
      streamId: state.streamId ?? null,
      status: lifeCycle,
      title: state.title ?? broadcast.snippet?.title ?? null,
      wentLiveAt: state.wentLiveAt ?? null,
    };
    if (ACTIVE_STATUSES.has(lifeCycle)) return { kind: 'live', ...base };
    if (REUSABLE_STATUSES.has(lifeCycle)) return { kind: 'reusable', ...base };
    // complete / revoked: bir daha canlıya alınamaz, yenisi gerekiyor.
    this.log.warn(`kayıtlı broadcast ${state.broadcastId} kullanılamaz durumda (${lifeCycle}) — kayıt temizlendi`);
    this.stateStore.clear();
    return null;
  }

  // ingest 'active' olmadan transition('live') hata verir; ffmpeg'in akışı YouTube'a
  // ulaştırması saniyeler alabilir.
  async #waitForIngest({ accessToken, streamId }) {
    const deadline = this.now() + this.ingestTimeoutMs;
    let last = null;
    for (;;) {
      const status = await this.api.getStreamStatus({ accessToken, streamId });
      if (status.streamStatus === 'active') {
        this.log.info(`ingest aktif (sağlık: ${status.healthStatus ?? '?'})`);
        return status;
      }
      last = status;
      if (this.now() >= deadline) break;
      this.log.info(`ingest bekleniyor: ${status.streamStatus ?? 'bilinmiyor'} — ${this.pollIntervalMs} ms sonra tekrar`);
      await this.sleep(this.pollIntervalMs);
    }
    throw new GoLiveError(
      `ingest ${this.ingestTimeoutMs >= 1000 ? `${Math.round(this.ingestTimeoutMs / 1000)} sn` : `${this.ingestTimeoutMs} ms`} içinde aktif olmadı ` +
      `(son durum: ${last?.streamStatus ?? 'bilinmiyor'}). ffmpeg gerçekten yayın yapıyor mu? ` +
      'Kontrol: systemctl status yt-streamer',
      { code: 'ingest_not_active', details: last },
    );
  }

  // Durum yazılamazsa akış DURUR: yazmadan devam etmek idempotansı kaybettirir ve
  // sonraki tetik ikinci bir broadcast açar — sessizce kabul edilemez.
  #saveState(state) {
    try {
      this.stateStore.save({ ...state, createdAt: state.createdAt ?? new Date(this.now()).toISOString() });
    } catch (err) {
      throw new GoLiveError(
        `broadcast durumu yazılamadı (${err.message}) — idempotans kaybolacağı için durduruldu`,
        { code: 'state_write_failed' },
      );
    }
  }
}

module.exports = { GoLiveService, GoLiveError };
