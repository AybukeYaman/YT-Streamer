// Faz 5.1 — Hazır döngü (loop.mp4) şartnamesi: komut kurucu, ffprobe doğrulayıcı, bayatlık kuralı.
// Saf işlevler (fs/child_process yok) — scripts/prepare-loops.js kullanır, testler doğrudan çağırır.
// Şartname Faz 5.2'deki `-c:v copy` yolunun dayanağıdır: kapalı GOP, B-kare yok, GOP = 2 sn,
// süre 2 sn katı; böylece döngü dikişi anahtar kareye denk gelir ve zaman damgaları monoton kalır.

const SPEC = {
  width: 1280,
  height: 720,
  fps: 24,
  gopSeconds: 2,
  codec: 'h264',
  profile: 'Main',
  pixFmt: 'yuv420p',
  bitrate: '3500k',
  bufsize: '7000k',
  preset: 'slow',
  imageLoopSeconds: 10,
  maxSeconds: 60,
  keyTolerance: 0.02,
  seamSsimWarn: 0.9,
};
SPEC.gopFrames = SPEC.gopSeconds * SPEC.fps;

// Kaynağı tek biçime getirir (prepare-backgrounds ile aynı kırpma kuralı: ölçekle, ortadan kırp).
function filterChain() {
  const { width, height, fps } = SPEC;
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=increase:out_range=tv`,
    `crop=${width}:${height}`,
    'setsar=1',
    `fps=${fps}`,
    'format=yuv420p',
  ].join(',');
}

// Süre 2 sn'nin katına aşağı yuvarlanır (video); görsel sabit imageLoopSeconds'tır.
function loopSeconds({ kind, duration }) {
  if (kind === 'image') return SPEC.imageLoopSeconds;
  const whole = Math.floor((duration + 1e-6) / SPEC.gopSeconds) * SPEC.gopSeconds;
  return Math.min(whole, SPEC.maxSeconds);
}

function buildLoopArgs({ input, output, kind, seconds }) {
  const src = kind === 'image'
    ? ['-loop', '1', '-framerate', String(SPEC.fps), '-t', String(seconds), '-i', input]
    : ['-i', input];
  return [
    '-hide_banner', '-nostats', '-y', ...src,
    '-map', '0:v:0', '-an',
    '-vf', filterChain(),
    '-t', String(seconds),
    '-color_range', 'tv',
    '-c:v', 'libx264', '-preset', SPEC.preset, '-profile:v', 'main', '-pix_fmt', SPEC.pixFmt,
    '-g', String(SPEC.gopFrames), '-keyint_min', String(SPEC.gopFrames), '-sc_threshold', '0',
    '-bf', '0', '-x264-params', 'open-gop=0',
    '-b:v', SPEC.bitrate, '-maxrate', SPEC.bitrate, '-bufsize', SPEC.bufsize,
    '-movflags', '+faststart',
    '-f', 'mp4', output,
  ];
}

// ffprobe: akış bilgisi (-show_streams) + paketler (-show_entries packet=pts_time,flags).
const PROBE_ARGS = (file) => [
  '-v', 'error', '-show_streams', '-show_entries',
  'stream=codec_type,codec_name,profile,width,height,r_frame_rate,pix_fmt,has_b_frames:format=duration:packet=stream_index,pts_time,flags',
  '-of', 'json', file,
];

function parseFps(text) {
  const [n, d] = String(text || '').split('/').map(Number);
  return d ? n / d : Number(n) || 0;
}

// ffprobe JSON → doğrulayıcının beklediği düz nesne.
function summarizeProbe(json) {
  const streams = json.streams || [];
  const video = streams.find((s) => s.codec_type === 'video') || null;
  const keyTimes = (json.packets || [])
    .filter((p) => String(p.flags || '').includes('K'))
    .map((p) => Number(p.pts_time))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    codec: video && video.codec_name,
    profile: video && video.profile,
    width: video && video.width,
    height: video && video.height,
    fps: video ? parseFps(video.r_frame_rate) : 0,
    pixFmt: video && video.pix_fmt,
    bFrames: video ? Number(video.has_b_frames) || 0 : 0,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    duration: Number(json.format && json.format.duration) || 0,
    keyTimes,
  };
}

// Şartnameye uymayan her şey için gerekçe listesi döner (boş = uygun).
function validateLoop(p) {
  const bad = [];
  if (!p || !p.codec) return ['video akışı okunamadı'];
  if (p.codec !== SPEC.codec) bad.push(`codec ${p.codec} (beklenen ${SPEC.codec})`);
  if (p.profile !== SPEC.profile) bad.push(`profil ${p.profile} (beklenen ${SPEC.profile})`);
  if (p.width !== SPEC.width || p.height !== SPEC.height) bad.push(`çözünürlük ${p.width}x${p.height} (beklenen ${SPEC.width}x${SPEC.height})`);
  if (Math.abs(p.fps - SPEC.fps) > 0.001) bad.push(`fps ${p.fps} (beklenen ${SPEC.fps})`);
  if (p.pixFmt !== SPEC.pixFmt) bad.push(`piksel biçimi ${p.pixFmt} (beklenen ${SPEC.pixFmt})`);
  if (p.hasAudio) bad.push('ses akışı var (olmamalı)');
  if (p.bFrames > 0) bad.push('B-kare var (olmamalı)');

  const rem = p.duration % SPEC.gopSeconds;
  const off = Math.min(rem, SPEC.gopSeconds - rem);
  if (p.duration < SPEC.gopSeconds || off > 0.05) bad.push(`süre ${p.duration.toFixed(2)} sn, ${SPEC.gopSeconds} sn katı değil`);

  const keys = p.keyTimes || [];
  if (!keys.length || Math.abs(keys[0]) > 0.001) {
    bad.push('ilk kare anahtar kare değil');
  } else {
    // Son anahtar kareden süre sonuna kalan da bir aralıktır (döngü dikişi).
    const edges = [...keys, p.duration];
    for (let i = 1; i < edges.length; i++) {
      const gap = edges[i] - edges[i - 1];
      if (Math.abs(gap - SPEC.gopSeconds) > SPEC.keyTolerance) {
        bad.push(`anahtar kare aralığı ${gap.toFixed(3)} sn (beklenen ${SPEC.gopSeconds})`);
        break;
      }
    }
  }
  return bad;
}

// Çıktı kaynaktan yeni mi? (mtime tabanlı; --force yoksa yeni olan atlanır, eskiyen bayat sayılır.)
function isUpToDate(outMtimeMs, inputMtimesMs) {
  if (outMtimeMs == null) return false;
  return inputMtimesMs.every((t) => outMtimeMs > t);
}

// ffmpeg ssim çıktısından ("... All:0.983 (17.7)") ortalamayı çıkarır.
function parseSsim(stderr) {
  const m = /All:([0-9.]+)/.exec(stderr || '');
  return m ? Number(m[1]) : null;
}

// Dikişte son kare → ilk kare: bitişik kareler arası beklenen benzerlikle karşılaştırılır.
const SEAM_ARGS = (file) => [
  '-hide_banner', '-nostats', '-sseof', String(-(1.5 / SPEC.fps)), '-i', file, '-i', file,
  '-frames:v', '1', '-lavfi', 'ssim', '-f', 'null', '-',
];

module.exports = {
  SPEC, filterChain, loopSeconds, buildLoopArgs, PROBE_ARGS, summarizeProbe,
  validateLoop, isUpToDate, parseSsim, SEAM_ARGS,
};
