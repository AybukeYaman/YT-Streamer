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
# ── Key maskesi ─────────────────────────────────────────────────────────────
# `systemctl status` ana surecin komut satirini basar, orada ffmpeg'in RTMP URL'si
# (yani stream key) var. Cikti maskeden gecirilir; maske calismiyorsa o cikti
# BASILMAZ (fail-closed) — maskesiz basmak, hic basmamaktan kotudur.
MASK_LIB="$REPO_ROOT/scripts/deploy/lib/mask.sh"
if [ -f "$MASK_LIB" ]; then
  # shellcheck source=scripts/deploy/lib/mask.sh
  . "$MASK_LIB"
else
  echo "UYARI: $MASK_LIB yok — key iceren ciktilar atlanacak." >&2
  mask() { cat; }
  mask_require() { return 1; }
fi

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

# Env doğrulama tek yerde: scripts/deploy/check-env.sh (.env.example sözleşmedir).
# Burada UYARI olarak geçilir, hata verilmez — ilk kurulumda .env henüz doldurulmamış
# olabilir ve servisin kurulması yine de istenir. Kod güncellemesinde ise deploy.sh
# aynı kontrolü HATA olarak uygular ve deploy'u durdurur.
if ! bash "$SCRIPT_DIR/check-env.sh" .env >&2; then
  echo "UYARI: .env eksik/boş — rtmp modunda uygulama config hatasıyla düşecek." >&2
  echo "        Servis kurulumu yine de sürüyor; key'i doldurup şunu çalıştır:" >&2
  echo "          systemctl restart yt-streamer" >&2
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

# Sinirsiz yeniden baslatma BILINCLI. systemd'nin varsayilan baslatma limiti
# (5 baslatma / 10 sn) RestartSec=15 yuzunden zaten hic tetiklenmiyordu; burada
# acikca 0 yaziyoruz ki davranis kazara degil karar olsun. Gerekce: uzun bir ag
# kesintisinde yayin kendiliginden donmeli. Surekli cokme halinde alarm uygulama
# icinden gelir (supervisor, tekrarlayan cokme bildirimi) — unit'i failed'a
# dusurup yayini kapatmak istenen davranis DEGIL. Ayrinti: KARARLAR.md
StartLimitIntervalSec=0

# NOT: Unit'te bilerek EnvironmentFile YOK. Uygulama .env'i kendisi okur
# (src/config/load-config.js, util.parseEnv) ve yolu __dirname bazlı olduğu için
# WorkingDirectory'den bağımsızdır. systemd'nin EnvironmentFile quoting kuralları
# util.parseEnv'den farklı olduğundan iki okuma yolu eklemek sessiz tutarsızlık
# riski getirir, karşılığında hiçbir fayda sağlamaz. Ayrıntı: KARARLAR.md
[Service]
Type=simple
WorkingDirectory=$REPO_ROOT
# Restart'in onunu temizle: onceki node SIGKILL'lenmisse (TimeoutStopSec doldu,
# elle kill -9, elektrik) ffmpeg PPID=1'e dusup yayina bagli kalir; yeni node
# ayni stream key'ine IKINCI bir ffmpeg baglar. Sweep'in tek cagirani deploy.sh
# idi, ama yetim birakan yol tam olarak systemd restart'i — ustelik alarm
# mesajlarinin operatore soyledigi duzeltme de "systemctl restart yt-streamer".
# "-" oneki bilincli: sweep basarisiz olsa bile yayin BASLAR (script'in kendi
# "deploy'u durdurmaz" ilkesiyle ayni). Script yanlis pozitif vermez: mesru
# ffmpeg = ebeveyni bu repodan calisan CANLI bir node, yani diger instance'lara
# ve elle baslatilmis yayinlara dokunmaz. Ayrinti: KARARLAR.md
ExecStartPre=-/bin/bash $REPO_ROOT/scripts/deploy/sweep-orphan-ffmpeg.sh
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
# ── 'deploy' kısayolu ───────────────────────────────────────────────────────
# Kod güncellemesi en sık yapılan iş ve her seferinde "cd <repo> && bash deploy.sh"
# yazmak gereksiz. Global bir sarmalayıcı: nerede olursan ol `deploy` yeter.
# Argümanlar olduğu gibi aktarılır (deploy --dry-run, deploy --test).
# Repo yolu kurulum anında gömülür — sarmalayıcı WorkingDirectory'ye bağlı değil.
DEPLOY_SHORTCUT=/usr/local/bin/deploy
echo "== $DEPLOY_SHORTCUT yazılıyor =="
cat > "$DEPLOY_SHORTCUT" <<SHORTCUT
#!/usr/bin/env bash
# YT Streamer deploy kisayolu — scripts/deploy/install-service.sh tarafindan uretildi.
# Elle duzenleme: kurulum tekrar calistirilinca uzerine yazilir.
exec bash "$REPO_ROOT/deploy.sh" "\$@"
SHORTCUT
chmod +x "$DEPLOY_SHORTCUT"

systemctl daemon-reload
if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
  systemctl restart "$SERVICE_NAME"
else
  systemctl enable --now "$SERVICE_NAME"
fi

sleep 3
echo ""
echo "== durum =="
if mask_require; then
  systemctl status "$SERVICE_NAME" --no-pager -l 2>&1 | mask || true
else
  echo "(servis durumu atlandi: key maskesi yok — 'systemctl status $SERVICE_NAME' ciktisi key icerir)"
fi
echo ""
echo "== ffmpeg (orphan kontrolü — servisin node'una bağlı tek süreç olmalı) =="
ps -C ffmpeg -o pid,ppid,%cpu,etime 2>/dev/null || echo "(henüz başlamadı — albüm yükleme sürüyor olabilir, birkaç sn sonra tekrar bak)"
echo ""
echo "Kurulum tamam. Loglar: journalctl -u ${SERVICE_NAME} -f"
echo "Reboot'ta otomatik başlar (enable edildi)."
