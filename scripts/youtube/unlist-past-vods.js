#!/usr/bin/env node
// Geçmiş yayınların VOD'larını (kayıtlarını) liste dışına alır.
//
// NEDEN VAR: vodPrivacy özelliği yalnızca BUNDAN SONRA bitecek yayınlara uygulanır.
// Daha önce bitmiş yayınların kayıtları kanalda herkese açık duruyor — onları bu betik
// temizler. Tek seferlik bir iş ama tekrar gerekebilir (özellik kapalıyken biten
// yayınlar, elle açılmış yayınlar), bu yüzden repo'da.
//
// GÜVENLİK: varsayılan KURU ÇALIŞMA. Ne yapacağını listeler, hiçbir şeye dokunmaz.
// Gerçek değişiklik için --apply gerekir.
//
// CANLI YAYINA DOKUNMAZ: yalnızca lifeCycleStatus === 'complete' olanlar işlenir.
// 'live', 'ready', 'created', 'testing' olanlar atlanır — çalışan yayını liste dışına
// almak izleyiciyi anında düşürürdü.
//
// Kullanım:
//   node scripts/youtube/unlist-past-vods.js              # kuru çalışma (varsayılan)
//   node scripts/youtube/unlist-past-vods.js --apply      # gerçekten çevir
//   node scripts/youtube/unlist-past-vods.js --apply --to private
const { loadYoutubeCredentials } = require('../../src/infrastructure/youtube-credentials');
const { getAccessToken, apiRequest } = require('../../src/infrastructure/youtube-oauth');
const { updateVideoPrivacy } = require('../../src/infrastructure/youtube-broadcasts');

const TARGETS = ['unlisted', 'private'];
const PAGE_SIZE = 50;

function parseArgs(argv) {
  const args = { apply: false, to: 'unlisted' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--to') { args.to = argv[i + 1]; i += 1; }
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`bilinmeyen argüman: ${a}`);
  }
  if (!TARGETS.includes(args.to)) {
    throw new Error(`--to "${args.to}" geçersiz — ${TARGETS.join(' ya da ')} olmalı`);
  }
  return args;
}

// Kanaldaki TÜM broadcast'ler (sayfalama: kanal büyüdükçe 50'den fazlası olur).
async function listAllBroadcasts(accessToken) {
  const items = [];
  let pageToken;
  do {
    const data = await apiRequest({
      accessToken,
      path: 'liveBroadcasts',
      params: {
        part: 'id,snippet,status',
        mine: 'true',
        maxResults: PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    items.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Kullanım: node scripts/youtube/unlist-past-vods.js [--apply] [--to unlisted|private]');
    return;
  }

  const c = loadYoutubeCredentials();
  const { accessToken } = await getAccessToken({
    clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: c.refreshToken,
  });

  const all = await listAllBroadcasts(accessToken);
  console.log(`kanalda ${all.length} broadcast bulundu.\n`);

  const skippedLive = [];
  const already = [];
  const todo = [];
  for (const b of all) {
    const life = b.status?.lifeCycleStatus ?? null;
    const privacy = b.status?.privacyStatus ?? null;
    const row = { id: b.id, title: b.snippet?.title ?? '(başlıksız)', life, privacy };
    if (life !== 'complete') skippedLive.push(row);
    else if (privacy === args.to || privacy === 'private') already.push(row);
    else todo.push(row);
  }

  const line = (r) => `  ${r.id}  ${String(r.privacy).padEnd(8)} ${r.life.padEnd(9)} ${r.title.slice(0, 50)}`;

  if (skippedLive.length) {
    console.log(`ATLANACAK — bitmemiş yayınlar (DOKUNULMAZ): ${skippedLive.length}`);
    skippedLive.forEach((r) => console.log(line(r)));
    console.log();
  }
  if (already.length) {
    console.log(`ATLANACAK — gizliliği zaten uygun: ${already.length}`);
    already.forEach((r) => console.log(line(r)));
    console.log();
  }

  if (todo.length === 0) {
    console.log('Çevrilecek VOD yok. Yapılacak bir şey kalmadı.');
    return;
  }

  console.log(`ÇEVRİLECEK → "${args.to}": ${todo.length}`);
  todo.forEach((r) => console.log(line(r)));
  console.log();

  if (!args.apply) {
    console.log('KURU ÇALIŞMA — hiçbir şey değiştirilmedi.');
    console.log(`Uygulamak için:  node scripts/youtube/unlist-past-vods.js --apply --to ${args.to}`);
    return;
  }

  let changed = 0;
  let failed = 0;
  for (const r of todo) {
    try {
      const result = await updateVideoPrivacy({ accessToken, videoId: r.id, privacyStatus: args.to });
      if (result.skipped) {
        console.log(`  atlandı  ${r.id} — ${result.reason}`);
      } else {
        changed += 1;
        console.log(`  çevrildi ${r.id}  "${result.previous}" → "${args.to}"`);
      }
    } catch (err) {
      // Bir videonun hatası diğerlerini engellemez; betik tekrar çalıştırılabilir
      // (çevrilmiş olanlar "zaten öyle" diye atlanır).
      failed += 1;
      console.log(`  HATA     ${r.id} — ${err.message}`);
    }
  }
  console.log(`\n${changed} çevrildi, ${failed} hata.`);
  if (failed) {
    console.log('Hatalılar için betiği tekrar çalıştırabilirsin — çevrilmiş olanlar atlanır.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`HATA: ${err.message}`);
  process.exit(1);
});
