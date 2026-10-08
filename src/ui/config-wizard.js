// Yayın yapılandırma sihirbazının denetleyicisi (CJS, framework'süz).
//
// Ne YAPAR: adımları yönetir, tuşları aksiyona çevirir, taslak planı (draft) biriktirir ve
// sonunda StreamConfigService'e teslim eder. Ne YAPMAZ: yayın başlatmaz, dosya okumaz,
// ffmpeg çağırmaz, Ink'i tanımaz — hepsi servisin ve presenter'ın işi. Böylece tüm akış
// (arama, çoklu seçim, sıralama, geri dönme, özet) Ink olmadan test edilebilir.
//
// Görünüm modeli TEK ve GENEL bir biçimdedir (kind: list/checklist/order/form/summary/...)
// — presenter her adım için ayrı bileşen yazmak zorunda kalmasın, yeni adım eklemek
// yalnızca buraya dokunmak olsun.
//
// Akış (Pomodoro kapalıysa aradaki adımlar atlanır):
//   [preset] → cover → music → order → pomodoro → pomodoroType → [pomodoroCustom]
//            → studyVideo → breakVideo → summary → (apply | savePreset | edit | cancel)
const { EventEmitter } = require('events');
const {
  StreamPlan, DEFAULT_ROUNDS, DEFAULT_TYPE, pathIndex, summarizePlan,
} = require('../domain/stream-plan');
const { POMODORO_TYPES } = require('../domain/pomodoro');

// Liste öğesi değeri olarak "gerçek bir seçim değil, alt akış" işareti.
const CUSTOM = '__custom__';

