import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';

import { Wizard } from '../../src/ui/wizard-view.mjs';
import { Screen } from '../../src/ui/ink-app.mjs';
import wizardModule from '../../src/ui/config-wizard.js';
import planModule from '../../src/domain/stream-plan.js';

const { ConfigWizard } = wizardModule;
const { StreamPlan } = planModule;
const h = React.createElement;

// Presenter testi: GERÇEK görünüm modelini denetleyiciden alır (elle kurulmuş bir nesne
// değil) — böylece denetleyici ile presenter arasındaki sözleşme kayarsa burada çıkar.

const ALBUMS = [{
  name: 'mimi',
  backgrounds: ['X:/mimi/bg.mp4'],
  tracks: [
    { path: 'X:/mimi/1.m4a', title: 'Sakin Sabah', durationSeconds: 120 },
    { path: 'X:/mimi/2.m4a', title: 'Yagmur', durationSeconds: 180 },
  ],
  totalSeconds: 300,
}];

function service() {
  return {
    listAlbums: async () => ALBUMS,
    listClips: async () => ['X:/assets/study.mp4'],
    listCovers: () => ['X:/assets/kapak.jpg'],
    listPresets: () => [],
    loadPreset: () => null,
    inspectPath: () => ({ ok: false, reason: 'yok' }),
    savePreset: (p) => ({ slug: 'x', plan: StreamPlan.from(p) }),
    applyAndRestart: async (p) => ({ plan: StreamPlan.from(p), warnings: [] }),
    restart: async () => ({}),
  };
}

async function openAt(steps = []) {
  const wizard = new ConfigWizard({ configService: service(), onExit() {} });
  await wizard.open();
  for (const [input, key] of steps) wizard.handleInput(input, key || {});
  return wizard;
}

const ENTER = ['', { return: true }];
const DOWN = ['', { downArrow: true }];

test('Ink render: liste adımı başlık, ipucu, imleç ve alt bilgiyi basar', async () => {
  const wizard = await openAt([ENTER]);
  const { lastFrame } = render(h(Wizard, { vm: wizard.getViewModel(), rows: 40 }));
  const frame = lastFrame();
  assert.match(frame, /YAYIN YAPILANDIRMA/);
  assert.match(frame, /SELECT COVER/);
  assert.match(frame, /assets\/kapak\.jpg/);
  assert.match(frame, /custom file/);
  assert.match(frame, /> /); // imleç
  assert.match(frame, /\[Enter\]/);
});

test('Ink render: çoklu seçim adımı kutuları ve albüm başlığını basar', async () => {
  const wizard = await openAt([ENTER, ENTER, [' ', {}]]);
  const vm = wizard.getViewModel();
  assert.equal(vm.kind, 'checklist');
  const frame = render(h(Wizard, { vm, rows: 40 })).lastFrame();
  assert.match(frame, /SELECT MUSIC/);
  assert.match(frame, /mimi/);
  assert.match(frame, /Sakin Sabah/);
  assert.match(frame, /\[x\]|\[ \]/);
});

test('Ink render: arama satırı görünür', async () => {
  const wizard = await openAt([ENTER, ENTER, ['/', {}], ['y', {}], ['a', {}]]);
  const frame = render(h(Wizard, { vm: wizard.getViewModel(), rows: 40 })).lastFrame();
  assert.match(frame, /\/ya/);
});

test('Ink render: sıralama adımı numaraları basar', async () => {
  // mimi başlığında space → tüm albüm seçili, sonra order adımı.
  const wizard = await openAt([ENTER, ENTER, [' ', {}], ENTER]);
  const vm = wizard.getViewModel();
  assert.equal(vm.kind, 'order');
  const frame = render(h(Wizard, { vm, rows: 40 })).lastFrame();
  assert.match(frame, /ORDER/);
  assert.match(frame, /1\. Sakin Sabah/);
  assert.match(frame, /2\. Yagmur/);
});

