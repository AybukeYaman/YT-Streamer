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

---

## [Faz 5] Speed penceresi ve 6 saatlik dayanıklılık testi — 25 Eylül 2026

**Soru:** Encode hızı (yavaşlama / sessiz arıza) nasıl izlenecek?

**Karar:** ffmpeg'in `speed=` alanı değil, ardışık iki ilerleme satırından hesaplanan
anlık hızın 30 sn pencere ortalaması (`SpeedWindow`, domain): toplam medya süresi
(Δframe/fps) / toplam duvar süresi. Her yeni ffmpeg sürecinin ilk 30 sn'si pencereye
girmez; pencere ısınma sonrası 30 sn dolunca değer verir. Eşikler: `< 0.95` "encode
yetişemiyor", `> 1.1` "anormal hız" — uyarı sadece durum değişince, otomatik aksiyon yok.

**Gerekçe:** `speed=` süreç başından beri ortalama. Saatlerce sağlam çalışmış bir
yayında ani yavaşlama ortalamayı neredeyse hiç oynatmaz (birim testi: 3 saat 1.0x + 40 sn
0.9x → ham ortalama ~0.999, pencere `slow`). Başta da ilk saniyelerde sıçrar (1.1x).

**Diğer Faz 5 kararları:**
- Çökme sonrası yayın sıfırdan değil `resume()` ile başlar: kuyruk korunur, yarım kalan
  playlist o an çalan parçadan yeniden yazılır. Sıfırdan başlasaydı `batchSize=50`'de
  onlarca parça o turda hiç çalmadan kaybolurdu. Konum duvar saatinden (ilk kareden
  çökmeye) hesaplanır — speed ≈ 1x olduğu için parça seçmeye yeter.
- Supervisor geri çekilme sayacı 5 dk çökmeden çalışınca sıfırlanır; crash loop = 5 dk'da 5 çökme.
- Windows'ta alt sürece SIGINT gönderilemez → `index.js` IPC `stop` mesajını da dinler
  (sadece başka bir Node süreci fork ederse etkili).

