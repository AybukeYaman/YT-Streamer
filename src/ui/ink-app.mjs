// Ink (React) render katmanı — ince "presenter". StreamTui denetleyicisinden hazır görünüm
// modelini (getViewModel) alıp basar; hiçbir iş mantığı içermez. CJS tarafından dynamic import
// ile yüklenir (mount). JSX yok: React.createElement (h) kullanılır (ekstra build/paket yok).
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput } from 'ink';
import { Wizard } from './wizard-view.mjs';

const h = React.createElement;

// ── Küçük parçalar ───────────────────────────────────────────────

function ProgressBar({ bar, percent, accent }) {
  const filled = Math.max(0, Math.min(bar.width, bar.filled));
  const empty = Math.max(0, bar.width - filled);
  return h(
    Text,
    null,
    h(Text, { color: accent }, '█'.repeat(filled)),
    h(Text, { color: 'gray' }, '░'.repeat(empty)),
    h(Text, { bold: true }, ` ${percent}%`),
  );
}

function Panel({ title, accent, width, flexGrow, children, headerRight }) {
  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'gray',
      paddingX: 1,
      width,
      flexGrow,
    },
    h(
      Box,
      { justifyContent: 'space-between' },
      h(Text, { bold: true, color: accent }, title),
      headerRight || null,
    ),
    h(Box, { flexDirection: 'column', marginTop: 1 }, children),
  );
}

function Field({ label, value, muted, valueColor, bold }) {
  return h(
    Box,
    null,
    h(Text, { color: muted }, label.padEnd(9)),
    h(Text, { color: valueColor, bold }, value),
  );
}

// ── Paneller ─────────────────────────────────────────────────────

function CurrentTrack({ vm }) {
  const t = vm.track;
  const body = t
    ? [
      h(Field, { key: 'al', label: 'Album', value: t.album, muted: vm.muted, bold: true }),
      h(Field, { key: 'tr', label: 'Track', value: t.title, muted: vm.muted, valueColor: vm.accent, bold: true }),
      h(Box, { key: 'sp', marginTop: 1 }),
      h(Box, { key: 'bar' }, h(ProgressBar, { bar: t.bar, percent: t.percent, accent: vm.accent })),
      h(
        Box, { key: 'tm' },
        h(Text, { color: vm.muted }, `${t.elapsed} / ${t.duration}`),
        h(Text, { color: vm.muted }, `   -${t.remaining}`),
      ),
    ]
    : [h(Text, { key: 'idle', color: vm.muted }, 'Yayın durdu — parça yok')];
  return h(Panel, { title: 'CURRENT TRACK', accent: vm.accent, width: '50%' }, body);
}

function StreamStatus({ vm }) {
  const s = vm.streamStatus;
  return h(
    Panel, { title: 'STREAM STATUS', accent: vm.accent, width: '50%' },
    [
      h(Field, { key: 'fps', label: 'FPS', value: s.fps, muted: vm.muted, bold: true }),
      h(Field, { key: 'br', label: 'BITRATE', value: s.bitrate, muted: vm.muted, valueColor: vm.accent, bold: true }),
      h(Field, { key: 'sp', label: 'SPEED', value: s.speed, muted: vm.muted }),
      h(Field, { key: 'up', label: 'UPTIME', value: s.uptime, muted: vm.muted }),
      h(Field, { key: 'run', label: 'RUN', value: `#${s.runNumber}`, muted: vm.muted }),
    ],
  );
}

function UpNext({ vm }) {
  const rows = vm.queue.length
    ? vm.queue.map((q, i) => h(
      Text, { key: i, wrap: 'truncate-end' },
      h(Text, { color: vm.muted }, `${q.number}  `),
      q.title,
      h(Text, { color: vm.muted }, `  ${q.duration}`),
    ))
    : [h(Text, { key: 'e', color: vm.muted }, '(kuyruk boş)')];
  return h(Panel, { title: 'UP NEXT', accent: vm.accent, width: '50%' }, rows);
}

function Logs({ vm }) {
  const live = vm.logs.live;
  const indicator = live
    ? h(Text, { color: 'green' }, '● LIVE')
    : h(Text, { color: 'yellow' }, '○ PAUSED');
  const lines = vm.logs.lines.length
    ? vm.logs.lines.map((l, i) => h(
      Text, { key: i, wrap: 'truncate-end' },
      l.time ? h(Text, { color: vm.muted }, `[${l.time}] `) : null,
      h(Text, { color: l.color }, l.text),
    ))
    : [h(Text, { key: 'e', color: vm.muted }, '(log yok)')];
  return h(Panel, { title: 'LOGS', accent: vm.accent, flexGrow: 1, headerRight: indicator }, lines);
}

function Header({ vm }) {
  const st = vm.header.status;
  return h(
    Box,
    { borderStyle: 'round', borderColor: 'gray', paddingX: 1, justifyContent: 'space-between' },
    h(Text, { bold: true, color: vm.accent }, vm.header.title),
    h(Text, { bold: true, color: st.color }, `${st.icon} ${st.label}`),
  );
}

function Footer({ vm }) {
  const parts = [];
  vm.footer.forEach((f, i) => {
    parts.push(h(Text, { key: `k${i}`, bold: true, color: vm.accent }, `[${f.key}]`));
    parts.push(h(Text, { key: `l${i}`, color: vm.muted }, ` ${f.label}   `));
  });
  return h(Box, { paddingX: 1 }, parts);
}

function Dashboard({ vm }) {
  return h(
    Box,
    { flexDirection: 'column' },
    h(Header, { vm }),
    h(Box, { flexDirection: 'row' }, h(CurrentTrack, { vm }), h(StreamStatus, { vm })),
    h(Box, { flexDirection: 'row', flexGrow: 1 }, h(UpNext, { vm }), h(Logs, { vm })),
    h(Footer, { vm }),
  );
}

// Aktif ekran: pano ya da yapılandırma sihirbazı. İkisi AYNI Ink ağacında yer değiştirir
// (bkz. stream-tui.js başlığı) — ikinci bir render örneği açılmaz.
function Screen({ vm }) {
  if (vm.screen === 'wizard') return h(Wizard, { vm: vm.wizard, rows: vm.rows });
  return h(Dashboard, { vm });
}

function App({ controller }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const onRender = () => setTick((t) => (t + 1) % 1e9);
    controller.on('render', onRender);
    return () => controller.removeListener('render', onRender);
  }, [controller]);
  useInput((input, key) => { controller.handleInput(input, key); });
  return h(Screen, { vm: controller.getViewModel() });
}

// CJS StreamTui.open() buradan çağırır: Ink'i başlatır, unmount kolu döner.
export function mount(controller) {
  const instance = render(h(App, { controller }));
  return { unmount: () => instance.unmount(), waitUntilExit: () => instance.waitUntilExit() };
}

export { Dashboard, App, Screen };
