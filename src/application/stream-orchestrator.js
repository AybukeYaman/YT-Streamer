// Yayını yöneten beyin. Encoder'ı sadece Encoder sözleşmesi üzerinden kullanır —
// child_process'i, ffmpeg'i ya da dosya sistemini bilmez (Faz 7'de infrastructure değişince
// burası aynı kalır).
//
// B yaklaşımı (KARARLAR.md, Faz 3.1): uzun bir playlist yazılır, encoder playlist modunda
// başlar; playlist bitince encoder code=0 ile kapanır, orchestrator kuyruğun kaldığı yerden
// yeni playlist yazıp encoder'ı hemen yeniden başlatır.
//
// Süreç tamamen ölürse (kill, elektrik) bellekteki kuyruk gider; o hal için çalan playlist'in
// konumu stateStore ile diske yazılır ve start() onu okuyup kaldığı parçadan devam eder.
//
// code !== 0 (gerçek çökme) burada ele alınmaz: loglanır, 'exit' (expected=false) yayılır.
// Yeniden başlatma kararı (üstel geri çekilme, crash loop koruması) Supervisor'da; o da
// resume() ile kaldığı yerden devam ettirir.
//
// Olaylar:
//   'exit' ({ expected, code, signal }) — yayın durdu; expected=false ise stop() istenmeden
const { EventEmitter } = require('events');
const { AlbumQueue } = require('./album-queue');
const { PlaybackTimeline } = require('../domain/playback-timeline');
const { PlaylistWriter } = require('./playlist-writer');

const PROGRESS_LOG_INTERVAL_MS = 5000;

// ffmpeg ham stderr'i çoğunlukla bilgi amaçlı (debug → sadece dosya). Ama çıkış/bağlantı
// hataları operatör için kritik: bu satırlar WARN olarak da yayılır ki TUI panelinde görünsün
// (ör. RTMP reddi: "Error opening output ... I/O error"). Yayın davranışı değişmez.
const CRITICAL_FFMPEG_STDERR = /error opening output|i\/o error|not authorized|connection (refused|reset|timed out)|conversion failed|no such file or directory|invalid data found|error in the pull function|end of file|broken pipe|unable to open|could not (write|open)|server (error|returned)/i;

const minutes = (s) => `${(s / 60).toFixed(1)} dk`;

