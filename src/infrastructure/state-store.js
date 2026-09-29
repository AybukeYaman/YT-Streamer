// Çalan playlist'in konumunu diske yazar: süreç öldürülüp (kill, elektrik, terminal kapanması)
// yeniden başlatıldığında orchestrator kaldığı parçadan devam edebilsin.
//
// Süreç içi çökmede buna gerek yok — Supervisor zaten orchestrator'ın bellekteki durumuyla
// resume() eder (bkz. StreamOrchestrator). Bu dosya yalnızca sürecin tamamen gittiği hali
// kurtarır: bellekte hiçbir şey kalmaz, tek bilgi kaynağı disktir.
//
// Yazma atomik (.tmp → rename): kill tam yazma anına denk gelse bile dosya ya eski ya yeni
// halidir, yarım JSON okunmaz. Bozuk/eski bir dosya yine de yayını engellememeli —
// load() hatayı yutup null döner, yayın sıfırdan başlar.
const fs = require('fs');

class StateStore {
  // file: mutlak yol (runtime/state.json); writeFile: atomik yazma
  constructor({ file, writeFile, log }) {
    this.file = file;
    this.writeFile = writeFile;
    this.log = log;
  }

  // { album, trackPaths, elapsedSeconds } — parçalar yol olarak saklanır; başlık ve süre
  // yeniden başlarken albüm deposundan (ffprobe önbelleği) gelir, burada kopyalanmaz.
  save(state) {
    try {
      this.writeFile(this.file, JSON.stringify(state));
    } catch (err) {
      // Durum yazılamazsa yayın sürmeli: sadece "kaldığı yerden devam" özelliği kaybedilir.
      this.log.warn(`durum yazılamadı: ${err.message}`);
    }
  }

  // Okunamayan, bozuk ya da beklenen alanları taşımayan dosya → null (yayın sıfırdan).
  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`durum okunamadı: ${err.message}`);
      return null;
    }
    let state;
    try {
      state = JSON.parse(text);
    } catch (err) {
      this.log.warn(`durum dosyası geçerli JSON değil, yoksayılıyor: ${err.message}`);
      return null;
    }
    if (typeof state?.album !== 'string' || !Array.isArray(state.trackPaths) || !state.trackPaths.length
      || typeof state.elapsedSeconds !== 'number' || !Number.isFinite(state.elapsedSeconds)) {
      this.log.warn('durum dosyası beklenen alanları taşımıyor, yoksayılıyor');
      return null;
    }
    return state;
  }

  clear() {
    try {
      fs.rmSync(this.file, { force: true });
    } catch (err) {
      this.log.warn(`durum silinemedi: ${err.message}`);
    }
  }
}

module.exports = { StateStore };
