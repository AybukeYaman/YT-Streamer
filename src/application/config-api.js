// Web formu (src/ui/config-page.js) ile StreamConfigService arasındaki köprü (Faz N2).
// HTML üretmez (sayfanın işi), HTTP de bilmez (golive-server.js'in işi) — yalnızca
// doğrulama ve servis çağrısı. Böylece ikisi de bu sınıfı test etmeden Ink'siz/http'siz
// sınanabilir (aynı ilke ConfigWizard'da da var).
//
// Katman kuralı: application, fs/child_process/infrastructure import ETMEZ. configService
// ve restartStream dışarıdan (composition root'tan) enjekte edilir.
const { resolvePomodoroType } = require('../domain/pomodoro');

class ConfigApi {
  // configService: StreamConfigService
  // restartStream: () => Promise<{ ok, message }> | null — verilmezse restart denenmez,
  //   kullanıcı restart istese bile plan kaydedilir, yalnızca devreye alınamaz.
  constructor({ configService, restartStream = null, log }) {
    this.configService = configService;
    this.restartStream = restartStream;
    this.log = log;
  }

  // Form açılışında gösterilecek veri: mevcut plan + klip adayları + kapak adayları.
  async form() {
    const plan = this.configService.currentPlan();
    const clips = await this.configService.listClips();
    return { plan, clips, covers: this.#covers() };
  }

  #covers() {
    return typeof this.configService.listCovers === 'function' ? this.configService.listCovers() : [];
  }

  /**
   * fields: { pomodoroEnabled: boolean, pomodoroType: string, studyVideos: string[],
   *           breakVideos: string[], title?: string, description?: string, cover?: string,
   *           restart: boolean }
   * title/description/cover VERİLMEZSE (undefined) mevcut değer korunur; boş metin
   * "config.json'daki varsayılan" demektir (plan alanı null olur).
   * @returns {Promise<{ ok: boolean, plan?: StreamPlan, warnings?: string[],
   *                      restarted?: boolean, restartError?: string|null, error?: string }>}
   */
  async save(fields) {
    const current = this.configService.currentPlan();
    const clips = await this.configService.listClips();
    const allowed = new Set(clips);

    // studyVideo/breakVideo yalnızca KLİP LİSTESİNDEKİ yollardan biri olabilir — rastgele
    // bir yol kabul EDİLMEZ, aksi halde form yol sızması/traversal'a açılırdı.
    const studyVideos = [...new Set(fields.studyVideos || [])];
    const breakVideos = [...new Set(fields.breakVideos || [])];
    const invalid = [...studyVideos, ...breakVideos].filter((v) => !allowed.has(v));
    if (invalid.length) {
      return { ok: false, error: `listede olmayan klip yolu reddedildi: ${invalid[0]}` };
    }

    const enabled = Boolean(fields.pomodoroEnabled);
    const type = (fields.pomodoroType || current.pomodoro.type || '').trim();
    if (enabled && !resolvePomodoroType(type)) {
      return { ok: false, error: `geçersiz pomodoro türü "${type}" — "<calisma>+<mola>" biçiminde olmalı (ornek "50+10")` };
    }

    // Kapak da klipler gibi YALNIZCA listedeki görsellerden biri olabilir. Mevcut kapak
    // listede olmasa bile (elle yazılmış yol) dokunulmadığı sürece korunur.
    let cover = current.cover;
    if (fields.cover !== undefined) {
      const wanted = String(fields.cover).trim();
      if (!wanted) cover = null;
      else if (wanted === current.cover || this.#covers().includes(wanted)) cover = wanted;
      else return { ok: false, error: `listede olmayan kapak yolu reddedildi: ${wanted}` };
    }

    const broadcast = { ...current.broadcast };
    if (fields.title !== undefined) broadcast.title = String(fields.title).trim() || null;
    if (fields.description !== undefined) {
      broadcast.description = String(fields.description).replace(/\r\n/g, '\n').trim() || null;
    }

    // music/metadata KORUNUR — form onlara hiç dokunmuyor (v1'de müzik seçimi web
    // formunda yok, bkz. PLAN-yapilandirma-ui.md Faz N2 "Açık karar").
    // Başlık/açıklama uzunluk sınırları StreamPlan'da doğrulanır; hata mesajı olduğu gibi gösterilir.
    let plan;
    try {
      plan = current.with({
        cover,
        broadcast,
        pomodoro: {
          enabled,
          type: type || current.pomodoro.type,
          rounds: current.pomodoro.rounds,
          studyVideos,
          breakVideos,
        },
      });
    } catch (err) {
      return { ok: false, error: err.problems ? err.problems.join('; ') : err.message };
    }

    let warnings;
    try {
      ({ warnings } = await this.configService.apply(plan));
    } catch (err) {
      return { ok: false, error: `plan kaydedilemedi: ${err.message}` };
    }

    let restarted = false;
    let restartError = null;
    if (fields.restart) {
      if (!this.restartStream) {
        restartError = 'bu sunucu yayını yeniden başlatamıyor — elle systemctl restart gerekir';
      } else {
        try {
          const result = await this.restartStream();
          restarted = Boolean(result && result.ok);
          if (!restarted) restartError = (result && result.message) || 'yeniden başlatma başarısız';
        } catch (err) {
          restartError = err.message;
        }
      }
    }
    return { ok: true, plan, warnings, restarted, restartError };
  }
}

module.exports = { ConfigApi };
