// YouTube'da VAR OLAN yayınları (broadcast) listeler ve üzerinde işlem yapar: başlık/açıklama,
// görünürlük, kapak, bitirme. /config sayfasındaki yayın seçicinin arkasındaki servis.
//
// GoLiveService'ten AYRI: o, tek bir kayıtlı yayını CANLIYA ALMAKLA ilgili (idempotans, ingest
// yoklaması). Bu sınıf kayıtlı yayından bağımsız, kullanıcının SEÇTİĞİ yayına bakar ve
// durum makinesi taşımaz. fs/HTTP bilmez: api ve log enjekte edilir (katman kuralı).
//
// GÜVENLİK: işlem yapılabilecek id'ler yalnızca listede (kanalın kendi yayınları) bulunanlardır.
// Formdan gelen rastgele bir id ile rastgele bir videoya dokunulmaz.
const { MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH } = require('../domain/stream-plan');

const PRIVACY_VALUES = ['public', 'unlisted', 'private'];
// Bitirilebilen (complete'e geçebilen) durumlar: YouTube, created/ready'den complete'e
// geçişe izin vermez; yalnızca testing/live (ve liveStarting) bitirilebilir.
const ENDABLE = new Set(['live', 'testing', 'liveStarting']);
const FINISHED = new Set(['complete', 'revoked']);

class BroadcastAdminError extends Error {}

class BroadcastAdmin {
  // api: { getAccessToken, listBroadcasts, updateVideoDetails, updateVideoPrivacy,
  //        setThumbnail, transitionBroadcast }
  constructor({
    api, log, now = () => Date.now(), cacheMs = 30000,
  }) {
    this.api = api;
    this.log = log;
    this.now = now;
    this.cacheMs = cacheMs;
    this.cache = null; // { at, items }
  }

  // [{ id, title, description, privacyStatus, lifeCycleStatus, finished }] — aktif/yaklaşan
  // yayınlar önce, bitenler sonra (her grup kendi içinde API sırasında: en yeni önce).
  // Sayfa her açılışta/yenilemede kota harcamasın diye cacheMs önbellek (işlemler sıfırlar).
  async list({ fresh = false } = {}) {
    if (!fresh && this.cache && this.now() - this.cache.at < this.cacheMs) return this.cache.items;
    const { accessToken } = await this.api.getAccessToken();
    const raw = await this.api.listBroadcasts({ accessToken });
    const items = raw.map((b) => ({
      id: b.id,
      title: b.snippet?.title ?? '(başlıksız)',
      description: b.snippet?.description ?? '',
      privacyStatus: b.status?.privacyStatus ?? null,
      lifeCycleStatus: b.status?.lifeCycleStatus ?? null,
      finished: FINISHED.has(b.status?.lifeCycleStatus),
    }));
    items.sort((a, b) => Number(a.finished) - Number(b.finished)); // Array#sort kararlı
    this.cache = { at: this.now(), items };
    return items;
  }

  async get(id) {
    return (await this.list()).find((b) => b.id === id) ?? null;
  }

  // Seçilen id gerçekten kanalın yayını mı? Önbellek bayatsa bir kez taze liste ile dener
  // (az önce oluşturulmuş yayın önbellekte olmayabilir).
  async #require(id) {
    let found = await this.get(id);
    if (!found) found = (await this.list({ fresh: true })).find((b) => b.id === id) ?? null;
    if (!found) throw new BroadcastAdminError('yayın bulunamadı (silinmiş olabilir)');
    return found;
  }

  async updateDetails(id, { title, description }) {
    await this.#require(id);
    const t = String(title ?? '').trim();
    const d = String(description ?? '').replace(/\r\n/g, '\n').trim();
    if (!t) throw new BroadcastAdminError('başlık boş olamaz');
    if (t.length > MAX_TITLE_LENGTH) throw new BroadcastAdminError(`başlık en fazla ${MAX_TITLE_LENGTH} karakter olabilir`);
    if (d.length > MAX_DESCRIPTION_LENGTH) throw new BroadcastAdminError(`açıklama en fazla ${MAX_DESCRIPTION_LENGTH} karakter olabilir`);
    const { accessToken } = await this.api.getAccessToken();
    const result = await this.api.updateVideoDetails({
      accessToken, videoId: id, title: t, description: d,
    });
    if (result?.skipped) throw new BroadcastAdminError(`güncellenemedi: ${result.reason}`);
    this.#forget(id, { title: t, description: d });
    this.log?.info?.(`yayın ${id}: başlık/açıklama güncellendi`);
  }

  async setPrivacy(id, privacyStatus) {
    await this.#require(id);
    if (!PRIVACY_VALUES.includes(privacyStatus)) throw new BroadcastAdminError(`geçersiz görünürlük: ${privacyStatus}`);
    const { accessToken } = await this.api.getAccessToken();
    const result = await this.api.updateVideoPrivacy({ accessToken, videoId: id, privacyStatus });
    if (result?.skipped && result.reason === 'video bulunamadı') throw new BroadcastAdminError('güncellenemedi: video bulunamadı');
    this.#forget(id, { privacyStatus });
    this.log?.info?.(`yayın ${id}: görünürlük → ${privacyStatus}`);
  }

  // filePath çağıranda doğrulanır (kapak listesinde olmalı); burada yalnızca API'ye iletilir.
  async setThumbnail(id, filePath) {
    await this.#require(id);
    const { accessToken } = await this.api.getAccessToken();
    const result = await this.api.setThumbnail({ accessToken, broadcastId: id, filePath });
    if (result?.skipped) {
      throw new BroadcastAdminError(`kapak yüklenemedi: dosya ${result.reason === 'empty' ? 'boş' : 'bulunamadı'}`);
    }
    this.log?.info?.(`yayın ${id}: kapak yüklendi (${filePath})`);
  }

  // Yayını bitirir (complete). GERİ ALINAMAZ — çağıran onay almalı. Yalnızca canlı/testte
  // olan yayın bitirilebilir; diğer durumlarda API zaten reddederdi, boşuna çağırmayız.
  async end(id) {
    const found = await this.#require(id);
    if (!ENDABLE.has(found.lifeCycleStatus)) {
      throw new BroadcastAdminError(`yayın şu an canlı değil (durum: ${found.lifeCycleStatus ?? 'bilinmiyor'}) — bitirilemez`);
    }
    const { accessToken } = await this.api.getAccessToken();
    await this.api.transitionBroadcast({ accessToken, broadcastId: id, status: 'complete' });
    this.cache = null;
    this.log?.info?.(`yayın ${id} bitirildi (/config)`);
  }

  // Önbellekteki kaydı yerinde günceller: işlemden hemen sonraki sayfa yeni değeri göstersin
  // (YouTube listesi birkaç saniye eski dönebilir) ve ek list() çağrısı harcanmasın.
  #forget(id, patch) {
    if (!this.cache) return;
    this.cache.items = this.cache.items.map((b) => (b.id === id ? { ...b, ...patch } : b));
  }
}

module.exports = { BroadcastAdmin, BroadcastAdminError, PRIVACY_VALUES };
