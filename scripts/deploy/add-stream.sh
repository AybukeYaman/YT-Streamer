#!/usr/bin/env bash
# Ek bir yayın (instance) kurar. Her yayın kendi config + env + runtime klasörünü kullanır,
# systemd template unit ile yönetilir:
#
#   sudo bash scripts/deploy/add-stream.sh stream2
#
# Idempotent: tekrar çalıştırmak güvenli. Stream key BOŞ ise servisi başlatmaz (sonsuz
# crash-loop olmasın) — key'i doldurduktan sonra aynı komutu tekrar çalıştır.
#
# ÖNEMLİ: Her yayın AYRI bir YouTube stream key'i gerektirir. Aynı key'e iki yayın
# gönderilemez (YouTube ikinciyi reddeder). Bu script key'i asla kopyalamaz/yazdırmaz.
set -euo pipefail

NAME="${1:-}"
if [ -z "$NAME" ] || ! printf '%s' "$NAME" | grep -Eq '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'; then
  echo "Kullanim: sudo bash scripts/deploy/add-stream.sh <isim>" >&2
  echo "  <isim>: harf/rakam/-/_ (ornek: stream2)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE_UNIT="/etc/systemd/system/yt-streamer@.service"
CONFIG_FILE="$REPO_ROOT/config.$NAME.json"
ENV_FILE="$REPO_ROOT/.env.$NAME"

if [ "$(id -u)" -ne 0 ]; then
  echo "HATA: root gerekli (sudo bash scripts/deploy/add-stream.sh $NAME)" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then echo "HATA: 'node' PATH'te yok." >&2; exit 1; fi

echo "== Yayin ekleniyor: $NAME =="
echo "repo: $REPO_ROOT"

# ── Kapasite uyarisi (CPU) ───────────────────────────────────────────────────
CORES="$(nproc 2>/dev/null || echo 0)"
RUNNING="$(systemctl list-units --type=service --state=running --no-legend 'yt-streamer*' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$CORES" -gt 0 ]; then
  echo "CPU: $CORES cekirdek | su an calisan yt-streamer servisi: $RUNNING"
  echo "Not: 720p24 yayin basina ~1.1 cekirdek. Guvenli tavan yaklasik $((CORES * 8 / 10 )) / 1.1 yayin."
  if [ "$RUNNING" -ge "$((CORES - 1))" ]; then
    echo "UYARI: kapasite sinirina yakinsin. Yayin kalitesi dusebilir (kare atlama)." >&2
    echo "        Cozum: paket yukselt, ya da config'te preset/cozunurluk dusur." >&2
  fi
fi

# ── config.<isim>.json ───────────────────────────────────────────────────────
if [ -f "$CONFIG_FILE" ]; then
  echo "config: $CONFIG_FILE (var, dokunulmadi)"
else
  BASE="$REPO_ROOT/config.json"
  [ -f "$BASE" ] || BASE="$REPO_ROOT/config.example.json"
  if [ ! -f "$BASE" ]; then echo "HATA: kaynak config bulunamadi." >&2; exit 1; fi
  # runtime klasoru MUTLAKA ayri olmali: playlist.txt / state.json / overlay cakismasin.
  # JS tirnakli heredoc'tan geliyor (<<'JS'), tek tirnakli shell string'den DEGIL: Turkce
  # yorumlardaki kesme isareti (instance + 'lar) tek tirnakli string'i ortasindan kapatiyor,
  # kalan kelimeler node'a arguman olarak gidiyordu -> readFileSync("ayni") / ENOENT. Kesilen
  # JS de gecerli kaldigi icin ne `bash -n` ne node syntax hatasi veriyordu. Tirnakli
  # heredoc'ta kesme isareti, $ ve backtick zararsiz. Ayrintı: KARARLAR.md
  "$NODE_BIN" -e "$(cat <<'JS'
    const fs=require("fs");
    const [src,dst,name]=process.argv.slice(1);
    const c=JSON.parse(fs.readFileSync(src,"utf8"));
    delete c._README;
    c.paths=c.paths||{};
    c.paths.runtime="./runtime/"+name;
    // localPath rtmp modunda kullanilmaz ama ileride local moda gecilirse
    // instance'lar ayni dosyaya yazmasin diye yine de instance'a ozel yapilir.
    if(c.output&&c.output.localPath!==undefined){c.output.localPath="./runtime/"+name+"/out.flv";}
    fs.writeFileSync(dst,JSON.stringify(c,null,2)+"\n");
