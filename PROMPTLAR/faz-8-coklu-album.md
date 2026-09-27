# Faz 8 — Çoklu Albüm Desteği (Claude Code Prompt)

> `PROMPTLAR\faz-8-coklu-album.md` olarak kaydet, aşağıdaki bölümü
> Claude Code'a ver.

---

## PROMPT BAŞLANGICI

### Mimari hatırlatma

Faz 2-7'deki katman ayrımına aynen uy. Yeni kod domain/application/
infrastructure'a dağılacak.

**Kaynak klasör:** `C:\Users\Aybuke Yeni\Desktop\Youtube\videolar`
(proje dışında, sadece OKUNACAK, hiçbir dosya taşınmayacak/silinmeyecek)

**Kararlar (sohbette verildi):**
- Codec karışıklığı sorun değil, mevcut `normalize.js` boru hattı çözüyor
- Başlıklardan `[usesuno.com]` gibi üretici imzaları temizlenecek,
  `(Take 2)` gibi anlamlı etiketler korunacak
- Japonca karakterler (21 dosya) bilinen sınırlama, engelleyici değil
- Bozuk/boş albümler (`vid3`, `video6`, `video3-tokyoNight`, `video2-`)
  ve eski düzendeki `video1` tarama dışı
- Arkaplan değişimi **albüm sınırında** (restart anında), parça bazında değil

Kurallar:
- Otonom ilerle, sadece "dur ve rapor ver" ya da beklenmedik hata/karar
  durumunda dur
- Faz sonunda tek commit
- Kaynak klasördeki hiçbir dosyayı değiştirme — sadece oku, projeye
  kopyala/normalize et

---

### Adım 8.1 — Arkaplan ön işleme

1. `scripts/prepare-backgrounds.js`:
   - Her geçerli albüm için `project.json`'daki `cropBottom` değerini oku
   - `videolar/` klasöründeki klibi (birden fazla varsa `project.json`'daki
     `clip` alanının işaret ettiğini) al
   - `crop` ile alttaki logoyu kes (cropBottom kadar), sonra **en-boy
     oranını koruyarak** 1280×720'ye getir (gerekirse ortadan kırp/doldur,
     düz `scale` ile esnetme yapma)
   - Çıktıyı `music-source/<albüm-adı>/background.mp4` gibi bir ara
     klasöre yaz (proje içinde, git'e girmeyecek)
   - `--analyze` modu: hiçbir şey işlemeden, hangi albümlerin hangi
     crop/aspect değerlerine sahip olduğunu raporla (Faz 2.5'teki
     analiz adımı gibi)

**Test:** 2-3 albümle çalıştır, çıktı videolarını bir kare çıkararak
görsel kontrol et — logo kesilmiş mi, distorsiyon var mı.

**Bu adım bitince dur ve rapor ver.**

---

### Adım 8.2 — Albüm-farkında müzik normalizasyonu ve başlık temizliği

1. `scripts/normalize.js`'i genişlet (ya da yeni bir script):
   - `videolar/<albüm>/audio/` içindeki dosyaları oku (project.json'daki
     parça listesine değil, gerçek klasör içeriğine güven — raporda
     belirtildiği gibi güvenilir değil)
   - Başlık temizliği: `[usesuno.com]` gibi bilinen üretici imzalarını
     regex ile temizle, `(Take 2)` gibi parantez içi etiketleri koru
   - Mevcut normalize mantığıyla (loudnorm + limiter, Faz 2.5'teki A
     yaklaşımı) `music-source/<albüm-adı>/music/` altına yaz

**Test:** 2-3 albümün müziklerini normalize et, başlıkların temizlendiğini
doğrula.

**Bu adım bitince dur ve rapor ver.**

---

### Adım 8.3 — Domain: `Album` ve albüm-farkında kuyruk

1. `src/domain/album.js`: albüm adı, arkaplan yolu, parça listesi
2. `src/infrastructure/album-repository.js`: `music-source/` altındaki
   albümleri tarar (bozuk/boş olanlar zaten orada olmayacak, Adım
   8.1-8.2 onları atladı)
3. `Queue`/`PlaylistWriter` güncellemesi: bir batch (playlist) **tek bir
   albümün** parçalarından oluşacak — böylece bir restart döngüsü
   boyunca arkaplan sabit kalır. Albüm sırası shuffle olabilir (aynı
   albüm arka arkaya gelmesin)
4. `StreamOrchestrator`: her restart'ta yeni albümün arkaplan yolunu
   `FfmpegEncoder`'a geçir (şu an sabit `assets/background.mp4` — bunu
   dinamikleştir)

**Test:** Gerçek 2-3 albümle, en az 2 restart gözlemle — arkaplan
gerçekten değişiyor mu, albüm içindeki parçalar karışmıyor mu.

**Bu adım bitince dur ve rapor ver.**

---

### Adım 8.4 — Özet, KARARLAR.md ve temizlik

1. Özet: kaç albüm işlendi, kaç parça, gerçek test sonucu
2. `KARARLAR.md`'ye ekle: Japonca karakter sınırlaması, arkaplan crop/
   aspect kararı, albüm sınırında değişim gerekçesi
3. Conflict/dead code kontrolü
4. Arkada kalan process kontrolü

**Raporu ver ve dur — commit onayı sohbette verilecek.**

## PROMPT SONU
