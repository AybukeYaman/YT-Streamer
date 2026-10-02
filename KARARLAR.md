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

> **DÜZELTME (2 Ekim 2026):** Yukarıdaki "kalıcı olarak durdurabilir / otomatik
> toparlanmaz" tespiti üretimde **doğru değildi**: unit'te `Restart=always` +
> `RestartSec=15` var ve `StartLimit*` ayarlanmamıştı, yani süreç vazgeçip çıkınca
> systemd 15 sn sonra yenisini açıyordu — yayın dönüyordu ama supervisor'ın backoff'u
> ve crash penceresi her yeni süreçte sıfırdan başlıyordu. Bu madde artık geçersiz:
> vazgeçme davranışı tamamen kaldırıldı, bkz. aşağıdaki
> *[Faz A] Tekrarlayan çökmede vazgeçme kaldırıldı*.

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

**`daemon-reload` tespiti systemd'ye sorularak, `git diff` ile değil:** ilk canlı deploy'da
systemd "unit file changed on disk, run daemon-reload" uyarısı verdi; restart'ı engellemedi ama
sessizce **eski** unit tanımıyla başlattı — bu yüzden reload restart'tan **önce** olmalı.

Tespit için `git diff --name-only` ya da pull öncesi/sonrası hash karşılaştırması
**işlemez: repoda unit dosyası yok.** `install-service.sh` ve `add-stream.sh` unit'i çalışma
anında heredoc ile üretir; `deploy.sh` unit'e hiç dokunmaz, dolayısıyla hash hep aynı çıkar ve
kontrol sessizce hiç tetiklenmez — en kötü hata türü. Doğru kaynak systemd'nin kendi bayrağı:
`systemctl show -p NeedDaemonReload --value <unit>`. Uyarıyı basan mekanizma da bu, yani
tahmin yok. `yes` dönmedikçe çağrılmaz; birden fazla unit değişse de reload süreç genelinde
olduğu için bir kez yapılır. Sorgu yetki istemediği için `--dry-run` de parola sormadan
kontrol edip yalnızca raporlar.

Dry-run'da bu **engelleyici sayılmaz** (`PROBLEMS`'a girmez): gerçek deploy kendisi hallediyor,
oraya koymak dry-run'ı boş yere kırmızıya boyardı.

**Sınırı:** `daemon-reload` yalnızca yüklü tanımı tazeler. VPS'teki unit dosyası repodaki
üreticiden geri kaldıysa düzeltmez — o makinede bir kez `install-service.sh` gerekir.
`deploy.sh`'ın "üretilecek unit ile diskteki fark var mı" diye bakması, unit üretim mantığının
iki yerde durması demek olurdu; bilinçli olarak yapılmadı.

**Restart sonrası 5 sn bekleyip `is-active` kontrolü:** `systemctl restart` restart'ın
başarısını değil yalnızca komutun kabulünü bildirir. Saniyeler içinde crash eden bir süreci
yakalamak için kısa bekleme + başarısızlıkta son 20 satır `journalctl`. Sessiz "başarılı"
raporu vermek en kötü sonuç olurdu.

---

## [Faz 7] Yetim ffmpeg: iki kademeli kill + restart öncesi orphan sweep — 30 Eylül 2026

**Gözlem (29-30 Eylül haftası, bir kez):** restart sonrası aynı anda birden fazla
ffmpeg ayakta kaldı. Eski süreç ölmeden yenisi başladığı için aynı stream key'ine
iki bağlantı gitti.

**Kök neden zinciri.** Eski `FfmpegEncoder.stop()`: `'q'` → 5 sn → tek bir
`child.kill()`, yani **sadece SIGTERM**, sonrası yok. Promise **yalnızca** `'close'`
ile resolve oluyordu. ffmpeg SIGTERM'i yutarsa (kesilemez I/O beklemesi, RTMP
flush) `'close'` hiç gelmiyor → `stop()` sonsuza kadar pending → kapanış zinciri
(`orchestrator.stop` → `supervisor.stop` → `index.js shutdown`) askıda kalıyor →
systemd'nin `TimeoutStopSec=30`'u doluyor → systemd **node'u SIGKILL** ediyor →
ffmpeg ebeveynsiz kalıp `PPID=1`'e düşüyor. Node yeniden başlayınca yetim ffmpeg
hâlâ yayına bağlı: çift yayın.

Node içinden çift ffmpeg doğması zaten mümkün değildi (`start()`, `this.child`
üzerinden korunuyor ve `child` yalnız `'close'`da null'lanıyor) — sorun **süreç
seviyesindeydi**, bu yüzden çözüm de iki yerde:

**1. Escalation (`ffmpeg-encoder.js`):** `'q'` → SIGTERM → SIGKILL, her kademe
loglanır. SIGKILL'den sonra da `'close'` gelmezse promise **yine resolve olur** —
kapanışı askıda bırakıp systemd'nin node'u öldürmesine izin vermek, tam olarak
kaçınmak istediğimiz şeydi. O yolda `this.child` **bilerek null'lanmaz**: `running`
true kalır, `start()` yeni ffmpeg'i reddeder, yani çift yayın yerine yayın durur.
Bu tercih bilinçli — bozuk çift yayın, durmuş yayından kötüdür.

**2. `index.js`'e SIGTERM handler:** unit'ler `KillSignal=SIGINT` kullanıyor, ama
elle `kill <pid>` ya da ileride `KillSignal`'i olmayan bir unit SIGTERM gönderir;
handler yoksa Node anında ölür ve ffmpeg yine yetim kalır. Tek satırlık sigorta.

**3. `deploy.sh` → `scripts/deploy/sweep-orphan-ffmpeg.sh`:** restart adımından
hemen önce tek tur tarama. Kural: **meşru** = PPID'si bu repodan çalışan **canlı**
bir `node .../index.js` süreci olan ffmpeg. Bu tanım systemd instance'larını da
elle başlatılmış bir yayını da kapsar; "systemd MainPID'si değilse orphan" demek
elle çalışan yayını sessizce öldürürdü — **yanlış pozitif en kritik risk**, testte
ayrıca karşılanıyor. Orphan = args'ında repo yolu geçen ama meşru kümede olmayan
(PPID=1 ya da ölmüş ebeveyn). Aksiyon: logla → SIGTERM → 3 sn → SIGKILL. Deploy
**durmaz, sorulmaz**: amaç restart'ın önünü temizlemek, restart'ı engellemek değil.
`--dry-run` yalnızca raporlar.

**Neden ayrı script:** `check-env.sh` ile aynı gerekçe — mantık test edilebilir
olsun (`ps`/`pgrep`/`kill` env ile enjekte edilir, sahte süreç tablosuyla test
edilir) ve `install-service.sh` de ileride aynı kontrolü çağırabilsin.

**Sır güvenliği:** ffmpeg argümanları RTMP URL'sini, yani stream key'i içeriyor.
Sweep log'a **yalnızca `pid/ppid/etime`** basar, `args`'ı asla — ayrı bir testle
sabitlendi.

---

## [Faz 7] Kapanış sırasında başlatma yarışı: iptal edilebilir start() — 30 Eylül 2026

**Gözlem:** art arda iki deploy. İkincisinin restart'ı, node album yüklerken
(264 parça) geldi. journalctl: `19:14:24` SIGINT + "temiz kapanış tamamlandı",
`19:14:36` yeni müzik yükleme + ffmpeg başlatma logları, `19:14:54`
`State 'stop-sigterm' timed out. Killing.` → systemd node'u ve ffmpeg'i SIGKILL etti.

**Log'un doğru okunuşu (ileride yanlış okunacak türden):** `19:14:54 − 30 =
19:14:24`, yani süre dolan stop job'ı `19:14:24`'te başlayandı. Dolayısıyla
`19:14:36`'daki "yeni süreç başladı" görünen loglar **yeni sürecin değil,
systemd'nin kapatmaya çalıştığı ESKİ sürecin** logları. Hiçbir başka okuma bu
aritmetiği vermiyor.

**Kök sebep — üç satırın birleşimi:**
1. `TrackRepository.list()` parça başına **sıralı** ffprobe çalıştırıyor: 264
   parçada ~12 sn'lik bir `await` penceresi (`19:14:24 → 19:14:36` tam bu).
2. `StreamOrchestrator.start()` bu `await`'ten sonra `stopping`'e **hiç
   bakmıyordu**: yükleme bitince koşulsuz `#startNextPlaylist()` → ffmpeg spawn.
3. `stop()` o anda `encoder.child === null` gördüğü için **anında resolve**
   oluyordu → `index.js` "temiz kapanış tamamlandı" yazıyor, ama hiçbir şey
   durdurulmamış oluyor.

Sonuç: ölmesi gereken süreç, kapanış "bitti" dedikten sonra kendini yayına
sokuyor. `index.js`'teki `shuttingDown` guard'ı sonraki sinyalleri de yok
saydığı için kurtarma yolu da yoktu; tek sonlandırıcı systemd'nin SIGKILL'i.

**Bugünkü kademeli kill (SIGTERM → SIGKILL) bozulmadı — devreye girecek bir
çocuk süreç yoktu.** Orphan sweep ve cgroup temizliği de doğru çalıştı (yetim
kalmadı). Bu bug o değişikliklerden önce de vardı; yalnızca iki deploy'un art
arda gelmesi onu 12 saniyelik pencereye denk getirdi.

**Çözüm:**
- `stopRequested` alanı, `stopping`'den **ayrı**. `stopping` her
  `start()`/`resume()` başında `false`'a çekildiği için uçuştaki bir başlatmayı
  iptal etmeye uygun değil — aynı alanı kullanmak sinyali silerdi.
- `stop()`: `stopRequested = true` → uçuştaki `startInFlight` promise'ini
  **bekler** → sonra `encoder.stop()`. Kapanış artık "ffmpeg başlatılacak mı"
  kararı verildikten SONRA tamamlanıyor.
- `start()`: `await`'ten sonra guard → ffmpeg hiç başlatılmaz, `exit`
  **expected=true** yayılır (supervisor çökme sanıp yeniden başlatmasın) ve
  **açık bir warn loglanır**: "başlatma iptal edildi: kapanış istendi (albüm
  yükleme sırasında)". Bugünkü teşhisi zorlaştıran şey, logların temiz kapanış
  derken sürecin yayına girmesiydi; bu satır o durumu tek bakışta gösterir.
