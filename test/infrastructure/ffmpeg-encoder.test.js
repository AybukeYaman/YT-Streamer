const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { FfmpegEncoder, buildFfmpegArgs, parseProgressLine, escapeFilterPath } = require('../../src/infrastructure/ffmpeg-encoder');
const { Encoder } = require('../../src/application/encoder');
const { StreamProfile } = require('../../src/domain/stream-profile');

const profile = new StreamProfile({
  width: 1280, height: 720, fps: 24,
  videoBitrate: '2500k', audioBitrate: '160k', preset: 'veryfast',
});
const BG = 'C:/Users/Aybuke Yeni/Desktop/Youtube/YT Stream System/assets/background.mp4';
const AUDIO = 'C:/Users/Aybuke Yeni/Desktop/Youtube/YT Stream System/music/After the Sun Goes Down.m4a';
const LOCAL = { mode: 'local', localPath: 'C:/Users/Aybuke Yeni/Desktop/Youtube/YT Stream System/runtime/out.flv' };

// Gerçek ffmpeg yerine kullanılan sahte süreç: stdin'e yazılanı kaydeder, kapanışı test tetikler.
function fakeSpawn() {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.written = '';
    child.stdin.on('data', (d) => { child.written += d; });
    child.pid = 4242;
    child.killed = false;
    // ignoreSignals: sinyali yutan (kapanmayan) ffmpeg'i taklit etmek için test doldurur.
    child.ignoreSignals = [];
    child.signals = [];
    child.kill = (signal = 'SIGTERM') => {
      child.killed = true;
      child.signals.push(signal);
      if (child.ignoreSignals.includes(signal)) return;
      setImmediate(() => child.emit('close', null, signal));
    };
    calls.push({ cmd, args, opts, child });
    return child;
  };
  return { spawnFn, calls };
}

test('argümanlar Faz 1 doğrulanmış komutla birebir aynı (local)', () => {
  const args = buildFfmpegArgs({ profile, backgroundPath: BG, audioPath: AUDIO, output: LOCAL });
  assert.deepEqual(args, [
    '-hide_banner', '-y',
    '-stream_loop', '-1', '-i', BG,
    '-re', '-i', AUDIO,
    '-map', '0:v', '-map', '1:a',
    '-vf', 'scale=1280:720',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-profile:v', 'main', '-r', '24', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
    '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-f', 'flv', LOCAL.localPath,
  ]);
});

test('playlist modu: -re -f concat -safe 0 -i <playlist> ve -shortest; geri kalan birebir aynı', () => {
  const PL = 'C:/Users/Aybuke Yeni/Desktop/Youtube/YT Stream System/runtime/playlist.txt';
  const single = buildFfmpegArgs({ profile, backgroundPath: BG, audioPath: AUDIO, output: LOCAL });
  const pl = buildFfmpegArgs({ profile, backgroundPath: BG, playlistPath: PL, output: LOCAL });
  assert.deepEqual(pl.slice(4, 11), ['-i', BG, '-re', '-f', 'concat', '-safe', '0']);
  assert.equal(pl[pl.indexOf('concat') + 4], PL);
  assert.deepEqual(pl.slice(-4), ['-shortest', '-f', 'flv', LOCAL.localPath]);
  // Encode parametreleri iki modda aynı
  const encodePart = (a) => a.slice(a.indexOf('-map'), a.indexOf('-f', a.indexOf('-map')));
  assert.deepEqual(encodePart(pl).filter((x) => x !== '-shortest'), encodePart(single));
});

