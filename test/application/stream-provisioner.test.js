const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StreamProvisioner } = require('../../src/application/stream-provisioner');
const { StreamManager } = require('../../src/application/stream-manager');
const { StreamInstances } = require('../../src/infrastructure/stream-instances');
const { StreamPlanStore } = require('../../src/infrastructure/stream-plan-store');
const { writeFileAtomic } = require('../../src/infrastructure/atomic-file');

const KEY = 'abcd-efgh-ijkl-mnop-qrst';
const ALBUMS = [
  { name: 'mimi', trackPaths: ['/m/mimi/a.m4a', '/m/mimi/b.m4a'], backgrounds: ['/m/mimi/bg.mp4'], trackCount: 2 },
  { name: 'zen', trackPaths: ['/m/zen/c.m4a'], backgrounds: ['/m/zen/bg.mp4'], trackCount: 1 },
];

// Tüm bağımlılıkları kaydeden sahte kurulum.
function setup({ existing = [], running = 1, max = 2, createFails = false, provisionFails = null } = {}) {
  const calls = [];
  const logs = [];
  const instances = {
    exists: (n) => existing.includes(n),
    runningCount: () => running,
    provision: (n) => {
      calls.push(['provision', n]);
      if (provisionFails === calls.filter((c) => c[0] === 'provision').length) throw new Error('add-stream.sh başarısız');
    },
    writeKey: (n, k) => calls.push(['writeKey', n, k]),
    patchConfig: (n, fn) => { const c = fn({ pomodoro: { enabled: true, type: '50+10' }, broadcast: { latencyPreference: 'normal' } }); calls.push(['patchConfig', n, c]); },
  };
  const p = new StreamProvisioner({
    createStream: async ({ title }) => { calls.push(['createStream', title]); if (createFails) throw new Error('kota doldu'); return { id: 'strm-1', streamKey: KEY }; },
    instances,
    writePlan: (n, plan) => calls.push(['writePlan', n, plan]),
    albums: () => ALBUMS,
    covers: () => ['/c/a.jpg'],
    goLive: async (n) => { calls.push(['goLive', n]); return { action: 'accepted' }; },
    maxStreams: max,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  return { p, calls, logs };
}

const GOOD = {
  name: 'Lofi2', title: ' Gece Yayını ', description: 'a\r\nb', privacy: 'public', cover: '/c/a.jpg', albums: ['zen', 'mimi'], goLiveNow: true,
};
const names = (calls) => calls.map((c) => c[0]);
const flush = () => new Promise((r) => setImmediate(r));

test('mutlu yol: sıra stream → kurulum → key/ayar/plan → başlatma → canlıya al; key SIZMAZ', async () => {
  const { p, calls, logs } = setup();
  const result = await p.create(GOOD);
  await flush();
  assert.equal(result.ok, true);
  assert.equal(result.name, 'lofi2');
  assert.deepEqual(names(calls), ['createStream', 'provision', 'writeKey', 'patchConfig', 'writePlan', 'provision', 'goLive']);

  // Ayarlar config'e doğru yazılır; Pomodoro kapalı (hafif varsayılan), diğer alanlar korunur.
  const cfg = calls.find((c) => c[0] === 'patchConfig')[2];
  assert.deepEqual(cfg.broadcast, { latencyPreference: 'normal', title: 'Gece Yayını', description: 'a\nb', privacyStatus: 'public' });
  assert.equal(cfg.pomodoro.enabled, false);
  assert.equal(cfg.pomodoro.type, '50+10');

  // Plan: albüm sırası seçim sırası, parça yolları katalogdan, pomodoro kapalı.
  const plan = calls.find((c) => c[0] === 'writePlan')[2];
  assert.equal(plan.cover, '/c/a.jpg');
  assert.deepEqual(plan.music.albums.map((a) => a.name), ['zen', 'mimi']);
  assert.deepEqual(plan.music.albums[1].trackPaths, ['/m/mimi/a.m4a', '/m/mimi/b.m4a']);
  assert.equal(plan.pomodoro.enabled, false);
  assert.equal(plan.broadcast.title, 'Gece Yayını');

  // Key yalnızca writeKey'e gitti; ne dönüş değerinde ne mesajda ne logda var.
  assert.equal(calls.find((c) => c[0] === 'writeKey')[2], KEY);
  const everythingElse = JSON.stringify([result, logs, calls.filter((c) => c[0] !== 'writeKey')]);
  assert.ok(!everythingElse.includes(KEY), 'stream key çıktıya sızmamalı');
});

test('goLiveNow kapalıysa canlıya alma tetiklenmez', async () => {
  const { p, calls } = setup();
  const r = await p.create({ ...GOOD, goLiveNow: false });
  await flush();
  assert.equal(r.ok, true);
  assert.ok(!names(calls).includes('goLive'));
  assert.match(r.message, /Canlıya Al/);
});

test('albüm seçimi boşsa tüm kütüphane (plan albümsüz), kapak boşsa null', async () => {
  const { p, calls } = setup();
  await p.create({ ...GOOD, albums: [], cover: '' });
  const plan = calls.find((c) => c[0] === 'writePlan')[2];
  assert.deepEqual(plan.music.albums, []);
  assert.equal(plan.cover, null);
});

test('doğrulama hataları HİÇBİR yan etki üretmez (stream bile açılmaz)', async () => {
  const cases = [
    [{ ...GOOD, name: 'a b' }, /yayın adı/],
    [{ ...GOOD, name: 'youtube' }, /yayın adı/],
    [{ ...GOOD, title: '   ' }, /başlık boş/],
    [{ ...GOOD, title: 'x'.repeat(101) }, /en fazla 100/],
    [{ ...GOOD, description: 'x'.repeat(5001) }, /en fazla 5000/],
    [{ ...GOOD, privacy: 'herkes' }, /görünürlük/],
    [{ ...GOOD, cover: '/etc/passwd' }, /kapak listede yok/],
    [{ ...GOOD, albums: ['olmayan'] }, /listede olmayan albüm/],
  ];
  for (const [input, re] of cases) {
    const { p, calls } = setup();
    const r = await p.create(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.match(r.error, re);
    assert.deepEqual(calls, [], 'doğrulama başarısızken hiçbir şey çağrılmamalı');
  }
});

test('ad zaten kullanımdaysa ve kapasite doluysa reddedilir, stream açılmaz', async () => {
  const taken = setup({ existing: ['lofi2'] });
  assert.match((await taken.p.create(GOOD)).error, /zaten kullanılıyor/);
  const full = setup({ running: 2, max: 2 });
  const r = await full.p.create(GOOD);
  assert.match(r.error, /kapasite dolu: şu an 2 yayın çalışıyor, bu sunucu en fazla 2/);
  assert.deepEqual(full.calls, []);
});

test('YouTube stream oluşturulamazsa hiçbir dosya/servis işlemi yapılmaz', async () => {
  const { p, calls } = setup({ createFails: true });
  const r = await p.create(GOOD);
  assert.equal(r.ok, false);
  assert.match(r.error, /YouTube stream oluşturma başarısız: kota doldu/);
  assert.doesNotMatch(r.error, /kısmi kurulum/);
  assert.deepEqual(names(calls), ['createStream']);
});

test('kurulum adımı düşerse hangi adım olduğu ve kısmi kurulum uyarısı mesajda yazar; canlıya alma denenmez', async () => {
  const { p, calls } = setup({ provisionFails: 2 }); // ikinci provision (başlatma) düşer
  const r = await p.create(GOOD);
  await flush();
  assert.equal(r.ok, false);
  assert.match(r.error, /"lofi2" için yayını başlatma başarısız: add-stream\.sh başarısız/);
  assert.match(r.error, /kısmi kurulum/);
  assert.ok(!names(calls).includes('goLive'));
});

test('canlıya alma arka planda hata verirse create() yine ok döner, hata loglanır', async () => {
  const { p, logs } = setup();
  p.goLive = async () => { throw new Error('ingest gelmedi'); };
  const r = await p.create(GOOD);
  await flush();
  await flush();
  assert.equal(r.ok, true);
  assert.ok(logs.some((l) => /canlıya alınamadı: ingest gelmedi/.test(l)));
});

// ── StreamManager ──────────────────────────────────────────────────────────

function manager({ names: n = ['lofi2'], state = 'running', goLiveResult = { action: 'accepted' } } = {}) {
  const calls = [];
  const instances = {
    names: () => n, status: () => state, start: (x) => calls.push(['start', x]), stop: (x) => calls.push(['stop', x]),
  };
  const m = new StreamManager({
    provisioner: { create: async (i) => ({ ok: true, input: i }) },
    instances,
    catalog: { list: () => ALBUMS },
    goLive: async (x) => { calls.push(['golive', x]); return goLiveResult; },
    log: { warn() {} },
  });
  return { m, calls };
}

test('StreamManager.list/albums: durumla birlikte; albüm parça yolları dışarı VERİLMEZ', () => {
  const { m } = manager();
  assert.deepEqual(m.list(), [{ name: 'lofi2', state: 'running', videoMode: 'encode' }]);
  const albums = m.albums();
  assert.equal(albums[0].trackCount, 2);
  assert.equal(albums[0].trackPaths, undefined);
});

test('StreamManager.control: yalnızca kurulu ek yayına ve bilinen işleme izin verir', async () => {
  const { m, calls } = manager();
  assert.equal((await m.control('lofi2', 'start')).ok, true);
  assert.equal((await m.control('lofi2', 'stop')).ok, true);
  assert.match((await m.control('lofi2', 'golive')).message, /canlıya alma başladı/);
  assert.deepEqual(calls, [['start', 'lofi2'], ['stop', 'lofi2'], ['golive', 'lofi2']]);
  const before = calls.length;
  assert.match((await m.control('baska', 'start')).error, /bulunamadı/);
  assert.match((await m.control('lofi2', 'reboot')).error, /bilinmeyen işlem/);
  assert.match((await m.control('../etc', 'stop')).error, /bulunamadı/);
  assert.equal(calls.length, before, 'reddedilen işlemler hiçbir şeyi çalıştırmamalı');
});

test('StreamManager.control: altyapı hatası mesajla ok:false döner', async () => {
  const { m } = manager();
  m.instances.stop = () => { throw new Error('Unit not found'); };
  const r = await m.control('lofi2', 'stop');
  assert.equal(r.ok, false);
  assert.match(r.error, /Unit not found/);
});

// ── Uçtan uca KURU ÇALIŞTIRMA: gerçek dosya sistemi, add-stream.sh taklit edilir ──────────────

test('KURU ÇALIŞTIRMA: gerçek dosyalarla tam kurulum — config, env(600), plan, servis başlatma sırası', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-e2e-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    paths: { runtime: './runtime' }, pomodoro: { enabled: true, type: '50+10' }, broadcast: { title: 'ana', privacyStatus: 'public' },
  }));
  const shell = [];
  // add-stream.sh taklidi: config yoksa kopyalar+runtime ayırır, env yoksa boş key ile yaratır;
  // key boşsa başlatmaz, doluysa "başlatır" (systemctl çağrısı kaydedilir).
  const run = (cmd, args) => {
    shell.push([cmd, ...args].map((a) => path.basename(String(a))).join(' '));
    if (cmd === 'bash') {
      const name = args[1];
      const cfg = path.join(root, `config.${name}.json`);
      if (!fs.existsSync(cfg)) {
        const base = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
        base.paths.runtime = `./runtime/${name}`;
        fs.writeFileSync(cfg, JSON.stringify(base));
      }
      const env = path.join(root, `.env.${name}`);
      if (!fs.existsSync(env)) fs.writeFileSync(env, 'YOUTUBE_STREAM_KEY=\n', { mode: 0o600 });
      const keySet = /YOUTUBE_STREAM_KEY=.+/.test(fs.readFileSync(env, 'utf8'));
      if (keySet) shell.push(`systemctl enable --now yt-streamer@${name}`);
      return { code: 0, stdout: keySet ? 'baslatildi' : 'anahtar bos', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const instances = new StreamInstances({ repoRoot: root, run, log: { info() {}, warn() {} } });
  const p = new StreamProvisioner({
    createStream: async () => ({ id: 's1', streamKey: KEY }),
    instances,
    writePlan: (name, plan) => new StreamPlanStore({
      runtimeDir: instances.runtimeDir(name), writeFile: writeFileAtomic, log: { info() {}, warn() {} },
    }).saveActive(plan),
    albums: () => ALBUMS,
    covers: () => ['/c/a.jpg'],
    goLive: async () => ({ action: 'accepted' }),
    maxStreams: 2,
    log: { info() {}, warn() {} },
  });

  const r = await p.create({ ...GOOD, goLiveNow: false });
  assert.equal(r.ok, true, r.error);

  // 1) config: kopyalandı, runtime ayrı, başlık/gizlilik yazıldı, pomodoro kapalı.
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.lofi2.json'), 'utf8'));
  assert.equal(cfg.paths.runtime, './runtime/lofi2');
  assert.deepEqual([cfg.broadcast.title, cfg.broadcast.privacyStatus, cfg.pomodoro.enabled], ['Gece Yayını', 'public', false]);
  // 2) env: key doğru yazıldı (izin 600 POSIX'te).
  const envFile = path.join(root, '.env.lofi2');
  assert.equal(fs.readFileSync(envFile, 'utf8'), `YOUTUBE_STREAM_KEY=${KEY}\n`);
  if (process.platform !== 'win32') assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  // 3) plan: örneğin KENDİ runtime klasöründe, StreamPlanStore ile geri okunabilir.
  const plan = new StreamPlanStore({ runtimeDir: path.join(root, 'runtime', 'lofi2'), writeFile: writeFileAtomic, log: { info() {}, warn() {} } }).loadActive();
  assert.deepEqual(plan.music.albums.map((a) => a.name), ['zen', 'mimi']);
  assert.equal(plan.pomodoro.enabled, false);
  assert.equal(plan.broadcast.title, 'Gece Yayını');
  // 4) servis yalnızca key YAZILDIKTAN sonraki ikinci add-stream çağrısında başladı.
  const bashRuns = shell.filter((s) => s.startsWith('add-stream.sh') || s.startsWith('bash'));
  assert.equal(bashRuns.length, 2);
  assert.equal(shell.filter((s) => s.startsWith('systemctl enable')).length, 1);
  assert.ok(shell.indexOf('systemctl enable --now yt-streamer@lofi2') > shell.indexOf(bashRuns[1]) - 1);
  // 5) ana yayının config'ine DOKUNULMADI.
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).pomodoro.enabled, true);
  // 6) aynı ad ikinci kez kurulamaz.
  const again = await p.create({ ...GOOD, goLiveNow: false });
  assert.match(again.error, /zaten kullanılıyor/);
});