- `#startNextPlaylist()`'e de guard: ffmpeg'i spawn eden **tek** nokta orası,
  çağrı yolları çoğalsa bile kapanışta yeni süreç doğmasın.
- `index.js`: ikinci sinyal artık **zorla çıkış** (eskiden tamamen etkisizdi,
  oysa takılı kapanışta tek çıkış yolu oydu) + kapanış sonrası **5 sn watchdog**:
  süreç hâlâ ayaktaysa açık handle/istek sayısını loglayıp `process.exit(0)`.
  Watchdog `unref()`'li: boş event loop'ta normal kapanış kazanır, yalnızca
  gerçekten bir şey süreci ayakta tutuyorsa tetikler.
- `getPlaybackState()` artık `stopRequested` de veriyor; UI o aralıkta
  "restarting" değil "stopped" gösteriyor (yayın bir daha başlamayacak).

**`TimeoutStopSec=30`'a bilerek dokunulmadı:** düşürmek belirtiyi kısaltır,
sebebi gizler. Kapanış artık bizim tarafta, 5 sn içinde sonlanıyor.

**Kapsam dışı (ayrı iş):** ffprobe'u paralelleştirmek / süreleri kalıcı
önbelleğe almak pencereyi ~1 sn'ye indirir ama yarışı **çözmez** — guard'sız
1 saniyelik pencere de eninde sonunda yakalanır, üstelik daha nadir olduğu için
teşhisi daha zor olur. Sıcak yolu (`TrackRepository`) değiştirdiği için de bu
commit'e alınmadı: bir şey bozulursa sebebin hangisi olduğu belirsizleşirdi.

---

## [Faz 9] YouTube broadcast otomasyonu — Aşama 1 kararları — 30 Eylül 2026

Sistem bugüne kadar YouTube'a yalnızca **veri** gönderiyordu (ffmpeg → RTMPS).
"Bu veriyi canlı yayına çevir" adımı elle Studio'da yapılıyordu. Aşama 1 kimlik
katmanını kuruyor; Aşama 2 (`insert` → `bind` → `transition`) otomasyonu.

**Kimlik bilgileri AYRI dosyada (`.env.youtube`), `.env.example`'a eklenmedi.**
İki sebep:
1. `scripts/deploy/check-env.sh`, `.env.example`'ı sözleşme kabul edip oradaki
   **her** key'i zorunlu sayıyor (opsiyonel key desteği yok). Üç OAuth key'ini
   oraya koymak, dosyalar doldurulana kadar **gerçek deploy'u durdururdu**
   (`deploy.sh` bölüm 2 → `exit 1`) ve **her `.env.<isim>` instance'ını** "eksik
   env" diye atlardı — `add-stream.sh` yeni instance'lara yalnızca
   `YOUTUBE_STREAM_KEY` yazıyor.
2. Semantik: OAuth kimliği **kanal** seviyesinde, yayın instance'ı seviyesinde
   değil. Üç yayın için üç kopya client secret tutmak anlamsız ve sır yüzeyini
   büyütür.
