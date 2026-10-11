const test = require('node:test');
const assert = require('node:assert/strict');

const { parseMultipart } = require('../../src/infrastructure/multipart');

const BOUNDARY = '----WebKitFormBoundaryAbC123';
const CT = `multipart/form-data; boundary=${BOUNDARY}`;

function build(parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}\r\n`));
    if (p.type) chunks.push(Buffer.from(`Content-Type: ${p.type}\r\n`));
    chunks.push(Buffer.from('\r\n'), p.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

test('metin alanı ve dosya alanı ayrıştırılır', () => {
  const body = build([
    { name: 'a', data: Buffer.from('merhaba') },
    { name: 'coverFile', filename: 'foto.jpg', type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x0d, 0x0a, 0x2d, 0x2d]) },
  ]);
  const parts = parseMultipart(body, CT);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].name, 'a');
  assert.equal(parts[0].filename, null);
  assert.equal(parts[0].data.toString(), 'merhaba');
  assert.equal(parts[1].name, 'coverFile');
  assert.equal(parts[1].filename, 'foto.jpg');
  // İkili veri bozulmaz (CRLF ve "--" içeren baytlar dahil).
  assert.deepEqual([...parts[1].data], [0xff, 0xd8, 0xff, 0x00, 0x0d, 0x0a, 0x2d, 0x2d]);
});

test('tırnaklı boundary kabul edilir', () => {
  const body = build([{ name: 'x', data: Buffer.from('1') }]);
  assert.equal(parseMultipart(body, `multipart/form-data; boundary="${BOUNDARY}"`).length, 1);
});

test('boundary yok / gövde boş / Buffer değil: boş dizi, hata atmaz', () => {
  assert.deepEqual(parseMultipart(Buffer.from('x'), 'multipart/form-data'), []);
  assert.deepEqual(parseMultipart(Buffer.alloc(0), CT), []);
  assert.deepEqual(parseMultipart('metin', CT), []);
  assert.deepEqual(parseMultipart(Buffer.from('rastgele çöp'), CT), []);
});

test('boş dosya (seçilmemiş) data uzunluğu 0 döner', () => {
  const body = build([{ name: 'coverFile', filename: '', type: 'application/octet-stream', data: Buffer.alloc(0) }]);
  const [part] = parseMultipart(body, CT);
  assert.equal(part.name, 'coverFile');
  assert.equal(part.data.length, 0);
});
