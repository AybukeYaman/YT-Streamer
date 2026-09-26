# Faz 7 — VPS'e Taşıma (Claude Code Prompt)

> `PROMPTLAR\faz-7-vps.md` olarak kaydet, aşağıdaki bölümü Claude Code'a
> ver.

---

## PROMPT BAŞLANGICI

### Mimari hatırlatma

Faz 2-5'teki katman ayrımına dokunmuyoruz — sadece infrastructure
katmanının çalıştığı ortam değişiyor. Kod tarafında değişmesi gereken
neredeyse hiçbir şey yok, bu fazın büyük kısmı deployment.

**Proje kökü:** `C:\Users\Aybuke Yeni\Desktop\Youtube\YT Stream System`

**Bilinen risk (Faz 4'ten):** Gerçek arkaplan videosuyla CPU kullanımı
test videosunun (`testsrc`) ~2.6 katı çıkmıştı (0.76 → ~2.0 çekirdek,
gerçek zamanlı encode için). PLAN.md'nin "2 vCPU minimum" tahmini bu
veriyle **yeniden değerlendirilmeli** — bu fazın kritik bir parçası.

Kurallar:
- Otonom ilerle, sadece "dur ve rapor ver" ya da [KULLANICI ETKİLEŞİMİ]
  dediğim yerlerde dur
- Faz sonunda tek commit
- SSH ile VPS'e bağlanmak, dosya transfer etmek (rsync/scp) ve orada
  komut çalıştırmak senin işin — bunlar kullanıcının kendi sunucusuna
  yönelik meşru işlemler, izin gerektirmez. Ama VPS'i kiralamak,
  ödeme yapmak, hesap oluşturmak **kullanıcının kendisinin yapması
  gereken şeyler** — bunları yapamazsın, iste

---

### Adım 7.1 — Dockerfile ve docker-compose.yml

1. `Dockerfile`:
   - Node.js + ffmpeg içeren bir temel imaj (örn. `node:20-bookworm` +
     `apt install ffmpeg`, ya da hazır bir ffmpeg imajı üzerine Node
     kurmak — hangisi daha küçük/hızlıysa)
   - `src/`, `package.json`, `config.json` kopyalanır
   - `music/`, `assets/`, `runtime/` **imaja gömülmez** — bunlar volume
     olarak dışarıdan bağlanacak
2. `docker-compose.yml`:
   - `restart: unless-stopped`
   - Volume tanımları: `./music:/app/music`, `./assets:/app/assets`,
     `./runtime:/app/runtime`
   - `.env`'i environment olarak geçir (dosyayı imaja gömme)
3. `.dockerignore`: `node_modules`, `runtime/`, `music/`, `assets/`,
   `.git`, `experiments/`

**Bu adım bitince dur ve rapor ver.**

---

### Adım 7.2 — Yerel Docker testi (VPS olmadan doğrulama)

1. İmajı yerelde build et (`docker build`)
2. `docker compose up` ile başlat, config'i `output.mode: "local"`
   tutarak (henüz RTMP değil) — container içinde ffmpeg gerçekten
   çalışıyor mu, volume'lar doğru bağlanıyor mu doğrula
3. Container içinde birkaç dakika yayın çalıştır, çıktı dosyasının
   (`runtime/out-*.flv`) doğru üretildiğini host'tan kontrol et
4. **CPU ölçümü:** `docker stats` ile container'ın gerçek CPU kullanımını
   ölç, Faz 4'teki host ölçümüyle (~2.0 çekirdek) karşılaştır — Docker
   overhead'i var mı

**Bu adım bitince dur ve rapor ver.**

---

### Adım 7.3 — [KULLANICI ETKİLEŞİMİ] VPS seçimi ve kiralama

**Bu adımda Claude Code ilerlemez, kullanıcıdan bilgi bekler.**

Kullanıcı bir VPS sağlayıcısı seçip kiralayacak. Öneri kriterleri
(Faz 4'ün CPU bulgusuna göre güncellendi):

- **CPU: en az 2 vCPU, tercihen 4 vCPU** — Faz 4'te gerçek arkaplan
  videosuyla gerçek zamanlı encode zaten ~2.0 çekirdek kullanıyordu
  (dev makinede, i7-12650H gibi güçlü bir işlemcide). Paylaşımlı/daha
  zayıf VPS çekirdeklerinde bu pay daha da büyüyebilir, 2 vCPU'nun
  tamamını tüketip encode'un gerçek zamana yetişememesi riski var.
  4 vCPU daha güvenli bir başlangıç noktası.
- **RAM: 4 GB** (Faz 5/6 saatlik testte ffmpeg ~765 MB, Node ~40 MB
  kullanmıştı, ama Docker overhead ve işletim sistemi için pay bırak)
- **Bant genişliği:** upload sınırı olmayan/yüksek bir plan (2500+160
  kbps sürekli upload, aylık ~1 TB civarı veri)
- **Lokasyon:** kanalın hedef kitlesine göre (Türkiye ağırlıklıysa
  Avrupa bölgesi gecikmeyi azaltır, ama RTMP upload için bu kritik değil)

Kullanıcı VPS'i kiralayıp SSH erişimini (IP, kullanıcı adı, SSH anahtarı
ya da parola) kurduğunda "hazır" diyecek. **SSH parolasını/anahtarını
bu sohbete yazma** — SSH anahtarıyla bağlanacaksan anahtarı yerel
makinende tut, Claude Code'a sadece "VPS hazır, IP şu, SSH ile
bağlanabiliyorum" bilgisini ver.

---

### Adım 7.4 — Dosya transferi ve deploy

1. VPS'e SSH ile bağlan, Docker kurulu mu kontrol et, değilse kur
2. `rsync` ile proje dosyalarını VPS'e taşı (`music/`, `assets/`,
   kod, `Dockerfile`, `docker-compose.yml`) — `node_modules`,
   `runtime/`, `.git`, `experiments/` hariç
