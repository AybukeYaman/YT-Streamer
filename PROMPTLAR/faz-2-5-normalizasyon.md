# Faz 2.5 — Ses Normalizasyonu (Claude Code Prompt)

> `PROMPTLAR\faz-2-5-normalizasyon.md` olarak kaydet, aşağıdaki bölümü
> Claude Code'a ver.

---

## PROMPT BAŞLANGICI

### Bağlam ve mimari notu

Bu script projenin çalışma zamanı (`src/domain`, `src/application`,
`src/infrastructure`) mimarisinin **parçası değil** — bir kerelik ön işleme
aracı. `scripts/normalize.js` altında, bağımsız ve tek dosyalık kalsın.
İleride Faz 3'te `TrackRepository`'nin okuduğu `music/` klasörünü bu script
üretecek.

**Neden bu faz gerekli:** PLAN.md'deki araştırmaya göre ffmpeg'in concat
demuxer'ı farklı parametreli (codec/sample rate/kanal) parçalarda ya hata
veriyor ya da sessizce bozuk çıktı üretiyor (bu Faz 3.1 deneyinde test
edilmedi — deneydeki 5 dosya bilerek birebir aynı parametredeydi). Bu
yüzden yayına giren tüm parçaların aynı parametrede olması zorunlu,
opsiyonel değil.

**Klasör sözleşmesi:**
- `raw/` — ham parçalar (Suno çıktıları vb.) buraya elle kopyalanır,
  script bu klasörü **değiştirmez**, sadece okur
- `music/` — normalize edilmiş çıktı, canlı yayının okuyacağı klasör
- Her iki klasör de proje kökünde, henüz yoksa oluşturulacak

**Proje kökü:** `C:\Users\Aybuke Yeni\Desktop\Youtube\YT Stream System`

Kurallar:
- Her adımı sırayla yap, bitmeden diğerine geçme
- Her adım sonunda ne yaptığını raporla
- Kod yazmadan önce mevcut durumu kontrol et

---

### Adım 1 — İskelet ve klasörler

