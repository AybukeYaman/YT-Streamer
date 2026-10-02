#!/usr/bin/env bash
# Bir yayın instance'ına deploy'da DOKUNULMALI MI? Kararı veren tek yer.
#
# Neden ayrı dosya: karar deploy.sh'ın orkestrasyonundan ayrılınca test edilebilir oluyor
# (test/scripts/instance-state.test.js sahte systemctl verir). deploy.sh'ın kendisi
# git pull / npm ci yaptığı için uçtan uca test edilemez.
#
# Kullanım:
#   source scripts/deploy/lib/instance-state.sh
#   case "$(instance_action yt-streamer@stream2.service /repo/.env.stream2.disabled)" in
#     restart) ... ;;
#     skip:*)  echo "atlandı: ${karar#skip:}" ;;
#   esac
#
# systemctl SORGUSU yetki istemez (--dry-run parola sormasın); enjekte edilebilir.

# shellcheck disable=SC2034
INSTANCE_SYSTEMCTL="${INSTANCE_SYSTEMCTL:-systemctl}"

# Deploy'un restart edeceği TEK durum kümesi. `systemctl is-enabled --quiet` kullanmak
# HATA olurdu: o komut 'static', 'indirect', 'generated', 'transient' durumlarında da
# 0 (başarı) döner. Böyle bir unit "enable edilmiş" sayılıp restart edilir — yani
# kullanıcının bilerek kapattığı bir yayın deploy'da geri açılabilir. Beyaz liste bu
# sınıf hatayı tümden kapatır: tanımadığımız durumda DOKUNMUYORUZ.
INSTANCE_RESTARTABLE_STATES="enabled enabled-runtime"

instance_unit_file_state() {
  $INSTANCE_SYSTEMCTL show -p UnitFileState --value "$1" 2>/dev/null || true
}

# instance_action <unit> [marker_file]
#   restart              → güncellenecek
#   skip:parked          → işaret dosyası var: bilerek park edilmiş, systemd ne derse desin
#   skip:state=<durum>   → unit durumu beyaz listede değil (disabled, static, masked, …)
instance_action() {
  local unit="$1" marker="${2:-}"

  # İşaret dosyası systemd durumunu EZER. Niyet repoda kayıtlı olduğu için
  # `systemctl enable` ya da add-stream.sh'ın tekrar çalıştırılması gibi kazalar
  # bu kararı sessizce bozamaz — 1 Ekim'de olan tam buydu.
  if [ -n "$marker" ] && [ -e "$marker" ]; then
    echo "skip:parked"
    return 0
  fi

  local state
  state="$(instance_unit_file_state "$unit")"
  [ -n "$state" ] || state="yok"
  case " $INSTANCE_RESTARTABLE_STATES " in
    *" $state "*) echo "restart" ;;
    *) echo "skip:state=$state" ;;
  esac
}
