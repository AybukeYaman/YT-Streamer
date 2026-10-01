#!/usr/bin/env bash
# x264 preset karsilastirmasi (Faz B testi).
#
# Canli ffmpeg'in GERCEK argumanlarini alir, yalnizca -preset degerini degistirir ve
# her preset icin ffmpeg'in kendi -benchmark sayaclariyla CPU maliyetini olcer.
# Ayrica gozle kalite kontrolu icin her presetten kisa bir mp4 ornegi uretir.
#
# Kullanim (VPS'te):
#   sudo bash scripts/bench-preset.sh --album cozyAutumnIstanbulvideo10
#   sudo bash scripts/bench-preset.sh --album cozyAutumnIstanbulvideo10 --args-file /tmp/args.bin
#
# Secenekler:
#   --album <ad>      Args'in bu albume ait oldugunu dogrula (zorunlu degil, siddetle onerilir)
#   --args-file <yol> Hazir arguman dokumu (NUL ayrakli, /proc/<pid>/cmdline formati)
#   --pid <pid>       Args'i bu surecten al (varsayilan: tek canli ffmpeg otomatik bulunur)
#   --duration <sn>   Olcum suresi, varsayilan 120
#   --sample <sn>     Ornek mp4 suresi, varsayilan 12 (0 = ornek uretme)
#   --presets a,b,c   Varsayilan: veryfast,superfast,ultrafast (ilki baseline sayilir)
#   --out <dizin>     Varsayilan /tmp/preset-bench
#
# ONEMLI: Canli yayin surerken calistirmak olcumu bozar (3 cekirdek paylasilir) ve
# yayini riske atar. Script bunu tespit edince durur; bilerek devam icin ALLOW_LIVE=1.
set -euo pipefail

DURATION=120
SAMPLE=12
PRESETS=veryfast,superfast,ultrafast
OUTDIR=/tmp/preset-bench
ALBUM=
ARGS_FILE=
PID=

die() { echo "HATA: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --album)     ALBUM=${2:?}; shift 2 ;;
    --args-file) ARGS_FILE=${2:?}; shift 2 ;;
    --pid)       PID=${2:?}; shift 2 ;;
    --duration)  DURATION=${2:?}; shift 2 ;;
    --sample)    SAMPLE=${2:?}; shift 2 ;;
    --presets)   PRESETS=${2:?}; shift 2 ;;
    --out)       OUTDIR=${2:?}; shift 2 ;;
    *) die "bilinmeyen secenek: $1" ;;
  esac
done

command -v ffmpeg >/dev/null || die "ffmpeg bulunamadi"
mkdir -p "$OUTDIR"

