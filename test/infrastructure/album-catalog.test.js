const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AlbumCatalog } = require('../../src/infrastructure/album-catalog');

function build(tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-cat-'));
  for (const rel of tree) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
  }
  return root;
}

test('albümleri ada göre listeler: parça yolları ve arkaplanlar, ffprobe yok', () => {
  const root = build([
    'zeta/music/b.m4a', 'zeta/music/a.m4a', 'zeta/backgrounds/2.mp4', 'zeta/backgrounds/1.mp4',
    'alfa/music/x.m4a', 'alfa/background.mp4',
  ]);
  const list = new AlbumCatalog({ dir: root }).list();
  assert.deepEqual(list.map((a) => a.name), ['alfa', 'zeta']);
  assert.equal(list[1].trackCount, 2);
  assert.deepEqual(list[1].trackPaths.map((p) => path.basename(p)), ['a.m4a', 'b.m4a']);
  assert.deepEqual(list[1].backgrounds.map((p) => path.basename(p)), ['1.mp4', '2.mp4']);
  assert.deepEqual(list[0].backgrounds.map((p) => path.basename(p)), ['background.mp4']);
});

test('backgrounds/ varsa tek background.mp4\'ün önüne geçer (AlbumRepository ile aynı kural)', () => {
  const root = build(['a/music/x.m4a', 'a/background.mp4', 'a/backgrounds/yeni.mp4']);
  assert.deepEqual(new AlbumCatalog({ dir: root }).list()[0].backgrounds.map((p) => path.basename(p)), ['yeni.mp4']);
});

test('parçası ya da arkaplanı olmayan klasör, nokta ile başlayanlar ve dosyalar atlanır', () => {
  const root = build([
    'parcasiz/background.mp4', 'arkaplansiz/music/x.m4a', '.staging/music/x.m4a', '.staging/background.mp4',
    'bos/readme.txt', 'iyi/music/x.m4a', 'iyi/background.mp4', 'duz-dosya.mp4',
  ]);
  assert.deepEqual(new AlbumCatalog({ dir: root }).list().map((a) => a.name), ['iyi']);
});

test('dizin yok ya da null ise boş katalog, hata atmaz', () => {
  assert.deepEqual(new AlbumCatalog({ dir: null }).list(), []);
  assert.deepEqual(new AlbumCatalog({ dir: path.join(os.tmpdir(), 'yt-yok-klasor-xyz') }).list(), []);
});

test('loop.mp4 varsa loopPath dolar, yoksa null', () => {
  const root = build(['a/music/x.m4a', 'a/background.mp4', 'a/loop.mp4', 'b/music/y.m4a', 'b/background.mp4']);
  const list = new AlbumCatalog({ dir: root }).list();
  assert.equal(list[0].loopPath, path.join(root, 'a', 'loop.mp4'));
  assert.equal(list[1].loopPath, null);
});