3. VPS'te `.env` dosyasını **elle** oluştur (rsync ile taşıma, stream
   key'in transfer sırasında düz metin olarak gitmesini istemeyiz —
   SSH zaten şifreli ama yine de VPS'te ayrıca oluşturmak daha temiz)
4. `config.json`'da VPS profiline geç: çözünürlük/bitrate/preset
   ayarlarını Adım 7.5'teki ölçüme göre ayarlayacağız, şimdilik
   yereldeki üretim değerleriyle başla

**Bu adım bitince dur ve rapor ver.**

---

### Adım 7.5 — VPS'te gerçek performans ölçümü

1. VPS'te `output.mode: "local"` ile birkaç dakika test yayını çalıştır
   (henüz RTMP değil — önce VPS'in encode'u gerçek zamanda yetiştirip
   yetiştiremediğini gör)
2. `speed` değerini izle: sürekli ~1.0x'te mi kalıyor, yoksa geride mi
   kalıyor
3. **Karar noktası:** Eğer speed 1.0'ın belirgin altındaysa (encode
   yetişmiyor), şu seçeneklerden birine geç ve tekrar ölç:
   - `preset`i `veryfast`'ten `faster`/`ultrafast`'a düşür
   - Çözünürlüğü 720p'den 480p'ye düşür
   - Bitrate'i düşür
   - (Son çare) daha güçlü bir VPS'e yükseltmeyi kullanıcıya öner
4. Sonucu `KARARLAR.md`'ye kaydet: hangi VPS specs, hangi profil,
   ölçülen speed

**Bu adım bitince dur ve rapor ver — profil kararı sohbette
onaylanacak.**

---

### Adım 7.6 — Geçiş ve 24 saatlik gözlem

1. `config.json`'da `output.mode: "rtmp"` yap, `.env`'deki stream key'i
   doğrula
2. VPS'te Docker container'ı `docker compose up -d` ile başlat
   (`restart: unless-stopped` ile)
3. YouTube Studio'da bağlantının kurulduğunu doğrula (kullanıcı
   kontrol edecek — [KULLANICI ETKİLEŞİMİ])
4. **Yerel makinedeki her şeyi durdur** (varsa çalışan yerel süreç)
5. Kullanıcıdan **yerel makineyi kapatmasını** iste, yayının VPS'ten
   bağımsız devam ettiğini doğrula
6. 24 saatlik gözlem: periyodik olarak (Faz 5'teki gibi, saatte bir
   ya da daha seyrek) VPS'e SSH ile bağlanıp durumu kontrol et —
   container ayakta mı, restart/çökme sayısı, disk durumu

**Bu adım başlayınca haber ver, periyodik güncellemeler bırak, 24
saat sonunda tam raporla.**

---

### Adım 7.7 — Özet ve kapanış

1. Özet: VPS specs, final config profili, 24 saatlik gözlem sonucu
2. `KARARLAR.md` ve `PLAN.md`'yi güncelle
3. Tek commit, push

**Raporu ver ve dur.**

## PROMPT SONU

---

## Sonraki adım

Bu faz kapanınca proje fiilen tamamlanmış olur — kanal 7/24 yayında.
Sonrası bakım/iyileştirme: Faz 6 (kontrol paneli), müzik ekleme iş
akışının kolaylaştırılması (raw/ klasörüne otomatik toplama), arkaplan
rotasyonu gibi konular ihtiyaç oldukça ele alınır.
