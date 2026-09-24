# Faz 3.2-3.5 — Kuyruk (B Yaklaşımı) (Claude Code Prompt)

> `PROMPTLAR\faz-3-kuyruk.md` olarak kaydet, aşağıdaki bölümü Claude
> Code'a ver.

---

## PROMPT BAŞLANGICI

### Mimari hatırlatma

Faz 2'deki katman ayrımına aynen uy: domain hiçbir modül import etmez,
application `child_process`/infrastructure'ı import etmez (bu kurallar
zaten testle korunuyor, kırma). Yeni kod da aynı üç katmana dağılacak.

**B yaklaşımı (Faz 3.1'de karar verildi, KARARLAR.md'de detay):** Uzun bir
playlist (50-100 parça) baştan yazılır, `-shortest` ile ffmpeg playlist
bitince temiz kapanır (`exit code=0`), orchestrator bunu yakalayıp yeni
bir playlist + yeni ffmpeg süreciyle yeniden başlar. Bu, tek parçalı Faz
2 davranışının üstüne eklenen bir mod — Faz 2'deki tek parça akışını
bozma, `FfmpegEncoder`'a playlist modu ekle.

**Proje kökü:** `C:\Users\Aybuke Yeni\Desktop\Youtube\YT Stream System`

Kurallar:
- Her adımı sırayla yap, bitmeden diğerine geçme
- Her adım sonunda ne yaptığını raporla, kullanılmayan kod/çakışma
  kontrolünü dahil et