JS
  )" "$BASE" "$CONFIG_FILE" "$NAME"
  echo "config olusturuldu: $CONFIG_FILE  (runtime -> ./runtime/$NAME)"
  echo "  Farkli muzik istiyorsan: bu dosyadaki paths.albums degerini degistir."
fi

# ── .env.<isim> (key BOS olusturulur — asla kopyalanmaz) ─────────────────────
if [ -f "$ENV_FILE" ]; then
  echo "env: $ENV_FILE (var, dokunulmadi)"
else
  printf 'YOUTUBE_STREAM_KEY=\n' > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "env olusturuldu: $ENV_FILE (bos key, izin 600)"
fi

# ── systemd template unit (tum ek yayinlar bunu paylasir) ────────────────────
cat > "$TEMPLATE_UNIT" <<EOF
[Unit]
Description=YT Streamer - %i
After=network-online.target
Wants=network-online.target

# NOT: Unit'te bilerek EnvironmentFile YOK. Uygulama .env.%i dosyasini kendisi okur
# (ExecStart'taki --env bayragi + src/config/load-config.js, util.parseEnv) ve yolu
# __dirname bazlı olduğu için WorkingDirectory'den bağımsızdır. systemd'nin EnvironmentFile quoting kuralları
# util.parseEnv'den farklı olduğundan iki okuma yolu eklemek sessiz tutarsızlık
# riski getirir, karşılığında hiçbir fayda sağlamaz. Ayrıntı: KARARLAR.md
[Service]
Type=simple
WorkingDirectory=$REPO_ROOT
ExecStart=$NODE_BIN $REPO_ROOT/index.js --config config.%i.json --env .env.%i
Restart=always
RestartSec=15
KillSignal=SIGINT
TimeoutStopSec=30
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
echo "template unit hazir: $TEMPLATE_UNIT"

# ── Key dolu mu? Bos ise baslatma (crash-loop olmasin) ──────────────────────
KEY_SET="$(grep -E '^YOUTUBE_STREAM_KEY=.+' "$ENV_FILE" >/dev/null 2>&1 && echo yes || echo no)"
if [ "$KEY_SET" != "yes" ]; then
  echo ""
  echo "=================== SIRADAKI ADIM ==================="
  echo "1) YouTube Studio -> Olustur -> Canli Yayina Gec -> YENI bir yayin/stream olustur"
  echo "   (mevcut yayinin key'ini KULLANMA - ayni key'e iki yayin gonderilemez)"
  echo "2) Yeni yayin anahtarini su dosyaya yaz:"
  echo "     nano $ENV_FILE"
  echo "     YOUTUBE_STREAM_KEY=xxxx-xxxx-xxxx-xxxx-xxxx"
  echo "3) Sonra bu komutu TEKRAR calistir:"
  echo "     sudo bash scripts/deploy/add-stream.sh $NAME"
  echo "====================================================="
  exit 0
fi

# ── Baslat / yeniden baslat ─────────────────────────────────────────────────
if systemctl is-enabled --quiet "yt-streamer@$NAME" 2>/dev/null; then
  systemctl restart "yt-streamer@$NAME"
else
  systemctl enable --now "yt-streamer@$NAME"
fi

sleep 3
echo ""
systemctl status "yt-streamer@$NAME" --no-pager -l || true
echo ""
echo "== tum yayinlar =="
systemctl list-units --type=service 'yt-streamer*' --no-pager || true
echo ""
echo "Loglar: journalctl -u yt-streamer@$NAME -f"
