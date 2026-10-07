// Pomodoro döngüsünün BAŞLANGIÇ ANINI diske yazar (runtime/pomodoro.json).
//
// Neden ayrı dosya: state.json çalan playlist'in konumunu tutuyor ve her ilerlemede
// yeniden yazılıyor. Pomodoro başlangıcı ise döngü boyunca DEĞİŞMEYEN tek bir sayı;
// aynı dosyaya koymak onu her yazımda gereksiz riske atardı.
//
// Kaydedilen tek şey startedAt (epoch ms) ve hangi tür için başlatıldığı. Faz (STUDY mi
// BREAK mi) ve kalan süre KAYDEDİLMEZ — ikisi de startedAt + duvar saatinden yeniden
// hesaplanıyor. Türetilebilen durumu saklamak, yeniden başlatmada iki kaynağın
// çelişmesi demek olurdu.
//
// Tür değişirse (config'de 50+10 → 30+10) kayıt geçersiz sayılır ve döngü yeniden başlar:
// yarım kalmış bir 50 dakikanın 30 dakikalık düzende karşılığı yok.
const fs = require('fs');

class PomodoroStore {
  // file: mutlak yol (runtime/pomodoro.json); writeFile: atomik yazma
  constructor({ file, writeFile, log }) {
    this.file = file;
    this.writeFile = writeFile;
    this.log = log;
  }

  save({ type, startedAt }) {
    try {
      this.writeFile(this.file, JSON.stringify({ type, startedAt }));
    } catch (err) {
      // Yazılamazsa yayın sürmeli: yalnızca restart sonrası döngü başa döner.
      this.log.warn(`pomodoro durumu yazılamadı: ${err.message}`);
    }
  }

  // Verilen tür için geçerli bir kayıt varsa startedAt, yoksa null.
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
    return state.startedAt;
  }
}

module.exports = { PomodoroStore };
