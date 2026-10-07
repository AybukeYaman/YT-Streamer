#!/usr/bin/env bash
# Albümleri (music-source/) YEREL makineden VPS'e taşır. deploy.sh yalnızca kodu
# güncelliyor; müzik ve arkaplanlar git'e girmediği için (.gitignore) bu adım ayrı.
#
# YERELDE çalışır, VPS'te değil — diğer deploy script'lerinin tersine.
#
#   bash scripts/deploy/sync-albums.sh <kullanıcı@host> <uzak-repo-yolu> [seçenekler]
#
#   --album <ad>   yalnızca bu albümü taşı (birden çok kez verilebilir)
#   --dry-run      hiçbir şey taşımaz, ne yapılacağını yazar
#   --delete       YEREL'de olmayan uzak albümleri siler (varsayılan: silmez)
#
# Örnek:
#   bash scripts/deploy/sync-albums.sh root@1.2.3.4 /root/yt-stream-system --dry-run
#
# Neden rsync değil: Windows'ta (Git Bash) rsync kurulu gelmiyor, ssh geliyor.
# tar | ssh tar aynı işi görür; m4a zaten sıkıştırılmış olduğu için gzip kullanılmaz
# (CPU yakar, kazanç ~%1).
#
# ATOMİK YAZMA — bu script'in asıl varlık sebebi:
# music-source/ canlı okunan bir dizin. AlbumRepository bir klasörü "background.mp4
# (ya da backgrounds/) + music/ var" diye geçerli sayıyor. Yarım aktarılmış bir albüm
# tam da bu kontrolü geçer ve EKSİK PARÇALARLA yayına girer. Bu yüzden aktarım önce
# uzaktaki music-source/.staging/<albüm>/ içine yapılır, ancak tamamlandığında tek
# mv ile yerine konur. Nokta ile başlayan klasörleri repository taramıyor.
#
# Değişmeyen albüm atlanır: karşılaştırma "dosya sayısı + toplam bayt" üzerinden.
# İçerik aynı kalıp bayt değişmeyen bir düzenleme teorik olarak kaçar; pratikte
# albümler yeniden üretilince hep değişiyor. Şüphede --album ile zorla gönder.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ALBUMS_DIR="$REPO_ROOT/music-source"

REMOTE=""
REMOTE_PATH=""
DRY_RUN=0
DO_DELETE=0
ONLY_ALBUMS=()

usage() {
  echo "kullanım: bash scripts/deploy/sync-albums.sh <kullanıcı@host> <uzak-repo-yolu> [--album <ad>] [--dry-run] [--delete]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --delete) DO_DELETE=1 ;;
    --album)
      shift
      [ $# -gt 0 ] || { echo "HATA: --album bir albüm adı bekliyor" >&2; exit 2; }
      ONLY_ALBUMS+=("$1")
      ;;
    -h|--help) usage ;;
    -*) echo "HATA: bilinmeyen seçenek $1" >&2; usage ;;
    *)
      if [ -z "$REMOTE" ]; then REMOTE="$1"
      elif [ -z "$REMOTE_PATH" ]; then REMOTE_PATH="$1"
      else echo "HATA: fazladan argüman: $1" >&2; usage
      fi
      ;;
  esac
  shift
done

[ -n "$REMOTE" ] && [ -n "$REMOTE_PATH" ] || usage
[ -d "$ALBUMS_DIR" ] || { echo "HATA: $ALBUMS_DIR yok" >&2; exit 1; }

REMOTE_ALBUMS="$REMOTE_PATH/music-source"
STAGING="$REMOTE_ALBUMS/.staging"

# Bir albümün parmak izi: "<dosya sayısı> <toplam bayt>". Nokta ile başlayan
# klasörler (staging) hiç sayılmaz.
local_fingerprint() {
  local dir="$1"
  find "$dir" -type f -printf '%s\n' 2>/dev/null \
    | awk '{ n++; total += $1 } END { printf "%d %d", n, total }'
}

echo "== albüm senkronu =="
echo "yerel : $ALBUMS_DIR"
echo "uzak  : $REMOTE:$REMOTE_ALBUMS"
[ "$DRY_RUN" -eq 1 ] && echo "(DRY RUN — hiçbir şey taşınmayacak)"
echo ""

# Yerel albümler (nokta ile başlayanlar hariç — repository de onları atlıyor)
mapfile -t LOCAL_ALBUMS < <(find "$ALBUMS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
  | grep -v '^\.' | sort)
[ "${#LOCAL_ALBUMS[@]}" -gt 0 ] || { echo "yerelde albüm yok."; exit 0; }