const OVERLAY = { fontFile: 'C:/Windows/Fonts/arial.ttf', fontSize: 28, position: 'bottom-left' };
const RT = 'C:\\Users\\Aybuke Yeni\\Desktop\\Youtube\\YT Stream System\\runtime\\overlay';
const TEXTS = [
  { textFile: `${RT}\\track-001.txt`, start: 0, end: 179.349 },
  { textFile: `${RT}\\track-002.txt`, start: 179.349, end: 359.7861 },
  { textFile: `${RT}\\track-003.txt`, start: 359.7861, end: null },
];
const vf = (args) => args[args.indexOf('-vf') + 1];
const withOverlay = (extra = {}) => buildFfmpegArgs({ profile, backgroundPath: BG, playlistPath: 'p', output: LOCAL, overlay: OVERLAY, overlayTexts: TEXTS, ...extra });

test('escapeFilterPath: sürücü iki noktası kaçışlı, düz bölü, tek tırnak içinde', () => {
  assert.equal(escapeFilterPath('C:/Windows/Fonts/arial.ttf'), "'C\\:/Windows/Fonts/arial.ttf'");
  assert.equal(escapeFilterPath('C:\\Windows\\Fonts\\arial.ttf'), "'C\\:/Windows/Fonts/arial.ttf'");
  assert.equal(escapeFilterPath('C:/Users/Aybuke Yeni/x.txt'), "'C\\:/Users/Aybuke Yeni/x.txt'"); // boşluk korunur
});

test('escapeFilterPath: yoldaki tek tırnak iki seviyede kaçışlanır (seçenek \\\', zincir \'\\\'\')', () => {
  // Beklenen ham metin: 'C\:/m/Don\'\''t.txt' — gerçek ffmpeg ile doğrulanan biçim
  assert.equal(escapeFilterPath("C:/m/Don't.txt"), "'C\\:/m/Don\\'\\''t.txt'");
});

test('overlay: parça başına bir drawtext, scale\'e virgülle zincirli, -vf tek kez', () => {
  const args = withOverlay();
  assert.equal(args.filter((a) => a === '-vf').length, 1);
  const parts = vf(args).split(',drawtext=');
  assert.equal(parts[0], 'scale=1280:720');
  assert.equal(parts.length, 1 + TEXTS.length);
});

test('overlay: drawtext tam biçimi — stil, mutlak düz bölü textfile, yarı açık enable aralığı', () => {
  const style = "fontfile='C\\:/Windows/Fonts/arial.ttf':fontsize=28:fontcolor=white:x=40:y=h-80:shadowcolor=black@0.6:shadowx=2:shadowy=2";
  const file = (n) => `textfile='C\\:/Users/Aybuke Yeni/Desktop/Youtube/YT Stream System/runtime/overlay/track-00${n}.txt'`;
  assert.equal(vf(withOverlay()), [
    'scale=1280:720',
    `drawtext=${style}:expansion=none:${file(1)}:enable='gte(t\\,0.000)*lt(t\\,179.349)'`,
    `drawtext=${style}:expansion=none:${file(2)}:enable='gte(t\\,179.349)*lt(t\\,359.786)'`,
    `drawtext=${style}:expansion=none:${file(3)}:enable='gte(t\\,359.786)'`, // son parça açık uçlu
  ].join(','));
});

test('overlay: reload yok — dosyalar açılışta bir kez okunur', () => {
  assert.doesNotMatch(vf(withOverlay()), /reload/);
});

test('overlay yoksa (enabled: false) ya da parça listesi verilmezse sadece scale kalır', () => {
  assert.equal(vf(withOverlay({ overlay: null })), 'scale=1280:720');
  assert.equal(vf(withOverlay({ overlayTexts: undefined })), 'scale=1280:720');
  assert.equal(vf(withOverlay({ overlayTexts: [] })), 'scale=1280:720');
});

test('overlay konumları: sağ taraf metin genişliğine göre hizalanır', () => {
  const at = (position) => vf(withOverlay({ overlay: { ...OVERLAY, position } }));
  assert.match(at('bottom-right'), /:x=w-tw-40:y=h-80:/);
  assert.match(at('top-left'), /:x=40:y=40:/);
  assert.match(at('top-right'), /:x=w-tw-40:y=40:/);
});