- Yeni davranışlar için test yaz (Faz 2'deki gibi `node:test`)
- Gerçek `music/` klasöründeki 30 dosyayla test et

---

### Adım 3.2 — `TrackRepository` (infrastructure)

1. `src/infrastructure/track-repository.js`:
   - `music/` klasörünü tarar, `.m4a` dosyalarını bulur
   - Her biri için `ffprobe` ile süreyi okur, bir `Track` domain nesnesi
     üretir (Track'i 3.3'te tanımlayacaksın, burada sadece onu kullan)
   - Sonuçları önbelleğe alır — her `list()` çağrısında yeniden tüm
     klasörü `ffprobe`'lamak gereksiz. Önbelleği geçersiz kılma koşulu:
     dosya sayısı değiştiyse yeniden tara (basit tutmak yeterli, Faz
     2.5'teki gibi tek tek mtime takibi gerekmiyor)
   - Okunamayan/bozuk dosyayı atla, listeye ekleme, uyar

**Bu adım bitince dur ve rapor ver.**

---

### Adım 3.3 — `Queue` (domain)

1. `src/domain/track.js`: `Track` — dosya yolu, başlık (dosya adından,
   uzantısız), süre. Saf veri nesnesi, doğrulama yapar (süre > 0, yol
   boş değil)
2. `src/domain/queue.js`: `Queue`
   - `mode`: `"sequential"` veya `"shuffle"` (config'den)
   - `next()` — sıradaki tek parçayı döndürür, liste tükenince başa
     sarar (sonsuz döngü)
   - `peek(n)` — sırada gelecek n parçayı, `next()`'i tüketmeden gösterir
   - Shuffle modunda: aynı parça arka arkaya iki kez gelmesin (liste
     1 parçadan büyükse)
   - Hiç parça yoksa (`music/` boşsa) açık hata fırlatsın, sessizce
     takılmasın
3. Birim testleri: sequential sırası, shuffle'da ardışık tekrar yok,
   sonsuz döngü, boş liste hatası, `peek` `next`'i etkilemiyor

**Bu adım bitince dur ve rapor ver.**

---

### Adım 3.4 — `PlaylistWriter` (application) + config

1. `config.json`'a `queue` bölümü ekle:
   ```json
   "queue": { "mode": "shuffle", "batchSize": 50 }
   ```
   (`batchSize` = bir playlist dosyasında kaç parça olacağı — B
   yaklaşımının restart aralığını belirler. Test için düşük bir değer
   kullanılabilir, üretimde 50-100 önerilir, bu config'den ayarlanır)
2. `src/application/playlist-writer.js`:
   - `Queue`'dan `batchSize` kadar parça çeker
   - `runtime/playlist.txt`'ye concat formatında yazar: her satır
     `file 'C:/mutlak/yol/parça.m4a'` (Windows'ta düz bölü, tek tırnak
     içinde — Faz 3.1 deneyinde doğrulanan format)
   - Yazdığı parçaların listesini ve toplam süresini döndürür (loglama
     ve restart zamanlamasını tahmin etmek için kullanılacak)
   - Atomik yazma: önce `.tmp`, sonra rename (Faz 2.5'teki desenle
     tutarlı)

**Bu adım bitince dur ve rapor ver.**

---

### Adım 3.5 — `FfmpegEncoder` ve `StreamOrchestrator` güncellemesi

1. `FfmpegEncoder`'a playlist modu ekle (mevcut tek-parça modunu
   **bozmadan**, yeni bir seçenek olarak):
   - Tek parça modu: `-re -i <dosya>` (Faz 2'deki mevcut davranış)
   - Playlist modu: `-f concat -safe 0 -i <playlist.txt>` ve **ek olarak
     `-shortest`** (sadece bu modda; tek parça modunda `-shortest`
     kullanma — PLAN.md'nin Faz 1 notu bunu zaten yasaklıyor)
   - Hangi modun kullanılacağı `start(options)`'a parametre olarak
     geçilsin
2. `StreamOrchestrator`'ı güncelle:
   - Başlarken: `TrackRepository` ile parçaları yükle, `Queue` kur,
     `PlaylistWriter` ile ilk playlist'i yaz, encoder'ı playlist
     modunda başlat
   - `encoder.on('exit', code)`: `code === 0` ise bunu **beklenen
     playlist bitişi** olarak işaretle (Faz 2'deki "beklenmeyen kapanış"
     mantığından ayır) — yeni bir playlist yaz (Queue zaten sıradaki
     parçaları biliyor, kaldığı yerden devam eder), encoder'ı hemen
     yeniden başlat
   - `code !== 0` durumu bu fazın kapsamı dışında — gerçek çökme
     yönetimi (üstel geri çekilme, crash loop koruması) Faz 5'in işi.
     Şimdilik sadece logla, restart deneme, bunu raporda açıkça belirt
   - Restart anındaki gerçek boşluğu ölç ve logla (ffmpeg exit
     event'inden yeni process'in ilk `frame=` satırına kadar) — Faz
     3.1'de ölçülen ~225 ms ile karşılaştırmak için

**Test:** `batchSize`'ı küçük bir değere (örn. 3) çekip gerçek `music/`
klasörüyle çalıştır, en az **2 restart**'ın da gerçekleşmesini gözlemle.
Her restart'ta:
   - Çıkış kodu 0 mı
   - Yeni playlist doğru parçaları mı içeriyor (Queue'nun kaldığı yerden
     devam ettiğini doğrula, baştan başlamadığını)
   - Restart boşluğu ne kadar
   - Ses/video kesintisiz mi (çıktı dosyasını ffprobe ile kontrol et)

**Bu adım bitince dur ve rapor ver.**

---

### Adım 3.6 — Özet ve temizlik

1. Özet: yeni dosyalar, testler, gerçek restart testinin sonucu
2. Conflict/dead code kontrolü: tüm `src/` ağacı
3. Arkada kalan process kontrolü
4. `batchSize`'ı config'de üretim değerine (50) geri al ya da düşük
   bırakıp bunu raporda belirt — karar sohbette verilecek

**Raporu ver ve dur.**

## PROMPT SONU

---

## Sonraki adım

Bu faz kapanınca PLAN.md'de Faz 3 satırı güncellenir, commit atılır.
Sırada Faz 4 (overlay) var — bu da RTMP gerektirmiyor, yerel test
edilebilir.
