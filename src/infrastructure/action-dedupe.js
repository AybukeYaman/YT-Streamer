// İşlem tekrarı önleme (Post/Redirect/Get, Faz 4). Sayfa her basımda rastgele bir "n"
// (nonce) üretir ve POST formlarının action URL'sine ekler. Aynı n ile ikinci gönderim
// (ağ yeniden denemesi, çift dokunuş, eski sayfayı yeniden gönderme) işlemi TEKRAR
// ÇALIŞTIRMAZ. n yoksa/biçimsizse dedupe yapılmaz (eski sekmeler, Shortcuts, testler).
//
//   begin(n) → 'new' (çalıştır) | 'inflight' (ilk istek sürüyor) | 'done' (zaten uygulandı)
//   finish(n) → işlem bitti (sonuç ne olursa olsun tekrar çalışmaz)
//   release(n) → işlem beklenmedik şekilde düştü (500); yeniden denenebilsin
const NONCE_RE = /^[0-9a-f]{32}$/;

class ActionDedupe {
  constructor({ now = () => Date.now(), ttlMs = 600000, max = 500 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.max = max;
    this.items = new Map(); // n → { state: 'inflight' | 'done', at }
  }

  static valid(n) {
    return typeof n === 'string' && NONCE_RE.test(n);
  }

  #sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [n, item] of this.items) {
      if (item.state === 'done' && item.at <= cutoff) this.items.delete(n);
    }
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value);
  }

  begin(n) {
    if (!ActionDedupe.valid(n)) return 'new';
    this.#sweep();
    const existing = this.items.get(n);
    if (existing) return existing.state;
    this.items.set(n, { state: 'inflight', at: this.now() });
    return 'new';
  }

  finish(n) {
    if (ActionDedupe.valid(n)) this.items.set(n, { state: 'done', at: this.now() });
  }

  release(n) {
    if (ActionDedupe.valid(n)) this.items.delete(n);
  }
}

module.exports = { ActionDedupe };