test('aynı ad için eşzamanlı ikinci istek reddedilir: tek YouTube stream; kilit sonra bırakılır', async () => {
  const { p, calls } = setup();
  let release;
  const gate = new Promise((r) => { release = r; });
  const original = p.createStream;
  p.createStream = async (arg) => { await gate; return original(arg); };

  const first = p.create({ ...GOOD, goLiveNow: false });
  const second = await p.create({ ...GOOD, name: ' LOFI2 ', goLiveNow: false });
  assert.equal(second.ok, false);
  assert.match(second.error, /kurulum zaten sürüyor/);
  assert.equal(calls.filter((c) => c[0] === 'createStream').length, 0, 'ikinci istek YouTube\'a gitmedi');

  release();
  assert.equal((await first).ok, true);
  assert.equal(calls.filter((c) => c[0] === 'createStream').length, 1);

  // Kilit bırakıldı: farklı ad engellenmez.
  assert.equal((await p.create({ ...GOOD, name: 'baska', goLiveNow: false })).ok, true);
});

test('süre önbelleği tohumlanır: ilk provision\'dan sonra, anahtar/plan ve başlatmadan önce; hata kurulumu durdurmaz', async () => {
  const { p, calls } = setup();
  p.instances.seedDurations = (n) => { calls.push(['seedDurations', n]); };
  const r = await p.create({ ...GOOD, goLiveNow: false });
  assert.equal(r.ok, true);
  assert.deepEqual(names(calls).slice(0, 4), ['createStream', 'provision', 'seedDurations', 'writeKey']);

  const second = setup();
  second.p.instances.seedDurations = () => { throw new Error('disk dolu'); };
  assert.equal((await second.p.create({ ...GOOD, goLiveNow: false })).ok, true, 'tohumlama hatası yalnızca uyarıdır');
});

