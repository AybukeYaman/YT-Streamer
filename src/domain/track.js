// Tek bir parça: dosya yolu, başlık (dosya adından, uzantısız), süre (sn).
// Saf veri nesnesi — I/O yok, Node modülü import etmez.

class TrackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrackError';
  }
}

// path modülü olmadan: son / ya da \'dan sonrası, son noktadan öncesi.
function titleFromPath(filePath) {
  const base = filePath.split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

class Track {
  constructor({ path, durationSeconds }) {
    if (typeof path !== 'string' || path.trim() === '') throw new TrackError(`geçersiz parça yolu (${path})`);
    if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new TrackError(`süre pozitif olmalı (${path}: ${durationSeconds})`);
    }
    this.path = path;
    this.title = titleFromPath(path);
    this.durationSeconds = durationSeconds;
    Object.freeze(this);
  }
}

module.exports = { Track, TrackError };
