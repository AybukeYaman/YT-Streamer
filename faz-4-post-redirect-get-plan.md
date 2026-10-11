# Faz 4 — POST → 303 → GET (Post/Redirect/Get) planı

**Durum:** UYGULANDI (öneriler onaylandı). Kararlar: bellek-içi flash; pendingCover flash'ta; nonce tüm POST rotalarında (riskli 4 işlem dahil); GOLIVE_CONFIG_PRG bayrağı eklendi (0 = eski davranış); plan formu taslağı ve /config hız kovası payı bu fazda YOK. Gerçekleme: src/infrastructure/flash-store.js, action-dedupe.js, golive-server.js, stream-provisioner.js (aynı-ad kilidi), config-page.js (n + flash temizliği). Testler: test/infrastructure/golive-server.prg.test.js.
**Kaynak:** `src/infrastructure/golive-server.js` (rotalar), `src/application/config-api.js`,
`src/application/stream-manager.js`, `src/application/stream-provisioner.js`,
`src/infrastructure/cover-upload.js`, `scripts/golive-server.js` (composition),
`src/ui/config-page.js` (formlar + istemci betiği), `test/infrastructure/golive-server.test.js`.
Aşağıdaki "mevcut davranış" sütunları bu dosyalardan okunarak yazıldı; satır numaraları
`golive-server.js` içindir ve kod değişince kayabilir.

---

## 1. Neden (sorun)

Bugün her `POST /config*` işlemi sonucu **doğrudan 200 + tam HTML** olarak döner
(`#configPage`, satır 312). Sonuçları:

1. Tarayıcı sayfayı POST sonucu olarak tutar; **yenile / geri-ileri / "formu yeniden gönder"**
   aynı işlemi tekrarlar. Zararlı olanlar: canlı yayını yeniden başlatma, ikinci kez kapak
   yükleme, ikinci YouTube stream'i kurma, yayını bitirme.
2. Adres çubuğunda POST'un URL'i (`/config/instance?token=…`) kalır; yenilemek bir GET değil
   POST'tur ve tarayıcı onay penceresi gösterir (mobilde kafa karıştırıcı).
3. Sayfa durumu (seçili yayın, `?new=1`) bazı rotalarda kaybolur (aşağıda her rota için).

Hedef: başarılı/başarısız her işlemden sonra tarayıcı **GET** bir adreste dursun, yenileme
güvenli olsun, sonuç mesajı yine görünsün — ve **işlemin kendisi** (özellikle yeniden başlatma
ve dosya yükleme) ağ tekrarı/çift dokunuşta **ikinci kez çalışmasın**.

---

## 2. Rotaların mevcut ve önerilen davranışı

Ortak: hepsi önce `#authorized` (token query `?token=` ya da `Authorization: Bearer`), sonra
route başına hız sınırı (`RATE_LIMITS`, satır 51-64), sonra gövde okuma. Yetkisiz/404/405/429/
413/500 cevapları **JSON** ve bu fazda **değişmez** (yönlendirme yalnızca işlem sonucu için).

### 2.1 `/config`

| | Mevcut | Önerilen |
|---|---|---|
| **GET** | `#configPage` ile 200 HTML. `?broadcast=<id>` yayın seçer, `?new=1` (streamManager varsa) yeni-yayın formunu açar. | Aynı. Ek olarak isteğe bağlı `?flash=<id>`: varsa tek seferlik mesaj/taslak sayfaya basılır; bilinmeyen/süresi dolmuş id **sessizce yok sayılır** (sayfa mesajsız açılır). |
| **POST** `action=start\|stop` | `configApi.control()`; sonuç aynı istekte 200 HTML (notice/error). `?broadcast` korunur. | `control()` aynı; sonuç flash'a yazılır; **303** → `/config?token=…[&broadcast=…]&flash=<id>`. |
| **POST** `action=save` | `configApi.save()`; hata → 200 HTML `error`; başarı → 200 HTML `notice`. | Aynı çağrı; **303** (başarıda da hatada da). Hata mesajı flash'ta. Form değerleri hata sonrası kaybolur (bkz. 3.3: plan formu için taslak taşımak gerekmez; kayıt başarısızsa plan diskteki hali olarak yüklenir — bugünkü davranışla AYNI, çünkü sayfa zaten `configApi.form()`'dan yeniden üretiliyor). |
| **POST** `action=save_restart` | `save()` + `restartStream()` → `systemctl restart` (senkron `spawnSync`). Sonuç tek 200 HTML. | Aynı çağrı; **303**; ayrıca tekrar önleme (bölüm 5). |
| Etki | POST sonrası adres `/config?token=…` ama istek POST | Adres her zaman GET; yenileme güvenli. |

