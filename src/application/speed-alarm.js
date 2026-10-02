// Encode hızı eşik dışına çıktığında bildirim gönderen alarm. Saf mantık — I/O yok,
// zamanı ve bildirim kanalını dışarıdan alır.
//
// NEDEN GEREKLİ: SpeedWindow'un 'slow'/'fast' durumunun tek tüketicisi bir log satırıydı.
// Encode 0.8x'e düşse bile ffmpeg ilerleme basmaya devam ettiği için state.json yazılıyor →
// encoder kalp atışı SAĞLIKLI, ingest SAĞLIKLI, ölü adam anahtarı yeşil. İzleyici kekeleyen
// bir yayın görürken panelde her şey yolunda görünüyordu. Mevcut kontrol setinin kör noktası.
//
// NEDEN HealthMonitor'A KONTROL OLARAK EKLENMEDİ: hız verisi yayın sürecinde (yt-streamer),
// HealthMonitor ise go-live sürecinde (yt-golive) çalışıyor. Veriyi state.json'a yeni bir
// alan koyup süreçler arası taşımak İKİNCİ bir dosya sözleşmesi demekti — encoder kalp
// atışında "ikinci kalp atışı dosyası eklenmedi" denmesinin aynı gerekçesi.
//
// BEKLEME PENCERESİ (dwellMs) ŞART: eşik (0.95) civarında salınan bir hız, her geçişte
// bildirim gönderse telefon susmazdı. Anormal durum dwellMs boyunca KESİNTİSİZ sürmeden
// alarm verilmez; 'ok'a dönünce — yalnızca alarm gönderilmişse — bir "düzeldi" bildirimi gider.
const DEFAULT_DWELL_MS = 60000;

const ABNORMAL = {
  slow: (avg, status) => `ENCODE YETİŞEMİYOR: hız ${avg} (eşik ${status.low}) — ffmpeg gerçek zamanın `
    + 'gerisinde kalıyor, yayın kekeliyor olabilir. CPU yükünü kontrol et; gerekirse '
    + 'profile.preset düşürülmeli (KARARLAR.md: bitrate artışı ilk geri alınacak ayar).',
  fast: (avg, status) => `ANORMAL ENCODE HIZI: hız ${avg} (eşik ${status.high}) — ses girişi `
    + 'beklenenden hızlı tüketiliyor, sessiz arıza olabilir (bozuk parça süresi, -re çalışmıyor).',
};

const format = (average) => (average === null ? 'bilinmiyor' : `${average.toFixed(3)}x`);

class SpeedAlarm {
  // alerter: { alert({ level, title, message }) }; log: { info, warn }
  // dwellMs: anormal durumun alarm için kesintisiz sürmesi gereken süre
  constructor({ alerter, log, dwellMs = DEFAULT_DWELL_MS }) {
    this.alerter = alerter;
    this.log = log;
    this.dwellMs = dwellMs;
    this.abnormalState = null; // 'slow' | 'fast' — hangi anormallik sürüyor
    this.abnormalSince = null;
    this.alerted = false;
  }

  // status: SpeedWindow.status() çıktısı + penceredeki eşikler ({ state, average, low, high }).
  // Her ilerleme satırında çağrılır: bekleme penceresi zamanın ilerlemesiyle dolar.
  update(status, now) {
    // 'warming': ölçüm YOK (yeni ffmpeg süreci, ilk 30 sn). Bekleme penceresi sıfırlanır —
    // playlist sınırındaki restart'tan önce birikmiş süre yeni sürece yazılmasın, yoksa
    // restart sonrası ilk anormal örnek anında alarm verirdi. Gönderilmiş alarm DURUR:
    // yeni süreç gerçekten düzeldiyse bunu 'ok' örneği söyleyecek.
    if (status.state === 'warming') {
      this.abnormalState = null;
      this.abnormalSince = null;
      return;
    }
    if (status.state === 'ok') return this.#onNormal(status);
    return this.#onAbnormal(status, now);
  }

  #onNormal(status) {
    this.abnormalState = null;
    this.abnormalSince = null;
    if (!this.alerted) return;
    this.alerted = false;
    const message = `encode hızı normale döndü: ${format(status.average)}`;
    this.log.info(message);
    this.#notify({ level: 'info', title: 'encode hızı düzeldi', message });
  }

  #onAbnormal(status, now) {
    // Farklı bir anormallik (slow → fast) BAŞKA bir arıza: pencere baştan sayılır.
    if (this.abnormalState !== status.state) {
      this.abnormalState = status.state;
      this.abnormalSince = now;
      return;
    }
    if (this.alerted || now - this.abnormalSince < this.dwellMs) return;
    this.alerted = true;
    const seconds = Math.round((now - this.abnormalSince) / 1000);
    const message = `${ABNORMAL[status.state](format(status.average), status)} (${seconds} sn sürüyor)`;
    this.log.warn(message);
    this.#notify({ level: 'error', title: 'YAYIN SORUNU: encode hızı', message });
  }

  // Bildirim ASLA yayını etkilemez: bu metot ilerleme satırı işlenirken çağrılıyor.
  // Bilerek await EDİLMEZ — bir webhook isteği encode döngüsünün log/durum yazımını bekletmemeli.
  #notify(payload) {
    Promise.resolve()
      .then(() => this.alerter.alert(payload))
      .catch((err) => this.log.warn(`bildirim gönderilemedi (${err.message}) — yayın etkilenmedi`));
  }
}

module.exports = { SpeedAlarm, DEFAULT_DWELL_MS };