test('overlay.bottomOffset alt konumların y değerini belirler, üst konumları etkilemez', () => {
  const at = (position) => vf(withOverlay({ overlay: { ...OVERLAY, position, bottomOffset: 140 } }));
  assert.match(at('bottom-left'), /:x=40:y=h-140:/);
  assert.match(at('bottom-right'), /:x=w-tw-40:y=h-140:/);
  assert.match(at('top-left'), /:x=40:y=40:/);
});

test('overlay.bottomOffset yoksa (eski config) 80 — mevcut davranış korunur', () => {
  const { bottomOffset, ...withoutOffset } = { ...OVERLAY, bottomOffset: 140 };
  assert.match(vf(withOverlay({ overlay: withoutOffset })), /:x=40:y=h-80:/);
});

test('geçersiz bottomOffset FfmpegEncoder kurulurken reddedilir', () => {
  for (const bad of [0, -20, 'yüz']) {
    assert.throws(
      () => new FfmpegEncoder({ profile, backgroundPath: BG, output: LOCAL, overlay: { ...OVERLAY, bottomOffset: bad } }),
      /overlay.bottomOffset pozitif sayı olmalı/,
    );
  }
});

test('desteklenmeyen konum FfmpegEncoder kurulurken reddedilir', () => {
  assert.throws(
    () => new FfmpegEncoder({ profile, backgroundPath: BG, output: LOCAL, overlay: { ...OVERLAY, position: 'ortala' } }),
    /desteklenmeyen overlay.position "ortala"/,
  );
});

test('FfmpegEncoder start\'taki overlayTexts\'i argümanlara geçirir', () => {
  const { spawnFn, calls } = fakeSpawn();
  new FfmpegEncoder({ profile, backgroundPath: BG, output: LOCAL, overlay: OVERLAY, spawnFn })
    .start({ playlistPath: 'p', runNumber: 1, overlayTexts: TEXTS });
  assert.equal(vf(calls[0].args).split(',drawtext=').length, 1 + TEXTS.length);
});

test('tek parça modunda -shortest yok (PLAN.md Faz 1 notu)', () => {
  assert.ok(!buildFfmpegArgs({ profile, backgroundPath: BG, audioPath: AUDIO, output: LOCAL }).includes('-shortest'));
});

test('ses girişi olarak tam olarak biri verilmeli', () => {
  assert.throws(() => buildFfmpegArgs({ profile, backgroundPath: BG, output: LOCAL }), /tam olarak biri/);
  assert.throws(() => buildFfmpegArgs({ profile, backgroundPath: BG, audioPath: AUDIO, playlistPath: 'p', output: LOCAL }), /tam olarak biri/);
});

test('runNumber verilirse local çıktı tura göre ayrı dosya; rtmp hedefi değişmez', () => {
  const args = buildFfmpegArgs({ profile, backgroundPath: BG, playlistPath: 'p', runNumber: 3, output: LOCAL });
  assert.equal(args.at(-1), 'C:/Users/Aybuke Yeni/Desktop/Youtube/YT Stream System/runtime/out-3.flv');
  const rtmp = buildFfmpegArgs({ profile, backgroundPath: BG, playlistPath: 'p', runNumber: 3, output: { mode: 'rtmp', streamKey: 'k' } });
  assert.equal(rtmp.at(-1), 'rtmps://a.rtmps.youtube.com/live2/k');
});

test('boşluklu yollar tek argüman olarak kalır', () => {
  const args = buildFfmpegArgs({ profile, backgroundPath: BG, audioPath: AUDIO, output: LOCAL });
  assert.ok(args.includes(BG));
  assert.ok(args.includes(AUDIO));
});