test('yük koruması: yük + yeni yayın çekirdeğin %95\'ini aşarsa reddedilir; YouTube\'a hiç gidilmez', async () => {
  const { p, calls } = setup({ max: 5 });
  p.systemLoad = () => ({ load1: 2.4, cores: 3 }); // 2.4 + 1 > 2.85
  const r = await p.create(GOOD);
  assert.equal(r.ok, false);
  assert.match(r.error, /sunucu yükü yüksek \(yük 2\.4 \/ 3 çekirdek\)/);
  assert.equal(calls.length, 0);

  p.systemLoad = () => ({ load1: 2.4, cores: 4 }); // 3.4 <= 3.8
  assert.equal((await p.create({ ...GOOD, goLiveNow: false })).ok, true);
});

test('yük koruması: systemLoad verilmezse ya da sayı geçersizse denetim yapılmaz', async () => {
  const a = setup();
  assert.equal((await a.p.create({ ...GOOD, goLiveNow: false })).ok, true);
  const b = setup();
  b.p.systemLoad = () => ({ load1: NaN, cores: 0 });
  assert.equal((await b.p.create({ ...GOOD, goLiveNow: false })).ok, true);
});

// ── Saf görüntü modu (videoMode: 'copy') ─────────────────────────────────────────
const LOOP_ALBUMS = [
  { ...ALBUMS[0], loopPath: '/m/mimi/loop.mp4' },
  { ...ALBUMS[1], loopPath: null },
];
const SAF = { ...GOOD, albums: ['mimi'], videoMode: 'copy' };