if [ "${#ONLY_ALBUMS[@]}" -gt 0 ]; then
  FILTERED=()
  for want in "${ONLY_ALBUMS[@]}"; do
    found=0
    for a in "${LOCAL_ALBUMS[@]}"; do [ "$a" = "$want" ] && found=1 && FILTERED+=("$a"); done
    [ "$found" -eq 1 ] || { echo "HATA: yerelde albüm yok: $want" >&2; exit 1; }
  done
  LOCAL_ALBUMS=("${FILTERED[@]}")
fi

# Uzak parmak izleri tek SSH turunda alınır (albüm başına bağlanmak yavaş).
echo "uzak durum okunuyor…"
REMOTE_STATE="$(ssh "$REMOTE" "
  cd '$REMOTE_ALBUMS' 2>/dev/null || exit 0
  for d in */; do
    [ -d \"\$d\" ] || continue
    name=\"\${d%/}\"
    case \"\$name\" in .*) continue ;; esac
    printf '%s\t' \"\$name\"
    find \"\$name\" -type f -printf '%s\n' 2>/dev/null | awk '{ n++; t += \$1 } END { printf \"%d %d\n\", n, t }'
  done
")" || { echo "HATA: VPS'e bağlanılamadı ya da $REMOTE_ALBUMS okunamadı" >&2; exit 1; }

remote_fingerprint() {
  printf '%s\n' "$REMOTE_STATE" | awk -F'\t' -v a="$1" '$1 == a { print $2 }'
}

TO_SEND=()
for album in "${LOCAL_ALBUMS[@]}"; do
  lf="$(local_fingerprint "$ALBUMS_DIR/$album")"
  rf="$(remote_fingerprint "$album")"
  size="$(du -sh "$ALBUMS_DIR/$album" | cut -f1)"
  if [ -z "$rf" ]; then
    echo "  YENİ       $album ($size)"
    TO_SEND+=("$album")
  elif [ "$lf" != "$rf" ]; then
    echo "  DEĞİŞMİŞ   $album ($size) — yerel: $lf / uzak: $rf"
    TO_SEND+=("$album")
  else
    echo "  aynı       $album"
  fi
done

EXTRA=()
while IFS=$'\t' read -r name _; do
  [ -n "$name" ] || continue
  found=0
  for a in "${LOCAL_ALBUMS[@]}"; do [ "$a" = "$name" ] && found=1; done
  [ "$found" -eq 0 ] && EXTRA+=("$name")
done <<< "$REMOTE_STATE"

if [ "${#EXTRA[@]}" -gt 0 ]; then
  echo ""
  for name in "${EXTRA[@]}"; do
    if [ "$DO_DELETE" -eq 1 ]; then
      echo "  SİLİNECEK  $name (uzakta var, yerelde yok)"
    else
      echo "  uzakta fazla: $name (silmek için --delete)"
    fi
  done
fi

if [ "${#TO_SEND[@]}" -eq 0 ] && { [ "${#EXTRA[@]}" -eq 0 ] || [ "$DO_DELETE" -eq 0 ]; }; then
  echo ""
  echo "yapılacak bir şey yok."
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "DRY RUN bitti — hiçbir şey taşınmadı."
  exit 0
fi

# ── Aktarım ─────────────────────────────────────────────────────────────────
for album in "${TO_SEND[@]}"; do
  echo ""
  echo "== $album gönderiliyor =="
  # Önce staging'i temizle: yarım kalmış önceki denemenin artığı kalmasın.
  ssh "$REMOTE" "rm -rf '$STAGING/$album' && mkdir -p '$STAGING'"
  # gzip YOK: m4a/mp4 zaten sıkıştırılmış.
  tar -cf - -C "$ALBUMS_DIR" "$album" \
    | ssh "$REMOTE" "tar -xf - -C '$STAGING'"
  # Aktarım tamam: yerine koy. Eski sürüm önce yedek adına alınır ki mv başarısız
  # olursa albüm hiç yokmuş gibi kalmasın.
  ssh "$REMOTE" "
    set -e
    cd '$REMOTE_ALBUMS'
    if [ -d '$album' ]; then mv '$album' '.eski-$album'; fi
    mv '.staging/$album' '$album'
    rm -rf '.eski-$album'
  "
  echo "   yerine kondu: $REMOTE_ALBUMS/$album"
done

if [ "$DO_DELETE" -eq 1 ] && [ "${#EXTRA[@]}" -gt 0 ]; then
  for name in "${EXTRA[@]}"; do
    echo "== $name siliniyor (uzak) =="
    ssh "$REMOTE" "rm -rf '$REMOTE_ALBUMS/$name'"
  done
fi

echo ""
echo "== bitti =="
echo "Albümler yayın sürecine ALBÜM GEÇİŞİNDE girer (AlbumRepository her playlist'te"
echo "diski yeniden tarar). Hemen görmek istersen: sudo systemctl restart yt-streamer"
