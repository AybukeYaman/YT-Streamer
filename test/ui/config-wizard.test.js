const test = require('node:test');
const assert = require('node:assert/strict');

const { ConfigWizard, shortPath } = require('../../src/ui/config-wizard');
const { StreamPlan } = require('../../src/domain/stream-plan');

// ─── Sahte servis ────────────────────────────────────────────────────────
//
// StreamConfigService'in sihirbazın kullandığı yüzü. Sihirbaz dosya okumaz, ffmpeg
// çağırmaz, yayına dokunmaz — hepsi buradan geçer, o yüzden akış Ink'siz test edilebilir.

const ALBUMS = [
  {
    name: 'mimi',
    backgrounds: ['X:/mimi/bg.mp4'],
    tracks: [
      { path: 'X:/mimi/1.m4a', title: 'Sakin Sabah', durationSeconds: 120 },
      { path: 'X:/mimi/2.m4a', title: 'Yagmur', durationSeconds: 180 },
      { path: 'X:/mimi/3.m4a', title: 'Gece Lambasi', durationSeconds: 60 },
    ],
    totalSeconds: 360,
  },
  {
    name: 'gece',
    backgrounds: ['X:/gece/bg.mp4'],
    tracks: [{ path: 'X:/gece/1.m4a', title: 'Uzak Sehir', durationSeconds: 90 }],
    totalSeconds: 90,
  },
];

function fakeService(overrides = {}) {
  const service = {
    applied: [],
    presets: [],
    plan: null,
    listAlbums: async () => ALBUMS,
    listClips: async () => ['X:/mimi/bg.mp4', 'X:/assets/study.mp4', 'X:/assets/break.mp4'],
    listCovers: () => ['X:/assets/kapak.jpg', 'X:/assets/covers/gece.png'],
    inspectPath: (input) => (String(input).endsWith('.jpg') || String(input).endsWith('.mp4')
      ? { ok: true, file: { path: `X:/custom/${String(input).split(/[\\/]/).pop()}` } }
      : { ok: false, reason: 'dosya yok' }),
    listPresets() { return this.presets; },
    loadPreset(slug) { return (this.presets.find((p) => p.slug === slug) || {}).plan || null; },
    savePreset(plan) {
      const entry = { slug: plan.name.toLowerCase().replace(/\s+/g, '-'), plan: StreamPlan.from(plan) };
      this.presets.push(entry);
      return entry;
    },
    async applyAndRestart(plan) {
      const p = StreamPlan.from(plan);
      this.applied.push(p);
      this.plan = p;
      return { plan: p, warnings: [], restarted: true };
    },
    async restart() { this.applied.push('restart'); return { plan: this.plan, restarted: true }; },
    ...overrides,
  };
  return service;
}

// Sihirbazı açar ve kütüphaneyi yükler.
async function openWizard({ mode = 'new', basePlan = null, service = fakeService(), isRunning = () => false } = {}) {
  const exits = [];
  const wizard = new ConfigWizard({
    configService: service, mode, basePlan, isRunning, onExit: (r) => exits.push(r),
  });
  await wizard.open();
  return { wizard, service, exits };
}

// ─── Tuş yardımcıları ───────────────────────────────────────────────────

const KEY = {
  down: ['', { downArrow: true }],
  up: ['', { upArrow: true }],
  enter: ['', { return: true }],
  esc: ['', { escape: true }],
  space: [' ', {}],
  shiftDown: ['', { downArrow: true, shift: true }],
  shiftUp: ['', { upArrow: true, shift: true }],
};

function press(wizard, ...keys) {
  for (const key of keys) {
    const [input, meta] = Array.isArray(key) ? key : KEY[key] || [key, {}];
    wizard.handleInput(input, meta);
  }
}

async function pressAsync(wizard, ...keys) {
  for (const key of keys) {
    const [input, meta] = Array.isArray(key) ? key : KEY[key] || [key, {}];
    // eslint-disable-next-line no-await-in-loop
    await wizard.handleInput(input, meta);
  }
}