Alternatif (`check-env.sh`'a `# optional` işareti eklemek) daha çok değişiklik ve
daha çok risk demekti; per-instance sözleşme hiç değişmesin diye ayrı dosya seçildi.
`.gitignore`'daki `.env.*` kalıbı dosyayı zaten gizliyor, şablon için
`!.env.youtube.example` istisnası eklendi.

**Sıfır yeni bağımlılık: düz `fetch`.** `googleapis` (~15 MB) zaten dışlanmıştı;
aynı mantıkla `google-auth-library` da eklenmedi. Kullanılan uç nokta sayısı üç
(token, liveStreams, ileride liveBroadcasts) ve PKCE + token takası `crypto` +
yerleşik `fetch` ile yazılabilecek kadar basit. `package.json` dependencies
değişmedi.

**OAuth akışı: loopback redirect (`http://127.0.0.1:<port>`) + PKCE.**
OOB akışı (`urn:ietf:wg:oauth:2.0:oob`) Ekim 2022'den beri engelli —
`invalid_request` döner, yani "consent URL üret, kodu terminale yapıştır"ın
klasik biçimi artık yok. Desktop client tipinde loopback izinli ve port önceden
kaydedilmek zorunda değil.

**VPS'te tarayıcı yok problemi: script tarayıcısı olan makinede çalıştırılıyor.**
Refresh token makineye bağlı değil; VPS'e taşınan tek şey o token, authorization
code hiç taşınmıyor. SSH tüneli (`ssh -L`) alternatifi telefondan işlemediği ve
gereksiz karmaşık olduğu için seçilmedi.

**Telefondan izin (`--manual`):** izin sonrası Safari
`http://127.0.0.1:<port>/?code=...` adresine gidip "bağlanılamadı" der, ama kod
**adres çubuğunda durur**. Script tam URL'i de sadece kodu da kabul ediyor. OOB'a
ihtiyaç kalmadan iOS yolu böyle çalışıyor.

**`access_type=offline` + `prompt=consent` zorunlu:** ikincisi olmadan aynı
client'a verilen ikinci izinde Google `refresh_token`'ı **atlar** ve elde yalnızca
1 saatlik access token kalır — sessiz ve teşhisi zor bir başarısızlık.

**Testing modu 7 gün tuzağı.** OAuth consent screen "Testing" durumundayken
refresh token **7 günde expire** olur; 7/24 yayın için kabul edilemez. Çözüm
consent screen'i **"In production"**a almak: `youtube` scope'u *sensitive*
(restricted değil), yani doğrulama olmadan da yayınlanabilir — bir kez
"doğrulanmamış uygulama" uyarısı geçilir, 100 kullanıcı sınırı olur (bizde 1) ve
**refresh token kalıcı olur**. Aşama 2'ye bırakılmadı, Aşama 1'in parçası yapıldı;
`invalid_grant` hatası da bu ipucunu mesajına basıyor ve test ile sabitlendi.

**Stream eşleştirme başlıktan DEĞİL key'den.** `verify-access.js`,
`cdn.ingestionInfo.streamName` alanını `.env`'deki `YOUTUBE_STREAM_KEY` ile
karşılaştırıyor. "Default stream key" başlığı dile/kanala göre değişir; key'in
kendisi kesin eşleşmedir. Eşleşme yoksa (key başka kanala ait ya da izin farklı
Google hesabıyla verilmiş) **non-zero çıkıyor** — Aşama 2 yanlış kanala yayın
açmasın. Stream key hiçbir çıktıda geçmiyor, son 4 hane maskeli gösteriliyor.

**Mimari:** `src/infrastructure/youtube-oauth.js` + `youtube-credentials.js`.
`application`/`domain` katmanları ve `index.js` YouTube API'yi **tanımıyor** —
yayın süreci ağ/API bağımlılığı almıyor (mevcut mimari testi bunu zorluyor).

### Aşama 2 tasarım kısıtları (henüz kodlanmadı)

**iOS'tan tetiklenebilir olmalı** (kullanıcı gereksinimi): canlıya alma adımı
sadece VPS terminalinden değil, Safari'den bir link ya da iOS Shortcuts ile HTTP
isteği göndererek de çalışmalı. Bu yüzden go-live yalnızca CLI script'i olamaz:
VPS'te küçük bir HTTP servisi (`node:http`, bağımlılıksız) + `Authorization:
Bearer <GOLIVE_AUTH_TOKEN>` (sabit-zamanlı karşılaştırma, hız sınırı). Token yer
tutucusu `.env.youtube.example`'a şimdiden eklendi.

**Yalnızca localhost'a bind + önünde TLS (Tailscale ya da Caddy).** Düz HTTP
üzerinden bearer token göndermek onu sızdırır; canlı yayın başlatabilen bir
endpoint için kabul edilemez. Tailscale tercih edilmeli: internete hiç açılmaz.

**İdempotans — en kritik kısıt.** Unit'lerde `Restart=always`, supervisor 5
çökmeye kadar yeniden başlatıyor. Broadcast oluşturma yayın sürecinin
başlangıcına girerse **her restart yeni bir broadcast yaratır**: kanalda çöp
yayınlar ve kota tükenmesi (`insert`/`transition` ~50 birim, günlük 10.000).
Bu yüzden `index.js` API'yi hiç tanımayacak; aktif broadcast id'si diske yazılıp
varsa yeni `insert` yapılmayacak.

**Sıra zorunlu:** ffmpeg zaten basıyor → `insert` → `bind` (mevcut **kalıcı**
stream id'ye) → ingest `active` olana kadar yokla → `transition(live)`.
`transition` ingest aktif değilken hata veriyor, yani otomasyon yayını başlatan
değil, **yayın başladıktan sonra çalışan** adım. `liveStreams.insert` ile her
yayında yeni stream AÇILMAYACAK: restart dayanıklılığı kalıcı key'e dayanıyor
(bkz. yukarıdaki RTMPS kopma/geri bağlanma kaydı).

---

## [Faz 9] Aşama 2 — go-live otomasyonu kararları — 1 Ekim 2026

Akış: ffmpeg zaten basıyor → **ingest kontrolü** → `liveBroadcasts.insert` →
`liveBroadcasts.bind` (kalıcı stream id) → `transition('live')`.

**Yayın sürecinden AYRI servis (`yt-golive.service`).** `index.js` YouTube API'yi
hiç tanımıyor. Sebep: unit'lerde `Restart=always`, supervisor 5 çökmeye kadar
yeniden başlatıyor. Broadcast oluşturma yayın başlangıcına girerse her restart
yeni bir broadcast yaratır — kanalda çöp yayınlar ve kota tükenmesi
(`insert`/`transition` ~50 birim, günlük 10.000). Aynı `GoLiveService` hem HTTP
servisi hem CLI tarafından kullanılıyor (`src/composition/go-live-wiring.js`):
iki tetikleme yolu, tek mantık.

**`src/composition/` klasörü açıldı.** Wiring `src/application` altına konamaz:
mimari testi application katmanının `infrastructure` import etmesini yasaklıyor.
Somut bağımlılıkları bağlamak `index.js` gibi bir composition root'un işi.

**ingest kontrolü insert'ten ÖNCE — duman testinin ortaya çıkardığı kusur.**
İlk uygulamada sıra insert → bind → ingest yoklama → transition idi. Duman
testinde (sahte API + gerçek HTTP + gerçek disk) ffmpeg basmıyorken tetiklenince
broadcast **oluşturuldu**, sonra ingest beklenip hata verildi ve kanalda `ready`
durumunda **çöp bir yayın kaldı**; ikinci deneme bir tane daha ekledi (2 insert).
Tam olarak kaçınmak istediğimiz şey. Düzeltme: ingest `active` olmadan insert
yapılmıyor. `transition` zaten ingest aktif olmadan çalışmadığı için önce kontrol
etmenin maliyeti yok, kazancı çöp broadcast olmaması. Düzeltmeden sonra aynı
senaryoda toplam insert = 1.

**Yarım kalan broadcast yeniden kullanılıyor.** `created`/`ready` durumundaki bir
kayıt varsa yenisi açılmıyor, aynı broadcast bind + transition ile sürdürülüyor.
`complete`/`revoked` ise bir daha canlıya alınamaz → kayıt temizlenip yeni insert.
Üç durumlu ayrım (`live` / `reusable` / kullanılamaz) bu yüzden var.

**İdempotansın tek bilgi kaynağı diskte** (`runtime/broadcast.json`, atomik yazma).
`StateStore`'dan ayrı dosya: farklı ömür (broadcast günlerce yaşar, playlist konumu
saniyelerde değişir) ve farklı yazar (go-live servisi vs yayın süreci) — aynı
dosyaya iki süreç yazarsa son yazan diğerini siler. **Durum yazılamazsa akış
DURUR**: yazmadan devam etmek idempotansı kaybettirir ve sonraki tetik ikinci bir
broadcast açar.

**`monitorStream` kapalı oluşturuluyor.** Açıkken `transition` önce `testing`,
sonra `live` gerektiriyor — iki adım, iki hata yüzeyi. Kapalıyken tek
`transition('live')` yeter. Studio önizlemesi kaybediliyor; 7/24 müzik yayını için
gereksiz. `insert`'in zorunlu alanları `snippet.scheduledStartTime` ve
`status.selfDeclaredMadeForKids` — ikincisi verilmezse API reddediyor.

**`broadcast` config bölümü OPSİYONEL.** Zorunlu yapmak, VPS'teki mevcut
`config.json`'larda bu bölüm olmadığı için **çalışan yayını** config hatasıyla
düşürürdü. Bölüm yoksa varsayılanlar geçerli; verilen alanlar doğrulanıyor
(geçersiz `privacyStatus` sessizce private yayına yol açmasın). `privacyStatus`
varsayılanı **`unlisted`**: ilk otomatik broadcast kanalda beklenmedik şekilde
herkese açık çıkmasın. Güven kazandıktan sonra elle `public`. Başlık **sabit**
(`24/7 Cozy Lofi Radio ☕ ...`): her restart'ta yeni başlık kanalı kalabalıklaştırır.

**Stream id sabit yazılmadı, key'den çözülüyor.** `cdn.ingestionInfo.streamName`
karşılaştırması (`verify-access.js`'teki mekanizmanın aynısı). Çoklu yayında her
instance KENDİ stream'ine bağlanır ve key döndürülürse id sessizce eskimez.
Config'te opsiyonel `broadcast.streamId` override'ı var; boşsa çözülüyor.
Eşleşme yoksa **açık hata** — yanlış kanala yayın açılmasın.

**HTTP servisi: sadece `127.0.0.1`, TLS'i Tailscale sağlıyor.**
`tailscale serve --bg https / http://127.0.0.1:8787` tailnet içinde geçerli
sertifikayla HTTPS verip arkada loopback'e proxy'liyor; internete hiçbir port
açılmıyor. Düz HTTP üzerinden bearer token göndermek onu sızdırır — canlı yayın
başlatabilen bir endpoint için kabul edilemez. Tailscale **koda hiç girmiyor**
(ulaşım katmanı); yarın Caddy'ye geçilse tek satır kod değişmez.

**Auth fail-closed:** token boş ya da 32 karakterden kısaysa sunucu **başlamıyor**.
Auth'suz ayağa kalkmak sessiz bir güvenlik açığı olurdu. Karşılaştırma iki tarafın
SHA-256 özetleri üzerinden `timingSafeEqual` (uzunluk farkı bile sızmasın). Token
hiçbir log satırına girmiyor (ayrı testle sabitlendi). URL parametresiyle token da
kabul ediliyor (Safari'den tek dokunuş), ama README bunun tarayıcı geçmişine
düştüğünü söyleyip Shortcuts + header öneriyor.

**Eşzamanlı tetik → `409`.** iOS'ta çift dokunma iki broadcast yaratmasın diye
tek-uçuş kilidi. İkinci istek sessizce aynı sonucu almıyor, açıkça reddediliyor:
çağıran "şu an sürüyor" bilgisini almalı.

**`/status` varsayılan olarak API'ye GİTMİYOR** (diskten okuyor). Telefondan sık
yoklamak kotayı yemesin; taze bilgi için `?refresh=1`.

**`deploy.sh` `yt-golive`'ı da restart ediyor.** Ayrı süreç ama AYNI repodan
çalışıyor: pull sonrası restart edilmezse eski kodla devam eder (sessiz
tutarsızlık). Kurulu değilse atlanıyor. Özet listesindeki `yt-streamer*` kalıbı
`yt-golive`'ı kaçırdığı için oraya da eklendi.

---

## [Ayar] Video bitrate 2500k → 3500k — 1 Ekim 2026

Görüntü kalitesi için `profile.videoBitrate` 2500k → 3500k. `preset` **bilerek
veryfast kaldı**: 3 çekirdekli VPS'te CPU'yu riske atan asıl kaldıraç preset'tir.
Sabit preset'te bitrate artışının CPU maliyeti küçük sayıldı (asıl yük hareket
tahmininde, artan kısım entropi kodlamada) — **varsayım, ölçülmedi**; gerçek bedel
upstream bant genişliğinde: ~2.7 → ~3.7 Mbit/s (+%40). `maxrate`/`bufsize`
StreamProfile'da b:v'den türediği için (bufsize 7000k) tek değer yetti, kod
değişmedi. Ölçüm notu yukarıda duruyor: overlay'li ffmpeg ~2.1 çekirdek,
3 çekirdekte pay ~0.9 — `speed` 1.00x'in altına inerse ilk geri alınacak budur.

Değişiklik yalnız şablonda (`config.example.json`). Makinelerdeki `config.json`
git'te olmadığı için elle güncellenir; `profile` süreç başlangıcında okunduğundan
restart şart.

---

## [Faz 10] `add-stream.sh` config üretimi: tek tırnak yerine tırnaklı heredoc — 1 Ekim 2026

**Soru:** `sudo bash scripts/deploy/add-stream.sh stream2` ilk gerçek çalıştırmada
`Error: ENOENT: no such file or directory, open 'ayni'` ile düştü. Neden?

**Sebep:** `config.<isim>.json` üreten node script'i **tek tırnaklı shell string**
içindeydi ve içindeki Türkçe JS yorumu kesme işareti barındırıyordu:

```
// instance'lar ayni dosyaya yazmasin diye yine de instance'a ozel yapilir.
```

Shell için ilk kesme işareti string'i **kapatıyor**, ikincisi yenisini açıyordu.
Node'a giden `-e` script'i satırın ortasından kesiliyor, kalan kelimeler
(`ayni`, `dosyaya`, `yazmasin`, …) argüman olarak node'a geçiyordu →
`process.argv.slice(1)` ile `src="ayni"` → `readFileSync("ayni")`.

**İki okuma yolu da sessiz kaldı:** kesme işareti sayısı çift olduğu için tırnaklar
dengeli görünüyor, `bash -n` temiz geçiyordu. Kesilen JS de geçerliydi — `//` yorumu
string sonuna kadar uzadığı için node da syntax hatası vermiyordu. Hata ancak çalışma
anında, yanlış dosya yolunda ortaya çıktı.

**Karar:** JS artık **tırnaklı heredoc** ile veriliyor (`-e "$(cat <<'JS' … JS )"`).
Tırnaklı heredoc'ta kesme işareti, `$` ve backtick zararsız; Türkçe yorumlar olduğu
gibi kalabiliyor. Yorumları ASCII'leştirmek (kesme işaretlerini silmek) alternatifti
ama aynı tuzak bir sonraki Türkçe yorumda yeniden kurulurdu — kurucu sorun quoting'di.

**Doğrulama (yerel, VPS'te değil):** blok `config.example.json` üzerinde çalıştırıldı;
üretilen dosya geçerli JSON, gerçek newline ile bitiyor, `_README` silinmiş,
`paths.runtime` → `./runtime/stream2`, `output.localPath` → `./runtime/stream2/out.flv`.
Ayrıca gerçek `loadConfig` ile yüklendi: OK. 375 test geçiyor. Son satırdaki
`+"\n"` incelendi ve DOGRU bulundu (tek tırnakta backslash literal olduğundan JS
`\n` kaçışını görüyor); heredoc'ta da aynı şekilde literal olduğu için olduğu gibi taşındı.

**Hâlâ açık:** `add-stream.sh`'in tamamı (systemd template unit yazımı, `enable --now`,
ikinci stream key ile canlı yayın) VPS'te doğrulanmadı. Bu kayıt yalnızca config üretim
adımını kapsıyor.

---

## [Faz 9 A] "already-live" kararina ingest sagligi katildi (stale tespiti) — 2 Ekim 2026

**Olay (1 Ekim):** yt-streamer servisi ~2 saat durmus kaldi. Tekrar baslatildiginda
ffmpeg saglikli akti (`speed=1x`) ama go-live "already-live" demeye devam etti:

```json
{"broadcastId":"hSqzx1FiX_k","liveStatus":"live",
 "ingest":{"streamStatus":"inactive","healthStatus":"noData"}}
```

**Sebep:** `#existingBroadcast` idempotans kararini YALNIZCA `lifeCycleStatus`
(`live/testing/liveStarting`) uzerinden veriyordu. `getStreamStatus` kodda vardi ama
sadece `getStatus({refresh:true})` yolunda kullaniliyordu — `goLive()` yolunda hic
sorulmuyordu. Yayin kanalda "live" gorunurken veri almiyordu ve sistem "her sey yolunda"
sayip hicbir sey yapmadi.

**Iki emniyetin ikisi de bu koseye kordu:** process exit kontrolu (ffmpeg ayakta) ve
`speed` guard'i (SONUC.md R1) — olu-ama-acik sokete yazan ffmpeg'in speed'i 1.00x kalir.

**Karar: otomatik kurtarma YAPILMIYOR (A fazi salt-okunur).** Broadcast'i `complete`'e
alip yenisini acmak ise yaramaz: ingest **stream'in** ozelligi, broadcast'in degil. Yeni
broadcast de `transition('live')` edilemez (ingest hala inactive) ve kanalda biri
`complete` biri `created` iki cop yayin kalir — ustelik `complete` geri alinamaz. Gercek
kurtarma ffmpeg'in RTMP oturumunu yenilemeyi gerektirir, o da encoder surecinin isi.
Otomatik kurtarma (B fazi) ayri ve sonra: stale tespit → encoder RTMP yenile → ingest
aktif olana kadar bekle → broadcast hala `live` ise DOKUNMA, degilse insert/bind/transition.
Eski broadcast, yeni ingest aktif oldugu dogrulanana kadar sonlandirilmaz.

**Esikler ve gerekceleri:**
- `staleGraceMs = 60000`: ingest saglikli degilse hemen stale denmez, 60 sn izlenir.
  Neden sart: her albüm gecisinde ffmpeg yeniden basliyor (Faz 3.1 B), RTMP oturumu
  yenileniyor ve ingest'in kisa sure `inactive` gorunmesi NORMAL. Tek ornege bakmak
  albüm sinirina denk gelen her tetikte yanlis alarm uretirdi. Esik boylece tahmin degil
  olcum: "encoder'a, biz izlerken, toparlanmasi icin verilen sure". 60 sn = soguk
  baslangic butcesinin (120 sn) yarisi, gozlenen yeniden baglanma suresinin kat kat ustu.
- `streamStatus` otorite, `healthStatus === 'noData'` saglıksız. **`bad` stale SAYILMAZ**:
  veri geliyor ama sorunlu demektir (bitrate/keyframe); bunun icin calisan bir yayini
  reddetmek yanlis olurdu — yalnizca `warn`.
- Periyodik kontrol (A′) `60 sn`, **3 ardisik** saglıksız ornekte alarm (~3 dk). Tek
  ornek yetmez (albüm gecisi dipleri, API teklemesi). API HATASI saglıksızlık kaniti
  SAYILMAZ: sayac artmaz, yoksa kota/ag teklemesi olu olmayan yayin icin alarm uretir.

**Kota:** yoklama basina 1 birim (`liveStreams.list`), 60 sn ile 1440 birim/gun —
10.000'lik gunluk kotanin ~%14'u, iki yayinda ~%29'u. Kayitta canli broadcast yokken
hic API cagrisi yapilmaz (`checkIngestHealth` erken doner).

**HTTP 409 (`stale_broadcast`), 200 + `action:'stale'` DEGIL:** telefon kestirmesi
(Shortcuts) durum kodunu ozel olarak kontrol etmedikce 200'u basari gibi gosterir. Bu
ariza elle mudahale istiyor, gorunur olmali.

**Neden periyodik kontrol sart (A′):** A yalnizca TETIKLENDIGINDE calisir; 1 Ekim'de
kimse tetiklemedi, kimse bakmadi. Tetikler arasindaki korlugu kapatan tek sey periyodik
kontroldur. `IngestHealthMonitor` go-live HTTP surecinde yasar (YouTube API ve broadcast
kaydi orada); `setInterval` degil `setTimeout` zinciri — yavas bir yoklama cagrilari
ust uste bindirmesin.

**Kapsam disi:** TUI/dashboard broadcast durumunu hic bilmiyor (ayri surec, `index.js`
YouTube API'yi tanimaz) — saglik gostergesi oraya eklenmedi, surecler arasi tesisat
kurmak bu fazin isi degil. Durum `GET /status` (health, unhealthySince, healthy) ve
loglardan izlenir.

**Dogrulama:** 389 test gecer (14 yeni). VPS'te dogrulanmadi: gercek stale senaryosu
(Studio'dan elle sonlandirip tetikleme) ve periyodik kontrolun canli yayinda davranisi.

---

## [Faz 1 / SORUN 1] Servis durursa haber verme: HealthMonitor + kontroller + ntfy — 2 Ekim 2026

**Olay:** `yt-streamer` test sirasinda durduruldu ve ~2 saat fark edilmeden oyle kaldi.
Hicbir alarm yoktu. systemd'nin `OnFailure=`'i bunu yakalamaz: elle `stop` bir "failure"
degildir, unit temiz sekilde inactive olur.

**Kalp atisi olarak `state.json`:** `stream-orchestrator` her progress tikinde (5 sn)
`stateStore.save()` cagiriyor — yani dosyanin mtime'i canli yayinin nabzi. **Yeni bir
kalp atisi dosyasi EKLENMEDI**: ikinci bir yazma yolu iki yerde bakim ve sessiz
tutarsizlik riski demekti. Bu olcumun yakaladiklari: servis durdurulmus/disable edilmis,
surec cokmus/crash-loop, node ayakta ama ffmpeg olu (progress gelmezse save da olmaz).
Esik **120 sn** = 24 kacan tik; albüm gecisi restart boslugu ~225 ms, soguk baslangic
~450 ms (Faz 3.1 olcumleri) — yanlis alarm payi kat kat.

**IngestHealthMonitor → HealthMonitor refactor'u (bir commit sonra):** A′'da yazilan sinif
tek kontrolu olan ozel bir zamanlayiciydi. Ikinci kontrol eklemek ikinci timer, ikinci
esik mantigi ve ikinci tekrar-bastirma politikasi demekti. Kontroller ayri nesneler
(`IngestCheck`, `EncoderHeartbeatCheck`; sozlesme `{ name, run() -> {status,message,detail} }`)
olunca yeni kontrol eklemek monitoru DEGISTIRMIYOR. Eski sinif ve testi silindi, davranis
testleri tasindi — olu kod birakilmadi.

**`status: 'skipped'` ucuncu durum olarak:** "olculecek sey yok" (yayin hic baslamamis,
kayitta canli broadcast yok) saglıksızlık DEGILDIR. Olmasa yeni bir VPS'te ya da bilerek
kapatilmis bir instance'ta her 3 dakikada bildirim giderdi.

**Bildirim kanali — ntfy.sh:** `Alerter` arayuzu application'da, `WebhookAlerter`
infrastructure'da (yerleşik fetch, sifir bagimlilik). Hesap gerektirmemesi ve telefonda
tek konu adiyla calismasi secim sebebi. Konu adi bir SIRDIR: `.env.youtube` (chmod 600)
icinde durur, loglara yalnizca host yazilir. HTTP baslıklari ASCII disi karakter
tasiyamadigi icin baslik sadelestirilir (Turkce harfler cevrilir), govde UTF-8 kalir.
URL bos ise `NullAlerter` devreye girer: izleme calisir, yalnizca log'a yazar (bugunku
davranis) ve acilista bunu soyleyen bir uyari basilir.

**Olu adam anahtari (healthchecks.io) SART:** yerel izleyici kendi olumunu bildiremez.
`yt-golive` cokerse ya da VPS tamamen giderse ntfy'ye de kimse yazamaz. Cozum tersine
cevirmek: saglikli her turda dis servise ping atilir, **ping susarsa** dis servis haber
verir. Ping yalnizca butun kontroller saglikliyken atilir; `skipped` ping'i ENGELLEMEZ
(yayini bilerek kapatinca dis alarm calmasin diye).

**Bildirim/ping ASLA turu dusurmez:** kanal bozuksa izleme surmeli. `WebhookAlerter`
kendi hatalarini yutar, `HealthMonitor` ayrica try/catch ile sarar. Kontrolun kendi
hatasi (ag/kota/EACCES) ise saglıksızlık KANITI SAYILMAZ — sayac artmaz, yoksa YouTube
API tekledikce olu olmayan yayin icin alarm verilirdi.

**`/status` → `health`:** izlemenin son turundan okunur, API'ye gitmez (kota harcamaz).
`GoLiveServer` opsiyonel `healthProvider` alir; verilmezse yanit eskisi gibi.

**Dogrulama:** 415 test gecer (33 yeni; 7 eski monitor testi tasindi). Yerelde gercek
dosya ile uctan uca duman testi: taze `state.json` → healthy + ping, 5 dk eskitilmis
dosya → esikte unhealthy, ping susuyor, alarm ve snapshot dogru. VPS'te dogrulanmadi:
gercek ntfy teslimi, healthchecks ping'i ve canli yayinda esiklerin davranisi.

**Kapsam disi (sonraki fazlar):** go-live'in 202 ile hemen donmesi (SORUN 2 — bu bildirim
kanali ona onkosul), deploy'un disabled instance'a dokunmamasi (SORUN 3), maskelemenin
tum scriptlere yayilmasi (SORUN 4).

---

## [Faz 2 / SORUN 2] go-live istegi hemen doner: 202 + hizli on kontrol — 2 Ekim 2026

**Sorun:** `yt-streamer` durup tekrar basladiginda ingest 'active' olana kadar go-live
120 sn'ye kadar bekliyor (3 sn araliklarla yoklama). iOS Shortcuts'in HTTP timeout'u
bundan kisa: istek zaman asimina ugruyor, oysa arka planda surec DOGRU calisiyordu.

**Karar:** `requestGoLive()` HTTP'nin yeni giris noktasi — uzun kismi arka planda surdurur,
**202 `accepted`** ile hemen doner. Sonuc `/status` → `lastRun` ({phase, startedAt,
finishedAt, action, error}). `goLive()` (senkron tam akis) DEGISMEDI: CLI onu kullanmaya
devam ediyor, terminalde timeout sorunu yok ve sonucu beklemek dogru davranis.

**Plandaki "on kontrolde stale yakalanirsa 409" DUZELTILDI.** Tek bir ingest ornegine
bakip stale demek YANLIS olur: albüm gecisinde ffmpeg yeniden baglanirken ingest kisa
sure 'inactive' gorunur — zaten `staleGraceMs` bunun icin var. Grace olmadan 409 donmek,
albüm sinirina denk gelen her tetikte yanlis ret uretirdi. Senkron reddedilenler yalnizca
KESIN bilinebilenler:

1. **`encoder_not_streaming`** — `state.json` kalp atisi 120 sn'den eski. ffmpeg basmiyor,
   ingest beklemek bosuna; dahasi en sik sebep bu (1 Ekim olayi). Maliyet: 1 stat, SIFIR
   API cagrisi. Ayni `EncoderHeartbeatCheck` nesnesi hem periyodik izlemede hem burada
   kullaniliyor — iki esik / iki politika olusmasin.
2. **`stale_broadcast`** — kayitta zaten `health:'stale'` izi var VE taze ornek de olu.
   Grace bir onceki turda harcandigi icin tekrar beklenmez. Iz varken ingest toparlanmissa
   iz gecersiz sayilir ve akis normal yoluna devam eder.
3. **`already-live`** (200) — kayitli broadcast aktif VE ilk ingest ornegi sagliklı.
   Ucuz (2 kota birimi) ve kesin; telefon arka plani beklemesin.

Belirsiz her durumda 202 donulur ve karar arka planda, grace penceresiyle verilir.

**Arka plan hatasi BILDIRIM gonderir:** 202 dondukten sonra hatayi gorecek kimse
olmayabilir. Bu yuzden Faz 1'in bildirim kanali bu fazin ON KOSULUDUR — kanal olmadan
202'ye gecmek gorunurlugu dusururdu. `GoLiveService` opsiyonel `alerter` alir (yine
HealthMonitor'daki ayni nesne).

**Arka plan promise'i yeniden FIRLATMAZ:** onu bekleyen kimse yok, islenmeyen ret
(unhandledRejection) sureci dusurebilir. Hata `lastRun.phase='failed'` + bildirim +
error log ile gorunur hale gelir.

**Kilit:** `inFlight` ayni kilit olarak kullaniliyor — arka plan surerken ikinci tetik
`busy` (409) alir, cift dokunma iki broadcast yaratmaz.

**Dogrulama:** 429 test gecer (11 yeni + sunucu testleri yeni sozlesmeye tasindi).
VPS'te dogrulanmadi: Shortcuts'tan gercek tetik, 202 sonrasi `/status` ile sonuc izleme.

**Kapsam disi:** deploy'un disabled instance'a dokunmamasi (SORUN 3), maskelemenin tum
scriptlere yayilmasi (SORUN 4).

---

## [Faz 3 / SORUN 3] Park edilmis instance'a deploy dokunmuyor — 2 Ekim 2026

**Olay:** `yt-streamer@stream2` stop+disable edildi, sonraki deploy'da "active running"
oldu. VPS kaniti (`UnitFileState=disabled`, `multi-user.target.wants/` icinde yok) bugun
gercekten disabled oldugunu gosterdi; sebep deploy.sh DEGIL, ENOENT duzeltmesini test
ederken `add-stream.sh stream2`'nin tekrar calistirilmasiydi — script sonunda
`systemctl enable --now` var. Yani kapatma niyeti hicbir yerde KAYITLI DEGILDI, yalnizca
systemd durumunda yasiyordu ve bir komut onu sessizce geri cevirdi.

**Iki ayri duzeltme:**

**1) Niyeti repoda kaydet — park isareti `.env.<isim>.disabled`.** Dosya varsa deploy
dokunmuyor, `add-stream.sh` yapilandirmayi guncelliyor ama baslatmiyor (`--force` ister),
saglik izlemesi o instance icin durakliyor. Isaret systemd durumunu EZIYOR: niyet
dosyada oldugu icin `systemctl enable` ya da scriptin tekrar calistirilmasi gibi kazalar
karari bozamiyor. Ana yayin icin ayni sozlesme (`.env.disabled`).

