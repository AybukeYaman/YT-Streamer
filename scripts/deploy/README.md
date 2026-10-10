# VPS kurulumu (systemd)

| Ne zaman | Komut |
|---|---|
| **İlk kurulum** (yeni VPS) | `sudo bash scripts/deploy/install-service.sh` |
| **Kod güncellemesi** (her deploy) | `deploy` (nerede olursan ol) |
| **Yeni yayın ekleme** | `sudo bash scripts/deploy/add-stream.sh <isim>` |
| **Albüm/müzik taşıma** (yerelden) | `bash scripts/deploy/sync-albums.sh <kullanıcı@host> <uzak-yol>` |

## Kod güncellemesi — `deploy.sh`

```bash
deploy --dry-run  # hiçbir şeyi DEĞİŞTİRMEZ — ne olacağını gösterir
deploy            # git pull -> env doğrulama -> npm ci -> tüm yayınları restart
deploy --test     # aynısı + testler (deploy öncesi)
```

`deploy`, `install-service.sh`'ın kurduğu global sarmalayıcıdır (`/usr/local/bin/deploy`):
repo yolu kurulum anında gömülür, bu yüzden hangi dizinde olduğun fark etmez ve
`cd <repo> && bash deploy.sh` yazmak gerekmez. Argümanlar olduğu gibi aktarılır.
Sarmalayıcı yoksa (eski kurulum) `bash <repo>/deploy.sh` hâlâ çalışır.

### `--dry-run` — riskli olmayan ilk tur

**Tamamen salt okunur.** Çalışan yayına, çalışma ağacına ve `node_modules`'a dokunmaz;
yayın kesintisi riski yoktur, istediğin kadar çalıştırabilirsin. Gösterdikleri:

- `git fetch` yapar ama **merge etmez** — pull'un hangi commit'leri ve hangi dosyaları
  getireceğini listeler (asıl restart riski buradan gelir, script'ten değil)
- `--ff-only` pull'un mümkün olup olmadığını önceden söyler (VPS'te elle commit yapılmışsa)
- kirli çalışma ağacını bildirir
- `.env` ve her `.env.<isim>` doğrulamasını yapar; gerçek deploy'un **nerede duracağını** yazar
- `npm ci --omit=dev --dry-run` ile lock/package.json tutarlılığını sınar, tek bayt yazmadan
- `daemon-reload` gerekip gerekmediğini söyler ama **reload etmez**
- hangi servislerin restart **edileceğini** listeler, restart etmez

Erken çıkmaz: tüm sorunları toplayıp özette listeler, böylece tek turda bütün tabloyu görürsün.
Engelleyici sorun varsa çıkış kodu non-zero. `--test` ile birlikte kullanılamaz (testler
devDependencies kurulumu gerektirir, bu da `node_modules`'ı değiştirir).

Sırayla:
1. `git pull --ff-only` — VPS'te elle değişiklik varsa sessiz merge yerine açık hata
2. **`.env` doğrulama** — `.env.example`'daki key'lerden eksik/boş varsa **deploy durur** ve
   hangi key olduğunu yazar (değerini değil)
3. `npm ci --omit=dev` — lock dosyasına birebir uyar
4. Unit dosyası diskte değiştiyse **bir kez** `systemctl daemon-reload` (restart'tan önce)
5. `yt-streamer.service` restart + 5 sn sonra gerçekten ayakta mı doğrulama; değilse son 20
   satır `journalctl`
6. **Her `.env.<isim>` için** `yt-streamer@<isim>` restart — bir instance'ın env'i eksikse
   yalnızca **o** instance atlanır, diğerleri güncellenir; özet bölümü atlananı açıkça yazar

`sudo` gerektirmez — `git`/`npm` mevcut kullanıcı olarak çalışır (root ile `git pull`
"dubious ownership" verebilir), yalnızca `systemctl` çağrıları `sudo` ile yapılır.

### Env doğrulamasını tek başına çalıştırma
```bash
bash scripts/deploy/check-env.sh .env
bash scripts/deploy/check-env.sh .env.stream2
```
`.env.example` **sözleşmedir**: yeni bir key eklediğinde `.env.example`'a da ekle (boş değerle),
böylece diğer makinelerde deploy o key eksikken durur. Script key **isimlerini** raporlar,
değerleri asla yazdırmaz.

## İlk kurulum

```bash
sudo bash scripts/deploy/install-service.sh
```

Ne yapar:
- node sürümünü doğrular (>=20)
- `.env`'i `check-env.sh` ile doğrular; eksik/boşsa **uyarır ama kurulumu sürdürür** (ilk kurulumda key henüz elde olmayabilir — `.env` git'e dahil değil, elle oluşturulur). Kod güncellemesinde `deploy.sh` aynı kontrolü **hata** olarak uygular.
- `config.json` yoksa `config.example.json`'dan oluşturur (sonra `overlay.fontFile`'ı bu makineye göre düzenlemen gerekir — Linux font yolu)
- `npm install --omit=dev`
- elle çalışan eski bir `node index.js` varsa **graceful** durdurur (orphan ffmpeg bırakmadan)
- `/etc/systemd/system/yt-streamer.service` yazar ve etkinleştirir