// NOT: imleç her adımda MEVCUT değerin üstünde başlar (ör. pomodoro kapalıysa "No").
// Bu yüzden testler sabit tuş dizisi yerine ETİKETE giderek seçim yapar — akış
// değiştiğinde testler yanlış satırı seçip sessizce başka şeyi doğrulamaz.

// Kütüphane listesinde verilen etiketli satıra imleci taşır.
function moveTo(wizard, label) {
  const limit = 500;
  for (let i = 0; i < limit; i++) {
    const vm = wizard.getViewModel();
    if (vm.items[vm.cursor] && vm.items[vm.cursor].label === label) return vm;
    press(wizard, 'down');
  }
  throw new Error(`satır bulunamadı: ${label}`);
}

function choose(wizard, label) {
  moveTo(wizard, label);
  press(wizard, 'enter');
}

// Pomodoro KAPALI akışıyla özete kadar yürür.
function toSummary(wizard) {
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  press(wizard, 'enter'); // music: seçim yapmadan devam
  press(wizard, 'enter'); // order: devam
  choose(wizard, 'No');
  return wizard.getViewModel();
}

// Pomodoro AÇIK akışıyla özete kadar yürür (hazır 50+10, varsayılan görüntüler).
function toSummaryWithPomodoro(wizard) {
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  press(wizard, 'enter');
  press(wizard, 'enter');
  choose(wizard, 'Yes');
  choose(wizard, '50 min study / 10 min break');
  press(wizard, 'enter'); // studyVideo: seçim yapmadan devam
  press(wizard, 'enter'); // breakVideo: aynı
  return wizard.getViewModel();
}

// ─── Akış ───────────────────────────────────────────────────────────────

test('yeni yapılandırma preset adımında başlar; preset yoksa yalnızca "yeni" seçeneği var', async () => {
  const { wizard } = await openWizard();
  const vm = wizard.getViewModel();
  assert.equal(vm.step, 'preset');
  assert.deepEqual(vm.items.map((i) => i.label), ['Yeni yapılandırma…']);
});

test('yayın çalışıyorsa restart menüsüyle açılır', async () => {
  const { wizard } = await openWizard({ mode: 'restart', basePlan: new StreamPlan({ name: 'Eski' }), isRunning: () => true });
  const vm = wizard.getViewModel();
  assert.equal(vm.step, 'restart');
  assert.deepEqual(vm.items.map((i) => i.label), [
    'Restart with current configuration',
    'Restart with new configuration',
    'Cancel',
  ]);
});

// Plan DOSYAYA yeniden yazılmaz: hiç plan dosyası olmayan bir kurulumda (config.json
// ayarlarıyla çalışan VPS) sırf restart yüzünden plan dosyası yaratmak istenmiyor.
test('"restart with current configuration" planı değiştirmeden yeniden başlatır', async () => {
  const basePlan = new StreamPlan({ name: 'Eski', pomodoro: { enabled: true, type: '30+10' } });
  const service = fakeService();
  service.plan = basePlan;
  const { wizard, exits } = await openWizard({ mode: 'restart', basePlan, service, isRunning: () => true });
  await pressAsync(wizard, 'enter');
  assert.deepEqual(service.applied, ['restart']); // applyAndRestart DEĞİL
  assert.equal(exits[0].started, true);
  assert.equal(exits[0].plan.name, 'Eski');
});

test('plan yoksa "mevcut yapılandırmayla" restart da plan yazmaz', async () => {
  const service = fakeService();
  const { wizard, exits } = await openWizard({ mode: 'restart', basePlan: null, service, isRunning: () => true });
  await pressAsync(wizard, 'enter');
  assert.deepEqual(service.applied, ['restart']);
  assert.equal(exits[0].started, true);
});

