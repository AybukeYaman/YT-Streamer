// Faz 3.1 / Yaklaşım B — uzun playlist + planlı restart (atılabilir deney script'i)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const assets = path.join(dir, 'assets').replace(/\\/g, '/');
const logFile = fs.createWriteStream(path.join(dir, 'test-b.log'));
const ROUNDS = 3;

const t0 = Date.now();
const now = () => Date.now() - t0;
const log = (msg) => {
  const s = `[${(now() / 1000).toFixed(3)}s] ${msg}`;
  console.log(s);
  logFile.write(s + '\n');
};

let prevExitAt = null;
const results = [];

function runRound(round) {
  const playlist = path.join(dir, `playlist-b${round}.txt`);
  const out = path.join(dir, `out-b${round}.flv`);
  let body = '';
  for (let n = 1; n <= 5; n++) body += `file '${assets}/${String(n).padStart(2, '0')}.m4a'\n`;
  fs.writeFileSync(playlist, body);

  const spawnAt = now();
  log(`>>> tur ${round}: ffmpeg başlatılıyor -> ${path.basename(out)}`);
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-y', '-stats_period', '0.05',
    '-stream_loop', '-1', '-i', path.join(dir, 'assets', 'background.mp4'),
    '-re', '-f', 'concat', '-safe', '0', '-i', playlist,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-r', '24', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-shortest', '-f', 'flv', out,
  ]);

  let firstFrameAt = null;
  let buf = '';
  ff.stderr.on('data', (d) => {
    buf += d.toString();
    const parts = buf.split(/\r|\n/);
    buf = parts.pop();
    for (const p of parts) {
      if (!p.trim()) continue;
      logFile.write(`[${(now() / 1000).toFixed(3)}s] ffmpeg: ${p}\n`);
      if (firstFrameAt === null && /frame=\s*[1-9]/.test(p)) {
        firstFrameAt = now();
        const gap = prevExitAt === null ? null : firstFrameAt - prevExitAt;
        log(`>>> tur ${round}: ilk frame — spawn'dan ${firstFrameAt - spawnAt} ms` +
          (gap === null ? '' : `, önceki exit'ten ${gap} ms`));
        results.push({ round, spawnToFrame: firstFrameAt - spawnAt, gap });
      }
    }
  });

  // Emniyet: 5 parça = 100 sn; 150 sn'de bitmediyse q gönder
  const guard = setTimeout(() => { log(`>>> tur ${round}: 150 sn doldu, q gönderiliyor`); ff.stdin.write('q'); }, 150000);

  ff.on('exit', (code, signal) => {
    clearTimeout(guard);
    prevExitAt = now();
    log(`>>> tur ${round}: ffmpeg çıktı code=${code} signal=${signal}, tur süresi ${((prevExitAt - spawnAt) / 1000).toFixed(2)} sn`);
    if (round < ROUNDS) return runRound(round + 1);
    log('>>> ÖZET: ' + JSON.stringify(results));
    logFile.end();
  });
}

runRound(1);
