#!/usr/bin/env bash
# Yetim (orphan) ffmpeg süreçlerini tespit eder ve öldürür.
#
#   bash scripts/deploy/sweep-orphan-ffmpeg.sh              # tespit + kill
#   bash scripts/deploy/sweep-orphan-ffmpeg.sh --dry-run    # sadece raporla
#
# Neden var: node süreci SIGKILL'lenirse (systemd TimeoutStopSec dolar, elle
# kill -9, elektrik) çalışan ffmpeg ebeveynsiz kalır ve PPID=1'e düşer. Yeni
# node başlayınca AYNI stream key'ine ikinci bir ffmpeg bağlanır — YouTube
# tarafında bozuk/çift yayın. 2026-09-29 haftasında bir kez gözlemlendi.
#
# MEŞRU sayılan ffmpeg: ebeveyni (PPID) bu repodan çalışan CANLI bir
# "node .../index.js" süreci olan ffmpeg. Bu tanım hem systemd instance'larını
# (yt-streamer, yt-streamer@<isim>) hem de elle başlatılmış bir yayını kapsar —
# yanlış pozitifle çalışan bir yayını öldürmek, yetim bırakmaktan daha kötü.
#
# ORPHAN: args'ında bu repo yolu geçen, ama PPID'si o canlı node kümesinde
# OLMAYAN ffmpeg (PPID=1, ya da ölmüş/alakasız bir ebeveyn).
#
# Bu script ffmpeg ARGÜMANLARINI asla yazdırmaz: argümanlar arasında RTMP
# URL'si, yani stream key var. Log'a sadece pid/ppid/etime düşer.
#
# Çıkış kodu her zaman 0 (usage hatası dışında): orphan sweep deploy'u
# durdurmamalı — amaç restart'ın önünü temizlemek, restart'ı engellemek değil.
#
# Test edilebilirlik: süreç listeleme/öldürme çağrıları env değişkenleriyle
# değiştirilebilir (test/scripts/sweep-orphan-ffmpeg.test.js sahte ps/pgrep/kill
# verir). Üretimde hiçbiri set edilmez, varsayılanlar kullanılır.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SWEEP_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

DRY_RUN=no
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=yes ;;
    *) echo "HATA: bilinmeyen argüman: $arg (--dry-run)" >&2; exit 2 ;;
  esac
done

# ── Enjekte edilebilir dış çağrılar ─────────────────────────────────────────
# PS_CMD çıktısı satır başına: "<pid> <ppid> <etime> <args...>"
PS_CMD="${SWEEP_PS_CMD:-ps -eo pid=,ppid=,etime=,args=}"
# Canlı node pid'leri: satır başına bir pid. pgrep eşleşme bulamazsa 1 döner
# (set -e yok, bu yüzden zararsız); boş küme = hiç canlı node yok.
# Desen tek argüman olarak geçmeli (REPO_ROOT boşluk içerebilir) — bu yüzden
# düz değişken yerine fonksiyon.
list_node_pids() {
  if [ -n "${SWEEP_NODE_PIDS_CMD:-}" ]; then
    $SWEEP_NODE_PIDS_CMD
  else
    pgrep -f "node .*${REPO_ROOT}/index.js"
  fi
}
KILL_CMD="${SWEEP_KILL_CMD:-kill}"
SLEEP_CMD="${SWEEP_SLEEP_CMD:-sleep}"
KILL_GRACE_SECONDS="${SWEEP_KILL_GRACE_SECONDS:-3}"

echo "== orphan ffmpeg kontrolü =="

# ── Canlı node PID'leri (meşru ebeveynler) ──────────────────────────────────
NODE_PIDS=" $(list_node_pids 2>/dev/null | tr -s ' \t\r\n' ' ' || true) "
if [ "$NODE_PIDS" = "  " ] || [ -z "${NODE_PIDS// /}" ]; then
  NODE_PIDS=" "
  echo "canlı node (index.js) süreci yok — bu repoya ait HER ffmpeg yetimdir."
else
  echo "canlı node (index.js) pid'leri:${NODE_PIDS%" "}"
fi

is_legit_parent() {
  case "$NODE_PIDS" in *" $1 "*) return 0 ;; esac
  return 1
}

# ── Tarama ──────────────────────────────────────────────────────────────────
ORPHANS=""
ORPHAN_COUNT=0
OURS_COUNT=0

while read -r pid ppid etime args; do
  [ -n "${pid:-}" ] || continue
  # ffmpeg olmayanları ve başka bir kurulumun ffmpeg'ini atla: args'ta bu repo
  # yolu geçmeli (playlist.txt / arkaplan / overlay yolları hep REPO_ROOT altında).
  case "$args" in
    *ffmpeg*) ;;
    *) continue ;;
  esac
  case "$args" in
    *"$REPO_ROOT"*) ;;
    *) continue ;;
  esac
  OURS_COUNT=$((OURS_COUNT + 1))
  if is_legit_parent "$ppid"; then
    # Argümanlar stream key içerir — basılmaz.
    echo "  ok      pid=$pid ppid=$ppid etime=$etime (canlı node'a bağlı)"
    continue
  fi
  echo "  ORPHAN  pid=$pid ppid=$ppid etime=$etime (ebeveyni canlı node değil)"
  ORPHANS="$ORPHANS $pid"
  ORPHAN_COUNT=$((ORPHAN_COUNT + 1))
done <<EOF
$($PS_CMD 2>/dev/null || true)
EOF

if [ "$ORPHAN_COUNT" -eq 0 ]; then
  echo "orphan ffmpeg yok (bu repoya ait $OURS_COUNT ffmpeg süreci incelendi)."
  exit 0
fi

if [ "$DRY_RUN" = "yes" ]; then
  echo "DRY RUN — öldürülmedi. Gerçek deploy şu pid'leri kill ederdi:$ORPHANS"
  exit 0
fi

# ── Öldür: önce TERM, hâlâ ayaktaysa KILL ───────────────────────────────────
for pid in $ORPHANS; do
  echo "orphan ffmpeg öldürülüyor: pid=$pid (SIGTERM)"
  $KILL_CMD -TERM "$pid" 2>/dev/null || true
done
$SLEEP_CMD "$KILL_GRACE_SECONDS" || true
for pid in $ORPHANS; do
  if $KILL_CMD -0 "$pid" 2>/dev/null; then
    echo "pid=$pid SIGTERM'e kapanmadı — SIGKILL"
    $KILL_CMD -KILL "$pid" 2>/dev/null || true
  fi
done
echo "$ORPHAN_COUNT orphan ffmpeg temizlendi — deploy devam ediyor."
exit 0
