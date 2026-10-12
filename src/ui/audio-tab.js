// /config "Sesler" sekmesi: albüme ses ekleme (mp3, m4a, mp4/m4v..., zip ya da klasör).
// Dosyalar tek tek /config/audio'ya ham gövdeyle gider (büyük dosya belleğe alınmaz); sunucu m4a'ya çevirir.
// .zip tek istekle gider, sunucuda arka planda açılır; ilerleme /config/audio/status ile sorgulanır.
// Yalnızca JS varken çalışır (js-only): dosya yükleme ilerlemesi JS'siz gösterilemez.
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// albums: [{ name, trackCount }]
function audioTabHtml(albums) {
  const options = albums.map((a) => `<option value="${esc(a.name)}">${esc(a.name)} (${a.trackCount} parça)</option>`).join('');
  return `<div class="step js-only" id="step-audio" role="tabpanel" aria-labelledby="tab-audio"><section>
  <h2>Sesler</h2>
  <label class="lbl" for="aAlbum">Albüm</label>
  <select id="aAlbum">${options}</select>
  <div class="btnrow">
    <button type="button" class="secondary" id="aPickFiles">Dosya seç</button>
    <button type="button" class="secondary" id="aPickDir">Klasör seç</button>
  </div>
  <input type="file" id="aFiles" multiple accept="audio/*,video/*,.mp3,.m4a,.m4v,.mp4,.wav,.flac,.ogg,.zip" hidden>
  <input type="file" id="aDir" webkitdirectory multiple hidden>
  <p class="hint" id="aInfo">mp3, m4a, mp4/m4v, wav, flac ya da zip. Sunucuda m4a'ya çevrilir. Yayın, yeni parçaları bir sonraki yeniden başlatmada görür.</p>
  <button type="button" class="primary" id="aGo" disabled>Yükle</button>
  <ul class="alog" id="aLog" aria-live="polite"></ul>
</section></div>`;
}

const AUDIO_SCRIPT = `
(function () {
  var d = document;
  var go = d.getElementById('aGo');
  if (!go) return;
  var token = new URLSearchParams(location.search).get('token') || '';
  var log = d.getElementById('aLog');
  var info = d.getElementById('aInfo');
  var files = [];
  var SKIP = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.txt', '.nfo', '.md', '.pdf', '.json', '.db', '.ini', '.url', '.lnk', '.cue', '.log'];
  var busy = false;

  function ext(name) { var i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i).toLowerCase(); }
  function usable(f) { return f.name.charAt(0) !== '.' && SKIP.indexOf(ext(f.name)) < 0; }
  function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }
  function line(text, cls) {
    var li = d.createElement('li');
    li.textContent = text;
    if (cls) li.className = cls;
    log.appendChild(li);
    return li;
  }
  function pick(list) {
    files = [].slice.call(list).filter(usable);
    var total = files.reduce(function (s, f) { return s + f.size; }, 0);
    info.textContent = files.length ? files.length + ' dosya seçildi (' + mb(total) + ')' : 'Ses dosyası bulunamadı.';
    go.disabled = !files.length || busy;
  }
  d.getElementById('aPickFiles').onclick = function () { d.getElementById('aFiles').click(); };
  d.getElementById('aPickDir').onclick = function () { d.getElementById('aDir').click(); };
  d.getElementById('aFiles').onchange = function () { pick(this.files); };
  d.getElementById('aDir').onchange = function () { pick(this.files); };

  function send(file, album, li) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/config/audio?token=' + encodeURIComponent(token) + '&album=' + encodeURIComponent(album) + '&name=' + encodeURIComponent(file.name));
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) li.textContent = file.name + ' — yükleniyor %' + Math.round(e.loaded * 100 / e.total);
      };
      xhr.onload = function () {
        var res = {};
        try { res = JSON.parse(xhr.responseText); } catch (err) { res = { ok: false, error: 'beklenmeyen cevap (' + xhr.status + ')' }; }
        resolve(res);
      };
      xhr.onerror = function () { resolve({ ok: false, error: 'bağlantı koptu' }); };
      li.textContent = file.name + ' — yükleniyor';
      xhr.send(file);
    });
  }

  function poll(job, li, name) {
    return new Promise(function (resolve) {
      (function tick() {
        fetch('/config/audio/status?token=' + encodeURIComponent(token) + '&job=' + encodeURIComponent(job))
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j.state === 'running') {
              li.textContent = name + ' — işleniyor ' + j.done + '/' + j.total + (j.current ? ' (' + j.current + ')' : '');
              setTimeout(tick, 2000);
            } else if (j.state === 'done') {
              var failed = (j.failed || []).length;
              li.textContent = name + ' — ' + j.added.length + ' eklendi' + (failed ? ', ' + failed + ' atlandı' : '');
              li.className = failed ? 'warn' : 'ok';
              (j.failed || []).forEach(function (f) { line('  ' + f.name + ': ' + f.error, 'bad'); });
              resolve(j.added.length);
            } else {
              li.textContent = name + ' — hata: ' + (j.error || 'bilinmiyor');
              li.className = 'bad';
              resolve(0);
            }
          })
          .catch(function () { setTimeout(tick, 4000); });
      })();
    });
  }

  go.onclick = function () {
    if (busy || !files.length) return;
    var album = d.getElementById('aAlbum').value;
    if (!album) return;
    busy = true;
    go.disabled = true;
    log.textContent = '';
    var queue = files.slice();
    var added = 0;
    (function next() {
      var f = queue.shift();
      if (!f) {
        busy = false;
        files = [];
        info.textContent = 'Bitti: ' + added + ' ses eklendi.';
        return;
      }
      var li = line(f.name, '');
      send(f, album, li).then(function (res) {
        if (!res.ok) {
          li.textContent = f.name + ' — ' + res.error;
          li.className = 'bad';
          return next();
        }
        if (res.job) {
          return poll(res.job, li, f.name).then(function (n) { added += n; next(); });
        }
        li.textContent = f.name + ' — eklendi';
        li.className = 'ok';
        added += 1;
        next();
      });
    })();
  };
})();
`;

module.exports = { audioTabHtml, AUDIO_SCRIPT };
