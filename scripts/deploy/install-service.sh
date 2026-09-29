#!/usr/bin/env bash
# VPS'te tek seferlik kurulum: uygulamayı systemd servisi yapar.
#
# Neden var: elle terminale uzun heredoc/printf yapıştırmak SSH konsollarında
# (bracketed-paste, satır kaydırma) sık sık bozuluyor. Bu script dosya olarak
# çalıştığı için o sorun oluşmaz — git pull sonrası HER VPS'te tek komutla kurulum:
#
#   sudo bash scripts/deploy/install-service.sh
#
# Idempotent: tekrar çalıştırmak güvenli (var olan servisi günceller/yeniden başlatır).
# Bu script hiçbir sırrı (.env, stream key) okumaz/loglamaz/yazdırmaz.
set -euo pipefail

# ── Kök dizin: script'in bulunduğu repo'nun kökü ────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVICE_NAME="yt-streamer"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "== YT Streamer — systemd kurulum =="
echo "repo: $REPO_ROOT"

# ── Ön kontroller ────────────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  echo "HATA: root gerekli (sudo bash scripts/deploy/install-service.sh)" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "HATA: 'node' PATH'te bulunamadı." >&2
  exit 1
fi
NODE_VERSION_OK="$("$NODE_BIN" -e "process.exit(process.versions.node.split('.').map(Number)[0]>=20?0:1)" && echo yes || echo no)"
if [ "$NODE_VERSION_OK" != "yes" ]; then
  echo "HATA: node >=20.12 gerekli, mevcut: $("$NODE_BIN" -v)" >&2
  exit 1
fi
echo "node: $NODE_BIN ($("$NODE_BIN" -v))"

if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "UYARI: $REPO_ROOT/.env yok. rtmp modunda YOUTUBE_STREAM_KEY zorunlu." >&2
  echo "        Devam ediliyor ama uygulama config hatasıyla düşebilir." >&2
fi

if [ ! -f "$REPO_ROOT/config.json" ]; then
  if [ -f "$REPO_ROOT/config.example.json" ]; then
    cp "$REPO_ROOT/config.example.json" "$REPO_ROOT/config.json"
    echo "config.json yoktu — config.example.json'dan oluşturuldu."
    echo "ÖNEMLİ: $REPO_ROOT/config.json içindeki overlay.fontFile'ı bu makineye göre düzenle (Linux font yolu)."
  else
    echo "HATA: config.json ve config.example.json ikisi de yok." >&2
    exit 1
  fi
fi

# ── Bağımlılıklar (yalnızca prod; ink-testing-library sadece testler için) ──
echo "== npm install --omit=dev =="
(cd "$REPO_ROOT" && npm install --omit=dev)

# ── Elle çalışan eski bir instance varsa graceful durdur (orphan bırakmadan) ─
if pgrep -f "node .*${REPO_ROOT}/index.js" >/dev/null 2>&1 && ! systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  echo "== elle çalışan eski instance graceful durduruluyor =="
  pkill -INT -f "node .*${REPO_ROOT}/index.js" || true
  sleep 6
fi

# ── systemd unit dosyası (dosya içinde heredoc güvenli — interaktif paste değil) ──
echo "== $UNIT_FILE yazılıyor =="
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=YT Streamer - YouTube 7/24 muzik yayini
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_ROOT
ExecStart=$NODE_BIN $REPO_ROOT/index.js
Restart=always
RestartSec=15
KillSignal=SIGINT
TimeoutStopSec=30
User=root

[Install]
WantedBy=multi-user.target
EOF

# ── Etkinleştir + (yeniden) başlat ───────────────────────────────────────────
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
echo "== ffmpeg (orphan kontrolü — servisin node'una bağlı tek süreç olmalı) =="
ps -C ffmpeg -o pid,ppid,%cpu,etime 2>/dev/null || echo "(henüz başlamadı — albüm yükleme sürüyor olabilir, birkaç sn sonra tekrar bak)"
echo ""
echo "Kurulum tamam. Loglar: journalctl -u ${SERVICE_NAME} -f"
echo "Reboot'ta otomatik başlar (enable edildi)."