**İdempotent** — tekrar çalıştırmak güvenli (var olan servisi günceller/yeniden başlatır).
Rutin kod güncellemesi için `install-service.sh` değil **`deploy.sh`** kullan: env doğrulaması
yapar ve ek yayınları da restart eder. `install-service.sh` yalnızca unit dosyası değiştiğinde
ya da yeni bir VPS kurarken gerekir.

### `daemon-reload` neden otomatik ve neden her deploy'da değil

systemd, unit dosyası diskte değişip de yüklenmediğinde restart'ı **engellemez** — uyarı basar
ve sessizce **eski** tanımla başlatır. Bu yüzden `deploy.sh` restart'tan **önce** kontrol eder.

Tespit `git diff` ile yapılamaz: **repoda unit dosyası yok.** `install-service.sh` ve
`add-stream.sh` unit'i çalışma anında heredoc ile `/etc/systemd/system/` altına üretir.
`deploy.sh` unit'e hiç dokunmadığı için hash karşılaştırması da hep "değişmedi" derdi — yani
kontrol sessizce hiç tetiklenmezdi.

Doğru kaynak systemd'nin kendisi:

```bash
systemctl show -p NeedDaemonReload --value yt-streamer.service   # yes / no
```

`yes` dönmedikçe `daemon-reload` çağrılmaz (körlemesine her deploy'da değil). Birden fazla
unit değişse de reload süreç genelinde olduğu için **bir kez** yapılır. Sorgu yetki
istemediğinden `--dry-run` bu kontrolü de parola sormadan yapar.

> `daemon-reload` yalnızca **yüklü tanımı** tazeler. VPS'teki unit dosyası repodaki
> üreticiden geri kaldıysa (örn. `install-service.sh` yeni bir alan eklemişse) bunu
> düzeltmez — o makinede bir kez `sudo bash scripts/deploy/install-service.sh` gerekir.

## Neden unit'te `EnvironmentFile` yok

Uygulama `.env`'i **kendisi** okur (`src/config/load-config.js`, `util.parseEnv`); yol
`__dirname` bazlı olduğu için `WorkingDirectory`'den bağımsız çalışır. Çoklu yayında aynı yol:
`ExecStart ... --env .env.%i`.

systemd'nin `EnvironmentFile` quoting/escape kuralları `util.parseEnv`'den farklıdır — ikisi
birlikte kullanılsa aynı dosya iki farklı şekilde yorumlanabilirdi (özellikle quote ve `#`
içeren değerlerde). Hiçbir fayda karşılığında sessiz tutarsızlık riski, bu yüzden eklenmedi.
Tek bir key'i geçici olarak ezmek gerekirse `Environment=` yeterli: gerçek ortam değişkeni
dosyadakini zaten ezer. Ayrıntı: `KARARLAR.md`, Faz 10.

Neden script (elle terminale yapıştırmak yerine): SSH konsollarında uzun heredoc/çok satırlı komutlar bracketed-paste ve satır kaydırma yüzünden bozuluyor. Script dosya olarak çalıştığı için bu sorun oluşmaz.

## Çoklu yayın (aynı kanalda birden fazla eşzamanlı yayın)

Her yayın **kendi süreci** olarak çalışır — biri çökse diğeri etkilenmez. Yayın eklemek:

```bash
sudo bash scripts/deploy/add-stream.sh stream2
```

Script şunları yapar:
- `config.stream2.json` oluşturur ve **`paths.runtime`'ı `./runtime/stream2`** yapar (kritik: `playlist.txt`/`state.json`/`overlay/` çakışmasın)
- `.env.stream2` dosyasını **boş key** ile oluşturur (izin 600) — mevcut key'i asla kopyalamaz
- `yt-streamer@.service` systemd template unit'ini kurar
- Key boşsa **başlatmaz** (crash-loop olmasın), ne yapacağını söyler; key'i doldurup script'i tekrar çalıştırınca başlatır

### Her yayın için ayrı YouTube stream key ZORUNLU
YouTube bir stream key'e **aynı anda tek** bağlantı kabul eder. İkinci yayın için YouTube Studio'da **yeni bir yayın/stream** oluşturup onun key'ini `.env.stream2`'ye yaz. Aynı key'i iki yerde kullanırsan ikinci bağlantı reddedilir (`Error opening output ... I/O error`).

### Farklı müzik istiyorsan
`config.stream2.json` içindeki `paths.albums` değerini başka bir klasöre çevir. Aynı bırakırsan iki yayın aynı albüm havuzunu kullanır (kuyruk sıraları bağımsız olur).

### Kapasite
720p24 yayın başına yaklaşık **1.1 CPU çekirdeği** gerekir (ölçüldü: E5-2699v4). Güvenli tavan ≈ `(çekirdek × 0.8) / 1.1`. Örnek: **3 çekirdek → 2 yayın**. Zorlarsan ffmpeg realtime'a yetişemez ve kare atlar. Daha fazlası için: paket yükselt, ya da config'te `preset`/çözünürlük/fps düşür.

### Yayınları yönetme
```bash
systemctl list-units 'yt-streamer*'           # tüm yayınlar
systemctl status yt-streamer@stream2 -l --no-pager
journalctl -u yt-streamer@stream2 -f
systemctl restart yt-streamer@stream2
systemctl disable --now yt-streamer@stream2   # yayını kaldır
```

### Bir yayını bilerek kapatma (park etme)

`systemctl disable --now` **yetmez**: `add-stream.sh`'ın tekrar çalıştırılması (ör. config
güncellemek için) `enable --now` ile yayını geri açar — 1 Ekim'de olan tam buydu. Niyeti
**repoda kaydetmek** gerekiyor:

