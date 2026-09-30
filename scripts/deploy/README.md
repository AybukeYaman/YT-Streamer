# VPS kurulumu (systemd)

Her VPS'te (yeni ya da mevcut) **tek komut**:

```bash
git pull
sudo bash scripts/deploy/install-service.sh
```

Ne yapar:
- node sürümünü doğrular (>=20)
- `.env` yoksa uyarır (rtmp modunda `YOUTUBE_STREAM_KEY` zorunlu — bu dosya git'e dahil değil, elle oluşturulmalı)
- `config.json` yoksa `config.example.json`'dan oluşturur (sonra `overlay.fontFile`'ı bu makineye göre düzenlemen gerekir — Linux font yolu)
- `npm install --omit=dev`
- elle çalışan eski bir `node index.js` varsa **graceful** durdurur (orphan ffmpeg bırakmadan)
- `/etc/systemd/system/yt-streamer.service` yazar ve etkinleştirir

**İdempotent** — tekrar çalıştırmak güvenli (kod güncellemesi sonrası da kullanılır: `git pull && sudo bash scripts/deploy/install-service.sh` servisi restart eder).

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
