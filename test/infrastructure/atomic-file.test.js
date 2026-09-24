const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeFileAtomic } = require('../../src/infrastructure/atomic-file');

test('yazar, .tmp kalıntısı bırakmaz, eksik klasörü oluşturur, üzerine yazar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-atomic-test-'));
  try {
    const file = path.join(dir, 'runtime', 'playlist.txt');
    writeFileAtomic(file, 'bir\n');
    writeFileAtomic(file, 'iki\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'iki\n');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['playlist.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
