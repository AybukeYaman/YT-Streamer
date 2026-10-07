// Kontrol: diskte yer kaldı mı?
//
// Neden var: disk dolduğunda yayının verdiği ilk belirti anlamsız bir ffmpeg çökmesi
// oluyor — log satırı "Conversion failed" ya da bir I/O hatası, sebebi görünmüyor.
// Supervisor yeniden başlatır, aynı duvara çarpar, döngüye girer. Diğer kontrollerin
// hiçbiri bu durumu göremiyor: ingest sağlıklı (yayın henüz ölmedi), kalp atışı geliyor.
//
// Albümler büyüdükçe ve her yeni albüm VPS'e taşındıkça bu gerçek bir risk: paket
// başına ~350 MB, birkaç albüm küçük bir VPS diskini bitirir.
//
// Eşik MUTLAK (GB), yüzde değil: yayının ihtiyacı sabit (log + geçici dosyalar),
// diskin toplam boyutuyla orantılı değil. 100 GB'lık diskte %5 bol, 20 GB'lıkta dar.
const fs = require('fs');

const DEFAULT_MIN_FREE_GB = 2;
const GB = 1024 ** 3;

class DiskCheck {
  // path: boş alanı ölçülecek dizin (yayının yazdığı yer — runtime)
  // minFreeGb: altına inilince sağlıksız sayılacak eşik
  // statfs: testlerde sahte verilir
  constructor({ path, minFreeGb = DEFAULT_MIN_FREE_GB, statfs = (p) => fs.promises.statfs(p) }) {
    if (typeof path !== 'string' || path.trim() === '') throw new Error('DiskCheck: path gerekli');
    if (!Number.isFinite(minFreeGb) || minFreeGb <= 0) {
      throw new Error(`DiskCheck: minFreeGb pozitif olmalı (${minFreeGb})`);
    }
    this.path = path;
    this.minFreeGb = minFreeGb;
    this.statfs = statfs;
  }

  get name() {
    return 'disk';
  }

  async run() {
    let stats;
    try {
      stats = await this.statfs(this.path);
    } catch (err) {
      // Ölçememek sağlıksızlık değil: disk dolu olduğu için değil, yol yanlış ya da
      // platform desteklemiyor olabilir. Alarm üretip gerçek sorunları gölgelemesin.
      return { status: 'skipped', message: `boş alan okunamadı: ${err.message}` };
    }

    const freeBytes = stats.bavail * stats.bsize;
    const totalBytes = stats.blocks * stats.bsize;
    const freeGb = freeBytes / GB;
    const percentFree = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;
    const detail = {
      freeGb: +freeGb.toFixed(2),
      totalGb: +(totalBytes / GB).toFixed(2),
      percentFree: +percentFree.toFixed(1),
      minFreeGb: this.minFreeGb,
    };
    const summary = `${detail.freeGb} GB boş (%${detail.percentFree})`;

    if (freeGb >= this.minFreeGb) return { status: 'healthy', message: summary, detail };
    return {
      status: 'unhealthy',
      message:
        `DİSK DOLUYOR: ${summary}, eşik ${this.minFreeGb} GB. Disk tamamen dolarsa ffmpeg ` +
        'sebebi görünmeyen bir hatayla çöker ve yeniden başlatma döngüsüne girer. ' +
        'Düzeltme: eski log ve çıktı dosyalarını temizle, kullanılmayan albümleri kaldır.',
      detail,
    };
  }
}

module.exports = { DiskCheck, DEFAULT_MIN_FREE_GB };
