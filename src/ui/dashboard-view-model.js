// Saf (I/O'suz, framework'süz) görünüm modeli: StreamControlService'in ham çıktısını + log
// dilimini alıp Ink presenter'ın doğrudan basacağı yapıya çevirir. Renkler burada anlamsal
// token olarak seçilir (ANSI yok) — böylece tüm biçimlendirme/hiyerarşi kararları test edilebilir.
//
// Tema: koyu terminal, ölçülü tek accent (cyan). Durum renkleri anlamsal:
//   running=green, restarting=yellow, stopped=gray, error=red.

const ACCENT = 'cyan';
const MUTED = 'gray';

// ── Biçimlendirme yardımcıları ───────────────────────────────────

// mm:ss veya h:mm:ss. Geçersiz/negatif → '--:--'.
function formatDuration(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--';
  const whole = Math.floor(totalSeconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

// Saat biçimi HH:MM:SS (uptime için). Geçersiz → '00:00:00'.
function formatClock(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00:00';
  const whole = Math.floor(totalSeconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}

function formatBitrate(kbps) {
  if (kbps == null || !Number.isFinite(kbps)) return '—';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
}

function formatFps(fps) {
  return fps == null || !Number.isFinite(fps) ? '—' : fps.toFixed(1);
}

function formatSpeed(speed) {
  return speed == null || !Number.isFinite(speed) ? '—' : `${speed.toFixed(2)}x`;
}

// Uzun metni UI'yi bozmayacak şekilde kısalt (son karakter … ). max küçükse güvenli.
function truncate(str, max) {
  const s = String(str ?? '');
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max === 1) return '…';
  return `${s.slice(0, max - 1)}…`;
}

// Durum → { label, icon, color }. Bilinmeyen → stopped görünümü.
function statusMeta(state) {
  switch (state) {
    case 'running': return { label: 'RUNNING', icon: '●', color: 'green' };
    case 'restarting': return { label: 'RESTARTING', icon: '◐', color: 'yellow' };
    case 'error': return { label: 'ERROR', icon: '✕', color: 'red' };
    case 'stopped': return { label: 'STOPPED', icon: '○', color: MUTED };
    default: return { label: String(state || 'UNKNOWN').toUpperCase(), icon: '○', color: MUTED };
  }
}

// Log satırını ayrıştır: Logger biçimi "YYYY-MM-DD HH:MM:SS.mmm [LEVEL] [scope] mesaj".
// level metinden alınır (WARN/ERROR ayrımı için — buffer ikisini de 'error' kovasına koyar).
const LOG_RE = /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2})\.\d+ \[(\w+)\] \[([^\]]+)\] ([\s\S]*)$/;

function parseLogLine(entry) {
  const raw = typeof entry === 'string' ? entry : (entry && entry.text) || '';
  const fallbackLevel = entry && entry.level === 'error' ? 'warn' : 'info';
  const m = LOG_RE.exec(raw);
  if (!m) return { time: null, level: fallbackLevel, scope: null, text: raw };
  const level = m[2].toLowerCase(); // info | warn | error | debug
  return { time: m[1], level, scope: m[3], text: m[4] };
}

// Log seviyesi → renk. info=soft(varsayılan), warn=amber, error=kırmızı, debug=muted.
function logLevelColor(level) {
  switch (level) {
    case 'error': return 'red';
    case 'warn': return 'yellow';
    case 'debug': return MUTED;
    default: return undefined; // normal metin
  }
}

// ── Layout ───────────────────────────────────────────────────────

// Terminal satır sayısından log/kuyruk iç yüksekliğini hesaplar (responsive).
// Header + üst panel bandı + footer için sabit pay ayrılır; kalanı alt bant kullanır.
function computeLogHeight(rows) {
  const r = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;
  // header(3) + üst bant(9) + footer(3) + alt bant border/başlık(4) ≈ 19 sabit
  return Math.max(3, Math.min(14, r - 19));
}

// ── Görünüm modeli ───────────────────────────────────────────────

// buildViewModel: presenter'ın basacağı tam yapıyı üretir.
// params: { status, track, queue, logLines, live, queueLimit, columns }
function buildViewModel({
  status = {}, track = null, queue = [], logLines = [],
  live = true, queueLimit = 10, columns = 80,
} = {}) {
  const width = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
  const meta = statusMeta(status.state);

  // Panel genişliğine göre isim kısaltma payı (yaklaşık yarı ekran - dekor).
  const nameWidth = Math.max(10, Math.floor(width / 2) - 12);
  const barWidth = Math.max(10, Math.min(28, Math.floor(width / 2) - 12));

  const header = {
    title: 'YT STREAMER',
    accent: ACCENT,
    status: meta,
  };

  const streamStatus = {
    fps: formatFps(status.fps),
    bitrate: formatBitrate(status.bitrateKbps),
    speed: formatSpeed(status.speed),
    uptime: formatClock(status.uptime),
    runNumber: status.runNumber ?? 0,
  };

  let trackVm = null;
  if (track) {
    const total = track.trackDuration || 0;
    const elapsed = track.elapsedSeconds || 0;
    const ratio = total > 0 ? Math.max(0, Math.min(1, elapsed / total)) : 0;
    const filled = Math.round(ratio * barWidth);
    trackVm = {
      album: truncate(track.albumName, nameWidth),
      title: truncate(track.trackTitle, nameWidth),
      elapsed: formatDuration(elapsed),
      duration: formatDuration(total),
      remaining: formatDuration(track.remainingSeconds),
      percent: Math.round(ratio * 100),
      bar: { width: barWidth, filled },
      accent: ACCENT,
    };
  }

  const queueVm = queue.slice(0, queueLimit).map((item, i) => ({
    number: String(i + 1).padStart(2, '0'),
    title: truncate(item.trackTitle, nameWidth),
    album: truncate(item.albumName, Math.max(6, nameWidth - 6)),
    duration: formatDuration(item.duration),
  }));

  const logsVm = {
    live,
    lines: logLines.map((e) => {
      const p = parseLogLine(e);
      return { time: p.time, text: p.text, level: p.level, color: logLevelColor(p.level) };
    }),
  };

  const footer = [
    { key: 'S', label: 'Start' },
    { key: 'R', label: 'Restart' },
    { key: 'C', label: 'Configure' },
    { key: 'Q', label: 'Stop' },
    { key: '↑↓', label: 'Logs' },
    { key: 'End', label: 'Live' },
  ];

  return { header, streamStatus, track: trackVm, queue: queueVm, logs: logsVm, footer, accent: ACCENT, muted: MUTED };
}

module.exports = {
  buildViewModel,
  statusMeta,
  parseLogLine,
  logLevelColor,
  computeLogHeight,
  formatDuration,
  formatClock,
  formatBitrate,
  formatFps,
  formatSpeed,
  truncate,
  ACCENT,
  MUTED,
};
