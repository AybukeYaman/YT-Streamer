// Dosya mtime okuma — application katmanı fs'i tanımaz (EncoderHeartbeatCheck bunu
// enjekte alır). Dosya yoksa null: "hiç yayın yapılmamış" ile "okuma hatası" ayrı şeyler,
// ikincisi fırlatılır ki izleyici sayacı artırmasın (hata kanıt değildir).
const fs = require('fs');

function readMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Park işareti (.env.<isim>.disabled) gibi "var mı?" sorularına cevap. Hata YUTULUR:
// işareti okuyamamak izlemeyi durdurmamalı, en kötü hâlde park edilmemiş sayılır.
function fileExists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

module.exports = { readMtimeMs, fileExists };
