// Sihirbazın Ink (React) render katmanı — ince "presenter". ConfigWizard'dan hazır
// görünüm modelini (getViewModel) alıp basar; iş mantığı içermez. JSX yok:
// React.createElement (h), ink-app.mjs ile aynı biçim.
//
// Tek bir genel ekran: vm.kind (list | checklist | order | form | summary) hangi gövdenin
// basılacağını söyler. Yeni adım eklemek presenter'a dokunmayı gerektirmez.
import React from 'react';
import { Box, Text } from 'ink';

const h = React.createElement;

const ACCENT = 'cyan';
const MUTED = 'gray';

// Terminal yüksekliğine göre listeden kaç satır gösterilecek (imleç ortada tutulur).
function windowed(items, cursor, height) {
  if (items.length <= height) return { slice: items, offset: 0 };
  const half = Math.floor(height / 2);
  const offset = Math.max(0, Math.min(items.length - height, cursor - half));
  return { slice: items.slice(offset, offset + height), offset };
}

function Row({ item }) {
  const number = item.number != null ? `${String(item.number).padStart(2, ' ')}. ` : '';
  const color = item.selected ? ACCENT : undefined;
  return h(
    Text,
    { wrap: 'truncate-end' },
    h(Text, { color: ACCENT, bold: true }, item.selected ? '> ' : '  '),
    item.checkable
      ? h(Text, { color: item.checked ? 'green' : MUTED }, item.checked ? '[x] ' : '[ ] ')
      : null,
    // Albüm başlığı listeyi bölen bir ara satır: parçalardan ayırt edilsin diye kalın.
    h(Text, { color, bold: item.selected || item.header }, `${number}${item.label}`),
    item.current && !item.selected ? h(Text, { color: 'green' }, ' ·') : null,
    item.hint ? h(Text, { color: MUTED }, `   ${item.hint}`) : null,
  );
}

function ListBody({ vm, height }) {
  if (!vm.items.length) {
    return [h(Text, { key: 'empty', color: MUTED }, '(liste boş — Enter ile devam)')];
  }
  const { slice, offset } = windowed(vm.items, vm.cursor, height);
  const rows = slice.map((item, i) => h(Row, { key: offset + i, item }));
  if (vm.items.length > slice.length) {
    rows.push(h(
      Text,
      { key: 'more', color: MUTED },
      `  ${offset + 1}-${offset + slice.length} / ${vm.items.length}`,
    ));
  }
  return rows;
}

function FormBody({ vm }) {
  return vm.form.map((field, i) => h(
    Box,
    { key: i },
    h(Text, { color: field.focused ? ACCENT : MUTED, bold: true }, field.focused ? '> ' : '  '),
    h(Text, { color: field.focused ? undefined : MUTED }, `${field.label}:`.padEnd(20)),
    h(Text, { bold: true, color: field.focused ? ACCENT : undefined }, field.value || '_'),
    field.unit ? h(Text, { color: MUTED }, ` ${field.unit}`) : null,
  ));
}

function SummaryBody({ vm, height }) {
  const rows = [];
  for (const line of vm.summary) {
    rows.push(h(
      Box,
      { key: `l-${line.label}` },
      h(Text, { color: MUTED }, `${line.label}:`.padEnd(14)),
      h(Text, { bold: true, wrap: 'truncate-end' }, String(line.value)),
    ));
    if (line.list) {
      for (const [i, entry] of line.list.entries()) {
        rows.push(h(Text, { key: `${line.label}-${i}`, color: MUTED, wrap: 'truncate-end' }, `              ${entry}`));
      }
    }
  }
  rows.push(h(Box, { key: 'gap', marginTop: 1 }));
  const { slice, offset } = windowed(vm.items, vm.cursor, Math.max(4, height - rows.length));
  slice.forEach((item, i) => rows.push(h(Row, { key: `a${offset + i}`, item })));
  return rows;
}

function Body({ vm, height }) {
  if (vm.busy) return [h(Text, { key: 'busy', color: 'yellow' }, `◐ ${vm.busy}`)];
  if (vm.textInput) {
    return [
      h(
        Box,
        { key: 'ti' },
        h(Text, { color: MUTED }, `${vm.textInput.label}: `),
        h(Text, { bold: true, color: ACCENT }, `${vm.textInput.value}█`),
      ),
      h(Text, { key: 'tih', color: MUTED }, 'yol proje köküne göre ya da mutlak olabilir'),
    ];
  }
  if (vm.kind === 'form') return h(FormBody, { vm });
  if (vm.kind === 'summary') return h(SummaryBody, { vm, height });
  return h(ListBody, { vm, height });
}

export function Wizard({ vm, rows = 24 }) {
  // Çerçeve + başlık + ipucu + alt bilgi dışında kalan yükseklik listeye ayrılır.
  const height = Math.max(4, (rows || 24) - 9);
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { borderStyle: 'round', borderColor: 'gray', paddingX: 1, justifyContent: 'space-between' },
      h(Text, { bold: true, color: ACCENT }, 'YAYIN YAPILANDIRMA'),
      h(Text, { color: MUTED }, vm.step),
    ),
    h(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexGrow: 1 },
      h(
        Box,
        { justifyContent: 'space-between' },
        h(Text, { bold: true, color: ACCENT }, vm.title),
        vm.search !== null ? h(Text, { color: 'yellow' }, `/${vm.search}█`) : null,
      ),
      vm.hint ? h(Text, { color: MUTED }, vm.hint) : null,
      h(Box, { flexDirection: 'column', marginTop: 1 }, h(Body, { vm, height })),
    ),
    vm.error ? h(Box, { paddingX: 1 }, h(Text, { color: 'red' }, `✕ ${vm.error}`)) : null,
    vm.notice ? h(Box, { paddingX: 1 }, h(Text, { color: 'green' }, `✓ ${vm.notice}`)) : null,
    h(
      Box,
      { paddingX: 1 },
      vm.footer.flatMap((f, i) => [
        h(Text, { key: `k${i}`, bold: true, color: ACCENT }, `[${f.key}]`),
        h(Text, { key: `l${i}`, color: MUTED }, ` ${f.label}   `),
      ]),
    ),
  );
}

export default Wizard;
