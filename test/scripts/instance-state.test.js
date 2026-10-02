// scripts/deploy/lib/instance-state.sh testleri: gerçek systemd yok, sahte systemctl
// enjekte edilir (INSTANCE_SYSTEMCTL).
//
// Asıl koruduğumuz şey: BİLEREK KAPATILMIŞ bir yayın deploy'da sessizce geri açılmasın.
// `systemctl is-enabled --quiet` kullanmak bu testi geçemezdi: o komut 'static',
// 'indirect', 'generated' durumlarında da 0 döner.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '../../scripts/deploy/lib/instance-state.sh');

// bash yoksa (Windows'ta Git Bash kurulu değilse) kabuk testleri atlanır.
const BASH = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';

// unitFileState: sahte systemctl'in basacağı durum ('' = unit yok)
function action({ unitFileState = 'enabled', marker = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-state-'));
  const fakeSystemctl = path.join(dir, 'fake-systemctl.sh');
  fs.writeFileSync(fakeSystemctl, `#!/usr/bin/env bash\nprintf '%s\\n' '${unitFileState}'\n`);
  const markerPath = path.join(dir, '.env.stream2.disabled');
  if (marker) fs.writeFileSync(markerPath, '');

  const script = [
    `INSTANCE_SYSTEMCTL="bash ${fakeSystemctl}"`,
    `. "${LIB}"`,
    `instance_action yt-streamer@stream2.service "${markerPath}"`,
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `bash hata verdi: ${r.stderr}`);
  return r.stdout.trim();
}

test('enabled → restart', { skip: !BASH }, () => {
  assert.equal(action({ unitFileState: 'enabled' }), 'restart');
});

test('enabled-runtime → restart (geçici enable de güncellenir)', { skip: !BASH }, () => {
  assert.equal(action({ unitFileState: 'enabled-runtime' }), 'restart');
});

test('disabled → dokunulmaz', { skip: !BASH }, () => {
  assert.equal(action({ unitFileState: 'disabled' }), 'skip:state=disabled');
});

// `is-enabled --quiet` bu üç durumda da 0 döner ve eski kod yayını geri açardı.
for (const state of ['static', 'indirect', 'generated', 'transient']) {
  test(`${state} → dokunulmaz (is-enabled --quiet tuzağı)`, { skip: !BASH }, () => {
    assert.equal(action({ unitFileState: state }), `skip:state=${state}`);
  });
}

test('masked → dokunulmaz', { skip: !BASH }, () => {
  assert.equal(action({ unitFileState: 'masked' }), 'skip:state=masked');
});

test('unit hiç yoksa (boş çıktı) dokunulmaz', { skip: !BASH }, () => {
  assert.equal(action({ unitFileState: '' }), 'skip:state=yok');
});

// Park işareti niyeti REPODA kaydeder: systemd ne derse desin kazanır.
test('park işareti varsa enabled olsa bile dokunulmaz', { skip: !BASH }, () => {
  assert.equal(action({ unitFileState: 'enabled', marker: true }), 'skip:parked');
});

test('park işareti + disabled → parked (işaret önce kontrol edilir)', { skip: !BASH }, () => {
  assert.equal(action({ unitFileState: 'disabled', marker: true }), 'skip:parked');
});

test('işaret dosyası verilmezse yalnızca duruma bakılır', { skip: !BASH }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-state-'));
  const fakeSystemctl = path.join(dir, 'fake-systemctl.sh');
  fs.writeFileSync(fakeSystemctl, "#!/usr/bin/env bash\nprintf '%s\\n' 'enabled'\n");
  const r = spawnSync('bash', ['-c', [
    `INSTANCE_SYSTEMCTL="bash ${fakeSystemctl}"`,
    `. "${LIB}"`,
    'instance_action yt-streamer@stream2.service',
  ].join('\n')], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.stdout.trim(), 'restart');
});
