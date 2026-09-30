#!/usr/bin/env bash
# .env.example'ı sözleşme kabul eder ve verilen env dosyasını ona göre doğrular.
#
#   bash scripts/deploy/check-env.sh .env
#   bash scripts/deploy/check-env.sh .env.stream2
#
# Çıkış kodu: 0 = tüm key'ler var ve dolu, 1 = eksik/boş key var (ya da dosya yok).
#
# Neden ayrı script: aynı kontrol deploy.sh, install-service.sh ve elle çalıştırma
# için gerekiyor — üç yerde kopyalanırsa zamanla birbirinden ayrışır.
#
# Bu script key DEĞERLERİNİ asla yazdırmaz; yalnızca key İSİMLERİNİ ve dolu/boş
# durumunu raporlar (loglar ve CI çıktıları sır sızdırmasın).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EXAMPLE="$REPO_ROOT/.env.example"

TARGET_ARG="${1:-.env}"
# Mutlak yol verilmişse olduğu gibi, değilse repo köküne göre çöz.
case "$TARGET_ARG" in
  /*) TARGET="$TARGET_ARG" ;;
  *)  TARGET="$REPO_ROOT/$TARGET_ARG" ;;
esac
TARGET_LABEL="$(basename "$TARGET")"

if [ ! -f "$EXAMPLE" ]; then
  echo "HATA: $EXAMPLE yok — hangi key'lerin gerektiği bilinemiyor." >&2
  exit 1
fi

if [ ! -f "$TARGET" ]; then
  echo "HATA: $TARGET_LABEL yok." >&2
  echo "      Oluştur:  cp .env.example $TARGET_LABEL   (sonra key'leri doldur)" >&2
  exit 1
fi

# Bir env dosyasından key isimlerini çıkarır: yorum ve boş satırları atlar,
# 'export KEY=' biçimini de kabul eder, CRLF'e karşı \r kırpar.
env_keys() {
  sed -e 's/\r$//' "$1" \
    | grep -E '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' \
    | sed -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/' \
    | sort -u
}

# Key'in değeri dolu mu? Boş, sadece boşluk ya da boş quote ("" / '') ise boş sayılır.
key_filled() {
  local file="$1" key="$2" value
  value="$(sed -e 's/\r$//' "$file" \
    | grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" \
    | tail -n 1 \
    | sed -E "s/^[[:space:]]*(export[[:space:]]+)?${key}=//")"
  # Kenar boşluklarını ve sarmalayan quote'ları soy.
  value="$(printf '%s' "$value" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  value="$(printf '%s' "$value" | sed -E 's/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/')"
  value="$(printf '%s' "$value" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  [ -n "$value" ]
}

MISSING=""
EMPTY=""
while IFS= read -r key; do
  [ -n "$key" ] || continue
  if ! grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}=" <(sed -e 's/\r$//' "$TARGET"); then
    MISSING="$MISSING $key"
  elif ! key_filled "$TARGET" "$key"; then
    EMPTY="$EMPTY $key"
  fi
done < <(env_keys "$EXAMPLE")

# Fazla key'ler: hata değil (makineye özel ek ayar olabilir), sadece bilgi.
EXTRA="$(comm -13 <(env_keys "$EXAMPLE") <(env_keys "$TARGET") | tr '\n' ' ' | sed -E 's/[[:space:]]+$//')"
if [ -n "$EXTRA" ]; then
  echo "bilgi: $TARGET_LABEL içinde .env.example'da olmayan key(ler): $EXTRA"
  echo "       (sorun değil — ama kalıcıysa .env.example'a da ekle ki diğer makineler bilsin)"
fi

if [ -n "$MISSING" ] || [ -n "$EMPTY" ]; then
  echo "HATA: $TARGET_LABEL eksik yapılandırma:" >&2
  [ -n "$MISSING" ] && echo "  eksik key :$MISSING" >&2
  [ -n "$EMPTY" ]   && echo "  boş key   :$EMPTY" >&2
  echo "      Düzelt:  nano $TARGET_LABEL   (karşılaştırma kaynağı: .env.example)" >&2
  exit 1
fi

echo "ok: $TARGET_LABEL — .env.example'daki tüm key'ler var ve dolu"
