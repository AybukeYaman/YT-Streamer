// Gizliliği çevrilmeyi bekleyen VOD'ların kuyruğu (runtime/vod-pending.json).
//
// NEDEN VAR: yayın bitince kayıt (VOD) herkese açık kalıyor; config.broadcast.vodPrivacy
// verilmişse unlisted'a çevrilmesi gerekiyor. Ama bu sistemde "yayın bitti" diye bir OLAY
// yok — transition('complete') hiç çağrılmıyor, yayınları YouTube kapatıyor. Bitiş ancak
// GoLiveService#existingBroadcast kayıtlı broadcast'in lifeCycleStatus'unu 'complete'
// görünce ANLAŞILIYOR, ve orası broadcast.json'ı SİLİYOR — id o anda kaybolur.
// Bu yüzden çevrilecek id, silinmeden önce buraya yazılır.
//
// NEDEN AYRI DOSYA (broadcast.json'a değil): o dosya tam da bu anda siliniyor, iş kaydı
// içinde yaşayamaz. Ayrıca ömürleri farklı — aktif broadcast kaydı her go-live'da
// değişir, bekleyen iş API hatası sürerse günlerce kalabilir.
//
// NEDEN DİSKTE: çevirme tek bir API çağrısı ve süreç (Restart=always) her an ölebilir.
// Bellekte tutulsa çökme o VOD'u sonsuza kadar public bırakırdı. Diskte kalınca sonraki
// periyodik tur onu bulup tekrar dener.
//
// Yazma atomik (.tmp → rename). Bozuk/okunamayan dosya akışı DURDURMAZ: boş liste
// döner ve uyarı loglanır — bir VOD'un gizliliği yüzünden go-live engellenmemeli.
// (Bedeli: o kayıtlar kaybolur, VOD public kalır. Elle düzeltilebilir bir durum;
// alternatifi yayının hiç açılmaması, bu daha kötü.)
const fs = require('fs');

class PendingVodStore {
  // file: mutlak yol; writeFile: atomik yazma; log: { warn }
  constructor({ file, writeFile, log }) {
    this.file = file;
    this.writeFile = writeFile;
    this.log = log;
  }

  // [{ broadcastId, title, discoveredAt }] — her zaman dizi döner.
  list() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`bekleyen VOD listesi okunamadı: ${err.message}`);
      return [];
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      this.log.warn(`bekleyen VOD listesi geçerli JSON değil, yoksayılıyor: ${err.message}`);
      return [];
    }
    if (!Array.isArray(data?.pending)) {
      this.log.warn('bekleyen VOD listesi "pending" dizisi taşımıyor, yoksayılıyor');
      return [];
    }
    // broadcastId'si olmayan kayıt işe yaramaz (çevrilecek video belli değil) — atılır.
    return data.pending.filter((e) => typeof e?.broadcastId === 'string' && e.broadcastId !== '');
  }

  // Kuyruğa ekler. Aynı broadcastId zaten varsa TEKRAR EKLENMEZ: aynı videoyu iki kez
  // çevirmek zararsız ama liste şişer ve her turda boşa API çağrısı yapılır.
  add({ broadcastId, title = null, discoveredAt }) {
    const current = this.list();
    if (current.some((e) => e.broadcastId === broadcastId)) return current;
    const next = [...current, { broadcastId, title, discoveredAt }];
    this.#write(next);
    return next;
  }

  // Çevirmesi BAŞARILI olanları düşürür. Başarısızlar kalır → sonraki tur tekrar dener.
  remove(broadcastIds) {
    const drop = new Set(broadcastIds);
    if (drop.size === 0) return this.list();
    const next = this.list().filter((e) => !drop.has(e.broadcastId));
    this.#write(next);
    return next;
  }

  #write(pending) {
    this.writeFile(this.file, `${JSON.stringify({ pending }, null, 2)}\n`);
  }
}

module.exports = { PendingVodStore };
