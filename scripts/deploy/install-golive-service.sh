#!/usr/bin/env bash
# go-live HTTP servisini systemd servisi yapar (yt-golive.service).
#
#   sudo bash scripts/deploy/install-golive-service.sh
#
# Yayın servisinden (yt-streamer) AYRI süreç: index.js YouTube API'yi hiç tanımaz, çünkü
# broadcast oluşturma yayın başlangıcına girerse Restart=always + supervisor retry'ları
# her restart'ta yeni broadcast yaratır (çöp yayınlar + kota tükenmesi). Ayrıntı: KARARLAR.md
#
# Sadece 127.0.0.1'e bind eder. iOS'tan erişim `tailscale serve` ile sağlanır (bkz.
# scripts/deploy/README.md) — internete hiçbir port açılmaz.
#
# Idempotent: tekrar çalıştırmak güvenli. Bu script hiçbir sırrı okumaz/yazdırmaz.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVICE_NAME="yt-golive"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CREDENTIALS="$REPO_ROOT/.env.youtube"

echo "== YT go-live servisi — systemd kurulum =="
echo "repo: $REPO_ROOT"

if [ "$(id -u)" -ne 0 ]; then
  echo "HATA: root gerekli (sudo bash scripts/deploy/install-golive-service.sh)" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then echo "HATA: 'node' PATH'te bulunamadı." >&2; exit 1; fi
echo "node: $NODE_BIN ($("$NODE_BIN" -v))"

# ── Ön kontroller: eksik kimlik/token ile servis sonsuz crash-loop'a girer ───
if [ ! -f "$CREDENTIALS" ]; then
  echo "HATA: $CREDENTIALS yok." >&2
  echo "      Oluştur:  cp .env.youtube.example .env.youtube && chmod 600 .env.youtube" >&2
  exit 1
fi

# Yalnızca VARLIK kontrolü — değerler asla yazdırılmaz.
missing=""
for key in YOUTUBE_CLIENT_ID YOUTUBE_CLIENT_SECRET YOUTUBE_REFRESH_TOKEN GOLIVE_AUTH_TOKEN; do
  grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}=.+" "$CREDENTIALS" || missing="$missing $key"
done
if [ -n "$missing" ]; then
  echo "HATA: .env.youtube içinde boş/eksik key(ler):$missing" >&2
  echo "      Refresh token:  node scripts/youtube/get-refresh-token.js" >&2
  echo "      Auth token   :  node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"" >&2
  exit 1
fi

# İzinler: kimlik dosyası yalnızca sahibine okunabilir olmalı.
current_mode="$(stat -c '%a' "$CREDENTIALS" 2>/dev/null || echo '?')"
if [ "$current_mode" != "600" ]; then
  chmod 600 "$CREDENTIALS"
  echo ".env.youtube izni $current_mode → 600 olarak düzeltildi."
fi

echo "== npm install --omit=dev =="
(cd "$REPO_ROOT" && npm install --omit=dev)

echo "== $UNIT_FILE yazılıyor =="
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=YT go-live - YouTube broadcast otomasyonu (HTTP tetikleyici)
After=network-online.target
Wants=network-online.target

# NOT: Unit'te bilerek EnvironmentFile YOK. Uygulama .env.youtube'u kendisi okur
# (src/infrastructure/youtube-credentials.js, util.parseEnv). systemd'nin
# EnvironmentFile quoting kuralları util.parseEnv'den farklı olduğundan iki okuma
# yolu sessiz tutarsızlık riski getirir. Ayrıntı: KARARLAR.md
[Service]
Type=simple
WorkingDirectory=$REPO_ROOT
ExecStart=$NODE_BIN $REPO_ROOT/scripts/golive-server.js
Restart=always
RestartSec=10
# Yayın servisiyle aynı ders: SIGINT temiz kapanışı tetikliyor (SIGTERM de ele alınıyor).
KillSignal=SIGINT
TimeoutStopSec=15
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
  systemctl restart "$SERVICE_NAME"
else
  systemctl enable --now "$SERVICE_NAME"
fi

sleep 3
echo ""
echo "== durum =="
systemctl status "$SERVICE_NAME" --no-pager -l || true

echo ""
echo "== yerel sağlık kontrolü =="
PORT="$(grep -E '^[[:space:]]*(export[[:space:]]+)?GOLIVE_PORT=' "$CREDENTIALS" 2>/dev/null | tail -n1 | sed -E 's/.*=//' | tr -d '"'\''[:space:]')"
PORT="${PORT:-8787}"
curl -fsS "http://127.0.0.1:${PORT}/healthz" && echo "" || echo "(healthz yanıt vermedi — journalctl -u ${SERVICE_NAME} -n 30)"

echo ""
echo "Kurulum tamam. Loglar: journalctl -u ${SERVICE_NAME} -f"
echo "iOS'tan erişim için Tailscale adımları: scripts/deploy/README.md"