```bash
sudo systemctl disable --now yt-streamer@stream2
touch .env.stream2.disabled                  # PARK İŞARETİ
```

İşaret dosyası varken:

| Komut | Davranış |
|---|---|
| `bash deploy.sh` | Instance'a **dokunmaz**, özette "BİLEREK PARK EDİLMİŞ" diye raporlar |
| `add-stream.sh stream2` | Yapılandırmayı günceller ama **başlatmaz**; `--force` ister |
| `yt-golive` sağlık izlemesi | O instance için **duraklar** (alarm/bildirim göndermez) |

Geri açmak:
```bash
rm .env.stream2.disabled
sudo bash scripts/deploy/add-stream.sh stream2
```

İşaret dosyası makineye özel; `.gitignore` zaten `.env.*` kalıbını kapsıyor, git'e girmez.
Ana yayın için aynı sözleşme: `.env.disabled`.

**Neden `is-enabled` yerine `UnitFileState` beyaz listesi:** `systemctl is-enabled --quiet`
çıkış kodu `static`, `indirect`, `generated` ve `transient` durumlarında da **0** döner.
Unit bunlardan birine düşerse eski kod onu "enable edilmiş" sayıp restart ediyordu. Artık
yalnızca `enabled` ve `enabled-runtime` restart edilir; tanımadığımız durumda **dokunulmaz**
(karar: `scripts/deploy/lib/instance-state.sh`, testleri `test/scripts/instance-state.test.js`).

