# Plan: yayın yapılandırmasını kullanıcı dostu hale getirme

> Bu dosya, konuyu hiç bilmeyen bir oturumun tek başına uygulayabilmesi için yazıldı.
> Önce "Sorun" ve "Mevcut durum" bölümlerini oku; kod yazmadan önce adı geçen dosyaları aç.

## Sorun

Yayının içeriği (hangi müzik, Pomodoro açık mı, süresi ne, çalışma/mola videosu hangisi)
**yayın planında** tutuluyor: `<runtime>/stream-plan.json`. Planı üreten arayüz (TUI
sihirbazı) var ve çalışıyor, ama **VPS'te kullanılamıyor**:

- Yayın VPS'te `yt-streamer.service` olarak koşuyor ve `runtime/` klasörünü instance
  kilidiyle (`src/infrastructure/instance-lock.js`) tutuyor.
- `npm run configure` ikinci bir `index.js` süreci açıyor → kilit onu reddediyor:
  `runtime klasörü başka bir instance tarafından kullanılıyor (PID ...)`.
- Kilit DOĞRU davranıyor (iki yayın motoru aynı runtime'ı paylaşmamalı). Sorun, sihirbazın
  yayın motoruyla aynı sürece bağlı olması.

Bugün tek yol: SSH + `cat > runtime/stream-plan.json` ile elle JSON yazmak. Kullanıcı
bunu yapabiliyor ama pratik değil (kullanıcının terminali ~80 karakterde satır kırıyor,
heredoc girintisi bozuluyor, yollar elle yazılıyor).

**Hedef:** "mola videosu bu olsun, çalışma videosu bu olsun, Pomodoro süresi bu olsun"
demek, SSH ve JSON olmadan mümkün olsun.

## Mevcut durum (bu plan yazılırken)

- Yayın VPS'te çalışıyor, plan dosyası elle yazıldı ve çalışıyor:
  `studyVideo` ve `breakVideo` ffmpeg komutunda doğrulandı.
- `yt-streamer.service` ve `yt-golive.service` ikisi de `User=root`,
  `WorkingDirectory=<repo>`. Yani go-live süreci `systemctl restart yt-streamer`
  çalıştırabilir.
- `yt-golive` HTTP sunucusu ayakta: bearer token'lı, hız sınırlı, tailscale ile
  telefondan HTTPS üzerinden erişilebiliyor (kullanıcı go-live'ı böyle tetikliyor).
- Testler: `npm test` → 770 test, hepsi geçiyor. Yeni iş de testli gelmeli.

## Çözüm: üç faz

**Faz N1 — `--plan-only` kipi** (küçük, bugün kullanılabilir): sihirbazı yayın motoru
kurmadan ve kilit almadan açar. SSH'ta çalışır.

**Faz N3 — çoklu study/break klibi + session başına rastgele seçim**: kullanıcı birden
çok çalışma/mola görseli seçebilsin; her session (her çalışma ya da mola fazı) havuzdan
rastgele birini kullansın, ardışık iki session aynı klibi KULLANMASIN.

**Faz N2 — web yapılandırma sayfası** (asıl çözüm): `yt-golive` sunucusuna `/config`
route'u. Telefondan açılır, form doldurulur, kaydedilir. SSH yok.

**Önerilen sıra: N1 → N3 → N2.** N3 plan şemasını değiştiriyor (tek klip → klip listesi);
N2'nin formu önce yazılırsa iki kez yazılmış olur. N1 bağımsız ve kullanıcıyı hemen
rahatlattığı için başa alınıyor.

---

# Faz N1 — `--plan-only` kipi

## Ne yapacak

```
npm run plan                 # sihirbaz açılır, plan kaydedilir (yayına dokunmaz)
npm run plan -- --restart    # kaydeder VE yt-streamer.service'i yeniden başlatır
```

Sihirbaz bugünküyle aynı (aynı `ConfigWizard`, aynı Ink görünümü). Tek fark: altında
yayın motoru yok, kilit alınmıyor.

## Neden kilit almamak güvenli

Kilit "iki yayın MOTORU aynı runtime'ı paylaşmasın" diye var (playlist.txt, state.json
çakışması + aynı stream key'e iki bağlantı). Plan-only süreç:

- ffmpeg başlatmaz, encoder/orchestrator/supervisor kurmaz,
- `playlist.txt`, `state.json`, `pomodoro.json` dosyalarına DOKUNMAZ,
- yalnızca `stream-plan.json` ve hazırlanan klipleri (`study-background.mp4`,
  `break-background.mp4` + `.json` meta) yazar.

Klip dosyalarını çalışan ffmpeg açık tutuyor olabilir: Linux'ta `rename` yeni bir inode
oluşturur, çalışan ffmpeg eski içeriği görmeye devam eder, yeni içerik bir sonraki
başlatmada devreye girer. Bu zararsız ve zaten istenen davranış. **Bu gerekçe koda yorum
olarak yazılmalı.**

## Dokunulacak dosyalar

### 1. `src/config/parse-args.js`
- Yeni bayrak: `--plan-only` → `{ planOnly: true, tui: true, configure: true }`.
  (TUI ve sihirbaz zaten açılmalı; `configure` yayının otomatik başlamasını engelliyor.)
- Yeni bayrak: `--restart` → `{ restartService: true }` (yalnızca plan-only ile anlamlı;
  tek başına verilirse hata atmalı — sessiz yoksayma yok, dosyanın mevcut üslubu bu).
- `DEFAULTS`'a eklenecek. Bilinmeyen argüman hatası korunuyor.
- Testler: `test/config/parse-args.test.js` — yeni bayraklar, kombinasyon, hatalı kullanım.

### 2. `src/application/plan-only-control-service.js` (YENİ)
`StreamConfigService`'in beklediği `controlService` sözleşmesini yayın motoru olmadan
karşılayan sınıf. UI-agnostik, `fs`/`child_process` İMPORT ETMEZ (katman kuralı —
komut çalıştırıcı dışarıdan enjekte edilir).

```js
new PlanOnlyControlService({
  // runRestart: () => Promise<{ ok, message }> | null
  // null ise restart denenmez; sihirbaz sonucu "elle restart gerekiyor" der.
  runRestart = null,
  log,
})
```

- `getStatus()` → `{ state: 'stopped', uptime: 0, fps: null, bitrateKbps: null, speed: null, runNumber: 0 }`
  (panoyu bozmaz, sihirbaz "yayın durmuş" kipinde açılır)
- `getCurrentTrack()` → `null`
- `getUpcomingQueue()` → `[]`
- `start()` / `stop()` → anlamlı hata ya da no-op + log (bu süreç yayın başlatmaz)
- `restart()` → `runRestart` varsa onu çağırır; yoksa log'a "plan kaydedildi; devreye
  almak için: systemctl restart yt-streamer" yazar. **Hata fırlatmamalı** — aksi halde
  sihirbaz "başlatılamadı" der ve kullanıcı planın kaydedildiğini sanmaz
  (`StreamConfigService.applyAndRestart` önce `apply()` yapıyor, yani plan ZATEN yazılmış olur).
- Testler: `test/application/plan-only-control-service.test.js`.

### 3. `index.js`
`args.planOnly` ise ayrı bir kurulum yolu:
- `acquireLock` **çağrılmaz** (yukarıdaki gerekçe yorum olarak yazılsın).
- Kurulan nesneler: `Logger`, `LogBuffer`, `DurationCache`, albüm deposu
  (`AlbumRepository`/`SingleAlbumRepository`), `StreamPlanStore`, `MediaLibrary`,
  `ensureStreamClip`, `StreamConfigService`, `PlanOnlyControlService`, `StreamTui`.
- Kurulmayanlar: `FfmpegEncoder`, `StreamOrchestrator`, `Supervisor`,
  `StreamControlService`, `SpeedAlarm`, `WebhookAlerter`, `StateStore`, pomodoro
  planlayıcısı/overlay yazarı.
- `--restart` verilmişse `runRestart` olarak `child_process.spawnSync('systemctl',
  ['restart', unit])` saran bir fonksiyon geçilir (unit adı sabit `yt-streamer.service`,
  ileride `--service` ile değiştirilebilir). `systemctl` yoksa/başarısızsa sonucu
  sihirbazın uyarı satırına düşür.
- Kapanış: sihirbaz çıkınca süreç kapanmalı (`onQuit` → `tui.close()`; yayın olmadığı
  için `controlService.stop()` gereksiz).
- `durationCache.flush()` kapanışta çağrılmalı (mevcut davranışla aynı).

### 4. `package.json`
```json
"plan": "node index.js --plan-only"
```

## Kabul kriterleri (Faz N1)
- VPS'te yayın ÇALIŞIRKEN `npm run plan` kilide takılmadan açılıyor.
- Sihirbazda study/break videosu + Pomodoro süresi seçilip START STREAM denince
  `runtime/stream-plan.json` güncelleniyor, klipler hazırlanıyor.
- `--restart` ile `yt-streamer` yeniden başlıyor ve loglarda
  `aktif yayın planı: "<ad>"` + `(study arkaplanı plandan)` görünüyor.
- `--restart` olmadan yayına DOKUNULMUYOR; sihirbaz "devreye almak için restart" diyor.
- `npm test` yeşil.

---

# Faz N2 — web yapılandırma sayfası

## Ne yapacak

`yt-golive` sunucusuna iki route:

```
GET  /config   → mobil uyumlu form (mevcut ayarlar dolu gelir)
POST /config   → doğrula → planı yaz → klipleri hazırla → (istenirse) yayını restart et
```

Telefondan tailscale adresiyle açılır; kimlik doğrulama mevcut token ile (go-live'daki
gibi `?token=` ya da `Authorization: Bearer`).

Form alanları (v1):
- Pomodoro: açık / kapalı
- Süre: `50+10`, `30+10`, serbest (`<çalışma>+<mola>`, örn. `45+15`)
- **Çalışma görselleri: ÇOKLU seçim** (onay kutuları) — N3 ile havuz oluyor
- **Mola görselleri: ÇOKLU seçim**
- Kaydet / Kaydet ve yeniden başlat

Çoklu seçim olduğu için `<select>` yerine onay kutusu listesi kullan: telefonda çoklu
`<select>` kullanımı zordur. Seçilen her kutu aynı ada sahip olur (`studyVideos`) ve
sunucu tarafında `URLSearchParams.getAll('studyVideos')` ile okunur. Formda havuzun
yanında "session başına rastgele biri seçilir, ardışık iki session aynı olmaz" diye
kısa bir açıklama satırı olsun — davranış sürpriz olmasın.

**v1'de müzik/albüm seçimi YOK** (öneri): 498 parçalık listeyi telefonda seçtirmek
kullanışlı değil, "tüm kütüphane" varsayılanı korunur. Planın `music.albums` alanı
olduğu gibi bırakılır (mevcut seçim varsa BOZULMAZ — bu önemli, form onu silmemeli).

## Mimari kurallar (bu projede zorunlu)

- `src/domain/` hiçbir şey import etmez (Node modülü bile).
- `src/application/` `fs`, `child_process` ve `src/infrastructure/` import ETMEZ —
  mimari testleri bunu zorluyor. Bağlama `src/composition/` ya da `index.js`/script'te yapılır.
- HTTP sunucusu `node:http`, **bağımlılık eklenmeyecek** (projede React/Express yok,
  `ink` dışında runtime bağımlılığı yok).
- Yorumlar Türkçe ve NEDEN'i anlatır (ne yaptığını değil) — dosyaların mevcut üslubuna bak.
- Dosya yazımı `writeFileAtomic` ile.

## Dokunulacak dosyalar

### 1. `src/ui/config-page.js` (YENİ) — saf HTML üretimi
```js
renderConfigPage({ plan, clips, pomodoroTypes, token, notice, error }) -> string
```
- Saf fonksiyon: veri → HTML metni. `fs` yok, http yok → kolayca test edilir.
- `<meta name="viewport" content="width=device-width, initial-scale=1">`, satır içi CSS,
  tek sütun, büyük dokunma hedefleri (telefon).
- `token` gizli alan olarak forma gömülür (POST'un yetkilenmesi için).
- Video seçimleri `<select>`; her `<option>` değeri **listedeki tam yol**, etiketi
  `MediaLibrary`'nin verdiği kısa etiket (`mimi/break.mp4`).
- Testler: `test/ui/config-page.test.js` — alanlar doluyor mu, seçili değer işaretli mi,
  HTML kaçışı (dosya adında `<`, `&`, `"` olabilir) yapılıyor mu.

### 2. `src/application/config-api.js` (YENİ) — form ile servis arası köprü
```js
new ConfigApi({ configService, pomodoroTypes, restartStream = null, log })
  async form()            -> { plan, clips, pomodoroTypes }
  async save(fields)      -> { ok, plan, warnings, restarted, error }
```
- `save` kuralları:
  - `studyVideo`/`breakVideo` **yalnızca `clips` listesindeki yollardan biri** olabilir
    (ya da boş = yok). Rastgele yol kabul EDİLMEZ — yol sızması/traversal kapatılır.
  - Pomodoro türü `domain/pomodoro.js`'teki `resolvePomodoroType` ile doğrulanır
    (tek kaynak; yeni tür eklenince burası kendiliğinden kabul eder).
  - Mevcut planın `music`, `cover`, `metadata` alanları KORUNUR
    (`StreamPlan.with({...})` kullan).
  - Doğrulama hatası → `{ ok: false, error }`, plan YAZILMAZ.
  - Yazma: `configService.apply(plan)` (klipleri de hazırlar, uyarıları döndürür).
  - `restartStream` verilmişse ve kullanıcı istediyse çağrılır; hatası `ok`'u bozmaz
    (plan kaydedildi, yalnızca devreye alınamadı — mesajda belirtilir).
- Testler: `test/application/config-api.test.js` — geçersiz tür, liste dışı yol,
  mevcut müzik seçiminin korunması, klip uyarılarının taşınması, restart hatası.

### 3. `src/infrastructure/golive-server.js` — iki route
- Kurucuya opsiyonel `configApi` eklenir. Verilmezse `/config` 404 döner
  (mevcut kurulumlar etkilenmez — projenin "özellik opsiyonel" deseni).
- `GET /config` → `renderConfigPage(...)`, `Content-Type: text/html; charset=utf-8`.
- `POST /config` → gövdeyi OKU (mevcut `drainBody` gövdeyi atıyor; yeni bir
  `readBody(req, limit)` gerekiyor, `MAX_BODY_BYTES` sınırı korunarak),
  `application/x-www-form-urlencoded` çöz (`new URLSearchParams(text)`),
  `configApi.save()` çağır, sonucu aynı sayfayı `notice`/`error` ile yeniden basarak döndür
  (POST-redirect-GET istenirse 303 + `Location: /config?token=...` de olur; basit tut).
- Hız sınırı: `RATE_LIMITS`'e `'/config'` kovası eklenir (örn. 30/dk).
- Token formda gizli alan olarak geldiği için `#authorized` gövdeyi de kabul etmeli —
  **dikkat:** `#authorized` şu an yalnızca header ve query'ye bakıyor. En temizi formun
  `action`'ına token'ı query olarak koymak (`/config?token=...`) ve `#authorized`'a
  dokunmamak. Gövdeden token okumak, gövdeyi auth'tan ÖNCE okumayı gerektirir; bundan kaçın.
- Testler: `test/infrastructure/golive-server.test.js` — auth'suz 401, `/config` kovası,
  GET HTML dönüyor, POST `configApi.save`'e doğru alanlarla gidiyor, 404 (configApi yokken).

### 4. `src/composition/config-wiring.js` (YENİ)
`StreamConfigService`'i kurmak hem `index.js` hem `scripts/golive-server.js` tarafından
gerekiyor; iki yerde kopyalanırsa zamanla ayrışır (projede bunun emsali:
`src/composition/go-live-wiring.js`).

```js
buildConfigService({ config, logger, probeDuration }) -> StreamConfigService
```

**v1 sadeleştirmesi:** go-live tarafında albüm taraması YAPMA. `listClips()` albüm
arkaplanlarını da listeliyor ve bu `AlbumRepository.list()` → ffprobe zinciri demek.
Bunun iki sakıncası var:
  1. go-live süreci her form açılışında kütüphaneyi tarar (yavaş),
  2. `runtime/durations.json` ÖNBELLEĞİNE İKİ SÜREÇ yazar.

İki çözüm (biri seçilmeli, kararı KARARLAR.md'ye yaz):
  - **(a) Önerilen:** v1'de klip listesi yalnızca `MediaLibrary.videos()` olsun
    (albüm klasörlerindeki ve `assets/` altındaki videoları zaten tarıyor, ffprobe
    gerektirmiyor). Albüm deposu go-live tarafında hiç kurulmaz.
  - (b) Albüm listesi gerekiyorsa: `writeFileAtomic`'teki geçici dosya adı süreçler
    arasında çakışmayacak hale getirilmeli (`${file}.${process.pid}.tmp`) — iki süreç
    aynı `.tmp`'ye yazarsa biri diğerinin yazdığını `rename` edebilir.
    (Bu düzeltme (a) seçilse bile başlı başına doğru bir iyileştirme.)

### 5. `scripts/golive-server.js`
- `buildConfigService` ile servis kurulur, `ConfigApi` oluşturulur,
  `restartStream` olarak `systemctl restart yt-streamer.service` saran bir fonksiyon geçilir.
- `GoLiveServer`'a `configApi` geçilir.
- Açılış logunda route listesine `/config` eklenir.

## Kabul kriterleri (Faz N2)
- Telefondan `https://<tailscale-host>/config?token=...` açılıyor, mevcut ayarlar dolu geliyor.
- Çalışma/mola videosu değiştirilip kaydedilince `runtime/stream-plan.json` güncelleniyor
  ve planın `music` seçimi değişmiyor.
- "Kaydet ve yeniden başlat" sonrası loglarda yeni plan görünüyor.
- Liste dışı bir yol POST edilirse reddediliyor (plan yazılmıyor).
- Token'sız istek 401; `/config` kendi hız sınırı kovasında.
- `npm test` yeşil.

---

# Faz N3 — çoklu study/break klibi, session başına rastgele

## İstenen davranış

Kullanıcı çalışma için birden çok görsel/loop video seçebilsin, mola için de ayrı bir
liste. Her **session** (her çalışma fazı, her mola fazı) kendi havuzundan rastgele bir
klip kullansın; **bir sonraki aynı tür session, bir öncekinden FARKLI** bir klip seçsin
(kalanlar arasından rastgele).

Bu, `src/domain/queue.js`'teki shuffle kuralının aynısı: "her tur listenin karıştırılmış
bir kopyası; aynı eleman arka arkaya gelmez (tur sınırında da)". Mantığı yeniden icat etme,
oradaki kuralı tekrar kullan.

## İki zor nokta (çözümleriyle)

### 1. Seçim RESTART'A DAYANIKLI olmalı

ffmpeg her playlist bitişinde yeniden başlıyor (~2 saatte bir) ve bu bir session'ın TAM
ORTASINA denk gelebilir. Seçim her başlatmada yeniden rastgele yapılırsa, kullanıcı
çalışmanın ortasında arka planın değiştiğini görür — istenen bu değil.

**Çözüm: seçim rastgele değil, DETERMİNİSTİK olmalı.** Pomodoro döngüsünün zaten diskte
duran bir çapası var: `runtime/pomodoro.json` → `startedAt` (bkz. `PomodoroStore`).
Oraya bir `seed` daha yazılır ve klip, fazın SIRA NUMARASINDAN hesaplanır:

```
phaseIndex = döngü başlangıcından bu yana kaçıncı faz (study ve break ayrı sayılır)
klip       = seededShuffleAt(havuz, seed, phaseIndex)
```

Aynı faz numarası + aynı seed = aynı klip. Restart, çökme, deploy seçimi değiştirmez —
`startedAt`'in döngüyü kaydırmaması ile birebir aynı ilke.

`seededShuffleAt`, `Queue`'nun tur mantığının saf/konumsal hali olmalı: tur = havuzun
karıştırılmış kopyası, tur sınırında ilk eleman önceki turun sonuncusuyla aynı olamaz,
ve `index`'inci elemanı döndürür. Yeni bir PRNG gerekiyor (saf, bağımlılıksız — mulberry32
yeterli) ve `src/domain/` altında kalmalı.

**Tek elemanlı havuz:** tekrar kuralı uygulanamaz, hep aynı klip döner (doğru davranış).
**Boş havuz:** klip yok, o faz için overlay üretilmez (albüm arkaplanı görünür).

### 2. ffmpeg'e nasıl veriliyor — ve CPU maliyeti

Her şey ÖNCEDEN hesaplanıyor (projenin temel ilkesi): faz pencereleri zaten
`PomodoroCycle.segmentsFor()` ile biliniyor. Yapılacak şey, mevcut mola overlay'ini
genelleştirmek — bugün tek klip tüm mola pencerelerine bindiriliyor
(`buildFfmpegArgs` içindeki `breaking` dalı), bundan sonra **pencere başına kendi klibi**
bindirilecek.

Filtre iskeleti (W/H profilden):

```
[0:v]scale=W:H,setsar=1[base]              # albüm arkaplanı = taban katman
[2:v]scale=W:H,setsar=1,split=2[c0a][c0b]  # split YALNIZCA birden çok pencerede kullanılan klip için
[base][c0a]overlay=enable='<pencere1>'[o1]
[o1][c1a]overlay=enable='<pencere2>'[o2]
...
[oN]<drawtext zinciri>[v]
```

- Girişler: 0 = albüm arkaplanı (ya da rotasyon concat'i), 1 = ses, 2..K = **bu
  çalıştırmada kullanılan FARKLI klipler**, sonra (varsa) bip.
- Aynı klip birden çok pencerede kullanılıyorsa `split` ile çoğaltılır (bir giriş akışı
  filtre grafiğinde yalnızca bir kez tüketilebilir).
- Pencere ifadeleri bugünkü `enableExpr`/`enableAny` ile üretilir — değişmiyor.
- Son pencerenin bitişi `null` (açık uçlu), bugünkü kuralla aynı.

**CPU:** her ek giriş `-stream_loop -1` ile sürekli decode edilir. Bugün 2 video girişi
var (study + break); N3 sonrası tipik bir çalıştırmada 2 saatlik playlist ≈ 2 döngü ≈
4-6 faz, yani **en fazla 4-6 farklı klip** olabilir. VPS 2 vCPU ve encode şu an 1.000x
ile sınıra yakın çalışıyor.

Bu yüzden:
- Çalıştırma başına **farklı klip sayısına üst sınır koy** (öneri: `MAX_CLIPS_PER_RUN = 4`).
  Sınır aşılırsa fazlası, zaten kullanılan kliplerden birine düşürülür (deterministik
  şekilde: `phaseIndex % kullanılanlar.length`). Sebebi koda yorum olarak yazılsın.
- Deploy sonrası **ölçülmeli**: loglardaki `hız(30sn)` 0.95'in altına inerse havuz
  küçültülmeli ya da `profile.preset` düşürülmeli. `SpeedAlarm` bunu zaten bildiriyor.
- Kabul testine "4 klipli bir çalıştırmada gerçek ffmpeg ile 60 sn render, speed ≥ 1.0"
  maddesi eklenmeli.

## Plan şeması değişikliği (geriye dönük uyumlu)

```jsonc
"pomodoro": {
  "enabled": true,
  "type": "50+10",
  "studyVideos": ["/yol/a.mp4", "/yol/b.mp4"],   // YENİ: liste
  "breakVideos":  ["/yol/c.mp4"],                // YENİ: liste
  "studyVideo": "/yol/a.mp4",                    // ESKİ: tek değer, hâlâ kabul edilir
  "breakVideo":  "/yol/c.mp4"
}
```

`StreamPlan` normalleştirmesi (`src/domain/stream-plan.js` → `normalizePomodoro`):
- `studyVideos`/`breakVideos` verilmişse: dizi, boş olmayan metinler, **tekrarlar atılır**.
- Yoksa `studyVideo`/`breakVideo` (metin) tek elemanlı listeye çevrilir.
- İkisi de yoksa boş liste.
- `toJSON()` HER ZAMAN liste biçimini yazar (tek kaynak); eski alan okuma için kalır.
- **VPS'te şu an çalışan plan tek değerli** — bu uyumluluk şart, yoksa canlı yayın bozulur.

## Dokunulacak dosyalar

| Dosya | Ne |
|---|---|
| `src/domain/seeded-shuffle.js` (YENİ) | saf PRNG + `shuffledAt(pool, seed, index)` (tur sınırında tekrar yok) |
| `src/domain/stream-plan.js` | `studyVideos`/`breakVideos` normalleştirme + geriye uyumluluk |
| `src/domain/pomodoro.js` | `segmentsFor` çıktısına `phaseIndex` ekle (döngü başından beri kaçıncı faz) |
| `src/infrastructure/pomodoro-store.js` | `seed` sakla (yoksa üret ve yaz; tür değişince sıfırlanır — mevcut kural) |
| `src/application/pomodoro-planner.js` | pencere başına klip ataması; çıktıya `phaseBackgrounds: [{ path, windows }]` |
| `src/application/stream-config-service.js` | tek klip yerine LİSTE hazırla (her klip ayrı çıktı adı: `study-1`, `study-2`, …) |
| `src/infrastructure/break-clip.js` | zaten `name` parametresi alıyor — çoklu çağrı için yeterli |
| `src/infrastructure/ffmpeg-encoder.js` | `breakBackground` yerine genel `phaseBackgrounds`; çoklu giriş + `split` + zincirli overlay |
| `src/application/plan-album-repository.js` | **study klibi artık albüm arkaplanını EZMEZ** (aşağıya bak) |
| `src/ui/config-wizard.js` | study/break adımları tek seçim yerine `checklist` (çoklu seçim) olacak — altyapı müzik adımında zaten var |

### Önemli: study klibinin yeri değişiyor

Bugün study klibi `PlanAlbumRepository#withStudyClip` ile **albümün arkaplanının yerine**
konuyor, yani tüm çalıştırma boyunca taban video o oluyor. Çoklu klipte bu çalışmaz
(klip faza göre değişiyor). Yeni model:

- Taban katman = **albümün kendi arkaplanı** (ya da rotasyon listesi) — eski davranış.
- Study pencereleri = study klibi overlay.
- Break pencereleri = break klibi overlay.
- Her an bir faza ait olduğu için, havuzlar doluyken taban katman pratikte görünmez;
  havuz boşsa albüm arkaplanı görünür (makul geri düşüş).

`PlanAlbumRepository`'deki `studyClipProvider` yolu bu fazda KALDIRILIR; `StreamConfigService`
study kliplerini pomodoro planına besler. `plan-album-repository.test.js` buna göre güncellenir.

## Testler (en az)

- `seeded-shuffle`: aynı seed+index aynı sonucu verir; ardışık indeksler farklı eleman;
  tek elemanlı havuz; boş havuz; tur sınırında tekrar yok (çok turlu dizi).
- `stream-plan`: `studyVideo` (tek) → tek elemanlı liste; `studyVideos` tekrarları atar;
  `toJSON` liste biçimi yazar; geçersiz tipler hata listesine girer.
- `pomodoro-planner`: her pencereye klip atanıyor; ardışık study pencereleri farklı klip;
  restart simülasyonu (aynı seed + aynı nowMs → aynı atama); havuz boşsa overlay yok;
  `MAX_CLIPS_PER_RUN` aşımında düşürme deterministik.
- `ffmpeg-encoder`: 1/2/3 klipli durumlar için filtre metni; `split` yalnızca gerektiğinde;
  giriş sırası; klip yokken komut BUGÜNKÜYLE BİREBİR AYNI (regresyon kalkanı — mevcut
  "pomodoro kapalıyken komut aynı" testinin kardeşi).
- Uçtan uca: gerçek ffmpeg ile kısa bir render + farklı anlardan kare çıkarıp doğru klibin
  göründüğünü gözle doğrula (bkz. "Doğrulama yöntemi" aşağıda).

## Kabul kriterleri (Faz N3)
- Planda 3 study + 2 break klibi varken: ardışık çalışma sessionları farklı klip gösteriyor.
- ffmpeg bir session ortasında yeniden başlarsa **aynı klip** devam ediyor (ekran değişmiyor).
- Havuzda tek klip varsa bugünkü davranış birebir korunuyor.
- Klip seçilmemişse komut bugünküyle aynı (regresyon yok).
- 4 klipli çalıştırmada `hız(30sn)` ≥ 1.0 (VPS'te ölçülecek).

---

## Bu projede çalışma kuralları (yeni oturum için)

1. **Test disiplini:** her davranış değişikliği için test; testin ESKİ kodda düştüğünü
   doğrula (düzeltmeyi geçici geri alıp çalıştır). Test çerçevesi yok, `node --test`.
2. **Faz başına TEK commit** (ara adımlarda commit yok). Commit mesajı: ne değişti + NEDEN.
   Sonuna `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
3. **KARARLAR.md'ye faz girdisi**: Soru / Karar / Gerekçe / Etki + "Doğrulama" bölümü.
   Dosyanın sonundaki mevcut girdilerin biçimini birebir izle.
4. **Mimari testleri**: `test/application/*` içinde katman kuralını zorlayan testler var;
   application katmanına `fs`/`child_process`/`infrastructure` import etme.
5. **Yorumlar**: Türkçe, NEDEN'i ve elenen alternatifi anlatır. Projenin en değerli yanı bu.
6. **Bağımlılık ekleme.** (`ink` + `react` dışında runtime bağımlılığı yok.)
7. **Deploy:** GitHub'a push → VPS'te tek kelime `deploy`. Kullanıcının terminali uzun
   komutları satır ortasından kırıyor: **verdiğin komutlar kısa (tek satır, ~60 karakter)
   olsun**, çok satırlı heredoc yapıştırmaktan kaçın.
8. **Kullanıcı Türkçe konuşuyor**, cevaplar Türkçe.

## Kullanıcının cihazları (N2 için önemli)

**Telefon: Android. Tablet: iPad.** Yani:

- Çözüm **tarayıcı tabanlı** olmalı — iOS Shortcuts'a bağımlı bir şey yapma. (Kod
  yorumlarında ve README'de go-live için "iOS Shortcuts" geçiyor; o eski bir varsayım,
  `/config` sayfası onun yerini alacak ve her iki cihazda da çalışacak.)
- Sayfa **Android Chrome** ve **iPad Safari**'de test edilmeli. Pratik sonuçlar:
  - `<input type="checkbox">` ve `<button>` dokunma hedefleri en az 44 px.
  - Yatay kaydırma OLMAMALI (uzun dosya adlarını kırp: `text-overflow: ellipsis`).
  - Token URL'de taşınıyorsa sayfayı **ana ekrana kısayol** olarak eklemek mümkün olsun
    (Android Chrome "Ana ekrana ekle", iPad Safari "Ana Ekrana Ekle") — kullanıcı tek
    dokunuşla açsın, her seferinde token yazmasın. Bu, iOS Shortcuts'ın yerine geçen
    kullanım biçimi; README'ye yazılmalı.

## Açık karar

- Web formunda müzik/albüm seçimi v1'e girsin mi? (Öneri: **hayır** — telefonda 498 parça
  seçtirmek kullanışsız; "tüm kütüphane" varsayılanı korunur, albüm seçimi TUI'da kalır.)
- `/config` POST sonrası aynı sayfayı mı basmalı, 303 ile GET'e mi dönmeli?
  (Öneri: basit tut, aynı sayfayı `notice` ile bas.)

## Doğrulama yöntemi (bu projede işe yarayan)

Filtre/overlay işlerinde testler yetmez — kaçış kuralları ve katman sırası ancak gerçek
ffmpeg ile görülür. Bu oturumda kullanılan ve işe yarayan yöntem:

1. Geçici bir klasörde malzeme üret:
   `ffmpeg -f lavfi -i color=c=0x1b2a3a:s=1280x720:r=24:d=2 ...` (arkaplan),
   `ffmpeg -f lavfi -i sine=frequency=220:duration=60 ...` (ses), tek satırlık `playlist.txt`.
2. Gerçek `buildFfmpegArgs()` ile komutu kur (sahte veri değil, gerçek planner çıktısıyla).
3. `-re`'yi çıkarıp hızlı render al, `-ss <saniye>` ile farklı anlardan PNG kare çıkar.
4. Kareleri **gözle kontrol et** — yazı konumu, sayaç değeri, hangi klibin göründüğü.

N3 için: farklı fazlara denk gelen en az 3 kare çıkar ve pencere başına doğru klibin
göründüğünü doğrula.

## İlgili dosyalar (okuma sırası)

```
src/domain/stream-plan.js              plan şeması + doğrulama + summarizePlan
src/infrastructure/stream-plan-store.js plan diske yazma/okuma, preset'ler
src/application/stream-config-service.js  planı uygulayan tek köprü (apply/applyAndRestart)
src/ui/config-wizard.js                TUI sihirbazının akışı (adımlar, tuşlar)
src/ui/stream-tui.js                   panel + sihirbaz barındırma
src/infrastructure/golive-server.js    HTTP sunucusu (auth, hız sınırı, route'lar)
src/infrastructure/media-library.js    kapak/video tarama (TUI listelerinin kaynağı)
src/infrastructure/break-clip.js       study/break klibini yayın formatına çevirme
src/composition/go-live-wiring.js      composition root örneği
index.js                               ana composition root
```