**2) `is-enabled --quiet` yerine UnitFileState beyaz listesi.** Bugunun sebebi olmasa da
gercek bir kusurdu: `systemctl is-enabled --quiet` cikis kodu 'static', 'indirect',
'generated' ve 'transient' durumlarinda da 0 doner. Unit bunlardan birine duserse eski
kod onu "enable edilmis" sayip restart ederdi. Artik yalnizca `enabled` ve
`enabled-runtime` restart edilir; **tanimadigimiz durumda dokunulmuyor** (fail-safe).

**Karar ayri dosyada (`scripts/deploy/lib/instance-state.sh`):** deploy.sh git pull/npm ci
yaptigi icin uctan uca test edilemez. Karar bir fonksiyona cikinca sahte systemctl ile
test edilebilir oldu — 'static'/'indirect'/'generated'/'transient' tuzaklarinin her biri
icin ayri test var (test/scripts/instance-state.test.js).

**Glob tuzagi:** `.env.*` dongusu `.env.stream2.disabled`'i "stream2.disabled" adli bir
yayin sanardi — `*.disabled` acikca atlaniyor.

**Izleme duraklatmasi monitor seviyesinde, kontrol seviyesinde DEGIL:** `paused()` true
iken HICBIR kontrol calismiyor (hepsi 'skipped', sayaclar sifirlaniyor). Yalnizca encoder
kontrolunu muaf tutmak yetmezdi: park edilmis bir yayinin `broadcast.json` kaydi 'live'
kalmis olabilir ve ingest kontrolu alarm uretirdi. Tek kavram, iki kontrolu birlikte
kapsiyor. **Ping ATILMAYA DEVAM EDIYOR**: park etmek bilincli bir karar, healthchecks.io
da alarm calmasin.

