const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildViewModel, statusMeta, parseLogLine, logLevelColor, computeLogHeight,
  formatDuration, formatClock, formatBitrate, formatFps, formatSpeed, truncate,
} = require('../../src/ui/dashboard-view-model');

// ── Biçimlendirme ──

test('formatDuration: mm:ss / h:mm:ss / geçersiz', () => {
  assert.equal(formatDuration(65), '01:05');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatDuration(null), '--:--');
  assert.equal(formatDuration(-1), '--:--');
});

test('formatClock: HH:MM:SS, geçersiz → 00:00:00', () => {
  assert.equal(formatClock(3725), '01:02:05');
  assert.equal(formatClock(0), '00:00:00');
  assert.equal(formatClock(null), '00:00:00');
});

test('formatBitrate: kbps → Mbps eşiği', () => {
  assert.equal(formatBitrate(4820), '4.82 Mbps');
  assert.equal(formatBitrate(800), '800 kbps');
  assert.equal(formatBitrate(null), '—');
});

test('formatFps / formatSpeed', () => {
  assert.equal(formatFps(30), '30.0');
  assert.equal(formatFps(null), '—');
  assert.equal(formatSpeed(1), '1.00x');
  assert.equal(formatSpeed(null), '—');
});

test('truncate: uzun metni … ile keser', () => {
  assert.equal(truncate('kısa', 10), 'kısa');
  assert.equal(truncate('çok uzun bir parça adı', 10), 'çok uzun …');
  assert.equal(truncate('abc', 0), '');
});

// ── statusMeta ──

test('statusMeta: tüm durumlar + bilinmeyen', () => {
  assert.deepEqual(statusMeta('running'), { label: 'RUNNING', icon: '●', color: 'green' });
  assert.deepEqual(statusMeta('restarting'), { label: 'RESTARTING', icon: '◐', color: 'yellow' });
  assert.deepEqual(statusMeta('error'), { label: 'ERROR', icon: '✕', color: 'red' });
  assert.equal(statusMeta('stopped').color, 'gray');
  assert.equal(statusMeta('bilinmeyen').icon, '○');
});

// ── log parse / renk ──

test('parseLogLine: Logger biçimini ayrıştırır', () => {
  const p = parseLogLine({ level: 'info', text: '2026-09-29 22:41:03.123 [INFO] [control] yayın başladı' });
  assert.equal(p.time, '22:41:03');
  assert.equal(p.level, 'info');
  assert.equal(p.scope, 'control');
  assert.equal(p.text, 'yayın başladı');
});

test('parseLogLine: WARN metinden algılanır (buffer error kovasında olsa da)', () => {
  const p = parseLogLine({ level: 'error', text: '2026-09-29 22:41:03.123 [WARN] [supervisor] çökme' });
  assert.equal(p.level, 'warn');
});

test('parseLogLine: eşleşmeyen satır fallback', () => {
  const p = parseLogLine({ level: 'error', text: '[tui] Başlat: zaten çalışıyor' });
  assert.equal(p.time, null);
  assert.equal(p.level, 'warn'); // error kovası → warn fallback
  assert.equal(p.text, '[tui] Başlat: zaten çalışıyor');
});

test('logLevelColor', () => {
  assert.equal(logLevelColor('error'), 'red');
  assert.equal(logLevelColor('warn'), 'yellow');
  assert.equal(logLevelColor('info'), undefined);
});

// ── computeLogHeight ──

test('computeLogHeight: satır sayısına göre clamp', () => {
  assert.equal(computeLogHeight(24), Math.max(3, Math.min(14, 24 - 19)));
  assert.equal(computeLogHeight(10), 3); // alt sınır
  assert.equal(computeLogHeight(100), 14); // üst sınır
});

// ── buildViewModel ──

test('buildViewModel: çalışan durum tam yapı', () => {
  const vm = buildViewModel({
    status: { state: 'running', uptime: 3725, fps: 30, bitrateKbps: 4820, speed: 1, runNumber: 12 },
    track: { albumName: 'Rainy Nights', trackTitle: 'Midnight Rain', trackDuration: 285, elapsedSeconds: 222, remainingSeconds: 63 },
    queue: [
      { albumName: 'Rainy Nights', trackTitle: 'Soft Rain', duration: 200 },
      { albumName: 'Rainy Nights', trackTitle: 'Empty Streets', duration: 210 },
    ],
    logLines: [{ level: 'info', text: '2026-09-29 22:41:03.000 [INFO] [control] ok' }],
    live: true, columns: 100,
  });
  assert.equal(vm.header.title, 'YT STREAMER');
  assert.equal(vm.header.status.label, 'RUNNING');
  assert.equal(vm.track.album, 'Rainy Nights');
  assert.equal(vm.track.percent, Math.round((222 / 285) * 100));
  assert.ok(vm.track.bar.filled <= vm.track.bar.width);
  assert.equal(vm.streamStatus.bitrate, '4.82 Mbps');
  assert.equal(vm.queue[0].number, '01');
  assert.equal(vm.queue[1].number, '02');
  assert.equal(vm.logs.live, true);
  assert.equal(vm.logs.lines[0].text, 'ok');
  assert.equal(vm.footer[0].key, 'S');
});

test('buildViewModel: durmuş/boş güvenli', () => {
  const vm = buildViewModel({ status: { state: 'stopped' }, track: null, queue: [], logLines: [], live: false });
  assert.equal(vm.header.status.label, 'STOPPED');
  assert.equal(vm.track, null);
  assert.deepEqual(vm.queue, []);
  assert.deepEqual(vm.logs.lines, []);
  assert.equal(vm.logs.live, false);
});

test('buildViewModel: queueLimit ve isim truncate uygulanır', () => {
  const queue = Array.from({ length: 20 }, (_, i) => ({ albumName: 'A', trackTitle: `Track ${i}`, duration: 60 }));
  const vm = buildViewModel({ status: { state: 'running' }, queue, logLines: [], queueLimit: 10, columns: 60 });
  assert.equal(vm.queue.length, 10);
});

test('buildViewModel: uzun parça adı bar/isim genişliğine göre kısalır', () => {
  const vm = buildViewModel({
    status: { state: 'running' },
    track: { albumName: 'X'.repeat(200), trackTitle: 'Y'.repeat(200), trackDuration: 100, elapsedSeconds: 50, remainingSeconds: 50 },
    queue: [], logLines: [], columns: 80,
  });
  assert.ok(vm.track.title.endsWith('…'));
  assert.ok(vm.track.title.length < 200);
});
