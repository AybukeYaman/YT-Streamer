const test = require('node:test');
const assert = require('node:assert/strict');

const { StreamTui } = require('../../src/ui/stream-tui');

// ─── Sahte bağımlılıklar ─────────────────────────────────────────

function fakeControl(overrides = {}) {
  return {
    calls: [],
    getStatus() { return { state: 'stopped', uptime: 0, fps: null, bitrateKbps: null, speed: null, runNumber: 0 }; },
    getCurrentTrack() { return null; },
    getUpcomingQueue() { return []; },
    async start() { this.calls.push('start'); },
    async stop() { this.calls.push('stop'); },
    async restart() { this.calls.push('restart'); },
    ...overrides,
  };
}

function fakeLogBuffer(lines = []) {
  const entries = lines.map((t) => ({ level: 'info', text: t }));
  return {
    entries,
    recent: (n) => entries.slice(-n),
    // LogBuffer'ın gerçek arayüzü console uyumlu: log = info, error = warn/error.
    log: (t) => entries.push({ level: 'info', text: t }),
    error: (t) => entries.push({ level: 'error', text: t }),
  };
}

function fakeOut({ columns = 100, rows = 40 } = {}) {
  return { columns, rows, on() {}, removeListener() {} };
}

// Ink'i yüklemeyen sahte importApp — mount/unmount izlenir.
function fakeImport(state) {
  return () => Promise.resolve({
    mount(controller) {
      state.mounted = controller;
      return { unmount() { state.unmounted = (state.unmounted || 0) + 1; } };
    },
  });
}

function makeTui(controlOverrides = {}, opts = {}) {
  const controlService = fakeControl(controlOverrides);
  const logBuffer = opts.logBuffer || fakeLogBuffer(opts.logLines || []);
  const out = fakeOut(opts.outOpts);
  const quits = [];
  const importState = {};
  const tui = new StreamTui({
    controlService,
    logBuffer,
    onQuit: () => quits.push(true),
    out,
    input: {},
    createInterval: () => ({ unref() {} }),
    destroyInterval: () => {},
    importApp: fakeImport(importState),
    ...opts.tui,
  });
  return { tui, controlService, logBuffer, out, quits, importState };
}

// ═══════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

test('constructor: controlService olmadan hata fırlatır', () => {
  assert.throws(() => new StreamTui({}), /controlService gerekli/);
});

test('open: Ink app mount edilir, timer kurulur; close: unmount + idempotent', async () => {
  let destroyed = 0;
  const { tui, importState } = makeTui({}, { tui: { destroyInterval: () => { destroyed++; } } });
  await tui.open();
  assert.equal(tui.opened, true);
  assert.ok(importState.mounted === tui, 'mount controller ile çağrılmalı');

  tui.close();
  assert.equal(tui.opened, false);
  assert.equal(importState.unmounted, 1);
  assert.equal(destroyed, 1);

  assert.doesNotThrow(() => tui.close()); // idempotent
  assert.equal(importState.unmounted, 1); // ikinci kez unmount yok
});

test('open: mount beklerken close çağrılırsa mount edilmez', async () => {
  const importState = {};
  const controlService = fakeControl();
  const tui = new StreamTui({
    controlService, logBuffer: fakeLogBuffer(), onQuit: () => {},
    out: fakeOut(), input: {},
    createInterval: () => ({ unref() {} }), destroyInterval: () => {},
    importApp: () => Promise.resolve({ mount(c) { importState.mounted = c; return { unmount() {} }; } }),
  });
  const p = tui.open();
  tui.close(); // import resolve olmadan kapat
  await p;
  assert.equal(importState.mounted, undefined, 'close sonrası mount edilmemeli');
});

// ═══════════════════════════════════════════════════════════════════════════
// Klavye → aksiyon
// ═══════════════════════════════════════════════════════════════════════════

test('handleInput S → controlService.start', async () => {
  const { tui, controlService } = makeTui();
  await tui.handleInput('s');
  assert.deepEqual(controlService.calls, ['start']);
});

test('handleInput R → controlService.restart', async () => {
  const { tui, controlService } = makeTui();
  await tui.handleInput('r');
  assert.deepEqual(controlService.calls, ['restart']);
});

test('handleInput Q → onQuit (start/restart çağrılmaz)', () => {
  const { tui, controlService, quits } = makeTui();
  tui.handleInput('q');
  assert.equal(quits.length, 1);
  assert.deepEqual(controlService.calls, []);
});

test('handleInput Ctrl+C → onQuit', () => {
  const { tui, quits } = makeTui();
  tui.handleInput('c', { ctrl: true, name: 'c' });
  assert.equal(quits.length, 1);
});

test('handleInput bilinmeyen tuş yoksayılır', () => {
  const { tui, controlService, quits } = makeTui();
  assert.doesNotThrow(() => tui.handleInput('x'));
  assert.deepEqual(controlService.calls, []);
  assert.equal(quits.length, 0);
});

