const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { StreamProfile, StreamProfileError } = require('../../src/domain/stream-profile');
const { loadConfig } = require('../../src/config/load-config');

const VALID = {
  width: 1280, height: 720, fps: 24,
  videoBitrate: '2500k', audioBitrate: '160k',
  preset: 'veryfast',
};

function problemsOf(overrides) {
  try {
    new StreamProfile({ ...VALID, ...overrides });
  } catch (err) {
    assert.ok(err instanceof StreamProfileError, `beklenmeyen hata tipi: ${err}`);
    return err.problems;
  }
  assert.fail('hata bekleniyordu');
}

test('geçerli profil: değerler aynen taşınır', () => {
  const p = new StreamProfile(VALID);
  assert.equal(p.width, 1280);
  assert.equal(p.height, 720);
  assert.equal(p.fps, 24);
  assert.equal(p.preset, 'veryfast');
  assert.equal(p.videoBitrate, '2500k');
  assert.equal(p.audioBitrate, '160k');
});

test('gopSize = fps × 2', () => {
  assert.equal(new StreamProfile(VALID).gopSize, 48);
  assert.equal(new StreamProfile({ ...VALID, fps: 30 }).gopSize, 60);
});

test('maxRate = videoBitrate, bufferSize = 2 × videoBitrate', () => {
  const p = new StreamProfile(VALID);
  assert.equal(p.maxRate, '2500k');
  assert.equal(p.bufferSize, '5000k');
  assert.equal(new StreamProfile({ ...VALID, videoBitrate: '2.5M' }).bufferSize, '5000k');
});

test('Faz 1 sabitleri', () => {
  const p = new StreamProfile(VALID);
  assert.equal(p.videoCodec, 'libx264');
  assert.equal(p.h264Profile, 'main');
  assert.equal(p.pixelFormat, 'yuv420p');
  assert.equal(p.audioCodec, 'aac');
  assert.equal(p.audioSampleRate, 48000);
  assert.equal(p.audioChannels, 2);
});

test('nesne değiştirilemez', () => {
  const p = new StreamProfile(VALID);
  assert.ok(Object.isFrozen(p));
  assert.throws(() => { 'use strict'; p.fps = 60; }, TypeError);
});

test('geçersiz fps reddedilir', () => {
  for (const fps of [0, -24, 23.976, '24', undefined]) {
    assert.match(problemsOf({ fps }).join(), /fps/, `fps=${fps}`);
  }
});

test('tek sayılı ya da pozitif olmayan boyut reddedilir', () => {
  assert.match(problemsOf({ width: 1279 }).join(), /width çift sayı/);
  assert.match(problemsOf({ height: 0 }).join(), /height pozitif/);
});

test('geçersiz bitrate reddedilir', () => {
  for (const videoBitrate of ['2500', 'abc', '0k', 2500]) {
    assert.match(problemsOf({ videoBitrate }).join(), /videoBitrate/, `videoBitrate=${videoBitrate}`);
  }
  assert.match(problemsOf({ audioBitrate: '160' }).join(), /audioBitrate/);
});

test('bilinmeyen preset reddedilir', () => {
  assert.match(problemsOf({ preset: 'superslow' }).join(), /preset/);
});

test('birden fazla sorun tek hatada listelenir', () => {
  assert.equal(problemsOf({ fps: 0, width: 1279, preset: 'x' }).length, 3);
});

test('gerçek config.json profili geçerli', () => {
  const p = new StreamProfile(loadConfig().profile);
  assert.equal(p.gopSize, 48);
});

test('domain katmanı hiçbir modül import etmez (I/O yok kuralı)', () => {
  const dir = path.join(__dirname, '..', '..', 'src', 'domain');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(src, /\brequire\s*\(|^\s*import\s|\bimport\s*\(/m, `${file} bir modül import ediyor`);
  }
});
