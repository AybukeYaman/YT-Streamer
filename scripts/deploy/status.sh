#!/usr/bin/env bash
# Maskeli inceleme: servis durumu, son loglar ve ffmpeg surecleri — stream key gorunmeden.
#
# NEDEN VAR: ffmpeg yayin URL'sini (icinde stream key) komut satirinda almak zorunda,
# baska yolu yok. Bu yuzden `systemctl status`, `ps aux` ve /proc/<pid>/cmdline key'i
# daima gosterir. Bu script sizmayi KAPATMAZ — sadece ciktiyi maskeler, yani ekran
# goruntusu, kopyala-yapistir ve log paylasimi yoluyla sizmayi onler. Gercek sizma
# kanali pratikte budur; alistigimiz inceleme komutu bu olsun diye yazildi.
#
# Kullanim:
#   sudo bash scripts/deploy/status.sh                 # tum yt-* servisleri + ffmpeg sureckeri
#   sudo bash scripts/deploy/status.sh yt-streamer     # yalniz adi verilenler
#   sudo bash scripts/deploy/status.sh --lines 200     # log satir sayisi (varsayilan 40)
#   sudo bash scripts/deploy/status.sh --ps            # yalniz ffmpeg surec listesi
#
# Ciplak komutu calistirman gerekirse maskeyi tek basina da kullanabilirsin:
#   journalctl -u yt-streamer -n 100 | bash scripts/deploy/status.sh --filter
set -euo pipefail

LINES=40
PS_ONLY=0
FILTER_ONLY=0
SERVICES=()

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

while [ $# -gt 0 ]; do
  case "$1" in
    --lines)  LINES=${2:?}; shift 2 ;;
    --ps)     PS_ONLY=1; shift ;;
    --filter) FILTER_ONLY=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "HATA: bilinmeyen secenek: $1" >&2; exit 1 ;;
    *)  SERVICES+=("$1"); shift ;;
  esac
done

# ---------------------------------------------------------------- maske kurulumu
# Maske scripts/deploy/lib/mask.sh'ta — add-stream.sh, install-service.sh ve deploy.sh de
# AYNI dosyayi kullaniyor (kopya kural birakmamak icin tek kaynak).
MASK_LIB="$REPO_ROOT/scripts/deploy/lib/mask.sh"
[ -f "$MASK_LIB" ] || { echo "HATA: $MASK_LIB yok — maskesiz cikti basilmaz." >&2; exit 1; }
# shellcheck source=scripts/deploy/lib/mask.sh
. "$MASK_LIB"

# Fail-closed: maske calismiyorsa hicbir sey basilmaz.
mask_require || exit 1

if [ "$FILTER_ONLY" = 1 ]; then
  mask
  exit 0
fi

section() { echo; echo "===== $* ====="; }

# ------------------------------------------------------------------ ffmpeg surecleri
show_ps() {
  section "ffmpeg surecleri (pid, ppid, gecen sure, %cpu, komut — maskeli)"
  if ! ps -eo pid,ppid,etime,pcpu,args 2>/dev/null | awk 'NR==1 || /[f]fmpeg/' | mask; then
    echo "  (ps calistirilamadi)"
  fi
}

if [ "$PS_ONLY" = 1 ]; then
  show_ps
  exit 0
fi

# --------------------------------------------------------------------- servisler
if [ ${#SERVICES[@]} -eq 0 ]; then
  # yt-streamer, yt-streamer@<instance>, yt-golive … hepsi tek kalipta.
  mapfile -t SERVICES < <(systemctl list-units --type=service --all --no-legend --plain 'yt-*' 2>/dev/null \
    | awk '{print $1}' | sed 's/\.service$//')
  [ ${#SERVICES[@]} -eq 0 ] && echo "UYARI: yt-* adinda servis bulunamadi (systemd yok ya da kurulu degil)"
fi

for svc in "${SERVICES[@]:-}"; do
  [ -n "$svc" ] || continue
  section "systemctl status $svc (maskeli)"
  systemctl status "$svc" --no-pager --lines=0 2>&1 | mask || true
  section "journalctl -u $svc -n $LINES (maskeli)"
  journalctl -u "$svc" -n "$LINES" --no-pager 2>&1 | mask || true
done

show_ps

echo
echo "NOT: bu cikti maskelidir ve paylasilabilir. Ciplak komutlarin (systemctl status,"
echo "     ps aux, cat /proc/<pid>/cmdline) ciktisi stream key icerir — paylasma."
