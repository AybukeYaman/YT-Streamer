// Atomik dosya yazma: önce <dosya>.tmp, sonra rename. Okuyan taraf (ffmpeg) hiçbir zaman
// yarım yazılmış bir dosya görmez; yazma ortada kesilirse eski dosya bozulmadan kalır.
const fs = require('fs');
const path = require('path');

function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { writeFileAtomic };