**Dogrulama:** 449 test gecer (20 yeni: 11 kabuk karari + 4 duraklatma + 5 file-stat).
VPS'te dogrulanmadi: gercek deploy'da park edilmis instance'in atlanmasi ve add-stream.sh
--force yolu.

**Kapsam disi:** maskelemenin tum scriptlere yayilmasi (SORUN 4, siradaki faz).

---

## [Faz 4 / SORUN 4] Key maskeleme tek kaynakta, tum scriptlerde — 2 Ekim 2026

**Durum tespiti:** maskeleme yalnizca `status.sh` icinde, satir ici bir fonksiyon olarak
duruyordu. Denetimde gercek sizinti noktalari:
- `add-stream.sh` ve `install-service.sh` → `systemctl status` (ana surecin komut
  satirini basar, orada ffmpeg'in RTMP URL'si var) **siziyordu**
- `deploy.sh` → restart basarisizliginda `journalctl -u <unit> -n 20` **sizdirabilirdi**
- `install-golive-service.sh` → `systemctl status` (bu unit'in cmdline'inda key yok ama
  son journal satirlarini basiyor) — tutarlilik icin o da maskeden geciyor
- `sweep-orphan-ffmpeg.sh` **temizdi** (argumanlari bilerek hic basmiyor, kendi
  basliginda yazili) — degistirilmedi