### 2.2 `/config/broadcast` (seçili YouTube yayınına işlem)

| | Mevcut | Önerilen |
|---|---|---|
| **POST** `action=apply` | `#broadcastAction`: yalnızca değişen alanlar (başlık/açıklama, görünürlük, kapak) API'ye gider; adım hatası olsa diğerleri denenir; sonuç tek mesaj. 200 HTML, `wanted=broadcastId`. | Aynı mantık; **303** → `/config?token=…&broadcast=<id>&flash=<id>`. `apply` doğası gereği **idempotent** (diff tabanlı; ikinci çalıştırma "Değişiklik yok."). |
| **POST** `action=end` | `admin.end(id)`; sonuç 200 HTML. | Aynı; **303**. Tekrar: YouTube zaten bitmiş yayını bitirmeyi hata ile reddeder → ikinci istek zararsız ama kullanıcıya hata gösterir; nonce ile "zaten uygulandı" denir (bölüm 5). |
| Etki | `broadcast` seçimi POST gövdesindeki `broadcastId`'den taşınıyor | Yönlendirmede aynı id korunur; boş id ise seçim parametresi eklenmez. |

### 2.3 `/config/new` (eşzamanlı yeni yayın kur)

| | Mevcut | Önerilen |
|---|---|---|
| **POST** | `streamManager.create(input)`: doğrulama → YouTube stream → `add-stream.sh` (~10 sn) → anahtar/ayar/plan yazımı → (opsiyonel) go-live. Başarı: 200 HTML `notice` (normal sayfa). **Hata: 200 HTML, `newMode`, `draft` = girilen değerler, `error`.** Not: formun `action`'ına `broadcast` seçimi ekleniyor (`keep`) ama sunucu bunu **okumuyor**; başarıda seçim kayboluyor. | **Başarı:** 303 → `/config?token=…[&broadcast=…]&flash=<id>` (notice). **Hata:** 303 → `/config?token=…&new=1[&broadcast=…]&flash=<id>`; flash **taslağı** (ad, başlık, açıklama, görünürlük, kapak, albümler, goLiveNow) + hata taşır. Sunucu `broadcast` parametresini okuyup yönlendirmede korur. |
| Risk | Çift gönderim → iki YouTube stream'i (bkz. 4.3) | Nonce + "devam eden işlem" kilidi (bölüm 5). |

### 2.4 `/config/instance` (kurulu ek yayına başlat/durdur/canlıya al)

| | Mevcut | Önerilen |
|---|---|---|
| **POST** | `streamManager.control(name, action)`; 200 HTML notice/error; **`broadcast` seçimi hiç taşınmıyor** (`wanted` verilmiyor). | **303** → `/config?token=…&flash=<id>`; formun action'ına `keep` eklenip `broadcast` korunur (küçük UI değişikliği). |
| Tekrar | `start`/`stop`: systemd'de idempotent. `golive`: `GoLiveService` "busy" korumasına sahip (409 `busy`) ve `already-live` döner. | Nonce yine eklenir ama bu rota için zorunlu değil; düşük risk. |

### 2.5 `/config/upload` (galeriden kapak, multipart)