test('Ink render: serbest süre formu alanları ve odağı basar', async () => {
  const wizard = await openAt([
    ENTER, ENTER, ENTER, ENTER, // preset, cover, music, order
    ENTER, // pomodoro: imleç "No" üstünde → kapalı kalır
  ]);
  // Pomodoro'yu aç ve Custom'a gir.
  wizard.handleInput('', { escape: true }); // özetten pomodoro adımına geri
  const vmBack = wizard.getViewModel();
  assert.equal(vmBack.step, 'pomodoro');
  wizard.handleInput('', { upArrow: true }); // "Yes"
  wizard.handleInput('', { return: true });
  // pomodoroType → Custom (son seçenek)
  wizard.handleInput('', { upArrow: true });
  wizard.handleInput('', { return: true });

  const vm = wizard.getViewModel();
  assert.equal(vm.kind, 'form');
  const frame = render(h(Wizard, { vm, rows: 40 })).lastFrame();
  assert.match(frame, /CUSTOM POMODORO/);
  assert.match(frame, /Study duration/);
  assert.match(frame, /Break duration/);
  assert.match(frame, /Number of rounds/);
});

test('Ink render: özet ekranı değerleri ve aksiyonları basar', async () => {
  const wizard = await openAt([ENTER, ENTER, ENTER, ENTER, ENTER]);
  const vm = wizard.getViewModel();
  assert.equal(vm.step, 'summary');
  const frame = render(h(Wizard, { vm, rows: 44 })).lastFrame();
  assert.match(frame, /LIVE STREAM CONFIG/);
  assert.match(frame, /Music:/);
  assert.match(frame, /Total Music:/);
  assert.match(frame, /Pomodoro:/);
  assert.match(frame, /START STREAM/);
  assert.match(frame, /Save Configuration/);
  assert.match(frame, /Cancel/);
});

test('Ink render: metin girdisi ve hata satırı basılır', async () => {
  const wizard = await openAt([ENTER]);
  // "custom file…" satırına in (kapak + custom + "değiştirilmesin").
  wizard.handleInput('', { downArrow: true });
  const vmList = wizard.getViewModel();
  const customIndex = vmList.items.findIndex((i) => /custom file/.test(i.label));
  while (wizard.getViewModel().cursor !== customIndex) wizard.handleInput('', { downArrow: true });
  wizard.handleInput('', { return: true });
  wizard.handleInput('x', {});
  wizard.handleInput('', { return: true }); // geçersiz → hata

  const frame = render(h(Wizard, { vm: wizard.getViewModel(), rows: 40 })).lastFrame();
  assert.match(frame, /Kapak dosyası:/);
  assert.match(frame, /✕/);
});

test('Ink render: uzun liste pencerelenir ve konum göstergesi basılır', async () => {
  const many = [{
    name: 'buyuk',
    backgrounds: ['X:/b.mp4'],
    tracks: Array.from({ length: 60 }, (_, i) => ({
      path: `X:/${i}.m4a`, title: `Parca ${i}`, durationSeconds: 60,
    })),
    totalSeconds: 3600,
  }];
  const wizard = new ConfigWizard({
    configService: { ...service(), listAlbums: async () => many },
    onExit() {},
  });
  await wizard.open();
  wizard.handleInput('', { return: true });
  wizard.handleInput('', { return: true }); // → music
  const frame = render(h(Wizard, { vm: wizard.getViewModel(), rows: 24 })).lastFrame();
  assert.match(frame, /\/ 61/); // 60 parça + albüm başlığı
  assert.doesNotMatch(frame, /Parca 59/); // pencerenin dışında
});

test('Ink render: Screen ekranı modele göre seçer (pano ↔ sihirbaz)', async () => {
  const wizard = await openAt([ENTER]);
  const frame = render(h(Screen, {
    vm: { screen: 'wizard', rows: 40, wizard: wizard.getViewModel() },
  })).lastFrame();
  assert.match(frame, /SELECT COVER/);
  assert.doesNotMatch(frame, /YT STREAMER/);
});

test('Ink render: "hazırlanıyor" durumu basılır, liste gizlenir', async () => {
  const wizard = await openAt([ENTER]);
  wizard.busy = 'yayın yeniden başlatılıyor…';
  const frame = render(h(Wizard, { vm: wizard.getViewModel(), rows: 40 })).lastFrame();
  assert.match(frame, /yayın yeniden başlatılıyor/);
  assert.doesNotMatch(frame, /custom file/);
});

test('Ink render: boş liste çökme üretmez', async () => {
  const wizard = new ConfigWizard({
    configService: { ...service(), listAlbums: async () => [], listCovers: () => [] },
    onExit() {},
  });
  await wizard.open();
  wizard.handleInput('', { return: true });
  const frame = render(h(Wizard, { vm: wizard.getViewModel(), rows: 40 })).lastFrame();
  assert.match(frame, /SELECT COVER/);
  assert.ok(frame.length > 0);
  assert.ok(DOWN);
});
