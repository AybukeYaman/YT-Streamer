// /config "Sesler" sekmesinden yüklenen ses dosyasını albümün music/ klasörüne .m4a olarak koyar.
//
// Kabul: ses içeren her dosya (mp3, wav, flac, ogg, m4a, mp4/m4v video...). Tür UZANTIDAN değil
// ffprobe'dan anlaşılır: içinde ses akışı yoksa reddedilir. Hepsi AAC m4a'ya çevrilir (48 kHz stereo,
// mevcut parçalarla aynı biçim; AlbumRepository/AlbumCatalog yalnızca .m4a okur).
//
// Yayını YAVAŞLATMASIN: ffmpeg düşük öncelikle (clip-normalizer#run) + tek iş parçacığı, ve bu modül aynı anda TEK dönüştürme
// çalıştırır (kuyruk). Yükleme gövdesi belleğe değil geçici dosyaya akıtılır (mp3/flac onlarca MB olabilir).
//
// Çalan yayını kesmez: yeni parça bir sonraki yayın başlatmada/plan uygulamasında listeye girer.
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { run } = require('./clip-normalizer');

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // ham dosya (flac/video için pay)
const AUDIO_BITRATE = '192k';

class AudioUploadError extends Error {}

// Dosya adından güvenli bir parça adı: uzantı atılır, yol ayracı/kontrol karakteri temizlenir.
function safeTrackName(filename) {
  const base = path.basename(String(filename ?? '').replace(/\\/g, '/'));
  const stem = base.replace(/\.[^.]*$/, '');
  const cleaned = stem
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} ()._&'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return cleaned || 'parca';
}

function uniquePath(dir, name) {
  let candidate = path.join(dir, `${name}.m4a`);
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(dir, `${name} (${n}).m4a`);
  return candidate;
}

// Aynı anda tek ffmpeg: sırayla çalıştırır.
let chain = Promise.resolve();
const enqueue = (task) => {
  const result = chain.then(task, task);
  chain = result.catch(() => {});
  return result;
};

// readable: istek akışı. musicDir: <albüm>/music. Dönüş: { name, path }. Atar: AudioUploadError.
async function saveUploadedAudio({
  readable, musicDir, filename, now = () => Date.now(), runFn = run, log = null,
  maxBytes = MAX_UPLOAD_BYTES,
}) {
  fs.mkdirSync(musicDir, { recursive: true });
  const stamp = now();
  const input = path.join(musicDir, `.yukleme-${stamp}.bin`);
  const tmpOut = path.join(musicDir, `.donusum-${stamp}.part`);
  try {
    let size = 0;
    const limiter = async function* limit(source) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > maxBytes) throw new AudioUploadError(`dosya çok büyük (en fazla ${Math.round(maxBytes / 1048576)} MB)`);
        yield chunk;
      }
    };
    const sink = fs.createWriteStream(input);
    try {
      await pipeline(readable, limiter, sink);
    } catch (err) {
      if (!sink.closed) await new Promise((resolve) => { sink.once('close', resolve); sink.destroy(); });
      throw err;
    }
    if (size === 0) throw new AudioUploadError('dosya boş');

    return await enqueue(async () => {
      const probe = await runFn('ffprobe', [
        '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', input,
      ]);
      if (probe.code !== 0 || !String(probe.stdout || '').includes('audio')) {
        throw new AudioUploadError('bu dosyada ses bulunamadı (bozuk ya da desteklenmeyen dosya)');
      }
      const result = await runFn('ffmpeg', [
        '-hide_banner', '-v', 'error', '-y', '-threads', '1',
        '-i', input, '-vn', '-map', '0:a:0',
        '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ar', '48000', '-ac', '2',
        '-map_metadata', '-1', '-f', 'ipod', tmpOut,
      ]);
      if (result.code !== 0) {
        log?.warn?.(`ses dönüştürülemedi: ${(result.stderr || '').trim().split(/\r?\n/).slice(-1)[0]}`);
        throw new AudioUploadError('ses dönüştürülemedi — dosya bozuk olabilir');
      }
      const out = uniquePath(musicDir, safeTrackName(filename));
      fs.renameSync(tmpOut, out);
      return { name: path.basename(out), path: out };
    });
  } finally {
    fs.rmSync(input, { force: true });
    fs.rmSync(tmpOut, { force: true });
  }
}

// ─── Zip: sunucuda açılır (VPS'te unzip yok, yeni bağımlılık eklenmez: yalnızca Node zlib) ─────────

const MAX_ZIP_BYTES = 1024 * 1024 * 1024; // zip dosyasının kendisi

// Gövdeyi geçici bir .zip dosyasına akıtır; yolu döner.
async function saveZipUpload({ readable, dir = os.tmpdir(), now = () => Date.now(), maxBytes = MAX_ZIP_BYTES }) {
  const file = path.join(dir, `yt-ses-${now()}-${Math.random().toString(36).slice(2, 8)}.zip`);
  let size = 0;
  const limiter = async function* limit(source) {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > maxBytes) throw new AudioUploadError(`zip çok büyük (en fazla ${Math.round(maxBytes / 1048576)} MB)`);
      yield chunk;
    }
  };
  const out = fs.createWriteStream(file);
  try {
    await pipeline(readable, limiter, out);
  } catch (err) {
    // Yazma akışı hata sonrası asenkron kapanır (dosya henüz açılmamış olabilir): kapanmadan silmek iz bırakır.
    if (!out.closed) await new Promise((resolve) => { out.once('close', resolve); out.destroy(); });
    fs.rmSync(file, { force: true });
    throw err;
  }
  if (size === 0) {
    fs.rmSync(file, { force: true });
    throw new AudioUploadError('dosya boş');
  }
  return file;
}

