// config.json + .env'i okur, doğrular ve yolları proje köküne göre mutlak hale getirir.
// Eksik/geçersiz alan varsa tüm sorunları tek bir hata mesajında listeleyip düşer —
// sessizce varsayılan değerle devam etmez.
const fs = require('fs');
const path = require('path');
const { parseEnv } = require('util');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_MODES = ['local', 'rtmp'];
const PRIVACY_STATUSES = ['public', 'unlisted', 'private'];

// broadcast bölümü OPSİYONEL: yalnızca go-live otomasyonu (Faz 9 Aşama 2) kullanıyor,
// yayın süreci hiç okumuyor. Zorunlu yapmak, VPS'teki mevcut config.json'lar (bu bölüm
// onlarda yok) yüzünden ÇALIŞAN YAYINI config hatasıyla düşürürdü. Bölüm yoksa
// varsayılanlar geçerli; verilen alanlar doğrulanır.
//
// privacyStatus varsayılanı "unlisted": ilk otomatik broadcast kanalda beklenmedik
// şekilde herkese açık çıkmasın (KARARLAR.md). Güven kazandıktan sonra elle "public".
const BROADCAST_DEFAULTS = Object.freeze({
  title: '24/7 Cozy Lofi Radio ☕ Chill Beats to Study / Work / Sleep to...',
  description: '',
  privacyStatus: 'unlisted',
  latencyPreference: 'normal',
  categoryId: '10', // Music
  // Boşsa stream id .env'deki YOUTUBE_STREAM_KEY'den çözülür (cdn.ingestionInfo.streamName
  // karşılaştırması) — sabit id yazmak çoklu yayında yanlış stream'e bind riski taşır.
  streamId: null,
  // Yeni broadcast'e yüklenecek sabit küçük resim. Dosya repo'ya GİRMEZ (assets/ yok
  // sayılı), VPS'te elle konur; yoksa sessizce atlanır. null: küçük resim hiç denenmez.
  // Sabit path yerine config alanı: çoklu yayında her kanal kendi resmini kullanabilir.
  thumbnailPath: './assets/thumbnail.jpg',
});