test('"restart with new configuration" yapılandırma akışını açar', async () => {
  const { wizard } = await openWizard({ mode: 'restart', basePlan: new StreamPlan({}), isRunning: () => true });
  press(wizard, 'down', 'enter');
  assert.equal(wizard.getViewModel().step, 'cover');
});

test('restart menüsünde Cancel hiçbir şey değiştirmez', async () => {
  const { wizard, service, exits } = await openWizard({ mode: 'restart', basePlan: new StreamPlan({}), isRunning: () => true });
  press(wizard, 'down', 'down', 'enter');
  assert.deepEqual(service.applied, []);
  assert.equal(exits[0].cancelled, true);
});

test('pomodoro kapalıyken akış kısadır: cover → music → order → pomodoro → summary', async () => {
  const { wizard } = await openWizard();
  const steps = [];
  const record = () => steps.push(wizard.getViewModel().step);
  record();
  choose(wizard, 'Yeni yapılandırma…'); record();
  choose(wizard, '(kapak değiştirilmesin)'); record();
  press(wizard, 'enter'); record();
  press(wizard, 'enter'); record();
  choose(wizard, 'No'); record();
  assert.deepEqual(steps, ['preset', 'cover', 'music', 'order', 'pomodoro', 'summary']);
});

test('pomodoro açılınca study/break adımları akışa girer', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  press(wizard, 'enter');
  press(wizard, 'enter');
  assert.equal(wizard.getViewModel().step, 'pomodoro');
  choose(wizard, 'Yes');
  assert.equal(wizard.getViewModel().step, 'pomodoroType');
  choose(wizard, '50 min study / 10 min break');
  assert.equal(wizard.getViewModel().step, 'studyVideo');
  press(wizard, 'enter');
  assert.equal(wizard.getViewModel().step, 'breakVideo');
  press(wizard, 'enter');
  assert.equal(wizard.getViewModel().step, 'summary');
});

// ─── Kapak ──────────────────────────────────────────────────────────────

test('kapak listesi dosya yollarından kısa etiket üretir, "custom" ve "değişmesin" eklenir', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  const vm = wizard.getViewModel();
  assert.deepEqual(vm.items.map((i) => i.label), [
    'assets/kapak.jpg', 'covers/gece.png', 'custom file…', '(kapak değiştirilmesin)',
  ]);
});

test('custom kapak: geçersiz yol hata gösterir, geçerli yol adımı geçer', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  moveTo(wizard, 'custom file…');
  press(wizard, 'enter');
  assert.ok(wizard.getViewModel().textInput);

  press(wizard, ...'olmayan.txt'.split(''), 'enter');
  assert.match(wizard.getViewModel().error, /dosya yok/);
  assert.equal(wizard.getViewModel().step, 'cover'); // adım geçilmedi

  // Hatalı metni silip geçerlisini yaz.
  for (let i = 0; i < 20; i++) press(wizard, ['', { backspace: true }]);
  press(wizard, ...'yeni.jpg'.split(''), 'enter');
  assert.equal(wizard.getViewModel().step, 'music');
});

// ─── Müzik seçimi ───────────────────────────────────────────────────────

test('müzik adımı albüm başlıkları ve parçaları listeler', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  const vm = wizard.getViewModel();
  assert.equal(vm.step, 'music');
  assert.deepEqual(vm.items.map((i) => i.label), [
    'mimi', 'Sakin Sabah', 'Yagmur', 'Gece Lambasi', 'gece', 'Uzak Sehir',
  ]);
  assert.equal(vm.items[0].header, true);
});

test('space tek parçayı seçer; seçim sayısı ipuçta görünür', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  moveTo(wizard, 'Yagmur');
  press(wizard, 'space');
  const vm = wizard.getViewModel();
  assert.equal(vm.items.find((i) => i.label === 'Yagmur').checked, true);
  assert.match(vm.hint, /Selected: 1/);
});

test('albüm başlığında space tüm albümü seçer, tekrar basınca bırakır', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  moveTo(wizard, 'mimi');
  press(wizard, 'space');
  assert.match(wizard.getViewModel().hint, /Selected: 3/);
  press(wizard, 'space');
  assert.match(wizard.getViewModel().hint, /TÜM kütüphane/);
});

