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

## Günlük komutlar
```bash
systemctl status yt-streamer --no-pager -l
journalctl -u yt-streamer -f              # canlı log
systemctl restart yt-streamer             # graceful restart (orphan bırakmaz)
systemctl stop yt-streamer
```

## Neden systemd (orphan sorunu)
Uygulama elle (`node index.js &`) çalıştırılıp terminal/ssh oturumu kapanınca ya da süreç `kill -9`/OOM ile ölünce, spawn ettiği ffmpeg **orphan** (PPID=1) kalabilir — bir CPU çekirdeğini boşa yer ve aynı YouTube stream key'e ikinci bir bağlantı denediği için canlı yayınla çakışır. systemd `KillSignal=SIGINT` ile uygulamaya graceful kapanış sinyali gönderir (bizim shutdown zinciri → `supervisor.stop()` → ffmpeg `q`) ve cgroup temizliği sayesinde orphan kalmaz. `enable` sayesinde VPS reboot olsa da yayın kendiliğinden döner.
