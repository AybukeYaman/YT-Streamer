const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StreamInstances } = require('../../src/infrastructure/stream-instances');
const { validInstanceName } = require('../../src/domain/instance-name');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yt-inst-'));
const log = { info() {}, warn() {} };

test('validInstanceName: küçük harf/rakam/-/_; kabuk ve yol karakterleri ve ayrılmış adlar reddedilir', () => {
  for (const ok of ['lofi2', 'stream-2', 'a_b', 'ab', 'x1234567890123456789']) assert.equal(validInstanceName(ok), true, ok);
  const bad = [
    '', 'a', 'Lofi', 'lo fi', 'a;rm', 'a$(x)', '../etc', 'a/b', 'a.b', '-ab', '_ab', 'x12345678901234567890', 'youtube', 'example', 'default', 'main', 'config', null, 42,
  ];
  for (const name of bad) assert.equal(validInstanceName(name), false, String(name));
});

test('names(): yalnızca config.<ad>.json VE .env.<ad> birlikte olanlar, geçersiz adlar elenir', () => {
  const root = tmp();
  for (const f of ['config.json', 'config.example.json', 'config.lofi2.json', '.env.lofi2', 'config.yarim.json', '.env.youtube', 'config.Buyuk.json', '.env.Buyuk']) {
    fs.writeFileSync(path.join(root, f), '{}');
  }
  assert.deepEqual(new StreamInstances({ repoRoot: root, log }).names(), ['lofi2']);
});

test('exists(): config, env ya da runtime klasöründen biri varsa dolu sayılır', () => {
  const root = tmp();
  const inst = new StreamInstances({ repoRoot: root, log });
  assert.equal(inst.exists('yeni'), false);
  fs.mkdirSync(path.join(root, 'runtime', 'yeni'), { recursive: true });
  assert.equal(inst.exists('yeni'), true);
  fs.writeFileSync(path.join(root, '.env.baska'), '');
  assert.equal(inst.exists('baska'), true);
});

test('provision(): add-stream.sh KABUKSUZ, argüman dizisiyle çağrılır; geçersiz ad hiç çalıştırmaz', async () => {
  const root = tmp();
  const calls = [];
  const inst = new StreamInstances({
    repoRoot: root, log, run: (cmd, args, opts) => { calls.push([cmd, args, opts]); return { code: 0, stdout: 'a\nb\nc\nd', stderr: '' }; },
  });
  const r = await inst.provision('lofi2');
  assert.equal(calls[0][0], 'bash');
  assert.deepEqual(calls[0][1], [path.join(root, 'scripts', 'deploy', 'add-stream.sh'), 'lofi2']);
  assert.equal(calls[0][2].cwd, root);
  assert.equal(r.output, 'b | c | d');
  await assert.rejects(inst.provision('a; rm -rf /'), /geçersiz yayın adı/);
  assert.equal(calls.length, 1);
});

test('provision(): betik başarısızsa anlaşılır hata', async () => {
  const inst = new StreamInstances({ repoRoot: tmp(), log, run: () => ({ code: 1, stdout: '', stderr: 'HATA: root gerekli' }) });
  await assert.rejects(inst.provision('lofi2'), /add-stream\.sh başarısız \(kod 1\): HATA: root gerekli/);
});

test('writeKey(): .env.<ad>\'a YOUTUBE_STREAM_KEY yazılır, izin 600; kötü biçim ve geçersiz ad reddedilir', () => {
  const root = tmp();
  const inst = new StreamInstances({ repoRoot: root, log });
  inst.writeKey('lofi2', 'abcd-efgh-ijkl-mnop-qrst');
  const file = path.join(root, '.env.lofi2');
  assert.equal(fs.readFileSync(file, 'utf8'), 'YOUTUBE_STREAM_KEY=abcd-efgh-ijkl-mnop-qrst\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => inst.writeKey('lofi2', 'kısa'), /biçimi geçersiz/);
  assert.throws(() => inst.writeKey('lofi2', 'abc\nINJECT=1xxxxxx'), /biçimi geçersiz/);
  assert.throws(() => inst.writeKey('../x', 'abcd-efgh-ijkl'), /geçersiz yayın adı/);
});

test('patchConfig(): config yerinde güncellenir', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'config.lofi2.json'), JSON.stringify({ a: 1, broadcast: { title: 'x' } }));
  new StreamInstances({ repoRoot: root, log }).patchConfig('lofi2', (c) => { c.broadcast.title = 'y'; c.b = 2; return c; });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config.lofi2.json'), 'utf8')), { a: 1, broadcast: { title: 'y' }, b: 2 });
});

test('status() ve runningCount() systemctl çıktısını doğru okur', () => {
  const answers = {
    'is-active': { code: 0, stdout: 'active\n', stderr: '' },
    'list-units': { code: 0, stdout: 'yt-streamer.service loaded active running A\nyt-streamer@lofi2.service loaded active running B\n', stderr: '' },
  };
  const inst = new StreamInstances({ repoRoot: tmp(), log, run: (cmd, args) => answers[args[0]] });
  assert.equal(inst.status('lofi2'), 'running');
  assert.equal(inst.runningCount(), 2);
  answers['is-active'] = { code: 3, stdout: 'inactive\n', stderr: '' };
  assert.equal(inst.status('lofi2'), 'stopped');
  answers['is-active'] = { code: -1, stdout: '', stderr: 'ENOENT' };
  assert.equal(inst.status('lofi2'), 'unknown');
});

test('start()/stop(): systemctl çağrılır, hata iletilir, geçersiz ad reddedilir', () => {
  const calls = [];
  const inst = new StreamInstances({
    repoRoot: tmp(), log, run: (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; },
  });
  inst.start('lofi2');
  inst.stop('lofi2');
  assert.deepEqual(calls, [['systemctl', 'start', 'yt-streamer@lofi2'], ['systemctl', 'stop', 'yt-streamer@lofi2']]);
  assert.throws(() => inst.start('x y'), /geçersiz yayın adı/);
  const failing = new StreamInstances({ repoRoot: tmp(), log, run: () => ({ code: 5, stdout: '', stderr: 'Unit not found' }) });
  assert.throws(() => failing.stop('lofi2'), /systemctl stop başarısız \(kod 5\): Unit not found/);
});

test('provision(): runAsync verilirse BLOKLAMAYAN çalıştırıcı kullanılır (spawnSync değil)', async () => {
  let syncCalled = false;
  const inst = new StreamInstances({
    repoRoot: tmp(),
    log,
    run: () => { syncCalled = true; return { code: 0, stdout: '', stderr: '' }; },
    runAsync: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
  });
  await inst.provision('lofi2');
  assert.equal(syncCalled, false);
});

test('defaultRunAsync: gerçek süreci bloklamadan çalıştırır, çıktı ve çıkış kodunu döner', async () => {
  const { defaultRunAsync } = require('../../src/infrastructure/stream-instances');
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  const res = await defaultRunAsync(process.execPath, ['-e', "setTimeout(() => { console.log('merhaba'); process.exit(3); }, 120)"]);
  clearInterval(timer);
  assert.equal(res.code, 3);
  assert.equal(res.stdout.trim(), 'merhaba');
  assert.ok(ticks >= 5, 'süreç beklenirken olay döngüsü çalışmaya devam etmeli (bloklanmamalı)');
  const missing = await defaultRunAsync('bu-komut-yok-xyz', []);
  assert.equal(missing.code, -1);
});
