#!/usr/bin/env bash
# VPS'te Docker Engine + compose eklentisi + rsync kurulumu (Ubuntu / Debian).
# Yerelden çalıştırma:  ssh <kullanici>@<ip> 'bash -s' < deploy/install-docker.sh
# Tekrar çalıştırmak güvenli: kurulu olanları atlar.
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

. /etc/os-release
case "$ID" in
  ubuntu|debian) ;;
  *) echo "Desteklenmeyen dağıtım: $ID (sadece ubuntu/debian)"; exit 1 ;;
esac
echo "Dağıtım: $PRETTY_NAME"

$SUDO apt-get update
$SUDO apt-get install -y ca-certificates curl rsync

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "Docker zaten kurulu, kurulum atlanıyor."
else
  # Resmi Docker apt deposu (dağıtımın kendi docker.io paketi yerine; compose eklentisi bundan geliyor)
  $SUDO install -m 0755 -d /etc/apt/keyrings
  $SUDO curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  $SUDO chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID ${VERSION_CODENAME} stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update
  $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Açılışta başlasın — restart: unless-stopped ancak daemon ayaktaysa işe yarar
$SUDO systemctl enable --now docker

# root değilsek sudo'suz docker için gruba ekle (yeni SSH oturumunda geçerli olur)
if [ -n "$SUDO" ] && ! id -nG "$USER" | grep -qw docker; then
  $SUDO usermod -aG docker "$USER"
  echo "UYARI: $USER docker grubuna eklendi — sudo'suz docker için SSH'tan çıkıp tekrar bağlan."
fi

mkdir -p "$HOME/yt-stream-system"

echo "--- Doğrulama ---"
$SUDO docker version --format 'Docker Engine: {{.Server.Version}}'
$SUDO docker compose version
rsync --version | head -1
$SUDO docker run --rm hello-world >/dev/null && echo "hello-world: OK"
echo "Kaynaklar: $(nproc) vCPU, $(free -h | awk '/^Mem:/{print $2}') RAM, disk boş: $(df -h "$HOME" | awk 'NR==2{print $4}')"
