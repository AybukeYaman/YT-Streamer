// Pomodoro döngüsünün BAŞLANGIÇ ANINI diske yazar (runtime/pomodoro.json).
//
// Neden ayrı dosya: state.json çalan playlist'in konumunu tutuyor ve her ilerlemede
// yeniden yazılıyor. Pomodoro başlangıcı ise döngü boyunca DEĞİŞMEYEN tek bir sayı;
// aynı dosyaya koymak onu her yazımda gereksiz riske atardı.
//
// Kaydedilen: startedAt (epoch ms), hangi tür için başlatıldığı ve seed (N3: study/break
// klip havuzundan hangi klibin seçileceğini belirleyen deterministik PRNG tohumu, bkz.
// src/domain/seeded-shuffle.js). Faz (STUDY mi BREAK mi) ve kalan süre KAYDEDİLMEZ —
// ikisi de startedAt + duvar saatinden yeniden hesaplanıyor. Türetilebilen durumu
// saklamak, yeniden başlatmada iki kaynağın çelişmesi demek olurdu.
//
// seed de startedAt ile AYNI kayıtta tutulur (ikinci bir dosya yok): klip seçimi de
// döngü gibi restart'a dayanıklı olmalı — ikisi ayrı dosyalarda olsa biri yazılıp diğeri
// yazılamadığında (disk hatası) tutarsız bir çift ortaya çıkabilirdi.
//
// Tür değişirse (config'de 50+10 → 30+10) kayıt geçersiz sayılır ve döngü (ve seed)
// yeniden başlar: yarım kalmış bir 50 dakikanın 30 dakikalık düzende karşılığı yok.
const fs = require('fs');

class PomodoroStore {
  // file: mutlak yol (runtime/pomodoro.json); writeFile: atomik yazma
  constructor({ file, writeFile, log }) {
    this.file = file;
    this.writeFile = writeFile;
    this.log = log;
  }

  save({ type, startedAt, seed }) {
    try {
      this.writeFile(this.file, JSON.stringify({ type, startedAt, seed }));
    } catch (err) {
      // Yazılamazsa yayın sürmeli: yalnızca restart sonrası döngü başa döner.
      this.log.warn(`pomodoro durumu yazılamadı: ${err.message}`);
    }
  }

  // Verilen tür için geçerli bir kayıt varsa { startedAt, seed }, yoksa null.
  // seed eski kayıtlarda (N3 öncesi) yoktu — yoksa 0 döner (deterministik, geçerli bir
  // seed): klip havuzu o sırada henüz yoktu, yani ilk kez kullanıldığında herhangi bir
  // seed değeri kabul edilir.
  load(type) {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`pomodoro durumu okunamadı: ${err.message}`);
      return null;
    }
    let state;
    try {
      state = JSON.parse(text);
    } catch (err) {
      this.log.warn(`pomodoro durumu geçerli JSON değil, yoksayılıyor: ${err.message}`);
      return null;
    }
    if (!state || !Number.isFinite(state.startedAt)) {
      this.log.warn('pomodoro durumu eksik (startedAt yok), yoksayılıyor');
      return null;
    }
    if (state.type !== type) {
      this.log.info(`pomodoro türü değişmiş (${state.type} → ${type}) — döngü yeniden başlıyor`);
      return null;
    }
    return { startedAt: state.startedAt, seed: Number.isFinite(state.seed) ? state.seed : 0 };
  }
}

module.exports = { PomodoroStore };
