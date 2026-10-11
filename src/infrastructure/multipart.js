// Minimal multipart/form-data ayrıştırıcı (bağımlılık yok). Yalnızca /config/upload'ın
// tek dosyalık formu için: gövde bellekte (üst sınır çağıranda), Buffer olarak işlenir.
//
// Neden elle yazıldı: projede HTTP çatısı yok (node:http), tek bir dosya alanı için
// multer/busboy gibi bir bağımlılık eklemek orantısız. Sınırlı ve test edilebilir.
//
// Dönüş: [{ name, filename|null, data: Buffer }]. Bozuk/boş gövdede boş dizi — hata
// fırlatmaz, çağıran "dosya yok" der.
function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!m || !Buffer.isBuffer(body)) return [];
  const delimiter = Buffer.from(`--${m[1] || m[2]}`);
  const parts = [];

  let pos = body.indexOf(delimiter);
  while (pos !== -1) {
    const start = pos + delimiter.length;
    // "--" ile biten sınır: gövdenin sonu.
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    // Parça: CRLF + başlıklar + CRLF CRLF + veri + CRLF (sonraki sınırdan önceki).
    let part = body.subarray(start, next);
    if (part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      let data = part.subarray(headerEnd + 4);
      if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
        data = data.subarray(0, data.length - 2);
      }
      const disposition = /^content-disposition:[^\r\n]*$/im.exec(headers)?.[0] ?? '';
      const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
      const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
      if (name !== undefined) parts.push({ name, filename, data });
    }
    pos = next;
  }
  return parts;
}

module.exports = { parseMultipart };
