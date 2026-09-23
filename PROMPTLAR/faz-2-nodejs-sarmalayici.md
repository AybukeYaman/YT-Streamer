# Faz 2 — Node.js Sarmalayıcı (Claude Code Prompt)

> `PROMPTLAR\faz-2-nodejs-sarmalayici.md` olarak kaydet, aşağıdaki bölümü
> Claude Code'a ver.

---

## PROMPT BAŞLANGICI

### Mimari hatırlatma

Bu, `scripts/normalize.js`'in aksine **kalıcı sistem kodu**. SOLID
prensiplerine ve katmanlı mimariye uy:

- **Domain** (`src/domain/`) — saf mantık, hiçbir I/O yok, `child_process`,
  `fs` gibi Node modüllerini import etmez
- **Application** (`src/application/`) — orkestrasyon, domain nesnelerini
  ve infrastructure arayüzlerini kullanır ama infrastructure'ın somut
  implementasyonlarını (örn. doğrudan `FfmpegEncoder`) bilmez, sadece
  arayüzlerini (`Encoder`) bilir
- **Infrastructure** (`src/infrastructure/`) — dış dünya: `child_process`,
  `fs`, `ffprobe` çağrıları buraya hapsedilir

**Kritik kural:** `StreamOrchestrator` (application) asla `child_process`'i
doğrudan çağırmaz. `Encoder` arayüzü üzerinden konuşur. Bu proje ileride
VPS'e taşınırken (Faz 7) infrastructure katmanı değişecek, application ve
domain aynı kalacak — bu ayrım o yüzden var, kozmetik değil.

**Doğrulanmış parametreler (Faz 1 yerel testinden):** Aşağıdaki ffmpeg
parametreleri gerçek arkaplan videosu ve gerçek parça ile test edildi ve
çalıştığı doğrulandı. Bunları olduğu gibi kullan, yeniden icat etme:

```
-stream_loop -1 -i assets/background.mp4
-re -i <ses dosyası>
-map 0:v -map 1:a
-vf scale=1280:720
-c:v libx264 -preset veryfast -pix_fmt yuv420p
-profile:v main -r 24 -g 48 -keyint_min 48 -sc_threshold 0
-b:v 2500k -maxrate 2500k -bufsize 5000k
-c:a aac -b:a 160k -ar 48000 -ac 2
```

Çıkış hedefi konfigüre edilebilir olacak (aşağıya bakın) — bu adımda
YouTube erişimi olmadığı için yerel dosyaya yazılacak, ama kod RTMP'ye
geçişte değişmeyecek şekilde tasarlanacak.

**Proje kökü:** `C:\Users\Aybuke Yeni\Desktop\Youtube\YT Stream System`

Kurallar:
- Her adımı sırayla yap, bitmeden diğerine geçme
- Her adım sonunda ne yaptığını raporla
- Her dosya oluşturma/düzenlemeden sonra o dosyada kullanılmayan kod ya
  da çakışma var mı kontrol et — bunu adım sonundaki rapora dahil et
- Kod yazmadan önce mevcut durumu kontrol et

---

### Adım 2.1 — İskelet ve config

1. Klasör yapısını oluştur:
   ```
   src/domain/
   src/application/
   src/infrastructure/
   src/config/
   ```
2. `package.json` oluştur (henüz yoksa)
3. `.env.example` oluştur: `YOUTUBE_STREAM_KEY=` (boş, gerçek key
   `.env`'e gidecek, `.env` zaten `.gitignore`'da)
