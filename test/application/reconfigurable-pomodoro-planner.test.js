const test = require('node:test');
const assert = require('node:assert/strict');

const { ReconfigurablePomodoroPlanner } = require('../../src/application/reconfigurable-pomodoro-planner');
const { StreamPlan } = require('../../src/domain/stream-plan');

const silentLog = { info() {}, warn() {} };

// Gerçek PomodoroPlanner yerine sayaç: sarmalayıcının İŞİ "hangi planlayıcı geçerli",
// pomodoro mantığı değil (o pomodoro-planner.test.js'te).
function make({ plan = null, breakClip = null } = {}) {
  const built = [];
  let current = plan;
  let clip = breakClip;
  const planner = new ReconfigurablePomodoroPlanner({
    planProvider: () => current,
    breakClipProvider: () => clip,
    log: silentLog,
    createPlanner: (opts) => {
      built.push(opts);
      return { plan: ({ durationSeconds }) => ({ type: opts.type, durationSeconds, breakClipPath: opts.breakClipPath }) };
    },
  });
  return {
    planner,
    built,
    setPlan: (p) => { current = p; },
    setClip: (c) => { clip = c; },
  };
}

const enabled = (type = '50+10') => new StreamPlan({ pomodoro: { enabled: true, type } });

test('plan yoksa null döner — encoder bugünküyle aynı argümanları alır', () => {
  const { planner, built } = make();
  assert.equal(planner.plan({ durationSeconds: 600 }), null);
  assert.deepEqual(built, []);
});

test('pomodoro kapalıysa planlayıcı hiç kurulmaz', () => {
  const { planner, built } = make({ plan: new StreamPlan({ pomodoro: { enabled: false } }) });
  assert.equal(planner.plan({ durationSeconds: 600 }), null);
  assert.deepEqual(built, []);
});

test('pomodoro açıkken planlayıcı kurulur ve plan() sonucu geçer', () => {
  const { planner, built } = make({ plan: enabled('30+10') });
  const result = planner.plan({ durationSeconds: 900 });
  assert.equal(result.type, '30+10');
  assert.equal(result.durationSeconds, 900);
  assert.equal(built.length, 1);
});

test('imza değişmedikçe planlayıcı YENİDEN kurulmaz (döngü başlangıcı korunur)', () => {
  const { planner, built } = make({ plan: enabled() });
  planner.plan({ durationSeconds: 600 });
  planner.plan({ durationSeconds: 700 });
  planner.plan({ durationSeconds: 800 });
  assert.equal(built.length, 1);
});

test('tür değişince planlayıcı yeniden kurulur', () => {
  const { planner, built, setPlan } = make({ plan: enabled('50+10') });
  planner.plan({ durationSeconds: 600 });
  setPlan(enabled('45+15'));
  const result = planner.plan({ durationSeconds: 600 });
  assert.equal(result.type, '45+15');
  assert.deepEqual(built.map((b) => b.type), ['50+10', '45+15']);
});

test('yalnızca mola klibi değişse de yeniden kurulur', () => {
  const { planner, built, setClip } = make({ plan: enabled(), breakClip: null });
  planner.plan({ durationSeconds: 600 });
  setClip('X:/runtime/break.mp4');
  const result = planner.plan({ durationSeconds: 600 });
  assert.equal(result.breakClipPath, 'X:/runtime/break.mp4');
  assert.equal(built.length, 2);
});

test('çalışırken kapatılırsa sonraki çalıştırmada null döner', () => {
  const { planner, setPlan } = make({ plan: enabled() });
  assert.ok(planner.plan({ durationSeconds: 600 }));
  setPlan(new StreamPlan({ pomodoro: { enabled: false } }));
  assert.equal(planner.plan({ durationSeconds: 600 }), null);
});

test('kapandıktan sonra tekrar açılırsa yeniden kurulur', () => {
  const { planner, built, setPlan } = make({ plan: enabled() });
  planner.plan({ durationSeconds: 600 });
  setPlan(new StreamPlan({ pomodoro: { enabled: false } }));
  planner.plan({ durationSeconds: 600 });
  setPlan(enabled());
  assert.ok(planner.plan({ durationSeconds: 600 }));
  assert.equal(built.length, 2);
});
