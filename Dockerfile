# Node + ffmpeg. music/, assets/, runtime/ imaja gömülmez — docker-compose.yml'de volume.
# Bağımlılık yok (package.json'da dependencies boş): npm install adımı gerekmiyor.
FROM node:22-bookworm-slim

# fonts-dejavu-core: overlay (drawtext) için font — config.docker.json'daki fontFile buna bakıyor
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json index.js ./
COPY src ./src
# Container'da Windows yolları geçersiz: Linux profili config.json adıyla (loadConfig varsayılanı)
COPY config.docker.json ./config.json

# runtime/ yazılabilir olmalı; music/ ve assets/ salt okunur bağlanıyor
RUN mkdir -p music assets runtime && chown node:node runtime
USER node

# npm start değil: npm sinyalleri alt sürece güvenilir iletmiyor. PID 1 = tini (compose'ta init: true)
CMD ["node", "index.js"]
