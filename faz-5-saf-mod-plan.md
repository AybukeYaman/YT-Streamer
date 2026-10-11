# Faz 5 — "Saf" görüntü modu (hazır döngü + `-c:v copy`) ve döngü hazırlama aracı

**Durum:** YALNIZCA PLAN. Koda dokunulmadı; her alt faz için ayrı onay beklenir.
**Dayanak:** 12 Ekim 2026 yerel ölçümü (bu dosyadaki sayılar), `src/infrastructure/ffmpeg-encoder.js`
(`buildFfmpegArgs`, `videoInputArgs`), `src/application/stream-orchestrator.js` (satır ~270-300),
`src/domain/album.js`, `src/infrastructure/album-repository.js`, `scripts/prepare-backgrounds.js`,
`src/application/stream-provisioner.js`, `src/config/load-config.js`, `src/ui/config-page.js`.

---

## 1. Neden (ölçüm özeti)

Aynı müzik ve ayarla, 60 sn çıktı için harcanan CPU süresi (3 iş parçacıklı x264 `superfast`, her ölçüm 3 tekrarın en iyisi;
mutlak değerler geliştirme bilgisayarına göre, **oranlar** geçerli):

| Yöntem | CPU | Yazı (şarkı adı) |
|---|---|---|
| A. Video döngü, canlı yeniden kodlama (**bugün**) | 12,5 sn | var (13,2) |
| B. Resim = 10 sn durağan video (hattın bugün ürettiği) | 10,9 sn | var (11,7) |
| B'. Resim, tek kare bellekte | 8,6 sn | var (10,0) |
| B''. Resim her karede PNG çözülürse | 40,9 sn | — (**kaçınılacak**) |
| **C. Hazır döngü + `-c:v copy`** | **0,9 sn** | **yok** |

- Kodlamanın kendisi (720p24 x264) baskın maliyet; resim yalnızca %15-30 kazandırıyor. Asıl kazanç **kodlamayı yayında hiç yapmamak**: ~14 kat.
- **Kalite de artıyor:** canlı `superfast` çıktı kaynağa SSIM 0,981, döngüyü önceden `slow` ile kodlamak 0,993.
- Copy, 95 sn'lik akışta (9 döngü geçişi) denendi: zaman damgaları monoton, anahtar kareler tam 2,00 sn arayla. Uzun süre dayanıklılığı **denenmedi** (Faz 5.4).
- Mevcut `music-source/*/background.mp4` dosyaları zaten 8-16 sn, 1280x720, 24 fps, H.264 High, ~0,4-2,3 Mbps.
- Bedel: copy'de görüntüye **yazı basılamaz** (şarkı adı, Pomodoro sayaç ve klipleri).

