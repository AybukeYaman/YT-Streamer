const test = require('node:test');
const assert = require('node:assert/strict');

const { mapKey } = require('../../src/ui/keymap');

test('stream komutları: s/r/q (büyük harf dahil)', () => {
  assert.equal(mapKey('s'), 'start');
  assert.equal(mapKey('S'), 'start');
  assert.equal(mapKey('r'), 'restart');
  assert.equal(mapKey('R'), 'restart');
  assert.equal(mapKey('q'), 'quit');
  assert.equal(mapKey('Q'), 'quit');
});

test('Ctrl+C → quit', () => {
  assert.equal(mapKey('c', { ctrl: true, name: 'c' }), 'quit');
  assert.equal(mapKey('', { ctrl: true, name: 'c' }), 'quit');
});

test('scroll tuşları', () => {
  assert.equal(mapKey('', { upArrow: true }), 'log-up');
  assert.equal(mapKey('', { downArrow: true }), 'log-down');
  assert.equal(mapKey('', { pageUp: true }), 'page-up');
  assert.equal(mapKey('', { pageDown: true }), 'page-down');
  assert.equal(mapKey('', { end: true }), 'live');
});

test('bilinmeyen tuş → null', () => {
  assert.equal(mapKey('x'), null);
  assert.equal(mapKey('', {}), null);
  assert.equal(mapKey(undefined, undefined), null);
});