**6 saatlik test (01:19–07:19, gerçek `music/`, `batchSize=50`, overlay açık):**
- Saatte bir ffmpeg `taskkill /F` ile öldürüldü (5 kez): 5/5 çökme `code=1` algılandı,
  her seferinde 3 sn sonra yeniden başladı (sayaç 5 dk'yı aştığı için sıfırlanıyordu),
  hepsi "kaldığı parçadan devam" (ör. 50 → 29 → 9 parça). Crash loop yok.
- 2 doğal restart (playlist bitişi, `code=0`); restart boşluğu 1234 / 1224 ms — Faz 3/4
  ölçümleriyle (~1.1-1.15 sn) tutarlı, 50 drawtext'le fark yok.
- Bellek düz: node 39.8 → 40.3 MB, ffmpeg 756.7 → 765.8 MB (saatlik ortalamalar
  756–763 MB, eğilim yok). Sızıntı yok.
- Disk: boş alan 38.47 → 34.34 GB; farkın ~3.6 GB'ı test sonunda duran son iki çıktı
  dosyası (test sürücüsü biten playlist çıktılarını 3.61 GB sildi — üretimde çıktı RTMP,
  dosya yok).
- **Log rotasyonu gerçek testte tetiklenmedi:** 6 saatte log 0.57 MB (~2.3 MB/gün) —
  50 MB eşiği bu hacimde ~3 haftada bir dolar; rotasyon sadece birim testlerle doğrulandı.
  Pratikte belirleyici sınır "en fazla 5 dosya" = ~5 günlük günlük dosya geçmişi.
  50 drawtext'li ~15 KB'lık komut satırı restart başına bir kez yazılıyor, hacmi etkilemedi.
- **Hız duraksaması (1 kez, test başından 2 sa 49 dk, playlist #4'ün 23. dk'sı):**
  04:08:31–04:08:58 arası ffmpeg ~0.45x hızla çalıştı (anlık 0.35 / 0.39 / 0.40 / 0.76x;
  25 sn'de 276 kare), 04:09:01'de 1.03x'e döndü. Pencere 04:08:35.8'de 0.940 → `< 0.95`
  uyarısı; kayıtlı en düşük 0.553 (04:09:01); 04:09:20.7'de 0.964 → "normale döndü"
  (uyarı 45 sn aktif, 30 sn pencere hafızası yüzünden). Çıktı gerçek zamanın 13.0 sn
  gerisine düştü ve 1.03–1.08x hızla ~6 dk'da telafi etti (04:15:02'de geri kalma yok).
  Telafi sırasında pencere en çok 1.071 → `> 1.1` eşiği 6 saatte hiç tetiklenmedi (yanlış
  alarm yok). 4088 pencere değerinin 11 aykırısının hepsi bu olaydan.
  Planlı olaylarla çakışmadı: en yakın öldürme 03:19:04 (−49 dk) ve 04:19:04 (+10 dk),
  doğal restart 03:45:05 (−23 dk), sürücünün 04:09:05 örneği duraksama bittikten sonra.
  Parça sınırı (medya 1399.2 sn) başlangıçtan ~7.5 sn önce — ama ~120 sınırın hiçbirinde
  başka duraksama yok → tesadüf sayıldı. Windows olay günlüğünde anlamlı kayıt yok
  (04:08:13'te BITS servis başlatma türü değişimi = arka plan aktarımı, zayıf ipucu).
  16 mantıksal işlemcide ffmpeg ~2 çekirdek (~%12) → kapasite sorunu değil; makine
  düzeyinde geçici açlık (CPU zamanlama / disk G/Ç) gibi. Nedeni kanıtlanamadı. Yerel
  dosyaya çıktıda zararsız; gerçek RTMP'de ~25 sn'lik duraksama izleyicide tamponlama
  demek — Faz 1'de YouTube ile izlenmeli, tekrarlanırsa çevre (disk/AV/arka plan) ölçülmeli.

---

## [Faz 1] Ağ kopması testi ve crash loop'un bilinen sınırlaması — 26 Eylül 2026

**Soru:** 5.5 testi — supervisor gerçek ağ kesintisinde nasıl davranıyor?

**Bulgu:** 30+ sn'lik gerçek Wi-Fi kesintisinde ffmpeg her seferinde net hata verip
(WSAECONNRESET, DNS çözümleme hatası) birkaç saniye içinde çıktı, askıda kalmadı.
Supervisor doğru geri çekilmeyle (3sn, 6sn, 12sn) toparlandı, YouTube yayını
sonlandırmadı (Mükemmel durumu ve sayaç kesintisiz devam etti).
(Log: 01:09:25 ve 01:10:02'de TLS `IO error -10054`, 01:10:09'da
`a.rtmps.youtube.com` DNS'te çözülemedi; 01:10:22'de RTMPS'e yeniden bağlandı,
kaldığı parçadan devam. Crash loop sayacı 3/5'e çıktı.)

**Bilinen risk:** Crash loop koruması (5 dk'da 5 çökme → dur) ağ kesintisinin
süresinden bağımsız çalışıyor. 48-60 sn'den uzun süren bir ağ kesintisi (modem
resetlenmesi gibi) crash loop'u tetikleyip yayını kalıcı olarak durdurabilir — ağ
geri gelse bile otomatik toparlanmaz. (Ağ yokken her yeniden bağlanma denemesi 0.1 sn'de
düşüp ayrı bir çökme sayılıyor; 3+6+12+24 sn geri çekilmeyle 5 hak ~45 sn'de biter.)

**Karar:** Şimdilik düzeltilmedi, kabul edilen risk olarak kaydedildi. İleride ele
alınabilir: ağ hatalarını (ECONNRESET, DNS hatası) diğer çökme türlerinden ayırıp
onlara daha toleranslı bir eşik/pencere uygulamak.

**Etki:** Üretimde (VPS'te) izlenmesi gereken bir nokta; uzun bir kesinti sonrası
yayının kendiliğinden dönmediği fark edilirse elle restart gerekecek.

---

## [Faz 8] Çoklu albüm düzeni — 27 Eylül 2026

**Soru:** Tek `music/` + tek arkaplan yerine 10 albüm; arkaplan hangi anda değişmeli,
başlıklar nasıl temizlenmeli, yeni kuyruk hangi katmana ait?

### Arkaplan değişimi albüm sınırında (parça bazında değil)

Arkaplan ffmpeg'e süreç başlarken veriliyor; parça başına değiştirmek her parçada
yeni bir ffmpeg süreci demek olurdu. Bunun yerine her playlist tek bir albümden
oluşuyor ve arkaplan bir restart döngüsü boyunca sabit kalıyor — yani değişim zaten
var olan restart anında oluyor, ek kesinti yok.

**Ölçüm (gerçek test, batchSize 1):** üst üste 2 restart'ta da albüm ve arkaplan
değişti, restart boşluğu 622 ms ve 665 ms — Faz 3'teki tek albümlü değerlerle
(608–667 ms) aynı aralıkta. Arkaplanın değişmesi boşluğu büyütmüyor.
Çökme sonrası `resume()` aynı albümün arkaplanıyla devam ediyor (kuyruk korunuyor).

### Arkaplan crop/aspect: esnetme yok, ortadan kırpma var

Dönüşüm: alttan `cropBottom` piksel kes (üretici logosu) → en-boy oranını koruyarak
1280×720'yi kaplayacak kadar ölçekle → taşanı ortadan kırp. Düz `scale` ile esnetme
ve siyah bant ikisi de reddedildi: ilki görüntüyü bozuyor, ikincisi 720p alanı
küçültüyor. Görsel kaynaklı albümde aynı dönüşüm tek kareye uygulanıp 10 sn'lik
sabit video üretiliyor — çıktı formatı her albümde aynı.

`project.json`'daki `cropBottom` güvenilir değil: toptan uygulanmış, logosu olmayan
kliplerde gerçek görüntüyü kesiyordu. Albüm bazında `scripts/background-overrides.json`
ile eziliyor; 7 albümde `cropBottom: 0` verildi.

### video6 istisnası

Faz başında `video6` "bozuk/boş" sayılıp tarama dışı bırakılmıştı. `prepare-backgrounds.js`
geçerliliği isme değil içeriğe bakarak belirlediği için (project.json + `audio/`'da ses +
bulunabilen klip) video6 geçerli çıktı: 15 parça, 3 klip. Dahil edildi.
Listedeki diğerleri (`vid3`, `video3-tokyoNight`, `video1`) klasör olarak yok,
`video2-` gerçekten boş — onlar dışarıda kaldı.

### Başlık sürümleri: `_N` → `(II)`, `(III)`

Üretici imzaları (`[usesuno.com]` gibi alan adı içeren köşeli parantezler) siliniyor,
`(Take 2)` gibi anlamlı etiketler korunuyor. Sondaki `_1`, `_2` sürüm ekleri ham
dosya adı artığı: aynı taban adın tek sürümü varsa ek düşüyor, birden fazlaysa ek
sırasına göre ilki düz başlık, sonrakiler `(II)`, `(III)` … oluyor (eksiz olan en önde).
Sebep: `_1` yayında başlık olarak anlamsız görünüyor. Aynı sürüm numarasının iki kez
geçtiği ya da temizlik sonrası başlığı boş kalan dosyalar işlenmeden atlanıyor.

### AlbumQueue neden application katmanında

`AlbumQueue` domain'deki `Queue`'ları birleştiriyor (albüm sırası için bir Queue, her
albümün parçaları için birer Queue). Projede domain dosyaları birbirini import etmiyor,
bu yüzden domain'e konamadı; I/O'su olmadığı için infrastructure'a da ait değil.
Application katmanı kaldı.

### CJK font: arial → Yu Gothic

Faz başında "21 dosyada Japonca karakter var, bilinen sınırlama" diye not edilmişti.
Faz sonunda kontrol edildiğinde yayına giren 10 albümün **hiçbirinde** Japonca
karakter kalmadığı görüldü (ne normalize çıktıda ne kaynak `audio/` klasörlerinde) —
o 21 dosya tarama dışı bırakılan albümlerdeydi (`video3-tokyoNight` gibi).

Sınırlamanın kendisi yine de gerçekti: `arial.ttf` Japonca glifleri içermiyor,
`drawtext` onların yerine boş kutu (tofu) basıyor — ffmpeg hata vermiyor, sessizce
bozuk render ediyor. Gelecekte Japonca başlıklı bir albüm eklenirse sorun fark
edilmeden yayına çıkardı.

**Karar:** `overlay.fontFile` = `C:/Windows/Fonts/YuGothR.ttc` (Yu Gothic Regular).
Görsel olarak doğrulandı: hem Japonca (`東京の夜 さくら`) hem Türkçe (`ğ ı ö`)
doğru render ediliyor; arial aynı metinde Japoncayı kutu basıyordu. Noto Sans CJK
sistemde kurulu değil, Yu Gothic Windows'ta hazır geliyor. `.ttc` bir font
koleksiyonu ama ffmpeg'in `fontfile`'ı indeks belirtmeden kabul ediyor.

**Docker tarafı (faz-7-vps branch'inde, merge edilirken yapılacak):**
`config.docker.json` şu an `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`
kullanıyor — DejaVu'da da CJK yok, yani aynı sorun Linux'ta sürüyor. Yu Gothic
Windows fontu olduğu için oraya taşınamaz. Yapılacak: `Dockerfile`'da
`fonts-dejavu-core` yanına `fonts-noto-cjk` eklemek ve `config.docker.json`'daki
`fontFile`'ı `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc` yapmak.

### Sayılar

10 albüm, 353 parça normalize edildi (hata yok). Eski tek `music/` + `background`
düzeni `SingleAlbumRepository` ile çalışmaya devam ediyor: `config.paths.albums`
varsa albüm düzeni, yoksa eski düzen.

---

## [Faz 9] Süreç ölümünden sonra kaldığı yerden devam: konum diske yazılıyor — 27 Eylül 2026

**Soru:** Süreç öldürüldüğünde (kill, terminal kapanması, elektrik) yeniden başlatma neden
kaldığı yerden devam etmiyor?

**Sebep:** `resume()` yalnızca süreç içi çökmeyi kurtarıyordu — kuyruğu ve çalan playlist'i
orchestrator'ın **belleğinden** okuyor. Süreç tamamen gidince bellekte hiçbir şey kalmıyor,
`start()` sıfırdan yeni bir shuffle kuruyordu.

**Karar:** Çalan playlist'in konumu diske yazılır (`runtime/state.json`), `start()` onu okur.

```json
{ "album": "video 1", "trackPaths": ["...", "..."], "elapsedSeconds": 836.875 }
```

**Neden bu üç alan:** Kuyruğun tamamı değil sadece çalan playlist saklanıyor — süreç içi
`resume()` ile aynı semantik (shuffle sırası korunmuyor, çalan playlist korunuyor). Parçalar
yol olarak saklanıyor; başlık ve süre yeniden başlarken albüm deposundan (ffprobe önbelleği)
geliyor, durum dosyasına kopyalanmıyor — süre bilgisi iki yerde tutulursa çelişebilir.

**Konum neden duvar saatinden:** `elapsedSeconds` ilk kareden o ana kadar geçen gerçek süre;
ffmpeg'in frame sayısından değil. Aynı gerekçe süreç içi `#remainingTracks()`'te de geçerli —
speed ≈ 1x olduğu için parça seçmeye yetiyor, iki yol aynı hesabı kullanıyor.

**Yazma tempesi 5 sn:** İlerleme loguyla aynı tik. Ölüm anı ile son kayıt arası fark en fazla
bir tik, yani devam noktası en kötü 5 sn geriden başlar — parça sınırı seçimini değiştirmiyor.
Her ilerleme satırında (~2/sn) yazmak diske gereksiz yük olurdu.

**Yazma atomik, okuma affedici:** Yazma `.tmp` → rename (kill tam yazma anına denk gelse bile
yarım JSON okunmaz). Okuma tarafında bozuk dosya, eksik alan, artık var olmayan albüm ya da
parça → uyarı + `null`, yayın normal kuyruktan başlar. Durum bir kolaylık; yayını asla
engellememeli.

**Ölçüm (gerçek doğrulama):** 10:00:22'de başlayan yayın 10:14:19'da öldürüldü (albüm
"video 1", 31 dk'lık playlist'in 13.9 dk'sı oynamış, frame 20085 @ 24 fps). Yeniden
başlatmada 5. parçadan (`Sayfa Arası`), kalan 7/11 parçayla ve aynı arkaplanla devam etti.

**Bilinen sınırlama:** Açılışta 354 parçanın süresi ffprobe ile yeniden okunuyor
(`TrackRepository` önbelleği süreç içi — bkz. Faz 3 kaydı). Bu, yeniden başlatmada
~2,5 dakika yayın boşluğu demek; devam mekanizması bu süreyi kısaltmıyor, sadece
boşluktan sonra doğru parçadan girilmesini sağlıyor. Önbelleğin diske alınması
ayrı bir iş.

---

## [Faz 10] Env doğrulama deploy'a taşındı; unit'te EnvironmentFile yok — 30 Eylül 2026

**Soru:** Her deploy'da `.env`'de key eksik mi diye elle bakmak gerekiyor. Bu kontrol nereye
konulmalı — systemd `EnvironmentFile`'a mı, uygulamaya mı, deploy script'ine mi?

### `.env.example` sözleşmedir, doğrulayıcı tek yerdedir

`scripts/deploy/check-env.sh` `.env.example`'daki key listesini alır ve hedef dosyada her
key'in **var olduğunu ve dolu olduğunu** doğrular. Boş sayılan değerler: boş, yalnızca
boşluk, `""` ve `''`. `export KEY=` biçimi ve CRLF satır sonları da kabul edilir.

Script key **isimlerini** raporlar, **değerleri asla yazdırmaz** — deploy logları ve
`journalctl` çıktısı sır sızdırmamalı.

**Neden ayrı script:** aynı kontrol üç yerden çağrılıyor (`deploy.sh`, `install-service.sh`,
elle). Üç kopya zamanla birbirinden ayrışırdı.

**Fazla key hata değil:** `.env`'de `.env.example`'da olmayan bir key varsa yalnızca bilgi
satırı basılır. Makineye özel ek ayarların deploy'u durdurması yanlış olurdu.

### Aynı kontrol iki yerde iki farklı sertlikte

| Çağıran | Eksik key durumunda | Neden |
|---|---|---|
| `install-service.sh` | UYARI, kurulum sürer | İlk kurulumda `.env` henüz doldurulmamış olabilir; servisin yine de kurulması istenir |
| `deploy.sh` (ana yayın) | **HATA, deploy durur** | Çalışan bir sistem güncelleniyor; eksik key'le restart yayını düşürür |
| `deploy.sh` (ek yayın) | O instance atlanır, diğerleri sürer | Tek eksik key tüm yayınları durdurmamalı |

Ek yayın atlandığında çıkış kodu yine non-zero ve özet bölümü hangi instance'ın atlandığını
açıkça yazar — sessizce eksik deploy olmaz.

### Unit dosyalarında `EnvironmentFile` bilerek YOK

Uygulama `.env`'i **kendisi** okur (`src/config/load-config.js`, `util.parseEnv`) ve yol
`__dirname` bazlı olduğu için `WorkingDirectory`'den bağımsızdır. Çoklu yayında da aynı yol
geçerli: `ExecStart ... --env .env.%i`.

**Neden eklenmedi:** systemd'nin `EnvironmentFile` quoting/escape kuralları `util.parseEnv`'den
farklıdır. İkisi birlikte kullanılsa aynı dosya iki farklı şekilde yorumlanabilir — özellikle
quote ve `#` içeren değerlerde. Bu, hiçbir fayda karşılığında sessiz tutarsızlık riski.
Ayrıca gerçek ortam değişkeni dosyadakini zaten ezer (`load-config.js`), yani `Environment=`
ile tek key geçici olarak override edilebilir; bunun için `EnvironmentFile` gerekmiyor.

Bu gerekçe üretilen unit dosyalarının içine de yorum olarak yazılır — soru
`/etc/systemd/system/yt-streamer.service`'e bakılırken doğuyor, cevabın orada olması gerekir.

### `deploy.sh` diğer kararları

**`git pull --ff-only`:** VPS'te elle değişiklik yapılmışsa sessiz merge commit'i yerine açık
hata. Neyin değiştiğini görmek isteriz.

**`npm ci` (`npm install` değil):** lock dosyasına birebir uyar, lock'u güncellemez. Deploy
makinesi kendi başına bağımlılık sürümü yükseltmemeli.

**Testler varsayılan olarak çalışmaz (`--test` ile opsiyonel):** deploy hızını config
doğrulamasına feda etmek mantıklı, teste feda etmek değil. `--test` verilirse testler
devDependencies gerektirdiği (`ink-testing-library`) için önce tam `npm ci`, testler geçtikten
sonra `npm prune --omit=dev` — prod kurulumunda dev paketi kalmaz.

**`--dry-run` tamamen salt okunur (yalnızca "restart etmeyen deploy" değil):** ilk amaç
prod'da ilk turu risksiz geçirmek. Bu yüzden `git pull` yerine `git fetch` + "ne gelecek"
listesi, `npm ci` yerine `npm ci --dry-run`. Pull'u gerçekten yapsaydı çalışma ağacı
değişirdi: servis restart edilene kadar yayın etkilenmez ama sonraki *herhangi* bir restart
(systemd `Restart=always`, OOM, reboot) yeni kodu sessizce devreye alırdı — yani "hiçbir şey
değişmedi" sözü yalan olurdu. `npm ci` de benzer şekilde `node_modules`'ı silip yeniden
kurar; çalışan süreç gecikmeli bir modülü (`ink`/`react`, TUI yolu) o an require ederse
patlayabilir. Salt okunur sınır bu iki tuzağı birlikte kapatır.

**Dry-run erken çıkmaz:** gerçek deploy ilk sorunda durur, dry-run tüm sorunları toplayıp
özette listeler. Amaç tek turda bütün tabloyu görmek — üç kez çalıştırıp üç ayrı sorun
keşfetmek değil. Engelleyici sorun varsa çıkış kodu yine non-zero.

**`--dry-run` + `--test` reddedilir:** testler devDependencies kurulumu gerektirir, bu da
`node_modules`'ı değiştirir — dry-run sözüyle çelişir. Sessizce birini yok saymak yerine
açık hata.

**systemctl sorguları `sudo`'suz:** `cat`, `is-enabled`, `is-active`, `list-units` yetki
istemez. Yalnızca `restart` ve `journalctl` `sudo` ile çağrılır — böylece `--dry-run` hiç
parola sormaz (salt okunur bir komutun parola istemesi yanlış sinyal olurdu).

**Restart sonrası 5 sn bekleyip `is-active` kontrolü:** `systemctl restart` restart'ın
başarısını değil yalnızca komutun kabulünü bildirir. Saniyeler içinde crash eden bir süreci
yakalamak için kısa bekleme + başarısızlıkta son 20 satır `journalctl`. Sessiz "başarılı"
raporu vermek en kötü sonuç olurdu.