test('rtmp modunda son argüman YouTube RTMPS URL', () => {
  const args = buildFfmpegArgs({ profile, backgroundPath: BG, audioPath: AUDIO, output: { mode: 'rtmp', streamKey: 'abcd-1234' } });
  assert.equal(args.at(-1), 'rtmps://a.rtmps.youtube.com/live2/abcd-1234');
  assert.deepEqual(args.slice(-2, -1), ['flv']);
});

test('ilerleme satırı parse edilir (gerçek ffmpeg 9.0.1 çıktısı)', () => {
  const p = parseProgressLine('frame= 2786 fps= 24 q=3.0 size=   19200KiB time=00:01:56.00 bitrate=1355.9kbits/s speed=1.01x elapsed=0:01:55.34    ');
  assert.deepEqual(p, { frame: 2786, fps: 24, bitrateKbps: 1355.9, speed: 1.01 });
});

test('N/A değerler null olur, ilerleme olmayan satır null döner', () => {
  assert.deepEqual(
    parseProgressLine('frame=    0 fps=0.0 q=0.0 size=       0KiB time=N/A bitrate=N/A speed=N/A elapsed=0:00:00.50'),
    { frame: 0, fps: 0, bitrateKbps: null, speed: null },
  );
  assert.equal(parseProgressLine('Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'x.mp4\':'), null);
});

test('FfmpegEncoder bir Encoder', () => {
  assert.ok(new FfmpegEncoder({ profile, backgroundPath: BG, output: LOCAL }) instanceof Encoder);
});

test('stderr satır satır parse edilip log olarak yayılır, exit bildirilir', async () => {
  const { spawnFn, calls } = fakeSpawn();
  const enc = new FfmpegEncoder({ profile, backgroundPath: BG, output: LOCAL, spawnFn });
  const logs = [];
  enc.on('log', (e) => logs.push(e));
  const exited = new Promise((resolve) => enc.on('exit', (code, signal) => resolve({ code, signal })));

  enc.start({ audioPath: AUDIO });
  const { child, cmd } = calls[0];
  assert.equal(cmd, 'ffmpeg');
  // İlerleme satırları \r ile gelir, parça parça bölünmüş olabilir.
  child.stderr.write('Stream mapping:\r\nframe=  117 fps= 23 q=38.0 size=    1536KiB time=00:00:04.79 bitr');
  child.stderr.write('ate=2626.0kbits/s speed=0.956x\rframe=  215 fps= 21 q=35.0 size= 2816KiB bitrate=2599.3kbits/s speed=0.885x');
  child.stderr.end();
  await new Promise((r) => setImmediate(r));
  child.emit('close', 0, null);

  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(enc.running, false);
  assert.deepEqual(logs.map((l) => l.kind), ['command', 'stderr', 'progress', 'progress']);
  assert.equal(logs[2].speed, 0.956);
  assert.equal(logs[3].frame, 215); // sondaki yarım satır close'ta işlenir
});

test('rtmp stream key command logunda maskelenir', () => {
  const { spawnFn, calls } = fakeSpawn();
  const enc = new FfmpegEncoder({ profile, backgroundPath: BG, output: { mode: 'rtmp', streamKey: 'gizli-key-123' }, spawnFn });
  const logs = [];
  enc.on('log', (e) => logs.push(e));
  enc.start({ audioPath: AUDIO });
  assert.equal(logs[0].args.at(-1), 'rtmps://a.rtmps.youtube.com/live2/***');
  assert.equal(calls[0].args.at(-1), 'rtmps://a.rtmps.youtube.com/live2/gizli-key-123');
  assert.ok(!JSON.stringify(logs).includes('gizli-key-123'));
});

