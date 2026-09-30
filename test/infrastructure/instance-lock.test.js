const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { acquireLock, InstanceLockError, LOCK_FILE } = require('../../src/infrastructure/instance-lock');

function tmpRuntime() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ytlock-'));
}

test('kilit alınır: runtime klasörü ve lock dosyası PID ile oluşur', () => {
  const dir = path.join(tmpRuntime(), 'alt'); // henüz var olmayan alt klasör
  try {
    const lock = acquireLock({ runtimeDir: dir, pid: 4242 });
    assert.equal(lock.file, path.join(dir, LOCK_FILE));
    assert.equal(fs.readFileSync(lock.file, 'utf8').trim(), '4242');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('aynı runtime\'ı kullanan CANLI başka instance varsa reddedilir', () => {
  const dir = tmpRuntime();
  try {
    acquireLock({ runtimeDir: dir, pid: 1001, isAlive: () => true });
    assert.throws(
      () => acquireLock({ runtimeDir: dir, pid: 2002, isAlive: () => true }),
      (err) => {
        assert.ok(err instanceof InstanceLockError);
        assert.equal(err.pid, 1001);
        assert.match(err.message, /paths\.runtime/); // çözüm yolunu söylüyor
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bayat kilit (PID ölmüş) devralınır — elle temizlik gerekmez', () => {
  const dir = tmpRuntime();
  try {
    acquireLock({ runtimeDir: dir, pid: 1001, isAlive: () => true });
    const lock = acquireLock({ runtimeDir: dir, pid: 2002, isAlive: () => false }); // eski süreç ölü
    assert.equal(fs.readFileSync(lock.file, 'utf8').trim(), '2002');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bozuk lock içeriği devralınır (çökmez)', () => {
  const dir = tmpRuntime();
  try {
    fs.writeFileSync(path.join(dir, LOCK_FILE), 'çöp veri');
    const lock = acquireLock({ runtimeDir: dir, pid: 3003, isAlive: () => true });
    assert.equal(fs.readFileSync(lock.file, 'utf8').trim(), '3003');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('aynı PID tekrar alırsa sorun yok (restart/idempotent)', () => {
  const dir = tmpRuntime();
  try {
    acquireLock({ runtimeDir: dir, pid: 5005, isAlive: () => true });
    assert.doesNotThrow(() => acquireLock({ runtimeDir: dir, pid: 5005, isAlive: () => true }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release: kilidi siler ve idempotenttir', () => {
  const dir = tmpRuntime();
  try {
    const lock = acquireLock({ runtimeDir: dir, pid: 6006 });
    lock.release();
    assert.equal(fs.existsSync(lock.file), false);
    assert.doesNotThrow(() => lock.release()); // ikinci çağrı
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release: başka bir instance devraldıysa onun kilidini silmez', () => {
  const dir = tmpRuntime();
  try {
    const first = acquireLock({ runtimeDir: dir, pid: 7007, isAlive: () => false });
    acquireLock({ runtimeDir: dir, pid: 8008, isAlive: () => false }); // devraldı
    first.release(); // eski sahip kapanıyor
    assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), true, 'yeni sahibin kilidi durmalı');
    assert.equal(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8').trim(), '8008');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release sonrası kilit yeniden alınabilir', () => {
  const dir = tmpRuntime();
  try {
    acquireLock({ runtimeDir: dir, pid: 9009 }).release();
    assert.doesNotThrow(() => acquireLock({ runtimeDir: dir, pid: 9010, isAlive: () => true }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
