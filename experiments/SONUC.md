# Faz 3.1 — Kuyruk Yaklaşımı Deneyi: Sonuçlar

**Tarih:** 23 Eylül 2026

---

## Adım 1 — Ortam ve test verisi

### Sürümler

| Araç | Sürüm |
|---|---|
| ffmpeg | 9.0.1-full_build-www.gyan.dev (gcc 16.1.0, MSYS2) |
| ffprobe | 9.0.1-full_build-www.gyan.dev |
| Node.js | v24.12.0 |

ffmpeg WinGet ile kurulu (`%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg`).

### Test verisi (`experiments/assets/`)

| Dosya | Frekans | Codec | Sample rate | Kanal | Süre |
|---|---|---|---|---|---|
| 01.m4a | 220 Hz | AAC | 48000 | stereo | 20.000 s |
| 02.m4a | 330 Hz | AAC | 48000 | stereo | 20.000 s |
| 03.m4a | 440 Hz | AAC | 48000 | stereo | 20.000 s |
| 04.m4a | 550 Hz | AAC | 48000 | stereo | 20.000 s |
| 05.m4a | 660 Hz | AAC | 48000 | stereo | 20.000 s |
| background.mp4 | `testsrc` | H.264 | — | — | 10.000 s, 1280x720, 24 fps |

Frekanslar 110 Hz arayla artıyor, parçalar kulakla ayırt edilebiliyor
(220 Hz en pes, 660 Hz en tiz).

**Doğrulama:** ffprobe'a göre 5 ses dosyasının codec, sample rate, kanal sayısı ve
kanal düzeni birebir aynı. Concat demuxer için parametre uyuşmazlığı riski yok.

---

## Adım 2 — Yaklaşım A: Canlı concat beslemesi → **BAŞARISIZ**

**Kurulum:** `test-a.js`, playlist'te 2 parça (01, 02) ile başladı; 25. sn'de 03,
45. sn'de 04 eklendi. Arkaplan `-stream_loop -1`, ses `-re -f concat`. Çıktı `out-a.flv`.

### Gözlem

| Zaman | Olay |
|---|---|
| 0–40 sn | Normal: `speed≈1.02x`, ~25 fps |
| 25 sn | 03 eklendi → **etkisi yok** |
| ~40 sn | 2 parça bitti, concat girişi EOF oldu. **Hiçbir uyarı/hata loglanmadı** |
| 40 sn sonrası | Ses durdu; video girişi `-re` olmadığı için frenlenmedi: `speed` 1.0x → 21x'e fırladı |
| 45 sn | 04 eklendi → **etkisi yok** |
| 120 sn | Emniyet zamanlayıcısı `q` gönderdi, ffmpeg code=0 ile çıktı |

- ffmpeg **kapanmadı** (video sonsuz döngü girişi onu ayakta tuttu) — ama sadece
  sessiz video üretmeye devam etti, eklenen parçalar hiç okunmadı.
- `out-a.flv` (ffprobe): son ses paketi **40.08 sn**, son video paketi **2547 sn**
  (~42 dk'lık video 120 sn'de üretildi). Çıktıda yalnızca 01 ve 02 var.

### Sonuç

Concat demuxer playlist'i **açılışta bir kez okuyor**; sonradan eklenen satırları
görmüyor. Varsayım çürütüldü.

### Kritik yan bulgu — sessiz arıza modu

Ses bittiğinde ffmpeg **ne çıkıyor ne uyarı veriyor**. Canlı yayında bu, "ffmpeg
çalışıyor" görünürken sessiz yayın + gerçek zamandan hızlı video itmesi demek
(YouTube muhtemelen reddeder/bozar). Supervisor sadece process exit'e bakarsa
bunu **yakalayamaz**. Tespit için `speed=` takibi (> ~1.1x = anormal) şart —
PLAN.md 5.4'teki yalnızca `< 0.95` kontrolü yetmez, üst sınır da gerekli.

---

## Adım 3 — Yaklaşım B: Uzun playlist + planlı restart → **ÇALIŞIYOR**

**Kurulum:** `test-b.js`, 5 parçalık playlist (100 sn) ile ffmpeg başlatır; ffmpeg
kapanınca hemen yeni playlist (`playlist-bN.txt`) ve yeni çıktı (`out-bN.flv`) ile
yeniden başlatır. 3 tur. Video sonsuz döngüde olduğu için `-shortest` eklendi —
playlist bitince ffmpeg'in kapanması için gerekli. (PLAN.md'deki "`-shortest`
kullanma" kuralı erken kapanmayı önlemek içindi; burada hedef tam olarak playlist
sonunda kapanmak, çelişki yok.) Boşluk ölçümü için `-stats_period 0.05` ile
ilk `frame=` satırı ~50 ms çözünürlükle yakalandı.

### Ölçümler

| Tur | Spawn → ilk frame | Önceki exit → ilk frame (**boşluk**) | Tur süresi | Exit |
|---|---|---|---|---|
| 1 | 452 ms (soğuk başlangıç) | — | 99.67 sn | code=0 |
| 2 | 227 ms | **227 ms** | 99.61 sn | code=0 |
| 3 | 223 ms | **224 ms** | 99.61 sn | code=0 |

- ffprobe: her `out-bN.flv`'de son ses paketi **100.09 sn** (5 parçanın tamamı),
  son video paketi **101.79 sn**.
- Hiçbir turda uyarı/hata yok, kapanışlar temiz (code=0).

### Değerlendirme

