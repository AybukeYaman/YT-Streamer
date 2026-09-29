// Sabit boyutlu (ring) log tamponu. Logger'ın `out` arayüzünü (log/error) uygular; böylece
// TUI modunda loglar konsol yerine buraya yazılır (panel bozulmaz) ve TUI son satırları
// buradan okur. Logger dosyaya yazmayı ayrıca sürdürür — bu tampon yalnızca ekran içindir.
//
// Logger düzey eşlemesi (bkz. logger.js #write): INFO → out.log, WARN/ERROR → out.error.
class LogBuffer {
  constructor({ capacity = 200 } = {}) {
    this.capacity = Math.max(1, capacity);
    this.entries = []; // { level: 'info' | 'error', text: string }
    // Logger, sink metodunu receiver'sız çağırır: `(cond ? out.error : out.log)(line)`.
    // console bu şekilde çalışır; LogBuffer da bir console yerine geçtiği için log/error
    // bağlamsız çağrıya dayanıklı olmalı — this kaybolmasın diye bind ediyoruz.
    this.log = this.log.bind(this);
    this.error = this.error.bind(this);
  }

  #push(level, text) {
    this.entries.push({ level, text: String(text) });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  // Console uyumlu arayüz — Logger bu iki metodu (bazen bağlamsız) çağırır.
  log(line) { this.#push('info', line); }
  error(line) { this.#push('error', line); }

  // Son `limit` satır (en yeni sonda). limit <= 0 ise boş dizi.
  recent(limit = 10) {
    if (limit <= 0) return [];
    return this.entries.slice(-limit);
  }
}

module.exports = { LogBuffer };
