// Encoder sözleşmesinin ffmpeg implementasyonu: argümanları kurar, süreci başlatır,
// stderr'i parse eder, kapanışı yönetir.
const { spawn } = require('child_process');
const { Encoder } = require('../application/encoder');

const YOUTUBE_RTMPS_BASE = 'rtmps://a.rtmps.youtube.com/live2/';
const DEFAULT_STOP_TIMEOUT_MS = 5000;
// SIGTERM'den sonra SIGKILL'e geçiş süresi. Kısa tutulur: bu noktaya gelindiyse
// ffmpeg zaten 'q'ya da SIGTERM'e cevap vermemiş, beklemek yalnızca systemd'nin
// TimeoutStopSec'ine yaklaştırır (dolarsa node SIGKILL'lenir ve ffmpeg yetim kalır).
const DEFAULT_KILL_TIMEOUT_MS = 3000;

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

// Filtre içindeki yol: düz bölü, sürücü iki noktası kaçışlı (C: → C\:), tek tırnak içinde.
// Filtre sözdiziminde : seçenek ayırıcı olduğu için kaçışsız C: filtreyi bozar — PLAN.md'nin
// "en sık takılınan yer" dediği kısım. Argümanlar dizi olarak geçtiği için kabuk kaçışı yok.
//
// ffmpeg filtre metnini İKİ kez ayrıştırır (gerçek ffmpeg ile doğrulandı, Faz 4.3):
//   1. seçenek seviyesi (drawtext): : ve ' önüne \ → C\:  Don\'t
//   2. filtre zinciri seviyesi: tek tırnak içine al; tırnak içinde ' yazılamaz, bu yüzden
//      kapat + \' + yeniden aç ('\'') — 1. seviyenin \'si tırnak içinde olduğu gibi kalır.
// Tek seviye kaçışla yoldaki ' ikinci ayrıştırmada yeni bir alıntı açıp filtrenin kalanını yutuyor.
function escapeFilterPath(filePath) {
  const optionLevel = filePath.replace(/\\/g, '/').replace(/[:']/g, '\\$&');
  return `'${optionLevel.replace(/'/g, "'\\''")}'`;
}

// Alt konumlarda y=h-<bottomOffset>: drawtext'te y metnin ÜST kenarı, yani metin alt kenara
// bottomOffset-fontSize kadar yaklaşır. 80 PLAN.md Faz 4'teki doğrulanmış değer (fontsize 28);
// oynatıcı kontrol çubuğu alt bandı kapattığı için config'den yükseltilebilir.
// Üst konumların kenar payı sabit 40 — ayarlanabilirlik şimdilik sadece alt konumlar için.
const DEFAULT_BOTTOM_OFFSET = 80;

const OVERLAY_POSITIONS = {
  'bottom-left': (bottom) => ({ x: '40', y: `h-${bottom}` }),
  'bottom-right': (bottom) => ({ x: 'w-tw-40', y: `h-${bottom}` }),
  'top-left': () => ({ x: '40', y: '40' }),
  'top-right': () => ({ x: 'w-tw-40', y: '40' }),
};

// bottomOffset verilmezse (eski config) 80 — mevcut davranış korunur.
function overlayPosition(position, bottomOffset = DEFAULT_BOTTOM_OFFSET) {
  const build = OVERLAY_POSITIONS[position];
  if (!build) throw new Error(`desteklenmeyen overlay.position "${position}" — ${Object.keys(OVERLAY_POSITIONS).join(', ')}`);
  if (!Number.isFinite(bottomOffset) || bottomOffset <= 0) {
    throw new Error(`overlay.bottomOffset pozitif sayı olmalı (${bottomOffset})`);
  }
  return build(bottomOffset);
}

// Saniye → enable ifadesi, yarı açık aralık start ≤ t < end (end null: sona kadar).
// Virgüller filtre zinciri seviyesinde ayırıcı olduğu için \, — ifade tek tırnak içinde.
function enableExpr(start, end) {
  const s = start.toFixed(3);
  return end === null ? `'gte(t\\,${s})'` : `'gte(t\\,${s})*lt(t\\,${end.toFixed(3)})'`;
}

// overlay: { fontFile, fontSize, position, bottomOffset } ya da null (overlay kapalı → sadece scale).
// overlayTexts: [{ textFile, start, end }] — parça başına bir drawtext, sadece kendi zaman
// aralığında görünür. Zamanlama ffmpeg'in video zaman damgasına (t) bağlı: sesle senkron.
// (textfile + reload=1 ile dosyayı Node'dan güncellemek ~12 sn geç kalıyordu — KARARLAR.md.)
function videoFilter(profile, overlay, overlayTexts = []) {
  const scale = `scale=${profile.width}:${profile.height}`;
  if (!overlay || overlayTexts.length === 0) return scale;
  const pos = overlayPosition(overlay.position, overlay.bottomOffset);
  const style = [
    `fontfile=${escapeFilterPath(overlay.fontFile)}`,
    `fontsize=${overlay.fontSize}`,
    'fontcolor=white',
    `x=${pos.x}`, `y=${pos.y}`,
    'shadowcolor=black@0.6', 'shadowx=2', 'shadowy=2',
  ].join(':');
  // expansion=none: başlık düz metin — "100% Love" gibi başlıklarda % dizisi yorumlanmasın.
  const drawtexts = overlayTexts.map(({ textFile, start, end }) =>
    `drawtext=${style}:expansion=none:textfile=${escapeFilterPath(textFile)}:enable=${enableExpr(start, end)}`);
  return [scale, ...drawtexts].join(',');
}

// Video girişi iki moddan biri:
//   tek arkaplan: -stream_loop -1 -i <dosya>
//   rotasyon:     -stream_loop -1 -f concat -safe 0 -i <liste>   (arkaplan saatlik döner)
// -stream_loop ikisinde de -1: listede TEK tur var, sonsuza uzatmayı ffmpeg yapar.
// concat demuxer girdilerin kodek/çözünürlük/fps/pix_fmt/SAR/timebase'inin BİREBİR aynı
// olmasını şart koşar; sapan tek dosya yayını bozar. Bu yüzden klipleri üreten taraf
// (yayın paketi sözleşmesi) setsar=1 dahil hepsini sabitliyor.
function videoInputArgs({ backgroundPath, backgroundPlaylistPath }) {
  if (Boolean(backgroundPath) === Boolean(backgroundPlaylistPath)) {
    throw new Error('video girişi olarak backgroundPath ya da backgroundPlaylistPath\'ten tam olarak biri verilmeli');
  }
  return backgroundPlaylistPath
    ? ['-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', backgroundPlaylistPath]
    : ['-stream_loop', '-1', '-i', backgroundPath];
}

// Argümanlar dizi olarak kurulur — boşluklu Windows yolları tek eleman kalır, kaçış gerekmez.
// Sıra ve değerler Faz 1 yerel testinde doğrulanan komutla aynı.
function buildFfmpegArgs({
  profile, backgroundPath, backgroundPlaylistPath, audioPath, playlistPath, runNumber,
  output, overlay = null, overlayTexts,
}) {
  return [
    '-hide_banner',
    '-y', // local modda çıktının üzerine yaz; yoksa ffmpeg stdin'den onay bekler
    ...videoInputArgs({ backgroundPath, backgroundPlaylistPath }),
    ...audioInputArgs({ audioPath, playlistPath }),
    '-map', '0:v', '-map', '1:a',
    '-vf', videoFilter(profile, overlay, overlayTexts),
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
    overlay = null, // { fontFile, fontSize, position, bottomOffset } — null ise drawtext yok
    ffmpegPath = 'ffmpeg',
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
    spawnFn = spawn, // testlerde sahte süreç vermek için
  }) {
    super();
    this.profile = profile;
    this.backgroundPath = backgroundPath;
    this.output = output;
    this.overlay = overlay;
    // Geçersiz konum yayın başlamadan, kurulumda yakalansın.
    if (overlay) overlayPosition(overlay.position, overlay.bottomOffset);
    this.ffmpegPath = ffmpegPath;
    this.stopTimeoutMs = stopTimeoutMs;
    this.killTimeoutMs = killTimeoutMs;
    this.spawnFn = spawnFn;
    this.child = null;
  }

  get running() {
    return this.child !== null;
  }

  // options: { audioPath } (tek parça) ya da { playlistPath, runNumber, overlayTexts } (playlist modu);
  // backgroundPath verilirse kurulumdakinin yerine o kullanılır (albüm başına arkaplan).
  // backgroundPlaylistPath verilirse arkaplan rotasyonu devrededir ve tek dosya yolu
  // tamamen devre dışı kalır — kurulumdaki backgroundPath'e DÜŞÜLMEZ, yoksa ffmpeg'e iki
  // video girişi birden verilmiş olur.
  start({
    audioPath, playlistPath, runNumber, overlayTexts,
    backgroundPath, backgroundPlaylistPath,
  }) {
    if (this.running) throw new Error('FfmpegEncoder zaten çalışıyor');
    const args = buildFfmpegArgs({
      profile: this.profile,
      backgroundPath: backgroundPlaylistPath ? undefined : (backgroundPath ?? this.backgroundPath),
      backgroundPlaylistPath,
      audioPath, playlistPath, runNumber,
      output: this.output, overlay: this.overlay, overlayTexts,
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

  // Kapanış kademeli: 'q' (ffmpeg çıktıyı düzgün kapatır) → SIGTERM → SIGKILL.
  //
  // Neden escalation şart: eskiden son adım tek bir child.kill() (SIGTERM) idi ve
  // promise yalnızca 'close' ile resolve oluyordu. ffmpeg SIGTERM'i yutarsa stop()
  // sonsuza kadar pending kalıyor; kapanış zinciri (orchestrator → supervisor →
  // index.js shutdown) askıda kalıyor, systemd TimeoutStopSec'i doluyor ve node'u
  // SIGKILL ediyor — ffmpeg PPID=1'e düşüp yayına bağlı kalıyor (yetim süreç).
  // Gerekçe ve gözlem: KARARLAR.md, 30 Eylül 2026.
  stop() {
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const timers = [];
      let settled = false;
      const pid = child.pid === undefined ? '?' : child.pid;
      // resolve tek sefer: hangi kademede kapanırsa kapansın kalan timer'lar iptal.
      const finish = (failureNote = null) => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        if (failureNote) this.emit('log', { kind: 'error', message: failureNote });
        resolve();
      };
      const escalate = (signal, note, nextTimeoutMs, onNext) => {
        this.emit('log', { kind: 'error', message: note });
        child.kill(signal);
        timers.push(setTimeout(onNext, nextTimeoutMs));
      };

      child.once('close', () => finish());

      timers.push(setTimeout(() => {
        escalate(
          'SIGTERM',
          `ffmpeg (pid=${pid}) ${this.stopTimeoutMs} ms içinde 'q' ile kapanmadı — SIGTERM gönderiliyor`,
          this.killTimeoutMs,
          () => escalate(
            'SIGKILL',
            `ffmpeg (pid=${pid}) SIGTERM'den sonra ${this.killTimeoutMs} ms içinde de kapanmadı — SIGKILL gönderiliyor`,
            this.killTimeoutMs,
            // SIGKILL'den sonra da 'close' gelmezse (pratikte kesilemez I/O beklemesi):
            // kapanış zincirini askıda bırakmamak için yine resolve edilir. this.child
            // BİLEREK null'lanmaz — böylece running=true kalır, start() yeni bir ffmpeg
            // başlatmayı reddeder ve aynı stream key'ine ikinci bağlantı oluşmaz.
            () => finish(
              `ffmpeg (pid=${pid}) SIGKILL'den sonra da kapanmadı — kapanış beklenmeden sürdürülüyor. ` +
              'Yetim süreç kalmış olabilir, VPS\'te kontrol et: ps -C ffmpeg -o pid,ppid,etime',
            ),
          ),
        );
      }, this.stopTimeoutMs));

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

module.exports = { FfmpegEncoder, buildFfmpegArgs, parseProgressLine, escapeFilterPath };
