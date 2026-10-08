// Tuş → soyut aksiyon eşlemesi (saf). Ink'in useInput imzasına uygun: (input, key).
// Aksiyonlar: 'start' | 'restart' | 'configure' | 'quit' | 'log-up' | 'log-down' |
//             'page-up' | 'page-down' | 'live' | null (yoksay).
// Stream komutları (start/restart/quit) UI tarafından ControlService'e; scroll aksiyonları
// LogViewport'a yönlendirilir. Engine'e doğrudan bağlanmaz.
function mapKey(input, key = {}) {
  if (key.ctrl && (input === 'c' || key.name === 'c')) return 'quit';

  if (key.upArrow) return 'log-up';
  if (key.downArrow) return 'log-down';
  if (key.pageUp) return 'page-up';
  if (key.pageDown) return 'page-down';
  if (key.end) return 'live';

  const k = String(input || '').toLowerCase();
  if (k === 's') return 'start';
  if (k === 'r') return 'restart';
  // 'c' — yayın yapılandırma sihirbazı (kapak/müzik/pomodoro seçimi, sonra restart).
  if (k === 'c') return 'configure';
  if (k === 'q') return 'quit';

  return null;
}

module.exports = { mapKey };
