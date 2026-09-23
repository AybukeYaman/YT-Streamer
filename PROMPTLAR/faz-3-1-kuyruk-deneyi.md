# Faz 3.1 — Kuyruk Yaklaşımı Deneyi (Claude Code Prompt)

> Bu dosyayı `C:\Users\Aybuke Yeni\Desktop\Youtube\YT Stream System\PROMPTLAR\`
> altına kaydet. Aşağıdaki bölümü olduğu gibi Claude Code'a ver.

---

## PROMPT BAŞLANGICI

### Bağlam ve mimari notu

Bu bir **deney fazı**, üretim kodu fazı değil. Amaç: üç farklı kuyruk besleme
yaklaşımını test edip hangisinin çalıştığını öğrenmek.

Bu yüzden bu fazda **bilinçli olarak katmanlı mimari uygulanmayacak** —
`experiments/` klasöründe bağımsız, atılabilir script'ler yazılacak. Kalıcı
sistem kodu bir sonraki fazda, SOLID ve katmanlı mimariye uygun şekilde
sıfırdan yazılacak. Bu deneyin kodu üretime taşınmayacak.

Kurallar:
- Her adımı sırayla yap, bir adım bitmeden diğerine geçme
- Her adım sonunda ne bulduğunu raporla
- Bulguları `experiments/SONUC.md` dosyasına yaz
- Kod yazmadan önce mevcut durumu kontrol et

**Proje kökü:** `C:\Users\Aybuke Yeni\Desktop\Youtube\YT Stream System`
**Ortam:** Windows, PowerShell, ffmpeg kurulu, Node.js mevcut

---

### Adım 1 — Ortam doğrulama ve test verisi

1. `ffmpeg -version` ve `ffprobe -version` çalıştır, sürümleri `SONUC.md`'ye yaz
   (concat demuxer davranışı sürüme göre değişebiliyor, bu bilgi kritik)
2. `experiments/` klasörünü oluştur
3. `experiments/assets/` altında test için **5 adet kısa ses dosyası** üret —
   ffmpeg'in sine wave generator'ı ile, her biri farklı frekansta ve **20 saniye**
   uzunluğunda. Farklı frekans olması önemli: hangi parçanın çaldığını kulakla
   ayırt edebilmeliyiz.
   - Hepsi aynı parametrede olsun: 48 kHz, stereo, AAC
4. Test için bir arkaplan videosu üret — ffmpeg'in `color` veya `testsrc`
   kaynağıyla, 10 saniyelik, 1280x720, 24fps
5. `ffprobe` ile 5 ses dosyasının da gerçekten aynı parametrede olduğunu doğrula

**Bu adım bitince dur ve rapor ver.**

---

### Adım 2 — Yaklaşım A: Canlı concat beslemesi

**Test edilen varsayım:** ffmpeg'in concat demuxer'ı playlist dosyasını satır
satır okur ve dosyaya yeni satır eklendikçe çalmaya devam eder (process hiç
yeniden başlamadan).

1. `experiments/playlist.txt` oluştur, içinde sadece **ilk 2 parça** olsun:
   ```
   file 'C:/Users/Aybuke Yeni/Desktop/Youtube/YT Stream System/experiments/assets/01.m4a'
   file 'C:/Users/Aybuke Yeni/Desktop/Youtube/YT Stream System/experiments/assets/02.m4a'
   ```
   (Windows'ta düz bölü kullan, tek tırnak içinde)

2. `experiments/test-a.js` yaz:
   - ffmpeg'i `child_process.spawn` ile başlat (dizi argüman kullan, string değil)
   - Girdi: arkaplan videosu (`-stream_loop -1`) + concat playlist
   - Çıktı: `experiments/out-a.flv` (RTMP yok, yerel dosya)
   - ffmpeg stderr'ini satır satır konsola ve bir log dosyasına yaz
   - **25. saniyede** (yani 2. parça çalarken) playlist.txt'ye 3. parçayı ekle
   - **45. saniyede** 4. parçayı ekle
   - ffmpeg'in exit event'ini yakala ve ne zaman/neden çıktığını logla

3. Script'i çalıştır ve gözlemle:
   - ffmpeg 2. parça bitince kapandı mı, yoksa 3. parçaya devam etti mi?
   - Devam ettiyse geçişte bir hata/uyarı log'landı mı?
   - Toplam kaç saniye çalıştı?

4. `out-a.flv` dosyasını `ffprobe` ile incele: gerçek süresi ne kadar?
   Kaç parça içeriyor?

**Bulguyu `SONUC.md`'ye yaz. Bu adım bitince dur ve rapor ver.**

---

### Adım 3 — Yaklaşım B: Uzun playlist + planlı restart

Bu yaklaşım A çalışmasa bile işe yarar, o yüzden her durumda test et.

1. `experiments/test-b.js` yaz:
   - Başlangıçta 5 parçanın hepsini playlist'e yaz
   - ffmpeg'i başlat, `out-b.flv`'ye yaz
   - ffmpeg normal şekilde bitince (playlist tükenince) **hemen yeniden başlat**
     — yeni bir playlist ve yeni çıktı dosyasıyla
   - İki restart yap, toplam 3 tur

2. Ölçülecek: **restart arasındaki boşluk kaç milisaniye?**
   - ffmpeg exit event'i ile yeni process'in ilk frame'i arasındaki süreyi ölç
   - Bunu log'a yaz

3. Not: gerçek yayında bu boşluk RTMP bağlantısının kopması anlamına gelir.
   YouTube bunu nasıl karşılar bilmiyoruz — ama boşluğun ne kadar olduğunu
   bilmek kararı etkileyecek.

**Bulguyu `SONUC.md`'ye yaz. Bu adım bitince dur ve rapor ver.**

---

### Adım 4 — Yaklaşım C: Named pipe (sadece A başarısızsa)

**Bu adımı yalnızca Adım 2 başarısız olduysa yap.** A çalıştıysa atla ve
`SONUC.md`'ye "A çalıştığı için C test edilmedi" yaz.

Windows'ta named pipe Unix'ten farklı çalışır (`\\.\pipe\isim` formatı).
Node'un `net` modülüyle bir named pipe server kurулabilir.

1. Basit bir fizibilite testi yap:
   - Node ile bir named pipe oluştur
   - ffmpeg'i pipe'tan okuyacak şekilde başlat
   - Node tarafından bir ses dosyasının içeriğini pipe'a yaz
   - ffmpeg okuyabildi mi?

2. Çalışıyorsa: ikinci bir dosyayı da arka arkaya pipe'a yaz, kesintisiz
   devam ediyor mu?

3. Bu yaklaşımın karmaşıklığını değerlendir ve `SONUC.md`'ye not düş

**Bu adım bitince dur ve rapor ver.**

---

### Adım 5 — Sonuç raporu ve temizlik

1. `experiments/SONUC.md` dosyasını tamamla. İçermesi gerekenler:
   - ffmpeg sürümü
   - Her yaklaşım için: çalıştı mı, nasıl davrandı, ölçülen değerler
   - Her yaklaşımın artı/eksileri
   - **Önerilen yaklaşım ve gerekçesi**
   - Beklenmedik gözlemler / uyarılar

2. **Conflict ve dead code kontrolü:**
   - `experiments/` altında kullanılmayan dosya veya fonksiyon kaldı mı?
   - Script'ler birbirinin çıktısını eziyor mu?
   - Yarıda kalmış ffmpeg process'i var mı? (Windows Task Manager /
     `Get-Process ffmpeg` ile kontrol et, varsa temizle)
   - Üretilen test dosyalarının toplam boyutu ne kadar? (disk alanı sınırlı)

3. `.gitignore` oluştur: `experiments/out-*.flv`, `experiments/*.log`,
   `experiments/assets/`

**Raporu ver ve dur.**

## PROMPT SONU

---

## Deney sonrası

Sonucu sohbete getir. Birlikte:
- Hangi yaklaşımın seçileceğine karar veririz
- Kararı ve gerekçesini `KARARLAR.md`'ye işleriz
- `PLAN.md`'deki Faz 3'ü bu karara göre güncelleriz
- Faz 2'nin prompt'unu yazarız

**Önemli:** Bu deneyin kodu üretime taşınmayacak. Faz 2'de kalıcı kod
katmanlı mimariye uygun şekilde sıfırdan yazılacak.