| | Mevcut | Önerilen |
|---|---|---|
| **POST** | `readBodyBuffer` (15 MB sınır) → `parseMultipart` → `uploadCover` (ffmpeg ile 1280x720 JPEG, `assets/covers/galeri-<ms>.jpg`). Başarı: 200 HTML `notice` + `pendingCover` (yeni dosya seçili gelir; plana HENÜZ yazılmadı, istemci dirty sayar). Hatalar (`dosya çok büyük`, `görsel seçilmedi`, işleme hatası): 200 HTML `error`, 413'te `Connection: close`. | Aynı işlem; **303** → `/config?token=…[&broadcast=…]&flash=<id>`. Flash `pendingCover` yolunu taşır (bkz. 3.3). 413 durumunda **303 + `Connection: close`** (gövdenin kalanı okunmadığı için soket kapanmalı). |
| Tekrar | Yenile = aynı dosya ikinci kez yüklenir → ikinci `galeri-<ms>.jpg` (öksüz dosya + galeride kopya). | PRG yenilemeyi çözer; ağ tekrarı/çift dokunuş için nonce (bölüm 5). |

### 2.6 Dokunulmayanlar
`GET /config/thumb`, `POST /go-live`, `GET /status`, `GET /healthz` — Shortcuts/Safari
istemcileri JSON bekler; PRG uygulanmaz.

---

## 3. Başarı/hata mesajları yönlendirmeden sonra nasıl korunur

### 3.1 Seçenekler
| Seçenek | Artı | Eksi |
|---|---|---|
| Mesajı query'ye koy (`?notice=…`) | Durumsuz | Mesaj sahteciliği (başkası link üretip kullanıcıya sahte "başarılı" gösterebilir), URL şişer, taslak taşınamaz. **Reddedildi.** |
| Çerez (flash cookie) | Standart | Sunucuda çerez altyapısı yok; token modeli URL tabanlı; yeni güvenlik yüzeyi (SameSite/Path). **Reddedildi.** |
| **Sunucu belleğinde tek seferlik "flash" deposu** | Yeni bağımlılık yok, taslak/`pendingCover` taşıyabilir, sahteciliğe kapalı (id sunucuda üretilir) | Süreç yeniden başlarsa mesaj kaybolur (zararsız) |

**Öneri:** bellek-içi flash deposu.

### 3.2 Tasarım
- `FlashStore` (yeni, `src/infrastructure/flash-store.js`): `put(payload) → id`
  (`crypto.randomBytes(16).toString('hex')`), `get(id) → payload | null`.
- Süre: **60 sn** TTL; en fazla ~50 kayıt (eskiyi at). `get` **silmez**: iOS/tarayıcı aynı GET'i
  ikinci kez atarsa (yeniden deneme) mesaj kaybolmasın. Karşılığında sayfa yüklenince
  istemci `history.replaceState` ile `flash` parametresini adresten siler → yenileme mesajı
  tekrar göstermez (JS yoksa TTL içinde yenileme mesajı bir kez daha gösterebilir; zararsız).