test('komut hatası LOG buffer\'a düşer, crash olmaz', async () => {
  const logBuffer = fakeLogBuffer();
  const { tui } = makeTui({ async start() { throw new Error('zaten çalışıyor'); } }, { logBuffer });
  await tui.handleInput('s');
  assert.ok(logBuffer.entries.some((e) => /zaten çalışıyor/.test(e.text)));
});

test('dispatch render olayı yayar', async () => {
  const { tui } = makeTui();
  let renders = 0;
  tui.on('render', () => { renders++; });
  tui.dispatch('log-up');
  assert.ok(renders >= 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Log scroll yönlendirmesi (ayrıntı LogViewport testinde)
// ═══════════════════════════════════════════════════════════════════════════

test('scroll aksiyonları viewport\'a gider: yukarı → PAUSED, End → LIVE', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `satır ${i}`);
  const { tui } = makeTui({}, { logLines: lines });
  assert.equal(tui.getViewModel().logs.live, true);
  tui.dispatch('log-up');
  assert.equal(tui.getViewModel().logs.live, false); // PAUSED
  tui.dispatch('live');
  assert.equal(tui.getViewModel().logs.live, true); // End → LIVE
});

// ═══════════════════════════════════════════════════════════════════════════
// getViewModel
// ═══════════════════════════════════════════════════════════════════════════

test('getViewModel: çalışan durum + parça + kuyruk doğru toplanır', () => {
  const { tui } = makeTui({
    getStatus: () => ({ state: 'running', uptime: 3725, fps: 30, bitrateKbps: 4820, speed: 1.0, runNumber: 12 }),
    getCurrentTrack: () => ({ albumName: 'Rainy Nights', trackTitle: 'Midnight Rain', trackDuration: 285, elapsedSeconds: 222, remainingSeconds: 63 }),
    getUpcomingQueue: () => [{ albumName: 'Rainy Nights', trackTitle: 'Soft Rain', duration: 200 }],
  });
  const vm = tui.getViewModel();
  assert.equal(vm.header.status.label, 'RUNNING');
  assert.equal(vm.header.status.color, 'green');
  assert.equal(vm.track.title, 'Midnight Rain');
  assert.equal(vm.streamStatus.bitrate, '4.82 Mbps');
  assert.equal(vm.streamStatus.uptime, '01:02:05');
  assert.equal(vm.queue[0].number, '01');
  assert.equal(vm.queue[0].title, 'Soft Rain');
});

test('getViewModel: boş/durmuş durumda güvenli (track null, kuyruk boş)', () => {
  const { tui } = makeTui();
  const vm = tui.getViewModel();
  assert.equal(vm.header.status.label, 'STOPPED');
  assert.equal(vm.track, null);
  assert.deepEqual(vm.queue, []);
  assert.deepEqual(vm.logs.lines, []);
});

test('getViewModel: resize (out.rows değişince) log viewport yüksekliği güncellenir', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `l${i}`);
  const out = fakeOut({ rows: 40 });
  const { tui } = makeTui({}, { logLines: lines, tui: { out } });
  const big = tui.getViewModel().logs.lines.length;
  out.rows = 24; // küçült
  const small = tui.getViewModel().logs.lines.length;
  assert.ok(small < big, `küçük terminalde daha az log satırı (${small} < ${big})`);
});

// ─── Yapılandırma sihirbazı ──────────────────────────────────────
//
// [C] sihirbazı AYNI Ink ağacında panonun yerine basar (ikinci bir render örneği yok).
// Burada denetleyicinin ekran seçimi ve tuş yönlendirmesi sınanıyor; sihirbazın kendi
// akışı test/ui/config-wizard.test.js'te.

function fakeWizard() {
  const wizard = new (require('events').EventEmitter)();
  wizard.keys = [];
  wizard.opened = 0;
  wizard.open = async () => { wizard.opened += 1; };
  wizard.handleInput = (input, key) => { wizard.keys.push([input, key]); };
  wizard.getViewModel = () => ({ step: 'cover', title: 'SELECT COVER', items: [], footer: [] });
  return wizard;
}

function fakeConfigService(plan = null) {
  return { planProvider: () => plan };
}

// configService + sahte sihirbazla kurulmuş, açılmış TUI.
async function tuiWithWizard({ control = fakeControl(), plan = null } = {}) {
  const state = {};
  const wizard = fakeWizard();
  const created = [];
  const tui = new StreamTui({
    controlService: control,
    configService: fakeConfigService(plan),
    logBuffer: fakeLogBuffer(),
    out: fakeOut(),
    createWizard: (opts) => { created.push(opts); return wizard; },
    importApp: fakeImport(state),
    createInterval: () => null,
    destroyInterval: () => {},
  });
  await tui.open();
  return { tui, wizard, created, control };
}

