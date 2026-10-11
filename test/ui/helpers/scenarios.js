// Form-eşdeğerlik testinin senaryoları (config-page.form-golden.json ESKİ sürümden üretildi).
// Ek yayın ve başlat/durdur formları burada YOK: bilinçli olarak yeniden tasarlandılar
// (bağlamsal tek düğme), onların sınaması config-page.test.js'te ayrıca yapılır.
const { StreamPlan } = require('../../../src/domain/stream-plan');

const LIVE = {
  id: 'b1', title: 'Canlı "yayın" <1>', description: 'açıklama\nikinci satır', privacyStatus: 'unlisted', lifeCycleStatus: 'live', finished: false,
};
const DONE = {
  id: 'b2', title: 'Eski', description: '', privacyStatus: 'private', lifeCycleStatus: 'complete', finished: true,
};
const CLIPS = ['X:/clips/a.mp4', 'X:/clips/b & c.mp4', 'X:/clips/<d>.mp4'];
const COVERS = ['X:/c/a.jpg', 'X:/c/b.jpg'];
const ALBUMS = [
  { name: 'mimi', trackCount: 12, backgrounds: ['X:/m/mimi/bg.mp4'] },
  { name: 'zen', trackCount: 3, backgrounds: [] },
];

const scenarios = {
  tam: () => ({
    plan: new StreamPlan({
      name: 'Cozy',
      cover: 'X:/c/b.jpg',
      broadcast: { title: 'Sonraki "başlık"', description: 'Sonraki\naçıklama' },
      pomodoro: {
        enabled: true, type: '45+15', studyVideos: [CLIPS[0], CLIPS[2]], breakVideos: [CLIPS[1]],
      },
    }),
    clips: CLIPS,
    covers: COVERS,
    token: 'tk',
    broadcasts: { items: [LIVE, DONE] },
    selectedId: 'b1',
  }),
  varsayilan: () => ({ plan: new StreamPlan({}), clips: [], token: 'tk' }),
  yeniVarsayilan: () => ({
    plan: new StreamPlan({}), clips: [], covers: COVERS, token: 'tk', canCreate: true, newMode: true, broadcasts: { items: [] }, catalogAlbums: ALBUMS,
  }),
  yeniTaslak: () => ({
    plan: new StreamPlan({}),
    clips: [],
    covers: COVERS,
    token: 'tk',
    canCreate: true,
    newMode: true,
    broadcasts: { items: [LIVE] },
    selectedId: 'b1',
    catalogAlbums: ALBUMS,
    draft: {
      name: 'lofi2', title: 'Gece <b>', description: 'a\nb', privacy: 'private', cover: 'X:/c/a.jpg', albums: ['zen'], goLiveNow: false,
    },
    error: 'kapasite dolu',
  }),
  yukluKapak: () => ({
    plan: new StreamPlan({ cover: 'X:/c/a.jpg' }), clips: CLIPS, covers: [...COVERS, 'X:/c/galeri.jpg'], token: 'tk', pendingCover: 'X:/c/galeri.jpg',
  }),
};

module.exports = { scenarios };