- Payload: `{ notice?, error?, newMode?, draft?, pendingCover? }`. **Token flash'a konmaz**
  (token zaten URL'den doğrulanır).
- GET `/config`, `flash` id'sini okur; `pendingCover` yalnızca `configApi.form().covers`
  içindeyse kabul edilir (mevcut "listede olmayan yol reddedilir" kuralı korunur).

### 3.3 Mesaj türüne göre
- **notice/error:** flash'ta; sayfa aynı `role="status"` / `role="alert"` kutularıyla basar
  (`config-page.js` değişmez).
- **Yeni yayın taslağı (hata):** flash'ta; `?new=1` + `draft` ile form eskisi gibi dolu açılır.
- **`pendingCover` (yükleme):** flash'ta. Yenilemeyle kaybolur; dosya galeride kalır ve kullanıcı
  seçebilir. (Alternatif: `&pendingCover=<yol>` query'de; yenilemede kalır ama yol adrese girer.
  Flash tercih edildi; karar açık bırakıldı.)
- **Plan formu hatası (`save` başarısız):** taslak taşınmaz — bugünkü davranışla aynı (sayfa
  `configApi.form()` diskteki plandan üretiliyor; hata sonrası girilen değerler zaten
  korunmuyor). İstenirse sonraki fazda taslak flash'a eklenir.

### 3.4 Yönlendirme adresi
Her zaman **göreli** `Location: /config?...` (Host başlığına güvenilmez). Token, isteğin
**query**'sinden geldiyse `Location`'a aynen (encodeURIComponent) eklenir — bugün zaten URL'de.
Yalnızca `Authorization` başlığıyla yetkilenen istemciler (token query yok) için `token`
eklenmez. `broadcast` yalnızca listede varsa/boş değilse taşınır (GET tarafı zaten yok sayıyor).

---

## 4. İşlem bazlı riskler

### 4.1 Yeniden başlatma (`save_restart`)
- `systemctl restart` ana yayını **keser**; `spawnSync` ile **event loop'u bloklar**
  (`scripts/golive-server.js`). Yeniden başlatma yavaşlar/mobil ağ koparsa kullanıcı
  yenileyip/yeniden dokunup **ikinci restart** tetikleyebilir → canlı yayın iki kez kesilir.
- PRG (3.) tarayıcı yenilemesini çözer; **ağ tekrarı ve çift dokunuşu** nonce çözer (bölüm 5).
- `save()` başarılı ama `restartStream` hatalıysa mevcut mesaj ("Plan kaydedildi — …")
  korunur; hata flash'ta döner.
- İstemci tarafında D4 (`busy` bayrağı) zaten ikinci gönderimi engelliyor; sunucu savunması
  JS'siz/ağ tekrarı için ek katmandır.

### 4.2 Kapak yükleme
- Çok parçalı gövde 15 MB'a kadar; 413 yolunda gövdenin kalanı okunmaz → yanıt
  `Connection: close` ile gitmeli (mevcut davranış korunur, sadece 200 yerine 303).
  Bazı tarayıcılar yükleme sürerken erken yanıtı "bağlantı sıfırlandı" diye gösterebilir —
  bugün de aynı risk (200 ile); PRG bunu kötüleştirmez.
- Yenileme/tekrar → öksüz `galeri-<ms>.jpg` kopyaları. PRG + nonce.
- Yükleme **plana dokunmaz**; `pendingCover` yalnızca görsel işarettir (3.3).

### 4.3 Yeni yayın oluşturma
- Sırası: `exists` kontrolü → YouTube `createStream` → `provision` → anahtar/ayar/plan. İki
  eşzamanlı istek ikisi de `exists` kontrolünü geçebilir (henüz kurulu değil) ve **iki
  YouTube stream'i** yaratır; ikincisi sonradan "ad zaten kullanılıyor" ile düşer ama
  YouTube'da öksüz stream kalır. `/config/new` hız sınırı 3/dk (bunu sadece azaltır).
- Önlem: aynı `name` için **devam eden işlem kilidi** (`StreamProvisioner` içinde
  `#inflight` kümesi) + nonce. Kilit ayrı bir kod değişikliği (ProvisionError ile
  "bu ad için kurulum sürüyor") ve kendi testiyle gelir.
- Kısmi kurulum hata mesajı adımı zaten söylüyor; PRG sonrası da aynen flash'ta görünür.
- Hata sonrası taslak korunmalı (3.3) — bu PRG'nin en kritik regresyon noktası.

### 4.4 Başlatma/durdurma (ana + ek yayın)
- Systemd `start`/`stop` idempotent; tekrar zararsız. Ana yayın `Durdur` zaten istemcide onaylı.
- Ek yayın `golive`: `GoLiveService` meşgulken 409 `busy` döndürüyor; `already-live` mesajı var.
  Tekrar yeni broadcast açmaz.
- `/config` POST `start|stop` yanıtı bugün aynı istekte `control()` sonucunu basıyor; PRG'de
  sonuç flash'a gider. `unknown` durumunda iki düğme birden gösterilir (mevcut) — değişmez.

### 4.5 Yayını bitirme (`end`)
- Geri alınamaz. İstemcide onay penceresi var. Tekrar: YouTube hata verir ("zaten bitti");
  PRG yenilemeyi zararsız yapar, nonce kullanıcıya "bu işlem zaten uygulandı" der.
- Mevcut `ENDABLE_STATES` kuralı UI'da; sunucu tarafı `BroadcastAdmin.end` doğrulaması aynen.

### 4.6 Diğer
- **Hız sınırı:** her işlem artı bir `GET /config` getirir; `/config` kovası 30/dk. Sık
  işlem yapan kullanıcı (örn. çok yayınlı) için sınır yeterli ama izlenmeli; gerekirse
  `/config` kovasına işlem başına +1 pay.
- **Geri/ileri (bfcache):** istemcide `pageshow` ile `resetBusy` zaten var; PRG sonrası
  geri tuşu bir önceki GET'e döner.
- **Kirli-form koruması (D2/D3):** işlem sırasında `leaving=true` yapıldığı için
  `beforeunload` uyarısı çıkmaz; yönlendirme sonrası yeni sayfa temiz yüklenir. Değişmez.
- **Log/izleme:** işlem logları aynı kalır; flash id'si loglanmaz.

---

## 5. Tekrar gönderimi önleme (yeniden başlatma ve dosya yükleme)

PRG yalnızca **tarayıcı** tekrarını (yenile/geri) çözer. Ağ yeniden denemesi, çift dokunuş,
bfcache'ten eski sayfayı yeniden gönderme için **işlem kimliği (nonce)** ekleniyor.

### 5.1 Mekanizma
1. `renderConfigPage` her basımda **rastgele bir `n` değeri** üretir (sunucuda; sayfa başına
   bir tane) ve tüm POST formlarının **action URL'sine query olarak** ekler
   (`…?token=…&n=<nonce>`). Gövdeye değil: token da query'de, gövde auth'tan önce okunmasın
   (mevcut tasarım ilkesi, bkz. `golive-server.js` yorumları).
2. `ActionDedupe` (yeni, bellek-içi, TTL ~10 dk): `begin(nonce) → 'new' | 'inflight' | 'done'`
   ve `finish(nonce, flashId)`.
3. POST işleyicisi gövdeyi okumadan/işlemi çalıştırmadan önce `begin` çağırır:
   - `new` → işlem çalışır, bitince `finish(nonce, flashId)`; 303.
   - `inflight` → işlem **çalıştırılmaz**; 303 → `/config?…&flash=<busy-flash>` ("İşlem sürüyor, sayfayı yenile").
   - `done` → işlem **çalıştırılmaz**; 303 → aynı sonucun flash'ı (TTL içinde) ya da
     "Bu işlem zaten uygulandı. Sayfa yenilendi."
4. `n` yoksa (eski açık sekme, Shortcuts, test istemcisi) işlem **bugünkü gibi** çalışır
   (geriye dönük uyum).
5. Aynı sayfa içinde ikinci farklı işlem (örn. önce Başlat, sonra Durdur) **farklı bir
   nonce gerektirmez mi?** — Evet: yalnızca **aynı sayfa yüklemesinden** gelen ikinci
   gönderim engellenir; her başarılı işlemden sonra PRG yeni sayfa (yeni `n`) getirdiği için
   kullanıcı sonraki işlemi normal yapar. Eski sekmede ikinci işlem "sayfayı yenile" mesajı alır.
   Bu kasıtlı: eski sayfadan gelen işlem bayat bir durum görüntüsüne dayanıyor.

### 5.2 Yeniden başlatma için ek notlar
- `spawnSync` event loop'u bloklar → eşzamanlı ikinci istek restart bitene kadar işlenmez;
  bittiğinde nonce `done` olduğu için çalışmaz. `inflight` durumu bu bloklamaya **güvenmeden**
  da doğru olmalı (ileride asenkrona geçilirse).
- Nonce, `save` kısmını da kapsar (aynı form). Bu zararsız: aynı veriyle ikinci kayıt zaten
  aynı sonucu verirdi.

### 5.3 Dosya yükleme için ek notlar
- Nonce kontrolü **gövde okunmadan önce** yapılır → tekrar isteğinde 15 MB gövde ffmpeg'e
  gitmez (gövde yine boşaltılır).
- Aynı dosyanın içerik özeti (SHA-256) ile tekilleştirme **önerilmiyor**: kullanıcı bilerek
  aynı görseli tekrar yüklemek isteyebilir; sorun iletim tekrarıdır, içerik değil.

### 5.4 Kapsam
Nonce zorunlu: `save_restart`, `/config/upload`, `/config/new`, `/config/broadcast end`.
Aynı mekanizma kalan rotalara (kolaylık için) uygulanır ama düşük riskli.

---

## 6. Geriye dönük uyumluluk

- **HTTP sözleşmesi:** tarayıcı formları etkilenmez (303'ü otomatik GET'e çevirir).
  Programatik istemciler: `fetch`/`curl -L` yönlendirmeyi izler; izlemeyen, artık 200 HTML
  yerine 303 görür. `POST /go-live` ve `/status` JSON istemcileri (Shortcuts) **etkilenmez**.
- **Authorization başlığı:** yalnızca başlıkla yetkilenen bir istemci yönlendirmeyi izlerse
  tarayıcılar başlığı taşımaz; `fetch` aynı-origin'de taşır. Testler `fetch` ile Bearer + query
  kullanıyor; sorun beklenmiyor ama test edilecek.
- **Form alan adları/değerleri:** DEĞİŞMEZ (`test/ui/config-page.form-golden.json` altın
  dosyasına dokunulmaz). Yeni olan yalnızca action URL'lerindeki `&n=` ve (isteğe bağlı)
  `/config/instance` ile `/config/new` action'larında `broadcast` taşıma düzeltmesi.
- **Eski açık sekmeler:** `n` yoksa eski davranış; flash/`n` bilinmiyorsa yok sayılır.
- **Sürüm geçişi:** bellek-içi depolar süreç yeniden başlayınca boşalır; kalıcı veri/migrasyon yok.
- **Özellik bayrağı (öneri):** `GOLIVE_CONFIG_PRG` (varsayılan açık; `0` = eski 200 HTML yolu).
  `#configPage` zaten tek basım yeri olduğundan eski yol küçük bir dal olarak kalabilir; ilk
  dağıtım için güvenlik ağı. Kalıcı olarak tutulup tutulmayacağı karar noktasıdır.

---

## 7. Test planı

Mevcut: `test/infrastructure/golive-server.test.js` (POST `/config*` testleri ~satır 321-855,
`fetch` ile; varsayılan olarak yönlendirmeyi izler, yani çoğu test GET sonucunu görür).

**Yeni/uyarlanan sunucu testleri** (`redirect: 'manual'`):
1. Her POST rotası, başarıda **303** + `Location` (göreli, `/config?`, `token` korunmuş,
   `broadcast` korunmuş, `flash=` var); gövde boş/gereksiz.
2. Hatada da **303**; flash'ta hata. `GET` ile `flash` ile açılınca `role="alert"` kutusunda.
3. `/config/new` hatası: `?new=1` + dolu taslak (ad, başlık, açıklama, görünürlük, kapak,
   albümler, `goLiveNow`) — **regresyon odağı**.
4. `/config/upload`: başarıda `pendingCover` seçili gelir; listede olmayan `pendingCover`
   reddedilir; 413 yolunda 303 + `Connection: close`.
5. Flash: bilinmeyen/süresi dolmuş id yok sayılır; TTL (enjekte edilen `now`); kapasite sınırı;
   token flash'ta yok.
6. Nonce: aynı `n` ile ikinci POST işlemi **çalıştırmaz** (fake `save`/`uploadCover`/`create`
   çağrı sayacı 1); eşzamanlı iki istek → ikincisi `inflight`; `n` yoksa eski davranış.
7. Hız sınırı: işlem + GET aynı kovada sayılıyor mu (beklenen sınırlar).
8. Yetkisiz 401, GET 405, 404 (servis yok) — **değişmediğini** doğrulayan mevcut testler korunur.

**Birim testleri:** `FlashStore`, `ActionDedupe` (TTL, kapasite, `begin/finish`),
`StreamProvisioner` eşzamanlı aynı-ad kilidi.

**UI testleri:** form action'ları `n` taşıyor; form alanları altın dosyayla aynı kalıyor;
istemci betiği `flash` parametresini adresten siliyor (gerçek DOM yardımcısı
`test/ui/helpers/browser-dom.js` kullanılabilir).

**Tam test paketi** (`npm test`) her adımdan sonra çalıştırılır.

---

## 8. Uygulama sırası (öneri; onay sonrası)

Tek faz, tek commit (proje kuralı). Sıra:
1. `FlashStore` + `ActionDedupe` + birim testleri.
2. `GET /config` `flash` okuma; `#redirect` yardımcı (göreli Location).
3. `/config` (save/start/stop) ve `/config/broadcast` PRG + testler.
4. `/config/instance`, `/config/new` PRG + `broadcast` taşıma + taslak.
5. `/config/upload` PRG + 413 yolu.
6. Nonce: render + action URL + `begin/finish` (restart/upload/new/end önce).
7. `StreamProvisioner` aynı-ad kilidi.
8. (İsteğe bağlı) `GOLIVE_CONFIG_PRG` bayrağı; `history.replaceState` betiği.
9. Tam test + VPS'te elle doğrulama (aşağıda).

**Elle doğrulama (VPS, canlı yayını kesmeden):** plan kaydet + yenile; geçersiz Pomodoro;
kapak yükle + yenile (tek dosya oluştu mu); yeni yayın hatası (taslak korundu mu); ek yayın
durdur/başlat; `save_restart` yalnızca bakım penceresinde, yenile/çift dokun.

---

## 9. Geri alma planı

- **Kod:** Faz tek commit olduğundan `git revert <commit>` + `deploy.sh` ile geri dönülür.
- **Hızlı kapatma (bayrak uygulanırsa):** `GOLIVE_CONFIG_PRG=0` + golive servisini yeniden
  başlat → eski 200 HTML yolu; kod dağıtımı gerekmez.
- **Veri:** kalıcı durum yok (flash/nonce bellek-içi) → migrasyon/temizlik gerekmez.
- **Yan etkisi geri alınamayanlar** (kurulan stream, yüklenen kapak, bitirilen yayın) bu
  fazın değil, işlemin kendisinin sonucudur; nonce ve kilit bunların **tekrarını** önler.
- Geri alma tetikleyicileri: kullanıcı sonuç mesajını görmüyor, `/config/new` taslağı kayboluyor,
  yönlendirme döngüsü, hız sınırı (429) artışı.

---

## 10. Açık kararlar (onay gerekir)

1. Mesaj taşıma: bellek-içi flash (öneri) mi, başka bir yol mu?
2. `pendingCover`: flash (öneri) mi, query mi?
3. Nonce kapsamı: yalnızca riskli 4 işlem mi, tüm POST'lar mı?
4. `GOLIVE_CONFIG_PRG` bayrağı eklensin mi, yoksa yalnızca `git revert` mi?
5. Plan formu başarısızlığında taslağın taşınması bu fazda mı, sonraya mı?
6. `/config` hız sınırı kovasına işlem başına pay eklensin mi?
