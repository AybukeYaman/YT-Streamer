const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StreamPlanStore, slugify } = require('../../src/infrastructure/stream-plan-store');
const { writeFileAtomic } = require('../../src/infrastructure/atomic-file');
const { StreamPlan } = require('../../src/domain/stream-plan');

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-plan-store-'));
  const warnings = [];
  const log = { info() {}, warn: (m) => warnings.push(m) };
  try {
    return fn({
      store: new StreamPlanStore({ runtimeDir: dir, writeFile: writeFileAtomic, log }),
      dir,
      warnings,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('plan dosyası yoksa null (plansız = mevcut davranış)', () => {
  withStore(({ store }) => assert.equal(store.loadActive(), null));
});

test('aktif plan yazılır ve geri okunur', () => {
  withStore(({ store }) => {
    const plan = new StreamPlan({
      name: 'Cozy Study',
      music: { order: 'shuffle', albums: [{ name: 'mimi', trackPaths: ['X:/1.m4a'] }] },
      pomodoro: { enabled: true, type: '45+15' },
    });
    store.saveActive(plan);
    const loaded = store.loadActive();
    assert.equal(loaded.name, 'Cozy Study');
    assert.equal(loaded.music.order, 'shuffle');
    assert.equal(loaded.pomodoro.type, '45+15');
    assert.deepEqual(loaded.music.albums[0].trackPaths, ['X:/1.m4a']);
  });
});

test('kaydedilme zamanı metadata\'ya yazılır (yayın akışı okumaz)', () => {
  withStore(({ store }) => {
    const saved = store.saveActive(new StreamPlan({ name: 'x' }));
    assert.match(saved.metadata.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('bozuk plan dosyası = plan yok; yayın plansız başlar, sebebi loglanır', () => {
  withStore(({ store, dir, warnings }) => {
    fs.writeFileSync(path.join(dir, 'stream-plan.json'), '{ bu json degil');
    assert.equal(store.loadActive(), null);
    assert.ok(warnings.some((w) => /aktif plan kullanılamadı/.test(w)));
  });
});

test('geçersiz ama okunabilir plan da reddedilir (doğrulama domain\'de)', () => {
  withStore(({ store, dir, warnings }) => {
    fs.writeFileSync(path.join(dir, 'stream-plan.json'), JSON.stringify({ pomodoro: { type: 'elli' } }));
    assert.equal(store.loadActive(), null);
    assert.ok(warnings.some((w) => /pomodoro\.type/.test(w)));
  });
});

test('preset kaydet / listele / sil', () => {
  withStore(({ store }) => {
    assert.deepEqual(store.listPresets(), []);
    const { slug } = store.savePreset(new StreamPlan({ name: 'Cozy Study 50/10' }));
    assert.equal(slug, 'cozy-study-50-10');
    assert.deepEqual(store.listPresets().map((p) => p.plan.name), ['Cozy Study 50/10']);
    assert.equal(store.deletePreset(slug), true);
    assert.deepEqual(store.listPresets(), []);
    // Olmayan preset: hata değil, false.
    assert.equal(store.deletePreset('yok'), false);
  });
});

test('aynı adla kaydetmek güncelleme sayılır (kopya üretmez)', () => {
  withStore(({ store }) => {
    store.savePreset(new StreamPlan({ name: 'Gece', pomodoro: { enabled: true, type: '50+10' } }));
    store.savePreset(new StreamPlan({ name: 'Gece', pomodoro: { enabled: true, type: '30+10' } }));
    const presets = store.listPresets();
    assert.equal(presets.length, 1);
    assert.equal(presets[0].plan.pomodoro.type, '30+10');
  });
});

test('okunamayan preset atlanır, diğerleri listelenir', () => {
  withStore(({ store, dir, warnings }) => {
    store.savePreset(new StreamPlan({ name: 'Saglam' }));
    fs.writeFileSync(path.join(dir, 'presets', 'bozuk.json'), 'yok');
    assert.deepEqual(store.listPresets().map((p) => p.plan.name), ['Saglam']);
    assert.ok(warnings.some((w) => /preset "bozuk"/.test(w)));
  });
});

test('preset listesi ada göre sıralı', () => {
  withStore(({ store }) => {
    for (const name of ['Zar', 'Alfa', 'Mimi']) store.savePreset(new StreamPlan({ name }));
    assert.deepEqual(store.listPresets().map((p) => p.plan.name), ['Alfa', 'Mimi', 'Zar']);
  });
});

test('slugify: türkçe karakterler ve boşluklar dosya adında güvenli hale gelir', () => {
  assert.equal(slugify('Çalışma Şöleni'), 'calisma-soleni');
  assert.equal(slugify('  Deep  Focus 30/10 '), 'deep-focus-30-10');
  assert.equal(slugify('???'), 'preset');
});

test('plan ve preset dosyaları runtime altında, birbirinden ayrı', () => {
  withStore(({ store, dir }) => {
    store.saveActive(new StreamPlan({ name: 'aktif' }));
    store.savePreset(new StreamPlan({ name: 'kayit' }));
    assert.ok(fs.existsSync(path.join(dir, 'stream-plan.json')));
    assert.ok(fs.existsSync(path.join(dir, 'presets', 'kayit.json')));
    // Preset kaydetmek aktif planı değiştirmez.
    assert.equal(store.loadActive().name, 'aktif');
  });
});
