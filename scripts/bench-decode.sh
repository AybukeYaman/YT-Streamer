#!/usr/bin/env bash
# Arkaplan decode maliyeti olcumu (D kararinin on kosulu) + disk raporu.
#
# NICIN: E testindeki albumler arasi 1.39x fark decode ile encode'un TOPLAMI.
# Hareketli/detayli bir arkaplan hem decode'da hem x264 hareket tahmininde pahalidir.
# D (arkaplani daha ucuz decode edilecek sekilde yeniden uretmek) yalnizca DECODE
# payini alabilir; encode payi arkaplan ne kadar ucuz decode edilirse edilsin durur.
# Bu script o payi olcer: boylece D'nin tavani tartismayla degil veriyle sinirlanir.
#
# Yontem: music-source/<album>/background.mp4 yalniz DECODE edilir — filtre yok,
# gercek encode yok (-c:v wrapped_avframe + -f null, cerceve kopyalanmaz bile).
# -stream_loop -1 ile dosya kisa olsa da tam DURATION boyunca decode surer, yani
# canli yayindaki davranisin aynisi. -benchmark sayaclari CPU-s verir.
#
# Kullanim:
#   bash scripts/bench-decode.sh                        tum albumler, 120 sn
#   bash scripts/bench-decode.sh --duration 60
#   bash scripts/bench-decode.sh autumnLake-video11 ...  yalniz adi verilenler
#   bash scripts/bench-decode.sh --full <dosya.tsv>      tam hat sonuclariyla pay hesabi
#
# --full dosyasi: her satir "<album><TAB><cekirdek@1x>" (E testi tablosundan).
# Verilirse decode payi yuzde olarak da yazilir — D'nin ust siniri dogrudan okunur.
#
# Canli yayin sirasinda calistirmak olcumu bozar (paylasimli CPU); script uyarir.
set -euo pipefail

DURATION=120
FULL_FILE=
ONLY=()

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SRC_DIR=$REPO_ROOT/music-source

die() { echo "HATA: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --duration) DURATION=${2:?}; shift 2 ;;
    --full)     FULL_FILE=${2:?}; shift 2 ;;
    --dir)      SRC_DIR=${2:?}; shift 2 ;;
    -h|--help)  sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) die "bilinmeyen secenek: $1" ;;
    *)  ONLY+=("$1"); shift ;;
  esac
done

command -v ffmpeg >/dev/null || die "ffmpeg bulunamadi"
command -v ffprobe >/dev/null || die "ffprobe bulunamadi"
[ -d "$SRC_DIR" ] || die "arkaplan dizini yok: $SRC_DIR"
[ -z "$FULL_FILE" ] || [ -r "$FULL_FILE" ] || die "--full dosyasi okunamiyor: $FULL_FILE"

live=$(pgrep -cf 'ffmpeg.*rtmps://' 2>/dev/null || true)
if [ "${live:-0}" -gt 0 ]; then
  echo "UYARI: canli yayin yapan ffmpeg calisiyor — CPU paylasilir, sonuclar oldugundan"
  echo "       pahali/yavas cikar. Kesin olcum icin once yayini durdur."
  echo
fi