function loopSetup(opts) {
  const s = setup(opts);
  s.p.albums = () => LOOP_ALBUMS;
  return s;
}

test('Saf: config\'e video.mode=copy yazılır, overlay ve Pomodoro kapanır', async () => {
  const { p, calls } = loopSetup();
  assert.equal((await p.create(SAF)).ok, true);
  const cfg = calls.find((c) => c[0] === 'patchConfig')[2];
  assert.deepEqual(cfg.video, { mode: 'copy' });
  assert.equal(cfg.overlay.enabled, false);
  assert.equal(cfg.pomodoro.enabled, false);
});

test('Yazılı (varsayılan): video.mode=encode yazılır, overlay\'e dokunulmaz', async () => {
  const { p, calls } = loopSetup();
  assert.equal((await p.create({ ...GOOD, albums: ['mimi'] })).ok, true);
  const cfg = calls.find((c) => c[0] === 'patchConfig')[2];
  assert.deepEqual(cfg.video, { mode: 'encode' });
  assert.equal(cfg.overlay, undefined);
});

test('Saf: albüm seçilmemişse, seçilen albümde loop.mp4 yoksa ya da mod geçersizse reddedilir; hiçbir şey kurulmaz', async () => {
  const none = loopSetup();
  const r1 = await none.p.create({ ...SAF, albums: [] });
  assert.match(r1.error, /en az bir albüm/);

  const missing = loopSetup();
  const r2 = await missing.p.create({ ...SAF, albums: ['mimi', 'zen'] });
  assert.match(r2.error, /hazır döngü \(loop\.mp4\) yok: zen/);

  const bad = loopSetup();
  const r3 = await bad.p.create({ ...SAF, videoMode: 'turbo' });
  assert.match(r3.error, /geçersiz görüntü modu/);

  for (const s of [none, missing, bad]) assert.equal(s.calls.length, 0, 'YouTube\'a ve sisteme hiç gidilmemeli');
});