test('arama listeyi süzer; eşleşmeyen albümün başlığı da düşer', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  press(wizard, '/', ...'yagmur'.split(''));
  const vm = wizard.getViewModel();
  assert.equal(vm.search, 'yagmur');
  assert.deepEqual(vm.items.map((i) => i.label), ['mimi', 'Yagmur']);
});

test('albüm adıyla arama o albümün tüm parçalarını gösterir', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  press(wizard, '/', ...'gece'.split(''));
  // "gece" albümü + mimi'deki "Gece Lambasi" parçası eşleşir.
  const labels = wizard.getViewModel().items.map((i) => i.label);
  assert.ok(labels.includes('Uzak Sehir'));
  assert.ok(labels.includes('Gece Lambasi'));
});

test('Tab yalnızca GÖRÜNEN parçaları seçer (arama açıkken harfler sorguya gider)', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  press(wizard, '/', ...'yagmur'.split(''));
  press(wizard, ['', { tab: true }]);
  assert.match(wizard.getViewModel().hint, /Selected: 1/);
  // 'a' arama açıkken sorguya yazılır, seçim yapmaz.
  press(wizard, 'a');
  assert.equal(wizard.getViewModel().search, 'yagmura');
});

test('arama Esc ile kapanır, liste tamamlanır', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  press(wizard, '/', ...'yagmur'.split(''));
  press(wizard, 'esc');
  assert.equal(wizard.getViewModel().search, null);
  assert.equal(wizard.getViewModel().items.length, 6);
});

test('hiç seçim yapılmazsa plan tüm kütüphaneyi kullanır', async () => {
  const { wizard, service } = await openWizard();
  toSummary(wizard);
  await pressAsync(wizard, 'enter'); // START STREAM (imleç varsayılan olarak burada)
  assert.equal(service.applied[0].usesWholeLibrary, true);
});

// ─── Sıralama ───────────────────────────────────────────────────────────

test('sıralama adımı seçili parçaları numaralı gösterir', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  moveTo(wizard, 'mimi');
  press(wizard, 'space', 'enter');
  const vm = wizard.getViewModel();
  assert.equal(vm.step, 'order');
  assert.deepEqual(vm.items.map((i) => i.number), [1, 2, 3]);
  assert.deepEqual(vm.items.map((i) => i.label), ['Sakin Sabah', 'Yagmur', 'Gece Lambasi']);
});

test('Shift+↓ parçayı aşağı taşır ve imleç onunla gider', async () => {
  const { wizard, service } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  moveTo(wizard, 'mimi');
  press(wizard, 'space', 'enter');
  press(wizard, 'shiftDown');
  const vm = wizard.getViewModel();
  assert.deepEqual(vm.items.map((i) => i.label), ['Yagmur', 'Sakin Sabah', 'Gece Lambasi']);
  assert.equal(vm.items[1].selected, true);

  press(wizard, 'enter'); // order → pomodoro
  choose(wizard, 'No');
  await pressAsync(wizard, 'enter');
  assert.deepEqual(service.applied[0].music.albums[0].trackPaths, [
    'X:/mimi/2.m4a', 'X:/mimi/1.m4a', 'X:/mimi/3.m4a',
  ]);
});

test('x seçimden çıkarır', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  moveTo(wizard, 'mimi');
  press(wizard, 'space', 'enter');
  press(wizard, 'x');
  assert.deepEqual(wizard.getViewModel().items.map((i) => i.label), ['Yagmur', 'Gece Lambasi']);
});

test('m sıralama modunu değiştirir ve plana yansır', async () => {
  const { wizard, service } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  press(wizard, 'enter'); // music: seçim yok → order
  assert.equal(wizard.getViewModel().step, 'order');
  press(wizard, 'm');
  assert.ok(wizard.getViewModel().footer.some((f) => f.label === 'sıra: shuffle'));
  press(wizard, 'enter'); // order → pomodoro
  choose(wizard, 'No');
  await pressAsync(wizard, 'enter');
  assert.equal(service.applied[0].music.order, 'shuffle');
});

