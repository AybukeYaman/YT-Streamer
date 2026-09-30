// Aktif broadcast'in kaydı (runtime/broadcast.json). İdempotansın tek bilgi kaynağı:
// dosyada canlı bir broadcast varsa go-live yeni insert YAPMAZ.
//
// Neden diskte: yayın süreci gibi go-live servisi de restart olabilir (Restart=always) ve
// bellekteki kayıt gider. Kayıt olmazsa her tetik yeni broadcast yaratır — kanalda çöp
// yayınlar, kota (10.000 birim/gün) tükenir. Ayrıntı: KARARLAR.md
//
// StateStore'dan AYRI dosya: farklı ömür (broadcast günlerce yaşar, playlist konumu
// saniyelerde değişir) ve farklı yazar (go-live servisi vs yayın süreci). Aynı dosyaya
// iki süreç yazarsa son yazan diğerini siler.
//
// Yazma atomik (.tmp → rename): yazma anında ölüm yarım JSON bırakmaz. Bozuk dosya
// go-live'ı engellememeli — load() null döner, akış "aktif broadcast yok" gibi sürer
// (o durumda yeni insert yapılır; bilinçli tercih: yayının canlıya geçmesi, çöp
// broadcast riskinden önce gelir).
const fs = require('fs');

class BroadcastStateStore {
  // file: mutlak yol; writeFile: atomik yazma; log: { warn }
  constructor({ file, writeFile, log }) {
    this.file = file;
    this.writeFile = writeFile;
    this.log = log;
  }

  // { broadcastId, streamId, status, title, createdAt, wentLiveAt }
  save(state) {
    this.writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }

  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`broadcast durumu okunamadı: ${err.message}`);
      return null;
    }
    let state;
    try {
      state = JSON.parse(text);
    } catch (err) {
      this.log.warn(`broadcast durumu geçerli JSON değil, yoksayılıyor: ${err.message}`);
      return null;
    }
    if (typeof state?.broadcastId !== 'string' || state.broadcastId === '') {
      this.log.warn('broadcast durumu broadcastId taşımıyor, yoksayılıyor');
      return null;
    }
    return state;
  }

  clear() {
    try {
      fs.rmSync(this.file, { force: true });
    } catch (err) {
      this.log.warn(`broadcast durumu silinemedi: ${err.message}`);
    }
  }
}

module.exports = { BroadcastStateStore };
