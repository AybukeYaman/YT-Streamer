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
    // Uzantısız yol (lastIndexOf = -1): numara sona eklenir. Eskiden slice(0,-1) son
    // karakteri kesip "out" → "ou-1t" gibi bozuk bir ad üretiyordu.
    if (dot <= 0) return `${output.localPath}-${runNumber}`;
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

// lineOffset: aynı köşeye alt alta birden çok satır yazmak için, KENARDAN İÇERİ doğru
// kayma (px). Üst konumlarda aşağı, alt konumlarda yukarı gider — yani "ikinci satır"
// her köşede köşenin bir içine düşer. Pomodoro sağ üstte iki satır kullanıyor:
// sayaç (0) ve STUDY/BREAK (fontSize + boşluk).
const OVERLAY_POSITIONS = {
  'bottom-left': (bottom, line) => ({ x: '40', y: `h-${bottom + line}` }),
  'bottom-right': (bottom, line) => ({ x: 'w-tw-40', y: `h-${bottom + line}` }),
  'top-left': (_bottom, line) => ({ x: '40', y: String(40 + line) }),
  'top-right': (_bottom, line) => ({ x: 'w-tw-40', y: String(40 + line) }),
  center: (_bottom, line) => ({ x: '(w-tw)/2', y: line ? `(h-th)/2+${line}` : '(h-th)/2' }),
};

