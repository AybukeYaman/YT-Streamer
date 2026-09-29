import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';

import { Dashboard } from '../../src/ui/ink-app.mjs';
import viewModel from '../../src/ui/dashboard-view-model.js';

const { buildViewModel } = viewModel;
const h = React.createElement;

function runningVm(overrides = {}) {
  return buildViewModel({
    status: { state: 'running', uptime: 3725, fps: 30, bitrateKbps: 4820, speed: 1, runNumber: 12 },
    track: { albumName: 'Rainy Nights', trackTitle: 'Midnight Rain', trackDuration: 285, elapsedSeconds: 222, remainingSeconds: 63 },
    queue: [
      { albumName: 'Rainy Nights', trackTitle: 'Soft Rain', duration: 200 },
      { albumName: 'Rainy Nights', trackTitle: 'Empty Streets', duration: 210 },
    ],
    logLines: [{ level: 'info', text: '2026-09-29 22:41:03.000 [INFO] [control] FFmpeg started' }],
    live: true, columns: 100,
    ...overrides,
  });
}

test('Ink render: dashboard temel bölümleri ve verileri basar', () => {
  const { lastFrame } = render(h(Dashboard, { vm: runningVm() }));
  const frame = lastFrame();
  assert.match(frame, /YT STREAMER/);
  assert.match(frame, /RUNNING/);
  assert.match(frame, /CURRENT TRACK/);
  assert.match(frame, /Midnight Rain/);
  assert.match(frame, /STREAM STATUS/);
  assert.match(frame, /4\.82 Mbps/);
  assert.match(frame, /UP NEXT/);
  assert.match(frame, /Soft Rain/);
  assert.match(frame, /LOGS/);
  assert.match(frame, /FFmpeg started/);
  assert.match(frame, /LIVE/);
});

test('Ink render: durmuş durumda boş göstergeler, crash yok', () => {
  const vm = buildViewModel({ status: { state: 'stopped' }, track: null, queue: [], logLines: [], live: false, columns: 100 });
  const { lastFrame } = render(h(Dashboard, { vm }));
  const frame = lastFrame();
  assert.match(frame, /STOPPED/);
  assert.match(frame, /kuyruk boş/);
  assert.match(frame, /log yok/);
  assert.match(frame, /PAUSED/);
});

test('Ink render: PAUSED göstergesi live=false iken görünür', () => {
  const { lastFrame } = render(h(Dashboard, { vm: runningVm({ live: false }) }));
  assert.match(lastFrame(), /PAUSED/);
});
