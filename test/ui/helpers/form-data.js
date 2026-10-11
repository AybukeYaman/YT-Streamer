// Test yardımcısı: üretilen HTML'deki formların TARAYICININ varsayılan olarak göndereceği
// alan/değer çiftlerini çıkarır (işaretli radyo/onay kutusu, metin değerleri, textarea,
// seçili option; pasif ve düğme alanları hariç). Gerçek DOM yok — config-page.js'in
// ürettiği sınırlı biçim için regex yeterli (özellik değerlerinde ham ">" basılmaz: esc()).
//
// Amaç: yeniden tasarımın form verisini ESKİ sürümle eşdeğer gönderdiğini sınamak
// (bkz. config-page.form-golden.json — eski sürümden alınan altın örnekler).

const unesc = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function attrsOf(tag) {
  const attrs = {};
  const body = tag.replace(/^<\/?[\w-]+/, '');
  for (const m of body.matchAll(/\s([\w:-]+)(?:="([^"]*)")?/g)) attrs[m[1]] = m[2] === undefined ? true : unesc(m[2]);
  return attrs;
}

function extractForms(html) {
  const forms = [];
  const byId = new Map();
  const stack = [];
  const tagRe = /<(\/?)(form|input|textarea|select|option)\b[^>]*>/g;
  let m;
  let select = null;
  let match;
  while ((match = tagRe.exec(html))) {
    const [tag, closing, name] = match;
    m = { tag, closing: Boolean(closing), name };
    if (name === 'form') {
      if (m.closing) { stack.pop(); continue; }
      const a = attrsOf(tag);
      const form = { id: a.id ?? null, method: String(a.method ?? 'get').toLowerCase(), action: a.action ?? '', entries: [] };
      forms.push(form);
      if (form.id) byId.set(form.id, form);
      stack.push(form);
      continue;
    }
    const owner = (a) => (a.form ? byId.get(a.form) : stack[stack.length - 1]);
    if (name === 'select') {
      if (m.closing) {
        if (select && select.owner) {
          const chosen = select.options.find((o) => o.selected) ?? select.options[0];
          if (chosen) select.owner.entries.push([select.name, chosen.value]);
        }
        select = null;
      } else {
        const a = attrsOf(tag);
        select = { name: a.name, owner: a.disabled ? null : owner(a), options: [] };
      }
      continue;
    }
    if (name === 'option') {
      if (!m.closing && select) {
        const a = attrsOf(tag);
        select.options.push({ value: a.value ?? '', selected: Boolean(a.selected) });
      }
      continue;
    }
    if (name === 'textarea') {
      if (m.closing) continue;
      const a = attrsOf(tag);
      const end = html.indexOf('</textarea>', tagRe.lastIndex);
      const text = unesc(html.slice(tagRe.lastIndex, end));
      const o = owner(a);
      if (o && a.name && !a.disabled) o.entries.push([a.name, text]);
      tagRe.lastIndex = end + '</textarea>'.length;
      continue;
    }
    // input
    const a = attrsOf(tag);
    const type = String(a.type ?? 'text').toLowerCase();
    const o = owner(a);
    if (!o || !a.name || a.disabled) continue;
    if (['submit', 'button', 'image', 'reset'].includes(type)) continue;
    if (type === 'checkbox' || type === 'radio') {
      if (a.checked) o.entries.push([a.name, a.value === undefined || a.value === true ? 'on' : a.value]);
    } else if (type === 'file') {
      o.entries.push([a.name, '<file>']);
    } else {
      o.entries.push([a.name, a.value === undefined || a.value === true ? '' : a.value]);
    }
  }
  return forms;
}

// Karşılaştırma için kanonik biçim: form sırası ve alanlar arası sıra önemsiz; aynı adlı
// alanların kendi içindeki sırası (studyVideos çoklu değeri) korunur (kararlı sıralama).
function canonicalForms(html) {
  return extractForms(html)
    .filter((f) => f.entries.length > 0)
    .map((f) => {
      const entries = f.entries
        .map((e, i) => ({ e, i }))
        .sort((x, y) => (x.e[0] < y.e[0] ? -1 : x.e[0] > y.e[0] ? 1 : x.i - y.i))
        .map((x) => x.e);
      return JSON.stringify({ method: f.method, action: f.action, entries });
    })
    .sort();
}

module.exports = { extractForms, canonicalForms, unesc };