# Olculecek albumler
list_albums() {
  if [ ${#ONLY[@]} -gt 0 ]; then printf '%s\n' "${ONLY[@]}"; return; fi
  find "$SRC_DIR" -mindepth 2 -maxdepth 2 -name background.mp4 -printf '%h\n' \
    | sed "s#^$SRC_DIR/##" | sort
}

RESULTS=$(mktemp); trap 'rm -f "$RESULTS"' EXIT
printf 'ALBUM\tCPU-s\tRTIME\tCEK@1x\tMBIT/S\tBOYUT\tSURE\n' > "$RESULTS"

while IFS= read -r album; do
  [ -n "$album" ] || continue
  bg=$SRC_DIR/$album/background.mp4
  [ -r "$bg" ] || { echo "ATLANDI $album: background.mp4 yok/okunamiyor"; continue; }

  # Kaynak ozellikleri (disk karari icin: bitrate ve dosya boyutu).
  # anahtar=deger okunuyor: ffprobe alanlari kendi sabit sirasinda basar (size, bit_rate),
  # istenen siraya gore degil — konuma guvenmek sessizce yanlis sutun uretir.
  dur=0; bitrate=0; size=0
  while IFS='=' read -r k v; do
    case "$k" in
      duration) dur=$v ;;
      bit_rate) bitrate=$v ;;
      size)     size=$v ;;
    esac
  done < <(ffprobe -v error -show_entries format=duration,bit_rate,size -of default=nw=1 "$bg")

  echo "olculuyor: $album (${DURATION}s decode)"
  log=$(mktemp)
  ffmpeg -hide_banner -benchmark -nostdin \
    -stream_loop -1 -i "$bg" -map 0:v:0 -an \
    -t "$DURATION" -c:v wrapped_avframe -f null - \
    > /dev/null 2> "$log" || { cat "$log" >&2; rm -f "$log"; die "$album decode olcumu basarisiz"; }

  bench=$(grep -o 'bench: utime=[0-9.]*s stime=[0-9.]*s rtime=[0-9.]*s' "$log" | tail -1)
  rm -f "$log"
  [ -n "$bench" ] || die "$album: -benchmark satiri bulunamadi"
  u=$(sed -E 's/.*utime=([0-9.]+)s.*/\1/' <<< "$bench")
  s=$(sed -E 's/.*stime=([0-9.]+)s.*/\1/' <<< "$bench")
  r=$(sed -E 's/.*rtime=([0-9.]+)s.*/\1/' <<< "$bench")

  awk -v a="$album" -v u="$u" -v s="$s" -v r="$r" -v d="$DURATION" \
      -v br="${bitrate:-0}" -v sz="${size:-0}" -v du="${dur:-0}" 'BEGIN {
    c = u + s
    printf "%s\t%.2f\t%.2f\t%.3f\t%.2f\t%.1f MB\t%.1f s\n", a, c, r, c / d, br / 1000000, sz / 1048576, du
  }' >> "$RESULTS"
done < <(list_albums)

[ "$(wc -l < "$RESULTS")" -gt 1 ] || die "hicbir albüm olculemedi"

echo
echo "========== DECODE MALIYETI (yalniz decode, filtre/encode yok) =========="
column -t -s "$(printf '\t')" "$RESULTS"

# ---------------------------------------------------- tam hat ile karsilastirma
if [ -n "$FULL_FILE" ]; then
  echo
  echo "========== DECODE PAYI (tam hat: $FULL_FILE) =========="
  awk -F'\t' -v full="$FULL_FILE" '
    BEGIN {
      while ((getline line < full) > 0) {
        n = split(line, f, "\t")
        if (n >= 2 && f[2] + 0 > 0) total[f[1]] = f[2] + 0
      }
      printf "%-28s %8s %8s %8s\n", "ALBUM", "DECODE", "TAM", "PAY"
    }
    NR > 1 {
      if (!($1 in total)) { printf "%-28s %8.3f %8s %8s\n", $1, $4, "-", "(tam hat verisi yok)"; next }
      printf "%-28s %8.3f %8.3f %7.1f%%\n", $1, $4, total[$1], $4 / total[$1] * 100
      sd += $4; st += total[$1]
    }
    END {
      if (st > 0) {
        printf "%-28s %8.3f %8.3f %7.1f%%\n", "TOPLAM", sd, st, sd / st * 100
        print ""
        print "D nin TAVANI: decode payi tamamen sifirlanirsa kazanc bu yuzdedir."
        print "Gercek kazanc bunun bir kismi (ucuz decode sifir decode degil)."
      }
    }' "$RESULTS"
fi

# ----------------------------------------------------------------- disk raporu
echo
echo "========== DISK =========="
du -sh "$SRC_DIR" 2>/dev/null | awk '{ printf "music-source toplam: %s\n", $1 }'
df -h "$SRC_DIR" 2>/dev/null | awk 'NR==1 { print } NR==2 { print }'
echo
echo "Varyant maliyeti (kabaca, mevcut toplam uzerinden):"
du -sb "$SRC_DIR" 2>/dev/null | awk '{
  gb = $1 / 1073741824
  printf "  simdiki (h264 crf18)   : %.2f GB\n", gb
  printf "  V1 all-intra, cabac=0  : ~%.2f GB (3-5x)\n", gb * 4
  printf "  V2 mjpeg q2            : ~%.2f GB (5-10x)\n", gb * 7
  printf "  V3 rawvideo            : 33 MB/s okuma — CPU yerine disk I/O maliyeti\n"
}'
