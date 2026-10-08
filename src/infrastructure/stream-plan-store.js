// Yayın planını ve preset'leri diske yazar/okur.
//
//   <runtime>/stream-plan.json        AKTİF plan — yayın süreci bunu okur
//   <runtime>/presets/<slug>.json     kaydedilmiş preset'ler (TUI'da listelenir)
//
// Neden runtime/ altında: plan MAKİNEYE özel (albüm adları, yerel dosya yolları) ve
// config.json ile aynı mantıkta git'e girmez. state.json/pomodoro.json ile aynı klasörde
// durması, çoklu yayında her instance'ın kendi runtime'ıyla kendi planını taşıması demek
// (instance-lock da aynı klasörü koruyor) — ayrıca bir "hangi plan hangi yayına ait"
// eşlemesi tutmak gerekmiyor.
//
// Okuma HER ZAMAN hatayı yutar ve null döner: bozuk ya da eksik bir plan dosyası yüzünden
// yayın BAŞLAMAMAZLIK etmemeli — plan yoksa mevcut (plansız) davranış geçerlidir.
// Yazma hatası ise yukarı iletilir: TUI "kaydedildi" derken sessizce kaybolmasın.
const fs = require('fs');
const path = require('path');
const { StreamPlan } = require('../domain/stream-plan');

const PLAN_FILE = 'stream-plan.json';
const PRESETS_DIR = 'presets';

// Preset adı → dosya adı. Türkçe karakterler ve boşluklar dosya adında sorun çıkarmasın;
// ad'ın kendisi dosyanın İÇİNDE (plan.name) tam haliyle duruyor, slug yalnızca adres.
function slugify(name) {
  const base = String(name).trim().toLowerCase()
    .replace(/[ğ]/g, 'g').replace(/[ü]/g, 'u').replace(/[ş]/g, 's')
    .replace(/[ı]/g, 'i').replace(/[ö]/g, 'o').replace(/[ç]/g, 'c')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'preset';
}

class StreamPlanStore {
  // runtimeDir: config.paths.runtime (mutlak); writeFile: atomik yazma; log: { info, warn }
  constructor({ runtimeDir, writeFile, log }) {
    this.planFile = path.join(runtimeDir, PLAN_FILE);
    this.presetsDir = path.join(runtimeDir, PRESETS_DIR);
    this.writeFile = writeFile;
    this.log = log;
  }

  // ── Aktif plan ───────────────────────────────────────────────

  // Geçerli bir plan varsa StreamPlan, yoksa null (plansız = mevcut davranış).
  loadActive() {
    return this.#read(this.planFile, 'aktif plan');
  }

  saveActive(plan) {
    const p = StreamPlan.from(plan);
    const json = { ...p.toJSON(), metadata: { ...p.metadata, savedAt: new Date().toISOString() } };
    this.writeFile(this.planFile, `${JSON.stringify(json, null, 2)}\n`);
    this.log.info(`aktif yayın planı yazıldı: ${this.planFile}`);
    return StreamPlan.from(json);
  }

  // ── Preset'ler ───────────────────────────────────────────────

  // [{ slug, plan }] — ada göre sıralı. Okunamayan dosya atlanır ve uyarılır.
  listPresets() {
    let names;
    try {
      names = fs.readdirSync(this.presetsDir).filter((f) => f.endsWith('.json'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`preset klasörü okunamadı: ${err.message}`);
      return [];
    }
    const out = [];
    for (const file of names) {
      const slug = file.replace(/\.json$/, '');
      const plan = this.#read(path.join(this.presetsDir, file), `preset "${slug}"`);
      if (plan) out.push({ slug, plan });
    }
    return out.sort((a, b) => a.plan.name.localeCompare(b.plan.name, 'tr'));
  }

  // Aynı slug varsa ÜZERİNE yazar: "Cozy Study 50/10" adını iki kez kaydetmek ikinci bir
  // kopya değil güncelleme anlamına gelir (TUI'da kullanıcı adı aynı yazarsa kastı bu).
  savePreset(plan) {
    const p = StreamPlan.from(plan);
    const slug = slugify(p.name);
    const file = path.join(this.presetsDir, `${slug}.json`);
    const json = {
      ...p.toJSON(),
      metadata: { ...p.metadata, savedAt: new Date().toISOString() },
    };
    this.writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
    this.log.info(`preset kaydedildi: ${p.name} (${file})`);
    return { slug, plan: StreamPlan.from(json) };
  }

  deletePreset(slug) {
    const file = path.join(this.presetsDir, `${slugify(slug)}.json`);
    try {
      fs.unlinkSync(file);
      this.log.info(`preset silindi: ${slug}`);
      return true;
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`preset silinemedi (${slug}): ${err.message}`);
      return false;
    }
  }

  // ── Dahili ───────────────────────────────────────────────────

  #read(file, label) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`${label} okunamadı: ${err.message}`);
      return null;
    }
    try {
      return StreamPlan.from(JSON.parse(text));
    } catch (err) {
      // Bozuk plan = plan yok. Yayın plansız başlar, sebebi logda durur.
      this.log.warn(`${label} kullanılamadı, yoksayılıyor: ${err.message}`);
      return null;
    }
  }
}

module.exports = { StreamPlanStore, slugify, PLAN_FILE, PRESETS_DIR };
