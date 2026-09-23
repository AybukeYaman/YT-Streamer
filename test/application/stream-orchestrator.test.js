const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { StreamOrchestrator } = require('../../src/application/stream-orchestrator');
const { Encoder } = require('../../src/application/encoder');

// Sözleşmeye uyan sahte encoder: çağrıları kaydeder, olayları test tetikler.
class FakeEncoder extends Encoder {
  constructor() {
    super();
    this.starts = [];
    this.stopCalls = 0;
  }
  start(options) { this.starts.push(options); }
  stop() {
    this.stopCalls++;
    setImmediate(() => this.emit('exit', 0, null));
    return new Promise((resolve) => this.once('exit', () => resolve()));
  }
}

function fakeLog() {
  const lines = [];
  const rec = (level) => (m) => lines.push({ level, m });
  return { log: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }, lines };
}

function setup(extra = {}) {
  const encoder = new FakeEncoder();
  const { log, lines } = fakeLog();
  const orch = new StreamOrchestrator({ encoder, log, trackPath: 'C:/music/a b.m4a', ...extra });
  return { encoder, orch, lines };
}

test('start encoder\'ı sabit parçayla başlatır', () => {
  const { encoder, orch } = setup();
  orch.start();
  assert.deepEqual(encoder.starts, [{ audioPath: 'C:/music/a b.m4a' }]);
  assert.equal(orch.running, true);
  assert.throws(() => orch.start(), /zaten çalışıyor/);
});

test('stop sonrası kapanış beklenen olarak bildirilir', async () => {
  const { encoder, orch, lines } = setup();
  const exits = [];
  orch.on('exit', (e) => exits.push(e));
  orch.start();
  await orch.stop();
  assert.equal(encoder.stopCalls, 1);
  assert.deepEqual(exits, [{ expected: true, code: 0, signal: null }]);
  assert.equal(orch.running, false);
  assert.ok(!lines.some((l) => l.level === 'error'));
});

test('stop istenmeden kapanış beklenmeyen olarak bildirilir ve hata loglanır', () => {
  const { encoder, orch, lines } = setup();
  const exits = [];
  orch.on('exit', (e) => exits.push(e));
  orch.start();
  encoder.emit('exit', 1, null);
  assert.deepEqual(exits, [{ expected: false, code: 1, signal: null }]);
  assert.ok(lines.some((l) => l.level === 'error' && /beklenmeyen/.test(l.m)));
});

test('çalışmıyorken stop bir şey yapmaz', async () => {
  const { encoder, orch } = setup();
  await orch.stop();
  assert.equal(encoder.stopCalls, 0);
});

test('encoder logları düzeylere dağıtılır, ilerleme 5 sn\'de bir', () => {
  let t = 0;
  const { encoder, orch, lines } = setup({ now: () => t });
  orch.start();
  encoder.emit('log', { kind: 'command', args: ['-i', 'x'] });
  encoder.emit('log', { kind: 'stderr', line: 'Stream mapping:' });
  encoder.emit('log', { kind: 'error', message: 'olmadı' });
  for (t = 0; t <= 12000; t += 500) {
    encoder.emit('log', { kind: 'progress', frame: t / 40, fps: 24, bitrateKbps: 2500, speed: 1 });
  }
  const progress = lines.filter((l) => l.m.startsWith('frame='));
  assert.equal(progress.length, 3); // t=0, 5000, 10000
  assert.ok(lines.some((l) => l.level === 'debug' && l.m === 'Stream mapping:'));
  assert.ok(lines.some((l) => l.level === 'error' && l.m === 'olmadı'));
  assert.ok(lines.some((l) => l.level === 'info' && l.m === 'ffmpeg başlatılıyor: -i x'));
});

test('application katmanı child_process ya da infrastructure import etmez', () => {
  const dir = path.join(__dirname, '..', '..', 'src', 'application');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(src, /require\(['"](node:)?child_process['"]\)/, `${file} child_process import ediyor`);
    assert.doesNotMatch(src, /require\(['"][^'"]*infrastructure/, `${file} infrastructure import ediyor`);
  }
});
