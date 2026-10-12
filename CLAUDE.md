# YT Stream System — Claude için proje notları

## ÖNEMLİ: Kod akışı (main her zaman gerçek kaynak)

- Kod değişikliği **yalnızca lokal depoda** yapılır. VPS'te (`root@37.140.242.65`, `/root/YT-Streamer`) kod elle düzenlenmez.
- **VPS `deploy`'u `main`'den alır** (git pull + npm ci + servis restart). Bu yüzden tüm süreç `main`'de tutulur:
  değişiklik main'e girmeden VPS'e verilmez; VPS dal (branch) üzerinde bırakılmaz, iş bitince `main`'e dönülür.
- Kod değişince sıra: lokalde değiştir → `npm test` → main'e al → VPS'te `git pull` (yalnızca arayüz/yeni sunucu kodu ise
  `systemctl restart yt-golive`; yayın kodu ise `deploy`).
- `deploy` tüm servisleri (canlı yayın dahil) yeniden başlatır ve canlı yayını kısa süre keser. Yalnızca arayüz değişikliğinde
  `deploy` yerine `git pull` + `systemctl restart yt-golive` yeterli (yayına dokunmaz).
- VPS yazma işlemleri (config, restart, deploy, go-live) kanalın canlı yayınına dokunur; ssh yetkisi `/permissions` ile kullanıcıdan gelir.

## Çalışma kuralları

- Kullanıcı Türkçe konuşur; yanıtlar kısa, sade, Türkçe.
- Faz başına tek commit (ara adımlarda commit yok). Commit sonuna `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` eklenir.
- Testler: `npm test`. Yeni bağımlılık ekleme.
- Güvenli silme: `rm`'de değişken/brace yok, tam yollarla tek tek.
- Ters bölü / ters tırnak içeren dosyaları heredoc ile değil Write/Edit ile yaz.
- Yayın anahtarı (stream key) çıktıda görünebilir (`ps`): çıktıları `cut -c1-250` ile kes, sohbete yapıştırma.

Ayrıntı: `DEVIR-TESLIM-faz-5.md`, `DEVIR-TESLIM-faz-5-4.md`, `faz-5-saf-mod-plan.md`, `KARARLAR.md`.
