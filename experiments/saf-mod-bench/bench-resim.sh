#!/usr/bin/env bash
set -u
OUT="$1"
cd "$OUT"
ENC="-c:v libx264 -preset superfast -threads 3 -pix_fmt yuv420p -profile:v main -r 24 -g 48 -keyint_min 48 -sc_threshold 0 -b:v 3500k -maxrate 3500k -bufsize 7000k"
AUDIO="-f lavfi -i sine=frequency=220:sample_rate=48000 -c:a aac -b:a 160k -ar 48000 -ac 2"
DT="drawtext=fontfile=font.ttf:fontsize=28:fontcolor=white:x=40:y=h-100:text=AnUnfinishedSentence"

best() {
  local name="$1"; shift
  local min=999999 rt=0
  for i in 1 2 3; do
    local log="$OUT/$name.$i.log"
    "$@" -benchmark -f null - > "$log" 2>&1
    local line; line=$(grep -a "bench: utime" "$log" | tail -1)
    local u s r
    u=$(echo "$line" | sed -E 's/.*utime=([0-9.]+)s.*/\1/')
    s=$(echo "$line" | sed -E 's/.*stime=([0-9.]+)s.*/\1/')
    r=$(echo "$line" | sed -E 's/.*rtime=([0-9.]+)s.*/\1/')
    if [ -z "$u" ] || [ "$u" = "$line" ]; then echo "$name | HATA: $(tail -3 "$log" | tr '\n' ' ')"; return; fi
    local tot; tot=$(awk -v u="$u" -v s="$s" 'BEGIN{printf "%.2f", u+s}')
    if awk -v a="$tot" -v b="$min" 'BEGIN{exit !(a<b)}'; then min="$tot"; rt="$r"; fi
  done
  echo "$name | CPU(60 sn çıktı için) = ${min} sn | gerçek süre ${rt} sn"
}

# Hattın gerçekte ürettiği resim albümü: 10 sn durağan video (prepare-backgrounds IMAGE_LOOP_SECONDS)
ffmpeg -hide_banner -v error -y -loop 1 -framerate 24 -i frame.png -t 10 -vf scale=1280:720 -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -r 24 static10.mp4

best "B3 resim = 10 sn durağan video (hattın ürettiği)" ffmpeg -hide_banner -y -stream_loop -1 -threads 1 -i static10.mp4 $AUDIO -t 60 -vf "scale=1280:720" $ENC
best "B3y aynısı + şarkı adı yazısı                  " ffmpeg -hide_banner -y -stream_loop -1 -threads 1 -i static10.mp4 $AUDIO -t 60 -vf "scale=1280:720,$DT" $ENC
best "B4 resim, tek kare bellekte döner (loop filtresi)" ffmpeg -hide_banner -y -i frame.png $AUDIO -t 60 -vf "scale=1280:720,loop=loop=-1:size=1:start=0,fps=24" $ENC
best "B4y aynısı + şarkı adı yazısı                  " ffmpeg -hide_banner -y -i frame.png $AUDIO -t 60 -vf "scale=1280:720,loop=loop=-1:size=1:start=0,fps=24,$DT" $ENC
