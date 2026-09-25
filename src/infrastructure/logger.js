// Konsola ve runtime/logs/stream-YYYY-MM-DD.log'a yazan basit logger.
// Dosya adı her yazımda o anki tarihten hesaplanır — gece yarısı yeni güne kendiliğinden geçer.
//
// Rotasyon (Faz 5.3): günün dosyası maxBytes'ı (50 MB) geçecekse döndürülür —
// stream-D.log → stream-D.1.log (eski .1 → .2 …), yeni satır boş stream-D.log'a gider.
// Saklama klasörün tamamına uygulanır: en yeni maxFiles (5) log dosyası kalır, fazlası
// silinir (günlük dosyalar da sayılır) → disk üst sınırı ≈ maxFiles × maxBytes.
// Not: 50 drawtext'li tek ffmpeg komut satırı ~15 KB (her restart'ta bir kez) — eşik
// bu yüzden düşürülmedi, sadece biraz daha hızlı yaklaşılıyor.
//
// Düzeyler: debug (sadece dosya), info, warn, error (konsol + dosya).
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const LOG_FILE = /^stream-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;

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
  constructor({
    dir, scope = 'main', now = () => new Date(), out = console, sink,
    maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES,
  }) {
    this.scope = scope;
    // file/size: şu an yazılan dosya ve bilinen boyutu — her satırda stat yapmamak için.
    this.sink = sink || { dir, now, out, fileDisabled: false, maxBytes, maxFiles, file: null, size: 0 };
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
      this.#appendToFile(this.fileFor(d), line + '\n');
    } catch (err) {
      // Log dosyası yazılamıyor diye yayın durmamalı: bir kez uyar, konsola devam et.
      this.sink.fileDisabled = true;
      out.error(`${localTimestamp(d)} [ERROR] [logger] log dosyasına yazılamıyor (${err.message}), sadece konsol kullanılacak`);
    }
  }

  #appendToFile(file, text) {
    const sink = this.sink;
    const bytes = Buffer.byteLength(text);
    if (sink.file !== file) {
      // Yeni gün ya da ilk yazım: dosya önceki çalıştırmadan kalmış olabilir.
      sink.file = file;
      const exists = fs.existsSync(file);
      sink.size = exists ? fs.statSync(file).size : 0;
      this.#prune(exists ? 0 : 1); // oluşturulacak dosya da sayıya dahil
    }
    // Boş dosyayı döndürme: tek satır eşikten büyükse yine de yazılır.
    if (sink.size > 0 && sink.size + bytes > sink.maxBytes) {
      this.#rotate(file);
      sink.size = 0;
    }
    fs.appendFileSync(file, text);
    sink.size += bytes;
  }

  // stream-D.log → .1, .1 → .2 … (en eskiden başlayarak kaydır), sonra saklama sınırı.
  #rotate(file) {
    const base = file.slice(0, -'.log'.length);
    let n = 1;
    while (fs.existsSync(`${base}.${n}.log`)) n++;
    for (let i = n; i > 1; i--) fs.renameSync(`${base}.${i - 1}.log`, `${base}.${i}.log`);
    fs.renameSync(file, `${base}.1.log`);
    this.#prune(1); // yazılacak yeni stream-D.log için yer ayır
  }

  // En yeni maxFiles dosya kalır. Sıra addan: tarih yeniden eskiye, aynı gün içinde
  // stream-D.log (en yeni) → .1 → .2 … (mtime değil — hızlı yazımlarda eşit olabiliyor).
  #prune(reserve = 0) {
    const { dir, maxFiles } = this.sink;
    const logs = fs.readdirSync(dir)
      .map((name) => ({ name, m: LOG_FILE.exec(name) }))
      .filter((f) => f.m)
      .sort((a, b) => b.m[1].localeCompare(a.m[1]) || Number(a.m[2] || 0) - Number(b.m[2] || 0));
    for (const f of logs.slice(Math.max(0, maxFiles - reserve))) fs.rmSync(path.join(dir, f.name));
  }
}

module.exports = { Logger };