test('farklı albümlerin parçaları birbirine taşınmaz (playlist tek albümden oluşur)', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  moveTo(wizard, 'Gece Lambasi');
  press(wizard, 'space');
  moveTo(wizard, 'Uzak Sehir');
  press(wizard, 'space', 'enter');
  const before = wizard.getViewModel().items.map((i) => i.label);
  press(wizard, 'shiftDown'); // sınırı geçmeye çalış
  assert.deepEqual(wizard.getViewModel().items.map((i) => i.label), before);
});

// ─── Pomodoro ───────────────────────────────────────────────────────────

test('serbest süre formu tür metnini üretir ve tur sayısını saklar', async () => {
  const { wizard, service } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  press(wizard, 'enter');
  press(wizard, 'enter');
  choose(wizard, 'Yes');
  moveTo(wizard, 'Custom');
  press(wizard, 'enter');
  assert.equal(wizard.getViewModel().step, 'pomodoroCustom');

  // Alanlar ön dolu (50/10/4): hepsini silip yeniden yaz.
  const clear = () => { for (let i = 0; i < 4; i++) press(wizard, ['', { backspace: true }]); };
  clear(); press(wizard, '4', '5');
  press(wizard, 'down'); clear(); press(wizard, '1', '5');
  press(wizard, 'down'); clear(); press(wizard, '6');
  press(wizard, 'enter');

  assert.equal(wizard.getViewModel().step, 'studyVideo');
  press(wizard, 'enter', 'enter'); // study, break: varsayılan
  await pressAsync(wizard, 'enter'); // START
  assert.equal(service.applied[0].pomodoro.type, '45+15');
  assert.equal(service.applied[0].pomodoro.rounds, 6);
});

// Serbest tür yeniden düzenlenirken form O ANKİ dakikalarla açılmalı: eskiden hazır
// türün 50/10'una dönüyor ve kullanıcının süresi sessizce kayboluyordu.
test('serbest tür yeniden düzenlenince form mevcut süreleri gösterir', async () => {
  const basePlan = new StreamPlan({ pomodoro: { enabled: true, type: '45+15', rounds: 6 } });
  const { wizard } = await openWizard({ basePlan });
  choose(wizard, 'Mevcut planla devam — adsız');
  press(wizard, 'enter'); // cover
  press(wizard, 'enter'); // music
  press(wizard, 'enter'); // order
  press(wizard, 'enter'); // pomodoro (imleç "Yes" üstünde)
  press(wizard, 'enter'); // pomodoroType (imleç "Custom" üstünde)
  assert.equal(wizard.getViewModel().step, 'pomodoroCustom');
  assert.deepEqual(wizard.getViewModel().form.map((f) => f.value), ['45', '15', '6']);
});

// Formda hazır bir süre girilirse tür artık serbest değildir; akış yine studyVideo'ya
// gitmeli (eskiden en başa, cover'a dönüyordu).
test('formda hazır süre girilse de akış study adımına devam eder', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  press(wizard, 'enter');
  press(wizard, 'enter');
  choose(wizard, 'Yes');
  moveTo(wizard, 'Custom');
  press(wizard, 'enter');
  press(wizard, 'enter'); // 50/10 olduğu gibi onayla
  assert.equal(wizard.getViewModel().step, 'studyVideo');
});

test('serbest süre formunda sıfır reddedilir', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  press(wizard, 'enter');
  press(wizard, 'enter');
  choose(wizard, 'Yes');
  moveTo(wizard, 'Custom');
  press(wizard, 'enter');
  for (let i = 0; i < 4; i++) press(wizard, ['', { backspace: true }]);
  press(wizard, '0', 'enter');
  assert.match(wizard.getViewModel().error, /pozitif tam sayı/);
  assert.equal(wizard.getViewModel().step, 'pomodoroCustom');
});

