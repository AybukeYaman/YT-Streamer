// Encoder sözleşmesi. Application katmanı (StreamOrchestrator) sadece bunu bilir;
// somut implementasyon (FfmpegEncoder) infrastructure'da yaşar ve bu sınıfı genişletir.
//
// Olaylar:
//   'log'  (entry)         — entry.kind: 'command' | 'progress' | 'stderr' | 'error'
//   'exit' (code, signal)  — süreç bitti; code null ise sinyalle ya da başlatılamadan bitti
const { EventEmitter } = require('events');

class Encoder extends EventEmitter {
  // options — ses girişi, iki moddan biri. Zaten çalışıyorsa hata fırlatır.
  //   { audioPath }               tek parça
  //   { playlistPath, runNumber } playlist (bitince code=0 ile kapanır); runNumber kaçıncı tur
  //                               olduğunu belirtir (local çıktı dosyasını ayırmak için)
  //   backgroundPath (opsiyonel)  bu çalıştırmanın arkaplanı (albüm başına); verilmezse
  //                               encoder kurulurken verilen kullanılır
  //   overlayTexts (opsiyonel)    [{ textFile, start, end }] — parça başına ekran yazısı;
  //                               start ≤ t < end saniyelerinde görünür, end null ise sona kadar
  start(options) {
    throw new Error(`${this.constructor.name}.start() implement edilmemiş`);
  }

  // Encoder'ı durdurur; süreç tamamen kapandığında resolve olan bir Promise döner.
  stop() {
    throw new Error(`${this.constructor.name}.stop() implement edilmemiş`);
  }

  // Kademesiz, anında öldürme (donma bekçisi için): süreç 'q'ya cevap vermiyorsa beklemenin
  // anlamı yok. 'exit' olayı normal yoldan gelir; orkestratör bunu beklenmeyen kapanış sayar,
  // yeniden başlatma kararı supervisor'dadır. Çalışan süreç yoksa sessizce hiçbir şey yapmaz.
  kill() {
    throw new Error(`${this.constructor.name}.kill() implement edilmemiş`);
  }
}

module.exports = { Encoder };
