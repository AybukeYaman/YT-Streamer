// Telefondan "Yeni yayın": ikinci (üçüncü…) bir eşzamanlı yayını baştan kurar.
//
// Akış (her adım sırayla; bir adım düşerse sonrası çalışmaz ve hata adıyla birlikte döner):
//   1. doğrulama + kapasite  (CPU: çalışan yayın sayısı üst sınırı aşmasın)
//   2. YouTube'da yeni stream + anahtar (API; ana yayının anahtarı KULLANILAMAZ)
//   3. add-stream.sh: config.<ad>.json + .env.<ad> + systemd şablonu (anahtar boşken başlatmaz)
//   4. anahtar .env.<ad>'a (izin 600), başlık/açıklama/gizlilik config'e, plan runtime/<ad>/'a
//   5. add-stream.sh yeniden: servis başlar
//   6. (isteğe bağlı) arka planda canlıya al — ingest hazır olunca broadcast açılıp live'a geçer
//
// ANAHTAR GİZLİDİR: yalnızca instances.writeKey'e gider; mesajlara, loglara, dönüş değerine
// girmez. Katman kuralı: fs/child_process bilinmez — hepsi enjekte edilir (infrastructure).
const {
  MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH,
} = require('../domain/stream-plan');
const { PRIVACY_VALUES } = require('./broadcast-admin');
const { validInstanceName } = require('../domain/instance-name');

class ProvisionError extends Error {}

class StreamProvisioner {
  // createStream: ({ title }) => Promise<{ id, streamKey }>
  // instances: { exists, runningCount, provision, writeKey, patchConfig }
  // writePlan: (name, planJson) => void           — runtime/<ad>/stream-plan.json
  // albums: () => [{ name, trackPaths }]          — AlbumCatalog.list
  // covers: () => string[]                        — izinli kapak yolları
  // goLive: (name) => Promise<unknown>            — örneğin kendi GoLiveService'i (arka plan)
  // maxStreams: aynı anda çalışabilecek en fazla yayın (CPU'ya göre hesaplanır)
  constructor({
    createStream, instances, writePlan, albums, covers, goLive, maxStreams, log,
  }) {
    Object.assign(this, {
      createStream, instances, writePlan, albums, covers, goLive, maxStreams, log,
    });
  }

  // Formdaki alanları doğrular; geçerliyse temizlenmiş halini döner. Atar: ProvisionError.
  #validate(input) {
    const name = String(input.name ?? '').trim().toLowerCase();
    if (!validInstanceName(name)) {
      throw new ProvisionError('yayın adı 2-20 karakter olmalı: küçük harf, rakam, - ya da _ (ör. lofi2)');
    }
    const title = String(input.title ?? '').trim();
    if (!title) throw new ProvisionError('başlık boş olamaz');
    if (title.length > MAX_TITLE_LENGTH) throw new ProvisionError(`başlık en fazla ${MAX_TITLE_LENGTH} karakter olabilir`);
    const description = String(input.description ?? '').replace(/\r\n/g, '\n').trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) throw new ProvisionError(`açıklama en fazla ${MAX_DESCRIPTION_LENGTH} karakter olabilir`);
    const privacy = input.privacy || 'unlisted';
    if (!PRIVACY_VALUES.includes(privacy)) throw new ProvisionError(`geçersiz görünürlük: ${privacy}`);

    const cover = String(input.cover ?? '').trim() || null;
    if (cover && !this.covers().includes(cover)) throw new ProvisionError('kapak listede yok, reddedildi');

    // Albüm seçimi: yalnızca katalogdaki adlar. Boş seçim = tüm kütüphane (mevcut davranış).
    const catalog = new Map(this.albums().map((a) => [a.name, a]));
    const wanted = [...new Set(input.albums ?? [])];
    const unknown = wanted.filter((a) => !catalog.has(a));
    if (unknown.length) throw new ProvisionError(`listede olmayan albüm reddedildi: ${unknown[0]}`);
    const selected = wanted.map((a) => catalog.get(a));

    return {
      name, title, description, privacy, cover, selected, goLiveNow: Boolean(input.goLiveNow),
    };
  }

  // @returns {Promise<{ ok: boolean, name?: string, message?: string, error?: string }>}
  async create(input) {
    let v;
    try {
      v = this.#validate(input);
      if (this.instances.exists(v.name)) throw new ProvisionError(`"${v.name}" adı zaten kullanılıyor, başka bir ad seç`);
      const running = this.instances.runningCount();
      if (running >= this.maxStreams) {
        throw new ProvisionError(
          `kapasite dolu: şu an ${running} yayın çalışıyor, bu sunucu en fazla ${this.maxStreams} yayın taşır `
          + '(CPU). Önce birini durdur ya da sunucuyu büyüt.',
        );
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }

    // Bundan sonraki hatalar KISMİ kurulum bırakabilir: hangi adımda düştüğü mesajda yazar.
    let step = 'YouTube stream oluşturma';
    try {
      const stream = await this.createStream({ title: `${v.name} — ${v.title}`.slice(0, MAX_TITLE_LENGTH) });

      step = 'yayın kurulumu (add-stream.sh)';
      await this.instances.provision(v.name); // config + env + unit; anahtar boş → başlatmaz

      step = 'anahtar ve ayarlar';
      this.instances.writeKey(v.name, stream.streamKey);
      this.instances.patchConfig(v.name, (config) => {
        config.broadcast = {
          ...(config.broadcast || {}), title: v.title, description: v.description, privacyStatus: v.privacy,
        };
        // Hafif varsayılan: Pomodoro klip girişleri CPU'yu ~2x yapıyor (ölçüldü), ikinci yayın kapalı açılır.
        config.pomodoro = { ...(config.pomodoro || {}), enabled: false };
        return config;
      });
      this.writePlan(v.name, {
        name: v.name,
        cover: v.cover,
        music: {
          order: 'sequential',
          albums: v.selected.map((a) => ({ name: a.name, trackPaths: a.trackPaths })),
        },
        pomodoro: { enabled: false },
        broadcast: { title: v.title, description: v.description },
      });

      step = 'yayını başlatma';
      await this.instances.provision(v.name); // anahtar dolu → enable --now
    } catch (err) {
      this.log?.warn?.(`yeni yayın "${v.name}" ${step} adımında düştü: ${err.message}`);
      return {
        ok: false,
        error: `"${v.name}" için ${step} başarısız: ${err.message}`
          + `${step === 'YouTube stream oluşturma' ? '' : ' — kısmi kurulum kalmış olabilir, farklı bir ad dene'}`,
      };
    }

    this.log?.info?.(`yeni yayın kuruldu: ${v.name}`);
    if (v.goLiveNow) {
      // Arka plan: ingest hazır olunca (≤2 dk) broadcast açılıp canlıya geçer. Hata yutulmaz, loglanır.
      Promise.resolve()
        .then(() => this.goLive(v.name))
        .then(() => this.log?.info?.(`yeni yayın "${v.name}" canlıya alındı`))
        .catch((err) => this.log?.warn?.(`yeni yayın "${v.name}" canlıya alınamadı: ${err.message}`));
    }
    return {
      ok: true,
      name: v.name,
      message: v.goLiveNow
        ? `"${v.name}" kuruldu ve başlatıldı. 1-2 dk içinde canlıya alınacak; yukarıdaki listeden takip et.`
        : `"${v.name}" kuruldu ve başlatıldı. Canlıya almak için hazır olunca "Canlıya Al" düğmesine bas.`,
    };
  }
}

module.exports = { StreamProvisioner, ProvisionError };