// Merkez dizinden girişleri okur: [{ name, method, compSize, offset }]. Zip64/şifreli desteklenmez.
function readZipEntries(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new AudioUploadError('geçerli bir zip değil');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new AudioUploadError('zip64 (4 GB üstü) desteklenmiyor');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n += 1) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      entries.push({ name, method, compSize, offset, encrypted: (flags & 1) === 1 });
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

// Giriş için okunabilir akış (açılmış içerik).
function openZipEntry(zipPath, entry) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, entry.offset);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new AudioUploadError('zip bozuk');
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const raw = fs.createReadStream(zipPath, { start, end: start + entry.compSize - 1 });
    if (entry.method === 0) return raw;
    if (entry.method === 8) return raw.pipe(zlib.createInflateRaw());
    throw new AudioUploadError('desteklenmeyen zip sıkıştırması');
  } finally {
    fs.closeSync(fd);
  }
}

// Sesli dosya olabilecek girişler: klasör, __MACOSX, nokta ile başlayanlar ve belli görsel/metin uzantıları elenir.
const SKIP_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.txt', '.nfo', '.md', '.pdf', '.json', '.db', '.ini', '.url', '.lnk', '.cue', '.log']);
function candidateEntries(entries) {
  return entries.filter((e) => {
    if (e.name.endsWith('/')) return false;
    const base = path.posix.basename(e.name);
    if (base.startsWith('.') || e.name.includes('__MACOSX/')) return false;
    return !SKIP_EXT.has(path.extname(base).toLowerCase());
  });
}

// Arka plan işleri (bellekte, son 20): zip içindeki dosyalar tek tek dönüştürülür.
// save({ readable, filename }) → { name } (tek dosya kaydedici; hatada atar).
class AudioJobs {
  constructor({ save, log = null, keep = 20 }) {
    this.save = save;
    this.log = log;
    this.keep = keep;
    this.jobs = new Map();
  }

  start({ zipPath }) {
    const id = Math.random().toString(36).slice(2, 10);
    const job = { id, state: 'running', total: 0, done: 0, added: [], failed: [], current: null };
    this.jobs.set(id, job);
    while (this.jobs.size > this.keep) this.jobs.delete(this.jobs.keys().next().value);
    this.#run(job, zipPath).catch((err) => {
      job.state = 'error';
      job.error = err.message;
    }).finally(() => fs.rmSync(zipPath, { force: true }));
    return id;
  }

  hasRunning() {
    return [...this.jobs.values()].some((j) => j.state === 'running');
  }

  status(id) {
    const job = this.jobs.get(id);
    return job ? { ...job, added: [...job.added], failed: [...job.failed] } : null;
  }

  async #run(job, zipPath) {
    const entries = candidateEntries(readZipEntries(zipPath));
    job.total = entries.length;
    if (entries.length === 0) throw new AudioUploadError('zip içinde ses/video dosyası bulunamadı');
    for (const entry of entries) {
      const base = path.posix.basename(entry.name);
      job.current = base;
      try {
        if (entry.encrypted) throw new AudioUploadError('şifreli');
        const saved = await this.save({ readable: openZipEntry(zipPath, entry), filename: base });
        job.added.push(saved.name);
      } catch (err) {
        job.failed.push({ name: base, error: err.message });
        this.log?.warn?.(`zip girişi atlandı (${base}): ${err.message}`);
      }
      job.done += 1;
    }
    job.current = null;
    job.state = 'done';
  }
}

// Tek giriş noktası: .zip → arka plan işi ({ job }), diğer her şey → hemen dönüştürülür ({ name }).
// albumsDir: music-source. Albüm adı çağıranda doğrulanmış olmalı.
function createAudioService({ albumsDir, log = null }) {
  const musicDirOf = (album) => path.join(albumsDir, album, 'music');
  let current = null; // zip işi içindeki dosya kaydı için albüm
  const jobs = new AudioJobs({
    log,
    save: ({ readable, filename }) => saveUploadedAudio({ readable, filename, musicDir: musicDirOf(current), log }),
  });
  return {
    async save({ album, filename, readable }) {
      if (/.zip$/i.test(String(filename ?? ''))) {
        if (jobs.hasRunning()) throw new AudioUploadError('önceki zip hâlâ işleniyor, bitmesini bekle');
        const zipPath = await saveZipUpload({ readable });
        current = album;
        return { job: jobs.start({ zipPath }) };
      }
      return saveUploadedAudio({ readable, filename, musicDir: musicDirOf(album), log });
    },
    status: (id) => jobs.status(id),
  };
}

module.exports = {
  createAudioService, saveUploadedAudio, safeTrackName, AudioUploadError, MAX_UPLOAD_BYTES,
  saveZipUpload, readZipEntries, openZipEntry, candidateEntries, AudioJobs, MAX_ZIP_BYTES,
};
