const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, ConfigError } = require('../../src/config/load-config');

const BASE = {
  paths: { music: './music', background: './assets/background.mp4', runtime: './runtime' },
  profile: { width: 1280, height: 720, fps: 24, videoBitrate: '2500k', audioBitrate: '160k', preset: 'veryfast' },
  queue: { mode: 'shuffle', batchSize: 50 },
  overlay: { enabled: true, fontFile: 'C:/Windows/Fonts/arial.ttf', fontSize: 28, position: 'bottom-left', bottomOffset: 80 },
  output: { mode: 'local', localPath: './runtime/out.flv' },
};
const clone = () => JSON.parse(JSON.stringify(BASE));

// Her senaryo kendi geçici kök dizininde: config.json (+ istenirse .env) yazılır.
function load({ config = BASE, envFile = null, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-config-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
    if (envFile !== null) fs.writeFileSync(path.join(dir, '.env'), envFile);
    return { dir, result: loadConfig({ rootDir: dir, env }) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function problemsOf(opts) {
  try {
    load(opts);
  } catch (err) {
    assert.ok(err instanceof ConfigError, `beklenmeyen hata tipi: ${err}`);
    return err.problems;
  }
  assert.fail('ConfigError bekleniyordu');
}

test('local mod: yollar kök dizine göre mutlak olur', () => {
  const { dir, result } = load();
  assert.equal(result.paths.music, path.join(dir, 'music'));
  assert.equal(result.paths.background, path.join(dir, 'assets', 'background.mp4'));
  assert.deepEqual(result.output, { mode: 'local', localPath: path.join(dir, 'runtime', 'out.flv') });
  assert.deepEqual(result.profile, BASE.profile);
  assert.deepEqual(result.queue, BASE.queue);
  assert.deepEqual(result.overlay, BASE.overlay); // fontFile kök dizine göre çözülmez
});

test('rtmp: .env yoksa ya da anahtar boşsa açık hata', () => {
  const config = clone();
  config.output = { mode: 'rtmp' };
  assert.match(problemsOf({ config }).join(), /YOUTUBE_STREAM_KEY boş/);
  assert.match(problemsOf({ config, envFile: 'YOUTUBE_STREAM_KEY=\n' }).join(), /YOUTUBE_STREAM_KEY boş/);
});

test('rtmp: anahtar .env\'den ya da ortam değişkeninden okunur, ortam değişkeni önceliklidir', () => {
  const config = clone();
  config.output = { mode: 'rtmp' };
  assert.deepEqual(load({ config, envFile: 'YOUTUBE_STREAM_KEY=dosya-key\n' }).result.output, { mode: 'rtmp', streamKey: 'dosya-key' });
  assert.equal(load({ config, env: { YOUTUBE_STREAM_KEY: 'env-key' } }).result.output.streamKey, 'env-key');
  assert.equal(
    load({ config, envFile: 'YOUTUBE_STREAM_KEY=dosya-key\n', env: { YOUTUBE_STREAM_KEY: 'env-key' } }).result.output.streamKey,
    'env-key',
  );
});

test('hata mesajı stream key\'i içermez', () => {
  const config = clone();
  config.output = { mode: 'rtmp' };
  delete config.paths.music;
  try {
    load({ config, envFile: 'YOUTUBE_STREAM_KEY=gizli-key-123\n' });
    assert.fail('hata bekleniyordu');
  } catch (err) {
    assert.ok(!err.message.includes('gizli-key-123'));
  }
});

test('geçersiz output.mode reddedilir', () => {
  const config = clone();
  config.output.mode = 'rtmps';
  assert.match(problemsOf({ config }).join(), /"output.mode" "rtmps"/);
});

test('local modda localPath zorunlu', () => {
  const config = clone();
  delete config.output.localPath;
  assert.match(problemsOf({ config }).join(), /output.localPath/);
});

test('eksik alan ve yanlış tip birlikte listelenir', () => {
  const config = clone();
  delete config.paths.background;
  config.profile.fps = '24';
  assert.deepEqual(problemsOf({ config }), [
    '"paths.background" eksik ya da geçersiz',
    '"profile.fps" eksik ya da geçersiz',
  ]);
});

test('queue bölümü eksikse ya da alanlar yanlış tipteyse listelenir', () => {
  const config = clone();
  delete config.queue;
  assert.match(problemsOf({ config }).join(), /"queue" bölümü eksik/);
  const c2 = clone();
  c2.queue.batchSize = '50';
  c2.queue.mode = '';
  assert.deepEqual(problemsOf({ config: c2 }), [
    '"queue.mode" eksik ya da geçersiz',
    '"queue.batchSize" eksik ya da geçersiz',
  ]);
});

test('bozuk JSON ve eksik dosya ConfigError verir', () => {
  assert.match(problemsOf({ config: '{ paths: ' }).join(), /geçerli JSON değil/);
  assert.throws(
    () => loadConfig({ rootDir: os.tmpdir(), configFile: 'yok-boyle-bir-config-7f3a.json' }),
    (err) => err instanceof ConfigError && /dosya okunamadı: ENOENT/.test(err.message),
  );
});

test('overlay bölümü eksikse ya da alanlar yanlış tipteyse listelenir', () => {
  const missing = clone();
  delete missing.overlay;
  assert.deepEqual(problemsOf({ config: missing }), ['"overlay" bölümü eksik']);

  const wrong = clone();
  wrong.overlay = { enabled: 'evet', fontFile: '', fontSize: '28', position: 'bottom-left' };
  assert.deepEqual(problemsOf({ config: wrong }), [
    '"overlay.enabled" eksik ya da geçersiz',
    '"overlay.fontFile" eksik ya da geçersiz',
    '"overlay.fontSize" eksik ya da geçersiz',
  ]);

  // bottomOffset isteğe bağlı: yokken sorun değil, varken sayı olmalı.
  const noOffset = clone();
  delete noOffset.overlay.bottomOffset;
  assert.equal(load({ config: noOffset }).result.overlay.bottomOffset, undefined);

  const badOffset = clone();
  badOffset.overlay.bottomOffset = '140';
  assert.deepEqual(problemsOf({ config: badOffset }), ['"overlay.bottomOffset" sayı olmalı']);
});

test('albüm modu: paths.albums varsa music/background gerekmez, yol mutlak olur', () => {
  const config = clone();
  config.paths = { albums: './music-source', runtime: './runtime' };
  const { dir, result } = load({ config });
  assert.deepEqual(result.paths, { albums: path.join(dir, 'music-source'), runtime: path.join(dir, 'runtime') });
});

test('albüm modu: paths.albums boşsa hata', () => {
  const config = clone();
  config.paths = { albums: '', runtime: './runtime' };
  assert.deepEqual(problemsOf({ config }), ['"paths.albums" eksik ya da geçersiz']);
});

// ── broadcast bölümü (Faz 9 Aşama 2) ────────────────────────────────────────
// OPSİYONEL olmak zorunda: VPS'teki mevcut config.json'larda bu bölüm yok ve
// zorunlu yapmak ÇALIŞAN YAYINI config hatasıyla düşürürdü.
const broadcastProblems = (broadcast) => {
  const config = clone();
  config.broadcast = broadcast;
  return problemsOf({ config }).join(' | ');
};

test('broadcast bölümü yoksa varsayılanlar gelir (mevcut config.json kırılmaz)', () => {
  const { result } = load();
  assert.equal(result.broadcast.privacyStatus, 'unlisted'); // ilk broadcast herkese açık olmasın
  assert.equal(result.broadcast.streamId, null); // null → key'den çözülür
  assert.equal(result.broadcast.categoryId, '10');
  assert.ok(result.broadcast.title.length > 0);
});

test('broadcast alanları config dosyasından okunur ve varsayılanlarla birleşir', () => {
  const config = clone();
  config.broadcast = { title: 'Özel Başlık', privacyStatus: 'public' };
  const { result } = load({ config });
  assert.equal(result.broadcast.title, 'Özel Başlık');
  assert.equal(result.broadcast.privacyStatus, 'public');
  assert.equal(result.broadcast.categoryId, '10'); // verilmeyen alan varsayılandan
});

test('geçersiz privacyStatus reddedilir (sessizce private yayına düşmesin)', () => {
  assert.match(broadcastProblems({ privacyStatus: 'herkese-acik' }), /broadcast\.privacyStatus/);
});

test('boş broadcast.title reddedilir', () => {
  assert.match(broadcastProblems({ title: '   ' }), /broadcast\.title/);
});

test('broadcast.streamId metin ya da null olmalı', () => {
  assert.match(broadcastProblems({ streamId: 42 }), /broadcast\.streamId/);
  const config = clone();
  config.broadcast = { streamId: 'sabit-id' };
  assert.equal(load({ config }).result.broadcast.streamId, 'sabit-id');
});

test('broadcast nesne değilse reddedilir', () => {
  assert.match(broadcastProblems('evet'), /"broadcast" bölümü nesne olmalı/);
});

test('broadcast.thumbnailPath varsayılanı kök dizine göre mutlaklaşır', () => {
  const { dir, result } = load();
  // Servis cwd'den bağımsız çalışıyor: göreli yol systemd altında yanlış yere bakardı.
  assert.equal(result.broadcast.thumbnailPath, path.join(dir, 'assets', 'thumbnail.jpg'));
});

test('broadcast.thumbnailPath null verilebilir (küçük resim hiç denenmez)', () => {
  const config = clone();
  config.broadcast = { thumbnailPath: null };
  assert.equal(load({ config }).result.broadcast.thumbnailPath, null);
});

test('broadcast.thumbnailPath metin ya da null olmalı', () => {
  assert.match(broadcastProblems({ thumbnailPath: 42 }), /broadcast\.thumbnailPath/);
  const config = clone();
  config.broadcast = { thumbnailPath: './assets/ozel.png' };
  const { dir, result } = load({ config });
  assert.equal(result.broadcast.thumbnailPath, path.join(dir, 'assets', 'ozel.png'));
});
