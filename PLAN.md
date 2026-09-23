# 24/7 YouTube Müzik Livestream — Plan

**Son güncelleme:** 23 Eylül 2026
**Yayın erişimi açılış:** 24 Eylül 2026, 23:04

---

## Durum özeti

| Faz | Konu | Durum |
|---|---|---|
| 0 | Hazırlık | Kısmen tamam — YouTube erişimi beklemede |
| 1 | Ham ffmpeg testi | Bekliyor (YouTube erişimi açılınca, R2 doğrulaması dahil) |
| 2 | Node.js sarmalayıcı | Tamamlandı |
| 2.5 | Ses normalizasyonu | **Şimdi yapılabilir** |
| 3 | Kuyruk ve kesintisiz geçiş | 3.1 tamam (karar: B) — 3.2-3.5 başlamadı |
| 4 | Now playing overlay | Başlamadı |
| 5 | Dayanıklılık | Başlamadı |
| 6 | Kontrol arayüzü (opsiyonel) | Başlamadı |
| 7 | VPS'e taşıma | Başlamadı |

---

## 24 saatlik bekleme süresinde yapılacaklar

YouTube erişimi olmadan yapılabilecek işler. Sıralama önem sırasına göre.

### 1. Kuyruk deneyi (Faz 3.1) — EN ÖNEMLİ

**Neden:** Planın en riskli varsayımı bu. Araştırmada concat demuxer'ın canlı
kuyruk beslemesini desteklediğine dair net bir kanıt bulunamadı. Sonuca göre
mimarinin bir kısmı değişecek — bu yüzden Faz 2'nin kodu yazılmadan önce
netleşmeli.

**YouTube gerekmiyor:** RTMP yerine yerel dosyaya çıktı alınarak test edilir.

Üç yaklaşım karşılaştırmalı test edilecek:

**A — Canlı concat beslemesi**
- 2 parçalık `playlist.txt` ile ffmpeg başlat
- Çalarken elle 3. satırı ekle
- Soru: ffmpeg devam ediyor mu, yoksa 2. parça bitince kapanıyor mu?

**B — Uzun playlist + planlı restart**
- Baştan 50-100 parçalık playlist yaz
- Sonuna yaklaşınca planlı restart
- Soru: restart anındaki kesinti ne kadar?

**C — Named pipe (FIFO)**
- Node ses akışını pipe'a yazar, ffmpeg pipe'tan okur
- Karmaşık ama tam kontrol
- Not: GitHub'daki bazı livestream radyo projeleri bu yaklaşımı seçmiş —
  muhtemelen A çalışmadığı için

**Çıktı:** Hangi yaklaşımın seçildiği ve gerekçesi → `KARARLAR.md`

---

### 2. Ses normalizasyonu (Faz 2.5)

**Neden öne alındı:** Araştırma gösterdi ki concat demuxer farklı codec,
sample rate veya kanal sayısında ya başarısız olur ya bozuk çıktı verir.
Ses kanal uyuşmazlığı senkron kaymasına yol açar ve ffmpeg her zaman
uyarı vermez. Yani bu Faz 3'ün ön koşulu, sonrası değil.

**Yapılacak:** `normalize.js` script'i
- Tüm parçaları 48 kHz stereo AAC'ye çevir
- `loudnorm` filtresiyle -14 LUFS'a normalize et (YouTube'un hedef seviyesi)
- Çıktıyı `music/` klasörüne yaz

**Doğrulama:** ffprobe ile tüm dosyaların aynı parametrede olduğunu kontrol et,
3-4 parçayı arka arkaya dinleyip seviye zıplaması olmadığını doğrula

---

### 3. Yerel ffmpeg zinciri testi (Faz 1'in YouTube'suz kısmı)

RTMP çıkışı yerine yerel dosyaya yazarak tüm encode zincirini doğrula:

