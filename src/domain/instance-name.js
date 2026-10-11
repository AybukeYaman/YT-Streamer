// Ek yayın (instance) adı kuralı. Saf işlev: I/O yok. Ad dosya adına (config.<ad>.json,
// .env.<ad>), systemd birimine (yt-streamer@<ad>) ve klasör yoluna (runtime/<ad>/) girdiği
// için dar tutulur: ad kabuğa ya da yola kaçamaz. add-stream.sh'taki kuralla uyumlu
// (harf/rakam/-/_), ama küçük harfle sınırlı ve uzunluk sınırlı.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,19}$/;

// 'youtube' = ortak OAuth/kimlik dosyası (.env.youtube), 'example' şablon dosyaları
// (.env.youtube.example, config.example.json); bunlar örnek adı OLAMAZ.
const RESERVED = new Set(['youtube', 'example', 'default', 'main', 'config']);

function validInstanceName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !RESERVED.has(name);
}

module.exports = { validInstanceName, RESERVED };
