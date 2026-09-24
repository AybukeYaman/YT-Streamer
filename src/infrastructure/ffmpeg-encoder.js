// Encoder sözleşmesinin ffmpeg implementasyonu: argümanları kurar, süreci başlatır,
// stderr'i parse eder, kapanışı yönetir.
const { spawn } = require('child_process');
const { Encoder } = require('../application/encoder');

const YOUTUBE_RTMPS_BASE = 'rtmps://a.rtmps.youtube.com/live2/';
const DEFAULT_STOP_TIMEOUT_MS = 5000;

// runNumber verilirse (playlist modu) local çıktı her çalıştırmada ayrı dosyaya gider:
// out.flv → out-1.flv, out-2.flv … — her restart gerçek yayında yeni bir RTMP oturumu,
// local'de ise yeni bir dosya; aynı dosyanın üzerine yazılıp önceki tur kaybolmaz.
function outputTarget(output, runNumber) {
  if (output.mode === 'local') {
    if (runNumber === undefined) return output.localPath;
    const dot = output.localPath.lastIndexOf('.');
    return `${output.localPath.slice(0, dot)}-${runNumber}${output.localPath.slice(dot)}`;
  }
  if (output.mode === 'rtmp') return YOUTUBE_RTMPS_BASE + output.streamKey;
  throw new Error(`bilinmeyen output.mode: ${output.mode}`);
}

// Ses girişi iki moddan biri:
//   tek parça: -re -i <dosya>                             (Faz 2)
//   playlist:  -re -f concat -safe 0 -i <playlist.txt>    (Faz 3.1 B yaklaşımı) + -shortest
// -shortest sadece playlist modunda: video sonsuz döngüde olduğu için playlist bitince
// ffmpeg'in kapanmasını (code=0) sağlar. Tek parça modunda kullanılmaz (PLAN.md Faz 1 notu).
function audioInputArgs({ audioPath, playlistPath }) {
  if (Boolean(audioPath) === Boolean(playlistPath)) {
    throw new Error('ses girişi olarak audioPath ya da playlistPath\'ten tam olarak biri verilmeli');
  }
  return playlistPath
    ? ['-re', '-f', 'concat', '-safe', '0', '-i', playlistPath]
    : ['-re', '-i', audioPath];
}

// Argümanlar dizi olarak kurulur — boşluklu Windows yolları tek eleman kalır, kaçış gerekmez.
// Sıra ve değerler Faz 1 yerel testinde doğrulanan komutla aynı.
function buildFfmpegArgs({ profile, backgroundPath, audioPath, playlistPath, runNumber, output }) {
  return [
    '-hide_banner',
    '-y', // local modda çıktının üzerine yaz; yoksa ffmpeg stdin'den onay bekler
    '-stream_loop', '-1', '-i', backgroundPath,
    ...audioInputArgs({ audioPath, playlistPath }),
    '-map', '0:v', '-map', '1:a',
    '-vf', `scale=${profile.width}:${profile.height}`,
    '-c:v', profile.videoCodec, '-preset', profile.preset, '-pix_fmt', profile.pixelFormat,
    '-profile:v', profile.h264Profile, '-r', String(profile.fps),
    '-g', String(profile.gopSize), '-keyint_min', String(profile.gopSize), '-sc_threshold', '0',
    '-b:v', profile.videoBitrate, '-maxrate', profile.maxRate, '-bufsize', profile.bufferSize,
    '-c:a', profile.audioCodec, '-b:a', profile.audioBitrate,
    '-ar', String(profile.audioSampleRate), '-ac', String(profile.audioChannels),
    ...(playlistPath ? ['-shortest'] : []),
    '-f', 'flv', outputTarget(output, runNumber),
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

  // options: { audioPath } (tek parça) ya da { playlistPath, runNumber } (playlist modu)
  start({ audioPath, playlistPath, runNumber }) {
    if (this.running) throw new Error('FfmpegEncoder zaten çalışıyor');
    const args = buildFfmpegArgs({
      profile: this.profile, backgroundPath: this.backgroundPath, audioPath, playlistPath, runNumber, output: this.output,
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
