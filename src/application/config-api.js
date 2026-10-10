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

  // Form açılışında gösterilecek veri: mevcut plan + klip adayları.
  async form() {
    const plan = this.configService.currentPlan();
    const clips = await this.configService.listClips();
    return { plan, clips };
  }

  /**
   * fields: { pomodoroEnabled: boolean, pomodoroType: string, studyVideos: string[],
   *           breakVideos: string[], restart: boolean }
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

    // music/cover/metadata KORUNUR — form onlara hiç dokunmuyor (v1'de müzik seçimi web
    // formunda yok, bkz. PLAN-yapilandirma-ui.md Faz N2 "Açık karar").
    const plan = current.with({
      pomodoro: {
        enabled,
        type: type || current.pomodoro.type,
        rounds: current.pomodoro.rounds,
        studyVideos,
        breakVideos,
      },
    });

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
