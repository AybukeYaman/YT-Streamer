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
# Iki katman:
#   1. Kalip bazli: rtmp(s)://.../live2/<key> ve YOUTUBE_*=<deger> — .env'de olmayan,
#      rotasyondan onceki ya da baska bir makinenin key'i de maskelenir.
#   2. Deger bazli: .env* dosyalarinda yazili olan key/token'lar birebir degistirilir —
#      key log icinde URL disinda, ciplak gecse de yakalanir.
# Kalip katmani her zaman devrede: .env okunamasa bile cikti maskesiz kalmaz.
build_sed_script() {
  printf '%s\n' \
    's#(rtmps?://[^[:space:]]*/live2/)[A-Za-z0-9_-]+#\1***MASKED***#g' \
    's#(YOUTUBE_[A-Z_]*(KEY|TOKEN|SECRET)[[:space:]]*=[[:space:]]*)[^[:space:]"]+#\1***MASKED***#g'
  # Deger bazli katman: .env, .env.<instance>, .env.youtube …
  local f line value
  for f in "$REPO_ROOT"/.env "$REPO_ROOT"/.env.*; do
    [ -f "$f" ] || continue
    case "$f" in *.example) continue ;; esac
    while IFS= read -r line; do
      case "$line" in
        YOUTUBE_*KEY=*|YOUTUBE_*TOKEN=*|YOUTUBE_*SECRET=*) value=${line#*=} ;;
        *) continue ;;
      esac
      value=${value%\"}; value=${value#\"}
      value=${value%\'}; value=${value#\'}
      # Cok kisa degerler (bos ya da yer tutucu) maskelenmez: "s###" gibi bir kural
      # ciktinin her yerini bozardi.
      [ ${#value} -ge 8 ] || continue
      # sed icin ayirici olarak # kullaniliyor; degerde # varsa kacir.
      printf 's#%s#***MASKED***#g\n' "$(printf '%s' "$value" | sed -e 's#[\\&#]#\\&#g')"
    done < "$f"
  done
}

SED_SCRIPT=$(build_sed_script)
mask() { sed -E -f <(printf '%s\n' "$SED_SCRIPT"); }

if [ "$FILTER_ONLY" = 1 ]; then
  mask
  exit 0
fi

# Maskenin gercekten devrede oldugunu kanitla: bilinen bir kalip filtreden gecirilir.
probe=$(printf 'rtmps://a.rtmps.youtube.com/live2/abcd-efgh-ijkl-mnop-qrst\n' | mask)
case "$probe" in
  *MASKED*) ;;
  *) echo "HATA: maske calismiyor, cikti basilmadi (sed -E -f destegi yok?)" >&2; exit 1 ;;
esac

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
