// scripts/lib/loop-spec.js testleri: gerçek ffmpeg/ffprobe gerekmez, sahte ffprobe çıktısı kullanılır.
const test = require('node:test');
const assert = require('node:assert/strict');
const spec = require('../../scripts/lib/loop-spec');

// Şartnameye uyan 8 sn'lik döngünün ffprobe JSON'u (anahtar kareler 0,2,4,6 sn).
function goodJson(over = {}) {
  return {
    streams: [{
      codec_type: 'video', codec_name: 'h264', profile: 'Main', width: 1280, height: 720,
      r_frame_rate: '24/1', pix_fmt: 'yuv420p', has_b_frames: 0,
    }],
    format: { duration: '8.000000' },
    packets: [0, 0.5, 2, 2.5, 4, 6].map((t) => ({ pts_time: String(t), flags: [0, 2, 4, 6].includes(t) ? 'K_' : '__' })),
    ...over,
  };
}
const verdict = (json) => spec.validateLoop(spec.summarizeProbe(json));

test('şartnameye uyan döngü kabul edilir', () => {
  assert.deepEqual(verdict(goodJson()), []);
});

test('okunamayan video reddedilir', () => {
  assert.deepEqual(spec.validateLoop(spec.summarizeProbe({ streams: [], format: {} })), ['video akışı okunamadı']);
});

test('yanlış codec, profil, çözünürlük, fps, piksel biçimi gerekçeyle reddedilir', () => {
  const j = goodJson();
  Object.assign(j.streams[0], { codec_name: 'hevc', profile: 'High', width: 1920, height: 1080, r_frame_rate: '30/1', pix_fmt: 'yuv444p' });
  const out = verdict(j).join(' | ');
  for (const w of ['codec hevc', 'profil High', '1920x1080', 'fps 30', 'yuv444p']) assert.match(out, new RegExp(w));
});

test('ses akışı ve B-kare reddedilir', () => {
  const j = goodJson();
  j.streams.push({ codec_type: 'audio' });
  j.streams[0].has_b_frames = 2;
  const out = verdict(j).join(' | ');
  assert.match(out, /ses akışı/);
  assert.match(out, /B-kare/);
});

test('süre 2 sn katı değilse reddedilir', () => {
  assert.match(verdict(goodJson({ format: { duration: '9.000000' } })).join(), /katı değil/);
  assert.deepEqual(verdict(goodJson({ format: { duration: '8.020000' } })), []);
});

test('anahtar kare aralığı bozuksa ya da ilk kare anahtar değilse reddedilir', () => {
  const j = goodJson();
  j.packets = [0, 3, 6].map((t) => ({ pts_time: String(t), flags: 'K_' }));
  assert.match(verdict(j).join(), /anahtar kare aralığı 3\.000/);
  j.packets = [{ pts_time: '0', flags: '__' }, { pts_time: '2', flags: 'K_' }];
  assert.match(verdict(j).join(), /ilk kare anahtar/);
});

test('son anahtar kare ile süre sonu arası da 2 sn olmalı (dikiş)', () => {
  const j = goodJson();
  j.packets = [0, 2, 4].map((t) => ({ pts_time: String(t), flags: 'K_' })); // 8 sn süre, son anahtar 4 → 4 sn boşluk
  assert.match(verdict(j).join(), /anahtar kare aralığı 4\.000/);
});

test('loopSeconds: video 2 sn katına aşağı yuvarlanır, görsel 10 sn', () => {
  assert.equal(spec.loopSeconds({ kind: 'video', duration: 9.5 }), 8);
  assert.equal(spec.loopSeconds({ kind: 'video', duration: 8 }), 8);
  assert.equal(spec.loopSeconds({ kind: 'video', duration: 15.99 }), 14);
  assert.equal(spec.loopSeconds({ kind: 'video', duration: 1.9 }), 0);
  assert.equal(spec.loopSeconds({ kind: 'image' }), 10);
});

test('buildLoopArgs altın argümanlar (video)', () => {
  const args = spec.buildLoopArgs({ input: 'in.mp4', output: 'out.tmp', kind: 'video', seconds: 8 });
  assert.deepEqual(args, [
    '-hide_banner', '-nostats', '-y', '-i', 'in.mp4',
    '-map', '0:v:0', '-an',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=increase:out_range=tv,crop=1280:720,setsar=1,fps=24,format=yuv420p',
    '-t', '8', '-color_range', 'tv',
    '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
    '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-bf', '0', '-x264-params', 'open-gop=0',
    '-b:v', '3500k', '-maxrate', '3500k', '-bufsize', '7000k',
    '-movflags', '+faststart', '-f', 'mp4', 'out.tmp',
  ]);
});

test('buildLoopArgs görselde -loop 1 girdisi kullanır', () => {
  const args = spec.buildLoopArgs({ input: 'a.png', output: 'o', kind: 'image', seconds: 10 });
  assert.deepEqual(args.slice(3, 10), ['-loop', '1', '-framerate', '24', '-t', '10', '-i']);
});

test('isUpToDate: yalnızca çıktı tüm girdilerden yeniyse güncel', () => {
  assert.equal(spec.isUpToDate(null, [1]), false);
  assert.equal(spec.isUpToDate(10, [5]), true);
  assert.equal(spec.isUpToDate(10, [5, 10]), false);
  assert.equal(spec.isUpToDate(10, [20]), false);
});

test('parseSsim ffmpeg çıktısından ortalamayı okur', () => {
  assert.equal(spec.parseSsim('[Parsed_ssim_0] SSIM Y:0.98 U:0.99 V:0.99 All:0.983456 (17.8)'), 0.983456);
  assert.equal(spec.parseSsim('hata'), null);
});