> İlk (ana) yayın `yt-streamer.service` olarak `config.json` + `.env` ile çalışmaya devam eder; ek yayınlar `yt-streamer@<isim>` template'ini kullanır.

### Çift-instance koruması
Uygulama başlarken runtime klasörüne bir kilit (`instance.lock`) koyar. Yanlışlıkla iki instance'ı aynı `paths.runtime` ile başlatırsan ikincisi **açık bir hatayla reddedilir** (sessiz dosya bozulması yerine). Süreç `kill -9` ile ölmüşse kalan bayat kilit otomatik devralınır.

## Günlük komutlar
```bash
systemctl status yt-streamer --no-pager -l
journalctl -u yt-streamer -f              # canlı log
systemctl restart yt-streamer             # graceful restart (orphan bırakmaz)
systemctl stop yt-streamer
```

## Key maskeleme — hangi komut neyi sızdırır

ffmpeg yayın URL'sini (içinde stream key) **komut satırında** almak zorunda; ffmpeg'in
bunu dosyadan okuma yolu yok. Dolayısıyla `ps aux`, `systemctl status`, `journalctl` ve
`/proc/<pid>/cmdline` key'i **daima** gösterir. Maskeleme bu sızmayı kapatmaz — çıktıyı
korur, yani ekran görüntüsü / kopyala-yapıştır / log paylaşımı yoluyla sızmayı önler.
Pratikte gerçek kanal budur (1 Ekim: iki key terminal çıktısında göründü ve rotasyon
gerekti).

Tek kural, tek kaynak: **`scripts/deploy/lib/mask.sh`**. İki katman — kalıp bazlı
(`live2/<key>`, `YOUTUBE_*KEY|TOKEN|SECRET=`, ki rotasyondan önceki key'ler de yakalanır)
ve değer bazlı (`.env*` dosyalarında yazılı key/token/webhook sırları birebir).

| Komut | Durum |
|---|---|
| `bash scripts/deploy/status.sh` | **Maskeli** — paylaşılabilir, inceleme için bunu kullan |
| `deploy.sh` (restart başarısızlığında `journalctl`) | **Maskeli** |
| `add-stream.sh`, `install-service.sh`, `install-golive-service.sh` (`systemctl status`) | **Maskeli** |
| `sweep-orphan-ffmpeg.sh` | ffmpeg argümanlarını hiç basmaz (yalnızca pid/ppid/etime) |
| `check-env.sh` | Yalnızca key **adlarını** basar, değerlerini asla |
| `scripts/bench-preset.sh` | Yayın hedefini argümanlardan ayıklar, diske maskeli döküm yazar |
| `journalctl -u … -f`, `ps aux`, `systemctl status` (**elle**) | **MASKESİZ** — paylaşma |

Maskeleme **fail-closed**: maske çalışmazsa (ör. `sed -E -f` desteği yok) o çıktı hiç
basılmaz. Maskesiz basmak, hiç basmamaktan kötüdür.

Elle bir komut çalıştırman gerekiyorsa süzgeci tek başına kullanabilirsin:
```bash
journalctl -u yt-streamer -n 200 | bash scripts/deploy/status.sh --filter
```

## Neden systemd (orphan sorunu)
Uygulama elle (`node index.js &`) çalıştırılıp terminal/ssh oturumu kapanınca ya da süreç `kill -9`/OOM ile ölünce, spawn ettiği ffmpeg **orphan** (PPID=1) kalabilir — bir CPU çekirdeğini boşa yer ve aynı YouTube stream key'e ikinci bir bağlantı denediği için canlı yayınla çakışır. systemd `KillSignal=SIGINT` ile uygulamaya graceful kapanış sinyali gönderir (bizim shutdown zinciri → `supervisor.stop()` → ffmpeg `q`) ve cgroup temizliği sayesinde orphan kalmaz. `enable` sayesinde VPS reboot olsa da yayın kendiliğinden döner.

Graceful kapanış **her zaman** işlemez: ffmpeg kesilemez bir I/O'da takılırsa `TimeoutStopSec=30` dolar, systemd node'u SIGKILL eder ve ffmpeg yetim kalır. Bu yüzden unit'te ayrıca `ExecStartPre=-/bin/bash .../sweep-orphan-ffmpeg.sh` var: **her** başlatmada (`systemctl restart` dahil, yalnızca `deploy.sh`'te değil) yetim taraması yapılır. Sweep meşru ffmpeg'e (ebeveyni bu repodan çalışan canlı bir `node`) dokunmaz, yani diğer instance'ların ve elle başlatılmış yayınların ffmpeg'i güvende. `-` öneki: tarama başarısız olsa bile yayın başlar.

