const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  saveUploadedCover, detectImageType, CoverUploadError, MAX_UPLOAD_BYTES, MAX_OUTPUT_BYTES,
} = require('../../src/infrastructure/cover-upload');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yt-cover-'));

test('detectImageType: baytlardan tür anlaşılır, uzantıya/başlığa bakılmaz', () => {
  assert.equal(detectImageType(JPEG), 'jpg');
  assert.equal(detectImageType(PNG), 'png');
  assert.equal(detectImageType(WEBP), 'webp');
  assert.equal(detectImageType(Buffer.from('<html>bu bir görsel değil</html>')), null);
  assert.equal(detectImageType(Buffer.alloc(4)), null);
  assert.equal(detectImageType('metin'), null);
});

test('görsel olmayan dosya reddedilir, ffmpeg HİÇ çalışmaz', async () => {
  let called = false;
  await assert.rejects(
    saveUploadedCover({ buffer: Buffer.from('#!/bin/sh\nrm -rf /\n\n\n'), dir: tmp(), runFn: async () => { called = true; } }),
    (err) => err instanceof CoverUploadError && /desteklenmeyen biçim/.test(err.message),
  );
  assert.equal(called, false);
});

test('boş ve aşırı büyük dosya reddedilir', async () => {
  await assert.rejects(saveUploadedCover({ buffer: Buffer.alloc(0), dir: tmp() }), /boş/);
  const big = Buffer.concat([JPEG, Buffer.alloc(MAX_UPLOAD_BYTES)]);
  await assert.rejects(saveUploadedCover({ buffer: big, dir: tmp() }), /çok büyük/);
});

test('başarılı yol: 1280x720 JPEG üretilir, geçici dosyalar silinir', async () => {
  const dir = tmp();
  const seen = [];
  const runFn = async (cmd, args) => {
    seen.push(args);
    fs.writeFileSync(args[args.length - 1], 'jpegdata');
    return { code: 0, stderr: '' };
  };
  const out = await saveUploadedCover({ buffer: PNG, dir, runFn, now: () => 1234 });
  assert.equal(out, path.join(dir, 'galeri-1234.jpg'));
  assert.equal(fs.readFileSync(out, 'utf8'), 'jpegdata');
  assert.match(seen[0].join(' '), /scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720/);
  assert.ok(seen[0].includes('-threads'));
  assert.deepEqual(fs.readdirSync(dir), ['galeri-1234.jpg'], 'yükleme girdisi ve geçici çıktı kalmamalı');
});

test('2 MB sınırına sığmazsa kalite düşürülerek tekrar denenir', async () => {
  const dir = tmp();
  const qualities = [];
  const runFn = async (cmd, args) => {
    const q = Number(args[args.indexOf('-q:v') + 1]);
    qualities.push(q);
    fs.writeFileSync(args[args.length - 1], Buffer.alloc(q === 3 ? MAX_OUTPUT_BYTES + 1 : 1000));
    return { code: 0, stderr: '' };
  };
  const out = await saveUploadedCover({ buffer: JPEG, dir, runFn, now: () => 1 });
  assert.deepEqual(qualities, [3, 6]);
  assert.ok(fs.statSync(out).size <= MAX_OUTPUT_BYTES);
});

test('hiçbir kalitede sığmazsa anlaşılır hata, dosya kalmaz', async () => {
  const dir = tmp();
  const runFn = async (cmd, args) => {
    fs.writeFileSync(args[args.length - 1], Buffer.alloc(MAX_OUTPUT_BYTES + 1));
    return { code: 0, stderr: '' };
  };
  await assert.rejects(saveUploadedCover({ buffer: JPEG, dir, runFn }), /2 MB/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('ffmpeg başarısız olursa "bozuk olabilir" hatası, dosya kalmaz', async () => {
  const dir = tmp();
  const runFn = async () => ({ code: 1, stderr: 'Invalid data found' });
  await assert.rejects(saveUploadedCover({ buffer: JPEG, dir, runFn, log: { warn() {} } }), /işlenemedi/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

// Gerçek ffmpeg varsa uçtan uca: üretilen PNG → 1280x720 JPEG.
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('GERÇEK ffmpeg: PNG → 1280x720 JPEG', { skip: !hasFfmpeg && 'ffmpeg yok' }, async () => {
  const dir = tmp();
  const png = path.join(dir, 'girdi.png');
  const gen = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=900x1600:rate=1', '-frames:v', '1', png]);
  assert.equal(gen.status, 0);
  const out = await saveUploadedCover({ buffer: fs.readFileSync(png), dir: path.join(dir, 'covers'), now: () => 99 });
  assert.ok(out.endsWith('galeri-99.jpg'));
  assert.equal(detectImageType(fs.readFileSync(out)), 'jpg');
  assert.ok(fs.statSync(out).size <= MAX_OUTPUT_BYTES);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out], { encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), '1280,720');
});
