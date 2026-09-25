# Faz 1 — Gerçek RTMP Testi (Claude Code Prompt)

> `PROMPTLAR\faz-1-rtmp-testi.md` olarak kaydet, aşağıdaki bölümü Claude
> Code'a ver.

---

## PROMPT BAŞLANGICI

### Önemli fark: bu fazda tam otonom ilerlenemez

YouTube Studio'daki bağlantı durumunu izlemek ve ağ kopması testinde
Wi-Fi'ı kapatmak **kullanıcının elle yapması gereken şeyler** — bunları
sen göremiyor ve yapamıyorsun. İki noktada (Adım 3 ve Adım 4) açıkça
"kullanıcıdan onay/bilgi bekle" diyeceğim, orada gerçekten dur. Geri
kalanında otonom ilerle.

**Proje kökü:** `C:\Users\Aybuke Yeni\Desktop\Youtube\YT Stream System`

**Stream key güvenliği:** Kullanıcı `.env` dosyasını kendisi düzenleyip
gerçek `YOUTUBE_STREAM_KEY` değerini oraya yazacak. Sen bu değeri hiçbir
log satırında, commit mesajında ya da rapor metninde tam olarak yazma —
zaten `FfmpegEncoder`'daki maskeleme bunu koruyor, ama ekstra dikkat et.

---

### Adım 1 — Hazırlık

1. `.env` dosyasının var olduğunu ve `YOUTUBE_STREAM_KEY`'in dolu
   olduğunu kontrol et (değeri okuma/yazdırma, sadece boş olup
   olmadığına bak)
2. `config.json`'da geçici test ayarları:
   - `output.mode: "rtmp"`
   - `queue.batchSize`: geçici olarak düşük bir değere (örn. 3) çek —
     bu testte hem R2 (restart) hem de sürdürülebilir bağlantıyı aynı
     oturumda gözlemlemek için. Üretim değeri (50) teste sonra geri
     dönecek
3. Upload hızını hatırlat (kullanıcı daha önce ölçmüştü, PLAN.md Faz
   0'da) — bağlantı yetersizse test anlamsız olur

**Bu adım bitince dur ve rapor ver.**

---

### Adım 2 — Yayını başlat

1. `node index.js` ile yayını başlat (arka planda, log dosyasına
   yazacak şekilde)
2. İlk 30 saniye içinde ffmpeg'in RTMPS bağlantısını kurduğunu (hata
   vermeden ilerlediğini) logdan doğrula
3. Bana haber ver: "Yayın başladı, YouTube Studio'da kontrol edebilirsin"

**Bu adım bitince dur ve rapor ver — sıradaki adım kullanıcı etkileşimi
gerektiriyor.**

---

### Adım 3 — [KULLANICI ETKİLEŞİMİ] Bağlantı durumu doğrulaması

**Bu adımda Claude Code otonom ilerlemez.** Kullanıcı YouTube Studio'yu
açıp canlı yayın bağlantı durumunu (Excellent/Good/Poor) kontrol
edecek ve buraya bildirecek. Claude Code bu sırada:

1. Log dosyasını izlemeye devam eder (speed penceresi, hata var mı)
2. Kullanıcıdan "Excellent görünüyor, devam" onayı gelince Adım 4'e geçer
3. Kullanıcı bir sorun bildirirse (bağlantı kurulamadı, "Bad" durumu vb.)
   dur, log'u paylaş, birlikte teşhis edelim

**10 dakikalık kesintisiz yayın + "Excellent" durumu** doğrulanana kadar
bekle — bu Faz 1'in temel kapanış kriteri.

---

### Adım 4 — R2 doğrulaması (planlı restart) ve [KULLANICI ETKİLEŞİMİ] ağ kopması testi

1. `batchSize=3` olduğu için birkaç dakika içinde doğal bir restart
   (playlist bitişi, `-shortest` ile `exit code=0`) gerçekleşecek —
   bunu logdan yakala
2. Restart anında **kullanıcıya haber ver**: "Restart oluyor, YouTube
   Studio'da ne görüyorsun?" — kısa bir donma/tamponlama mı, bağlantı
   kopması uyarısı mı, yoksa yayın tamamen mi sonlanıyor?
3. **[KULLANICI ETKİLEŞİMİ] Ağ kopması testi (5.5):** Kullanıcıdan
   Wi-Fi'ı ~30 saniyeliğine kapatıp tekrar açmasını iste (yayın
   sürerken, restart anıyla çakışmayan bir zamanda). Bu sırada:
   - Encoder'ın nasıl davrandığını logla (ffmpeg hata mı verdi, süreç
     kapandı mı, kaç saniye sonra)
   - Supervisor devreye girdiyse (gerçek çökme olarak algılandıysa)
     geri çekilme davranışını logla
   - Kullanıcıdan YouTube Studio'nun bu sırada ne gösterdiğini sor
     (yayın durdu mu, "reconnecting" mi gösterdi, devam mı etti)
4. Sonucu `KARARLAR.md`'deki R2 kararına göre değerlendir: YouTube kısa
   kopmayı tolere ediyorsa mevcut B yaklaşımı yeterli; **yayını
   tamamen sonlandırıyorsa** bunu açıkça belirt, C (named pipe)
   yaklaşımına dönme kararı sohbette verilecek

**Bu adım bitince dur ve rapor ver.**

---

### Adım 5 — Temizlik ve config'i üretim değerlerine döndür

1. Yayını temiz kapat (Ctrl+C / `stop()`)
2. **Kullanıcıya hatırlat:** YouTube Studio'da yayını da elle
   sonlandırması gerekiyor (kod tarafında durdurmak YouTube tarafındaki
   "canlı" durumunu otomatik kapatmaz)
3. `config.json`'ı geri al: `queue.batchSize` → 50. `output.mode`'u
   `"rtmp"` olarak bırak ya da `"local"`a döndür — bu kararı kullanıcıya
   sor (üretimde zaten RTMP gerekecek, ama geliştirme sırasında yanlışlıkla
   canlıya çıkmamak için "local" varsayılan daha güvenli olabilir)
4. Arkada kalan process kontrolü
5. Özet: 10 dakikalık test sonucu, R2 sonucu, ağ kopması testi sonucu,
   hız duraksaması gözlendi mi

**Raporu ver ve dur — commit, KARARLAR.md/PLAN.md güncellemesi ve
config.output.mode kararı sohbette verilecek.**

## PROMPT SONU

---

## Sonraki adım

Faz 1 gerçekten kapanınca PLAN.md ve KARARLAR.md güncellenir (özellikle
R2 sonucu — B yaklaşımı kesinleşir ya da C'ye dönülür). Sırada Faz 6
(opsiyonel) ya da Faz 7 (VPS) var.
