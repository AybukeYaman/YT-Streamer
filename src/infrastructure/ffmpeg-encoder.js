// Encoder sözleşmesinin ffmpeg implementasyonu: argümanları kurar, süreci başlatır,
// stderr'i parse eder, kapanışı yönetir.
const { spawn } = require('child_process');
const { Encoder } = require('../application/encoder');

const YOUTUBE_RTMPS_BASE = 'rtmps://a.rtmps.youtube.com/live2/';
const DEFAULT_STOP_TIMEOUT_MS = 5000;

function outputTarget(output) {
  if (output.mode === 'local') return output.localPath;
  if (output.mode === 'rtmp') return YOUTUBE_RTMPS_BASE + output.streamKey;
  throw new Error(`bilinmeyen output.mode: ${output.mode}`);
}

// Argümanlar dizi olarak kurulur — boşluklu Windows yolları tek eleman kalır, kaçış gerekmez.
// Sıra ve değerler Faz 1 yerel testinde doğrulanan komutla aynı.
function buildFfmpegArgs({ profile, backgroundPath, audioPath, output }) {
  return [
    '-hide_banner',
    '-y', // local modda runtime/out.flv'nin üzerine yaz; yoksa ffmpeg stdin'den onay bekler
    '-stream_loop', '-1', '-i', backgroundPath,
    '-re', '-i', audioPath,
    '-map', '0:v', '-map', '1:a',
    '-vf', `scale=${profile.width}:${profile.height}`,
    '-c:v', profile.videoCodec, '-preset', profile.preset, '-pix_fmt', profile.pixelFormat,
    '-profile:v', profile.h264Profile, '-r', String(profile.fps),
    '-g', String(profile.gopSize), '-keyint_min', String(profile.gopSize), '-sc_threshold', '0',
    '-b:v', profile.videoBitrate, '-maxrate', profile.maxRate, '-bufsize', profile.bufferSize,
    '-c:a', profile.audioCodec, '-b:a', profile.audioBitrate,
    '-ar', String(profile.audioSampleRate), '-ac', String(profile.audioChannels),
    '-f', 'flv', outputTarget(output),
  ];
}

// Stream key loglara sızmasın — hem komut argümanlarında hem ffmpeg'in stderr'inde
// ("Output #0, flv, to 'rtmps://.../<key>'") geçiyor.
function maskSecret(text, output) {
  if (output.mode !== 'rtmp') return text;
  return text.split(output.streamKey).join('***');
}

// "frame= 2880 fps= 24 q=-1.0 size= 19954KiB time=00:02:00.00 bitrate=1362.2kbits/s speed=1x"
// speed ffmpeg'in yayın başından beri hesapladığı ORTALAMA — anlık değil. Yorumlamak Faz 5'in işi.
function parseProgressLine(line) {
  const frame = line.match(/frame=\s*(\d+)/);
  if (!frame) return null;
  const num = (re) => {
    const m = line.match(re);
    return m ? Number(m[1]) : null; // N/A → null
  };
  return {
    frame: Number(frame[1]),
    fps: num(/fps=\s*([\d.]+)/),
    bitrateKbps: num(/bitrate=\s*([\d.]+)kbits\/s/),
    speed: num(/speed=\s*([\d.]+)x/),
  };
}

class FfmpegEncoder extends Encoder {
  constructor({
    profile, backgroundPath, output,
    ffmpegPath = 'ffmpeg',
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    spawnFn = spawn, // testlerde sahte süreç vermek için
  }) {
    super();
    this.profile = profile;
    this.backgroundPath = backgroundPath;
    this.output = output;
    this.ffmpegPath = ffmpegPath;
    this.stopTimeoutMs = stopTimeoutMs;
    this.spawnFn = spawnFn;
    this.child = null;
  }

  get running() {
    return this.child !== null;
  }

  start({ audioPath }) {
    if (this.running) throw new Error('FfmpegEncoder zaten çalışıyor');
    const args = buildFfmpegArgs({
      profile: this.profile, backgroundPath: this.backgroundPath, audioPath, output: this.output,
    });
    this.emit('log', { kind: 'command', args: args.map((a) => maskSecret(a, this.output)) });

    const child = this.spawnFn(this.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    this.child = child;
    // Süreç kapanırken 'q' yazmak EPIPE verebilir; kapanış zaten 'close' ile izleniyor.
    child.stdin.on('error', () => {});

    let buffer = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r\n|\r|\n/); // ilerleme satırları \r ile ayrılır
      buffer = lines.pop();
      for (const line of lines) this.#handleLine(line);
    });

    child.on('error', (err) => {
      this.emit('log', { kind: 'error', message: `ffmpeg başlatılamadı: ${err.message}` });
    });

    // 'close' stderr tamamen okunduktan sonra gelir — son satırlar kaybolmaz.
    child.on('close', (code, signal) => {
      if (buffer) this.#handleLine(buffer);
      buffer = '';
      this.child = null;
      this.emit('exit', code, signal);
    });
  }

  // Önce ffmpeg'in standart kapanışı ('q' → çıktıyı düzgün kapatır), yanıt yoksa kill.
  stop() {
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.emit('log', { kind: 'error', message: `ffmpeg ${this.stopTimeoutMs} ms içinde kapanmadı, kill()` });
        child.kill();
      }, this.stopTimeoutMs);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.write('q');
    });
  }

  #handleLine(rawLine) {
    if (!rawLine.trim()) return;
    const line = maskSecret(rawLine, this.output);
    const progress = parseProgressLine(line);
    if (progress) this.emit('log', { kind: 'progress', ...progress, raw: line });
    else this.emit('log', { kind: 'stderr', line });
  }
}

module.exports = { FfmpegEncoder, buildFfmpegArgs, parseProgressLine };
