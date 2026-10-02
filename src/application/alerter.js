// Bildirim sözleşmesi: application katmanı "nasıl" gönderildiğini bilmez (ntfy, Telegram,
// e-posta), yalnızca "haber ver" der. Encoder sözleşmesiyle aynı gerekçe.
//
// ASLA ATMAMALI: bildirim kanalı bozuksa izleme sürmeli. Çağıran yine de try/catch ile
// sarıyor (HealthMonitor), ama implementasyonlar da kendi hatalarını yutar — bir webhook
// 500'ü yüzünden sağlık izlemesinin durması kabul edilemez.
class Alerter {
  // { level: 'info' | 'error', title, message }
  async alert() {
    throw new Error('Alerter.alert implement edilmedi');
  }
}

// Bildirim kanalı yapılandırılmadığında kullanılır: her şey yalnızca log'a gider
// (bugünkü davranış). Null nesne, çağıranda "alerter var mı?" dalı açmamak için.
class NullAlerter extends Alerter {
  async alert() {}
}

module.exports = { Alerter, NullAlerter };