Sunucu ölçümü (3 çekirdek): ana yayın (Pomodoro'lu) 0,5x'e düştü; ek yayın 1x. Hedef: ek yayınları Saf modda açıp
çekirdek başına taşıdığımız yayın sayısını artırmak ve ana yayını korumak.

## 2. Hedef davranış

| | **Yazılı** (bugünkü, varsayılan) | **Saf** (yeni) |
|---|---|---|
| Video | döngüyü çöz → filtre → x264 | hazır `loop.mp4`, **kopya** |
| Şarkı adı yazısı / Pomodoro / bip / study-break klipleri | var | **yok** |
| Arkaplan rotasyonu (çok klipli albüm) | var | yok (ilk sürümde tek döngü) |
| CPU | yüksek | çok düşük |
| Kalite | canlı preset'e bağlı | önceden `slow` kodlanmış (daha iyi) |

Karar yayın başına verilir. **Ana yayın Yazılı kalır. Ek yayınlarda varsayılan Saf**, albümde hazır döngü varsa.
Yazılı mod hiç değişmez: mevcut komut satırı birebir korunur (altın test).

## 3. Mimari değişiklikler (özet)

1. **Hazır döngü dosyası:** her albümde `music-source/<albüm>/loop.mp4` (mevcut `background.mp4`'ten türetilir).
   Sabit teknik şartname: 1280x720, 24 fps, H.264 **Main**, `yuv420p`, kapalı GOP, **GOP = 48 kare (2 sn)**, B-kare yok,
   ses yok, süre 2 sn'nin katı (8-16 sn), `-b:v 3500k -maxrate 3500k -bufsize 7000k`, `-preset slow`.
2. **Konfig:** `video.mode: "encode" | "copy"` (yoksa `encode`; `load-config.js` doğrular, bilinmeyen değeri reddeder).
3. **Encoder:** `buildFfmpegArgs` içinde `copyVideo` dalı: `-re -stream_loop -1 -i loop.mp4`, `-map 0:v -map 1:a`,
   `-c:v copy`, filtre/bip/klip/yazı **yok**; ses dalı (`-c:a aac …`, playlist, `-shortest`) aynı.
4. **Orkestratör:** copy modunda overlay yazıcı, Pomodoro planlayıcı, arkaplan rotasyonu devre dışı; albümün `loopPath`'i kullanılır.
5. **Album alanı:** `loopPath` (varsa); `AlbumRepository` `loop.mp4`'ü okur.
6. **Sağlayıcı + arayüz:** yeni yayın formunda "Görüntü: Saf / Yazılı"; kapasite maliyeti moda göre.

## 4. Fazlar

Her faz ayrı onay, her faz sonunda **tek commit** (proje kuralı) ve tam test paketi. Fazlar sırayla; ilk ikisi canlı
yayına dokunmaz.

### Faz 5.1 — Döngü hazırlama aracı (boyut: orta; canlıya etki: yok)
- `scripts/prepare-loops.js` + `npm run loops:prepare`: `music-source/<albüm>/background.mp4` (ya da `backgrounds/*.mp4` ilki)
  → `loop.mp4`. Bayraklar: `--analyze` (yazmaz, rapor), `--force`, `<albüm>…`. Idempotent: kaynak değişmediyse atlar.
- Yeni girdiler: `--from <video|resim> --album <ad>`: 8-10 sn'lik orijinal videoyu ya da resmi şartnameye çevirir
  (resim: 10 sn durağan döngü, `prepare-backgrounds` ile aynı kırpma kuralı).
- Doğrulama (ffprobe): codec/profil/çözünürlük/fps/GOP/anahtar kare aralığı/süre/ses yok. Şartnameye uymayan
  çıktı yazılmaz, neden söylenir.
- Dikiş uyarısı: son ve ilk kare arasındaki fark (SSIM) eşiği altındaysa "döngü fark edilebilir" uyarısı (hata değil).
- Testler: şartname doğrulayıcı (sahte ffprobe çıktısıyla), komut kurucu (altın argümanlar), idempotans.
- Çıktı: `--analyze` raporu ile mevcut 5 albümün durumu.

### Faz 5.2 — Encoder ve orkestratörde copy modu (boyut: büyük; canlıya etki: yok, varsayılan `encode`)
- `load-config.js`: `video.mode` doğrulaması (varsayılan `encode`); `config.example.json` + açıklama.
- `Album.loopPath`, `AlbumRepository`: `loop.mp4` okunur, yoksa `null`.
- `buildFfmpegArgs`: `copyVideo` dalı (bkz. 3.3). `-re` hem video hem ses girişinde (ikisi de gerçek zamanlı; arabellek şişmesi önlemi).
- Orkestratör: `video.mode=copy` iken overlay/Pomodoro/rotasyon kurulmaz; `loopPath` yoksa **net hata** ve Yazılı'ya
  düşmez (sessiz düşme kaliteyi/yükü gizlice değiştirirdi); log'da mod yazılır.
- Sağlık/ilerleme: `parseProgressLine` copy'de de `fps/speed/bitrate` üretiyor mu doğrulanır; `speed-alarm` ve
  `encoder-heartbeat` etkilenmez (testle).
- Testler: Yazılı mod komut satırı **birebir aynı** (mevcut testler değişmez), copy mod altın argümanlar, hatalı konfig, `loopPath` yok.

### Faz 5.3 — Yeni yayın formu ve sağlayıcı (boyut: orta; canlıya etki: yalnızca yeni yayın kurarken)
- `stream-provisioner.js`: girdi `videoMode` (`copy|encode`); `copy` için albümde `loop.mp4` zorunlu; `patchConfig`
  `video.mode` yazar, `copy` iken `overlay.enabled=false`, `pomodoro.enabled=false`. Albüm seçilmemişse (tüm kütüphane)
  `copy` izinli değil (hangi döngü?) — açık hata.
- `config-page.js`: "Görüntü" seçimi (Saf / Yazılı, `segmented`); Saf için albümde döngü yoksa devre dışı ve neden yazar.
  Ek yayın kartında mod rozeti. Yeni yayın formunda Saf seçiliyken Pomodoro/şarkı adı notu.
- Yük koruması: yeni yayının tahmini maliyeti moda göre (Saf ≈ 0,1 çekirdek, Yazılı ≈ 1 çekirdek).
- Testler: sağlayıcı (mod, doğrulama, config yazımı), arayüz (gerçek DOM yardımcısı), form altın dosyası güncellemesi.

### Faz 5.4 — VPS doğrulaması ve uzun süreli deneme (boyut: küçük kod, uzun bekleme)
- Dağıtım, VPS'te `loops:prepare`, bir test yayınını (`lofi3`) **Saf** modda ≥ 4 saat açık bırakma.
- Ölçülür: `speed`, ffmpeg CPU, bellek (arabellek şişmesi), YouTube ingest sağlığı, ses-görüntü kayması,
  döngü dikişinde görsel sıçrama, ağ kopması sonrası yeniden bağlanma.
- Başarı ölçütü: `speed ≥ 1,0x` sürekli, bellek sabit, YouTube "iyi" ingest, kopma/yeniden bağlanma sorunsuz.
- Ana yayın ve ikinci yayın birlikte (4 çekirdek) `speed` 1x.

### Faz 5.5 — Sonraki adaylar (planlanmadı, karar bekler)
- Copy modunda çok döngülü rotasyon (parametreleri aynı klipler `concat` ile; hazırlama aracı bunu garanti eder).
- Hazır döngüye çapraz geçişle (crossfade) görünmez dikiş; durağan resme çok hafif hareket (önceden işlenmiş).
- Yazılı ek yayında yalnızca sayaçlı Pomodoro (klipsiz) için ayrı hafif yol.
- Ana yayını da Saf yapabilme (Pomodoro kapalıysa).

## 5. Riskler ve önlemler

| Risk | Önlem |
|---|---|
| Copy'de uzun süre ses-görüntü kayması / arabellek şişmesi | `-re` iki girişte; Faz 5.4 saatlik deneme; ölçüt belirli; geri alma kolay |
| Döngü dikişinde takılma | Kapalı GOP, B-kare yok, süre 2 sn katı; 95 sn'lik testte sorun yok; Faz 5.4'te uzun test |
| YouTube düşük bitrate uyarısı (durağan döngü) | Hazırlama aracı sabit hedef bitrate verir; gerekirse `nal-hrd=cbr` seçeneği (Faz 5.1'de ölçülür) |
| Kullanıcı Saf'ta Pomodoro/şarkı adı bekler | Formda açık not; seçim yayın başına; Yazılı her zaman seçilebilir |
| `loop.mp4` eskir (background.mp4 değişti) | Araç kaynağın mtime/boyutuna bakar, `--analyze` bayatı gösterir; orkestratör bayatsa uyarı |
| Mevcut yayınlar bozulur | Varsayılan `encode`; Yazılı komut satırı altın testle sabit; tüm değişiklikler eklemeli |

## 6. Geri alma

- **Yayın başına:** config'te `video.mode` → `encode` + servis yeniden başlat; ya da formdan Yazılı yeniden kur.
- **Kod:** faz başına tek commit; `git revert <commit>`. `video.mode` yoksa davranış bugünküyle aynı olduğundan
  Faz 5.1-5.3'ün hiçbiri varsayılan yolu değiştirmez.
- Faz 5.1 çıktısı (`loop.mp4`) yalnızca ek dosyadır, silinebilir.

## 7. Açık kararlar (onay gerekir)

1. Ek yayınlarda **şarkı adı yazısı** kaldırılabilir mi? (Saf varsayılanın şartı)
2. Albümde döngü yokken Saf seçilirse: reddet (öneri) mi, otomatik `loops:prepare` mi?
3. Faz 5.1'de yeni orijinal videoları kabul eden `--from` ilk sürümde olsun mu, yoksa yalnızca mevcut `background.mp4`'ten mi başlayalım?
4. Ana yayın için de Saf seçeneği Faz 5.5'e mi kalsın?
5. Faz 5.4 uzun denemesi için hangi yayın ve ne kadar süre (öneri: lofi3, 4+ saat)?
