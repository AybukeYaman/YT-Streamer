// config.json + .env'i okur, doğrular ve yolları proje köküne göre mutlak hale getirir.
// Eksik/geçersiz alan varsa tüm sorunları tek bir hata mesajında listeleyip düşer —
// sessizce varsayılan değerle devam etmez.
const fs = require('fs');
const path = require('path');
const { parseEnv } = require('util');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_MODES = ['local', 'rtmp'];

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
  };
}

module.exports = { loadConfig, ConfigError };
