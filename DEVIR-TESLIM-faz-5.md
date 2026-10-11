# Devir teslim — Faz 5 (Saf görüntü modu) — sıfırdan başlayan oturum için

Bu dosya, konuşma geçmişini bilmeyen yeni bir Claude oturumunun işi **tek başına** sürdürebilmesi için yazıldı.
Önce bunu, sonra `faz-5-saf-mod-plan.md` (asıl plan) dosyasını oku. Kullanıcı Türkçe konuşur; yanıtların Türkçe olmalı.

## 1. Proje nedir

7/24 YouTube müzik canlı yayını (lofi). Node.js sarmalayıcı, ffmpeg ile müzik + döngü video akıtır.
- Depo: `C:\Users\Aybuke Yeni\Desktop\Youtube\YT Stream System` (Windows, PowerShell/Git Bash). GitHub: `AybukeYaman/YT-Streamer`, dal `main`.
- Canlı sunucu (VPS): `root@37.140.242.65`, repo `/root/YT-Streamer`. Servisler: `yt-streamer` (ana yayın), `yt-streamer@<ad>` (ek yayınlar,
  örn. `lofi3`), `yt-golive` (HTTP sunucu: `/config` mobil sayfası, go-live, yeni yayın kurma). VPS 3 vCPU idi; kullanıcı **4 çekirdeğe çıkaracağını** söyledi.
- Test: `npm test` (şu an 1059 test, hepsi geçiyor). Yeni bağımlılık ekleme.
- Mimari katmanlar: `src/domain` (saf), `src/application` (iş mantığı, fs/child_process import ETMEZ), `src/infrastructure`, `src/composition`,
  `src/ui` (HTML üreten `config-page.js`). Kararlar: `KARARLAR.md`. Eski planlar: `PLAN*.md`, `PROMPTLAR/`.

## 2. Çalışma kuralları (kullanıcının kalıcı tercihleri — mutlaka uy)

1. **Faz başına tek commit.** Ara adımlarda commit yok; faz sonunda tek commit (gerekirse squash). Commit mesajı sonuna şu satırı ekle:
   `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
2. **Push ve deploy için her seferinde açık onay iste.** Push'ı sen yaparsın (onaydan sonra). **VPS'e ssh yok** (izin katmanında kapalı): VPS komutlarını
   kullanıcıya yaz, o çalıştırır. Kullanıcı genellikle yalnızca "şu komutları yaz" ister; uzun açıklama yapma.
3. **Backend/yıkıcı değişiklikte önce plan, onay sonra uygulama.** Kullanıcı bir kez "onayım olmadan Faz 4 backend'ine başlama" demişti; aynı ilke geçerli.
4. **Güvenli silme:** `rm`'de değişken/brace kullanma; önce hedefi doğrula, tam yollarla tek tek sil.
5. **Bash heredoc ters bölü ve ters tırnağı bozar.** Ters bölü / ters tırnak / `${}` içeren dosyaları **Write aracıyla** yaz (ya da Edit). `sed` ile
   `/` içeren regex'te dikkat. (Bu oturumda defalarca bozuldu.)
6. Testler: `npm test`. UI için gerçek DOM yardımcısı `test/ui/helpers/browser-dom.js` (headless Chrome/Edge `--dump-dom`, bağımlılık yok, tarayıcı
   yoksa atlanır). Form altın dosyası: `test/ui/config-page.form-golden.json` (form alan/değer sözleşmesi; değiştirirsen bilinçli güncelle).
7. Kullanıcıya teknik terimi **sade** anlat (örn. "kodlama = videoyu sıkıştırma, benim kodumun kalitesi değil"). Şüphede kısa ve net ol; sayı uydurma,
   ölçmediğini "ölçmedim" de.

## 3. Şu anki durum (12 Ekim 2026)

- Son commit: `f2b24f5` (Faz 5 planı). Hepsi **push'landı** (`origin/main` ile aynı), bu dosya ve `experiments/saf-mod-bench/` hariç.
- VPS'te en son `4c16d48` civarına çekildi; sonraki commit'ler (`839150e` yeni yayın hızlandırma/yük koruması, `aa5542e` ince alanlar, `f2b24f5`)
  için kullanıcıya `git pull && sudo systemctl restart yt-golive` verildi; yapıp yapmadığını **sor**.
- Bu oturumda biten işler (hepsi commit'li):
  - **Faz 4:** `POST /config*` → 303 → `GET /config?flash=<id>` (Post/Redirect/Get), `FlashStore`, `ActionDedupe` (işlem kimliği `n`), `GOLIVE_CONFIG_PRG=0` geri alma
    bayrağı, aynı ad için eşzamanlı kurulum kilidi. Plan: `faz-4-post-redirect-get-plan.md`.
  - **Mobil sayfa yeniden tasarımı** (`src/ui/config-page.js`): Pomodoro süresi istemci doğrulaması, bilinmeyen görünürlük notu, simgeli düğmeler/rozetler
    (CSS mask), adım adım sekmeler (Şu an / Yayın / Sonraki), sağ üst palet ikonuyla 4 tema (pembe, gece, orman, kâğıt), ince alanlar, seçili yayına galeriden kapak.
  - **Yeni yayın hızlandırma:** süre önbelleği tohumlama (`StreamInstances#seedDurations`), plan yalnızca seçili albümleri tarar
    (`AlbumRepository#list({only})`), **yük koruması** (`StreamProvisioner#checkLoad`, `systemLoad`).
