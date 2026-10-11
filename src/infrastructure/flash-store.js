// Tek seferlik "flash" mesaj deposu (Post/Redirect/Get, Faz 4). POST işleminin sonucu
// (mesaj, yeni-yayın taslağı, yüklenen kapak) burada tutulur; tarayıcı 303 ile GET'e
// yönlendirilir ve sayfa `?flash=<id>` ile bunu okur. Bellek-içi: süreç yeniden başlarsa
// mesaj kaybolur (zararsız). Id sunucuda üretilir, bu yüzden mesaj sahteciliği mümkün değil.
//
// get() KAYDI SİLMEZ: tarayıcı aynı GET'i yeniden denerse mesaj kaybolmasın; süre (ttl)
// dolunca ya da kapasite aşılınca eskiler atılır. Token buraya KONMAZ.
const crypto = require('node:crypto');

class FlashStore {
  constructor({ now = () => Date.now(), ttlMs = 60000, max = 50 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.max = max;
    this.items = new Map(); // id → { payload, at } (ekleme sırası = yaş sırası)
  }

  #sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, item] of this.items) {
      if (item.at > cutoff) break;
      this.items.delete(id);
    }
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value);
  }

  put(payload) {
    const id = crypto.randomBytes(16).toString('hex');
    this.items.set(id, { payload, at: this.now() });
    this.#sweep();
    return id;
  }

  // Bilinmeyen/süresi dolmuş/biçimsiz id → null (sayfa mesajsız açılır).
  get(id) {
    this.#sweep();
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return null;
    return this.items.get(id)?.payload ?? null;
  }
}

module.exports = { FlashStore };
