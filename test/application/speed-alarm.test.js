// Yavaş/anormal encode bildirimi: bekleme penceresi, tek alarm, "düzeldi" ve salınım.
const test = require('node:test');
const assert = require('node:assert/strict');

const { SpeedAlarm } = require('../../src/application/speed-alarm');

const flush = () => new Promise((r) => setImmediate(r));

function setup(opts = {}) {
  const sent = [];
  const lines = [];
  const alerter = { fail: false, async alert(p) { sent.push(p); if (this.fail) throw new Error('webhook 500'); } };
  const rec = (level) => (m) => lines.push({ level, m });
  const alarm = new SpeedAlarm({ alerter, log: { info: rec('info'), warn: rec('warn') }, ...opts });
  return { alarm, sent, lines, alerter };
}

// Pencereyi taklit eden durum: eşikler status'a orchestrator tarafından ekleniyor.
const status = (state, average) => ({ state, average, low: 0.95, high: 1.1 });

test('yavaşlık bekleme penceresinden KISA sürerse alarm gitmez', async () => {
  const { alarm, sent } = setup({ dwellMs: 60000 });
  alarm.update(status('slow', 0.8), 0);
  alarm.update(status('slow', 0.8), 59999);
  await flush();
  assert.deepEqual(sent, []);
});

test('yavaşlık pencere kadar sürerse TEK alarm gider', async () => {
  const { alarm, sent, lines } = setup({ dwellMs: 60000 });
  alarm.update(status('slow', 0.82), 0);
  alarm.update(status('slow', 0.80), 60000);
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].level, 'error');
  assert.match(sent[0].title, /encode hızı/);
  assert.match(sent[0].message, /ENCODE YETİŞEMİYOR: hız 0\.800x \(eşik 0\.95\)/);
  assert.match(sent[0].message, /60 sn sürüyor/);
  assert.ok(lines.some((l) => l.level === 'warn'));

  // Sürmeye devam etmesi yeni bildirim ÜRETMEZ.
  alarm.update(status('slow', 0.79), 180000);
  alarm.update(status('slow', 0.78), 600000);
  await flush();
  assert.equal(sent.length, 1);
});

test('normale dönünce "düzeldi" bildirimi gider, sonra yeni bir alarm mümkün olur', async () => {
  const { alarm, sent } = setup({ dwellMs: 1000 });
  alarm.update(status('slow', 0.8), 0);
  alarm.update(status('slow', 0.8), 1000);
  alarm.update(status('ok', 1.0), 2000);
  await flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].level, 'info');
  assert.match(sent[1].message, /normale döndü: 1\.000x/);

  alarm.update(status('slow', 0.9), 3000);
  alarm.update(status('slow', 0.9), 4000);
  await flush();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].level, 'error');
});

test('alarm gönderilmediyse normale dönüş sessizdir (gürültü yok)', async () => {
  const { alarm, sent } = setup({ dwellMs: 60000 });
  alarm.update(status('slow', 0.9), 0);
  alarm.update(status('ok', 1.0), 5000); // pencere dolmadan düzeldi
  await flush();
  assert.deepEqual(sent, []);
});

test('eşik etrafında salınım alarm yağmuru yapmaz', async () => {
  const { alarm, sent } = setup({ dwellMs: 60000 });
  for (let t = 0; t < 600000; t += 5000) {
    alarm.update(status(t % 10000 === 0 ? 'slow' : 'ok', 0.949), t);
  }
  await flush();
  assert.deepEqual(sent, []); // hiçbir anormallik 60 sn kesintisiz sürmedi
});

test('anormallik türü değişirse (slow → fast) pencere baştan sayılır', async () => {
  const { alarm, sent } = setup({ dwellMs: 60000 });
  alarm.update(status('slow', 0.8), 0);
  alarm.update(status('fast', 1.5), 59000); // başka bir arıza: sayaç sıfırlanır
  alarm.update(status('fast', 1.5), 100000);
  await flush();
  assert.deepEqual(sent, []);
  alarm.update(status('fast', 1.5), 119000);
  await flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /ANORMAL ENCODE HIZI: hız 1\.500x \(eşik 1\.1\)/);
});

// Playlist sınırında ffmpeg yeniden başlıyor ve pencere 'warming'e dönüyor. Birikmiş
// süre yeni sürece yazılırsa restart'tan hemen sonraki ilk anormal örnek alarm verirdi.
test('warming (yeni ffmpeg süreci) bekleme penceresini sıfırlar', async () => {
  const { alarm, sent } = setup({ dwellMs: 60000 });
  alarm.update(status('slow', 0.8), 0);
  alarm.update(status('warming', null), 50000);
  alarm.update(status('slow', 0.8), 70000); // eski 0'dan sayılsaydı anında alarm olurdu
  await flush();
  assert.deepEqual(sent, []);
  alarm.update(status('slow', 0.8), 130000);
  await flush();
  assert.equal(sent.length, 1);
});

test('bozuk bildirim kanalı yutulur (yayın etkilenmez)', async () => {
  const { alarm, lines, alerter } = setup({ dwellMs: 1000 });
  alerter.fail = true;
  alarm.update(status('slow', 0.8), 0);
  alarm.update(status('slow', 0.8), 1000);
  await flush();
  assert.ok(lines.some((l) => l.level === 'warn' && /bildirim gönderilemedi \(webhook 500\)/.test(l.m)));
});
