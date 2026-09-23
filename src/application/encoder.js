// Encoder sözleşmesi. Application katmanı (StreamOrchestrator) sadece bunu bilir;
// somut implementasyon (FfmpegEncoder) infrastructure'da yaşar ve bu sınıfı genişletir.
//
// Olaylar:
//   'log'  (entry)         — entry.kind: 'command' | 'progress' | 'stderr' | 'error'
//   'exit' (code, signal)  — süreç bitti; code null ise sinyalle ya da başlatılamadan bitti
const { EventEmitter } = require('events');

class Encoder extends EventEmitter {
  // options: { audioPath } — çalınacak ses girişi. Zaten çalışıyorsa hata fırlatır.
  start(options) {
    throw new Error(`${this.constructor.name}.start() implement edilmemiş`);
  }

  // Encoder'ı durdurur; süreç tamamen kapandığında resolve olan bir Promise döner.
  stop() {
    throw new Error(`${this.constructor.name}.stop() implement edilmemiş`);
  }
}

module.exports = { Encoder };