- **Bekleyen büyük iş: Faz 5** (aşağıda).

## 4. Faz 5'in gerekçesi (ölçümle)

Kullanıcı sunucuda ana yayın + ek yayın `lofi3`'ü birlikte çalıştırınca ana yayın `speed=0,5x`'e düştü (3 çekirdek yetmedi; ana yayın Pomodoro/overlay'li ~2 çekirdek,
ek yayın ~1 çekirdek). Çözüm yönü: ek yayınlarda videoyu **yeniden kodlamamak**.

Yerel ölçüm (60 sn çıktı için CPU sn, 3 iş parçacıklı x264 superfast; oranlar geçerli) — script'ler `experiments/saf-mod-bench/`:

| Yöntem | CPU |
|---|---|
| A. Video döngü + yeniden kodlama (bugün) | 12,5 (yazılı 13,2) |
| B. Resim = 10 sn durağan video | 10,9 (11,7) |
| B'. Resim tek kare bellekte | 8,6 (10,0) |
| **C. Hazır döngü + `-c:v copy`** | **0,9** (yazı basılamaz) |

Resim yalnızca %15-30 kazandırır; asıl kazanç kodlamayı hiç yapmamak (~14x). Kalite: canlı superfast SSIM 0,981 vs önceden `slow` 0,993. 95 sn copy akışında
dikiş geçişleri sorunsuz (dts monoton, anahtar kare tam 2,00 sn). Uzun süre dayanıklılığı **denenmedi**.

Mevcut `music-source/*/background.mp4` dosyaları zaten 8-16 sn, 1280x720, 24 fps, H.264 High. Resimli albümler `scripts/prepare-backgrounds.js` ile 10 sn'lik durağan videoya çevriliyor.

## 5. Yapılacak: Faz 5.1 → 5.4 (ayrıntı `faz-5-saf-mod-plan.md`)

Sırayla, her faz ayrı onay + tek commit + tam test.

- **5.1 Döngü hazırlama aracı** (`scripts/prepare-loops.js`, `npm run loops:prepare`): `background.mp4` → `music-source/<albüm>/loop.mp4`
  (1280x720, 24 fps, H.264 **Main**, yuv420p, kapalı GOP, **GOP=48 / 2 sn**, B-kare yok (`-bf 0`, `-x264-params open-gop=0`), ses yok, süre 2 sn katı,
  `-b:v 3500k -maxrate 3500k -bufsize 7000k`, `-preset slow`). Bayraklar `--analyze`, `--force`, `<albüm>…`; ffprobe ile doğrulama; idempotent; dikiş SSIM uyarısı.
  Referans komutlar: `experiments/saf-mod-bench/bench-yontemler.sh` içinde `loop_slow.mp4` üretimi. Canlıya etkisi yok.