4. `config.json` oluştur:
   ```json
   {
     "paths": {
       "music": "./music",
       "background": "./assets/background.mp4",
       "runtime": "./runtime"
     },
     "profile": {
       "width": 1280, "height": 720, "fps": 24,
       "videoBitrate": "2500k", "audioBitrate": "160k",
       "preset": "veryfast"
     },
     "output": {
       "mode": "local",
       "localPath": "./runtime/out.flv"
     }
   }
   ```
   `output.mode` iki değer alabilir: `"local"` (dosyaya yaz, RTMP yok)
   veya `"rtmp"` (`.env`'deki `YOUTUBE_STREAM_KEY` ile
   `rtmps://a.rtmps.youtube.com/live2/<key>`'e yaz). Şimdilik `local`.
5. `src/config/load-config.js`: `config.json` + `.env`'i okur, eksik
   zorunlu alan varsa (örn. `mode: "rtmp"` seçiliyken key yoksa) açık
   hata mesajıyla düşer, sessizce devam etmez
6. `runtime/` klasörünü oluştur, `.gitignore`'a ekle (henüz yoksa)

**Bu adım bitince dur ve rapor ver.**

---

### Adım 2.2 — `StreamProfile` (domain)

1. `src/domain/stream-profile.js`: config'deki `profile` nesnesinden
   üretilen, encode parametrelerini tutan saf bir nesne
   - `gopSize` kendi hesaplasın: `fps × 2` (2 saniyelik keyframe kuralı)
   - Geçersiz değerlere (örn. `fps <= 0`) karşı kendini doğrulasın
2. Birim testi yaz (basit bir test runner yeterli, ağır bir framework
   gerekmiyor — projede zaten var olan bir test aracı varsa onu kullan,
   yoksa Node'un yerleşik `node:test` modülünü kullan)

**Bu adım bitince dur ve rapor ver.**

---

### Adım 2.3 — `Encoder` arayüzü + `FfmpegEncoder` (infrastructure)

1. `src/application/encoder.js` (ya da uygun bir yere): `Encoder` arayüzü
   — bir interface objesi/sözleşmesi olarak: `start(options)`, `stop()`,
   `on('exit', callback)`, `on('log', callback)`
2. `src/infrastructure/ffmpeg-encoder.js`: arayüzü implement eder
   - ffmpeg argümanlarını **dizi olarak** üret (string birleştirme değil
     — boşluklu Windows yollarında tek güvenli yol, örn.
     `"C:\Users\Aybuke Yeni\..."`)
   - `StreamProfile`'dan ve `config.output`'tan komutu kur: `output.mode`
     `"local"` ise son argüman `localPath`, `"rtmp"` ise RTMP URL
   - `child_process.spawn` ile başlat
   - stderr'i satır satır parse et: `frame=`, `fps=`, `bitrate=`,
     `speed=` değerlerini çıkar, `on('log', ...)` ile dışarı ver
   - `speed` değerinin ffmpeg'in yayın başından beri hesapladığı bir
     **ortalama** olduğunu unutma (Faz 1 testinde doğrulandı) — bu adımda
     sadece ham değeri çıkarman yeterli, yorumlama (30 sn pencere,
     anlık hız hesabı) Faz 5'in işi, şimdi yapma
3. Exit event'ini yakala, exit code'u `on('exit', code)` ile bildir

**Bu adım bitince dur ve rapor ver.**

---

### Adım 2.4 — Temiz kapanış

1. `index.js`'de `SIGINT` yakala:
   - ffmpeg'e önce nazik kapanma sinyali gönder (stdin'e `q` yazmak
     ffmpeg için standart kapanma yoludur)
   - 5 saniye bekle
   - Yanıt yoksa `kill()` ile zorla kapat
2. Test: `node index.js` ile başlat, birkaç saniye sonra Ctrl+C, **Windows
   Task Manager'dan (`Get-Process ffmpeg` PowerShell'de de olur) arkada
   ffmpeg process'i kalmadığını doğrula**
3. Bu testi 3 kez tekrarla (bazen zamanlama sorunları tek seferde
   görünmeyebilir)

**Bu adım bitince dur ve rapor ver — Task Manager/Get-Process çıktısını
da rapora ekle.**

---

### Adım 2.6 — Logger

(2.5 numarası kasıtlı atlandı — Faz 2.5 ses normalizasyonuna ayrılmıştı,
bkz. PLAN.md)

1. `src/infrastructure/logger.js`: konsola ve `runtime/logs/`'a yazan
   basit bir logger
   - Dosya adı tarih damgalı olsun (`stream-2026-09-24.log` gibi)
   - Bu adımda rotasyon **gerekmiyor** — o Faz 5.3'ün işi, şimdi sadece
     temel yazma yeterli
2. `FfmpegEncoder`'ın `on('log', ...)` çıktısını logger'a bağla

**Bu adım bitince dur ve rapor ver.**

---

### Adım 2.7 — Uçtan uca yerel test

1. `src/application/stream-orchestrator.js`: yukarıdaki parçaları birbirine
   bağlayan basit bir `start()`/`stop()` — henüz kuyruk yok (Faz 3'ün işi),
   **tek bir sabit parça** ile çalışsın (örn. `music/` klasöründeki ilk
   dosya)
2. `index.js`: config'i yükle, orchestrator'ı başlat
3. Çalıştır: `node index.js`, 60 saniye kesintisiz çalıştığını doğrula,
   Ctrl+C ile durdur, zombi process kalmadığını tekrar doğrula
4. `runtime/out.flv`'yi ffprobe ile kontrol et — Faz 1'deki yerel test
   sonuçlarına yakın çıkması bekleniyor (aynı parametreler kullanıldığı
   için)

**Bu adım bitince dur ve rapor ver.**

---

### Adım 2.8 — Özet ve temizlik

1. Özet: hangi dosyalar oluşturuldu, hangi testler geçti
2. **Conflict ve dead code kontrolü:** tüm `src/` ağacını gözden geçir —
   kullanılmayan export, kullanılmayan import, birbirini ezen dosya var mı
3. Arkada kalan process kontrolü (`Get-Process ffmpeg`)
4. `runtime/out.flv` gibi test çıktılarının `.gitignore`'da olduğunu
   doğrula

**Raporu ver ve dur.**

## PROMPT SONU

---

## Sonraki adım

Bu faz kapanınca PLAN.md'de Faz 2 satırı güncellenir. Sırada Faz 3.2-3.5
var — B yaklaşımına göre kuyruk implementasyonu (bu da RTMP gerektirmiyor,
yerel test edilebilir).
