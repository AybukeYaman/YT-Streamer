# Kararlar — 24/7 YouTube Müzik Livestream

Bu dosya, proje boyunca verilen mimari kararları ve gerekçelerini tutar.
Her karar, hangi fazda ve neden verildiğiyle birlikte kaydedilir.

Format:

```
## [Faz X] Karar başlığı — TARİH

**Soru:** Ne karara bağlanıyordu?
**Karar:** Ne seçildi?
**Gerekçe:** Neden bu seçildi, alternatifler neden elendi?
**Etki:** Bu karar hangi fazları/dosyaları etkiliyor?
```

---

## [Faz 3.1] Kuyruk besleme yaklaşımı — 23 Eylül 2026

**Soru:** Yayın kuyruğu ffmpeg'e nasıl beslenecek — canlı concat (A),
uzun playlist + planlı restart (B), yoksa named pipe (C)?

**Deney bulguları:**
- **A elendi.** ffmpeg 9.0.1'de concat demuxer playlist'i yalnızca açılışta
  bir kez okuyor, çalışırken eklenen satırları görmüyor. Ayrıca sessiz bir
  arıza tespit edildi: ses girişi tükendiğinde, video girişinde `-re`
  olmadığı için ffmpeg kapanmıyor, hız sınırsız artıyor (speed ~21x'e çıktı)
  ve anlamsız/sessiz video üretmeye devam ediyor. Process canlı göründüğü için salt process
  varlığına bakan bir supervisor bunu yakalayamaz.
- **B çalışıyor.** `-shortest` ile playlist bitince ffmpeg temiz kapanıyor
  (code=0). Ölçülen restart boşluğu (process kapanıp yenisi başlayana kadar)
  ~225 ms. Ancak bu sadece process seviyesinde — gerçek yayında RTMPS
  bağlantısının da yeniden kurulması gerekeceğinden gerçek boşluk muhtemelen
  1-3 sn civarında olacak (henüz YouTube ile doğrulanmadı).
- **C test edilmedi** (aşağıya bakın).

**Karar:** Yaklaşım B seçildi (uzun playlist + `-shortest` + planlı restart).
C (named pipe) şimdilik uygulanmayacak.

**Gerekçe:** Bu bir arkaplan müzik yayını, saniye hassasiyetinde canlı
etkileşim gerektirmiyor. Playlist uzun tutulduğunda (50-100 parça, saatler
sürer) restart seyrek olur; her seferinde 1-3 sn'lik bir kopma bu ölçekte
kabul edilebilir risk. Named pipe'ın getireceği karmaşıklık (Windows'ta
ayrı bir uygulama modeli, yeni bir mimari katman) henüz kanıtlanmamış bir
sorunu çözmek için şimdiden satın alınmış komplekslik olurdu.

**Açık risk (R2):** RTMPS bağlantısının restart'ta gerçekten nasıl
davrandığı (YouTube kısa kopmayı tolere ediyor mu, yoksa yayını
sonlandırıyor mu) Faz 1'de gerçek YouTube ile doğrulanacak. Eğer YouTube
yayını tamamen sonlandırırsa, C'ye (named pipe) dönülecek.

**Etki:**
- Faz 3 tasarımı B'ye göre şekillenecek: `PlaylistWriter` uzun bir playlist
  önceden yazacak (50-100 parça), `StreamOrchestrator` playlist bitişini
  (`exit code=0`) yakalayıp yeni playlist + yeni process ile restart edecek
- Faz 5.4'e speed üst sınır kontrolü eklenecek: `speed > 1.1x` anormal kabul
  edilmeli (sessiz arıza tespiti için — sadece `< 0.95` alt sınırı yetersiz)
- Faz 1'in kapanış kriterine R2 doğrulaması eklenecek: en az bir planlı
  restart'ı gerçek YouTube yayınında gözlemleyip tepkisini kaydetmek

---

## [Faz 2.5] Loudness normalizasyon yöntemi — 23 Eylül 2026

**Soru:** 30 dosyanın analizinde loudnorm'un `linear=true` modu koşulu
sağlamıyordu (kazanç sonrası peak hedef TP'nin üstünde kalıyor). Üç seçenek
vardı: A) sabit kazanç + ayrı limiter, B) loudnorm'un dinamik moduna razı
olmak, C) hedefi -19 LUFS'a düşürmek.