test('study ve break video havuzları bağımsız ve ÇOKLU seçilir (N3)', async () => {
  const { wizard, service } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  press(wizard, 'enter');
  press(wizard, 'enter');
  choose(wizard, 'Yes');
  choose(wizard, '50 min study / 10 min break');
  assert.equal(wizard.getViewModel().step, 'studyVideo');
  moveTo(wizard, 'assets/study.mp4');
  press(wizard, 'space', 'enter'); // seç + devam
  assert.equal(wizard.getViewModel().step, 'breakVideo');
  moveTo(wizard, 'assets/break.mp4');
  press(wizard, 'space', 'enter');
  await pressAsync(wizard, 'enter'); // START
  assert.deepEqual(service.applied[0].pomodoro.studyVideos, ['X:/assets/study.mp4']);
  assert.deepEqual(service.applied[0].pomodoro.breakVideos, ['X:/assets/break.mp4']);
});

test('study/break adımında hiç seçim yapılmazsa havuz boş kalır (mevcut davranış)', async () => {
  const { wizard, service } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  press(wizard, 'enter');
  press(wizard, 'enter');
  choose(wizard, 'Yes');
  choose(wizard, '50 min study / 10 min break');
  press(wizard, 'enter'); // studyVideo: hiç seçim yapmadan devam
  press(wizard, 'enter'); // breakVideo: aynı
  await pressAsync(wizard, 'enter');
  assert.deepEqual(service.applied[0].pomodoro.studyVideos, []);
  assert.deepEqual(service.applied[0].pomodoro.breakVideos, []);
});

test('study videosunda birden çok klip seçilebilir', async () => {
  const { wizard, service } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  press(wizard, 'enter');
  press(wizard, 'enter');
  choose(wizard, 'Yes');
  choose(wizard, '50 min study / 10 min break');
  moveTo(wizard, 'mimi/bg.mp4');
  press(wizard, 'space');
  moveTo(wizard, 'assets/study.mp4');
  press(wizard, 'space', 'enter');
  press(wizard, 'enter'); // breakVideo: seçim yok
  await pressAsync(wizard, 'enter');
  assert.deepEqual(service.applied[0].pomodoro.studyVideos, ['X:/mimi/bg.mp4', 'X:/assets/study.mp4']);
});

// ─── Özet, Edit, Save ───────────────────────────────────────────────────

test('özet seçimleri, toplam süreyi ve geçiş davranışını gösterir', async () => {
  const { wizard } = await openWizard();
  choose(wizard, 'Yeni yapılandırma…');
  choose(wizard, '(kapak değiştirilmesin)');
  moveTo(wizard, 'mimi');
  press(wizard, 'space', 'enter'); // music → order
  press(wizard, 'enter'); // order → pomodoro
  choose(wizard, 'Yes');
  choose(wizard, '50 min study / 10 min break');
  press(wizard, 'enter'); // studyVideo: seçim yapmadan devam
  press(wizard, 'enter'); // breakVideo: aynı
  const vm = wizard.getViewModel();
  assert.equal(vm.step, 'summary');
  const value = (label) => vm.summary.find((l) => l.label === label).value;
  assert.equal(value('Music'), '3 parça / 1 albüm');
  assert.equal(value('Total Music'), '06:00');
  assert.equal(value('Pomodoro'), 'YES');
  assert.equal(value('Study'), '50 min');
  assert.equal(value('Break'), '10 min');
  assert.match(value('Transitions'), /3 uyarı bipi/);
});

test('özette seçim yoksa tüm kütüphanenin süresi gösterilir', async () => {
  const { wizard } = await openWizard();
  toSummary(wizard);
  const vm = wizard.getViewModel();
  assert.match(vm.summary.find((l) => l.label === 'Music').value, /tüm kütüphane/);
  assert.equal(vm.summary.find((l) => l.label === 'Total Music').value, '07:30');
});