test('rtmp stream key ffmpeg stderr satırlarında da maskelenir', async () => {
  const { spawnFn, calls } = fakeSpawn();
  const enc = new FfmpegEncoder({ profile, backgroundPath: BG, output: { mode: 'rtmp', streamKey: 'gizli-key-123' }, spawnFn });
  const logs = [];
  enc.on('log', (e) => logs.push(e));
  enc.start({ audioPath: AUDIO });
  const { child } = calls[0];
  // ffmpeg 9.0.1'in gerçekte yazdığı çıktı başlığı biçimi
  child.stderr.write("Output #0, flv, to 'rtmps://a.rtmps.youtube.com/live2/gizli-key-123':\n");
  child.stderr.end();
  await new Promise((r) => setImmediate(r));
  child.emit('close', 0, null);
  assert.equal(logs[1].line, "Output #0, flv, to 'rtmps://a.rtmps.youtube.com/live2/***':");
  assert.ok(!JSON.stringify(logs).includes('gizli-key-123'));
});

test('çalışırken ikinci start hata fırlatır', () => {
  const { spawnFn } = fakeSpawn();
  const enc = new FfmpegEncoder({ profile, backgroundPath: BG, output: LOCAL, spawnFn });
  enc.start({ audioPath: AUDIO });
  assert.throws(() => enc.start({ audioPath: AUDIO }), /zaten çalışıyor/);
});

test('stop: önce q yazar, ffmpeg kapanınca resolve olur', async () => {
  const { spawnFn, calls } = fakeSpawn();
  const enc = new FfmpegEncoder({ profile, backgroundPath: BG, output: LOCAL, spawnFn });
  enc.start({ audioPath: AUDIO });
  const { child } = calls[0];
  const stopped = enc.stop();
  await new Promise((r) => setImmediate(r));
  assert.equal(child.written, 'q');
  child.emit('close', 0, null);
  await stopped;
  assert.equal(child.killed, false);
});

