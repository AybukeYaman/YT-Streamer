// TUI denetleyicisi (CJS, framework'süz). UI state'i yönetir, ControlService'den veri okur,
// klavyeyi aksiyonlara çevirir, LogBuffer'ı LogViewport ile görüntüler. Stream engine'in iç
// detaylarına dokunmaz — komutlar ControlService'e, scroll LogViewport'a gider.
//
// Render katmanı Ink'tir (ESM). CJS'den ESM'e köprü: open() sırasında dynamic import ile
// './ink-app.mjs' yüklenip mount edilir. importApp enjekte edilebilir → Ink olmadan test.
//
// İKİ EKRAN, TEK MOUNT: normalde pano (dashboard) görünür; [C] ile yayın yapılandırma
// sihirbazı (ConfigWizard) aynı Ink ağacında onun YERİNE basılır. Sihirbaz kendi
// denetleyicisidir; buradaki tek iş, aktif ekranı seçmek ve tuşları ona yönlendirmek.
// Böylece ikinci bir Ink örneği (ve ikinci bir raw-mode sahibi) doğmaz.
const { EventEmitter } = require('events');
const { LogViewport } = require('./log-viewport');
const { buildViewModel, computeLogHeight } = require('./dashboard-view-model');
const { mapKey } = require('./keymap');
const { ConfigWizard } = require('./config-wizard');

class StreamTui extends EventEmitter {
  // controlService: getStatus/getCurrentTrack/getUpcomingQueue/start/restart(/stop)
  // logBuffer: { entries: Array, recent(limit) } — LOG paneli kaynağı
  // onQuit: quit/Ctrl+C'de çağrılır (uygulamanın normal shutdown lifecycle'ı)
  // importApp: () => Promise<{ mount(controller) -> { unmount() } }> (test için enjekte)
  constructor({
    controlService, logBuffer, onQuit,
    // configService: StreamConfigService — verilmezse [C] tuşu çalışmaz ve pano
    // bugünküyle birebir aynı davranır (sihirbaz tamamen opsiyonel bir katman).
    configService = null,
    createWizard = (opts) => new ConfigWizard(opts),
    out = process.stdout, input = process.stdin,
    now = () => Date.now(), refreshMs = 1000, queueLimit = 10,
    createInterval = setInterval, destroyInterval = clearInterval,
    importApp = () => import('./ink-app.mjs'),
  }) {
    super();
    if (!controlService) throw new Error('StreamTui: controlService gerekli');
    this.controlService = controlService;
    this.configService = configService;
    this.createWizard = createWizard;
    this.wizard = null; // null: pano görünür; doluysa sihirbaz görünür
    this.logBuffer = logBuffer && Array.isArray(logBuffer.entries) ? logBuffer : { entries: [], recent: () => [] };
    this.onQuit = typeof onQuit === 'function' ? onQuit : () => {};
    this.out = out;
    this.input = input;
    this.now = now;
    this.refreshMs = refreshMs;
    this.queueLimit = queueLimit;
    this.createInterval = createInterval;
    this.destroyInterval = destroyInterval;
    this.importApp = importApp;

    this.viewport = new LogViewport({ height: computeLogHeight(out && out.rows) });
    this.opened = false;
    this.timer = null;
    this.app = null;
    this._onResize = () => this.emit('render');
  }

