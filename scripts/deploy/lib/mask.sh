#!/usr/bin/env bash
# Stream key maskeleme — tek kaynak. Bu dosyayı source eden her script `mask` ile
# çıktıyı süzebilir.
#
# NEDEN VAR: ffmpeg yayın URL'sini (içinde stream key) komut satırında almak zorunda,
# ffmpeg'in bunu dosyadan okuma yolu yok. Bu yüzden `systemctl status`, `ps aux`,
# `journalctl` ve /proc/<pid>/cmdline key'i daima gösterir. Maskeleme sızmayı KAPATMAZ —
# çıktıyı korur, yani ekran görüntüsü, kopyala-yapıştır ve log paylaşımı yoluyla sızmayı
# önler. Pratikte gerçek sızma kanalı budur (1 Ekim: iki key terminal çıktısında göründü).
#
# Kullanım:
#   REPO_ROOT=/srv/yt-stream
#   . scripts/deploy/lib/mask.sh
#   mask_require            # maske çalışmıyorsa HİÇBİR ŞEY basmadan çık (fail-closed)
#   systemctl status yt-streamer --no-pager | mask
#
# İki katman:
#   1. Kalıp bazlı: rtmp(s)://.../live2/<key> ve YOUTUBE_*KEY|TOKEN|SECRET=<değer>.
#      .env'de olmayan, rotasyondan önceki ya da başka bir makinenin key'i de maskelenir.
#   2. Değer bazlı: .env* dosyalarında yazılı key/token'lar birebir değiştirilir — key,
#      log içinde URL dışında, çıplak geçse de yakalanır.
# Kalıp katmanı HER ZAMAN devrede: .env okunamasa bile çıktı maskesiz kalmaz.

MASK_ENV_DIR="${MASK_ENV_DIR:-${REPO_ROOT:-.}}"

mask_build_sed_script() {
  printf '%s\n' \
    's#(rtmps?://[^[:space:]]*/live2/)[A-Za-z0-9_-]+#\1***MASKED***#g' \
    's#(YOUTUBE_[A-Z_]*(KEY|TOKEN|SECRET)[[:space:]]*=[[:space:]]*)[^[:space:]"]+#\1***MASKED***#g'
  local f line value
  for f in "$MASK_ENV_DIR"/.env "$MASK_ENV_DIR"/.env.*; do
    [ -f "$f" ] || continue
    # .env.example sözleşme dosyası (içinde gerçek değer yok), .disabled bir park işareti.
    case "$f" in *.example|*.disabled) continue ;; esac
    while IFS= read -r line; do
      case "$line" in
        YOUTUBE_*KEY=*|YOUTUBE_*TOKEN=*|YOUTUBE_*SECRET=*|ALERT_WEBHOOK_URL=*|HEARTBEAT_PING_URL=*|GOLIVE_AUTH_TOKEN=*)
          value=${line#*=} ;;
        *) continue ;;
      esac
      value=${value%\"}; value=${value#\"}
      value=${value%\'}; value=${value#\'}
      # Çok kısa değerler (boş ya da yer tutucu) maskelenmez: "s###" gibi bir kural
      # çıktının her yerini bozardı.
      [ ${#value} -ge 8 ] || continue
      # sed ayırıcısı # olduğu için değerdeki #, & ve \ kaçırılır.
      printf 's#%s#***MASKED***#g\n' "$(printf '%s' "$value" | sed -e 's#[\\&#]#\\&#g')"
    done < "$f"
  done
}

# Her çağrıda yeniden kurmak yerine bir kez: büyük çıktıları süzerken fark eder.
MASK_SED_SCRIPT="$(mask_build_sed_script)"

mask() {
  sed -E -f <(printf '%s\n' "$MASK_SED_SCRIPT")
}

# Fail-closed: maskenin gerçekten çalıştığını bilinen bir örnekle kanıtla. Çalışmıyorsa
# (sed -E -f desteği yok, process substitution kapalı) çağıran HİÇBİR ŞEY basmadan çıkar —
# maskesiz çıktı basmak, hiç çıktı basmamaktan kötüdür.
mask_require() {
  local probe
  probe="$(printf 'rtmps://a.rtmps.youtube.com/live2/abcd-efgh-ijkl-mnop-qrst\n' | mask 2>/dev/null || true)"
  case "$probe" in
    *MASKED*) return 0 ;;
    *)
      echo "HATA: key maskesi çalışmıyor — çıktı basılmadı (sed -E -f / process substitution yok?)" >&2
      return 1 ;;
  esac
}
