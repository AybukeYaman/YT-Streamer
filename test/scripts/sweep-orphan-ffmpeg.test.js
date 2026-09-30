// scripts/deploy/sweep-orphan-ffmpeg.sh testleri: gerçek süreç yok, sahte ps/pgrep/kill
// enjekte edilir (SWEEP_* env değişkenleri). En kritik nokta YANLIŞ POZİTİF: meşru ama
// farklı PID'li bir ffmpeg (ör. elle başlatılmış instance) asla öldürülmemeli.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../../scripts/deploy/sweep-orphan-ffmpeg.sh');
const REPO_ROOT = '/srv/yt-stream';

// bash yoksa (Windows'ta Git Bash kurulu değilse) kabuk testleri atlanır — script
// yalnızca VPS'te (Linux) çalışıyor, geri kalan test paketi bundan etkilenmemeli.
const BASH = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';

// ps çıktısı: "<pid> <ppid> <etime> <args...>"
const psLine = (pid, ppid, args, etime = '10:00') => `${pid} ${ppid} ${etime} ${args}`;
const ffmpegArgs = (extra = '') =>
  `ffmpeg -hide_banner -i ${REPO_ROOT}/assets/bg.mp4 -i ${REPO_ROOT}/runtime/playlist.txt ${extra}`.trim();

// Sahte kill: çağrıları bir dosyaya yazar. `kill -0 <pid>` (hayatta mı?) sorusuna
// alivePids'e göre cevap verir — SIGTERM sonrası SIGKILL kademesi böyle test edilir.
function run({ psLines, nodePids, alivePids = [], dryRun = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-'));
  const killLog = path.join(dir, 'kill.log');
  const fakeKill = path.join(dir, 'fake-kill.sh');
  fs.writeFileSync(fakeKill, [
    '#!/usr/bin/env bash',
    `echo "$1 $2" >> "${killLog}"`,
    '[ "$1" = "-0" ] || exit 0',
    `case " ${alivePids.join(' ')} " in *" $2 "*) exit 0 ;; esac`,
    'exit 1',
    '',
  ].join('\n'));

  // Sahte ps/pgrep: çıktıyı basan birer script. (Env değeri kabukta word-split
  // edildiği için komutu tırnaklı tek satır olarak geçirmek işe yaramaz.)
  const fakeOut = (name, lines) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/usr/bin/env bash\ncat <<'PS_EOF'\n${lines.join('\n')}\nPS_EOF\n`);
    return `bash ${file}`;
  };

  const res = spawnSync('bash', [SCRIPT, ...(dryRun ? ['--dry-run'] : [])], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SWEEP_REPO_ROOT: REPO_ROOT,
      SWEEP_PS_CMD: fakeOut('fake-ps.sh', psLines),
      SWEEP_NODE_PIDS_CMD: fakeOut('fake-pgrep.sh', nodePids),
      SWEEP_KILL_CMD: `bash ${fakeKill}`,
      SWEEP_SLEEP_CMD: 'true',
      SWEEP_KILL_GRACE_SECONDS: '0',
    },
  });
  const kills = fs.existsSync(killLog) ? fs.readFileSync(killLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: res.status, out: `${res.stdout}${res.stderr}`, kills };
}

test('meşru ffmpeg (canlı node\'un çocuğu) öldürülmez', { skip: !BASH }, () => {
  const r = run({ psLines: [psLine(2000, 1000, ffmpegArgs())], nodePids: [1000] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.kills, []);
  assert.match(r.out, /orphan ffmpeg yok/);
});

// Yanlış pozitif riski en kritik nokta: birden çok yayın çalışıyorken her ffmpeg
// KENDİ node'una bağlıdır; "farklı PID" tek başına orphan demek değildir.
test('birden çok meşru instance: farklı PID\'li ffmpeg\'ler öldürülmez', { skip: !BASH }, () => {
  const r = run({
    psLines: [
      psLine(2000, 1000, ffmpegArgs()), // systemd ana yayın
      psLine(2001, 1001, ffmpegArgs()), // systemd yt-streamer@stream2
      psLine(2002, 1002, ffmpegArgs()), // elle başlatılmış instance
    ],
    nodePids: [1000, 1001, 1002],
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.kills, []);
  assert.doesNotMatch(r.out, /ORPHAN/);
});

test('PPID=1 olan ffmpeg orphan sayılır: SIGTERM ile kapanırsa SIGKILL gönderilmez', { skip: !BASH }, () => {
  const r = run({
    psLines: [psLine(2000, 1000, ffmpegArgs()), psLine(2500, 1, ffmpegArgs())],
    nodePids: [1000],
    alivePids: [], // SIGTERM'den sonra ölmüş
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.kills, ['-TERM 2500', '-0 2500']); // -0: hayatta mı? (ölmüş → SIGKILL yok)
  assert.match(r.out, /ORPHAN\s+pid=2500 ppid=1/);
  assert.match(r.out, /1 orphan ffmpeg temizlendi/);
});

test('ebeveyni ölmüş node olan ffmpeg de orphan (PPID=1 olmasa bile)', { skip: !BASH }, () => {
  const r = run({ psLines: [psLine(2500, 999, ffmpegArgs())], nodePids: [1000] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.kills, ['-TERM 2500', '-0 2500']); // -0: hayatta mı? (ölmüş → SIGKILL yok)
});

test('SIGTERM\'e kapanmayan orphan SIGKILL alır', { skip: !BASH }, () => {
  const r = run({
    psLines: [psLine(2500, 1, ffmpegArgs())],
    nodePids: [1000],
    alivePids: [2500], // hâlâ ayakta
  });
  assert.deepEqual(r.kills, ['-TERM 2500', '-0 2500', '-KILL 2500']);
  assert.match(r.out, /SIGTERM'e kapanmadı — SIGKILL/);
});

test('başka bir kurulumun ffmpeg\'ine dokunulmaz (args\'ta repo yolu yok)', { skip: !BASH }, () => {
  const r = run({
    psLines: [psLine(2500, 1, 'ffmpeg -i /home/biri/baska-proje/in.mp4 -f flv rtmp://x')],
    nodePids: [1000],
  });
  assert.deepEqual(r.kills, []);
  assert.match(r.out, /orphan ffmpeg yok/);
});

test('hiç canlı node yokken bu repoya ait her ffmpeg orphan', { skip: !BASH }, () => {
  const r = run({ psLines: [psLine(2500, 1, ffmpegArgs())], nodePids: [] });
  assert.deepEqual(r.kills, ['-TERM 2500', '-0 2500']); // -0: hayatta mı? (ölmüş → SIGKILL yok)
  assert.match(r.out, /canlı node .* yok/);
});

test('--dry-run: tespit eder ama kill etmez', { skip: !BASH }, () => {
  const r = run({ psLines: [psLine(2500, 1, ffmpegArgs())], nodePids: [1000], dryRun: true });
  assert.equal(r.code, 0);
  assert.deepEqual(r.kills, []);
  assert.match(r.out, /DRY RUN — öldürülmedi.*2500/s);
});

// Argümanlar arasında RTMP URL'si (yani stream key) var — log'a asla düşmemeli.
test('ffmpeg argümanları (stream key) loglanmaz', { skip: !BASH }, () => {
  const r = run({
    psLines: [psLine(2500, 1, ffmpegArgs('-f flv rtmps://a.rtmps.youtube.com/live2/gizli-key'))],
    nodePids: [1000],
  });
  assert.doesNotMatch(r.out, /gizli-key/);
  assert.doesNotMatch(r.out, /rtmps:/);
});
