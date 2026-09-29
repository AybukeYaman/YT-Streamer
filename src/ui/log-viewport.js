// Log paneli kaydırma denetleyicisi (saf, I/O'suz). LogBuffer'ın kendisini tutmaz; sadece
// toplam satır sayısı + viewport yüksekliği üzerinden hangi aralığın görüneceğini hesaplar.
//
// Davranış:
//  - LIVE (auto-follow): en yeni satırlar görünür; yeni log gelince otomatik takip.
//  - Kullanıcı yukarı kaydırınca LIVE kapanır, konum (top) mutlak indekse sabitlenir; yeni
//    loglar buffer'a eklenmeye devam eder ama görünüm zıplamaz.
//  - En alta inilince (veya End) LIVE tekrar açılır.
//  - Yükseklik resize'da güncellenir (setHeight).
class LogViewport {
  constructor({ height = 10 } = {}) {
    this.height = Math.max(1, Math.floor(height) || 1);
    this.live = true;
    this.top = 0; // LIVE değilken görünür ilk satırın mutlak indeksi
  }

  setHeight(height) {
    const h = Math.max(1, Math.floor(height) || 1);
    this.height = h;
  }

  #maxTop(total) {
    return Math.max(0, total - this.height);
  }

  #clampTop(total) {
    this.top = Math.max(0, Math.min(this.top, this.#maxTop(total)));
  }

  // En alta değiyor muyuz? (LIVE'a dönüş koşulu)
  #atBottom(total) {
    return this.top >= this.#maxTop(total);
  }

  lineUp(total) {
    this.#enterScroll(total);
    this.top = Math.max(0, this.top - 1);
  }

  lineDown(total) {
    this.#enterScroll(total);
    this.top = Math.min(this.#maxTop(total), this.top + 1);
    if (this.#atBottom(total)) this.live = true;
  }

  pageUp(total) {
    this.#enterScroll(total);
    this.top = Math.max(0, this.top - this.height);
  }

  pageDown(total) {
    this.#enterScroll(total);
    this.top = Math.min(this.#maxTop(total), this.top + this.height);
    if (this.#atBottom(total)) this.live = true;
  }

  // End → en son log / LIVE modu.
  toLive() {
    this.live = true;
  }

  // LIVE'dan scroll'a geçiş: mevcut LIVE konumunu (dip) başlangıç top'u yap, sonra kaydır.
  #enterScroll(total) {
    if (this.live) {
      this.top = this.#maxTop(total);
      this.live = false;
    } else {
      this.#clampTop(total);
    }
  }

  // Görünür aralık. LIVE ise dibe sabitlenir; değilse top clamp'lenir (buffer büyümüş olabilir).
  view(total) {
    const t = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
    let start;
    if (this.live) {
      start = this.#maxTop(t);
    } else {
      this.#clampTop(t);
      start = this.top;
      // scroll sırasında dibe temas edip etmediğini yansıt (LIVE'a dönüş olmadan gösterge)
    }
    const end = Math.min(t, start + this.height);
    return {
      start,
      end,
      live: this.live,
      atTop: start === 0,
      atBottom: end >= t,
    };
  }

  get isLive() {
    return this.live;
  }
}

module.exports = { LogViewport };
