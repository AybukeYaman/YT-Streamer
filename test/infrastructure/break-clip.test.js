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