# ---------------------------------------------------------------- argumanlari al
if [ -z "$ARGS_FILE" ]; then
  if [ -z "$PID" ]; then
    # Canli encoder: rtmps hedefine yazan ffmpeg. Birden fazlaysa --pid ile secilsin.
    mapfile -t pids < <(pgrep -f 'ffmpeg.*rtmps://' || true)
    [ ${#pids[@]} -eq 0 ] && die "calisan canli ffmpeg bulunamadi -- --pid ya da --args-file ver"
    [ ${#pids[@]} -gt 1 ] && die "birden fazla canli ffmpeg var (${pids[*]}) -- --pid ile sec"
    PID=${pids[0]}
  fi
  [ -r "/proc/$PID/cmdline" ] || die "/proc/$PID/cmdline okunamiyor (sudo gerekebilir)"
  ARGS_FILE=$OUTDIR/args.bin
  cp "/proc/$PID/cmdline" "$ARGS_FILE"
  echo "Argumanlar pid=$PID surecinden alindi -> $ARGS_FILE"
else
  [ -r "$ARGS_FILE" ] || die "$ARGS_FILE okunamiyor"
  echo "Argumanlar $ARGS_FILE dosyasindan okunuyor"
fi

mapfile -d '' -t RAW < "$ARGS_FILE"
[ ${#RAW[@]} -gt 0 ] || die "$ARGS_FILE bos"

# cmdline'in ilk elemani argv0 (ffmpeg'in kendisi) -- arguman degil, ayir.
FFMPEG=ffmpeg
case "${RAW[0]}" in
  */ffmpeg|ffmpeg) FFMPEG=${RAW[0]}; RAW=("${RAW[@]:1}") ;;
esac

# ------------------------------------------------------------ album dogrulamasi
# Albumun kimligi args icinde arkaplan yolu / playlist yolu / drawtext textfile'larinda
# gecer. Yanlis albumun args'iyla olcum sessizce yanlis sonuc uretir -- burada durulur.
if [ -n "$ALBUM" ]; then
  if ! printf '%s\n' "${RAW[@]}" | grep -qF -- "$ALBUM"; then
    echo "Yakalanan argumanlardaki yollar:" >&2
    printf '%s\n' "${RAW[@]}" | grep -E '\.(txt|mp4|m4a|mkv)$' >&2 || true
    die "argumanlarda \"$ALBUM\" gecmiyor -- baska bir album caliyor. O album siraya gelince tekrar yakala."
  fi
  echo "Album dogrulandi: $ALBUM"
fi

# ------------------------------------------------------------ canli yayin korumasi
live=$(pgrep -cf 'ffmpeg.*rtmps://' 2>/dev/null || true)
if [ "${live:-0}" -gt 0 ] && [ "${ALLOW_LIVE:-0}" != 1 ]; then
  {
    echo "HATA: canli yayin yapan ffmpeg calisiyor."
    echo "  Olcum 3 cekirdegi canli surecle paylasir: rtime siser (HIZ dusuk cikar) ve canli"
    echo "  yayinin speed'i 1.00x altina inebilir. Dogru yontem: once yayini durdur"
    echo "  (sudo systemctl stop yt-streamer), sonra olc."
    echo "  Bilerek devam etmek icin: ALLOW_LIVE=1 sudo -E bash scripts/bench-preset.sh ..."
  } >&2
  exit 1
fi

# ------------------------------------------------------- argumanlari olcume cevir
# Yapilan degisiklikler (baska hicbir seye dokunulmaz):
#   -preset <x>      -> istenen preset
#   -re              -> cikarilir (gercek zaman freni; olcumde tam hiz gerekir)
#   -y / -shortest   -> korunur
#   -f flv <hedef>   -> -f null - (olcum) ya da -f mp4 <dosya> (ornek)
#   playlist yolu    -> anlik goruntu kopyasi (canli surec dosyayi yeniden yazarsa test bozulmasin)
for i in "${!RAW[@]}"; do
  if [ "${RAW[$i]}" = "concat" ] && [ "${RAW[$((i+3))]:-}" = "-i" ]; then
    src=${RAW[$((i+4))]}
    snapshot=$OUTDIR/playlist-snapshot.txt
    cp "$src" "$snapshot"
    RAW[$((i+4))]=$snapshot
    echo "Playlist kopyalandi: $src -> $snapshot ($(wc -l < "$snapshot") satir)"
  fi
done

# build_args <preset> <sure> <cikti-formati> <cikti-hedefi>  -> BUILT dizisi
build_args() {
  local preset=$1 dur=$2 fmt=$3 target=$4
  BUILT=()
  local skip_next=0 i
  for i in "${!RAW[@]}"; do
    if [ $skip_next -eq 1 ]; then skip_next=0; continue; fi
    case "${RAW[$i]}" in
      -re) continue ;;
      -preset) BUILT+=(-preset "$preset"); skip_next=1; continue ;;
      -f) # "-f flv <hedef>" cikar; "-f concat" korunur
          if [ "${RAW[$((i+1))]:-}" = "flv" ]; then skip_next=1; continue; fi ;;
    esac
    BUILT+=("${RAW[$i]}")
  done
  # Eski cikti hedefi (son eleman: rtmps:// ya da .flv) atilir.
  local last=${BUILT[${#BUILT[@]}-1]}
  case "$last" in
    rtmps://*|rtmp://*|*.flv) unset "BUILT[${#BUILT[@]}-1]" ;;
    *) echo "UYARI: son arguman beklenen cikti hedefi degil: $last" >&2 ;;
  esac
  BUILT=("${BUILT[@]}" -benchmark -nostdin -t "$dur" -f "$fmt" "$target")
}

# ------------------------------------------------------------------------- olcum
RESULTS=$OUTDIR/results.tsv
printf 'PRESET\tCPU-s\tRTIME\tHIZ\tCEK@1x\n' > "$RESULTS"

IFS=, read -r -a preset_list <<< "$PRESETS"
for preset in "${preset_list[@]}"; do
  log=$OUTDIR/bench-$preset.log
  build_args "$preset" "$DURATION" null -
  echo
  echo "=== OLCUM: $preset (${DURATION}s) ==="
  { printf '%q ' "$FFMPEG" "${BUILT[@]}"; echo; } > "$OUTDIR/cmd-$preset.txt"
  "$FFMPEG" "${BUILT[@]}" > /dev/null 2> "$log" || die "$preset olcumu basarisiz -- $log"

  # "bench: utime=12.345s stime=1.234s rtime=56.789s"
  bench=$(grep -o 'bench: utime=[0-9.]*s stime=[0-9.]*s rtime=[0-9.]*s' "$log" | tail -1)
  [ -n "$bench" ] || die "$preset: -benchmark satiri bulunamadi -- $log"
  u=$(sed -E 's/.*utime=([0-9.]+)s.*/\1/' <<< "$bench")
  s=$(sed -E 's/.*stime=([0-9.]+)s.*/\1/' <<< "$bench")
  r=$(sed -E 's/.*rtime=([0-9.]+)s.*/\1/' <<< "$bench")
  awk -v p="$preset" -v u="$u" -v s="$s" -v r="$r" -v d="$DURATION" \
    'BEGIN { c = u + s; printf "%s\t%.2f\t%.2f\t%.2fx\t%.3f\n", p, c, r, d / r, c / d }' >> "$RESULTS"
  tail -1 "$RESULTS"
done

# ------------------------------------------------------------- kalite ornekleri
if [ "$SAMPLE" -gt 0 ]; then
  for preset in "${preset_list[@]}"; do
    out=$OUTDIR/sample-$preset.mp4
    build_args "$preset" "$SAMPLE" mp4 "$out"
    echo
    echo "=== ORNEK: $preset -> $out (${SAMPLE}s) ==="
    "$FFMPEG" "${BUILT[@]}" > /dev/null 2> "$OUTDIR/sample-$preset.log" \
      || die "$preset ornegi basarisiz -- $OUTDIR/sample-$preset.log"
    ls -lh "$out" | awk '{ print "  " $5, $9 }'
  done
fi

# ------------------------------------------------------------------------ ozet
echo
echo "================ SONUC ================"
column -t -s "$(printf '\t')" "$RESULTS"
awk -F'\t' 'NR == 2 { b = $2; base = $1 } NR > 2 {
  d = (b - $2) / b * 100
  if (d > 0.05)       printf "%s: %s baseline degerine gore CPU %%%.1f AZ\n", $1, base, d
  else if (d < -0.05) printf "%s: %s baseline degerine gore CPU %%%.1f FAZLA\n", $1, base, -d
  else                printf "%s: %s ile ayni CPU\n", $1, base
}' "$RESULTS"
echo
echo "Dosyalar: $OUTDIR  (loglar, cmd-*.txt, sample-*.mp4)"
if [ "$SAMPLE" -gt 0 ]; then
  echo "Indirmek icin (yerelden): scp '<kullanici>@<vps>:$OUTDIR/sample-*.mp4' ."
fi
