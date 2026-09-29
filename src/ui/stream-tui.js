// TUI denetleyicisi (CJS, framework'süz). UI state'i yönetir, ControlService'den veri okur,
// klavyeyi aksiyonlara çevirir, LogBuffer'ı LogViewport ile görüntüler. Stream engine'in iç
// detaylarına dokunmaz — komutlar ControlService'e, scroll LogViewport'a gider.
//
// Render katmanı Ink'tir (ESM). CJS'den ESM'e köprü: open() sırasında dynamic import ile
// './ink-app.mjs' yüklenip mount edilir. importApp enjekte edilebilir → Ink olmadan test.
const { EventEmitter } = require('events');
const { LogViewport } = require('./log-viewport');
const { buildViewModel, computeLogHeight } = require('./dashboard-view-model');
const { mapKey } = require('./keymap');

class StreamTui extends EventEmitter {
  // controlService: getStatus/getCurrentTrack/getUpcomingQueue/start/restart(/stop)
  // logBuffer: { entries: Array, recent(limit) } — LOG paneli kaynağı
  // onQuit: quit/Ctrl+C'de çağrılır (uygulamanın normal shutdown lifecycle'ı)
  // importApp: () => Promise<{ mount(controller) -> { unmount() } }> (test için enjekte)
  constructor({
    controlService, logBuffer, onQuit,
    out = process.stdout, input = process.stdin,
    now = () => Date.now(), refreshMs = 1000, queueLimit = 10,
    createInterval = setInterval, destroyInterval = clearInterval,
    importApp = () => import('./ink-app.mjs'),
  }) {
    super();
    if (!controlService) throw new Error('StreamTui: controlService gerekli');
    this.controlService = controlService;
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
  }

  // Ink useInput → buraya iletir. Aksiyona çevirip dağıtır. Async komutlar Promise döndürür.
  handleInput(input, key = {}) {
    const action = mapKey(input, key);
    if (!action) return undefined;
    return this.dispatch(action);
  }

  dispatch(action) {
    const total = this.logBuffer.entries.length;
    switch (action) {
      case 'start': return this.#command('start', 'Başlat');
      case 'restart': return this.#command('restart', 'Yeniden başlat');
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

  // Ink presenter'ın basacağı görünüm modeli. Her çağrıda yükseklik (resize) yeniden hesaplanır.
  getViewModel() {
    const rows = (this.out && this.out.rows) || 24;
    const columns = (this.out && this.out.columns) || 80;
    this.viewport.setHeight(computeLogHeight(rows));

    const total = this.logBuffer.entries.length;
    const win = this.viewport.view(total);
    const logLines = this.logBuffer.entries.slice(win.start, win.end);

    return buildViewModel({
      status: this.controlService.getStatus(),
      track: this.controlService.getCurrentTrack(),
      queue: this.controlService.getUpcomingQueue(this.queueLimit),
      logLines,
      live: win.live,
      queueLimit: this.queueLimit,
      columns,
    });
  }
}

module.exports = { StreamTui };
