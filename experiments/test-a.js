// Faz 3.1 / Yaklaşım A — canlı concat beslemesi (atılabilir deney script'i)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const assets = path.join(dir, 'assets').replace(/\\/g, '/');
const playlist = path.join(dir, 'playlist.txt');
const logFile = fs.createWriteStream(path.join(dir, 'test-a.log'));
const line = (n) => `file '${assets}/${String(n).padStart(2, '0')}.m4a'\n`;

const t0 = Date.now();
const log = (msg) => {
  const s = `[${((Date.now() - t0) / 1000).toFixed(2)}s] ${msg}`;
  console.log(s);
  logFile.write(s + '\n');
};

fs.writeFileSync(playlist, line(1) + line(2));

const ff = spawn('ffmpeg', [
  '-hide_banner', '-y',
  '-stream_loop', '-1', '-i', path.join(dir, 'assets', 'background.mp4'),
  '-re', '-f', 'concat', '-safe', '0', '-i', playlist,
  '-map', '0:v', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
  '-r', '24', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
  '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
  '-f', 'flv', path.join(dir, 'out-a.flv'),
]);

let buf = '';
ff.stderr.on('data', (d) => {
  buf += d.toString();
  const parts = buf.split(/\r|\n/);
  buf = parts.pop();
  for (const p of parts) if (p.trim()) log('ffmpeg: ' + p);
});

const append = (n, at) => setTimeout(() => {
  fs.appendFileSync(playlist, line(n));
  log(`>>> playlist'e ${n}. parça eklendi`);
}, at);
append(3, 25000);
append(4, 45000);

// Emniyet: 120 sn'de hâlâ çalışıyorsa temiz kapat
const guard = setTimeout(() => { log('>>> 120 sn doldu, q gönderiliyor'); ff.stdin.write('q'); }, 120000);

ff.on('exit', (code, signal) => {
  clearTimeout(guard);
  log(`>>> ffmpeg çıktı: code=${code} signal=${signal}, toplam ${((Date.now() - t0) / 1000).toFixed(2)} sn`);
  logFile.end();
  process.exit(0);
});