class StreamOrchestrator extends EventEmitter {
  // encoder: Encoder sözleşmesi; log: { debug, info, warn, error }
  // albumRepository: { list(): Promise<Album[]> } — her playlist tek albüm; arkaplan albümle değişir
  // queue: { mode, batchSize }; playlistPath: mutlak yol; writeFile: atomik yazma
  // nowPlayingWriter: { writeAll(titles): string[] } — verilirse (overlay açık) her playlist'te
  // parça başlıkları yazılır ve encoder'a parça başına zaman aralığıyla verilir
  constructor({
    encoder, log, albumRepository, queue, playlistPath, writeFile,
    nowPlayingWriter = null, speedWindow = null, speedAlarm = null, stateStore = null,
    backgroundPlaylistWriter = null,
    now = () => Date.now(), random = Math.random,
  }) {
    super();
    // speedWindow: SpeedWindow — anlık hızın 30 sn pencere ortalaması; eşik dışına çıkınca
    // uyarı loglanır (sadece görünürlük, otomatik aksiyon yok)
    this.speedWindow = speedWindow;
    // speedAlarm: SpeedAlarm — aynı durumu bildirime çevirir (eşik dışında bir süre kalınırsa
    // telefona alarm). Verilmezse davranış eskisi gibi: yalnızca log.
    this.speedAlarm = speedAlarm;
    this.speedState = 'warming';
    this.encoder = encoder;
    this.log = log;
    this.albumRepository = albumRepository;
    this.queueOptions = queue;
    this.playlistPath = playlistPath;
    this.writeFile = writeFile;
    this.nowPlayingWriter = nowPlayingWriter;
    // backgroundPlaylistWriter: BackgroundPlaylistWriter — verilmezse rotasyon hiç denenmez,
    // her albüm tek arkaplanla oynar (eski davranış).
    this.backgroundPlaylistWriter = backgroundPlaylistWriter;
    // stateStore: { save(state), load() } — verilirse süreç ölümünden sonra kaldığı yerden devam
    this.stateStore = stateStore;
    this.now = now;
    this.random = random;

    this.running = false;
    this.stopping = false;
    // stopRequested: "kapanış istendi" — stopping'den AYRI tutulur. stopping her
    // start()/resume() başında false'a çekiliyor (yeni tur başlıyor anlamında), o yüzden
    // uçuştaki bir start'ı iptal etmek için kullanılamaz: sinyal silinir. Bu alan yalnızca
    // stop() ile set edilir, bir sonraki start()/resume() girişinde temizlenir.
    this.stopRequested = false;
    // startInFlight: start()/resume()'un uçuştaki promise'i (album yükleme ~10-15 sn sürer;
    // ffprobe parça başına sıralı çalışıyor). stop() bunu bekler ki kapanış, yükleme bitip
    // ffmpeg spawn edilmeden ÖNCE değil, o karar verildikten SONRA tamamlansın.
    this.startInFlight = null;
    this.runNumber = 0;
    this.playlistWriter = null;
    this.lastProgressLog = -Infinity;
    this.restartStartedAt = null; // önceki ffmpeg'in kapandığı an; ilk frame gelince boşluk ölçülür
    this.restartGapsMs = [];
    this.currentTracks = null; // çalan playlist'in parçaları (çökme sonrası kaldığı yer için)
    this.currentAlbum = null; // çalan playlist'in albümü (çökme sonrası aynı arkaplanla devam)
    this.playStartedAt = null; // bu playlist'in ilk karesinin geldiği an
    this.crashedAt = null;

    this.encoder.on('log', (entry) => this.#onEncoderLog(entry));
    this.encoder.on('exit', (code, signal) => this.#onEncoderExit(code, signal));
  }

  async start() {
    if (this.running) throw new Error('StreamOrchestrator zaten çalışıyor');
    this.running = true;
    this.stopping = false;
    this.stopRequested = false;
    return this.#trackStart(async () => {
      const albums = await this.albumRepository.list();
      // Album yükleme uzun sürer (ffprobe parça başına, sıralı: 264 parçada ~12 sn).
      // O pencerede stop() gelmişse ffmpeg'i HİÇ başlatmamalıyız.
      if (this.#cancelStartIfRequested('albüm yükleme')) return;
      const queue = new AlbumQueue({ albums, mode: this.queueOptions.mode, random: this.random });
      this.playlistWriter = new PlaylistWriter({
        queue, batchSize: this.queueOptions.batchSize, playlistPath: this.playlistPath, writeFile: this.writeFile,
      });
      const trackCount = albums.reduce((n, a) => n + a.tracks.length, 0);
      this.log.info(`yayın başlıyor: ${albums.length} albüm, ${trackCount} parça, mod=${queue.mode}, ` +
        `batchSize=${this.queueOptions.batchSize}`);
      const restored = this.#restoredPlaylist(albums);
      this.#startNextPlaylist(restored?.playlist, restored?.note ?? '');
    });
  }

  // Çökme sonrası yeniden başlatma (Supervisor çağırır). Kuyruk korunur; yarım kalan
  // playlist o an çalan parçadan itibaren yeniden yazılır — o parça baştan çalar ama
  // kalan parçalar atlanmaz (batchSize=50'de onlarca parça kaybolurdu).
  // Hiç başlamamışsa (start() de düştüyse) sıfırdan start().
  async resume() {
    if (this.running) throw new Error('StreamOrchestrator zaten çalışıyor');
    if (!this.playlistWriter) return this.start();
    this.running = true;
    this.stopping = false;
    this.stopRequested = false;
    return this.#trackStart(async () => {
      if (this.#cancelStartIfRequested('yeniden başlatma')) return;
      const remaining = this.#remainingTracks();
      this.#startNextPlaylist(
        remaining && this.playlistWriter.write(remaining, this.currentAlbum),
        remaining ? ' (kaldığı parçadan devam)' : '',
      );
    });
  }

  // Kapanış. stopRequested ÖNCE set edilir: uçuşta bir start()/resume() varsa onu bekler,
  // böylece kapanış "tamamlandı" derken yükleme bitip ffmpeg spawn edilmesi imkânsız olur.
  //
  // Neden gerekli (30 Eylül 2026, KARARLAR.md): eskiden stop() encoder'da çocuk süreç
  // yoksa (album yükleme sürerken) anında resolve oluyordu. index.js "temiz kapanış
  // tamamlandı" yazıyor, ama uçuştaki start() yüklemeyi bitirip ffmpeg'i başlatıyor ve
  // süreç yayına giriyordu; shuttingDown=true olduğu için sonraki sinyaller de yok
  // sayılıyor, systemd TimeoutStopSec'i dolup node'u SIGKILL ediyordu.
  async stop() {
    this.stopRequested = true;
    if (this.startInFlight) {
      this.log.info('başlatma sürüyor — kapanış onu bekliyor (ffmpeg başlatılmayacak)');
      await this.startInFlight.catch(() => {}); // başlatma hatası kapanışı bozmasın
    }
    if (!this.running) return;
    this.stopping = true;
    this.log.info('yayın durduruluyor');
    await this.encoder.stop();
  }

  // start()/resume() gövdesini sarar: uçuştaki promise'i stop()'un beklemesi için tutar,
  // hata halinde running'i eski davranışta olduğu gibi false'a çeker ve hatayı yukarı iletir.
  #trackStart(body) {
    const promise = (async () => {
      try {
        await body();
      } catch (err) {
        this.running = false;
        throw err;
      } finally {
        // Yalnızca kendi kaydını temizler: araya yeni bir start girmişse ona dokunmaz.
        if (this.startInFlight === promise) this.startInFlight = null;
      }
    })();
    this.startInFlight = promise;
    return promise;
  }

  // Uçuşta iken stop() geldiyse: ffmpeg başlatılmaz, yayın başlamamış sayılır.
  // 'exit' expected=true ile yayılır — supervisor bunu çökme sanıp yeniden başlatmasın.
  #cancelStartIfRequested(phase) {
    if (!this.stopRequested) return false;
    this.log.warn(`başlatma iptal edildi: kapanış istendi (${phase} sırasında) — ffmpeg başlatılmadı`);
    this.#finish({ expected: true, code: null, signal: null });
    return true;
  }

  // Dış okuyucular (StreamControlService, TUI, Web UI) için çalma durumu snapshot'ı.
  // Mevcut akışa müdahale etmez, salt okunur kopya döner — iç property'lere doğrudan
  // bağımlılık yerine bu kullanılır.
  getPlaybackState() {
    return Object.freeze({
      running: this.running,
      stopping: this.stopping,
      // Kapanış istendi ama henüz encoder'a gelmedi (start uçuşta olabilir). UI bu aralıkta
      // "restarting" değil "stopped" göstersin — yayın bir daha başlamayacak.
      stopRequested: this.stopRequested,
      runNumber: this.runNumber,
      currentTracks: this.currentTracks,
      currentAlbum: this.currentAlbum,
      playStartedAt: this.playStartedAt,
    });
  }

  // Çöken playlist'te çökme anında çalan parça ve sonrası. Konum duvar saatinden (ilk
  // karenin geldiği andan çökmeye) — speed ≈ 1x olduğu için parça seçmeye yeter.
  #remainingTracks() {
    if (!this.currentTracks) return null;
    const elapsed = this.playStartedAt === null ? 0 : (this.crashedAt - this.playStartedAt) / 1000;
    return this.currentTracks.slice(new PlaybackTimeline(this.currentTracks).indexAt(elapsed));
  }

  // Diskteki durumdan (varsa) yarım kalan playlist'i kurtarır: aynı albüm, o an çalan parçadan
  // itibaren kalanlar. Albüm ya da parçalar artık yoksa (klasör silinmiş, yeniden hazırlanmış)
  // vazgeçilir — yayın normal kuyruktan başlar, durum uğruna yayın geciktirilmez.
  #restoredPlaylist(albums) {
    const state = this.stateStore?.load();
    if (!state) return null;
    const album = albums.find((a) => a.name === state.album);
    if (!album) {
      this.log.warn(`kayıtlı durum kullanılamadı: albüm "${state.album}" artık yok`);
      return null;
    }
    const byPath = new Map(album.tracks.map((t) => [t.path, t]));
    const tracks = state.trackPaths.map((p) => byPath.get(p));
    if (tracks.some((t) => !t)) {
      this.log.warn(`kayıtlı durum kullanılamadı: "${album.name}" albümünün bazı parçaları artık yok`);
      return null;
    }
    const remaining = tracks.slice(new PlaybackTimeline(tracks).indexAt(state.elapsedSeconds));
    return {
      playlist: this.playlistWriter.write(remaining, album),
      note: ` (kayıtlı durumdan devam: ${minutes(state.elapsedSeconds)} oynamış, ${remaining.length}/${tracks.length} parça kaldı)`,
    };
  }

  // Çalan playlist ve içindeki konum. Konum duvar saatinden (ilk kare → şimdi); ffmpeg'in
  // ilerlemesiyle aynı tempoda (speed ≈ 1x) olduğu için parça seçmeye yeter.
  #saveState(elapsedSeconds) {
    if (!this.stateStore || !this.currentTracks) return;
    this.stateStore.save({
      album: this.currentAlbum.name,
      trackPaths: this.currentTracks.map((t) => t.path),
      elapsedSeconds,
    });
  }

  #startNextPlaylist(playlist = this.playlistWriter.writeNext(), note = '') {
    // Son çıkış kapısı: ffmpeg'i spawn eden TEK yer burası, o yüzden guard da burada
    // tekrarlanıyor. Çağrı yolları (start, resume, playlist bitişinde yeniden başlatma)
    // ileride çoğalsa bile kapanış istenmişken yeni süreç doğmasın.
    if (this.stopRequested) {
      this.log.warn('yeni playlist başlatılmadı: kapanış istendi');
      return;
    }
    this.runNumber++;
    this.currentTracks = playlist.tracks;
    this.currentAlbum = playlist.album;
    this.playStartedAt = null;
    this.speedWindow?.reset(this.now()); // yeni süreç: ilk 30 sn pencereye girmez
    this.speedState = 'warming';
    this.log.info(
      `playlist #${this.runNumber}${note}: albüm "${playlist.album.name}", ${playlist.tracks.length} parça, ` +
      `${minutes(playlist.totalDurationSeconds)} — ` +
      playlist.tracks.map((t) => t.title).join(' | '),
    );
    this.#saveState(0); // yeni playlist: konum sıfırlanır (ilk kare gelmeden ölürse baştan)
    const overlayTexts = this.nowPlayingWriter ? this.#writeOverlayTexts(playlist.tracks) : undefined;
    // Arkaplan rotasyonu: albümde birden çok klip varsa concat listesi yazılır ve encoder
    // tek dosya yerine onu okur. Tek arkaplanlı albümde writer null döner → eski yol.
    const rotation = this.backgroundPlaylistWriter?.write(playlist.album) ?? null;
    if (rotation) {
      this.log.info(
        `arkaplan rotasyonu: ${rotation.backgroundCount} klip, ${rotation.lineCount} satır`,
      );
    }
    this.encoder.start({
      playlistPath: playlist.path,
      runNumber: this.runNumber,
      ...(rotation
        ? { backgroundPlaylistPath: rotation.path }
        : { backgroundPath: playlist.album.backgroundPath }),
      ...(overlayTexts && { overlayTexts }),
    });
  }

  // Başlık dosyalarını yazar, her birini parçanın zaman aralığıyla eşler. Zamanlama ffmpeg'de
  // (drawtext enable, video zaman damgası t) — Node tarafında frame takibi yok.
  #writeOverlayTexts(tracks) {
    const segments = new PlaybackTimeline(tracks).segments();
    const files = this.nowPlayingWriter.writeAll(tracks.map((t) => t.title));
    return segments.map(({ start, end }, i) => ({ textFile: files[i], start, end }));
  }

  // ffmpeg'in ham stderr'i sadece dosyaya (debug); ilerleme ~2/sn geldiği için 5 sn'de bir.
  #onEncoderLog(entry) {
    switch (entry.kind) {
      case 'command':
        this.log.info(`ffmpeg başlatılıyor: ${entry.args.join(' ')}`);
        break;
      case 'progress':
        if (this.playStartedAt === null && entry.frame > 0) this.playStartedAt = this.now();
        if (this.restartStartedAt !== null && entry.frame > 0) {
          const gap = this.now() - this.restartStartedAt;
          this.restartStartedAt = null;
          this.restartGapsMs.push(gap);
          this.log.info(`restart boşluğu: ${gap} ms (önceki ffmpeg'in kapanışından yeni sürecin ilk frame'ine)`);
        }
        const speed = this.#checkSpeed(entry.frame);
        if (this.now() - this.lastProgressLog < PROGRESS_LOG_INTERVAL_MS) return;
        this.lastProgressLog = this.now();
        // Durum da bu tempoda (5 sn) yazılır: ölüm anıyla kayıt arası fark en fazla bir tik.
        this.#saveState(this.playStartedAt === null ? 0 : (this.now() - this.playStartedAt) / 1000);
        // speed= ffmpeg'in süreç başından ortalaması; hız(30sn) bizim pencere ortalamamız.
        const windowed = speed?.average == null ? 'ısınıyor' : `${speed.average.toFixed(3)}x`;
        this.log.info(`frame=${entry.frame} fps=${entry.fps} bitrate=${entry.bitrateKbps}kbps speed=${entry.speed}x hız(30sn)=${windowed}`);
        break;
      case 'stderr':
        // Kritik çıkış/bağlantı hataları panelde görünsün diye WARN; gerisi sadece dosyaya (debug).
        if (CRITICAL_FFMPEG_STDERR.test(entry.line)) this.log.warn(`ffmpeg: ${entry.line}`);
        else this.log.debug(entry.line);
        break;
      case 'error':
        this.log.error(entry.message);
        break;
    }
  }

  // Pencereyi günceller; durum değiştiğinde (her satırda değil) uyarı/bilgi loglar.
  #checkSpeed(frame) {
    if (!this.speedWindow) return null;
    const now = this.now();
    this.speedWindow.add(frame, now);
    const status = this.speedWindow.status(now);
    const { low, high } = this.speedWindow;
    // Alarm HER satırda beslenir (durum değişiminde değil): bekleme penceresi zamanın
    // ilerlemesiyle dolduğu için "60 sn'dir yavaş" ancak böyle anlaşılır. Eşikler status'a
    // eklenir — SpeedAlarm'ın ikinci bir yapılandırma kaynağı olmasın.
    this.speedAlarm?.update({ ...status, low, high }, now);
    if (status.state !== this.speedState && status.state !== 'warming') {
      const avg = `${status.average.toFixed(3)}x`;
      if (status.state === 'slow') this.log.warn(`encode yetişemiyor: hız(30sn)=${avg} < ${low}`);
      else if (status.state === 'fast') this.log.warn(`anormal hız, sessiz arıza olabilir: hız(30sn)=${avg} > ${high}`);
      else if (this.speedState !== 'warming') this.log.info(`hız normale döndü: hız(30sn)=${avg}`);
      this.speedState = status.state;
    }
    return status;
  }

  #onEncoderExit(code, signal) {
    const message = `ffmpeg kapandı (code=${code}, signal=${signal})`;
    this.crashedAt = this.now();

    if (this.stopping) {
      this.log.info(message);
      this.#finish({ expected: true, code, signal });
      return;
    }

    if (code === 0) {
      // Beklenen playlist bitişi (-shortest) — kuyruğun kaldığı yerden devam et.
      this.log.info(`${message} — playlist #${this.runNumber} bitti, yeniden başlatılıyor`);
      this.restartStartedAt = this.now();
      try {
        this.#startNextPlaylist();
      } catch (err) {
        this.log.error(`yeniden başlatılamadı: ${err.message}`);
        this.#finish({ expected: false, code, signal });
      }
      return;
    }

    this.log.error(`${message} — beklenmeyen kapanış (yeniden başlatma kararı supervisor'da)`);
    this.#finish({ expected: false, code, signal });
  }

  #finish(result) {
    this.running = false;
    this.stopping = false;
    this.restartStartedAt = null;
    this.emit('exit', result);
  }
}

module.exports = { StreamOrchestrator };
