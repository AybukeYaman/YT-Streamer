#!/usr/bin/env bash
# VPS'te kod güncellemesi: git pull -> env doğrulama -> npm ci -> servisleri restart.
#
#   bash deploy.sh              # normal deploy
#   bash deploy.sh --dry-run    # hiçbir şeyi DEĞİŞTİRMEZ: ne olacağını gösterir
#   bash deploy.sh --test       # deploy öncesi testleri de çalıştır
#
# Neden var: her deploy'da ".env'de key eksik mi?" diye elle bakma ihtiyacını
# kaldırır. .env.example sözleşmedir; eksik/boş key varsa deploy DURUR ve hangi
# key'in eksik olduğunu söyler (değerini değil).
#
# Çoklu yayın: ana yayın (.env + config.json + yt-streamer.service) ile birlikte
# her .env.<isim> için yt-streamer@<isim> de restart edilir. Bir instance'ın env'i
# eksikse yalnızca O instance atlanır — diğerleri güncellenmeye devam eder. Aksi
# halde tek eksik key tüm yayınları durdururdu.
#
# --dry-run: prod'da ilk tur için. Çalışan yayına, çalışma ağacına ve node_modules'a
# DOKUNMAZ — merge etmeden neyin geleceğini, env'lerin durumunu, lock dosyasının
# tutarlılığını ve hangi servislerin restart edileceğini gösterir. Yayın kesintisi
# riski taşımadığı için istediğin kadar çalıştırabilirsin.
#
# Idempotent: tekrar çalıştırmak güvenli.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
REPO_ROOT="$SCRIPT_DIR"
CHECK_ENV="$REPO_ROOT/scripts/deploy/check-env.sh"
MAIN_SERVICE="yt-streamer"

RUN_TESTS=no
DRY_RUN=no
for arg in "$@"; do
  case "$arg" in
    --test) RUN_TESTS=yes ;;
    --dry-run|-n) DRY_RUN=yes ;;
    # Yorum blogunu yardim metni olarak bas: ilk yorum-olmayan satirda dur.
    -h|--help) awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/,""); print}' "$0"; exit 0 ;;
    *) echo "HATA: bilinmeyen argüman: $arg (bkz. --help)" >&2; exit 1 ;;
  esac
done

if [ "$DRY_RUN" = "yes" ] && [ "$RUN_TESTS" = "yes" ]; then
  # --test tam npm ci gerektirir (node_modules'ı değiştirir), bu dry-run sözüyle çelişir.
  echo "HATA: --dry-run ile --test birlikte kullanılamaz." >&2
  echo "      Testler devDependencies kurulumu gerektirir, bu da node_modules'ı değiştirir." >&2
  exit 1
fi

# git/npm mevcut kullanıcı olarak çalışır (root'la pull "dubious ownership" verebilir);
# yalnızca restart root gerektirir. systemctl SORGULARI (cat/is-enabled/is-active/
# list-units) yetki istemez — sudo'suz çağrılır ki --dry-run parola sormasın.
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

echo "== YT Streamer deploy =="
echo "repo: $REPO_ROOT"
if [ "$DRY_RUN" = "yes" ]; then
  echo ""
  echo "*** DRY RUN — hiçbir şey değiştirilmeyecek (pull yok, npm yok, restart yok) ***"
fi

[ -f "$CHECK_ENV" ] || { echo "HATA: $CHECK_ENV yok." >&2; exit 1; }

# Dry-run'da erken çıkmak yerine tüm sorunlar toplanır: tek tur bütün tabloyu göstersin.
PROBLEMS=""

