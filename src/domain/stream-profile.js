// Encode parametrelerini tutan saf domain nesnesi. I/O yok, Node modülü import etmez.
// ffmpeg argümanlarına çevirmek infrastructure'ın (FfmpegEncoder) işi.

const X264_PRESETS = [
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast',
  'medium', 'slow', 'slower', 'veryslow', 'placebo',
];

// YouTube'un önerdiği 2 saniyelik keyframe aralığı.
const KEYFRAME_INTERVAL_SECONDS = 2;

class StreamProfileError extends Error {
  constructor(problems) {
    super(`Geçersiz stream profili:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'StreamProfileError';
    this.problems = problems;
  }
}

// "2500k" → 2500, "2.5M" → 2500. Tanınmayan biçimde null.
function parseKbps(value) {
  const m = typeof value === 'string' && value.trim().match(/^(\d+(?:\.\d+)?)([kKmM])$/);
  if (!m) return null;
  const kbps = Number(m[1]) * (m[2].toLowerCase() === 'm' ? 1000 : 1);
  return kbps > 0 ? kbps : null;
}

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

class StreamProfile {
  constructor({ width, height, fps, videoBitrate, audioBitrate, preset }) {
    const problems = [];
    // yuv420p'de kroma yarım çözünürlükte tutulur; libx264 tek sayılı boyutu reddeder.
    for (const [name, v] of [['width', width], ['height', height]]) {
      if (!isPositiveInt(v)) problems.push(`${name} pozitif tam sayı olmalı (${v})`);
      else if (v % 2 !== 0) problems.push(`${name} çift sayı olmalı — yuv420p gereği (${v})`);
    }
    // GOP = fps × 2 kare; tam sayı çıkması için fps tam sayı olmalı.
    if (!isPositiveInt(fps)) problems.push(`fps pozitif tam sayı olmalı (${fps})`);
    const videoKbps = parseKbps(videoBitrate);
    if (videoKbps === null) problems.push(`videoBitrate "2500k" ya da "2.5M" biçiminde olmalı (${videoBitrate})`);
    if (parseKbps(audioBitrate) === null) problems.push(`audioBitrate "160k" biçiminde olmalı (${audioBitrate})`);
    if (!X264_PRESETS.includes(preset)) problems.push(`preset geçerli bir x264 preset'i değil (${preset})`);
    if (problems.length) throw new StreamProfileError(problems);

    this.width = width;
    this.height = height;
    this.fps = fps;
    this.preset = preset;
    this.videoBitrate = videoBitrate;
    this.audioBitrate = audioBitrate;

    // Türetilen değerler — config'den gelmez, kurallardan hesaplanır.
    this.gopSize = fps * KEYFRAME_INTERVAL_SECONDS;
    this.maxRate = videoBitrate; // maxrate = b:v
    this.bufferSize = `${videoKbps * 2}k`; // bufsize = 2 × b:v

    // Faz 1'de doğrulanmış sabitler.
    this.videoCodec = 'libx264';
    this.h264Profile = 'main';
    this.pixelFormat = 'yuv420p';
    this.audioCodec = 'aac';
    this.audioSampleRate = 48000;
    this.audioChannels = 2;

    Object.freeze(this);
  }
}

module.exports = { StreamProfile, StreamProfileError };
