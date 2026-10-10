// Deterministik "rastgele" seçim: aynı seed + index her zaman aynı elemanı döndürür.
// Saf domain — I/O yok, Math.random YOK (restart'a dayanıklı olmak için RNG tamamen
// seed'den türemeli, bkz. src/domain/pomodoro.js phaseIndex ve PLAN-yapilandirma-ui.md
// Faz N3 "Seçim RESTART'A DAYANIKLI olmalı").
//
// queue.js'teki shuffle kuralının AYNISI ("her tur listenin karıştırılmış bir kopyası,
// tur sınırında da aynı eleman arka arkaya gelmez") ama STATELESS/konumsal: Queue bir
// akışı tüketir, burada ise "index'inci eleman ne olurdu" sorusunun saf cevabı isteniyor
// (pomodoro fazının sıra numarasından klip hesaplamak için — motor hiçbir sıra tutmaz).
const mulberry32 = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// round numarasına özel bir alt-seed türetir: aynı seed farklı round'larda farklı (ama
// her zaman aynı round için aynı) permütasyon üretsin.
const roundSeed = (seed, round, salt = 0) => (seed + round * 0x9E3779B9 + salt) >>> 0;

// Fisher-Yates, verilen round için TAM deterministik (aynı seed+round → aynı sonuç).
function basePermutation(pool, seed, round) {
  const rng = mulberry32(roundSeed(seed, round));
  const a = [...pool];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Bir round'a takas (varsa) uygular ve SONUÇ permütasyonu döndürür. prevLast önceki
// round'un (zaten takas uygulanmış) son elemanı olmalı — yoksa takas zincirleme etkisini
// kaybeder (aşağıdaki not).
function applyBoundarySwap(perm, seed, round, prevLast) {
  if (perm[0] === prevLast) {
    const swapRng = mulberry32(roundSeed(seed, round, 0x1_000_000));
    const j = 1 + Math.floor(swapRng() * (perm.length - 1));
    [perm[0], perm[j]] = [perm[j], perm[0]];
  }
  return perm;
}

// Tur sınırı düzeltmesi UYGULANMIŞ tam permütasyon (queue.js'teki aynı kural: yeni
// turun ilki, bir önceki turun sonuncusuyla aynı olamaz). TÜM permütasyon döndürülür —
// yalnızca position 0'ı değil, çünkü takas iki pozisyonu birden değiştirir; herhangi bir
// position için ayrı ayrı "swap uygulanmış mı" kontrolü yapmak position 0 dışındaki
// konumları eski/tutarsız değerle döndürür.
//
// ZİNCİRLEME: round r'nin takası round r'nin SON elemanını değiştirebilir (j == n-1 ise),
// bu da round r+1'in takas kontrolünü etkiler. Bu yüzden prevLast hep ÖNCEKİ round'un
// ÇÖZÜLMÜŞ (takas uygulanmış) son elemanı olmalı — baştan (round 0) itibaren adım adım
// ilerlenir. round sayısı pratikte küçük kalır (pomodoro faz sayısı, günlerce yayında
// bile binlerce), O(round) burada sorun değil; rekürsiyon yerine döngü kullanmak yığın
// taşmasını önler.
function resolvedPermutation(pool, seed, round) {
  let prevLast = basePermutation(pool, seed, 0).at(-1);
  if (round === 0) return basePermutation(pool, seed, 0);
  for (let r = 1; r < round; r++) {
    const perm = applyBoundarySwap(basePermutation(pool, seed, r), seed, r, prevLast);
    prevLast = perm.at(-1);
  }
  return applyBoundarySwap(basePermutation(pool, seed, round), seed, round, prevLast);
}

// havuzun index'inci elemanı. index = round * pool.length + position.
// Tek elemanlı havuz: tekrar kuralı uygulanamaz, hep aynı eleman döner (kasıtlı).
// Boş havuz: null.
function shuffledAt(pool, seed, index) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  if (!Number.isInteger(index) || index < 0) throw new Error(`geçersiz index (${index})`);

  const round = Math.floor(index / pool.length);
  const position = index % pool.length;
  return resolvedPermutation(pool, seed, round)[position];
}

module.exports = { shuffledAt, mulberry32 };