// bottomOffset verilmezse (eski config) 80 — mevcut davranış korunur.
function overlayPosition(position, bottomOffset = DEFAULT_BOTTOM_OFFSET, lineOffset = 0) {
  const build = OVERLAY_POSITIONS[position];
  if (!build) throw new Error(`desteklenmeyen overlay.position "${position}" — ${Object.keys(OVERLAY_POSITIONS).join(', ')}`);
  if (!Number.isFinite(bottomOffset) || bottomOffset <= 0) {
    throw new Error(`overlay.bottomOffset pozitif sayı olmalı (${bottomOffset})`);
  }
  if (!Number.isFinite(lineOffset) || lineOffset < 0) {
    throw new Error(`lineOffset negatif olmayan sayı olmalı (${lineOffset})`);
  }
  return build(bottomOffset, lineOffset);
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
// Ortak drawtext gövdesi: konum + yazı tipi + gölge.
function drawtextStyle({ fontFile, fontSize, position, bottomOffset, lineOffset }) {
  const pos = overlayPosition(position, bottomOffset, lineOffset);
  return [
    `fontfile=${escapeFilterPath(fontFile)}`,
    `fontsize=${fontSize}`,
    'fontcolor=white',
    `x=${pos.x}`, `y=${pos.y}`,
    'shadowcolor=black@0.6', 'shadowx=2', 'shadowy=2',
  ].join(':');
}

// expansion=none: metin düz okunur — "100% Love" gibi başlıklarda % dizisi yorumlanmasın.
// enable verilmezse yazı tüm çalıştırma boyunca durur (Pomodoro tür etiketi böyle).
function drawtext(style, textFile, enable) {
  const parts = [`drawtext=${style}`, 'expansion=none', `textfile=${escapeFilterPath(textFile)}`];
  if (enable) parts.push(`enable=${enable}`);
  return parts.join(':');
}

// Pomodoro geri sayımı: "12:34", fazın bitişine kalan süre.
//
// Metin DOSYADAN DEĞİL ifadeden geliyor (tek istisna): sayaç saniyede bir değişiyor,
// dosya yöntemi (ffmpeg açılışta bir kez okur) burada işlemez ve faz başına bir dosya
// yazma yöntemi saatlik çalıştırmada binlerce drawtext demek olurdu. Döngü periyodik
// olduğu için tek bir ifade tüm çalıştırma boyunca geçerli:
//   x   = döngü içindeki konum          mod(t + offset, cycle)
//   rem = fazın bitişine kalan          x < study ? study-x : cycle-x
// ceil: son saniye ekranda 00:00 değil 00:01 görünsün (geri sayımın okunuşu).
//
// Kaçış: ifadedeki : ve , drawtext'in kendi ayrıştırıcısı için \ ile kaçışlanır ve
// tamamı tek tırnak içine alınır — ffmpeg dokümanındaki %{eif} örneğiyle aynı biçim.
// Gerçek ffmpeg ile doğrulandı (10 Ekim 2026): tırnaksız ya da kaçışsız hali filtreyi
// bozuyor (bkz. escapeFilterPath'teki aynı ders).
const escapeExpr = (expr) => expr.replace(/[:,]/g, '\\$&');

function countdownText({ studySeconds, cycleSeconds, offsetSeconds }) {
  const x = `mod(t+${offsetSeconds.toFixed(3)},${cycleSeconds})`;
  const rem = `ceil(if(lt(${x},${studySeconds}),${studySeconds}-${x},${cycleSeconds}-${x}))`;
  return `'${escapeExpr(`%{eif:trunc((${rem})/60):d:2}:%{eif:mod((${rem}),60):d:2}`)}'`;
}

// Metni ifadeden üreten drawtext (sayaç). expansion=none YOK: %{...} burada tam olarak
// yorumlanmak isteniyor — parça başlıklarının tersi, orada metin düz okunmalı.
function drawtextExpr(style, text) {
  return `drawtext=${style}:text=${text}`;
}

// overlay: { fontFile, fontSize, position, bottomOffset } ya da null (overlay kapalı → sadece scale).
// overlayTexts: [{ textFile, start, end }] — parça başına bir drawtext, sadece kendi zaman
// aralığında görünür. Zamanlama ffmpeg'in video zaman damgasına (t) bağlı: sesle senkron.
// (textfile + reload=1 ile dosyayı Node'dan güncellemek ~12 sn geç kalıyordu — KARARLAR.md.)
//
// pomodoro: { statusTexts: [{ textFile, start, end }], countdown, fontSize,
//             statusPosition, lineGap } ya da null. Parça başlığından AYRI bir
// drawtext kümesi: kendi konumu, kendi punto'su. Böylece sol altta "Track Name",
// sağ üstte "12:34 / STUDY" aynı anda, üst üste binmeden görünür.
// Birden çok zaman aralığını tek enable ifadesinde birleştirir: (a1)+(a2)+… — ffmpeg'de
// toplama mantıksal VEYA gibi davranır (sıfırdan büyük = etkin).
function enableAny(windows) {
  return windows.length === 1
    ? enableExpr(windows[0].start, windows[0].end)
    : `'${windows.map((w) => enableExpr(w.start, w.end).slice(1, -1)).join('+')}'`;
}

function videoFilter(profile, overlay, overlayTexts = [], pomodoro = null) {
  const scale = `scale=${profile.width}:${profile.height}`;
  const filters = [];

  if (overlay && overlayTexts.length > 0) {
    const style = drawtextStyle(overlay);
    filters.push(...overlayTexts.map(({ textFile, start, end }) =>
      drawtext(style, textFile, enableExpr(start, end))));
  }

  if (pomodoro) {
    if (!overlay) throw new Error('pomodoro overlay gerektirir: yazı tipi overlay.fontFile\'dan geliyor');
    const lineGap = pomodoro.lineGap ?? 0;
    // Sağ üstte iki satır, aynı köşede alt alta:
    //   1. satır  geri sayım (enable yok — sayaç hep ekranda, faz fark etmez)
    //   2. satır  STUDY/BREAK (faz başına bir drawtext, kendi zaman aralığında)
    if (pomodoro.countdown) {
      const timerStyle = drawtextStyle({
        fontFile: overlay.fontFile,
        fontSize: pomodoro.fontSize,
        position: pomodoro.statusPosition,
      });
      filters.push(drawtextExpr(timerStyle, countdownText(pomodoro.countdown)));
    }
    const statusStyle = drawtextStyle({
      fontFile: overlay.fontFile,
      fontSize: pomodoro.fontSize,
      position: pomodoro.statusPosition,
      // Sayaç varsa durum yazısı ikinci satıra iner; yoksa köşenin kendisinde kalır.
      lineOffset: pomodoro.countdown ? pomodoro.fontSize + lineGap : 0,
    });
    filters.push(...pomodoro.statusTexts.map(({ textFile, start, end }) =>
      drawtext(statusStyle, textFile, enableExpr(start, end))));
  }

  return [scale, ...filters].join(',');
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

// Pomodoro uyarı bipleri. Ayrı bir ses dosyası tutulmuyor: ffmpeg'in kendi sine üreteci
// (lavfi) kısa bir bip üretiyor, o bip her geçiş anına adelay ile kopyalanıp müziğin
// üstüne amix'leniyor. Zamanlar çalıştırmaya göreli ve ÖNCEDEN hesaplanmış — overlay
// zamanlamasıyla aynı ilke, canlı müdahale yok.
//
// normalize=0: amix varsayılanı girdi sayısına bölerek sesi kısardı, müzik seviyesi düşmesin.
// duration=first: karışım müzikle biter, bip girdilerinin bitmesi yayını kesmez.
const BEEP_FREQUENCY_HZ = 880;
const BEEP_DURATION_SECONDS = 0.12;
const BEEP_VOLUME = 0.25;
const BEEP_INPUT_ARGS = ['-f', 'lavfi', '-i', `sine=frequency=${BEEP_FREQUENCY_HZ}:duration=${BEEP_DURATION_SECONDS}`];

function beepMixChain(beepTimes, musicLabel = '1:a', beepLabel = '2:a', outLabel = 'a') {
  const splits = beepTimes.map((_, i) => `[p${i}]`).join('');
  const chains = [
    `[${beepLabel}]volume=${BEEP_VOLUME},aformat=sample_rates=48000:channel_layouts=stereo,`
      + `asplit=${beepTimes.length}${splits}`,
    ...beepTimes.map((seconds, i) => {
      const ms = Math.round(seconds * 1000);
      return `[p${i}]adelay=${ms}|${ms}[d${i}]`;
    }),
    `[${musicLabel}]${beepTimes.map((_, i) => `[d${i}]`).join('')}`
      + `amix=inputs=${beepTimes.length + 1}:duration=first:normalize=0[${outLabel}]`,
  ];
  return chains.join(';');
}

// Argümanlar dizi olarak kurulur — boşluklu Windows yolları tek eleman kalır, kaçış gerekmez.
// Sıra ve değerler Faz 1 yerel testinde doğrulanan komutla aynı.
//
// beepTimes boşsa (Pomodoro kapalı ya da bu çalıştırmada geçiş yok) ses zinciri HİÇ
// kurulmaz: -vf + doğrudan map, yani bugünkü komutun birebir aynısı. Bip varsa video ve
// ses tek -filter_complex'e taşınır (ikisini -vf ile karıştırmak kırılgan).
function buildFfmpegArgs({
  profile, backgroundPath, backgroundPlaylistPath, audioPath, playlistPath, runNumber,
  output, overlay = null, overlayTexts, pomodoro = null, beepTimes = [],
  breakBackground = null,
}) {
  const vf = videoFilter(profile, overlay, overlayTexts, pomodoro);
  const mixing = beepTimes.length > 0;
  // Mola arkaplanı: yalnızca bu çalıştırmada mola penceresi varsa giriş eklenir.
  const breaking = Boolean(breakBackground && breakBackground.windows.length > 0);
  // Giriş sırası: 0 arkaplan, 1 müzik, sonra (varsa) mola klibi, sonra (varsa) bip.
  const breakIndex = breaking ? 2 : null;
  const beepIndex = mixing ? (breaking ? 3 : 2) : null;
  const complex = mixing || breaking;

  // Video zinciri: önce mola klibi ana arkaplanın ÜSTÜNE bindirilir, yazılar en sona
  // kalır — STUDY/BREAK ve tür etiketi mola görselinin de üstünde görünsün.
  // overlay'in enable'ı, BREAK yazısının enable'ıyla aynı zaman ifadesinden üretiliyor:
  // ikisi tek kaynaktan geldiği için görsel ile yazı asla birbirinden kayamaz.
  let videoChain;
  if (breaking) {
    const brk = `[${breakIndex}:v]scale=${profile.width}:${profile.height},setsar=1[brk]`;
    const comp = `[0:v]scale=${profile.width}:${profile.height}[bg];[bg][brk]overlay=enable=${enableAny(breakBackground.windows)}[comp]`;
    // vf'in başındaki scale zaten uygulandı; kalan filtreleri (drawtext'ler) comp'a bağla.
    const rest = vf.split(',').slice(1).join(',');
    videoChain = `${brk};${comp}` + (rest ? `;[comp]${rest}[v]` : ';[comp]null[v]');
  } else {
    videoChain = `[0:v]${vf}[v]`;
  }

  return [
    '-hide_banner',
    '-y', // local modda çıktının üzerine yaz; yoksa ffmpeg stdin'den onay bekler
    ...videoInputArgs({ backgroundPath, backgroundPlaylistPath }),
    ...audioInputArgs({ audioPath, playlistPath }),
    ...(breaking ? ['-stream_loop', '-1', '-i', breakBackground.path] : []),
    ...(mixing ? BEEP_INPUT_ARGS : []),
    ...(complex
      ? ['-filter_complex',
        videoChain + (mixing ? `;${beepMixChain(beepTimes, '1:a', `${beepIndex}:a`)}` : ''),
        '-map', '[v]', '-map', mixing ? '[a]' : '1:a']
      : ['-map', '0:v', '-map', '1:a', '-vf', vf]),
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
  // pomodoro / beepTimes: verilmezse Pomodoro kapalı demektir ve komut bugünküyle aynı kalır.
  start({
    audioPath, playlistPath, runNumber, overlayTexts,
    backgroundPath, backgroundPlaylistPath,
    pomodoro = null, beepTimes = [], breakBackground = null,
  }) {
    if (this.running) throw new Error('FfmpegEncoder zaten çalışıyor');
    const args = buildFfmpegArgs({
      profile: this.profile,
      backgroundPath: backgroundPlaylistPath ? undefined : (backgroundPath ?? this.backgroundPath),
      backgroundPlaylistPath,
      audioPath, playlistPath, runNumber,
      output: this.output, overlay: this.overlay, overlayTexts,
      pomodoro, beepTimes, breakBackground,
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

module.exports = { FfmpegEncoder, buildFfmpegArgs, parseProgressLine, escapeFilterPath, countdownText };