Unit'te `StartLimitIntervalSec=0` da var: yeniden başlatma bilerek **sınırsız**. Sürekli çöken bir yayında alarm uygulama içinden gelir (`supervisor` → tekrarlayan çökme bildirimi); unit'i `failed`'a düşürüp yayını kapatmak istenen davranış değil.

---

## go-live: YouTube yayınını otomatik canlıya alma (Faz 9 Aşama 2)

ffmpeg zaten RTMPS'e basıyor; bu adım YouTube tarafında broadcast oluşturup stream'e
bağlıyor ve **canlıya** alıyor. Yayın sürecinden (`yt-streamer`) **ayrı** bir servis:
`index.js` YouTube API'yi hiç tanımaz, çünkü broadcast oluşturma yayın başlangıcına
girerse `Restart=always` + supervisor retry'ları her restart'ta yeni broadcast yaratır
(kanalda çöp yayınlar, kota tükenmesi).

### Kurulum

```bash
# 1) Kimlik + auth token (.env.youtube)
cp .env.youtube.example .env.youtube && chmod 600 .env.youtube
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # GOLIVE_AUTH_TOKEN
node scripts/youtube/get-refresh-token.js    # tarayıcısı olan makinede çalıştır
node scripts/youtube/verify-access.js        # stream id eşleşmesini doğrula

# 2) Servisi kur (yalnızca 127.0.0.1'e bind eder)
sudo bash scripts/deploy/install-golive-service.sh
```

### Terminalden kullanım

```bash
node scripts/youtube/go-live.js                    # canlıya al (idempotent)
node scripts/youtube/go-live.js --status           # durum (API'ye gitmez)
node scripts/youtube/go-live.js --status --refresh # durumu API'den taze al

# HTTP üzerinden (servis çalışıyorken)
TOKEN=$(grep GOLIVE_AUTH_TOKEN .env.youtube | cut -d= -f2)
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/go-live
curl -fsS       -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/status
curl -fsS http://127.0.0.1:8787/healthz            # auth'suz
```

**Ön koşul:** ffmpeg gerçekten yayın yapıyor olmalı. `transition`, ingest `active`
değilken çalışmaz — bu komut yayını **başlatmaz**, canlıya **alır**. ffmpeg basmıyorsa
komut broadcast **oluşturmadan** hata verir (kanalda çöp yayın bırakmaz).

**İdempotans:** aktif broadcast varsa yeni broadcast **açılmaz** (`already-live` döner).
Yarım kalmış bir broadcast varsa (oluşturulmuş ama canlıya alınamamış) o **yeniden
kullanılır**. Eşzamanlı ikinci istek `409` alır.

### HTTP yanıt kodları — `POST /go-live` hemen döner

ingest `active` olana kadar beklemek 120 sn'ye kadar sürebiliyor; iOS Shortcuts'ın HTTP
timeout'u bundan kısa olduğu için istek zaman aşımına uğruyordu (oysa iş arka planda
doğru çalışıyordu). Artık **uzun kısım arka planda sürüyor** ve istek hemen yanıtlanıyor:

