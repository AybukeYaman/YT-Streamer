const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, DEFAULTS } = require('../../src/config/parse-args');

test('argümansız: varsayılanlar (mevcut tek-yayın davranışı korunur)', () => {
  assert.deepEqual(parseArgs([]), { tui: false, configFile: 'config.json', envFile: '.env' });
  assert.deepEqual(parseArgs(), DEFAULTS);
});

test('--tui bayrağı', () => {
  assert.equal(parseArgs(['--tui']).tui, true);
});

test('--config / --env ayrı argümanla', () => {
  const a = parseArgs(['--config', 'config.stream1.json', '--env', '.env.stream1']);
  assert.equal(a.configFile, 'config.stream1.json');
  assert.equal(a.envFile, '.env.stream1');
  assert.equal(a.tui, false);
});

test('--config= / --env= eşittirli biçim', () => {
  const a = parseArgs(['--config=config.s2.json', '--env=.env.s2']);
  assert.equal(a.configFile, 'config.s2.json');
  assert.equal(a.envFile, '.env.s2');
});

test('kısa biçim -c / -e', () => {
  const a = parseArgs(['-c', 'c.json', '-e', 'e.env']);
  assert.equal(a.configFile, 'c.json');
  assert.equal(a.envFile, 'e.env');
});

test('bayraklar birlikte kullanılabilir (--tui + çoklu yayın)', () => {
  const a = parseArgs(['--tui', '--config', 'config.stream2.json', '--env', '.env.stream2']);
  assert.deepEqual(a, { tui: true, configFile: 'config.stream2.json', envFile: '.env.stream2' });
});

test('değer eksikse hata (sessizce yanlış config ile başlamasın)', () => {
  assert.throws(() => parseArgs(['--config']), /dosya yolu bekliyor/);
  assert.throws(() => parseArgs(['--env']), /dosya yolu bekliyor/);
  assert.throws(() => parseArgs(['--config', '--tui']), /dosya yolu bekliyor/);
});

test('bilinmeyen argüman hata verir (yazım hatası fark edilsin)', () => {
  assert.throws(() => parseArgs(['--confg', 'x.json']), /bilinmeyen argüman: --confg/);
  assert.throws(() => parseArgs(['fazladan']), /bilinmeyen argüman: fazladan/);
});