- `check-env.sh` **temizdi** (yalnizca key ADLARINI basiyor, degerleri asla)

**Karar:** maske `scripts/deploy/lib/mask.sh`'a cikti, `status.sh` dahil bes script onu
source ediyor. Kopya kural birakmak, zamanla ayrisan iki maske demekti (check-env ile
ayni gerekce: tek sozlesme, tek yer).

**Fail-closed:** `mask_require` maskenin calistigini bilinen bir ornekle KANITLAR; sed
ya da process substitution yoksa cagiran o ciktiyi **hic basmaz** (yerine nereye bakilacagini
soyler). Maskesiz basmak, hic basmamaktan kotudur — sizmanin bedeli rotasyon.

**Kapsam genisledi:** deger bazli katman artik `ALERT_WEBHOOK_URL` (ntfy konu adi),
`HEARTBEAT_PING_URL` ve `GOLIVE_AUTH_TOKEN`'i da maskeliyor. Faz 1'de eklenen ntfy konu
adi bir sirdir (bilen herkes dinleyebilir ve bildirim yayinlayabilir) ve auth token
canli yayin baslatabilen bir endpoint'in anahtari.

**Aliskanligi degistirmek:** `deploy.sh` ve `add-stream.sh` artik log ipucu olarak ONCE
maskeli yolu (`status.sh`) oneriyor, ciplak `journalctl`'i "MASKESIZ, key icerir" etiketiyle
ikinci sirada veriyor. Maskeleme ancak alisilan komut maskeli olursa ise yarar.