// mm:ss / h:mm:ss — dashboard-view-model'deki biçimle aynı okunuşta tutuldu.
function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--';
  const whole = Math.floor(totalSeconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

// Uzun dosya yolunu listede okunur hale getirir: son iki bileşen ("mimi/break.mp4").
function shortPath(file) {
  return String(file).split(/[\\/]/).slice(-2).join('/');
}

function matches(text, query) {
  if (!query) return true;
  return String(text).toLowerCase().includes(query.toLowerCase());
}

// Taslak: StreamPlan'ın düz (donmamış) hali. Adımlar bunu değiştirir, sonunda StreamPlan'a
// çevrilir — doğrulama tek yerde (domain) kalsın.
function draftFromPlan(plan) {
  if (!plan) {
    return {
      name: 'adsız',
      cover: null,
      order: 'sequential',
      // Seçim: albüm adı → seçili parça yollarının SIRALI listesi.
      selection: new Map(),
      pomodoro: {
        enabled: false, type: DEFAULT_TYPE, rounds: DEFAULT_ROUNDS, studyVideo: null, breakVideo: null,
      },
    };
  }
  return {
    name: plan.name,
    cover: plan.cover,
    order: plan.music.order,
    selection: new Map(plan.music.albums.map((a) => [a.name, [...a.trackPaths]])),
    pomodoro: { ...plan.pomodoro },
  };
}

class ConfigWizard extends EventEmitter {
  // configService: StreamConfigService
  // library: { albums, covers, videos } — açılışta yüklenir (open())
  // basePlan: StreamPlan|null — "mevcut yapılandırmayla devam" için
  // mode: 'new' | 'restart'
  // onExit: (result) => void — sihirbaz kapanırken ({ started, cancelled, plan })
  // isRunning: () => boolean — restart menüsünün anlamlı olması için
  constructor({
    configService, mode = 'new', basePlan = null, onExit = () => {}, isRunning = () => false, log = null,
  }) {
    super();
    if (!configService) throw new Error('ConfigWizard: configService gerekli');
    this.configService = configService;
    this.mode = mode;
    this.basePlan = basePlan;
    this.onExit = onExit;
    this.isRunning = isRunning;
    this.log = log;

    // albums: [{ name, tracks, totalSeconds }]; clips/covers: mutlak yol dizileri
    this.library = { albums: [], clips: [], covers: [] };
    this.draft = draftFromPlan(basePlan);
    this.step = mode === 'restart' ? 'restart' : 'preset';
    this.cursor = 0;
    this.search = null; // null: arama kapalı; '' ya da metin: açık
    this.busy = null;
    this.error = null;
    this.notice = null;
    // Özetten "Edit" ile gelindiyse, düzenlenen adım bitince özete DÖN (baştan akmasın).
    this.returnToSummary = false;
    this.textInput = null; // { label, value, onSubmit, kind }
    this.formField = 0;
    this.closed = false;
  }

  // Kütüphaneyi yükler (albüm taraması ffprobe önbelleğinden gelir, hızlı).
  async open() {
    this.busy = 'kütüphane okunuyor…';
    this.emit('render');
    try {
      // Katalog üç ayrı çağrıdan toplanır (servisin sözleşmesi): albümler depodan,
      // kapaklar ve klip adayları dosya tarayıcıdan.
      const [albums, clips] = await Promise.all([
        this.configService.listAlbums(),
        this.configService.listClips(),
      ]);
      this.library = { albums, clips, covers: this.configService.listCovers() };
    } catch (err) {
      this.error = `kütüphane okunamadı: ${err.message}`;
    }
    this.busy = null;
    this.emit('render');
  }

  // ── Adım akışı ───────────────────────────────────────────────

  #flow() {
    const steps = ['cover', 'music', 'order', 'pomodoro'];
    if (this.draft.pomodoro.enabled) {
      steps.push('pomodoroType');
      // Serbest süre adımı yalnızca tür serbestse akışta. "|| this.step === ..." şart:
      // formda hazır bir süre (ör. 50+10) girilirse tür artık serbest değildir ve adım
      // akıştan düşer; o an üstünde DURDUĞUMUZ adım akışta olmazsa #advance "akışta
      // bulunamadı" sayıp en başa (cover) dönüyordu.
      if (!POMODORO_TYPES[this.draft.pomodoro.type] || this.step === 'pomodoroCustom') {
        steps.push('pomodoroCustom');
      }
      steps.push('studyVideo', 'breakVideo');
    }
    steps.push('summary');
    return steps;
  }

  #goto(step) {
    this.step = step;
    this.cursor = this.#initialCursor(step);
    this.search = null;
    this.error = null;
    this.formField = 0;
    this.emit('render');
  }

  #advance() {
    if (this.returnToSummary && this.step !== 'pomodoro' && this.step !== 'pomodoroType') {
      this.returnToSummary = false;
      this.#goto('summary');
      return;
    }
    const flow = this.#flow();
    const i = flow.indexOf(this.step);
    // Akışta olmayan adım (preset, restart) → akışın başı.
    this.#goto(i === -1 ? flow[0] : flow[Math.min(i + 1, flow.length - 1)]);
  }

  #back() {
    if (this.textInput) { this.textInput = null; this.emit('render'); return; }
    if (this.search !== null) { this.search = null; this.emit('render'); return; }
    if (this.returnToSummary) { this.returnToSummary = false; this.#goto('summary'); return; }
    const flow = this.#flow();
    const i = flow.indexOf(this.step);
    if (i > 0) { this.#goto(flow[i - 1]); return; }
    if (this.step === 'summary') { this.#goto(flow[flow.length - 2]); return; }
    // İlk adımda geri = çıkış.
    this.cancel();
  }

  // İmleci anlamlı bir yerden başlat: mevcut seçim neredeyse orada.
  #initialCursor(step) {
    const items = this.#rawItems(step);
    const i = items.findIndex((it) => it.current);
    return i > 0 ? i : 0;
  }

  // ── Seçim yardımcıları ───────────────────────────────────────

  get #selectedPaths() {
    const set = new Set();
    for (const paths of this.draft.selection.values()) for (const p of paths) set.add(p);
    return set;
  }

  // Seçili parçalar: [{ albumName, path, title, durationSeconds }] — plandaki SIRADA.
  #selectedTracks() {
    // Eşleştirme motor tarafıyla AYNI kuralla (pathIndex): preset'ten ya da elle
    // düzenlenmiş bir plandan gelen ileri bölülü yollar da bulunur.
    const all = this.library.albums.flatMap(
      (album) => album.tracks.map((t) => ({ ...t, albumName: album.name })),
    );
    const findTrack = pathIndex(all, (t) => t.path);
    const out = [];
    for (const [albumName, paths] of this.draft.selection) {
      for (const p of paths) {
        // Diskte bulunamayan parça listede yine görünür (kullanıcı ne seçtiğini görsün)
        // ama süresi bilinmez ve yayına çıkmaz — depo onu atlar.
        out.push(findTrack(p) || { path: p, title: shortPath(p), durationSeconds: 0, albumName });
      }
    }
    return out;
  }

  #toggleTrack(albumName, trackPath) {
    const paths = this.draft.selection.get(albumName) || [];
    const i = paths.indexOf(trackPath);
    if (i === -1) paths.push(trackPath);
    else paths.splice(i, 1);
    if (paths.length) this.draft.selection.set(albumName, paths);
    else this.draft.selection.delete(albumName);
  }

  // Ekranda GÖRÜNEN (arama süzgecinden geçen) parçaların hepsini seç / hepsini bırak.
  #toggleVisible() {
    const items = this.#visibleItems();
    const tracks = items.filter((it) => it.track);
    if (!tracks.length) return;
    const allSelected = tracks.every((it) => it.checked);
    for (const it of tracks) {
      const has = (this.draft.selection.get(it.albumName) || []).includes(it.value);
      if (allSelected && has) this.#toggleTrack(it.albumName, it.value);
      else if (!allSelected && !has) this.#toggleTrack(it.albumName, it.value);
    }
  }

  #moveSelected(delta) {
    const tracks = this.#selectedTracks();
    const from = this.cursor;
    const to = from + delta;
    if (from < 0 || to < 0 || from >= tracks.length || to >= tracks.length) return;
    const moving = tracks[from];
    const target = tracks[to];
    // Sıralama albüm İÇİNDE yapılır: bir playlist tek albümden oluşuyor (AlbumQueue),
    // yani albümler arası global sıra yayına yansımaz — kullanıcıyı yanıltmamak için
    // farklı albümlere taşımaya izin verilmez.
    if (moving.albumName !== target.albumName) return;
    const paths = this.draft.selection.get(moving.albumName);
    const i = paths.indexOf(moving.path);
    const j = paths.indexOf(target.path);
    if (i === -1 || j === -1) return;
    [paths[i], paths[j]] = [paths[j], paths[i]];
    this.cursor = to;
  }

  // ── Adım içerikleri (ham: süzülmemiş) ────────────────────────

  #rawItems(step = this.step) {
    switch (step) {
      case 'restart':
        return [
          { value: 'current', label: 'Restart with current configuration', hint: this.basePlan ? `plan: ${this.basePlan.name}` : 'plan yok — config.json ayarları' },
          { value: 'new', label: 'Restart with new configuration', hint: 'yapılandırmayı baştan seç' },
          { value: 'cancel', label: 'Cancel', hint: 'hiçbir şey değişmesin' },
        ];
      case 'preset': {
        const items = [];
        if (this.basePlan) {
          items.push({ value: 'active', label: `Mevcut planla devam — ${this.basePlan.name}`, hint: 'son kullanılan yapılandırma', current: true });
        }
        for (const { slug, plan } of this.configService.listPresets()) {
          items.push({
            value: `preset:${slug}`,
            label: plan.name,
            hint: `${plan.usesWholeLibrary ? 'tüm kütüphane' : `${plan.selectedTrackCount} parça`}`
              + ` · pomodoro ${plan.pomodoro.enabled ? plan.pomodoro.type : 'kapalı'}`,
          });
        }
        items.push({ value: 'blank', label: 'Yeni yapılandırma…', hint: 'sıfırdan başla' });
        return items;
      }
      case 'cover': {
        const items = this.library.covers.map((file) => ({
          value: file, label: shortPath(file), current: file === this.draft.cover,
        }));
        items.push({ value: CUSTOM, label: 'custom file…', hint: 'dosya yolunu yaz' });
        items.push({ value: null, label: '(kapak değiştirilmesin)', hint: 'config.json\'daki kalır', current: this.draft.cover === null });
        return items;
      }
      case 'music': {
        const selected = this.#selectedPaths;
        const items = [];
        for (const album of this.library.albums) {
          items.push({
            value: `album:${album.name}`,
            label: album.name,
            hint: `${album.tracks.length} parça · ${formatDuration(album.totalSeconds)}`,
            header: true,
            albumName: album.name,
          });
          for (const t of album.tracks) {
            items.push({
              value: t.path,
              label: t.title,
              hint: formatDuration(t.durationSeconds),
              track: true,
              albumName: album.name,
              checked: selected.has(t.path),
            });
          }
        }
        return items;
      }
      case 'order':
        return this.#selectedTracks().map((t, i) => ({
          value: t.path,
          label: t.title,
          hint: `${t.albumName} · ${formatDuration(t.durationSeconds)}`,
          number: i + 1,
        }));
      case 'pomodoro':
        return [
          { value: true, label: 'Yes', hint: 'STUDY/BREAK döngüsü, bipler, mola görüntüsü', current: this.draft.pomodoro.enabled },
          { value: false, label: 'No', hint: 'normal yayın akışı', current: !this.draft.pomodoro.enabled },
        ];
      case 'pomodoroType': {
        const items = Object.entries(POMODORO_TYPES).map(([key, v]) => ({
          value: key,
          label: `${v.studyMinutes} min study / ${v.breakMinutes} min break`,
          hint: key,
          current: this.draft.pomodoro.type === key,
        }));
        items.push({
          value: CUSTOM,
          label: 'Custom',
          hint: 'süreleri ve tur sayısını kendim gireyim',
          current: !POMODORO_TYPES[this.draft.pomodoro.type],
        });
        return items;
      }
      case 'studyVideo':
      case 'breakVideo': {
        const field = step === 'studyVideo' ? 'studyVideo' : 'breakVideo';
        const items = this.library.clips.map((file) => ({
          value: file, label: shortPath(file), hint: 'klip', current: file === this.draft.pomodoro[field],
        }));
        // Görseller de kabul: açılışta Ken Burns klibine çevrilir (bkz. clip-normalizer).
        for (const file of this.library.covers) {
          items.push({ value: file, label: shortPath(file), hint: 'görsel', current: file === this.draft.pomodoro[field] });
        }
        items.push({ value: CUSTOM, label: 'custom…', hint: 'dosya yolunu yaz' });
        items.push({
          value: null,
          label: step === 'studyVideo' ? '(albümün kendi arkaplanı)' : '(molada arkaplan değişmesin)',
          hint: 'mevcut davranış',
          current: this.draft.pomodoro[field] === null,
        });
        return items;
      }
      case 'summary':
        return [
          { value: 'start', label: 'START STREAM', hint: this.isRunning() ? 'yayını bu planla yeniden başlat' : 'yayını bu planla başlat' },
          { value: 'edit', label: 'Edit', hint: 'bir adıma geri dön' },
          { value: 'save', label: 'Save Configuration', hint: 'preset olarak kaydet' },
          { value: 'cancel', label: 'Cancel', hint: 'değişiklikleri at' },
        ];
      case 'edit':
        return [
          { value: 'cover', label: 'Cover' },
          { value: 'music', label: 'Music' },
          { value: 'order', label: 'Order' },
          { value: 'pomodoro', label: 'Pomodoro' },
          ...(this.draft.pomodoro.enabled ? [
            { value: 'pomodoroType', label: 'Pomodoro mode' },
            { value: 'studyVideo', label: 'Study video' },
            { value: 'breakVideo', label: 'Break video' },
          ] : []),
          { value: 'summary', label: '← özete dön' },
        ];
      default:
        return [];
    }
  }

  #visibleItems() {
    const items = this.#rawItems();
    if (this.search === null || this.search === '') return items;
    const q = this.search;
    if (this.step === 'music') {
      // Albüm adı eşleşirse albümün tamamı görünür; yoksa yalnızca eşleşen parçalar ve
      // (varsa) onların başlığı. Altında parça kalmayan başlık listeden düşer.
      const keep = new Set();
      for (const item of items) {
        if (!item.track) continue;
        if (matches(item.albumName, q) || matches(item.label, q)) keep.add(item);
      }
      const albumsWithHits = new Set([...keep].map((it) => it.albumName));
      return items.filter((it) => (it.header ? albumsWithHits.has(it.albumName) : keep.has(it)));
    }
    return items.filter((it) => matches(it.label, q) || matches(it.hint || '', q));
  }

  // ── Girdi ────────────────────────────────────────────────────

  handleInput(input, key = {}) {
    if (this.closed) return undefined;
    this.notice = null;
    if (key.ctrl && (input === 'c' || key.name === 'c')) return this.cancel();
    if (this.busy) return undefined; // uygulama sürerken tuşlar yoksayılır

    if (this.textInput) return this.#handleText(input, key);
    if (this.step === 'pomodoroCustom') return this.#handleForm(input, key);

    // Arama açıkken harfler sorguya gider; gezinme tuşları yine çalışır.
    if (this.search !== null && !key.escape && !key.return && !key.upArrow && !key.downArrow
        && !key.pageUp && !key.pageDown && !key.tab) {
      if (key.backspace || key.delete) {
        this.search = this.search.slice(0, -1);
        this.cursor = 0;
        this.emit('render');
        return undefined;
      }
      if (input && input.length === 1 && input !== ' ') {
        this.search += input;
        this.cursor = 0;
        this.emit('render');
        return undefined;
      }
    }

    if (key.escape) { this.#back(); return undefined; }

    const items = this.#visibleItems();
    const last = Math.max(0, items.length - 1);
    if (key.upArrow) {
      if (key.shift && this.step === 'order') this.#moveSelected(-1);
      else this.cursor = this.cursor <= 0 ? last : this.cursor - 1;
      this.emit('render');
      return undefined;
    }
    if (key.downArrow) {
      if (key.shift && this.step === 'order') this.#moveSelected(1);
      else this.cursor = this.cursor >= last ? 0 : this.cursor + 1;
      this.emit('render');
      return undefined;
    }
    if (key.pageUp) { this.cursor = Math.max(0, this.cursor - 10); this.emit('render'); return undefined; }
    if (key.pageDown) { this.cursor = Math.min(last, this.cursor + 10); this.emit('render'); return undefined; }

    const ch = String(input || '');
    // Arama 'order' adiminda KAPALI: orada imlec dogrudan secim listesinin indeksi,
    // suzulmus bir liste uzerinde tasima/cikarma yanlis parcayi hedefler.
    if (ch === '/' && this.search === null && this.step !== 'order') {
      this.search = '';
      this.cursor = 0;
      this.emit('render');
      return undefined;
    }

    if (this.step === 'music') {
      if (ch === ' ') { this.#toggleCursor(items); return undefined; }
      // "Görünenlerin hepsini seç": Tab ve (arama kapalıyken) 'a'. Tab gerekiyor çünkü
      // arama açıkken harfler sorguya gider — "yagmur yaz, hepsini seç" akışının tek
      // tuşu o. Arama kapalıyken 'a' daha akılda kalıcı olduğu için ikisi de kabul.
      if (key.tab || (this.search === null && ch.toLowerCase() === 'a')) {
        this.#toggleVisible();
        this.emit('render');
        return undefined;
      }
    }
    if (this.step === 'order') {
      if (ch === 'K') { this.#moveSelected(-1); this.emit('render'); return undefined; }
      if (ch === 'J') { this.#moveSelected(1); this.emit('render'); return undefined; }
      if (ch === 'x' || key.delete) { this.#removeAtCursor(items); return undefined; }
      if (ch.toLowerCase() === 'm') {
        this.draft.order = this.draft.order === 'sequential' ? 'shuffle' : 'sequential';
        this.emit('render');
        return undefined;
      }
    }

    if (key.return) return this.#confirm(items[this.cursor]);
    return undefined;
  }

  #toggleCursor(items) {
    const item = items[this.cursor];
    if (!item) return;
    if (item.header) {
      // Başlıkta space: o albümün TÜM parçaları.
      const album = this.library.albums.find((a) => a.name === item.albumName);
      if (album) {
        const selected = this.draft.selection.get(album.name) || [];
        const all = selected.length === album.tracks.length;
        if (all) this.draft.selection.delete(album.name);
        else this.draft.selection.set(album.name, album.tracks.map((t) => t.path));
      }
    } else if (item.track) {
      this.#toggleTrack(item.albumName, item.value);
    }
    this.emit('render');
  }

  // İmlecin üstündeki parçayı seçimden çıkarır. Yol üzerinden bulunur (arama açıkken
  // görünen liste ile seçim listesi aynı indekste olmaz).
  #removeAtCursor(items) {
    const item = items[this.cursor];
    if (!item) return;
    const owner = this.#selectedTracks().find((t) => t.path === item.value);
    if (owner) this.#toggleTrack(owner.albumName, owner.path);
    this.cursor = Math.max(0, Math.min(this.cursor, this.#selectedTracks().length - 1));
    this.emit('render');
  }

  #confirm(item) {
    if (!item) {
      // Boş listede Enter: ilerle (ör. hiç kapak yoksa).
      if (this.step !== 'summary') this.#advance();
      return undefined;
    }
    switch (this.step) {
      case 'restart':
        if (item.value === 'cancel') return this.cancel();
        // "Mevcut yapılandırmayla": plan DOSYAYA YENİDEN YAZILMAZ, yalnızca yayın
        // yeniden başlatılır. Yazmak, hiç plan dosyası olmayan bir kurulumda (config.json
        // ayarlarıyla çalışan VPS) sırf restart yüzünden plan dosyası yaratmak olurdu.
        if (item.value === 'current') return this.#restartOnly();
        this.#goto('cover');
        return undefined;
      case 'preset': {
        if (item.value === 'blank') this.draft = draftFromPlan(null);
        else if (item.value === 'active') this.draft = draftFromPlan(this.basePlan);
        else {
          const slug = String(item.value).slice('preset:'.length);
          const preset = this.configService.loadPreset(slug);
          if (preset) this.draft = draftFromPlan(preset);
        }
        this.#advance();
        return undefined;
      }
      case 'cover':
        if (item.value === CUSTOM) return this.#askPath('Kapak dosyası', 'cover', (file) => { this.draft.cover = file; });
        this.draft.cover = item.value;
        this.#advance();
        return undefined;
      case 'music':
        // Enter = bu adımı bitir (space seçer). Hiç seçim yoksa tüm kütüphane demektir.
        this.#advance();
        return undefined;
      case 'order':
        this.#advance();
        return undefined;
      case 'pomodoro': {
        const was = this.draft.pomodoro.enabled;
        this.draft.pomodoro.enabled = item.value === true;
        // Özetten "Edit → Pomodoro" ile gelip AÇILDIYSA, yeni adımları atlamamak için
        // akışa devam edilir (returnToSummary bırakılır).
        if (!was && this.draft.pomodoro.enabled) this.returnToSummary = false;
        this.#advance();
        return undefined;
      }
      case 'pomodoroType':
        if (item.value === CUSTOM) {
          // Form O ANKİ sürelerle açılır: hazır türden geliyorsa onun dakikaları,
          // zaten serbest bir türdeysek (45+15) kendi dakikaları. Eskiden serbest tür
          // yeniden düzenlenirken 50/10'a dönüyordu.
          this.customForm = { ...this.#currentDurations() };
          this.#goto('pomodoroCustom');
          return undefined;
        }
        this.draft.pomodoro.type = item.value;
        this.#advance();
        return undefined;
      case 'studyVideo':
        if (item.value === CUSTOM) return this.#askPath('Study videosu', 'video', (f) => { this.draft.pomodoro.studyVideo = f; });
        this.draft.pomodoro.studyVideo = item.value;
        this.#advance();
        return undefined;
      case 'breakVideo':
        if (item.value === CUSTOM) return this.#askPath('Break videosu', 'video', (f) => { this.draft.pomodoro.breakVideo = f; });
        this.draft.pomodoro.breakVideo = item.value;
        this.#advance();
        return undefined;
      case 'summary':
        if (item.value === 'start') return this.#applyDraft();
        if (item.value === 'edit') { this.#goto('edit'); return undefined; }
        if (item.value === 'save') return this.#askPresetName();
        return this.cancel();
      case 'edit':
        if (item.value === 'summary') { this.#goto('summary'); return undefined; }
        this.returnToSummary = true;
        this.#goto(item.value);
        return undefined;
      default:
        return undefined;
    }
  }

  // ── Serbest metin girdisi (dosya yolu / preset adı) ──────────

  #askPath(label, kind, assign) {
    this.textInput = {
      label,
      value: '',
      kind,
      onSubmit: (value) => {
        const result = this.configService.inspectPath(value, kind === 'cover' ? 'cover' : 'video');
        if (!result.ok) { this.error = result.reason; return false; }
        assign(result.file.path);
        return true;
      },
    };
    this.emit('render');
    return undefined;
  }

  #askPresetName() {
    this.textInput = {
      label: 'Preset adı',
      value: this.draft.name === 'adsız' ? '' : this.draft.name,
      kind: 'text',
      onSubmit: (value) => {
        const name = value.trim();
        if (!name) { this.error = 'ad boş olamaz'; return false; }
        this.draft.name = name;
        try {
          const { plan } = this.configService.savePreset(this.#buildPlan());
          this.notice = `preset kaydedildi: ${plan.name}`;
        } catch (err) {
          this.error = `preset kaydedilemedi: ${err.message}`;
          return false;
        }
        return true;
      },
    };
    this.emit('render');
    return undefined;
  }

  #handleText(input, key) {
    const ti = this.textInput;
    if (key.escape) { this.textInput = null; this.error = null; this.emit('render'); return undefined; }
    if (key.return) {
      this.error = null;
      const ok = ti.onSubmit(ti.value);
      if (ok) {
        this.textInput = null;
        // Yol girişi bir adımın cevabıydı → ilerle. Preset adı özette kalır.
        if (ti.kind !== 'text') this.#advance();
        else this.emit('render');
      } else {
        this.emit('render');
      }
      return undefined;
    }
    if (key.backspace || key.delete) { ti.value = ti.value.slice(0, -1); this.emit('render'); return undefined; }
    if (input && !key.ctrl && !key.meta) { ti.value += input; this.emit('render'); }
    return undefined;
  }

  // ── Serbest süre formu ───────────────────────────────────────

  #handleForm(input, key) {
    if (!this.customForm) this.customForm = { ...this.#currentDurations() };
    const fields = ['study', 'break', 'rounds'];
    if (key.escape) { this.#back(); return undefined; }
    if (key.upArrow) { this.formField = (this.formField + fields.length - 1) % fields.length; this.emit('render'); return undefined; }
    if (key.downArrow || key.tab) { this.formField = (this.formField + 1) % fields.length; this.emit('render'); return undefined; }
    if (key.backspace || key.delete) {
      const f = fields[this.formField];
      this.customForm[f] = this.customForm[f].slice(0, -1);
      this.emit('render');
      return undefined;
    }
    if (key.return) {
      const study = Number(this.customForm.study);
      const brk = Number(this.customForm.break);
      const rounds = Number(this.customForm.rounds);
      if (!Number.isInteger(study) || study <= 0 || !Number.isInteger(brk) || brk <= 0) {
        this.error = 'çalışma ve mola süresi pozitif tam sayı (dakika) olmalı';
        this.emit('render');
        return undefined;
      }
      if (!Number.isInteger(rounds) || rounds <= 0) {
        this.error = 'tur sayısı pozitif tam sayı olmalı';
        this.emit('render');
        return undefined;
      }
      this.error = null;
      // Serbest süre de tür metnine yazılır ("45+15") — ikinci bir alan yok.
      this.draft.pomodoro.type = `${study}+${brk}`;
      this.draft.pomodoro.rounds = rounds;
      this.#advance();
      return undefined;
    }
    if (/^[0-9]$/.test(String(input || ''))) {
      const f = fields[this.formField];
      if (this.customForm[f].length < 3) this.customForm[f] += input;
      this.emit('render');
    }
    return undefined;
  }

  // Taslaktaki türün dakikaları, form alanları için metin olarak. Hazır tür de serbest
  // tür de aynı gösterimden ("<calisma>+<mola>") çözülür — tek kaynak.
  #currentDurations() {
    const type = this.draft.pomodoro.type;
    const preset = POMODORO_TYPES[type];
    const [study, brk] = preset
      ? [preset.studyMinutes, preset.breakMinutes]
      : String(type).split('+').map(Number);
    return {
      study: String(Number.isFinite(study) ? study : 50),
      break: String(Number.isFinite(brk) ? brk : 10),
      rounds: String(this.draft.pomodoro.rounds ?? DEFAULT_ROUNDS),
    };
  }

  // ── Plan üretimi ve uygulama ─────────────────────────────────

  #buildPlan() {
    return StreamPlan.from({
      name: this.draft.name,
      cover: this.draft.cover,
      music: {
        order: this.draft.order,
        albums: [...this.draft.selection.entries()].map(([name, trackPaths]) => ({ name, trackPaths })),
      },
      pomodoro: this.draft.pomodoro,
    });
  }

  // Planı değiştirmeden yeniden başlat.
  async #restartOnly() {
    this.busy = 'yayın yeniden başlatılıyor…';
    this.error = null;
    this.emit('render');
    try {
      const result = await this.configService.restart();
      this.busy = null;
      this.closed = true;
      this.emit('render');
      this.onExit({ started: true, plan: result ? result.plan : this.basePlan, warnings: [] });
    } catch (err) {
      this.busy = null;
      this.error = `yeniden başlatılamadı: ${err.message}`;
      this.emit('render');
    }
    return undefined;
  }

  async #applyDraft() {
    const plan = this.#buildPlan();
    this.busy = 'hazırlanıyor…';
    this.error = null;
    this.emit('render');
    try {
      const result = await this.configService.applyAndRestart(plan, {
        onProgress: (msg) => { this.busy = msg; this.emit('render'); },
      });
      this.busy = null;
      this.closed = true;
      this.emit('render');
      this.onExit({ started: true, plan: result.plan, warnings: result.warnings });
    } catch (err) {
      this.busy = null;
      this.error = `başlatılamadı: ${err.message}`;
      this.emit('render');
    }
    return undefined;
  }

  cancel() {
    if (this.closed) return undefined;
    this.closed = true;
    this.emit('render');
    this.onExit({ started: false, cancelled: true, plan: null });
    return undefined;
  }

  // ── Görünüm modeli ───────────────────────────────────────────

  getViewModel() {
    const items = this.#visibleItems();
    const cursor = Math.max(0, Math.min(this.cursor, Math.max(0, items.length - 1)));
    const meta = STEP_META[this.step] || { title: this.step, kind: 'list' };
    const vm = {
      step: this.step,
      title: meta.title,
      hint: typeof meta.hint === 'function' ? meta.hint(this) : meta.hint,
      kind: meta.kind,
      items: items.map((it, i) => ({
        label: it.label,
        hint: it.hint || null,
        header: Boolean(it.header),
        checked: it.checked === true,
        checkable: Boolean(it.track || it.header),
        current: it.current === true,
        number: it.number ?? null,
        selected: i === cursor,
      })),
      cursor,
      search: this.search,
      busy: this.busy,
      error: this.error,
      notice: this.notice,
      textInput: this.textInput ? { label: this.textInput.label, value: this.textInput.value } : null,
      form: this.step === 'pomodoroCustom' ? this.#formViewModel() : null,
      summary: this.step === 'summary' ? this.summaryLines() : null,
      footer: this.#footer(),
    };
    return vm;
  }

  #formViewModel() {
    const f = this.customForm || { study: '50', break: '10', rounds: String(DEFAULT_ROUNDS) };
    const fields = [
      { label: 'Study duration', value: f.study, unit: 'min' },
      { label: 'Break duration', value: f.break, unit: 'min' },
      { label: 'Number of rounds', value: f.rounds, unit: '' },
    ];
    return fields.map((field, i) => ({ ...field, focused: i === this.formField }));
  }

  // Özet ekranının satırları — "LIVE STREAM CONFIG".
  //
  // Parça sayısı ve toplam süre domain'deki summarizePlan'dan gelir; StreamConfigService
  // de AYNI işlevi çağırıyor. Böylece ekranda yazan süre ile loga/servise düşen süre tek
  // hesaptan çıkıyor — iki ayrı toplama bir gün birbirinden ayrılırdı.
  summaryLines() {
    const summary = summarizePlan(this.#buildPlan(), this.library.albums);
    const tracks = this.#selectedTracks();
    const p = this.draft.pomodoro;
    const short = (v) => (v ? shortPath(v) : null);
    const lines = [
      { label: 'Cover', value: short(this.draft.cover) || '(değişmeyecek)' },
    ];
    if (summary.usesWholeLibrary) {
      lines.push({ label: 'Music', value: `tüm kütüphane (${summary.trackCount} parça, seçim yapılmadı)` });
    } else {
      lines.push({
        label: 'Music',
        value: `${summary.trackCount} parça / ${summary.albums.length} albüm`,
        list: tracks.slice(0, 12).map((t, i) => `${i + 1}. ${t.title}`)
          .concat(tracks.length > 12 ? [`… +${tracks.length - 12} parça`] : []),
      });
    }
    lines.push({ label: 'Total Music', value: formatDuration(summary.totalSeconds) });
    lines.push({ label: 'Order', value: this.draft.order === 'shuffle' ? 'shuffle' : 'seçtiğim sıra' });
    lines.push({ label: 'Pomodoro', value: p.enabled ? 'YES' : 'NO' });
    if (p.enabled) {
      const resolved = POMODORO_TYPES[p.type] || (() => {
        const [s, b] = p.type.split('+').map(Number);
        return { studyMinutes: s, breakMinutes: b };
      })();
      lines.push({ label: 'Study', value: `${resolved.studyMinutes} min` });
      lines.push({ label: 'Break', value: `${resolved.breakMinutes} min` });
      // Tur sayısı 7/24 yayında döngüyü BİTİRMEZ (yayın sonsuz akar); planda bilgi olarak
      // durur ve logda görünür. Döngü duvar saatine bağlı olduğu için tur sınırı koymak
      // yayını durdurmak anlamına gelirdi — bilinçli olarak yapılmıyor.
      lines.push({ label: 'Rounds', value: `${p.rounds} (bilgi — yayın 7/24 akar)` });
      lines.push({ label: 'Study Video', value: short(p.studyVideo) || '(albümün arkaplanı)' });
      lines.push({ label: 'Break Video', value: short(p.breakVideo) || '(arkaplan değişmez)' });
      lines.push({ label: 'Transitions', value: 'geçiş öncesi 3 uyarı bipi (mevcut sistem)' });
    }
    return lines;
  }

  #footer() {
    if (this.textInput) return [{ key: 'Enter', label: 'onayla' }, { key: 'Esc', label: 'vazgeç' }];
    if (this.step === 'pomodoroCustom') {
      return [{ key: '0-9', label: 'yaz' }, { key: '↑↓', label: 'alan' }, { key: 'Enter', label: 'devam' }, { key: 'Esc', label: 'geri' }];
    }
    const base = [{ key: '↑↓', label: 'gez' }];
    if (this.step === 'music') {
      base.push(
        { key: 'Space', label: 'seç' },
        { key: this.search === null ? 'a/Tab' : 'Tab', label: 'görünenleri seç' },
        { key: '/', label: 'ara' },
        { key: 'Enter', label: 'devam' },
      );
    } else if (this.step === 'order') {
      base.push({ key: 'Shift+↑↓', label: 'taşı' }, { key: 'x', label: 'çıkar' }, { key: 'm', label: `sıra: ${this.draft.order}` }, { key: 'Enter', label: 'devam' });
    } else {
      base.push({ key: 'Enter', label: 'seç' }, { key: '/', label: 'ara' });
    }
    base.push({ key: 'Esc', label: 'geri' });
    return base;
  }
}

