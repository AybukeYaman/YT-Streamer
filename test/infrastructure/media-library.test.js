const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MediaLibrary } = require('../../src/infrastructure/media-library');

// Gerçek bir albüm/assets düzeni kurar: tarama kuralları dosya sisteminde sınanıyor.
function withTree(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-media-'));
  const touch = (...parts) => {
    const file = path.join(root, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    return file;
  };
  try {
    return fn({
      root,
      touch,
      library: () => new MediaLibrary({
        albumsDir: path.join(root, 'music-source'),
        assetsDir: path.join(root, 'assets'),
        rootDir: root,
      }),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('kapaklar: assets kökü önce, alt klasör sonra; görsel olmayan listede yok', () => {
  withTree(({ touch, library }) => {
    touch('assets', 'kapak.jpg');
    touch('assets', 'notlar.txt');
    touch('assets', 'covers', 'gece.png');
    assert.deepEqual(
      library().covers().map((c) => path.basename(c.path)),
      ['kapak.jpg', 'gece.png'],
    );
  });
});

test('kapaklar: albüm klasörlerindeki görseller de bulunur', () => {
  withTree(({ touch, library }) => {
    touch('music-source', 'mimi', 'thumb.jpg');
    const found = library().covers();
    assert.deepEqual(found.map((c) => c.label), ['mimi/thumb.jpg']);
  });
});

test('videolar: background.mp4, backgrounds/ havuzu ve break.mp4 birlikte listelenir', () => {
  withTree(({ touch, library }) => {
    touch('music-source', 'mimi', 'break.mp4');
    touch('music-source', 'mimi', 'backgrounds', '01.mp4');
    touch('music-source', 'gece', 'background.mp4');
    const labels = library().videos().map((v) => v.label).sort();
    assert.deepEqual(labels, ['gece/background.mp4', 'mimi/backgrounds/01.mp4', 'mimi/break.mp4']);
  });
});

test('etiket kök dizine göre göreli ve düz bölü kullanır (platformdan bağımsız)', () => {
  withTree(({ touch, library }) => {
    touch('assets', 'covers', 'gece.png');
    assert.equal(library().covers()[0].label, 'covers/gece.png');
  });
});

test('nokta ile başlayan klasörler atlanır (yarım yazım alanı)', () => {
  withTree(({ touch, library }) => {
    touch('music-source', '.staging', 'yarim.mp4');
    touch('music-source', 'mimi', 'background.mp4');
    assert.deepEqual(library().videos().map((v) => v.label), ['mimi/background.mp4']);
  });
});

test('olmayan klasör hata vermez, boş liste döner', () => {
  const library = new MediaLibrary({ albumsDir: 'X:/yok', assetsDir: 'X:/yok2', rootDir: 'X:/' });
  assert.deepEqual(library.covers(), []);
  assert.deepEqual(library.videos(), []);
});

test('aynı dosya iki yoldan görünse bir kez listelenir', () => {
  withTree(({ root, touch }) => {
    touch('assets', 'kapak.jpg');
    // albumsDir ile assetsDir aynı klasörü gösterse de tekrar olmamalı.
    const library = new MediaLibrary({
      albumsDir: path.join(root, 'assets'), assetsDir: path.join(root, 'assets'), rootDir: root,
    });
    assert.equal(library.covers().length, 1);
  });
});

test('inspect: var olan dosyayı mutlaklaştırır (göreli yol kök dizine göre)', () => {
  withTree(({ root, touch, library }) => {
    const file = touch('assets', 'kapak.jpg');
    const result = library().inspect('assets/kapak.jpg', 'cover');
    assert.equal(result.ok, true);
    assert.equal(result.file.path, file);
    assert.equal(path.isAbsolute(result.file.path), true);
    assert.ok(root);
  });
});

test('inspect: tırnaklı yapıştırma ve mutlak yol kabul edilir', () => {
  withTree(({ touch, library }) => {
    const file = touch('assets', 'kapak.jpg');
    assert.equal(library().inspect(`"${file}"`, 'cover').ok, true);
  });
});

test('inspect: olmayan dosya, boş giriş ve yanlış tür reddedilir', () => {
  withTree(({ touch, library }) => {
    touch('assets', 'notlar.txt');
    assert.match(library().inspect('', 'cover').reason, /boş/);
    assert.match(library().inspect('assets/yok.jpg', 'cover').reason, /dosya yok/);
    assert.match(library().inspect('assets/notlar.txt', 'cover').reason, /desteklenmeyen tür/);
  });
});

test('inspect: video alanı görseli de kabul eder (açılışta klibe çevrilir)', () => {
  withTree(({ touch, library }) => {
    touch('assets', 'kapak.jpg');
    assert.equal(library().inspect('assets/kapak.jpg', 'video').ok, true);
  });
});

test('albumsDir yoksa (eski tek-music düzeni) yalnızca assets taranır', () => {
  withTree(({ root, touch }) => {
    touch('assets', 'kapak.jpg');
    const library = new MediaLibrary({ assetsDir: path.join(root, 'assets'), rootDir: root });
    assert.deepEqual(library.covers().map((c) => c.label), ['kapak.jpg']);
  });
});
