// Konsola ve runtime/logs/stream-YYYY-MM-DD.log'a yazan basit logger.
// Dosya adı her yazımda o anki tarihten hesaplanır — gece yarısı yeni güne kendiliğinden geçer.
// Rotasyon/boyut sınırı yok (Faz 5.3'ün işi).
//
// Düzeyler: debug (sadece dosya), info, warn, error (konsol + dosya).
const fs = require('fs');
const path = require('path');

const pad = (n, w = 2) => String(n).padStart(w, '0');

function localDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 2026-09-24 00:45:12.345 — yerel saat (yayın takibi yerel saatle yapılıyor)
function localTimestamp(d) {
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

class Logger {
  // sink: child logger'ların paylaştığı ortak durum (dizin, saat, çıktı, dosya yazılabilir mi).
  constructor({ dir, scope = 'main', now = () => new Date(), out = console, sink }) {
    this.scope = scope;
    this.sink = sink || { dir, now, out, fileDisabled: false };
    if (!sink) fs.mkdirSync(dir, { recursive: true });
  }

  // Aynı dosyaya ve ayarlara yazan, farklı kapsam etiketli logger.
  child(scope) {
    return new Logger({ scope, sink: this.sink });
  }

  fileFor(date) {
    return path.join(this.sink.dir, `stream-${localDate(date)}.log`);
  }

  debug(message) { this.#write('DEBUG', message, false); }
  info(message) { this.#write('INFO', message, true); }
  warn(message) { this.#write('WARN', message, true); }
  error(message) { this.#write('ERROR', message, true); }

  #write(level, message, toConsole) {
    const { now, out } = this.sink;
    const d = now();
    const line = `${localTimestamp(d)} [${level}] [${this.scope}] ${message}`;
    if (toConsole) (level === 'ERROR' || level === 'WARN' ? out.error : out.log)(line);
    if (this.sink.fileDisabled) return;
    try {
      fs.appendFileSync(this.fileFor(d), line + '\n');
    } catch (err) {
      // Log dosyası yazılamıyor diye yayın durmamalı: bir kez uyar, konsola devam et.
      this.sink.fileDisabled = true;
      out.error(`${localTimestamp(d)} [ERROR] [logger] log dosyasına yazılamıyor (${err.message}), sadece konsol kullanılacak`);
    }
  }
}

module.exports = { Logger };
