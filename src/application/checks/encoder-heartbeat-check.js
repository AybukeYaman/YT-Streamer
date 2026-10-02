// Kontrol: encoder (yt-streamer) hâlâ yayın yapıyor mu?
//
// 1 Ekim olayı: servis durduruldu ve ~2 saat fark edilmeden öyle kaldı. Hiçbir alarm
// yoktu — süreç durması bir "failure" olmadığı için systemd de haber vermiyor
// (OnFailure= yalnızca çökmeyi yakalar, elle stop'u yakalamaz).
//
// KALP ATIŞI OLARAK state.json: stream-orchestrator her progress tikinde (5 sn)
// stateStore.save() çağırıyor, yani dosyanın mtime'ı canlı yayının nabzıdır. Yeni bir
// yazma yolu EKLENMEDİ — ikinci bir kalp atışı dosyası, iki yerde bakım ve sessiz
// tutarsızlık riski demekti. Bu kontrolün yakaladıkları:
//   - servis durdurulmuş / disable edilmiş (yazma durur)
//   - süreç çökmüş, crash-loop'ta (yazma durur ya da seyrekleşir)
//   - node ayakta ama ffmpeg ölü (progress gelmez → save çağrılmaz)
//
// maxAgeMs 120 sn: progress tiki 5 sn, yani 24 kaçan tik. Albüm geçişindeki restart
// boşluğu ~225 ms (Faz 3.1 ölçümü) ve soğuk başlangıç ~450 ms — eşik bunların kat kat
// üstünde, yanlış alarm vermez.
const DEFAULT_MAX_AGE_MS = 120000;

class EncoderHeartbeatCheck {
  // readMtimeMs: (path) => number | null  — dosya yoksa null (fs application'a girmez)
  constructor({ statePath, readMtimeMs, now = () => Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS }) {
    this.statePath = statePath;
    this.readMtimeMs = readMtimeMs;
    this.now = now;
    this.maxAgeMs = maxAgeMs;
  }

  get name() {
    return 'encoder';
  }

  async run() {
    const mtime = this.readMtimeMs(this.statePath);
    // Dosya hiç yok: bu kurulumda yayın hiç başlatılmamış. Alarm DEĞİL — yeni VPS'te ya
    // da bilerek kapatılmış bir instance'ta her dakika bildirim göndermek anlamsız.
    if (mtime === null) {
      return { status: 'skipped', message: `durum dosyası yok (${this.statePath}) — yayın hiç başlamamış` };
    }
    const ageMs = this.now() - mtime;
    const ageSeconds = Math.round(ageMs / 1000);
    if (ageMs <= this.maxAgeMs) {
      return { status: 'healthy', message: `encoder ${ageSeconds} sn önce yazdı`, detail: { ageSeconds } };
    }
    const dakika = Math.round(ageMs / 60000);
    return {
      status: 'unhealthy',
      message:
        `ENCODER DURMUŞ: ${this.statePath} ${dakika} dk (${ageSeconds} sn) güncellenmedi — ` +
        'yayın akmıyor. Kontrol: bash scripts/deploy/status.sh — gerekirse ' +
        'systemctl restart yt-streamer',
      detail: { ageSeconds },
    };
  }
}

module.exports = { EncoderHeartbeatCheck, DEFAULT_MAX_AGE_MS };