test('Edit bir adıma döner, o adım bitince ÖZETE geri gelir', async () => {
  const { wizard } = await openWizard();
  toSummary(wizard);
  moveTo(wizard, 'Edit');
  press(wizard, 'enter');
  assert.equal(wizard.getViewModel().step, 'edit');
  moveTo(wizard, 'Cover');
  press(wizard, 'enter');
  assert.equal(wizard.getViewModel().step, 'cover');
  press(wizard, 'enter'); // kapak seç
  assert.equal(wizard.getViewModel().step, 'summary');
});

test('Save Configuration preset olarak kaydeder, özet ekranında kalır', async () => {
  const { wizard, service } = await openWizard();
  toSummary(wizard);
  moveTo(wizard, 'Save Configuration');
  press(wizard, 'enter');
  press(wizard, ...'Gece Yagmuru'.split(''), 'enter');
  assert.deepEqual(service.presets.map((p) => p.plan.name), ['Gece Yagmuru']);
  assert.equal(wizard.getViewModel().step, 'summary');
  assert.match(wizard.getViewModel().notice, /preset kaydedildi/);
  assert.deepEqual(service.applied, []); // kaydetmek yayına çıkarmaz
});

test('preset adı boş bırakılamaz', async () => {
  const { wizard } = await openWizard();
  toSummary(wizard);
  moveTo(wizard, 'Save Configuration');
  press(wizard, 'enter', 'enter');
  assert.match(wizard.getViewModel().error, /ad boş olamaz/);
});

test('kayıtlı preset seçilince ayarlar hazır gelir', async () => {
  const service = fakeService();
  service.savePreset(new StreamPlan({
    name: 'Cozy Study',
    cover: 'X:/assets/kapak.jpg',
    music: { order: 'shuffle', albums: [{ name: 'mimi', trackPaths: ['X:/mimi/2.m4a'] }] },
    pomodoro: { enabled: true, type: '45+15', rounds: 3, studyVideo: 'X:/assets/study.mp4' },
  }));
  const { wizard } = await openWizard({ service });
  const vm = wizard.getViewModel();
  assert.deepEqual(vm.items.map((i) => i.label), ['Cozy Study', 'Yeni yapılandırma…']);
  choose(wizard, 'Cozy Study'); // preset seç
  // Her adımda imleç PRESET'ten gelen değerin üstünde: hepsini onaylayarak özete git.
  // Adım sayısı Pomodoro açık/kapalı olmasına göre değiştiği için sabit sayı yerine döngü.
  for (let i = 0; i < 12 && wizard.getViewModel().step !== 'summary'; i++) press(wizard, 'enter');
  const summary = wizard.getViewModel();
  assert.equal(summary.step, 'summary');
  const value = (label) => summary.summary.find((l) => l.label === label).value;
  assert.equal(value('Study'), '45 min');
  assert.equal(value('Break'), '15 min');
  assert.equal(value('Music'), '1 parça / 1 albüm');
  assert.match(value('Cover'), /kapak\.jpg/);
});

test('"mevcut planla devam" seçeneği aktif plan varken listenin başında', async () => {
  const basePlan = new StreamPlan({ name: 'Son Kullanılan' });
  const { wizard } = await openWizard({ basePlan });
  assert.match(wizard.getViewModel().items[0].label, /Mevcut planla devam — Son Kullanılan/);
});

// ─── Çıkış, iptal, hata ─────────────────────────────────────────────────

test('START STREAM planı uygular ve sihirbaz kapanır', async () => {
  const { wizard, service, exits } = await openWizard();
  toSummary(wizard);
  await pressAsync(wizard, 'enter');
  assert.equal(service.applied.length, 1);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].started, true);
});

test('Cancel planı uygulamaz', async () => {
  const { wizard, service, exits } = await openWizard();
  toSummary(wizard);
  moveTo(wizard, 'Cancel');
  press(wizard, 'enter');
  assert.deepEqual(service.applied, []);
  assert.equal(exits[0].cancelled, true);
});