class ConfigError extends Error {
  constructor(file, problems) {
    super(`Geçersiz yapılandırma (${file}):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(file, [`dosya okunamadı: ${err.code || err.message}`]);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigError(file, [`geçerli JSON değil: ${err.message}`]);
  }
}

// .env yoksa boş döner — anahtar sadece rtmp modunda zorunlu, o kontrol aşağıda.
function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isBoolean = (v) => typeof v === 'boolean';

function requireFields(obj, section, spec, problems) {
  if (obj === null || typeof obj !== 'object') {
    problems.push(`"${section}" bölümü eksik`);
    return;
  }
  for (const [key, check] of Object.entries(spec)) {
    if (!check(obj[key])) problems.push(`"${section}.${key}" eksik ya da geçersiz`);
  }
}

function loadConfig({
  rootDir = PROJECT_ROOT,
  configFile = 'config.json',
  envFile = '.env',
  env = process.env,
} = {}) {
  const configPath = path.resolve(rootDir, configFile);
  const raw = readJson(configPath);
  const fileEnv = readEnvFile(path.resolve(rootDir, envFile));
  const problems = [];

  // paths.albums varsa albüm düzeni (Faz 8: music-source/<albüm>/...); yoksa eski tek
  // music/ + background düzeni — ikisinden biri zorunlu.
  const albumMode = raw.paths && raw.paths.albums !== undefined;
  requireFields(raw.paths, 'paths', albumMode
    ? { albums: isNonEmptyString, runtime: isNonEmptyString }
    : { music: isNonEmptyString, background: isNonEmptyString, runtime: isNonEmptyString }, problems);

  // Değer aralığı kontrolü (örn. fps > 0) StreamProfile'ın işi; burada sadece varlık/tip.
  requireFields(raw.profile, 'profile', {
    width: isNumber,
    height: isNumber,
    fps: isNumber,
    videoBitrate: isNonEmptyString,
    audioBitrate: isNonEmptyString,
    preset: isNonEmptyString,
  }, problems);

  // Değer kontrolü (geçerli mod, batchSize ≥ 1) Queue ve PlaylistWriter'ın işi.
  requireFields(raw.queue, 'queue', {
    mode: isNonEmptyString,
    batchSize: isNumber,
  }, problems);

  // position değer kontrolü (desteklenen konumlar) drawtext'i kuran encoder'ın işi.
  requireFields(raw.overlay, 'overlay', {
    enabled: isBoolean,
    fontFile: isNonEmptyString,
    fontSize: isNumber,
    position: isNonEmptyString,
  }, problems);

  const output = raw.output || {};
  let streamKey;
  if (!OUTPUT_MODES.includes(output.mode)) {
    problems.push(`"output.mode" "${output.mode}" — ${OUTPUT_MODES.map((m) => `"${m}"`).join(' ya da ')} olmalı`);
  } else if (output.mode === 'local' && !isNonEmptyString(output.localPath)) {
    problems.push('"output.localPath" eksik — "local" modunda zorunlu');
  } else if (output.mode === 'rtmp') {
    // Gerçek ortam değişkeni .env dosyasındakini ezer.
    streamKey = env.YOUTUBE_STREAM_KEY || fileEnv.YOUTUBE_STREAM_KEY;
    if (!isNonEmptyString(streamKey)) {
      problems.push('YOUTUBE_STREAM_KEY boş — "rtmp" modunda .env dosyasında (ya da ortam değişkeninde) zorunlu');
    }
  }

  // Opsiyonel broadcast bölümü: verilen alanların tipi/değeri doğrulanır, eksikler
  // varsayılandan gelir. Yanlış privacyStatus sessizce "private" yayına yol açmasın.
  const rawBroadcast = raw.broadcast === undefined ? {} : raw.broadcast;
  if (rawBroadcast === null || typeof rawBroadcast !== 'object') {
    problems.push('"broadcast" bölümü nesne olmalı (ya da hiç verilmemeli)');
  } else {
    for (const key of ['title', 'description', 'latencyPreference', 'categoryId']) {
      if (rawBroadcast[key] !== undefined && typeof rawBroadcast[key] !== 'string') {
        problems.push(`"broadcast.${key}" metin olmalı`);
      }
    }
    if (rawBroadcast.title !== undefined && !isNonEmptyString(rawBroadcast.title)) {
      problems.push('"broadcast.title" boş olamaz');
    }
    if (rawBroadcast.privacyStatus !== undefined && !PRIVACY_STATUSES.includes(rawBroadcast.privacyStatus)) {
      problems.push(`"broadcast.privacyStatus" "${rawBroadcast.privacyStatus}" — ${PRIVACY_STATUSES.map((s) => `"${s}"`).join(', ')} olmalı`);
    }
    if (rawBroadcast.streamId !== undefined && rawBroadcast.streamId !== null
        && !isNonEmptyString(rawBroadcast.streamId)) {
      problems.push('"broadcast.streamId" metin ya da null olmalı (null: key\'den çözülür)');
    }
    if (rawBroadcast.thumbnailPath !== undefined && rawBroadcast.thumbnailPath !== null
        && !isNonEmptyString(rawBroadcast.thumbnailPath)) {
      problems.push('"broadcast.thumbnailPath" metin ya da null olmalı (null: küçük resim yüklenmez)');
    }
  }

  if (problems.length) throw new ConfigError(configPath, problems);

  const abs = (p) => path.resolve(rootDir, p);
  return {
    paths: albumMode
      ? { albums: abs(raw.paths.albums), runtime: abs(raw.paths.runtime) }
      : { music: abs(raw.paths.music), background: abs(raw.paths.background), runtime: abs(raw.paths.runtime) },
    profile: { ...raw.profile },
    queue: { mode: raw.queue.mode, batchSize: raw.queue.batchSize },
    // fontFile mutlak bir sistem yolu (C:/Windows/Fonts/...) — kök dizine göre çözülmez.
    overlay: { ...raw.overlay },
    output: output.mode === 'local'
      ? { mode: 'local', localPath: abs(output.localPath) }
      : { mode: 'rtmp', streamKey: streamKey.trim() },
    broadcast: (() => {
      const merged = { ...BROADCAST_DEFAULTS, ...rawBroadcast };
      // Küçük resim yolu kök dizine göre çözülür: servis cwd'den bağımsız çalışıyor
      // (systemd unit'te WorkingDirectory'ye güvenmek kırılgan).
      return { ...merged, thumbnailPath: merged.thumbnailPath ? abs(merged.thumbnailPath) : null };
    })(),
  };
}

module.exports = { loadConfig, ConfigError, BROADCAST_DEFAULTS };