| Kod | `action` / `error` | Anlamı |
|---|---|---|
| **202** | `accepted` | İş başladı, arka planda sürüyor. Sonuç: `/status` → `lastRun` |
| **200** | `already-live` | Zaten sağlıklı şekilde akıyor, yapılacak bir şey yok |
| **409** | `encoder_not_streaming` | ffmpeg basmıyor (kalp atışı durmuş) — ingest beklemek boşuna, önce `systemctl restart yt-streamer` |
| **409** | `stale_broadcast` | Broadcast canlı görünüyor ama ingest ölü — Studio'dan sonlandır + encoder'ı yeniden başlat |
| **409** | `busy` | Başka bir go-live sürüyor (çift dokunma) |
| **502** | diğer | Beklenmeyen hata |

Senkron reddedilenler yalnızca **kesin** bilinenlerdir. Tek bir ingest örneğine bakıp
"stale" demek yanlış olurdu: albüm geçişinde ffmpeg yeniden bağlanırken ingest kısa süre
`inactive` görünür. O yüzden belirsiz durumda 202 dönülür ve grace penceresi arka planda
beklenir.

**Arka planda bitenin sonucu iki yerden öğrenilir:**
```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:8787/status | jq '.lastRun, .health'
```
```json
{ "phase": "done", "startedAt": "...", "finishedAt": "...", "action": "went-live" }
```
`phase`: `running` | `done` | `failed`. **Başarısızlıkta ntfy bildirimi de gider** —
202'den sonra hatayı gören kimse olmayabilir, bu yüzden bildirim kanalı (yukarıdaki
sağlık izleme bölümü) bu akışın ön koşuludur.

**Shortcuts tarafı:** kestirme artık beklemeden dönüyor. Sonucu görmek istersen 30-60 sn
sonra `/status` çağıran ikinci bir adım ekle ve `lastRun.phase`'e bak; hata olursa
telefona bildirim zaten gelir.

**CLI değişmedi:** `node scripts/youtube/go-live.js` hâlâ **senkron** çalışır ve sonucu
bekler — terminalde timeout sorunu yok, sonucu görmek doğru davranıştır.

### iOS'tan tetikleme (Tailscale)

Servis internete **açılmaz**; erişim tailnet üzerinden olur.

```bash
# VPS'te (bir kerelik)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg https / http://127.0.0.1:8787
sudo tailscale serve status        # verilen https adresini gösterir
```

`tailscale serve`, tailnet içinde **geçerli sertifikayla HTTPS** verir ve arkada
loopback'e proxy'ler. Adres şöyle olur:
`https://<makine>.<tailnet-adi>.ts.net/go-live`

iPhone'a Tailscale uygulamasını kurup aynı hesapla giriş yap, sonra:

**iOS Shortcuts (önerilen):** "Get Contents of URL" →
- URL: `https://<makine>.<tailnet>.ts.net/go-live`
- Method: `POST`
- Headers: `Authorization: Bearer <GOLIVE_AUTH_TOKEN>`

**Safari (hızlı yol):** `https://<makine>.<tailnet>.ts.net/go-live?token=<TOKEN>`
Tarayıcı `GET` gönderdiği için bu yol `405` döner — Safari'yi kullanacaksan Shortcuts
ile `POST` at. URL'deki token tarayıcı geçmişine ve sunucu loglarına düşebileceği için
**Shortcuts + header tercih edilmeli**; URL parametresi yalnızca acil durum içindir.

> Düz HTTP üzerinden bearer token göndermek onu sızdırır. Canlı yayın başlatabilen bir
> endpoint için kabul edilemez, bu yüzden TLS'siz dışa açma **yapılmaz**.

## Yayın yapılandırması: telefondan, SSH'sız (`/config`)

