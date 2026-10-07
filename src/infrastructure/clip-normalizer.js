// Ham video/görselleri yayın sözleşmesine uygun arkaplan klibine çevirir.
//
//   h264, 1280x720, 24 fps, yuv420p, SAR 1:1, ses YOK
//
// İKİ çağıranı var ve ikisinin de aynı çıktıyı üretmesi şart:
//   scripts/add-backgrounds.js          albümün backgrounds/ havuzu
//   src/infrastructure/break-clip.js    Pomodoro mola görseli
// Aynı dönüşümü iki yerde yazmak, bir gün birinin SAR'ı ya da fps'i kaymasına ve
// concat'in sessizce bozulmasına yol açardı. Tek kaynak burası.
//
// Dönüşüm: en-boy oranını koruyarak hedefi kaplayacak kadar ölçekle → taşanı ortadan
// kırp (esnetme yok, siyah bant yok) → sesi at → SAR'ı sabitle.
//   kısa klip (<MIN_SECONDS): bant alt sınırına kadar döngüye sokulur
//   görsel: yavaş ileri-geri zoom (Ken Burns) — durağan kare uzun süre "yayın dondu"
//           gibi duruyor. Zoom kosinüs eğrisiyle başladığı yere döner, yani klip kendi
//           içinde dikişsiz: tekrarlarken sıçrama olmaz.
const { spawn } = require('child_process');
const path = require('path');

const TARGET = { width: 1280, height: 720, fps: 24 };
const MIN_SECONDS = 10; // bant alt sınırı: daha kısa klip döngüye sokulur
const IMAGE_SECONDS = 15; // görselden üretilen klibin süresi
const IMAGE_ZOOM = 0.08; // Ken Burns zoom miktarı (%8) — fazlası baş döndürüyor
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const ENCODE_ARGS = [
  '-an', // ses sözleşme gereği atılır: arkaplan sessiz, ses playlist'ten geliyor
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
  '-pix_fmt', 'yuv420p', '-profile:v', 'high',
  '-r', String(TARGET.fps), '-movflags', '+faststart',
];

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function probe(file) {
  const { code, stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate,sample_aspect_ratio,pix_fmt',
    '-show_entries', 'format=duration',
    '-of', 'json', file,
  ]);
  if (code !== 0) return null;
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find((s) => s.codec_type === 'video');
  if (!video) return null;
  return {
    width: video.width,
    height: video.height,
    pixelFormat: video.pix_fmt,
    sar: video.sample_aspect_ratio || 'N/A',
    fps: video.r_frame_rate,
    hasAudio: (data.streams || []).some((s) => s.codec_type === 'audio'),
    durationSeconds: parseFloat((data.format || {}).duration) || null,
  };
}

const normalizeFilter = () => [
  `scale=${TARGET.width}:${TARGET.height}:force_original_aspect_ratio=increase`,
  `crop=${TARGET.width}:${TARGET.height}`,
  'setsar=1',
  `fps=${TARGET.fps}`,
].join(',');

// z, kosinüs eğrisiyle 1'den başlayıp 1'e döner: ilk ve son kare aynı → dikişsiz döngü.
// Önce 2x çözünürlüğe ölçekleniyor, zoompan düşük çözünürlükte titriyor.
function kenBurnsFilter(frames) {
  const z = `1+${IMAGE_ZOOM}*(1-cos(2*PI*on/${frames}))/2`;
  return [
    `scale=${TARGET.width * 2}:${TARGET.height * 2}:force_original_aspect_ratio=increase`,
    `crop=${TARGET.width * 2}:${TARGET.height * 2}`,
    `zoompan=z='${z}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${TARGET.width}x${TARGET.height}:fps=${TARGET.fps}`,
    'setsar=1',
  ].join(',');
}

// Kaynak dikişsizse sonuç da dikişsiz; değilse sıçrama zaten kaynağın kendisinde var.
function loopPlan(durationSeconds) {
  if (durationSeconds >= MIN_SECONDS) return { loops: 0, seconds: durationSeconds };
  const times = Math.ceil(MIN_SECONDS / durationSeconds);
  return { loops: times - 1, seconds: +(durationSeconds * times).toFixed(3) };
}

async function convertVideo(src, out, info) {
  const { loops, seconds } = loopPlan(info.durationSeconds);
  const { code, stderr } = await run('ffmpeg', [
    '-hide_banner', '-v', 'error', '-y',
    ...(loops ? ['-stream_loop', String(loops)] : []),
    '-i', src,
    ...(loops ? ['-t', String(seconds)] : []),
    '-vf', normalizeFilter(),
    ...ENCODE_ARGS, out,
  ]);
  return { ok: code === 0, stderr, seconds, note: loops ? `${loops + 1}x döngü` : 'olduğu gibi' };
}

async function convertImage(src, out) {
  const { code, stderr } = await run('ffmpeg', [
    '-hide_banner', '-v', 'error', '-y',
    '-loop', '1', '-t', String(IMAGE_SECONDS), '-i', src,
    '-vf', kenBurnsFilter(IMAGE_SECONDS * TARGET.fps),
    ...ENCODE_ARGS, out,
  ]);
  return { ok: code === 0, stderr, seconds: IMAGE_SECONDS, note: 'Ken Burns (ileri-geri)' };
}

const isImage = (file) => IMAGE_EXT.has(path.extname(file).toLowerCase());
const isVideo = (file) => VIDEO_EXT.has(path.extname(file).toLowerCase());
const isSupported = (file) => isImage(file) || isVideo(file);

// Kaynak türünü kendisi seçer. info verilmezse ffprobe ile okunur.
async function convertAny(src, out, info = null) {
  if (isImage(src)) return convertImage(src, out);
  const probed = info || await probe(src);
  if (!probed) return { ok: false, stderr: 'okunamadı', seconds: 0, note: '' };
  return convertVideo(src, out, probed);
}

module.exports = {
  TARGET, MIN_SECONDS, IMAGE_SECONDS, ENCODE_ARGS, VIDEO_EXT, IMAGE_EXT,
  run, probe, normalizeFilter, kenBurnsFilter, loopPlan,
  convertVideo, convertImage, convertAny, isImage, isVideo, isSupported,
};