const STEP_META = {
  restart: { title: 'RESTART STREAM', kind: 'list', hint: 'yayın çalışıyor — nasıl yeniden başlatılsın?' },
  preset: { title: 'PRESETS', kind: 'list', hint: 'kayıtlı bir yapılandırmadan başla ya da sıfırdan kur' },
  cover: { title: 'SELECT COVER', kind: 'list', hint: 'yayının küçük resmi (YouTube broadcast thumbnail)' },
  music: {
    title: 'SELECT MUSIC',
    kind: 'checklist',
    hint: (w) => {
      const n = w.draft.selection.size ? [...w.draft.selection.values()].reduce((a, b) => a + b.length, 0) : 0;
      return n ? `Selected: ${n}` : 'seçim yapılmazsa TÜM kütüphane çalar';
    },
  },
  order: { title: 'ORDER', kind: 'order', hint: 'albüm içindeki çalma sırası (Shift+↑↓ taşır)' },
  pomodoro: { title: 'ENABLE POMODORO?', kind: 'list', hint: 'kapalıysa normal yayın akışı sürer' },
  pomodoroType: { title: 'POMODORO MODE', kind: 'list', hint: 'çalışma/mola süresi' },
  pomodoroCustom: { title: 'CUSTOM POMODORO', kind: 'form', hint: 'dakika cinsinden' },
  studyVideo: { title: 'STUDY VIDEO', kind: 'list', hint: 'çalışma fanında gösterilecek görüntü' },
  breakVideo: { title: 'BREAK VIDEO', kind: 'list', hint: 'molada gösterilecek görüntü' },
  summary: { title: 'LIVE STREAM CONFIG', kind: 'summary', hint: 'son kontrol' },
  edit: { title: 'EDIT', kind: 'list', hint: 'hangi adıma dönülsün?' },
};

module.exports = { ConfigWizard, formatDuration, shortPath, STEP_META };
