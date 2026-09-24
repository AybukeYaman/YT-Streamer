# Faz 4 — Now Playing Overlay (Claude Code Prompt)

> `PROMPTLAR\faz-4-overlay.md` olarak kaydet, aşağıdaki bölümü Claude
> Code'a ver.

---

## PROMPT BAŞLANGICI

### Mimari hatırlatma

Faz 2-3'teki katman ayrımına aynen uy: domain hiçbir modül import etmez,
application `child_process`/`fs`/infrastructure import etmez (bu kurallar
testle korunuyor, kırma).

### Çözülmesi gereken temel sorun

B yaklaşımında ffmpeg'e tek girdi olarak bir concat playlist veriliyor —
ffmpeg'in stderr çıktısında "şu an şu dosya çalıyor" diye bir bilgi **yok**,
sadece toplam `frame=` sayısı var. Yani "şu an hangi parça çalıyor" bilgisini
**biz hesaplamak zorundayız**:

- Video çıktısı sabit 24 fps, bu yüzden `geçenSaniye = frame / 24`
- Yazdığımız playlist'teki parçaların süreleri zaten biliniyor
  (`PlaylistWriter`'ın döndürdüğü liste). Bu sürelerin kümülatif toplamını
  çıkar: `[parça1Süre, parça1+parça2Süre, ...]`
- `geçenSaniye` bu kümülatif sınırların hangi aralığına düşüyorsa, o an
  çalan parça odur
- Sınır aşıldığında (yani hesaplanan indeks değiştiğinde) `nowplaying.txt`
  güncellenir — her `frame=` satırında değil, sadece değiştiğinde

Bu hesap sesle tam senkron olmayabilir (birkaç yüz ms sapma normal,
video/ses arası zaten Faz 2'de bilinen küçük bir kaymaya sahip), overlay
için bu kabul edilebilir hassasiyet.

**Proje kökü:** `C:\Users\Aybuke Yeni\Desktop\Youtube\YT Stream System`

Kurallar:
- **Aksi belirtilmedikçe otonom ilerle** — adımdan adıma geçerken durup
  onay bekleme. Sadece şu iki durumda dur: (1) prompt'ta açıkça "dur ve
  rapor ver" dediğim yerlerde, (2) beklenmedik bir hata ya da mimari
  kararla karşılaşırsan (örn. prompt'taki bir varsayım yanlış çıkarsa)
- Her dosya oluşturma/düzenlemeden sonra o dosyada kullanılmayan kod ya
  da çakışma var mı kontrol et — bunu ara adımlarda sessizce yap, sadece
  belirtilen durma noktalarındaki rapora dahil et
- Gerçek `music/` klasörü ve gerçek yayın komutuyla test et

---

### Adım 4.1-4.2 — Config, `NowPlayingWriter`, parça takibi

1. `config.json`'a ekle:
   ```json
   "overlay": {
     "enabled": true,
     "fontFile": "C:/Windows/Fonts/arial.ttf",
     "fontSize": 28,
     "position": "bottom-left"
   }
   ```
2. `src/application/now-playing-writer.js`:
   - `runtime/nowplaying.txt`'ye o an çalan parçanın başlığını yazar
   - Atomik yazma (Faz 2.5/3.4'teki `.tmp` → rename deseni, `atomic-file.js`
     zaten var, onu kullan)
   - **Uzun başlık taşması:** ekranda taşmayı önlemek için başlığı belli
     bir karakter sınırının (örn. 40) üzerindeyse `…` ile kısalt — ffmpeg
     `drawtext`'te dinamik font küçültme pratik değil, kısaltma en basit
     ve güvenilir çözüm
3. `StreamOrchestrator`'a parça takibi ekle:
   - Yeni bir playlist yazıldığında, `PlaylistWriter`'ın döndürdüğü parça
     listesinden kümülatif süre sınırlarını hesapla
   - Her ilerleme satırında (`frame=` parse edildiğinde) geçen saniyeyi
     hesapla (`frame / 24`), hangi parçada olunduğunu bul
   - Hesaplanan parça bir önceki hesaplanan parçadan farklıysa
     `NowPlayingWriter`'ı çağır
   - Playlist'in en başında (restart hemen sonrası) ilk parçayı hemen
     yaz — `frame=0` gelene kadar bekleme

**Test:** Gerçek playlist ile çalıştır (batchSize düşük tutulabilir, örn.
3), `nowplaying.txt`'nin içeriğinin parça geçişlerinde değiştiğini
logla ve doğrula.

**Bu iki adım bitince dur ve rapor ver.**

---

### Adım 4.3 — `drawtext` filtresi (`FfmpegEncoder`)

1. Mevcut `-vf scale=1280:720` filtresine `drawtext`'i **virgülle zincirleyerek**
   ekle (ffmpeg'de `-vf` tek kez kullanılır, birden fazla filtre virgülle
   ayrılır):
   ```
   -vf "scale=1280:720,drawtext=fontfile='<escaped>':textfile='runtime/nowplaying.txt':reload=1:fontsize=28:fontcolor=white:x=40:y=h-80:shadowcolor=black@0.6:shadowx=2:shadowy=2"
   ```
2. **Windows font yolu escape'i:** `config.overlay.fontFile` değerindeki
   sürücü harfinden sonraki iki noktayı (`C:` → `C\:`) kaçır, yolu düz
   bölüyle tut. Bunu için ayrı bir küçük fonksiyon yaz (`escapeFontPath`
   gibi), test et — bu PLAN.md'nin "en sık takılınan yer" dediği kısım
3. `overlay.enabled: false` ise `drawtext` filtresini hiç ekleme (sadece
   `scale` kalsın) — ileride overlay'siz test etmek isteyebiliriz
4. `textfile` yolunun da mutlak ve düz bölü olduğundan emin ol

**Bu adım bitince dur ve rapor ver.**

---

### Adım 4.4-4.5 — Uçtan uca test, özet ve temizlik

1. Gerçek `music/` klasörü, düşük `batchSize` (örn. 3) ile yayını başlat
2. En az bir parça geçişini gözlemle:
   - `nowplaying.txt` değişti mi
   - Kaç saniye içinde değişti (hesap ile gerçek geçiş arasındaki sapma)
3. Çıktı dosyasını (`runtime/out-*.flv`) VLC'de ya da bir kare çıkararak
   görsel kontrol et — yazı görünüyor mu, okunabilir mi, ekran dışına
   taşmıyor mu
4. **Uzun başlık testi:** `music/` klasöründeki en uzun başlıklı parçayı
   (varsa) kullanarak kısaltmanın çalıştığını doğrula. Yoksa geçici olarak
   uzun bir test dosyası adıyla dene
5. Özel karakter testi: parça adında `'` (tek tırnak) varsa `drawtext`
   içindeki metin de bundan etkilenebilir (concat'teki gibi) — `music/`
   klasöründe böyle bir dosya var mı kontrol et, varsa nasıl davrandığını
   raporla
6. Özet: yeni/değişen dosyalar, testler, gerçek test sonucu
7. Conflict/dead code kontrolü: tüm `src/` ağacı
8. Arkada kalan process kontrolü
9. `overlay.enabled: true` olarak bırak (üretim varsayılanı)

**Raporu ver ve dur.**

## PROMPT SONU

---

## Sonraki adım

Bu faz kapanınca PLAN.md'de Faz 4 satırı güncellenir, commit atılır.
Sırada Faz 5 (dayanıklılık) var — bu da RTMP gerektirmiyor, yerelde
6 saatlik test yapılabilir. Faz 1'in gerçek YouTube/RTMP testi hâlâ
erişim açılmasını bekliyor.