- **Process seviyesindeki boşluk ~225 ms** (sıcak), ilk açılışta ~450 ms.
  Tutarlı ve öngörülebilir.
- **Bu ölçüm RTMP'yi kapsamıyor.** Gerçek yayında her restart = RTMP(S) bağlantısını
  kapat + yeniden aç (TCP + TLS + RTMP handshake). Gerçek boşluk muhtemelen
  ~1-3 sn olur ve YouTube'un bunu nasıl karşıladığı (yayın devam mı, "bağlantı
  koptu" uyarısı mı, yeni yayın mı) **bilinmiyor** — Faz 1'de YouTube erişimi
  açılınca test edilmeli.
- **Etki azaltma:** Playlist'i uzun tutmak (ör. 50-100 parça ≈ birkaç saat) restart
  sayısını günde birkaç kereye indirir.
- `-shortest` sonunda video sesten ~1.7 sn uzun — kısa sessiz kuyruk. Önemsiz ama
  her restart'ta tekrarlanır.

---

## Riskler

### R1 — Sessiz arıza modu: ses biterse ffmpeg kapanmaz, hızlanır (Adım 2'de gözlendi)

**Ne oldu:** Yaklaşım A'da concat girişi (ses) 40. sn'de EOF oldu. ffmpeg
**ne çıktı ne uyarı verdi**. Video girişi `-stream_loop -1` olduğu ve `-re`
sadece ses girişinde olduğu için video frenlenmedi: `speed` 1.02x → **21x**'e
çıktı, 120 sn'de ~42 dk'lık sessiz video üretildi.

**Neden tehlikeli:** Canlı yayında process ayakta görünür ama yayın sessizdir ve
gerçek zamandan hızlı veri itilir. Sadece process exit'e bakan bir Supervisor
bunu **yakalayamaz**.

**Aksiyon (ileride):** PLAN.md **Faz 5.4**'e `speed` **üst sınırı** eklenecek —
`speed > 1.1x` = anormal (girdi tükenmiş / frenleme kaybolmuş) → alarm + restart.
Mevcut 5.4 yalnızca alt sınırı (`< 0.95`) kontrol ediyor.

### R2 — Restart'ta RTMP bağlantı kopması (Adım 3'ten)

B yaklaşımında her restart RTMP bağlantısını yeniler. YouTube tarafındaki davranış
bilinmiyor; Faz 1'de doğrulanmalı.

---

## Adım 4 — Yaklaşım C: Named pipe → **TEST EDİLMEDİ**

B yeterli kabul edildiği için C'ye geçilmedi (aşağıdaki karara bakın).

---

## Adım 5 — Özet ve karar

### Yaklaşımların karşılaştırması

| | A — Canlı concat | B — Uzun playlist + restart | C — Named pipe |
|---|---|---|---|
| Çalıştı mı | **Hayır** | **Evet** | Test edilmedi |
| Davranış | Playlist açılışta bir kez okunuyor, eklenen satırlar yok sayılıyor | 3 turda da temiz kapanış (code=0), tüm parçalar çıktıda | — |
| Ölçüm | Ses 40 sn'de bitti, sonra speed 21x | Restart boşluğu ~225 ms (process), ilk açılış ~450 ms | — |
| Artı | — | Basit, öngörülebilir, ffmpeg'in standart kullanımı | Kesintisiz, tam kontrol |
| Eksi | Çalışmıyor + sessiz arıza modu | Her restart'ta RTMP kopması (gerçekte ~1-3 sn tahmini) | Windows pipe karmaşıklığı, ses akışını Node'un yönetmesi gerekir |

### Karar

**B yaklaşımı seçildi, C test edilmedi.**

**Gerekçe:** Bu bir arkaplan müzik yayını. Playlist uzun tutulduğunda (50-100 parça)
restart seyrek olacak ve 1-3 sn'lik kopma kabul edilebilir bir risk.
R2 (RTMP reconnect davranışı) Faz 1'de gerçek YouTube ile doğrulanacak;
**YouTube yayını tamamen sonlandırırsa C'ye dönülecek.**

### Beklenmedik gözlemler

1. **Sessiz arıza modu (R1):** Ses girişi bitince ffmpeg ne çıkıyor ne uyarı veriyor. Video frenlenmediği için hızlanıyor. → Faz 5.4'e speed üst sınırı.
2. **`-shortest` kuyruğu:** Video sesten ~1,7 sn uzun sürüyor. Her restart'ta kısa bir sessiz kuyruk oluşuyor.
3. **İlk açılış yavaş:** İlk spawn ~450 ms, sonrakiler ~225 ms (disk/önbellek ısınması).

### Temizlik ve kontrol

- **Çakışma:** `test-a.js` ve `test-b.js` farklı dosyalara yazıyor (`out-a` / `out-bN`, `playlist.txt` / `playlist-bN.txt`, ayrı log'lar). Çakışma yok.
- **Kullanılmayan kod:** Yok. İki script de bağımsız ve tek amaçlı.
- **Arkada kalan process:** `ffmpeg` process'i yok.
- **Disk:** Deney sonunda ~51 MB'tı (çoğu `out-a.flv`, 39 MB). Çıktılar (`out-*.flv`), log'lar ve üretilen playlist'ler silindi; bulgular bu dosyaya işlendi. Kalanlar: script'ler, `SONUC.md`, `assets/` (~2 MB, deneyleri yeniden çalıştırmak için gerekli).
- **`.gitignore`:** Proje kökünde oluşturuldu.
