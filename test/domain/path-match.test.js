const test = require('node:test');
const assert = require('node:assert/strict');

const { pathKey, pathKeyLoose, pathIndex } = require('../../src/domain/stream-plan');

// Ters bölüyü kaynak metne gömmeden üret: dosya içi kaçışların kazası olmasın.
const SEP = String.fromCharCode(92);
const winPath = (...parts) => parts.join(SEP);

test('pathKey ters bölüyü ileri bölüye çevirir', () => {
  assert.equal(pathKey(winPath('C:', 'muzik', 'Bir.m4a')), 'C:/muzik/Bir.m4a');
  assert.equal(pathKey('C:/muzik/Bir.m4a'), 'C:/muzik/Bir.m4a');
  assert.equal(pathKey('/home/x/bir.m4a'), '/home/x/bir.m4a');
});

test('pathKeyLoose ayrıca küçük harfe indirir', () => {
  assert.equal(pathKeyLoose(winPath('C:', 'Muzik', 'BIR.m4a')), 'c:/muzik/bir.m4a');
});

// Duman testinde yakalanan hata: plan JSON'da ileri bölü, diskten okunan yol Windows'ta
// ters bölü. Düz metin karşılaştırması tüm seçimi yok sayıyordu.
test('plandaki ileri bölülü yol, diskteki ters bölülü yolla eşleşir', () => {
  const disk = [{ path: winPath('C:', 'ms', 'mimi', 'music', 'After the Rain.m4a') }];
  const find = pathIndex(disk, (t) => t.path);
  assert.equal(find('C:/ms/mimi/music/After the Rain.m4a'), disk[0]);
});

test('büyük/küçük harf farkı da eşleşir (Windows yolları harf duyarsız)', () => {
  const disk = [{ path: 'C:/MS/Mimi/After the Rain.m4a' }];
  const find = pathIndex(disk, (t) => t.path);
  assert.equal(find('c:/ms/mimi/after the rain.m4a'), disk[0]);
});

test('TAM eşleşme harf duyarsız eşleşmeye tercih edilir', () => {
  // Linux'ta yalnızca harfiyle ayrılan iki dosya birbirine karışmamalı.
  const lower = { path: '/muzik/bir.m4a' };
  const upper = { path: '/muzik/Bir.m4a' };
  const find = pathIndex([lower, upper], (t) => t.path);
  assert.equal(find('/muzik/bir.m4a'), lower);
  assert.equal(find('/muzik/Bir.m4a'), upper);
});

test('olmayan yol undefined döner', () => {
  const find = pathIndex([{ path: 'C:/a/bir.m4a' }], (t) => t.path);
  assert.equal(find('C:/a/yok.m4a'), undefined);
});

test('boş kütüphanede arama güvenli', () => {
  assert.equal(pathIndex([], (t) => t.path)('C:/a.m4a'), undefined);
});
