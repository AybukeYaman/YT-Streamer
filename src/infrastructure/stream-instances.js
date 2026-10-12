// Ek yayın örneklerinin (instance) dosya + systemd işlemleri. scripts/deploy/add-stream.sh
// ile AYNI sözleşme: her örnek config.<ad>.json + .env.<ad> + runtime/<ad>/ + yt-streamer@<ad>.
// Kurulumun kendisi (config kopyası, systemd şablonu, enable --now) add-stream.sh'ın işi;
// burada o betik çağrılır, kural ikinci kez yazılmaz.
//
// GÜVENLİK:
//   - Ad kabuğa/yola gitmeden önce validInstanceName ile doğrulanır; komutlar KABUKSUZ
//     (argüman dizisi) çalışır — ad içinde ; & $ boşluk olsa bile komuta dönüşmez.
//   - Stream key yalnızca .env.<ad> dosyasına (izin 600) yazılır; hiçbir yerde loglanmaz,
//     döndürülmez. Betik çıktısında key geçmez (add-stream.sh key'i asla yazdırmaz).
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { validInstanceName, RESERVED } = require('../domain/instance-name');

const defaultRun = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    code: res.error ? -1 : res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || String(res.error || ''),
  };
};

// Bloklamayan çalıştırma: add-stream.sh ~10 sn sürer (içinde sleep 3, iki kez çalışır); spawnSync
// bu sürede go-live sunucusunun TÜM isteklerini (/go-live, /status, /healthz) dondururdu.
const defaultRunAsync = (cmd, args, opts = {}) => new Promise((resolve) => {
  const child = spawn(cmd, args, opts);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});

const tail = (text, n = 6) => String(text).trim().split(/\r?\n/).slice(-n).join(' | ');

class StreamInstances {
  // repoRoot: proje kökü; run: (cmd, args, opts) => { code, stdout, stderr } — testte sahte.
  // runAsync: aynı sözleşme ama Promise döner (yavaş betikler için); verilmezse run sarılır.
  constructor({
    repoRoot, run = defaultRun, runAsync = null, log,
  }) {
    this.repoRoot = repoRoot;
    this.run = run;
    this.runAsync = runAsync ?? ((cmd, args, opts) => Promise.resolve(run(cmd, args, opts)));
    this.log = log;
  }

  configFile(name) { return path.join(this.repoRoot, `config.${name}.json`); }

  envFile(name) { return path.join(this.repoRoot, `.env.${name}`); }

  runtimeDir(name) { return path.join(this.repoRoot, 'runtime', name); }

  // Ad dolu mu? config, env ya da runtime klasörü varsa EVET (yeni örnek hiçbirinin üstüne yazmaz).
  exists(name) {
    return [this.configFile(name), this.envFile(name), this.runtimeDir(name)].some((p) => fs.existsSync(p));
  }

  // Kurulu ek yayınlar: config.<ad>.json VE .env.<ad> ikisi de var olanlar.
  names() {
    let files;
    try {
      files = fs.readdirSync(this.repoRoot);
    } catch {
      return [];
    }
    return files
      .map((f) => /^config\.([a-z0-9][a-z0-9_-]*)\.json$/.exec(f)?.[1])
      .filter((n) => n && validInstanceName(n) && fs.existsSync(this.envFile(n)))
      .sort();
  }

  // Ek yayının görüntü modu: config.<ad>.json'daki video.mode ('copy' = Saf); okunamazsa/yoksa 'encode'.
  videoMode(name) {
    if (!validInstanceName(name)) return 'encode';
    try {
      const config = JSON.parse(fs.readFileSync(this.configFile(name), 'utf8'));
      return config?.video?.mode === 'copy' ? 'copy' : 'encode';
    } catch {
      return 'encode';
    }
  }

  // 'running' | 'stopped' | 'unknown'
  status(name) {
    const res = this.run('systemctl', ['is-active', `yt-streamer@${name}`]);
    if (res.code === -1) return 'unknown';
    const state = res.stdout.trim();
    if (state === 'active' || state === 'activating') return 'running';
    return state === 'inactive' || state === 'failed' ? 'stopped' : 'unknown';
  }

  // Çalışan TÜM yt-streamer servisleri (ana + ek) — kapasite kontrolü için.
  runningCount() {
    const res = this.run('systemctl', ['list-units', '--type=service', '--state=running', '--no-legend', '--plain', 'yt-streamer*']);
    if (res.code === -1) return 0;
    return res.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('yt-streamer')).length;
  }

  // add-stream.sh: yapılandırmayı kurar; key doluysa servisi de başlatır/yeniden başlatır.
  // Key boşken kurulum yapıp başlatmadan çıkar (bilinen davranış, hata değil).
  async provision(name) {
    if (!validInstanceName(name)) throw new Error(`geçersiz yayın adı: ${name}`);
    const script = path.join(this.repoRoot, 'scripts', 'deploy', 'add-stream.sh');
    const res = await this.runAsync('bash', [script, name], { cwd: this.repoRoot });
    if (res.code !== 0) {
      throw new Error(`add-stream.sh başarısız (kod ${res.code}): ${tail(res.stderr || res.stdout)}`);
    }
    return { output: tail(res.stdout, 3) };
  }

  // Ana yayının süre önbelleğini (runtime/durations.json) yeni yayının runtime klasörüne tohumlar.
  // Önbellek anahtarı yol+boyut+mtime olduğundan aynı müzik dosyaları için isabet eder; yoksa
  // yeni yayın ilk açılışta tüm parçaları ffprobe ile baştan ölçer (498 parça ≈ 2 dk). Kopya
  // yalnızca hedefte yoksa yapılır; başarısızlık kurulumu durdurmaz (yalnızca yavaş açılış).
  seedDurations(name) {
    if (!validInstanceName(name)) throw new Error(`geçersiz yayın adı: ${name}`);
    const from = path.join(this.repoRoot, 'runtime', 'durations.json');
    const dir = this.runtimeDir(name);
    const to = path.join(dir, 'durations.json');
    if (!fs.existsSync(from) || fs.existsSync(to)) return false;
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(from, to);
    return true;
  }

  writeKey(name, key) {
    if (!validInstanceName(name)) throw new Error(`geçersiz yayın adı: ${name}`);
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.-]{8,}$/.test(key)) throw new Error('stream key biçimi geçersiz');
    const file = this.envFile(name);
    fs.writeFileSync(file, `YOUTUBE_STREAM_KEY=${key}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  // config.<ad>.json'u fn(config) ile günceller (yerinde). fn config'i değiştirir ya da yeni nesne döner.
  patchConfig(name, fn) {
    const file = this.configFile(name);
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    const next = fn(config) ?? config;
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  }

  stop(name) {
    if (!validInstanceName(name)) throw new Error(`geçersiz yayın adı: ${name}`);
    const res = this.run('systemctl', ['stop', `yt-streamer@${name}`]);
    if (res.code !== 0) throw new Error(`systemctl stop başarısız (kod ${res.code}): ${tail(res.stderr)}`);
  }

  // Zaten kurulu bir örneği başlatır (yeniden kurmadan).
  start(name) {
    if (!validInstanceName(name)) throw new Error(`geçersiz yayın adı: ${name}`);
    const res = this.run('systemctl', ['start', `yt-streamer@${name}`]);
    if (res.code !== 0) throw new Error(`systemctl start başarısız (kod ${res.code}): ${tail(res.stderr)}`);
  }
}

module.exports = {
  StreamInstances, validInstanceName, RESERVED, defaultRunAsync,
};
