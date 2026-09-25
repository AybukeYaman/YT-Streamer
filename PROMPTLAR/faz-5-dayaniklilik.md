# Faz 5 — Dayanıklılık (Claude Code Prompt)

> `PROMPTLAR\faz-5-dayaniklilik.md` olarak kaydet, aşağıdaki bölümü
> Claude Code'a ver.

---

## PROMPT BAŞLANGICI

### Mimari hatırlatma

Faz 2-4'teki katman ayrımına aynen uy. Yeni kod domain/application/
infrastructure'a dağılacak, testle korunan kurallar kırılmayacak.

**Proje kökü:** `C:\Users\Aybuke Yeni\Desktop\Youtube\YT Stream System`

Kurallar:
- Otonom ilerle, sadece "dur ve rapor ver" dediğim yerlerde ya da
  beklenmedik hata/karar durumunda dur
- Faz sonunda **tek commit**, ara adımlarda commit atma
- Gerçek `music/` klasörü ve gerçek yayın komutuyla test et

**Not — 5.5 (ağ kopması testi) bu fazda YOK:** Şu an çıkış yerel dosyaya
(`output.mode: "local"`), ağ bağımlılığı yok — Wi-Fi kapat/aç'ın hiçbir
etkisi olmaz. Bu test ancak gerçek RTMP bağlantısıyla (Faz 1) anlamlı,
oraya ertelendi.

---

### Adım 5.1-5.3 — Supervisor ve log rotasyonu

1. `src/application/supervisor.js`:
   - Encoder'ın `exit` event'ini dinler. **`code === 0` (beklenen
     playlist bitişi, Faz 3'ün restart mantığı) ile `code !== 0`
     (gerçek çökme) ayrımını koru** — supervisor sadece ikincisiyle
     ilgilenir, birincisi zaten orchestrator'da ele alınıyor
   - Gerçek çökmede üstel geri çekilme: 3s → 6s → 12s → 24s → 48s →
     60s (tavan). Başarılı bir restart'tan sonra (yeterince uzun süre
     çökmeden çalışırsa) sayaç sıfırlanır
   - Crash loop koruması: 5 dakika içinde 5 çökme → durdur, açık bir
     hata/alarm logla, yeniden başlatmayı bırak (sonsuz döngüye girme)
2. `src/infrastructure/logger.js`'e rotasyon ekle:
   - Dosya 50 MB'ı geçince döndür (yeni dosyaya geç, eskisini
     `.1`, `.2` gibi numarala), en fazla 5 dosya sakla, fazlasını sil
   - Not: tek ffmpeg başlatma komutu artık ~15 KB (Faz 4'teki 50
     drawtext yüzünden) — bu rotasyon eşiğini normalden biraz daha
     hızlı yaklaştırabilir, hesaba kat ama eşiği bu yüzden düşürme
3. **Gerçek test:** Yayını başlat, ffmpeg process'ini elle zorla
   öldür (`taskkill /F` gibi) 2-3 kez art arda, supervisor'ın geri
   çekilme aralıklarını doğru uyguladığını logdan doğrula. Sonra kısa
   sürede (5 dakika içinde) 5 kez öldürerek crash loop korumasının
   devreye girdiğini doğrula

**Bu adım bitince dur ve rapor ver.**

---

### Adım 5.4 — Speed penceresi

Faz 1 ve Faz 2'de bulunan davranış: ffmpeg'in `speed=` alanı **yayın
başından beri hesaplanan ortalama**, anlık değer değil. Bunu ham
haliyle eşik olarak kullanmak yanlış alarm üretir.

1. `FfmpegEncoder`'ın parse ettiği `speed`/`frame` verisinden **anlık**
   hızı kendin hesapla: ardışık iki ilerleme satırı arasındaki
   `frame` farkını `fps`'e böl, geçen gerçek zamana (wallclock) oranla
2. Bu anlık hızın **~30 saniyelik pencere ortalamasını** al (Faz 5.4
   notundaki gerekçe: yayın/restart başında geçici sıçramalar normal)
3. Her restart'ın **ilk 30 saniyesini** pencereye dahil etme (yeni
   sürecin başlangıç sıçraması, Faz 4'te de gözlemlendi)
4. Eşikler: pencere ortalaması `< 0.95` → "encode yetişemiyor" uyarısı,
   `> 1.1` → "anormal hız, sessiz arıza olabilir" uyarısı (Faz 3.1'deki
   video/ses `-re` sorunu gibi bir durumun erken belirtisi)
5. Uyarıları logla, bu adımda otomatik aksiyon alma (örn. otomatik
   restart) — sadece görünürlük, aksiyon ileride eklenebilir

**Test:** Gerçek yayınla birkaç dakika çalıştır, pencere hesabının
mantıklı değerler ürettiğini (1.0 civarı, restart başında sıçrama
görmezden gelinmiş) logdan doğrula.

**Bu adım bitince dur ve rapor ver.**

---

### Adım 5.6 — 6 saatlik dayanıklılık testi

1. Yayını gerçek `music/` klasörü, üretim `batchSize` (50) ile başlat
2. Başlangıçta: bellek kullanımı, disk boş alanı, `runtime/logs/`
   boyutu kaydet
3. **6 saat kesintisiz çalıştır** (arka planda, periyodik olarak durum
   kontrol et — her 30-60 dakikada bir kısa bir rapor bırakman yeterli,
   sürekli mesaj atma)
4. Test boyunca en az 1 kez ffmpeg'i elle öldürerek gerçek bir çökme
   senaryosu yaşat, supervisor'ın toparlandığını doğrula
5. 6 saat sonunda: bellek kullanımını başlangıçla karşılaştır (sızıntı
   var mı), disk kullanımını kontrol et, kaç doğal restart (playlist
   bitişi) ve kaç supervisor müdahalesi (gerçek çökme) olduğunu say
6. `runtime/logs/` rotasyonun gerçekten çalışıp çalışmadığını (50 MB
   sınırı aşıldıysa dosya sayısı 5'i geçmemeli) kontrol et

**Bu adım başlayınca bana haber ver (yaklaşık bitiş saatini söyle),
periyodik kısa güncellemeler bırak, sonunda tam raporla.**

---

### Adım 5.7 — Özet, KARARLAR.md ve temizlik

1. Özet: 6 saatlik test sonucu, bellek/disk durumu, restart/çökme
   sayıları
2. Conflict/dead code kontrolü: tüm `src/` ağacı
3. Arkada kalan process kontrolü
4. `KARARLAR.md`'ye not: speed penceresi tasarımı (neden ham `speed`
   değil pencere ortalaması) ve 6 saatlik test sonucu özet olarak

**Raporu ver ve dur — commit ve PLAN.md güncellemesi sohbette
onaylanacak.**

## PROMPT SONU

---

## Sonraki adım

Bu faz kapanınca sırada Faz 6 (opsiyonel kontrol arayüzü) ya da
doğrudan Faz 7 (VPS) var — YouTube erişimi açıldıysa önce Faz 1'in
gerçek RTMP testi (R2 doğrulaması dahil) araya girecek.