**Karar:** A seçildi.

**Gerekçe:** B dinamiği parça boyunca bozuyor. C, YouTube'un -14 LUFS
hedefinin belirgin altında kısık bir yayına yol açıyor ve YouTube kısık
içeriğin sesini yükseltmiyor. A hem hedefe oturuyor hem dinamiği koruyor,
bedeli sadece birkaç dosyada zaten var olan tepe noktalarının kırpılması.

**Etki:** `normalize.js`'in normalize mantığı loudnorm linear yerine
ölçüm + sabit kazanç + `alimiter` zincirine göre yazılacak. Bitrate 192k'de
bırakıldı (değiştirilmedi).

---

## [Faz 3] TrackRepository önbelleği restart'ta yenilenmiyor — 24 Eylül 2026

**Soru:** Yayın sürerken `music/`'e eklenen parça kuyruğa girmeli mi?

**Karar:** Şimdilik hayır — bilinen sınırlama olarak bırakıldı.

**Gerekçe:** `TrackRepository.list()` sadece başlangıçta çağrılıyor, planlı
restart'ta yenilenmiyor. Yayın sürerken eklenen parça, süreç yeniden
başlatılana kadar kuyruğa girmiyor. Düzeltmek kuyruğun yeniden kurulmasını
gerektiriyor — şu aşamada gereksiz komplekslik.

**Etki:** Faz 6 (kontrol arayüzü) ile birlikte ele alınabilir.

---

## [Faz 4] Overlay zamanlaması ffmpeg'de: parça başına drawtext + enable — 25 Eylül 2026

**Soru:** "Şu an çalan" yazısı nasıl sesle senkron değişecek?

**İlk tasarım (prompt):** Tek `drawtext` + `textfile=nowplaying.txt:reload=1`; Node,
ffmpeg'in `frame=` sayısından geçen süreyi (`frame/24`) hesaplayıp parça değişince
dosyayı günceller.

**Neden terk edildi:** 4.4 uçtan uca testinde (gerçek parça, çıktı videosu kare kare
incelendi) yazı sesten **~12 sn geç** değişti — ses 178.2 sn'de geçti, `nowplaying.txt`
178.6 sn'de doğru güncellendi, ama ekranda yazı 190.1 sn'de değişti. ffmpeg arka plan
videosunu (`-re` yok) kuyrukta ~12 sn önden işliyor; `frame=` çıktı tarafının sayısı.
Denenen ve elenenler: atomik rename değil (yerinde yazmayla aynı); video girişine `-re`
gecikmeyi düzeltmiyor ve her başlangıçta ~12 sn takılma ekliyor (PLAN.md Faz 1'deki
"video girişinde `-re` kullanma" kuralı doğrulandı).

**Karar:** Her parçanın başlığı ayrı dosyada; parça başına bir `drawtext`,
`enable='gte(t,başlangıç)*lt(t,bitiş)'` (son parça `gte` ile açık uçlu). `t` videonun
kendi zaman damgası — zamanlama tamamen ffmpeg'de, Node'da frame takibi yok. `reload`
yok (dosyalar açılışta bir kez okunur → Windows'ta rename/EPERM riski de kalmadı).
`expansion=none`: başlıktaki `%` yorumlanmaz.

**Doğrulama:** Gerçek parçada geçiş 180.608 sn, yazı 180.5–180.7 arasında değişti
(tek kare). 3 restart'ta yeni playlist'in ilk karesinde doğru başlık.

**Performans (batchSize=50, 120 sn, `-benchmark`):** Gerçek zamanlı (`-re`, Faz 1
koşulu) overlay'siz 2.007 çekirdek → 50 drawtext 2.110 çekirdek (+%5); `-re`'siz
ölçümde fark −%2 — gürültü aralığında. Hız 1.00x, bellek +3 MiB. `sendcmd` yedeğine
gerek kalmadı.

**Not:** Overlay'siz CPU bile Faz 1'in (0.76 çekirdek, `experiments/faz1-gercek720b.log`)
~2.6 katı. Overlay ile ilgisi yok; arka plan videosu Faz 1'dekinden farklı
(`assets/background.mp4`). VPS boyutlandırması (Faz 7, "2 vCPU minimum") için
yeniden değerlendirilmeli.
