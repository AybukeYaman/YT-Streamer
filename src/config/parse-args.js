// CLI argümanlarını çözer (saf, I/O'suz). Çoklu yayın için her instance kendi config ve
// env dosyasını kullanır — böylece aynı kod tabanından N bağımsız yayın çalışabilir:
//
//   node index.js                                        (tek yayın, varsayılan)
//   node index.js --tui                                  (panel)
//   node index.js --config config.stream1.json --env .env.stream1
//
// Yollar proje köküne göre çözülür (bkz. loadConfig).
const DEFAULTS = { tui: false, configFile: 'config.json', envFile: '.env' };

function value(raw, flag) {
  if (raw === undefined || raw === '' || raw.startsWith('-')) {
    throw new Error(`${flag} bir dosya yolu bekliyor (örn. ${flag} config.stream1.json)`);
  }
  return raw;
}

// args: process.argv.slice(2)
function parseArgs(args = []) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--tui') { out.tui = true; continue; }
    if (a === '--config' || a === '-c') { out.configFile = value(args[++i], a); continue; }
    if (a === '--env' || a === '-e') { out.envFile = value(args[++i], a); continue; }
    if (a.startsWith('--config=')) { out.configFile = value(a.slice('--config='.length), '--config'); continue; }
    if (a.startsWith('--env=')) { out.envFile = value(a.slice('--env='.length), '--env'); continue; }
    // Sessizce yoksaymak yerine hata: yazım hatası (--confg) fark edilmeden yanlış
    // config'le yayına çıkmaktan iyidir.
    throw new Error(`bilinmeyen argüman: ${a}`);
  }
  return out;
}

module.exports = { parseArgs, DEFAULTS };