```powershell
ffmpeg -stream_loop -1 -i assets/background.mp4 `
  -re -i music/01.mp3 `
  -map 0:v -map 1:a `
  -c:v libx264 -preset veryfast -pix_fmt yuv420p `
  -profile:v main -r 24 -g 48 -keyint_min 48 -sc_threshold 0 `
  -b:v 2500k -maxrate 2500k -bufsize 5000k `
  -c:a aac -b:a 160k -ar 48000 -ac 2 `
  -t 120 -f flv test-output.flv
```

Kontrol edilecekler:
- `speed=` değeri 1.0x civarında mı (encode yetişiyor mu)
- Çıktı dosyası düzgün oynuyor mu
- CPU kullanımı ne seviyede

**Not:** YouTube'a geçerken sadece son satır değişecek:
`-t 120 -f flv test-output.flv` → `-f flv rtmps://a.rtmps.youtube.com/live2/KEY`

---

### 4. Varlık hazırlığı

- 5 test parçası seç
- Loop arkaplan videosu hazırla (mevcut lofi pipeline'dan çıkan klip iş görür)
- Arkaplanın gerçekten kesintisiz loop olduğunu doğrula (baş/son kare uyumu)
- Upload hızını ölç — en az 4-5 Mbps stabil gerekli, ethernet tercih et

---

### 5. Referans projeleri incele (opsiyonel, 20 dk)

Kopyalamak için değil, ffmpeg parametrelerini ve çökme yönetimini nasıl
çözmüşler diye:

- `nokey-54/FFmpeg-livestream-docker` — Python + FFmpeg + Docker, mimariye en yakın
- `hajilok/youtube-live-streaming` — Node.js, stack'e en yakın (ama geliştirici
  kendisi olgun olmadığını söylüyor — referans, temel değil)
- GitHub topic: `lofi-stream`, `24-7-streaming`, `lofi-radio`

---

## Mimari özet

### Katmanlar

**Domain** (saf mantık, I/O yok)
- `Track` — dosya yolu, başlık, süre, sample rate, kanal
- `Queue` — sıra yönetimi, sequential/shuffle, sonsuz döngü
- `StreamProfile` — encode parametreleri, `gopSize = fps × 2`

**Application** (orkestrasyon)
- `StreamOrchestrator` — beyin: başlat/durdur/atla
- `PlaylistWriter` — kuyruktan besler (yaklaşım Faz 3.1 sonucuna göre)
- `NowPlayingWriter` — atomik yazma (önce .tmp, sonra rename)
- `Supervisor` — çökme yönetimi, üstel geri çekilme