**`.env.example` ve `.disabled` okunmaz:** ornek dosyada gercek deger yok; park isareti
(Faz 3) bos dosya. Bos/kisa (<8 karakter) degerler kural uretmiyor — yoksa "s###" gibi bir
kural ciktinin her yerini bozardi.

**Dogrulama:** 462 test gecer (13 yeni). Testler sahte `.env` dizini (MASK_ENV_DIR) ile
calisiyor: URL ici key, ciplak key, rotasyon oncesi key, instance env dosyalari, bildirim
sirlari, yanlis pozitif yoklugu ve fail-closed davranis. VPS'te dogrulanmadi: gercek
`systemctl status` / `journalctl` ciktilarinin maskeli basilmasi.

**Hatirlatma:** bugun gorulen iki key rotasyon bekliyor (Studio -> yeni key -> .env ve
.env.stream2 guncelle -> restart). Maskeleme gelecegi korur, gecmisi degil.

## [Faz 5] Overlay dikey konumu config'den: `overlay.bottomOffset` — 2 Ekim 2026

**Sorun:** overlay metni ekranin dibine cok yakindi; YouTube oynaticinin kontrol/ilerleme
cubugu o bandi kapatinca basliklar kesiliyordu. `y=h-80` ffmpeg-encoder.js'te SABIT
kodluydu (Faz 4'te dogrulanmis deger), ayarlamak icin kod degisikligi gerekiyordu.

**Karar:** `OVERLAY_POSITIONS` sabit tablodan fonksiyon tablosuna dondu; alt konumlar
`y=h-${bottomOffset}` uretiyor. Deger `config.broadcast` degil `config.overlay`
altinda — overlay'in bir stil ozelligi.

**Geriye uyumluluk:** alan yoksa 80. Eski config'ler birebir ayni ffmpeg komutunu
uretir. Varsayilan BILEREK yukseltilmedi: davranis degisikligi config'de gorunur
olsun, sessizce olmasin.

**Ust konumlar sabit (40) kaldi:** ustte kesilme sorunu yok, ayarlanabilirlik bedava
degil (ikinci alan, ikinci dogrulama, ikinci test).

**Dogrulama:** `bottomOffset` pozitif sayi olmali, degilse `FfmpegEncoder` KURULURKEN
atar — yayin ortasinda degil, baslangicta. 720p'de 100 ≈ alt kenara 72px (cubugun ustu).

## [Faz 5] Canli public + VOD liste disi: API'de yok, bitiste cevirme — 2 Ekim 2026

**Istek:** canli yayin herkese acik kalsin (izleyici + sohbet), ama yayin bitince olusan
VOD (kayit) herkese acik OLMASIN.

**API'de karsiligi YOK.** Sebep alan eksikligi degil, veri modeli: broadcast ile VOD
AYNI videodur, ayni id. Dokumanin ifadesi: "the broadcast represents exactly one YouTube
video, so the privacy settings are identical to those supported for videos". Yani
`status.privacyStatus` TEK bir alan, hem canliyi hem kaydi yonetiyor. "Canliyken public,
sonra unlisted" insert govdesinde temsil edilemez — zaman icinde DEGISEN bir deger.

Tek tek bakilan ve ise yaramayan alanlar:
- `status.recordingStatus` — **salt okunur** (notRecording/recording/recorded)
- `contentDetails.recordFromStart` — kaydin alinip alinmamasi, gizlilikle ilgisi yok
- `contentDetails.availabilityConfig` — adi umut verici ama **cografi kisitlama**
- `privacyStatusAfterStreamEnds` gibi bir alan hic yok

Studio'daki "tekrar videosunu liste disi yap" kutusu gercek ama ise yaramaz: kanal ayari
degil YAYIN BASINA ayar, ve bizim yayinlar her go-live'da API ile YENIDEN olusuyor —
elle isaretlenecek bir yayin yok.

**`recordFromStart: false` DENENDI ve REDDEDILDI.** Tek seferlik sonda ile dogrulandi:

    A: recordFromStart:false + enableDvr:false
       403 "The user is not permitted to disable recording."
       [reason=disableRecordingNotAllowed]
    B: kontrol — mevcut uretim govdesi
       KABUL EDILDI (recordFromStart=true enableDvr=true)

Kontrolun gecmesi kritik: sorun kimlik/kota degil, SADECE kaydi kapatmak yasak. Dokuman
diyor: "can only be set to false if the broadcasting channel is allowed to disable
recordings". Bu izin kullanici tarafindan acilamiyor (dokumante bir yol yok).
**Bu yuzden insert govdesine `recordFromStart` KOYULMAMALI** — koyulsa her go-live 403
ile duser, yayin hic acilmaz. Bunu koruyan bir test var (youtube-broadcasts.test.js).

**Karar:** kayit alinir, yayin bitince VOD'un gizliligi `videos.update` ile cevrilir.
`config.broadcast.vodPrivacy` (varsayilan `null` = dokunma).

**Mimari bulgu — "yayin bitti" OLAYI YOK:** `transition('complete')` bu sistemde hic
cagrilmiyor (tek transition `'live'`), Supervisor ve HealthMonitor broadcast'ten habersiz.
Bitis YALNIZCA `GoLiveService#existingBroadcast` kayitli broadcast'in lifeCycleStatus'unu
`complete` gorunce anlasiliyor — ve orasi `broadcast.json`'i SILIYOR, id o anda kaybolur.
Bu yuzden kuyruga yazma `clear()`'dan ONCE.

Bu zayiflik degil avantaj: kesif noktasi bellekteki bir event degil DISKTEKI duruma
dayaniyor, cokuse dayaniklilik neredeyse bedava geliyor.

**Kalici kuyruk** `runtime/vod-pending.json` (`PendingVodStore`). `broadcast.json`'a
yazilamaz cunku o dosya tam bu anda siliniyor; ayrica omurleri farkli (bekleyen is API
hatasi surerse gunlerce kalir). Basarili cevirmeler listeden duser, basarisizlar KALIR.

**Iki tetik:** (1) kesiften hemen sonra (token elde, ek maliyet yok) — yaygin durumda
saniyeler icinde cevrilir; (2) `checkIngestHealth()` basinda, yani HealthMonitor
temposunda (~60 sn) — cokme/API hatasi sonrasi kurtarma. **Kuyruk bossa hic API cagrisi
yapilmaz**, "yayin kapaliyken kota harcanmaz" sozu korunur.

**`videos.update` ONCE OKUYOR:** gonderilen part'i BUTUN olarak degistiriyor; status
gonderip icine yalnizca privacyStatus koyarsan `selfDeclaredMadeForKids`, `license`,
`embeddable` varsayilana doner. Mevcut status okunur, uzerine yazilir. 1 ek birim kota —
bir alani sessizce sifirlamanin bedelinden ucuz.

**Kabul edilen takas:** cevirme ANINDA degil. Sistem bitisi ancak periyodik tur ya da bir
go-live/status cagrisinda ogreniyor → VOD ~60 sn public kalabilir. Anlik yapmanin tek
yolu yayin sonlandirmayi sisteme almak (`transition('complete')`), bu cok daha buyuk bir
degisiklik ve "YouTube kapatsin" davranisini bozar.

**Hatalar yayini DUSURMEZ:** kuyruga yazamamak da, cevirememek de yalnizca uyari loglar.
`#saveState`'in tersi — orada yazamamak IKINCI bir broadcast demekti, burada yalnizca bir
gizlilik ayari kaciyor.

**Gecmis VOD'lar:** `scripts/youtube/unlist-past-vods.js`. Varsayilan KURU CALISMA,
gercek degisiklik icin `--apply`. Yalnizca `complete` olanlar — canli yayini liste disina
almak izleyiciyi aninda dusururdu. Kanalda 21 broadcast: 2 bitmemis (atlandi), 13 zaten
private, **6 public complete** cevrildi.

**Not:** `config.json`'da `broadcast` bolumu YOKTU, yani `privacyStatus` varsayilandan
(`unlisted`) geliyor — ama canli yayin (XpwWzSY4QMc) public. Yeni broadcast'ler unlisted
acilacak. Canli yayinin public olmasi isteniyorsa `broadcast.privacyStatus: "public"`
ayrica eklenmeli; bu Faz 5'te BILEREK degistirilmedi (dis dunyaya donuk bir degisiklik,
karar kullanicinin).

---

## [Faz A] Tekrarlayan çökmede vazgeçme kaldırıldı — 2 Ekim 2026