test('pano varsayılan ekran; görünüm modeli screen alanı taşır', async () => {
  const { tui } = await tuiWithWizard();
  assert.equal(tui.getViewModel().screen, 'dashboard');
  tui.close();
});

test('C sihirbazı açar; görünüm sihirbaza geçer', async () => {
  const { tui, wizard } = await tuiWithWizard();
  await tui.handleInput('c', {});
  assert.equal(wizard.opened, 1);
  const vm = tui.getViewModel();
  assert.equal(vm.screen, 'wizard');
  assert.equal(vm.wizard.title, 'SELECT COVER');
  tui.close();
});

test('yayın dururken sihirbaz doğrudan yapılandırma kipinde açılır', async () => {
  const { tui, created } = await tuiWithWizard();
  await tui.handleInput('c', {});
  assert.equal(created[0].mode, 'new');
  tui.close();
});

test('yayın çalışırken sihirbaz restart kipinde açılır', async () => {
  const control = fakeControl({
    getStatus: () => ({ state: 'running', uptime: 5, fps: 24, bitrateKbps: 2500, speed: 1, runNumber: 1 }),
  });
  const { tui, created } = await tuiWithWizard({ control });
  await tui.handleInput('c', {});
  assert.equal(created[0].mode, 'restart');
  assert.equal(created[0].isRunning(), true);
  tui.close();
});

test('aktif plan sihirbaza basePlan olarak geçer', async () => {
  const plan = { name: 'Cozy' };
  const { tui, created } = await tuiWithWizard({ plan });
  await tui.handleInput('c', {});
  assert.equal(created[0].basePlan, plan);
  tui.close();
});

test('sihirbaz açıkken TÜM tuşlar ona gider (pano kısayolları devre dışı)', async () => {
  const { tui, wizard, control } = await tuiWithWizard();
  await tui.handleInput('c', {});
  tui.handleInput('s', {});
  tui.handleInput('r', {});
  tui.handleInput('q', {});
  tui.handleInput('c', { ctrl: true });
  assert.deepEqual(control.calls, []); // yayına hiçbir komut gitmedi
  assert.deepEqual(wizard.keys.map(([i]) => i), ['s', 'r', 'q', 'c']);
  tui.close();
});

test('C iki kez basılırsa ikinci sihirbaz açılmaz', async () => {
  const { tui, created } = await tuiWithWizard();
  await tui.handleInput('c', {});
  await tui.openWizard();
  assert.equal(created.length, 1);
  tui.close();
});

test('sihirbaz START ile kapanınca panoya dönülür ve sonuç loga yazılır', async () => {
  const state = {};
  const wizard = fakeWizard();
  const logBuffer = fakeLogBuffer();
  const tui = new StreamTui({
    controlService: fakeControl(),
    configService: fakeConfigService(),
    logBuffer,
    out: fakeOut(),
    createWizard: (opts) => { wizard.onExit = opts.onExit; return wizard; },
    importApp: fakeImport(state),
    createInterval: () => null,
    destroyInterval: () => {},
  });
  await tui.open();
  await tui.handleInput('c', {});
  wizard.onExit({ started: true, plan: { name: 'Cozy' }, warnings: ['mola görüntüsü hazırlanamadı'] });
  assert.equal(tui.getViewModel().screen, 'dashboard');
  const texts = logBuffer.entries.map((e) => e.text);
  assert.ok(texts.some((t) => /Cozy/.test(t)));
  assert.ok(texts.some((t) => /uyarı: mola görüntüsü/.test(t)));
  tui.close();
});

test('sihirbaz iptal edilince pano geri gelir, yayına komut gitmez', async () => {
  const { tui, wizard, control } = await tuiWithWizard();
  await tui.handleInput('c', {});
  wizard.emit('render'); // sihirbazın render olayı TUI'ya bağlanmış olmalı
  const exit = tui.wizard === wizard;
  assert.equal(exit, true);
  tui.dispatch('configure'); // ikinci kez açmaz
  assert.deepEqual(control.calls, []);
  tui.close();
});

test('configService verilmezse C devre dışı ve pano bozulmaz', async () => {
  const state = {};
  const logBuffer = fakeLogBuffer();
  const tui = new StreamTui({
    controlService: fakeControl(),
    logBuffer,
    out: fakeOut(),
    importApp: fakeImport(state),
    createInterval: () => null,
    destroyInterval: () => {},
  });
  await tui.open();
  await tui.handleInput('c', {});
  assert.equal(tui.getViewModel().screen, 'dashboard');
  assert.ok(logBuffer.entries.some((e) => /\[C\] devre dışı/.test(e.text)));
  tui.close();
});

test('close() sihirbazı da bırakır (terminal geri yüklenir)', async () => {
  const { tui } = await tuiWithWizard();
  await tui.handleInput('c', {});
  tui.close();
  assert.equal(tui.wizard, null);
});