Çalışma/mola görselini veya Pomodoro süresini değiştirmek için eskiden SSH'tan elle
JSON yazmak gerekiyordu. Artık `yt-golive` servisinin verdiği `/config` sayfası aynı
tailnet adresinden açılır — **SSH gerekmez**, `/go-live` ile aynı token kullanılır:

```
https://<makine>.<tailnet-adi>.ts.net/config?token=<GOLIVE_AUTH_TOKEN>
```

Açılan sayfada Pomodoro aç/kapa, süre (`50+10`, `30+10` ya da serbest `<çalışma>+<mola>`)
ve çalışma/mola görselleri (ÇOKLU seçim — her session havuzdan rastgele bir klip kullanır,
ardışık iki session aynı klibi tekrarlamaz) değiştirilip **Kaydet** ya da **Kaydet ve
Yeniden Başlat** ile uygulanır. Müzik/albüm seçimi bu sayfada YOK — "tüm kütüphane"
varsayılanı korunur; albüm seçimi için VPS'te `npm run plan` (bkz. ana README).

**Ana ekrana kısayol (önerilir, tek dokunuşla açılsın, token her seferinde yazılmasın):**
- **Android Chrome:** sayfayı aç → ⋮ menü → "Ana ekrana ekle"
- **iPad Safari:** sayfayı aç → Paylaş → "Ana Ekrana Ekle"

Bu, go-live tetiği için önerilen iOS Shortcuts kullanımının yerini TUTMAZ — `/go-live`
hâlâ Shortcuts'tan tetiklenir, `/config` yalnızca yapılandırma ekranıdır.

## Yayın ölürse haber alma (sağlık izleme)

`yt-golive` servisi, yayın yapmanın yanında **60 saniyede bir iki şeyi yokluyor**:

| Kontrol | Ne sorar | Nasıl ölçer |
|---|---|---|
| `ingest` | Broadcast canlı görünüyor ama veri akıyor mu? | YouTube `liveStreams.list` (1 kota birimi) |
| `encoder` | `yt-streamer` hâlâ yayın yapıyor mu? | `runtime/state.json` mtime (yayın her 5 sn yazar) |

**3 ardışık sağlıksız örnekte (~3 dk)** log'a `error` düşer ve bildirim gönderilir;
sorun sürerken bildirim tekrarlanmaz, düzelince "düzeldi" bildirimi gelir. Kontrolün
kendi hatası (ağ/kota) sağlıksızlık sayılmaz — sayaç artmaz.

`encoder` kontrolü şunların hepsini yakalar: servisin durdurulması (`systemctl stop`),
disable edilmesi, çökmesi/crash-loop'a girmesi, node ayakta ama ffmpeg'in ölmesi.
systemd'nin `OnFailure=`'ı bunları yakalamaz — elle durdurma bir "failure" değildir.

### Kurulum (ikisi de opsiyonel, `.env.youtube`)

**1) Telefona bildirim — ntfy.sh** (hesap gerekmez):
```bash
# Tahmin edilemez bir konu adı üret
node -e "console.log('yt-'+require('crypto').randomBytes(9).toString('base64url'))"
# .env.youtube içine yaz:
#   ALERT_WEBHOOK_URL=https://ntfy.sh/yt-<uretilen>
```
Telefona **ntfy** uygulamasını kur ve aynı konu adına abone ol. Konu adı bir **sırdır**:
bilen herkes dinleyebilir ve bildirim yayınlayabilir, bu yüzden `.env.youtube` (chmod 600)
dışına çıkmamalı. Loglara URL'nin tamamı yazılmaz, yalnızca host.

**2) Ölü adam anahtarı — healthchecks.io:** sağlıklı her turda ping atılır; **ping
susarsa** dış servis sana e-posta/bildirim gönderir. `yt-golive` süreci çökerse ya da
VPS tamamen giderse alarm verecek **tek** mekanizma budur — yerel izleyici kendi ölümünü
bildiremez.
```
healthchecks.io → yeni check → Period: 5 dakika, Grace: 5 dakika
→ ping URL'sini .env.youtube içine:  HEARTBEAT_PING_URL=https://hc-ping.com/<uuid>
```
Yayını **bilerek** kapatırsan (`systemctl stop yt-streamer`) `encoder` kontrolü
`state.json` dosyası durduğu için alarm verir. Uzun süre kapalı tutacaksan ya durum
dosyasını taşı ya da healthchecks check'ini duraklat — yoksa her 3 dakikada bildirim alırsın.