test('Ctrl+C iptal eder (yayına komut gitmez)', async () => {
  const { wizard, service, exits } = await openWizard();
  press(wizard, ['c', { ctrl: true }]);
  assert.deepEqual(service.applied, []);
  assert.equal(exits[0].cancelled, true);
});

test('ilk adımda Esc sihirbazdan çıkar', async () => {
  const { wizard, exits } = await openWizard();
  press(wizard, 'esc');
  assert.equal(exits[0].cancelled, true);
});

test('Esc bir adım geri alır', async () => {
  const { wizard } = await openWizard();
  press(wizard, 'enter', 'enter'); // cover → music
  press(wizard, 'esc');
  assert.equal(wizard.getViewModel().step, 'cover');
});

test('uygulama hatası sihirbazı kapatmaz, hata gösterilir', async () => {
  const service = fakeService({ applyAndRestart: async () => { throw new Error('ffmpeg yok'); } });
  const { wizard, exits } = await openWizard({ service });
  toSummary(wizard);
  await pressAsync(wizard, 'enter');
  assert.match(wizard.getViewModel().error, /ffmpeg yok/);
  assert.deepEqual(exits, []);
  assert.equal(wizard.getViewModel().busy, null);
});

test('kütüphane okunamazsa sihirbaz açılır ve hatayı gösterir', async () => {
  const service = fakeService({ listAlbums: async () => { throw new Error('disk yok'); } });
  const { wizard } = await openWizard({ service });
  assert.match(wizard.getViewModel().error, /kütüphane okunamadı/);
  assert.equal(wizard.getViewModel().busy, null);
});

test('uygulama sürerken tuşlar yoksayılır (çifte START olmasın)', async () => {
  let resolveApply;
  const service = fakeService({
    applyAndRestart: () => new Promise((r) => { resolveApply = () => r({ plan: new StreamPlan({}), warnings: [] }); }),
  });
  const { wizard } = await openWizard({ service });
  toSummary(wizard);
  const pending = wizard.handleInput('', { return: true });
  assert.ok(wizard.getViewModel().busy);
  press(wizard, 'enter', 'esc', 'down'); // hepsi yoksayılmalı
  assert.ok(wizard.getViewModel().busy);
  resolveApply();
  await pending;
});

test('configService zorunlu', () => {
  assert.throws(() => new ConfigWizard({}), /configService gerekli/);
});

test('shortPath son iki yol bileşenini verir (platformdan bağımsız)', () => {
  assert.equal(shortPath('X:\\music-source\\mimi\\break.mp4'), 'mimi/break.mp4');
  assert.equal(shortPath('/home/x/assets/kapak.jpg'), 'assets/kapak.jpg');
});

test('uygulama sürerken Ctrl+C sihirbazı KAPATMAZ, durumu söyler', async () => {
  // 10 Ekim 2026: Ctrl+C busy kapısının üstündeydi. Sihirbaz "iptal edildi" diyip
  // kapanıyor, arka plandaki iş sürüyor ve bitince kapanmış sihirbaz üzerinden
  // "başlatıldı" diyordu — iptal edilemeyen bir iş iptal edilmiş gibi görünüyordu.
  let resolveApply;
  const service = fakeService({
    applyAndRestart: () => new Promise((r) => { resolveApply = () => r({ plan: new StreamPlan({}), warnings: [] }); }),
  });
  const { wizard, exits } = await openWizard({ service });
  toSummary(wizard);
  const pending = wizard.handleInput('', { return: true });

  wizard.handleInput('c', { ctrl: true });
  assert.deepEqual(exits, [], 'sihirbaz kapanmamalı');
  assert.match(wizard.getViewModel().notice, /iptal edilemez/);

  resolveApply();
  await pending;
  assert.deepEqual(exits.map((e) => e.started), [true], 'iş bitince tek sonuç: başlatıldı');
});