- **5.2 Encoder/orkestratör copy modu:** `video.mode: "encode"|"copy"` (`load-config.js`, varsayılan encode), `Album.loopPath`, `buildFfmpegArgs` copy dalı
  (`-re -stream_loop -1 -i loop.mp4`, `-map 0:v -map 1:a`, `-c:v copy`, filtre/bip/klip yok), orkestratörde overlay/Pomodoro/rotasyon kapalı;
  `loopPath` yoksa net hata (sessizce Yazılı'ya düşme). **Yazılı komut satırı birebir aynı kalmalı** (mevcut testler değişmemeli).
  İlgili kod: `src/infrastructure/ffmpeg-encoder.js` (`buildFfmpegArgs` ~satır 294), `src/application/stream-orchestrator.js` (~satır 270-300), `src/domain/album.js`.
- **5.3 Yeni yayın formu ve sağlayıcı:** `stream-provisioner.js` girdi `videoMode`; Saf için albümde `loop.mp4` zorunlu ve albüm seçimi şart;
  `patchConfig` ile `video.mode`, `overlay.enabled=false`, `pomodoro.enabled=false`; `config-page.js` yeni yayın formunda "Görüntü: Saf / Yazılı"; yük
  hesabı moda göre (Saf ≈0,1 çekirdek, Yazılı ≈1).
- **5.4 VPS doğrulaması:** kullanıcı deploy eder, VPS'te `loops:prepare` çalıştırır, `lofi3`'ü Saf modda 4+ saat açık bırakır; `speed`, CPU, bellek,
  YouTube ingest, ses kayması, dikiş ölçülür. Komutları kullanıcıya ver.

### Varsayılan kararlar (kullanıcı henüz yanıtlamadı; "önerilere göre" derse bunlarla ilerle, yoksa tek mesajda sor)
1. Ek yayınlarda şarkı adı yazısı **kaldırılabilir** (Saf varsayılan). Ana yayın Yazılı kalır.
2. Albümde döngü yokken Saf seçilirse **reddet** (net hata).
3. Faz 5.1'de önce mevcut `background.mp4`'lerden başla; yeni video/resim için `--from <dosya> --album <ad>` ikinci yarı.
4. Ana yayın için Saf seçeneği Faz 5.5'e kalsın.
5. Faz 5.4: `lofi3`, 4+ saat.

Kullanıcı ayrıca: "kalitemizden ödün vermek istemiyoruz", ek yayınlarda Pomodoro isteyebilir (Yazılı modda mümkün; Saf'ta değil), ve ileride 8-10 sn'lik orijinal
döngü videoları/resimleri ekleyebilmek istiyor (Faz 5.1 `--from`).

## 6. Bilinen tuzaklar

- ffmpeg'de resmi her karede PNG olarak çözmek çok pahalı (40 sn CPU); resim girdisi hazır durağan videoya ya da `loop` filtresine çevrilmeli.
- Copy modunda ses `-re` ile gerçek zamanlı, video dosyadan hızlı okunur: arabellek şişmesini önlemek için `-re` her iki girişte; 5.4'te bellek izle.
- YouTube anahtar kare aralığı ≤4 sn ister (2 sn ile uyumlu). Durağan döngü bitrate'i hedefin çok altında kalabilir; gerekirse `nal-hrd=cbr` (ölçülmedi).
- `exists(name)` `runtime/<ad>` varlığına bakar: tohumlama/ara dizin oluşturma sırası önemli (şu an ilk `provision`'dan sonra).
- Her `yt-streamer@<ad>` kendi `runtime/<ad>/durations.json` önbelleğini kullanır.
- Önizleme (headless Chrome) 390 px yerine kırpılmış görüntü verir; dar ekranı göremezsin, kullanıcıdan ekran görüntüsü iste.

## 7. İlk yapılacaklar (sırayla)

1. `git status`, `git log --oneline -8` ile durumu doğrula; `npm test` çalıştır (1059 geçmeli).
2. Kullanıcıya VPS'in son sürümde olup olmadığını sor (gerekirse `git pull && sudo systemctl restart yt-golive` komutlarını ver).
3. Kullanıcı "önerilere göre / başla" derse **Faz 5.1**'e geç; `faz-5-saf-mod-plan.md` bölüm 4'teki 5.1 maddelerini uygula; testle bitir; tek commit; push için onay iste.
4. Sonraki fazlara geçmeden önce kullanıcıdan açık onay al.