İkisi de boşsa izleme çalışır ama yalnızca log'a yazar; açılışta bunu uyaran bir satır
basılır (`ALERT_WEBHOOK_URL boş — … telefona bildirim GİTMEYECEK`).

### Durumu görmek

```bash
curl -s -H "Authorization: Bearer $GOLIVE_AUTH_TOKEN" localhost:8787/status | jq .health
```
`health` alanı izlemenin son turundan okunur, **YouTube API'ye gitmez** (kota harcamaz).

## Albüm taşıma — `sync-albums.sh`

Diğer deploy script'lerinin tersine **yerelde** çalışır, VPS'te değil. `deploy.sh` yalnızca
kodu güncelliyor; `music-source/` git'e girmediği için (`.gitignore`) albümler ayrı taşınır.

```bash
bash scripts/deploy/sync-albums.sh root@<ip> /root/yt-stream-system --dry-run
bash scripts/deploy/sync-albums.sh root@<ip> /root/yt-stream-system
bash scripts/deploy/sync-albums.sh root@<ip> /root/yt-stream-system --album mimi
```

- **Atomik:** aktarım uzaktaki `music-source/.staging/<albüm>/` içine yapılır, ancak
  tamamlandığında tek `mv` ile yerine konur. Yarım aktarılmış bir albüm `background.mp4`
  + `music/` kontrolünü geçip **eksik parçalarla yayına girerdi** — script'in asıl
  varlık sebebi bu. Nokta ile başlayan klasörleri `AlbumRepository` taramıyor.
- **Değişmeyeni atlar:** karşılaştırma "dosya sayısı + toplam bayt". Şüphede `--album`
  ile zorla gönder.
- **Silmez:** yerelde olmayan uzak albümler yalnızca raporlanır; silmek için `--delete`.
- **rsync gerektirmez** (Windows'ta Git Bash ile gelmiyor) — `tar | ssh tar`. m4a zaten
  sıkıştırılmış olduğu için gzip kullanılmaz.

Albümler yayın sürecine **albüm geçişinde** girer (`AlbumRepository` her playlist'te
diski yeniden tarar); hemen görmek için `sudo systemctl restart yt-streamer`.

## Tek komutla yayınlama — `npm run albums:publish`

Günlük akış bu: ham video/görseli kaynak klasöre at, tek komut.

```bash
npm run albums:publish                 # dönüştür + VPS'e taşı
npm run albums:publish -- --dry-run    # hiçbir şey değiştirme, ne olacağını yaz
npm run albums:publish -- --no-sync    # sadece dönüştür, VPS'e dokunma
```

İki adımı birleştirir: `add-backgrounds.js` (her eşleme için) ve `sync-albums.sh`.
Dönüştürme başarısız olursa VPS'e **hiçbir şey gönderilmez**.

Hedef ve eşlemeler `scripts/publish.json`'da; makineye özel, git'e girmez.
Şablon: `scripts/publish.example.json`.

```json
{
  "host": "root@1.2.3.4",
  "path": "/root/YT-Streamer",
  "albums": { "mimi": "../mimi-loops" }
}
```

Neden `.env` değil: `check-env.sh`, `.env.example`'daki her anahtarı zorunlu sayıyor ve
eksikse deploy'u durduruyor. VPS'in `.env`'inde bu anahtarlar olmayacağı için oraya koymak
deploy'u kırardı.

> Arkaplan klasörü her seferinde **baştan** yazılır (eklenmez): kaynak klasörde ne varsa
> albümün arkaplanı odur. Yeni bir klip eklerken eskileri de klasörde tut.