  async open() {
    if (this.opened) return;
    this.opened = true;
    if (this.out && typeof this.out.on === 'function') this.out.on('resize', this._onResize);
    // 1 sn'lik tazeleme: uptime/progress/log akışını canlı tutar.
    this.timer = this.createInterval(() => this.emit('render'), this.refreshMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    const mod = await this.importApp();
    if (!this.opened) return; // open sırasında close çağrıldıysa mount etme
    this.app = mod.mount(this);
  }

  // Idempotent: birden çok çağrı güvenli. Ink unmount terminali (raw mode, imleç) geri yükler.
  close() {
    if (!this.opened) return;
    this.opened = false;
    if (this.timer) { this.destroyInterval(this.timer); this.timer = null; }
    if (this.out && typeof this.out.removeListener === 'function') this.out.removeListener('resize', this._onResize);
    if (this.app && typeof this.app.unmount === 'function') this.app.unmount();
    this.app = null;
    this.wizard = null;
  }

  // Ink useInput → buraya iletir. Aksiyona çevirip dağıtır. Async komutlar Promise döndürür.
  handleInput(input, key = {}) {
    // Sihirbaz açıkken TÜM tuşlar ona gider: Ctrl+C dahil (sihirbaz onu kendi iptali
    // olarak ele alır, yayını düşürmez). Pano kısayolları (S/R/Q) o sırada devre dışı —
    // yapılandırma yarım bırakılmış bir anda yayına komut gitmesi istenmez.
    if (this.wizard) return this.wizard.handleInput(input, key);
    const action = mapKey(input, key);
    if (!action) return undefined;
    return this.dispatch(action);
  }

  dispatch(action) {
    const total = this.logBuffer.entries.length;
    switch (action) {
      case 'start': return this.#command('start', 'Başlat');
      case 'restart': return this.#command('restart', 'Yeniden başlat');
      case 'configure': return this.openWizard();
      case 'quit': return this.quit();
      case 'log-up': this.viewport.lineUp(total); break;
      case 'log-down': this.viewport.lineDown(total); break;
      case 'page-up': this.viewport.pageUp(total); break;
      case 'page-down': this.viewport.pageDown(total); break;
      case 'live': this.viewport.toLive(); break;
      default: return undefined;
    }
    this.emit('render');
    return undefined;
  }

  // [C] — yayın yapılandırma sihirbazını açar. Yayın çalışıyorsa 'restart' kipinde
  // açılır (önce "mevcut planla mı, yeni planla mı?" sorulur), durmuşsa doğrudan
  // yapılandırma akışı başlar.
  async openWizard() {
    if (this.wizard) return;
    if (!this.configService) {
      this.#note('yapılandırma servisi kurulmadı — [C] devre dışı');
      return;
    }
    const running = this.controlService.getStatus().state !== 'stopped';
    this.wizard = this.createWizard({
      configService: this.configService,
      mode: running ? 'restart' : 'new',
      basePlan: this.configService.planProvider(),
      isRunning: () => this.controlService.getStatus().state !== 'stopped',
      onExit: (result) => this.#closeWizard(result),
    });
    this.wizard.on('render', () => this.emit('render'));
    this.emit('render'); // sihirbaz hemen görünsün (kütüphane okunurken "busy")
    await this.wizard.open();
  }

  #closeWizard(result = {}) {
    this.wizard = null;
    if (result.started) {
      this.#note(`yayın yeni yapılandırmayla başlatıldı: ${result.plan?.name ?? 'plan'}`);
      for (const w of result.warnings || []) this.#note(`uyarı: ${w}`);
    } else if (result.cancelled) {
      this.#note('yapılandırma iptal edildi');
    }
    this.emit('render');
  }

  // Panonun LOG bölmesine tek satır: sihirbazın sonucu kaybolmasın.
  // LogBuffer console arayüzünü uyguluyor (log = info, error = warn/error) — bilgi
  // satırları 'log'a gider, yoksa 'error'a düşülür (eski sahte tamponlar için).
  #note(message) {
    const line = `[tui] ${message}`;
    if (typeof this.logBuffer.log === 'function') this.logBuffer.log(line);
    else if (typeof this.logBuffer.error === 'function') this.logBuffer.error(line);
  }

  quit() { this.onQuit(); }

  async #command(method, label) {
    try {
      await this.controlService[method]();
    } catch (err) {
      // Hata LOG paneline düşer (amber). Engine'e dokunmaz.
      if (typeof this.logBuffer.error === 'function') this.logBuffer.error(`[tui] ${label}: ${err.message}`);
    }
    this.emit('render');
  }

  // Ink presenter'ın basacağı görünüm modeli. Her çağrıda yükseklik (resize) yeniden
  // hesaplanır. screen alanı hangi ekranın basılacağını söyler ('dashboard' | 'wizard').
  getViewModel() {
    const rows = (this.out && this.out.rows) || 24;
    const columns = (this.out && this.out.columns) || 80;
    if (this.wizard) {
      return { screen: 'wizard', rows, columns, wizard: this.wizard.getViewModel() };
    }
    this.viewport.setHeight(computeLogHeight(rows));

    const total = this.logBuffer.entries.length;
    const win = this.viewport.view(total);
    const logLines = this.logBuffer.entries.slice(win.start, win.end);

    // screen alanı dışarıdan eklenir: buildViewModel saf kalır, ekran seçimi UI'nın işi.
    return {
      screen: 'dashboard',
      ...buildViewModel({
        status: this.controlService.getStatus(),
        track: this.controlService.getCurrentTrack(),
        queue: this.controlService.getUpcomingQueue(this.queueLimit),
        logLines,
        live: win.live,
        queueLimit: this.queueLimit,
        columns,
      }),
    };
  }
}

module.exports = { StreamTui };
