// TUI'nın listeleyeceği medyayı diskten tarar: kapak görselleri ve arkaplan/mola videoları.
//
// Müzik ve albümler BURADA TARANMAZ — onların tek kaynağı AlbumRepository (ffprobe süre
// önbelleği, "albüm atlandı" kuralları, backgrounds/ önceliği hepsi orada). TUI da aynı
// depoyu kullanır; burada ikinci bir müzik tarayıcısı yok.
//
// Aradığı yerler (hepsi varsa):
//   <albums>/<albüm>/background.mp4, <albüm>/backgrounds/*.mp4, <albüm>/*.mp4   video
//   <albums>/<albüm>/*.jpg|png|jpeg|webp                                        kapak
//   assets/ (ve bir alt seviyesi, ör. assets/covers/)                           ikisi de
//
// Dosya adının yanında hangi klasörden geldiği de döner (TUI'da aynı adlı iki dosya
// ayırt edilebilsin: "mimi/break.mp4" ile "assets/break.mp4" karışmasın).
const fs = require('fs');
const path = require('path');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm']);

function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// Bir klasörün dosyalarını (verilen uzantılarla) listeler. depth>0 ise alt klasörlere de
// o kadar seviye iner. Okunamayan klasör sessizce boş döner: TUI listesi eksik görünür
// ama yapılandırma akışı hata vermez.
//
// Sıra kasıtlı: ÖNCE bu klasörün dosyaları (ada göre), SONRA alt klasörler. Kullanıcı
// assets/ köküne koyduğu kapağı listenin başında görür; assets/covers/ gibi arşiv
// klasörleri aşağıda kalır. Alfabetik tek düze sıralama bunu bozuyordu.
function scanDir(dir, extensions, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  const dirs = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) dirs.push(full);
    else if (extensions.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  files.sort((a, b) => a.localeCompare(b, 'tr'));
  dirs.sort((a, b) => a.localeCompare(b, 'tr'));
  const out = [...files];
  if (depth > 0) for (const sub of dirs) out.push(...scanDir(sub, extensions, depth - 1));
  return out;
}

// Mutlak yolu kullanıcıya gösterilecek kısa etikete çevirir: kök altındaki göreli yol.
function labelFor(file, roots) {
  for (const root of roots) {
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  }
  return file.replace(/\\/g, '/');
}

class MediaLibrary {
  // albumsDir: config.paths.albums (null olabilir — eski tek-music düzeni)
  // assetsDir: proje kökündeki assets/ (kapaklar burada durur, bkz. config.example.json)
  // rootDir: etiketleri kısaltmak için proje kökü
  constructor({ albumsDir = null, assetsDir, rootDir }) {
    this.albumsDir = albumsDir;
    this.assetsDir = assetsDir;
    this.rootDir = rootDir;
  }

  // [{ path, label, sizeBytes }] — tarama sırasında (klasör kökü önce), tekrarsız.
  covers() {
    return this.#collect(IMAGE_EXT);
  }

  videos() {
    return this.#collect(VIDEO_EXT);
  }

  // Kullanıcının elle girdiği yol: mutlaklaştırır ve var mı/tür uygun mu söyler.
  // TUI "custom file..." seçeneğinde kullanılır — hatalı yol özet ekranına kadar
  // taşınıp yayın başlarken ortaya çıkmasın.
  inspect(input, kind = 'any') {
    const raw = String(input || '').trim().replace(/^["']|["']$/g, '');
    if (!raw) return { ok: false, reason: 'yol boş' };
    const full = path.isAbsolute(raw) ? raw : path.resolve(this.rootDir, raw);
    const stat = statSafe(full);
    if (!stat || !stat.isFile()) return { ok: false, reason: `dosya yok: ${full}` };
    const ext = path.extname(full).toLowerCase();
    const allowed = kind === 'cover' ? IMAGE_EXT : kind === 'video' ? new Set([...VIDEO_EXT, ...IMAGE_EXT]) : null;
    if (allowed && !allowed.has(ext)) {
      return { ok: false, reason: `desteklenmeyen tür: ${ext || '(uzantısız)'}` };
    }
    return {
      ok: true,
      file: { path: full, label: labelFor(full, this.#roots()), sizeBytes: stat.size },
    };
  }

  #roots() {
    return [this.albumsDir, this.assetsDir, this.rootDir].filter(Boolean);
  }

  #collect(extensions) {
    const files = new Set();
    if (this.albumsDir) {
      // Albüm klasörleri: kökteki dosyalar + backgrounds/ gibi bir alt seviye.
      for (const file of scanDir(this.albumsDir, extensions, 2)) files.add(file);
    }
    // assets/ ve bir alt seviyesi (assets/covers/ alışkanlığı için).
    for (const file of scanDir(this.assetsDir, extensions, 1)) files.add(file);

    const roots = this.#roots();
    // Sıralama scanDir'de yapıldı (klasör kökü önce); burada yeniden sıralanmaz.
    return [...files].map((file) => {
      const stat = statSafe(file);
      return { path: file, label: labelFor(file, roots), sizeBytes: stat ? stat.size : 0 };
    });
  }
}

module.exports = { MediaLibrary, IMAGE_EXT, VIDEO_EXT };
