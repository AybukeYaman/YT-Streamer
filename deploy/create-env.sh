#!/usr/bin/env bash
# VPS'te .env dosyasını oluşturur. KULLANICI kendi terminalinde çalıştırır
# (Claude Code değil) — stream key sadece burada, gizli girişle yazılır:
# ekrana basılmaz, shell geçmişine girmez, sohbete/loglara düşmez.
# Kullanım:  bash deploy/create-env.sh <kullanici>@<ip>
set -euo pipefail

VPS="${1:?Kullanım: bash deploy/create-env.sh <kullanici>@<ip>}"

# -t: uzak tarafta gizli giriş için terminal gerekiyor
# umask 077: dosya en baştan 600 izinle oluşur, bir an bile herkese açık kalmaz
ssh -t "$VPS" '
  set -e
  mkdir -p yt-stream-system && cd yt-stream-system
  if [ -e .env ]; then
    printf ".env zaten var, üzerine yazılsın mı? [e/H] "; read -r ans
    [ "$ans" = "e" ] || { echo "Vazgeçildi."; exit 0; }
  fi
  read -rsp "YouTube stream key (görünmez): " key; echo
  [ -n "$key" ] || { echo "Boş key, vazgeçildi."; exit 1; }
  umask 077
  printf "YOUTUBE_STREAM_KEY=%s\n" "$key" > .env
  unset key
  echo ".env yazıldı: $(stat -c "%a izin, %s bayt" .env)"
'
