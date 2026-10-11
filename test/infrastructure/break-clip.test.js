const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureStreamClip } = require('../../src/infrastructure/break-clip');

const log = { info() {}, warn() {} };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-clip-'));
  const src = path.join(dir, 'kaynak.mp4');
  fs.writeFileSync(src, 'x');
  return { dir, src };
}

test('klip geçici dosyaya yazılır, sonra yerine taşınır (canlı dosya yerinde yazılmaz)', async () => {
  const { dir, src } = setup();
  const out = path.join(dir, 'study-1.mp4');
  fs.writeFileSync(out, 'ESKI');
  let writtenTo = null;
  const convert = async (_s, target) => { writtenTo = target; fs.writeFileSync(target, 'YENI'); return { ok: true, seconds: 1, note: 'n' }; };
  const result = await ensureStreamClip({ sourcePath: src, runtimeDir: dir, log, name: 'study-1', convert });
  assert.equal(result, out);
  assert.notEqual(writtenTo, out, 'dönüştürücü canlı dosyaya doğrudan yazmamalı');
  assert.equal(fs.readFileSync(out, 'utf8'), 'YENI');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), [], 'geçici dosya kalmamalı');
});

test('dönüşüm başarısızsa mevcut klip BOZULMAZ, geçici dosya silinir', async () => {
  const { dir, src } = setup();
  const out = path.join(dir, 'study-1.mp4');
  fs.writeFileSync(out, 'ESKI');
  const convert = async (_s, target) => { fs.writeFileSync(target, 'YARIM'); return { ok: false, stderr: 'hata', seconds: 0, note: '' }; };
  const result = await ensureStreamClip({ sourcePath: src, runtimeDir: dir, log, name: 'study-1', convert });
  assert.equal(result, null);
  assert.equal(fs.readFileSync(out, 'utf8'), 'ESKI');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
});

test('önbellek geçerli ama klip bozuksa yeniden üretilir', async () => {
  const { dir, src } = setup();
  const out = path.join(dir, 'study-1.mp4');
  const stat = fs.statSync(src);
  fs.writeFileSync(out, 'BOZUK');
  fs.writeFileSync(path.join(dir, 'study-1.json'), JSON.stringify({ source: src, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }));
  let converted = 0;
  const convert = async (_s, target) => { converted += 1; fs.writeFileSync(target, 'TEMIZ'); return { ok: true, seconds: 1, note: 'n' }; };
  const result = await ensureStreamClip({
    sourcePath: src, runtimeDir: dir, log, name: 'study-1', convert, verify: async (f) => fs.readFileSync(f, 'utf8') === 'TEMIZ',
  });
  assert.equal(result, out);
  assert.equal(converted, 1);
  assert.equal(fs.readFileSync(out, 'utf8'), 'TEMIZ');
});

test('önbellek geçerli ve klip sağlamsa yeniden üretilmez', async () => {
  const { dir, src } = setup();
  const out = path.join(dir, 'study-1.mp4');
  const stat = fs.statSync(src);
  fs.writeFileSync(out, 'TEMIZ');
  fs.writeFileSync(path.join(dir, 'study-1.json'), JSON.stringify({ source: src, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }));
  const convert = async () => { throw new Error('çağrılmamalı'); };
  const result = await ensureStreamClip({ sourcePath: src, runtimeDir: dir, log, name: 'study-1', convert, verify: async () => true });
  assert.equal(result, out);
});

test('klip dönüşümü düşük öncelik ve tek iş parçacığı ister', () => {
  const { ENCODE_ARGS, LOW_PRIORITY, lowerPriority } = require('../../src/infrastructure/clip-normalizer');
  const i = ENCODE_ARGS.indexOf('-threads');
  assert.ok(i >= 0 && ENCODE_ARGS[i + 1] === '1');
  const calls = [];
  lowerPriority({ pid: 123 }, (pid, prio) => calls.push([pid, prio]));
  assert.deepEqual(calls, [[123, LOW_PRIORITY]]);
  // pid yoksa ya da setPriority atarsa sessizce geçer.
  lowerPriority({}, () => { throw new Error('olmamalı'); });
  lowerPriority({ pid: 1 }, () => { throw new Error('yetki yok'); });
});
