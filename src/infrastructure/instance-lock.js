// Aynı runtime klasörünü iki instance'ın birlikte kullanmasını engelleyen kilit.
//
// Neden: çoklu yayında her instance kendi runtime'ına yazmalı (playlist.txt, state.json,
// overlay/). İki süreç aynı klasörü paylaşırsa playlist ve durum dosyaları birbirini ezer,
// üstüne ikisi de aynı YouTube key'ine bağlanmaya çalışır (YouTube ikinciyi reddeder).
// Sessiz bozulma yerine açık bir hatayla başlatmayı reddediyoruz.
//
// Kilit dosyası sahibinin PID'sini tutar. Süreç temiz kapanmadan ölmüşse (kill -9, elektrik)
// kalan kilit "bayat"tır: PID artık yaşamıyorsa devralınır — elle temizlik gerekmez.
const fs = require('fs');
const path = require('path');

const LOCK_FILE = 'instance.lock';

class InstanceLockError extends Error {
  constructor(runtimeDir, pid) {
    super(
      `runtime klasörü başka bir instance tarafından kullanılıyor: ${runtimeDir} (PID ${pid}).\n` +
      '  Çoklu yayında her instance kendi runtime klasörünü kullanmalı — ' +
      'config dosyasındaki "paths.runtime" değerini değiştir (ör. ./runtime/stream2).',
    );
    this.name = 'InstanceLockError';
    this.runtimeDir = runtimeDir;
    this.pid = pid;
  }
}

// PID yaşıyor mu? Sinyal 0 süreci etkilemez, yalnızca varlığını sınar.
// EPERM = süreç var ama bize ait değil (yine de yaşıyor).
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Kilidi alır. Başka canlı bir instance aynı runtime'ı kullanıyorsa InstanceLockError atar.
 * @returns {{ file: string, release: () => void }}
 */
function acquireLock({ runtimeDir, pid = process.pid, isAlive = processAlive }) {
  const file = path.join(runtimeDir, LOCK_FILE);
  fs.mkdirSync(runtimeDir, { recursive: true });

  // Oluşturma ATOMİK ('wx' = yoksa oluştur, varsa EEXIST). Eskiden "oku → yaz" iki ayrı
  // adımdı: milisaniye arayla başlayan iki instance ikisi de "kilit yok" görüp ikisi de
  // yazabiliyordu — kilidin engellemesi gereken durumun ta kendisi (10 Ekim 2026).
  // Bayat kilidi devralma davranışı korunuyor: EEXIST'te sahip PID'ye bakılır.
  const claim = () => fs.writeFileSync(file, `${pid}\n`, { flag: 'wx' });
  try {
    claim();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let existing = '';
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch (readErr) {
      if (readErr.code !== 'ENOENT') throw readErr; // ENOENT: araya silen biri girmiş
    }
    const owner = Number(existing.trim());
    // Geçersiz/bozuk içerik ya da ölü PID → bayat kilit, devralınır.
    if (Number.isInteger(owner) && owner > 0 && owner !== pid && isAlive(owner)) {
      throw new InstanceLockError(runtimeDir, owner);
    }
    // Bayat kilidi devral: dosya zaten var, üzerine yazmak güvenli (sahibi yaşamıyor).
    fs.writeFileSync(file, `${pid}\n`);
  }

  let released = false;
  return {
    file,
    // Idempotent: shutdown ve hata yolundan birden çok kez çağrılabilir.
    release() {
      if (released) return;
      released = true;
      try {
        // Sadece bizim kilidimizi sil — bayat kilidi devraldıysak da PID artık bizim.
        const current = fs.readFileSync(file, 'utf8').trim();
        if (current === String(pid)) fs.rmSync(file, { force: true });
      } catch {
        // Kilit dosyası yoksa ya da okunamıyorsa: kapanışı engellemeye değmez.
      }
    },
  };
}

module.exports = { acquireLock, InstanceLockError, LOCK_FILE };
