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

module.exports = { readMtimeMs };
