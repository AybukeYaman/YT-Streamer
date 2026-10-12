// /config sayfasının "ek yayın" tarafının tek giriş noktası: kurulu ek yayınları listeler,
// albüm kataloğunu verir, yeni yayın kurdurur ve mevcut ek yayını başlatır/durdurur/canlıya alır.
// ANA yayın (yt-streamer.service) buradan YÖNETİLMEZ: onun kendi başlat/durdur düğmeleri var.
//
// HTTP/fs/systemd bilmez: provisioner, instances, catalog ve goLive enjekte edilir.
const ACTIONS = ['start', 'stop', 'golive'];

class StreamManager {
  // provisioner: StreamProvisioner; instances: { names, status, start, stop }
  // catalog: { list() } AlbumCatalog; goLive: (name) => Promise<{ action, ... }> — örneğin
  //   kendi GoLiveService'i (config.<ad>.json + .env.<ad>) ile requestGoLive.
  constructor({
    provisioner, instances, catalog, goLive, endBroadcast = null, log,
  }) {
    Object.assign(this, {
      provisioner, instances, catalog, goLive, endBroadcast, log,
    });
  }

  // [{ name, state }] — state: running | stopped | unknown
  list() {
    return this.instances.names().map((name) => ({
      name, state: this.instances.status(name), videoMode: this.instances.videoMode?.(name) ?? 'encode',
    }));
  }

  // Form için: [{ name, trackCount, backgrounds, hasLoop }] (parça yolları sayfaya GİTMEZ, sunucuda kalır).
  albums() {
    return this.catalog.list().map((a) => ({
      name: a.name, trackCount: a.trackCount, backgrounds: a.backgrounds, hasLoop: Boolean(a.loopPath),
    }));
  }

  create(input) {
    return this.provisioner.create(input);
  }

  // Durdurulan ek yayının YouTube yayınını bitirir; hata durdurmayı bozmaz, nota yazılır.
  async #endNote(name) {
    if (!this.endBroadcast) return '';
    try {
      const ended = await this.endBroadcast(name);
      return ended?.ended ? ' YouTube yayını da bitirildi.' : ` YouTube yayını bitirilmedi: ${ended?.reason ?? 'bilinmiyor'}.`;
    } catch (err) {
      this.log?.warn?.(`ek yayın "${name}" YouTube yayını bitirilemedi: ${err.message}`);
      return ` YouTube yayını bitirilemedi (${err.message}) — Studio'dan bitir.`;
    }
  }

  // action: start | stop | golive. İşlem yalnızca KURULU ek yayınlara yapılır (rastgele ad olmaz).
  // @returns {Promise<{ ok: boolean, message?: string, error?: string }>}
  async control(name, action) {
    if (!ACTIONS.includes(action)) return { ok: false, error: `bilinmeyen işlem: ${action}` };
    if (!this.instances.names().includes(name)) return { ok: false, error: `"${name}" adlı ek yayın bulunamadı` };
    try {
      if (action === 'start') {
        this.instances.start(name);
        return { ok: true, message: `"${name}" başlatıldı. Canlıya almak için 30-60 sn sonra "Canlıya Al".` };
      }
      if (action === 'stop') {
        this.instances.stop(name);
        return { ok: true, message: `"${name}" durduruldu.${await this.#endNote(name)}` };
      }
      const result = await this.goLive(name);
      const text = {
        'already-live': 'zaten canlı',
        accepted: 'canlıya alma başladı (1-2 dk sürebilir)',
        'went-live': 'canlıya alındı',
      }[result?.action] ?? 'istek gönderildi';
      return { ok: true, message: `"${name}": ${text}.` };
    } catch (err) {
      // go-live zaten sürüyorsa iş yapılıyor demektir: başarısızlık değil.
      if (action === 'golive' && err?.code === 'busy') {
        return { ok: true, message: `"${name}": canlıya alma zaten sürüyor, birkaç dakika sonra listeye bak.` };
      }
      this.log?.warn?.(`ek yayın "${name}" ${action} başarısız: ${err.message}`);
      return { ok: false, error: `"${name}" ${action} başarısız: ${err.message}` };
    }
  }
}

module.exports = { StreamManager, ACTIONS };