**Infrastructure** (VPS'e geçişte değişecek tek katman)
- `Encoder` arayüzü — start/stop/onExit/onLog
- `FfmpegEncoder` — spawn, stderr parse (`speed=` takibi kritik)
- `TrackRepository` — klasör tarama + ffprobe + cache
- `Logger` — konsol + dosya + rotasyon

**Kural:** `StreamOrchestrator` asla `child_process`'i doğrudan çağırmaz.

### Klasör yapısı

> Not: `<proje kökü>` = `YT Stream System\`. `src\` doğrudan bu kökte,
> ayrı bir alt klasör değil.

```
<proje kökü>/
  src/
    domain/          track.js, queue.js, stream-profile.js
    application/     orchestrator.js, playlist-writer.js, supervisor.js
    infrastructure/  ffmpeg-encoder.js, track-repository.js, logger.js
    config/          load-config.js
  assets/            background.mp4
  music/             (normalize edilmiş parçalar)
  runtime/           playlist.txt, nowplaying.txt, logs/
  .env               STREAM_KEY
  config.json
  index.js
```

`.gitignore`: `.env`, `runtime/`, `music/`, `assets/`

### Git durumu

Repo proje kökünde (`YT Stream System\`) — önceden boş bir `YT-Streamer\` alt
klasöründeydi, köke taşındı. GitHub'a bağlı: `AybukeYaman/YT-Streamer`
(`main` branch). İki commit push edildi (Faz 0-2 + Faz 3.1 deney script'leri).

### Config şeması

```json
{
  "paths": {
    "music": "./music",
    "background": "./assets/background.mp4",
    "runtime": "./runtime",
    "fontFile": "C:/Windows/Fonts/arial.ttf"
  },
  "queue": { "mode": "shuffle", "lookahead": 3 },
  "profile": {
    "width": 1280, "height": 720, "fps": 24,
    "videoBitrate": "2500k", "audioBitrate": "160k",
    "preset": "veryfast"
  },
  "overlay": { "enabled": true, "fontSize": 28, "position": "bottom-left" },
  "supervisor": {
    "restartDelayMs": 3000,
    "maxDelayMs": 60000,
    "crashLoopThreshold": 5
  }
}
```

---

## Faz detayları

### Faz 1 — Ham ffmpeg + RTMP (24 saat sonra)

Yerel test (yukarıda madde 3) geçtikten sonra sadece çıkış hedefi değişir.

**Kapanış kriteri:** 10 dakika kesintisiz, YouTube Studio'da "Excellent"
bağlantı durumu, `speed≈1.0x`. Ayrıca **R2 doğrulaması**: en az bir planlı
restart'ı (Faz 3.1'deki B yaklaşımı) gerçek YouTube yayınında tetikleyip
YouTube'un tepkisini kaydet — kısa bir kopmayla devam mı ediyor, uyarı mı
veriyor, yoksa yayını sonlandırıyor mu? Sonlandırıyorsa `KARARLAR.md`'de
kayıtlı olduğu gibi C (named pipe) yaklaşımına dönülecek.

**Parametre gerekçeleri:**
- `-stream_loop -1` — arkaplanı sonsuz döndürür
- `-re` sadece ses girişinde — video girişinde kullanma, çakışır
- `-g 48 -keyint_min 48 -sc_threshold 0` — 24fps'te tam 2 sn sabit GOP
  (`sc_threshold` olmadan ffmpeg sahne değişiminde ekstra keyframe atar)
- `-maxrate = -b:v`, `-bufsize = 2×` — CBR davranışı
- `-pix_fmt yuv420p` — uyumluluk için zorunlu
- `rtmps` + 443 — güvenli ingest
- **`-shortest` kullanma** — yayını erken kapatır

### Faz 2 — Node.js sarmalayıcı

Alt adımlar:
- 2.1 İskelet + config loader
- 2.2 `StreamProfile` + birim testi
- 2.3 `Encoder` arayüzü + `FfmpegEncoder` (argüman **dizisi**, string değil —
  boşluklu Windows yollarında tek güvenli yol)
- 2.4 Temiz kapanış: SIGINT → ffmpeg'e `q` → 5 sn bekle → `kill`.
  **Task Manager'dan zombi process kalmadığını doğrula**
- 2.6 Logger (2.5 numarası atlandı — Faz 2.5 ses normalizasyonuyla
  karışmasın diye)

**Kapanış:** `node index.js` yayını başlatıyor, Ctrl+C temiz kapatıyor,
zombi process yok

**Kapanış notu (24 Eylül) — TAMAMLANDI:**
- 46 test geçti
- 60 sn uçtan uca doğrulandı, Faz 1 sonuçlarıyla birebir tutarlı: 720p,
  2518 kbps, GOP 2 sn, `speed` 1.01x
- Mimari kural testleri eklendi: domain hiçbir modül import edemiyor,
  application `child_process`/infrastructure import edemiyor — testle korunuyor
- **Ele alınmayanlar:** `-shortest` (Faz 3.4'te eklenecek), pencere kapatma
  olayı (Faz 5)

### Faz 3 — Kuyruk

**3.1 sonucu (23 Eylül):** Yaklaşım B seçildi — uzun playlist + `-shortest` +
planlı restart. Gerekçe ve detay → `KARARLAR.md`. Aşağıdaki alt adımlar
buna göre şekillendi.

- 3.1 ~~Yaklaşım deneyi~~ — tamamlandı, karar B
- 3.2 `TrackRepository`
- 3.3 `Queue` + birim testleri
- 3.4 `PlaylistWriter` — B'ye göre: her seferinde uzun bir playlist
  (50-100 parça) önceden yazar, tek dosyaya (Windows'ta düz bölü,
  tek tırnak içinde), `-shortest` ile birlikte kullanılır
- 3.5 `StreamOrchestrator` — playlist bitişini (`exit code=0`) yakalar,
  yeni playlist + yeni ffmpeg process ile restart eder. Restart'ın gerçek
  RTMPS boşluğu Faz 1'de ölçülecek (R2, aşağıya bakın)

**Kapanış:** 5+ parça arka arkaya, geçişte ses kesilmiyor, YouTube'da uyarı
yok, planlı restart temiz çalışıyor (code=0)

### Faz 4 — Overlay

```
drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':textfile='runtime/nowplaying.txt':reload=1:fontsize=28:fontcolor=white:x=40:y=h-80:shadowcolor=black@0.6:shadowx=2:shadowy=2
```

**Windows font yolu escape'i en sık takılınan yer:** sürücü harfinden sonraki
iki nokta `\:` şeklinde kaçırılmalı, yol düz bölü kullanmalı.

Parça adları İngilizce (kanal geneli sabit).

**Kapanış:** Parça değişiminde yazı birkaç saniyede güncelleniyor, uzun
başlıklar taşmıyor

### Faz 5 — Dayanıklılık

- 5.1 Üstel geri çekilme (3s → 6s → 12s → … → 60s tavan)
- 5.2 Crash loop koruması (5 dakikada 5 çökme → dur, alarm)
- 5.3 Log rotasyonu (50 MB → döndür, 5 dosya sakla) — **disk alanı sınırlı,
  gerçek risk**
- 5.4 `speed` < 0.95 → uyarı (encode yetişemiyor). **`speed` > 1.1 → uyarı**
  (Faz 3.1'de bulunan sessiz arıza: ses girişi tükenip video girişinde `-re`
  olmadığında ffmpeg kapanmadan hız sınırsız artıyor, anlamsız/sessiz video
  üretmeye devam ediyor — salt process varlığına bakan bir supervisor bunu
  fark edemez, bu yüzden üst sınır kontrolü olmadan alt sınır tek başına
  yetersiz)
- 5.5 Ağ kopması testi (Wi-Fi 30 sn kapat/aç)
- 5.6 **6 saat kesintisiz test** + bellek/disk karşılaştırması

**Kapanış:** 6 saat geçti, ağ kopmasından toparlandı, bellek ve disk stabil

### Faz 7 — VPS

Ön koşul: Faz 5 tamam.

- 2 vCPU minimum (1 vCPU'da 720p x264 zorlanır), 2 GB RAM
- `Dockerfile`: Node + ffmpeg; `music/`, `assets/`, `runtime/` volume
- `docker-compose.yml`: `restart: unless-stopped`
- VPS profili: 720p, `veryfast`/`ultrafast`, bitrate düşür
- Geçiş: yerel durdur → VPS başlat → **yerel makineyi kapat** → doğrula
- 24 saat gözlem

**Docker burada gerçek bir sorunu çözüyor** (ortam farkı + tek komutla deploy).
Faz 1-6'da gereksiz karmaşıklıktı, burada değil.

---

## Süreç ritmi

Her faz: plan → prompt → uygulama → test → conflict/dead-code kontrolü →
commit → kapanış → birlikte gözden geçirme → sonraki fazın planı.

Faz atlanmaz. Özellikle 3.1 sonucuna göre sonraki fazların şekli değişebilir.

## Rol dağılımı

- **Sohbet** — mimari kararlar, faz planlama, prompt yazma, hata yorumlama
- **Claude Code** — kod, ffmpeg çalıştırma, test, debug
- **Cowork / bu dosya** — durum takibi, karar kaydı, süreklilik

---

## Açık sorular

- [ ] Kuyruk yaklaşımı hangisi olacak? (Faz 3.1 sonucu)
- [ ] Arkaplan videosu tek mi olacak, rotasyon mu?
- [ ] Yayın başlığı/açıklaması otomatik güncellenecek mi?