**Soru:** Crash loop koruması (5 dk'da 5 çökme → `gave-up`, yayını bırak) gerçekten
istediğimiz şeyi mi yapıyor?

**Bulgu — koruma üretimde hiç devreye girmiyordu.** `Supervisor` vazgeçince `index.js`
yalnızca `process.exitCode = 1` yapıyordu. Logger tamamen senkron (`appendFileSync`),
başka açık handle da yok → event loop boşalıyor ve süreç gerçekten çıkıyordu. Unit'te ise
`Restart=always` + `RestartSec=15` var ve `StartLimit*` **yoktu**. systemd'nin varsayılan
limiti (5 başlatma / 10 sn) `RestartSec=15` yüzünden hiç tetiklenmiyor. Sonuç:

- "Yayın kalıcı olarak durur" **olmuyordu**: systemd 15 sn'de bir yeni süreç açıyordu.
- Ama supervisor'ın frenleri de boşa çıkıyordu: her yeni süreçte `crashTimes` boş,
  `attempt = 0`, yani backoff sürekli 3 sn'den başlıyordu.
- `KARARLAR.md`'deki Faz 1 "bilinen risk" notu (26 Eylül) bu yüzden yanlıştı; düzeltme
  notu o bloğa eklendi.

**Karar — vazgeçme tamamen kaldırıldı, hız korunarak.** İstenen davranış zaten bunun
tersiydi: uzun bir ağ kesintisinde (modem reseti) yayın kendiliğinden dönmeli ve
toparlanma hızından ödün verilmemeli.

- `gaveUp` / `'gave-up'` → `crashLoop` / `'crash-loop'`. Eşik aşımı artık yeniden
  başlatmayı **durdurmuyor**, yalnızca "bu yayın sağlıklı değil" işareti.
- Gecikme dizisi ve 60 sn tavanı **değişmedi**. Uzatmak (ör. 5 dk'ya çıkarmak)
  düşünüldü ve bilerek reddedildi: sürekli çöken bir yayında bile dakikada bir deneme
  olması isteniyor.
- Alarm politikası `HealthMonitor`'daki ile aynı: eşikte **bir kez** bildirim + ERROR,
  sonraki çökmelerde yalnızca WARN. Yeniden başlatmadan sonra `resetAfterMs` (5 dk)
  çökmeden çalışırsa durum temizlenir ve "düzeldi" bildirimi gider — TUI de kırmızıda
  kilitli kalmıyor (eskiden `gaveUp` bir daha asla temizlenmiyordu).
- Bildirim **await edilmiyor** (`#notify` fire-and-forget + catch): çökme anında bir
  webhook isteği backoff'u geciktirmemeli, bozuk kanal gözetmeni düşürmemeli.

**systemd:** `StartLimitIntervalSec=0` **iki** şablona da eklendi
(`install-service.sh` tek yayın unit'i ve `add-stream.sh` `yt-streamer@.service`
template'i). Zaten fiilen sınırsızdı; artık kazara değil **karar**. `[Service]` değil
`[Unit]` bölümüne yazılır. Unit'i `failed`'a düşürüp yayını kapatmak bilerek seçilmedi:
alarm uygulama içinden geliyor, yayının kapanması istenen davranış değil.

**Bildirim kanalı yayın sürecine girdi.** `index.js` artık `WebhookAlerter` kuruyor —
`HealthMonitor`'un kullandığı AYNI sınıf, ikinci bir bildirim yolu açılmadı. URL
`.env.youtube`'dan geliyor ama `loadYoutubeCredentials()` **kullanılamazdı**: o
CLIENT_ID/SECRET/REFRESH_TOKEN eksikse atıyor ve yayın sürecinin YouTube kimliğine
bağımlı olmaması bilinçli bir karar (bkz. `scripts/golive-server.js` başlığı). Bu yüzden
aynı modüle zorunlu key istemeyen, hiç atmayan `loadAlertChannel()` eklendi — `.env.youtube`
ayrıştırması tek yerde (`reader`) kaldı.

**Yan bulgu — `[json]` etiketi.** Bildirim etiketi türetmesi (`config.stream2.json` →
`stream2`) `golive-server.js`'te tek satırdı ve `config.json` için **`"json"`**
üretiyordu: `^config\.?` öneki sondaki noktayı da yiyor, geriye `.json` kalmıyordu. Yani
varsayılan instance'ın tüm bildirimleri `[json]` etiketiyle gidiyormuş. Türetme
`src/config/parse-args.js`'e `instanceLabel()` olarak taşındı (yayın süreci ve go-live
aynı etiketi üretmek zorunda), sıra düzeltildi (önce uzantı, sonra önek) ve test edildi.

**Testler:** `supervisor.test.js`'teki "vazgeçer, yeniden başlatmaz" testi yerine 6 test:
eşikte alarm + yeniden başlatma devam, alarm tekrarlanmıyor, 5 dk sonra "düzeldi",
toparlanma beklenirken gelen çökme kontrolü iptal ediyor, `stop()` de iptal ediyor, bozuk
bildirim kanalı restart'ı etkilemiyor.

---

## [Faz B] Orphan sweep restart yoluna girdi (ExecStartPre) — 2 Ekim 2026

**Soru:** Faz 7'de kapatılan "aynı key'e iki ffmpeg" deliği gerçekten kapandı mı?

**Bulgu — hayır, yalnızca deploy yolunda kapandı.** `sweep-orphan-ffmpeg.sh`'in tek
çağıranı `deploy.sh` idi. Oysa yetim bırakan yol tam olarak **systemd restart**: ffmpeg
kesilemez bir I/O'da takılırsa `TimeoutStopSec=30` doluyor, systemd node'u SIGKILL ediyor,
ffmpeg PPID=1'e düşüp yayına bağlı kalıyor. Üstüne, alarm mesajlarının operatöre söylediği
düzeltme de birebir `systemctl restart yt-streamer`
(`encoder-heartbeat-check.js`, `ingest-check.js`) — yani sistem, deliği açan komutu
çözüm olarak öneriyordu. Faz A'daki sınırsız otomatik restart bunu birleştiriyor: SIGKILL →
15 sn → süpürülmemiş restart.

**Karar:** her iki unit şablonuna (`install-service.sh` tek yayın unit'i ve
`add-stream.sh` `yt-streamer@.service` template'i) tek satır:

```
ExecStartPre=-/bin/bash $REPO_ROOT/scripts/deploy/sweep-orphan-ffmpeg.sh
```

- `-` öneki **bilinçli**: sweep başarısız olsa bile yayın başlar. Script'in kendi "deploy'u
  durdurmaz, amaç restart'ın önünü temizlemek" ilkesinin (bkz. script başlığı) unit
  karşılığı.
- `/bin/bash <yol>` biçimi şart: script `100644` (çalıştırma biti yok), systemd de
  `ExecStartPre`'da mutlak bir ikili bekliyor. `deploy.sh` de aynı şekilde `bash` ile
  çağırıyor.
- **Çoklu instance güvenli:** sweep repo genelinde tarıyor ama "meşru = ebeveyni bu
  repodan çalışan CANLI bir `node .../index.js`" tanımı diğer instance'ların ve elle
  başlatılmış yayınların ffmpeg'ini koruyor. ExecStartPre anında bizim node'umuz henüz
  doğmadığı için yalnızca gerçek yetimler orphan sayılıyor. (Yanlış pozitif, Faz 7'de de
  "en kritik risk" diye işaretlenmişti ve ayrı testi var.)
- `deploy.sh`'teki çağrı **kaldırılmadı**: idempotent, exit 0 ve systemd dışı yolları da
  (elle `node index.js`) kapsıyor. İki yerde olması zarar değil, kapsam farkı.

Bu karar, Faz 7'deki "`install-service.sh` de ileride aynı kontrolü çağırabilsin"
notunu kapatıyor.

**Doğrulama:** heredoc'lar aynı değişkenlerle render edilip üretilen iki unit metni
gözle kontrol edildi (`%i` korunuyor, satır `[Service]` bölümünde ve `ExecStart`'tan
önce). VPS tarafı: `systemctl cat yt-streamer` + node'u `kill -9` edip restart sonrası
`ps -C ffmpeg -o pid,ppid,etime` tek süreç göstermeli.
