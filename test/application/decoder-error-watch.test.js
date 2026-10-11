const test = require('node:test');
const assert = require('node:assert/strict');

const { DecoderErrorWatch } = require('../../src/application/decoder-error-watch');

const LINE = '[vist#4:0/h264 @ 0x64e4] Error submitting packet to decoder: Invalid data found when processing input';

function setup(opts = {}) {
  const warns = [];
  const alerts = [];
  const watch = new DecoderErrorWatch({
    alerter: { alert: async (p) => { alerts.push(p); } },
    log: { warn: (m) => warns.push(m) },
    summaryEveryMs: 1000, alertThreshold: 5, alertCooldownMs: 60000, ...opts,
  });
  return { watch, warns, alerts };
}

test('ilgisiz satır yok sayılır (false döner)', () => {
  const { watch, warns } = setup();
  assert.equal(watch.record('frame=1 fps=24', 0), false);
  assert.equal(warns.length, 0);
});

test('ilk hata hemen loglanır, tekrarlayanlar tek tek loglanmaz', () => {
  const { watch, warns } = setup();
  for (let i = 0; i < 50; i++) assert.equal(watch.record(LINE, i), true);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /decoder hatası/);
});

test('pencere dolunca özet yazılır; eşik aşılırsa tek bildirim gider', async () => {
  const { watch, warns, alerts } = setup();
  for (let i = 0; i < 20; i++) watch.record(LINE, 10);
  watch.record(LINE, 2000); // pencere doldu → özet + alarm
  await new Promise((r) => setImmediate(r));
  assert.equal(warns.length, 2);
  assert.match(warns[1], /son 2 sn'de 21 hata/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, 'error');
});

test('eşik altında bildirim gitmez; bekleme süresi içinde ikinci bildirim gitmez', async () => {
  const { watch, alerts } = setup();
  watch.record(LINE, 0); watch.record(LINE, 2000); // pencere: 1 hata → eşik altı
  await new Promise((r) => setImmediate(r));
  assert.equal(alerts.length, 0);
  for (let i = 0; i < 10; i++) watch.record(LINE, 2100);
  watch.record(LINE, 4000); // 11 hata → alarm
  for (let i = 0; i < 10; i++) watch.record(LINE, 4100);
  watch.record(LINE, 6000); // yine eşik üstü ama cooldown içinde
  await new Promise((r) => setImmediate(r));
  assert.equal(alerts.length, 1);
});

test('bildirim gönderilemezse hata fırlatmaz', async () => {
  const warns = [];
  const watch = new DecoderErrorWatch({
    alerter: { alert: async () => { throw new Error('ağ yok'); } },
    log: { warn: (m) => warns.push(m) }, summaryEveryMs: 1000, alertThreshold: 1,
  });
  watch.record(LINE, 0); watch.record(LINE, 2000);
  await new Promise((r) => setImmediate(r));
  assert.ok(warns.some((m) => /bildirim gönderilemedi/.test(m)));
});
