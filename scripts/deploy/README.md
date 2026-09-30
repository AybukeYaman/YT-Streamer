# VPS kurulumu (systemd)

| Ne zaman | Komut |
|---|---|
| **İlk kurulum** (yeni VPS) | `sudo bash scripts/deploy/install-service.sh` |
| **Kod güncellemesi** (her deploy) | `bash deploy.sh` |
| **Yeni yayın ekleme** | `sudo bash scripts/deploy/add-stream.sh <isim>` |

## Kod güncellemesi — `deploy.sh`

```bash
bash deploy.sh --dry-run  # hiçbir şeyi DEĞİŞTİRMEZ — ne olacağını gösterir
bash deploy.sh            # git pull -> env doğrulama -> npm ci -> tüm yayınları restart
bash deploy.sh --test     # aynısı + testler (deploy öncesi)
```

### `--dry-run` — riskli olmayan ilk tur

**Tamamen salt okunur.** Çalışan yayına, çalışma ağacına ve `node_modules`'a dokunmaz;
yayın kesintisi riski yoktur, istediğin kadar çalıştırabilirsin. Gösterdikleri:

- `git fetch` yapar ama **merge etmez** — pull'un hangi commit'leri ve hangi dosyaları
  getireceğini listeler (asıl restart riski buradan gelir, script'ten değil)
- `--ff-only` pull'un mümkün olup olmadığını önceden söyler (VPS'te elle commit yapılmışsa)
- kirli çalışma ağacını bildirir
- `.env` ve her `.env.<isim>` doğrulamasını yapar; gerçek deploy'un **nerede duracağını** yazar
- `npm ci --omit=dev --dry-run` ile lock/package.json tutarlılığını sınar, tek bayt yazmadan
- hangi servislerin restart **edileceğini** listeler, restart etmez

Erken çıkmaz: tüm sorunları toplayıp özette listeler, böylece tek turda bütün tabloyu görürsün.
Engelleyici sorun varsa çıkış kodu non-zero. `--test` ile birlikte kullanılamaz (testler
devDependencies kurulumu gerektirir, bu da `node_modules`'ı değiştirir).

Sırayla:
1. `git pull --ff-only` — VPS'te elle değişiklik varsa sessiz merge yerine açık hata
2. **`.env` doğrulama** — `.env.example`'daki key'lerden eksik/boş varsa **deploy durur** ve
   hangi key olduğunu yazar (değerini değil)
3. `npm ci --omit=dev` — lock dosyasına birebir uyar
4. `yt-streamer.service` restart + 5 sn sonra gerçekten ayakta mı doğrulama; değilse son 20
   satır `journalctl`
5. **Her `.env.<isim>` için** `yt-streamer@<isim>` restart — bir instance'ın env'i eksikse
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

## Neden systemd (orphan sorunu)
Uygulama elle (`node index.js &`) çalıştırılıp terminal/ssh oturumu kapanınca ya da süreç `kill -9`/OOM ile ölünce, spawn ettiği ffmpeg **orphan** (PPID=1) kalabilir — bir CPU çekirdeğini boşa yer ve aynı YouTube stream key'e ikinci bir bağlantı denediği için canlı yayınla çakışır. systemd `KillSignal=SIGINT` ile uygulamaya graceful kapanış sinyali gönderir (bizim shutdown zinciri → `supervisor.stop()` → ffmpeg `q`) ve cgroup temizliği sayesinde orphan kalmaz. `enable` sayesinde VPS reboot olsa da yayın kendiliğinden döner.