1. `raw/` ve `music/` klasörlerini proje kökünde oluştur (yoksa)
2. `raw/` içine `.gitkeep` koy, `.gitignore`'a şunları ekle:
   ```
   raw/*
   !raw/.gitkeep
   music/*
   !music/.gitkeep
   ```
   (`!` satırları olmadan `.gitkeep` de dışarıda kalır ve klasör repoda
   hiç görünmez). Proje kökünün gerçekten bir git reposu olup olmadığını
   kontrol et (`YT-Streamer\` altında mı, yoksa proje kökünün kendisi mi) —
   değilse `.gitignore` şimdilik hiçbir şeyi etkilemez, bunu raporla ama
   yine de dosyayı oluştur (repo ileride kurulacak).
3. `scripts/normalize.js` dosyasının iskeletini oluştur:
   - Hedef parametreler sabit olarak tanımlansın: `48000 Hz, 2 kanal, AAC,
     192 kbps, loudnorm hedefi -14 LUFS (TP -1.5, LRA 11)`
   - `raw/` ve `music/` yolları config'den değil, dosyanın başında sabit
     olarak tanımlansın (bu araç tek seferlik, ayrı config dosyasına gerek yok)

**Bu adım bitince dur ve rapor ver.**

---

### Adım 2 — Analiz (dokunmadan önce gör)

Önce hiçbir dosyayı değiştirmeden, sadece raporla:

1. `raw/` klasöründeki tüm ses dosyalarını listele
2. Her biri için `ffprobe` ile mevcut parametreleri oku: sample rate,
   kanal sayısı, codec, süre, entegre loudness (varsa)
3. Bunları bir tabloda göster — hangileri zaten hedef parametrede, hangileri
   değil

**Bu adım bitince dur ve rapor ver.** Dosya sayısı çoksa (50+), önce
5 dosyalık bir örnekle devam et ve onay bekle.

---

### Adım 3 — Normalize işlemi

Her dosya için doğrusal kazanç + ayrı true-peak limiter kullan (Adım 2'nin
analiz sonucuna göre: bu 30 dosyada loudnorm'un `linear=true` modu geçerli
koşulu sağlamıyor — kazanç uygulandıktan sonra peak hedef true-peak'in
üstünde kalıyor, bu da loudnorm'u sessizce dinamik moda düşürüp parça
boyunca dinamiği bozuyor; bunu önlemek için kazanç ve limitleme ayrı
adımlar olarak uygulanacak):

1. **Ölçüm geçişi:** `loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json` ile
   ölç, `input_i` değerini al
2. **Kazanç hesabı:** `gain_db = -14 - input_i` (sabit, dosya boyunca
   değişmeyen bir kazanç — bu adım dinamiği bozmaz, sadece seviyeyi
   kaydırır)
3. **Uygulama geçişi:**
   `-ar 48000 -ac 2 -af "volume=${gain_db}dB,alimiter=limit=0.841:level=false" -c:a aac -b:a 192k`
   - `volume=${gain_db}dB` → hesaplanan sabit kazancı uygular
   - `alimiter=limit=0.841` → yaklaşık -1.5 dBTP'ye karşılık gelen
     doğrusal limit (10^(-1.5/20) ≈ 0.841); sadece kazanç sonrası
     oluşan tepe noktalarını kırpar, geri kalan dinamiğe dokunmaz
   - Bu filtre zincirinin (özellikle alimiter parametreleri) beklendiği
     gibi çalıştığını doğrulamak Adım 4'ün işi — orada zaten her
     dosyanın çıktısı yeniden ölçülecek, sonuç -14 LUFS'a yeterince
     yakın değilse alimiter parametrelerini (attack/release) ayarlayıp
     yeniden dene

**Çıktı uzantısı her zaman `.m4a`**, kaynağın uzantısı ne olursa olsun. Bu 30
dosyanın hepsi zaten `.m4a` olduğu için isim çakışması beklenmiyor, ama
yine de kontrolü atlama — ileride farklı formatlı dosya eklenebilir.

**Atomik yazma:** çıktıyı doğrudan `music/<isim>.m4a` yerine önce
`music/<isim>.m4a.tmp`'ye yaz, ffmpeg başarıyla bitince `music/<isim>.m4a`
olarak yeniden adlandır. İşlem ortada kesilirse (Ctrl+C, hata) yarım
dosya `.tmp` uzantısıyla kalır, `music/`'te geçerli bir dosya gibi
görünüp bir sonraki çalıştırmada atlanmaz.

**Idempotency:** `music/<isim>.m4a` zaten varsa ve hedef parametrede ise
VE kaynak dosyanın değişim zamanı (mtime) çıktıdan daha eski ise atla.
Kaynak daha yeniyse (parça sonradan güncellendiyse) yeniden işle.

Her dosya için başarı/hata durumunu logla:
- Başarılı: dosya adı, eski/yeni boyut, ölçülen ilk loudness, işlem süresi
- Hatalı: dosya adı ve ffmpeg hata mesajı — **script durmasın, sıradaki
  dosyaya geçsin, sonunda hata listesini raporlasın**

Bozuk/okunamayan bir dosyaya rastlarsan (ffprobe süre okuyamıyorsa)
normalize etmeye çalışma, doğrudan hata listesine ekle.

**Bu adım bitince dur ve rapor ver.**

---

### Adım 4 — Doğrulama

1. `music/` klasöründeki **tüm** çıktı dosyalarını `ffprobe` ile tekrar
   kontrol et: hepsi 48000 Hz, 2 kanal, AAC mi?
2. Uyuşmayan varsa listele — bu olursa Adım 3'teki komutta bir sorun var
   demektir, düzelt ve o dosyaları yeniden işle
3. 3-4 dosyayı rastgele seç — seçilen dosyalar arasında **mutlaka
   Unspoken Accord da olsun** (en yüksek kazancı gören parça, +4.42 dB,
   dolayısıyla limiter'ın en çok devreye girdiği parça). Bu dosyalarda
   **`loudnorm` ölçüm modunu (`print_format=json`, ikinci geçiş olmadan
   sadece ölçüm)** tekrar çalıştır ve iki değeri kontrol et:
   - `input_i` değerinin -14 LUFS'a yakın çıktığını doğrula
   - `input_tp` değerinin -1.5 dBTP'yi aşmadığını doğrula (aynı ölçümde
     zaten geliyor, ek maliyeti yok)

   `volumedetect` kullanma — o sadece peak ve ortalama dB verir, LUFS ölçmez.

   **Not:** `alimiter` örnek bazlı çalışıyor, örnekler arası true peak'i
   (inter-sample peak) görmüyor; AAC kodlaması da tepe noktalarını biraz
   yükseltebiliyor. Bu yüzden ölçülen `input_tp` -1.5'e yakın ama üstünde
   çıkarsa (örn. -1.3, -1.2) bunu kritik hata sayma — birkaç onda dB'lik
   sapma normal. Belirgin şekilde aşarsa (örn. -0.5 ve üstü) bunu logla ve
   limiter parametrelerinin (attack/release) gözden geçirilmesi gerektiğini
   raporla.

**Bu adım bitince dur ve rapor ver.**

---

### Adım 5 — Özet ve temizlik

1. Bir özet raporu ver: kaç dosya işlendi, kaç atlandı (idempotent),
   kaç hata verdi, toplam süre
2. **Conflict ve dead code kontrolü:**
   - `scripts/normalize.js` içinde kullanılmayan kod var mı?
   - `raw/` klasörüne yanlışlıkla yazma oldu mu? (olmamalı, salt okunur
     davranılmalı)
   - `music/` içinde script'in üretmediği, eski/kalıntı dosya var mı?
3. Hata veren dosyalar varsa bunları ayrı bir listede raporla — elle
   kontrol edilmesi gerekecek

**Raporu ver ve dur.**

## PROMPT SONU

---

## Sonraki adım

Bu faz kapanınca PLAN.md'de Faz 2.5 satırı "tamamlandı" olarak işaretlenir.
Sırada Faz 1 var — YouTube erişimi açıldıktan sonra, ham ffmpeg + RTMP
testi (R2 doğrulaması dahil).