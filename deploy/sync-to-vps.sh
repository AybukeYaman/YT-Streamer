#!/usr/bin/env bash
# Proje dosyalarını VPS'e taşır (Git Bash'ten, proje kökünde çalıştır).
# Kullanım:  bash deploy/sync-to-vps.sh <kullanici>@<ip>
#
# Beyaz liste: sadece aşağıdaki SOURCES gider. Böylece .env, .git, .claude,
# node_modules, runtime/, experiments/, raw/, test/, PROMPTLAR/ ve *.md
# dosyaları listeye eklenmedikçe asla gitmez.
# --delete YOK: VPS'te fazladan dosya varsa silinmez (music/ için bilinçli).
set -euo pipefail

VPS="${1:?Kullanım: bash deploy/sync-to-vps.sh <kullanici>@<ip>}"
REMOTE_DIR="yt-stream-system"   # uzak kullanıcının home'una göre

cd "$(dirname "$0")/.."

SOURCES=(index.js package.json config.docker.json Dockerfile docker-compose.yml .dockerignore src music assets)

for s in "${SOURCES[@]}"; do
  [ -e "$s" ] || { echo "Eksik: $s (Adım 7.1 tamamlanmadı mı?)"; exit 1; }
done

if command -v rsync >/dev/null 2>&1; then
  # -rlt: Windows'tan izin/sahiplik taşıma, izinleri --chmod ile sabitle
  # --partial: kopan büyük dosya (müzik/video) kaldığı yerden devam eder
  # m4a/mp4 zaten sıkıştırılmış, -z kodu/metni sıkıştırır, medyayı otomatik atlar
  rsync -rltvz --partial --progress --chmod=D755,F644 \
    --exclude='.gitkeep' \
    "${SOURCES[@]}" "$VPS:$REMOTE_DIR/"
else
  # Yedek yol: yerelde rsync yok (Git Bash'te varsayılan olarak gelmiyor).
  # Her seferinde her şeyi baştan gönderir (artımlı değil) ama ek kurulum gerektirmez.
  echo "rsync bulunamadı, tar + ssh ile gönderiliyor..."
  tar -cf - --exclude='.gitkeep' "${SOURCES[@]}" \
    | ssh "$VPS" "mkdir -p $REMOTE_DIR && tar -xf - -C $REMOTE_DIR --no-same-owner"
fi

echo "--- VPS tarafı ---"
ssh "$VPS" "cd $REMOTE_DIR && ls -la && echo \"music: \$(ls music | wc -l) dosya\" && du -sh music assets src"