test('yük koruması moda göre: Saf ~0,1 çekirdek sayılır, Yazılı 1', async () => {
  const saf = loopSetup({ max: 5 });
  saf.p.systemLoad = () => ({ load1: 2.7, cores: 3 }); // 2.7 + 0.1 <= 2.85
  assert.equal((await saf.p.create({ ...SAF, goLiveNow: false })).ok, true);

  const yazili = loopSetup({ max: 5 });
  yazili.p.systemLoad = () => ({ load1: 2.7, cores: 3 }); // 2.7 + 1 > 2.85
  const r = await yazili.p.create({ ...GOOD, albums: ['mimi'], goLiveNow: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /sunucu yükü yüksek/);
});

test('StreamManager.albums hasLoop, list videoMode taşır', () => {
  const m = new StreamManager({
    provisioner: null,
    instances: { names: () => ['lofi3'], status: () => 'running', videoMode: () => 'copy' },
    catalog: { list: () => LOOP_ALBUMS },
    goLive: async () => ({}),
    log: { warn() {} },
  });
  assert.deepEqual(m.list(), [{ name: 'lofi3', state: 'running', videoMode: 'copy' }]);
  assert.deepEqual(m.albums().map((a) => [a.name, a.hasLoop]), [['mimi', true], ['zen', false]]);
  assert.equal(m.albums()[0].loopPath, undefined, 'dosya yolu sayfaya gitmez');
});
