// Tek komutla yayınlama: ham dosyaları arkaplan klibine çevirir ve albümleri VPS'e taşır.
//   npm run albums:publish            hepsini yap
//   npm run albums:publish -- --dry-run   hiçbir şey değiştirme, ne olacağını yaz
//   npm run albums:publish -- --no-sync   sadece dönüştür (VPS'e dokunma)
//
// İki adımı birleştirir:
//   node scripts/add-backgrounds.js <kaynak> <albüm>     (her eşleme için)
//   bash scripts/deploy/sync-albums.sh <host> <yol>
//
// Hedef ve eşlemeler publish.json'dan okunur. Dosya MAKİNEYE ÖZELDİR ve git'e girmez
// (.gitignore) — VPS adresi ve yerel klasör yolları her makinede farklı.
// publish.example.json şablondur.
//
// Neden .env değil: check-env.sh, .env.example'daki her anahtarı zorunlu sayıyor ve
// eksikse deploy'u durduruyor. VPS'in .env'inde bu anahtarlar olmayacağı için oraya
// koymak deploy'u kırardı. Ayrı dosya, ayrı sözleşme.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(__dirname, 'publish.json');
const EXAMPLE_FILE = path.join(__dirname, 'publish.example.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noSync = args.includes('--no-sync');

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(CONFIG_FILE)) {
  fail(
    `${CONFIG_FILE} yok.\n\n`
    + `Şablonu kopyalayıp doldur:\n  cp "${EXAMPLE_FILE}" "${CONFIG_FILE}"\n\n`
    + 'Bu dosya makineye özeldir ve git\'e girmez.',
  );
}

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch (err) {
  fail(`${CONFIG_FILE} okunamadı: ${err.message}`);
}

const albums = config.albums && typeof config.albums === 'object' ? config.albums : {};
const entries = Object.entries(albums);

// Windows'ta npm script'i PowerShell'den çalışabiliyor; bash PATH'te olmayabilir.
function findBash() {
  const candidates = ['bash', 'C:/Program Files/Git/bin/bash.exe', '/bin/bash'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function run(cmd, cmdArgs, label) {
  console.log(`\n== ${label} ==`);
  if (dryRun) {
    console.log(`DRY RUN — çalıştırılmayacak: ${cmd} ${cmdArgs.join(' ')}`);
    return true;
  }
  const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT });
  if (result.error) {
    console.error(`çalıştırılamadı: ${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

// ── 1. Arkaplanları dönüştür ────────────────────────────────────────────────
if (entries.length === 0) {
  console.log('publish.json içinde "albums" eşlemesi yok — dönüştürme adımı atlanıyor.');
}
for (const [album, source] of entries) {
  const sourceDir = path.resolve(ROOT, source);
  if (!fs.existsSync(sourceDir)) {
    fail(`kaynak klasör yok: ${sourceDir} (albüm "${album}")`);
  }
  const ok = run(
    process.execPath,
    [path.join(__dirname, 'add-backgrounds.js'), sourceDir, album, ...(dryRun ? ['--analyze'] : [])],
    `arkaplanlar: ${source} → ${album}`,
  );
  if (!ok) fail(`arkaplan dönüştürme başarısız: ${album} — VPS'e hiçbir şey gönderilmedi.`);
}

// ── 2. VPS'e taşı ───────────────────────────────────────────────────────────
if (noSync) {
  console.log('\n--no-sync: VPS\'e taşıma atlandı.');
  process.exit(0);
}
if (!config.host || !config.path) {
  fail('\npublish.json içinde "host" ve "path" gerekli (ör. "root@1.2.3.4" ve "/root/YT-Streamer").');
}
const bash = findBash();
if (!bash) {
  fail('\nbash bulunamadı — sync-albums.sh çalıştırılamıyor. Git Bash kurulu mu?');
}
const syncArgs = [
  path.join(__dirname, 'deploy', 'sync-albums.sh'),
  config.host, config.path,
  ...(dryRun ? ['--dry-run'] : []),
];
if (!run(bash, syncArgs, `VPS'e taşıma: ${config.host}:${config.path}`)) {
  fail('taşıma başarısız.');
}

console.log('\n== yayınlama tamam ==');
console.log('Albümler yayın sürecine ALBÜM GEÇİŞİNDE girer; hemen görmek için VPS\'te:');
console.log('  sudo systemctl restart yt-streamer');