test('stop: q\'ya yanıt yoksa süre dolunca SIGTERM (SIGKILL\'e gerek kalmaz)', async () => {
  const { spawnFn, calls } = fakeSpawn();
  const enc = new FfmpegEncoder({
    profile, backgroundPath: BG, output: LOCAL, spawnFn, stopTimeoutMs: 20, killTimeoutMs: 20,
  });
  const logs = [];
  enc.on('log', (e) => logs.push(e));
  enc.start({ audioPath: AUDIO });
  await enc.stop();
  const { child } = calls[0];
  assert.equal(child.killed, true);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.ok(logs.some((l) => l.kind === 'error' && /SIGTERM/.test(l.message)));
  // SIGTERM'e kapandı: SIGKILL timer'ı iptal edilmiş olmalı (geç tetiklenmesin).
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('stop: SIGTERM yutulursa SIGKILL\'e yükseltilir', async () => {
  const { spawnFn, calls } = fakeSpawn();
  const enc = new FfmpegEncoder({
    profile, backgroundPath: BG, output: LOCAL, spawnFn, stopTimeoutMs: 10, killTimeoutMs: 10,
  });
  const logs = [];
  enc.on('log', (e) => logs.push(e));
  enc.start({ audioPath: AUDIO });
  calls[0].child.ignoreSignals = ['SIGTERM'];
  await enc.stop();
  assert.deepEqual(calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(logs.some((l) => l.kind === 'error' && /SIGKILL gönderiliyor/.test(l.message)));
  assert.equal(enc.running, false); // SIGKILL kapattı → 'close' geldi → child temizlendi
});

// En kritik senaryo: eski kod bu durumda sonsuza kadar pending kalıyordu ve
// kapanış zinciri askıda kalıp systemd'nin node'u SIGKILL etmesine yol açıyordu.
test('stop: SIGKILL de yutulursa promise yine resolve olur ve uyarı loglanır', async () => {
  const { spawnFn, calls } = fakeSpawn();
  const enc = new FfmpegEncoder({
    profile, backgroundPath: BG, output: LOCAL, spawnFn, stopTimeoutMs: 10, killTimeoutMs: 10,
  });
  const logs = [];
  enc.on('log', (e) => logs.push(e));
  enc.start({ audioPath: AUDIO });
  calls[0].child.ignoreSignals = ['SIGTERM', 'SIGKILL'];
  await enc.stop(); // askıda kalmamalı
  assert.deepEqual(calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(logs.some((l) => l.kind === 'error' && /SIGKILL'den sonra da kapanmadı/.test(l.message)));
  // running=true kalır: start() ikinci bir ffmpeg başlatmayı reddetsin (çift yayın olmasın).
  assert.equal(enc.running, true);
  assert.throws(() => enc.start({ audioPath: AUDIO }), /zaten çalışıyor/);
});

test('çalışmıyorken stop hemen resolve olur', async () => {
  const enc = new FfmpegEncoder({ profile, backgroundPath: BG, output: LOCAL });
  await enc.stop();
});

test('Encoder soyut metotları implement edilmemişse hata verir', () => {
  const e = new Encoder();
  assert.throws(() => e.start({}), /implement edilmemiş/);
  assert.throws(() => e.stop(), /implement edilmemiş/);
});

test('FfmpegEncoder start\'ta verilen backgroundPath kurulumdakini ezer (albüm başına arkaplan)', () => {
  const { spawnFn, calls } = fakeSpawn();
  const enc = new FfmpegEncoder({ profile, backgroundPath: BG, output: LOCAL, spawnFn });
  enc.start({ playlistPath: 'p', runNumber: 1, backgroundPath: 'C:/ms/A/background.mp4' });
  assert.equal(calls[0].args[calls[0].args.indexOf('-stream_loop') + 3], 'C:/ms/A/background.mp4');
});

// ── Arkaplan rotasyonu (çoğul arkaplan) ──────────────────────────────────────
const BGLIST = 'C:/Users/Aybuke Yeni/Desktop/Youtube/YT Stream System/runtime/backgrounds.txt';

test('rotasyon modu: video girişi -stream_loop -1 -f concat -safe 0 -i <liste>', () => {
  const args = buildFfmpegArgs({
    profile, backgroundPlaylistPath: BGLIST, playlistPath: 'p', output: LOCAL,
  });
  assert.deepEqual(args.slice(0, 10), [
    '-hide_banner', '-y',
    '-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', BGLIST,
  ]);
});

test('rotasyon modu encode parametrelerini değiştirmez', () => {
  const single = buildFfmpegArgs({ profile, backgroundPath: BG, playlistPath: 'p', output: LOCAL });
  const rotated = buildFfmpegArgs({ profile, backgroundPlaylistPath: BGLIST, playlistPath: 'p', output: LOCAL });
  const encodePart = (a) => a.slice(a.indexOf('-map'));
  assert.deepEqual(encodePart(rotated), encodePart(single));
});

test('video girişi olarak tek dosya ve liste birlikte verilemez', () => {
  assert.throws(() => buildFfmpegArgs({
    profile, backgroundPath: BG, backgroundPlaylistPath: BGLIST, playlistPath: 'p', output: LOCAL,
  }), /tam olarak biri/);
  assert.throws(() => buildFfmpegArgs({ profile, playlistPath: 'p', output: LOCAL }), /tam olarak biri/);
});

test('start: rotasyon listesi verilince kurulumdaki backgroundPath kullanılmaz', () => {
  const { spawnFn, calls } = fakeSpawn();
  const encoder = new FfmpegEncoder({ profile, backgroundPath: BG, output: LOCAL, spawnFn });
  encoder.start({ playlistPath: 'p', runNumber: 1, backgroundPlaylistPath: BGLIST });
  const { args } = calls[0];
  assert.ok(args.includes(BGLIST));
  assert.ok(!args.includes(BG), 'tek dosya yolu rotasyon modunda argümanlara girmemeli');
  assert.equal(args.filter((a) => a === '-i').length, 2, 'tam iki giriş olmalı: arkaplan + ses');
});

// ── Pomodoro ─────────────────────────────────────────────────────────────────
const POMO = {
  statusTexts: [{ textFile: '/ov/pomodoro-001.txt', start: 0, end: 600 }, { textFile: '/ov/pomodoro-002.txt', start: 600, end: null }],
  labelTextFile: '/ov/pomodoro-label.txt',
  fontSize: 56,
  statusPosition: 'center',
  labelPosition: 'top-right',
};

test('pomodoro kapalıyken komut bugünküyle BİREBİR aynı (regresyon kalkanı)', () => {
  const withoutArgs = buildFfmpegArgs({ profile, backgroundPath: BG, playlistPath: 'p', output: LOCAL, overlay: OVERLAY, overlayTexts: TEXTS });
  const explicitOff = buildFfmpegArgs({ profile, backgroundPath: BG, playlistPath: 'p', output: LOCAL, overlay: OVERLAY, overlayTexts: TEXTS, pomodoro: null, beepTimes: [] });
  assert.deepEqual(explicitOff, withoutArgs);
  assert.ok(!withoutArgs.includes('-filter_complex'), 'bip yokken filter_complex kurulmamalı');
  assert.ok(withoutArgs.includes('-vf'));
});

test('pomodoro açık: durum yazıları kendi aralığında, tür etiketi sürekli', () => {
  const args = buildFfmpegArgs({ profile, backgroundPath: BG, playlistPath: 'p', output: LOCAL, overlay: OVERLAY, overlayTexts: [], pomodoro: POMO });
  const vf = args[args.indexOf('-vf') + 1];
  // Ters bolu iceren enable ifadesi: duz metin karsilastirmasi (regex kacisi kirilgan)
  assert.ok(vf.includes("textfile='/ov/pomodoro-001.txt':enable='gte(t\\,0.000)*lt(t\\,600.000)'"));
  assert.ok(vf.includes("textfile='/ov/pomodoro-002.txt':enable='gte(t\\,600.000)'"));
  // Etiket son drawtext ve enable TASIMIYOR (hep ekranda)
  assert.ok(vf.endsWith("textfile='/ov/pomodoro-label.txt'"));
  assert.ok(vf.includes('fontsize=56:fontcolor=white:x=(w-tw)/2:y=(h-th)/2'), 'durum ortada ve buyuk punto');
  assert.ok(vf.includes('fontsize=28:fontcolor=white:x=w-tw-40:y=40'), 'etiket sag ustte, normal punto');
});

test('pomodoro ve parça başlığı aynı anda, ayrı drawtext olarak', () => {
  const args = buildFfmpegArgs({ profile, backgroundPath: BG, playlistPath: 'p', output: LOCAL, overlay: OVERLAY, overlayTexts: TEXTS, pomodoro: POMO });
  const vf = args[args.indexOf('-vf') + 1];
  assert.ok(vf.includes('track-'), 'parça başlığı korunmalı');
  assert.ok(vf.includes('pomodoro-001.txt'));
  assert.equal((vf.match(/drawtext=/g) || []).length, TEXTS.length + 3, 'parça sayısı + 2 durum + 1 etiket');
});

test('bip varsa lavfi sine girişi eklenir ve ses amix ile karışır', () => {
  const args = buildFfmpegArgs({
    profile, backgroundPath: BG, playlistPath: 'p', output: LOCAL,
    overlay: OVERLAY, overlayTexts: [], pomodoro: POMO, beepTimes: [10.5, 11.1],
  });
  assert.ok(args.includes('lavfi'));
  assert.ok(args.some((a) => a.startsWith('sine=frequency=880')));
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /asplit=2\[p0\]\[p1\]/);
  assert.match(fc, /\[p0\]adelay=10500\|10500\[d0\]/);
  assert.match(fc, /\[p1\]adelay=11100\|11100\[d1\]/);
  assert.match(fc, /\[1:a\]\[d0\]\[d1\]amix=inputs=3:duration=first:normalize=0\[a\]/);
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '[v]', '-map', '[a]']);
  // Video zinciri de filter_complex'e taşınmış olmalı, -vf kalmamalı
  assert.ok(!args.includes('-vf'));
  assert.match(fc, /^\[0:v\]scale=1280:720/);
});

test('bip yokken pomodoro yazıları yine de görünür (-vf yolu korunur)', () => {
  const args = buildFfmpegArgs({ profile, backgroundPath: BG, playlistPath: 'p', output: LOCAL, overlay: OVERLAY, overlayTexts: [], pomodoro: POMO, beepTimes: [] });
  assert.ok(args.includes('-vf'));
  assert.ok(!args.includes('-filter_complex'));
  assert.ok(args[args.indexOf('-vf') + 1].includes('pomodoro-001.txt'));
});

test('mola arkaplanı: ikinci video girişi overlay ile bindirilir, yazılar üstte kalır', () => {
  const args = buildFfmpegArgs({
    profile, backgroundPath: BG, playlistPath: 'p', output: LOCAL,
    overlay: OVERLAY, overlayTexts: [], pomodoro: POMO,
    breakBackground: { path: '/runtime/break.mp4', windows: [{ start: 600, end: null }] },
  });
  // Giriş sırası: 0 arkaplan, 1 müzik, 2 mola klibi (sonsuz döngüde)
  assert.deepEqual(args.slice(args.lastIndexOf('-stream_loop'), args.lastIndexOf('-stream_loop') + 4),
    ['-stream_loop', '-1', '-i', '/runtime/break.mp4']);
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.ok(fc.startsWith('[2:v]scale=1280:720,setsar=1[brk];'), 'mola klibi ölçeklenip SAR sabitlenmeli');
  assert.ok(fc.includes("[bg][brk]overlay=enable='gte(t\\,600.000)'[comp]"));
  // Yazılar overlay'den SONRA: mola görselinin üstünde görünsünler
  assert.ok(fc.indexOf('[comp]drawtext') > fc.indexOf('overlay='));
  // Bip yoksa ses doğrudan müzikten map'lenir
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '[v]', '-map', '1:a']);
});

test('mola arkaplanı + bip birlikte: giriş indeksleri kaymaz', () => {
  const args = buildFfmpegArgs({
    profile, backgroundPath: BG, playlistPath: 'p', output: LOCAL,
    overlay: OVERLAY, overlayTexts: [], pomodoro: POMO, beepTimes: [12.5],
    breakBackground: { path: '/runtime/break.mp4', windows: [{ start: 600, end: null }] },
  });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.ok(fc.includes('[2:v]scale'), 'mola klibi 2. giriş');
  assert.ok(fc.includes('[3:a]volume='), 'bip 3. giriş');
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '[v]', '-map', '[a]']);
});

test('mola penceresi yoksa mola girişi hiç eklenmez', () => {
  const args = buildFfmpegArgs({
    profile, backgroundPath: BG, playlistPath: 'p', output: LOCAL,
    overlay: OVERLAY, overlayTexts: [], pomodoro: POMO,
    breakBackground: { path: '/runtime/break.mp4', windows: [] },
  });
  assert.ok(!args.includes('/runtime/break.mp4'));
  assert.ok(args.includes('-vf'), 'ek giriş yoksa eski -vf yolu korunur');
});

test('iki mola penceresi tek enable ifadesinde toplanır', () => {
  const args = buildFfmpegArgs({
    profile, backgroundPath: BG, playlistPath: 'p', output: LOCAL,
    overlay: OVERLAY, overlayTexts: [], pomodoro: POMO,
    breakBackground: { path: '/b.mp4', windows: [{ start: 600, end: 1200 }, { start: 4200, end: null }] },
  });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.ok(fc.includes("overlay=enable='gte(t\\,600.000)*lt(t\\,1200.000)+gte(t\\,4200.000)'"));
});