# ── 1) Kod güncelle ─────────────────────────────────────────────────────────
echo ""
if [ "$DRY_RUN" = "yes" ]; then
  # fetch uzak referansları günceller ama çalışma ağacına dokunmaz — merge YOK.
  echo "== git fetch (merge YOK) =="
  git fetch
  echo "mevcut HEAD : $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
  UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo '')"
  if [ -z "$UPSTREAM" ]; then
    echo "UYARI: bu dal bir upstream'e bağlı değil — git pull çalışmaz."
    PROBLEMS="$PROBLEMS upstream-yok"
  else
    INCOMING="$(git log --oneline "HEAD..$UPSTREAM")"
    if [ -z "$INCOMING" ]; then
      echo "gelecek commit yok — VPS güncel ($UPSTREAM ile aynı)."
    else
      echo ""
      echo "PULL ŞU COMMIT'LERİ GETİRECEK ($UPSTREAM):"
      printf '%s\n' "$INCOMING" | sed 's/^/  /'
      echo ""
      echo "Değişecek dosyalar:"
      git diff --stat "HEAD..$UPSTREAM" | sed 's/^/  /'
    fi
    # İleri sarma mümkün mü? Değilse gerçek deploy --ff-only ile duracak.
    if [ -n "$(git log --oneline "$UPSTREAM..HEAD")" ]; then
      echo ""
      echo "UYARI: HEAD upstream'de olmayan commit içeriyor — git pull --ff-only HATA verecek."
      echo "       (VPS'te elle commit yapılmış olabilir; gerçek deploy'dan önce çöz.)"
      PROBLEMS="$PROBLEMS ff-only-mumkun-degil"
    fi
  fi
  # Kirli çalışma ağacı pull'u engeller — dry-run bunu şimdi söylemeli.
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo ""
    echo "UYARI: çalışma ağacında commit edilmemiş değişiklik var — pull başarısız olabilir:"
    git status --short --untracked-files=no | sed 's/^/  /'
    PROBLEMS="$PROBLEMS kirli-calisma-agaci"
  fi
else
  # --ff-only: beklenmeyen merge commit'i yerine açık hata ver (VPS'te elle
  # değişiklik yapılmışsa bunu sessizce merge etmek yerine görmek isteriz).
  echo "== git pull =="
  git pull --ff-only
fi

# ── 2) Env doğrulama (ana yayın — gerçek deploy'da eksik key DURDURUR) ──────
echo ""
echo "== env doğrulama: .env =="
if ! bash "$CHECK_ENV" .env; then
  if [ "$DRY_RUN" = "yes" ]; then
    echo "^ GERÇEK DEPLOY BURADA DURURDU (ana yayının .env'i eksik)."
    PROBLEMS="$PROBLEMS .env"
  else
    echo "" >&2
    echo "DEPLOY DURDURULDU: ana yayının .env'i eksik. Yukarıdaki key'leri doldurup tekrar çalıştır." >&2
    exit 1
  fi
fi

# ── 3) Bağımlılıklar ────────────────────────────────────────────────────────
# npm ci: package-lock.json'a birebir uyar (npm install gibi lock'u güncellemez).
echo ""
if [ "$DRY_RUN" = "yes" ]; then
  # npm'in kendi --dry-run'ı: package.json ile lock tutarsızsa yine hata verir
  # (asıl npm ci hata sebebi bu) ama node_modules'a tek bayt yazmaz.
  echo "== npm ci --omit=dev --dry-run (node_modules'a yazmaz) =="
  if ! npm ci --omit=dev --dry-run; then
    echo "^ GERÇEK DEPLOY BURADA DURURDU (npm ci başarısız — lock/package.json tutarsız?)."
    PROBLEMS="$PROBLEMS npm-ci"
  fi
elif [ "$RUN_TESTS" = "yes" ]; then
  # Testler devDependencies'e (ink-testing-library) ihtiyaç duyar, bu yüzden önce
  # tam kurulum yapılır; testler geçtikten sonra dev paketleri buradan atılır.
  echo "== npm ci (dev dahil — testler için) =="
  npm ci
  echo ""
  echo "== npm test =="
  npm test
  echo ""
  echo "== npm prune --omit=dev =="
  npm prune --omit=dev
else
  echo "== npm ci --omit=dev =="
  npm ci --omit=dev
fi

# ── Yardımcı: bir servisi restart et ve gerçekten ayakta mı doğrula ─────────
FAILED=""
WOULD_RESTART=""
restart_service() {
  local unit="$1"
  if [ "$DRY_RUN" = "yes" ]; then
    echo "DRY RUN — restart EDİLMEDİ: $unit (şu an: $(systemctl is-active "$unit" 2>/dev/null || echo bilinmiyor))"
    WOULD_RESTART="$WOULD_RESTART $unit"
    return 0
  fi
  echo ""
  echo "== restart: $unit =="
  if ! $SUDO systemctl restart "$unit"; then
    echo "HATA: $unit restart edilemedi." >&2
    FAILED="$FAILED $unit"
    return 0
  fi
  # Restart'tan hemen sonra "active" görünüp saniyeler içinde crash eden bir
  # süreci yakalamak için kısa bekleme — sessiz başarı raporu vermeyelim.
  sleep 5
  if systemctl is-active --quiet "$unit"; then
    echo "ok: $unit çalışıyor"
  else
    echo "HATA: $unit restart sonrası ayakta değil. Son loglar:" >&2
    $SUDO journalctl -u "$unit" -n 20 --no-pager >&2 || true
    FAILED="$FAILED $unit"
  fi
}

# ── 4) Ana yayın ────────────────────────────────────────────────────────────
# systemctl cat: unit yoksa non-zero döner (list-unit-files bir kalıpla 0 dönebilir).
echo ""
if systemctl cat "$MAIN_SERVICE.service" >/dev/null 2>&1; then
  restart_service "$MAIN_SERVICE.service"
else
  echo "UYARI: $MAIN_SERVICE.service kurulu değil — atlandı."
  echo "       Kurulum:  sudo bash scripts/deploy/install-service.sh"
fi

# ── 5) Ek yayınlar (.env.<isim> -> yt-streamer@<isim>) ──────────────────────
# Her instance'ın env'i ayrı doğrulanır; eksikse SADECE o instance atlanır.
SKIPPED=""
shopt -s nullglob
for env_file in "$REPO_ROOT"/.env.*; do
  base="$(basename "$env_file")"
  name="${base#.env.}"
  # .env.example sözleşme dosyası, bir instance değil.
  [ "$name" = "example" ] && continue
  unit="yt-streamer@$name.service"

  # Kurulu olmayan (add-stream.sh ile hiç enable edilmemiş) instance'ı restart etmeye
  # çalışmak anlamsız — env dosyası elde kalmış olabilir.
  if ! systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    echo ""
    echo "bilgi: $name — $unit enable değil, atlandı (kurulum: sudo bash scripts/deploy/add-stream.sh $name)"
    continue
  fi

  echo ""
  echo "== env doğrulama: $base =="
  if ! bash "$CHECK_ENV" "$base"; then
    echo "ATLANDI: $name instance'ı güncellenmedi (env eksik) — diğerlerine devam ediliyor." >&2
    SKIPPED="$SKIPPED $name"
    continue
  fi
  restart_service "$unit"
done
shopt -u nullglob

# ── 6) Özet ─────────────────────────────────────────────────────────────────
echo ""
echo "=================== ÖZET ==================="
echo "commit: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
systemctl list-units --type=service "yt-streamer*" --no-pager 2>/dev/null || true

if [ -n "$SKIPPED" ]; then
  echo ""
  echo "ENV EKSİK OLDUĞU İÇİN ATLANAN YAYIN(LAR):$SKIPPED"
  echo "  Düzelt:  nano .env.<isim>   sonra:  bash deploy.sh"
fi

if [ "$DRY_RUN" = "yes" ]; then
  echo ""
  echo "*** DRY RUN — hiçbir şey değiştirilmedi ***"
  if [ -n "$WOULD_RESTART" ]; then
    echo "Gerçek deploy şunları restart ederdi:$WOULD_RESTART"
  else
    echo "Restart edilecek servis yok (hiçbiri kurulu/enable değil)."
  fi
  if [ -n "$PROBLEMS" ]; then
    echo ""
    echo "GERÇEK DEPLOY'U ENGELLEYECEK SORUN(LAR):$PROBLEMS" >&2
    echo "Yukarıdaki uyarıları çözmeden 'bash deploy.sh' çalıştırma." >&2
    exit 1
  fi
  echo ""
  echo "Engelleyici sorun yok. Hazır olduğunda:  bash deploy.sh"
  if [ -n "$SKIPPED" ]; then exit 1; fi
  exit 0
fi

if [ -n "$FAILED" ]; then
  echo ""
  echo "BAŞARISIZ SERVİS(LER):$FAILED" >&2
  exit 1
fi
if [ -n "$SKIPPED" ]; then
  exit 1
fi
echo ""
echo "Deploy tamam. Loglar: journalctl -u $MAIN_SERVICE -f"
