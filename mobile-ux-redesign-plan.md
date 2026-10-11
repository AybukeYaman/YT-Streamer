# Mobil UX Yeniden Tasarım Planı — `/config` sayfası

> **Durum: PLAN — onay bekliyor. Bu aşamada hiçbir kod değiştirilmedi.**
> Temel: `ANALIZ-mobil-arayuz.md` (aynı klasör). Burada tekrarlanmayan ayrıntılar orada.

## 0. Bağlam ve sınırlar

- Arayüz = `src/ui/config-page.js` içindeki **tek bir saf fonksiyon** (`renderConfigPage`), sunucuda HTML metni üretir. Framework, bundler, istemci state'i, UI kütüphanesi **yok**; stil satır içi `<style>`. Bu plan bu modeli korur: **yeni bağımlılık yok, SPA'ya geçiş yok, çok ekranlı uygulama yok.**
- Marka dili mevcut: koyu zemin + pembe vurgu (`#1c0f17`, `#ec4899`), Türkçe arayüz. Korunur, yalnızca token'lara (CSS değişkenleri) bağlanır.
- Not: bu makinede tanımlı `ui-design` yetkinliği React/Vite/Electron (`web/src`) varsayıyor; bu projede öyle bir klasör yok. Yalnızca stack'ten bağımsız ilkelerini aldım: tek birincil eylem, durum her zaman görünür, eyleme dönük hata, yıkıcı eylemde onay, "gelişmiş"i katla, bir şeyi kaldırmadan önce kullanımı doğrula.
- **Korunacaklar (dokunulmaz):** tüm rotalar ve form alan adları (`title`, `description`, `privacy`, `cover`, `pomodoroEnabled`, `pomodoroType`, `studyVideos`, `breakVideos`, `albums`, `goLiveNow`, `name`, `action=…`, `broadcastId`, `coverFile`), sunucu doğrulamaları, hız sınırları, token/yetki, beyaz liste kuralları, `esc()` ile kaçış, YouTube küçük resim güvenliği. **Faz 1-3 yalnızca `config-page.js` (+ testleri) değiştirir; backend davranışı değişmez.**

---

## 1. Mevcut arayüzün en önemli sorunları

Her madde koddan/üretilen HTML'den doğrulandı (satır no: `config-page.js`).

| # | Sorun | Kanıt | Etki |
|---|---|---|---|
| P1 | **Ana eylem gömülü.** "Kaydet" / "Kaydet ve Yeniden Başlat" 7 bölümlük formun en altında; klip listeleri onlarca satır | 425-426 | Kullanıcı kaydetmek için uzun kaydırır; kaydedip kaydetmediğini bilemez |
| P2 | **Canlı yayını kesen eylem onaysız** (Kaydet ve Yeniden Başlat) — Durdur/Bitir onaylı | 426 vs 77, 205 | Yanlış dokunuşla yayın kesilir; tutarsız |
| P3 | **Aynı alanlar iki kez**: mevcut yayın formu ve "Sonraki Yayın" formunda ayrı Başlık/Açıklama/Kapak | 193-204 vs 375-397 | "Hangisi neyi değiştiriyor?" ancak küçük ipuçlarından anlaşılır; "Sonraki Yayın" altında ikinci h2 de var (377-379) |
| P4 | **Seçim hiyerarşisi yok**: her bölüm aynı ağırlıkta (14px büyük harf h2) | 314 | Önce neye bakılacağı belli değil; seyrek ayarlar (klip havuzları, açıklama) sürekli açık |
| P5 | **Kaydedilmemiş girdi sessizce kaybolur** (galeri yüklemesi `onchange` ile anında POST, yayın değiştirme tam yenileme) | 395, 119 | Veri kaybı |
| P6 | **Ölü/pasif düğmeler**: Başlat+Durdur yan yana, biri hep `disabled` (ek yayınlarda 3 düğmeden 1-2'si pasif) | 75, 78, 272 | Gürültü; "ne yapabilirim?" yerine "neler yapamam" gösterir |
| P7 | **Etiketsiz alanlar**: input/textarea/select için `<label>` yok, yalnızca üstte `<p class="hint">` | 195-202, 381, 406 | Ekran okuyucu alan adını okuyamaz, dokunma hedefi daralır |
| P8 | **Pomodoro süresi serbest metin**; kapalıyken de süre alanı ve iki uzun klip listesi görünür | 401-419 | Bağımlılık görünmez; hata ancak gönderince |
| P9 | **Geri bildirim zayıf**: sonuç bandı sayfanın en üstünde, işlem sırasında yalnızca "Yayını Kur" düğmesi pasifleşir | 365-366, 254 | Aşağıdaki bir düğmenin sonucu ekranda görünmeyebilir; çift dokunma mümkün |
| P10 | **Kontrast/biçim**: beyaz yazı üstü pembe birincil buton **3.53:1** (WCAG AA normal metin için 4.5 gerekir); ikincil buton zemini kart kenarından ayrışmıyor (**1.21:1**); ipucu metni 6.9:1 (iyi) | hesaplandı | Birincil/ikincil ayrımı ve okunabilirlik |
| P11 | **Seçili yayın yeni-yayın/ek-yayın işleminden sonra sıfırlanır**; POST yanıtı sayfa olarak basılır (yenilemede yeniden gönderim) | golive-server 514-525 | Bağlam kaybı (Faz 4'te ele alınır; backend değişikliği) |
| P12 | Ham JSON hata sayfaları (401/429/404) telefonda | `#json` | Eyleme dönük değil (Faz 4) |

---

## 2. Önerilen yaklaşım: "Görev sırasına göre tek sayfa"

Kullanıcının gerçek işleri (koddan): **(a)** ana yayının çalışıp çalışmadığına bak, başlat/durdur; **(b)** YouTube'daki bir yayının başlık/görünürlüğünü düzelt, gerekirse bitir; **(c)** bir sonraki yayının kapağı/başlığı/Pomodoro'sunu hazırla; **(d)** ikinci bir yayın aç/yönet.
Sayfayı bu sırayla ve **"Şimdi → Düzenle → Hazırla → Ek"** mantığıyla diziyorum; her bölüm tek sorunun cevabı.

İlkeler:
1. **Durum ilk ekranda**: sayfa açılınca "yayın çalışıyor mu, canlı mı" bir bakışta görünür.
2. **Bağlamsal tek düğme**: Başlat *ya da* Durdur (duruma göre), pasif düğme yok.
3. **Progressive disclosure `<details>` ile** (JS gerektirmez, zaten projede kullanılıyor): açıklama, kapak, klip havuzları, yıkıcı eylemler varsayılan kapalı; kapalıyken **özet satırı** ("3 görsel seçili", "Kapak: x.jpg") durumu gösterir.
4. **Doğru kontrol, doğru yerde**: 3 seçenek → segmented control; aç/kapa → switch; kapak → küçük resimli kart ızgarası; çok sayıda klip → özetli katlanır liste.
5. **Plan formunun kendi sabit eylem çubuğu**: yalnızca kullanıcı bir şeyi değiştirdiyse görünür ("Kaydedilmemiş değişiklik var"), içeriği kapatmaz.
6. **Her işlemin sonucu görünür yerde**: sabit üst bildirim (aria-live) + işlem sırasında düğmede "…yapılıyor".

---

## 3. Yeni sayfa düzeni (metinsel wireframe)

Genişlik 360-480px tek sütun. `[ ]` = kontrol, `▸` = kapalı `<details>`, `●` = durum noktası.

```
┌─────────────────────────────────────┐
│ Yayın Yönetimi                      │  H1 (+ plan adı küçük, soluk)
│ ● Ana yayın çalışıyor · ● Canlı     │  Durum şeridi (tek satır, sayfa açılışındaki durum)
├─────────────────────────────────────┤
│ [bildirim bandı — yalnızca varsa,   │  sabit üstte, aria-live, kapatılabilir
│  ✓ Plan kaydedildi.]                │
├─────────────────────────────────────┤
│ 1 · ŞU AN                           │
│ ┌ Ana yayın ─────────────────────┐ │
│ │ ● Çalışıyor                    │ │  durum kartı
│ │ [   Durdur   ]  (tek bağlamsal │ │  çalışıyorsa Durdur (onaylı),
│ │                  düğme)        │ │  durmuşsa Başlat (primary)
│ │ ℹ Başlattıktan 30-60 sn sonra  │ │  yalnızca Başlat'tan sonra/durmuşken
│ │   go-live tetikle              │ │
│ └────────────────────────────────┘ │
│ ┌ Ek yayınlar (varsa) ───────────┐ │  her ek yayın: ad · ● durum · tek ana düğme
│ │ lofi2 ● Çalışıyor [Canlıya Al] │ │  + ⋯ altında Durdur/Başlat
│ └────────────────────────────────┘ │
├─────────────────────────────────────┤
│ 2 · YOUTUBE'DAKİ YAYIN              │
│ [▾ ▣ ● Lofi … · Canlı · Herkese…]   │  mevcut seçici (kompakt, aynı <details>)
│  Başlık   [__________________]      │  label'lı
│  Görünürlük  (Herkese|Liste dışı|Gizli) segmented
│ ▸ Açıklama ve kapak                 │  kapalı; özet: "Açıklama 312 krk · kapak değişmez"
│ [      Bu Yayına Uygula      ]      │  bölümün primary'si
│ ▸ Yayını bitir…                     │  kapalı, tehlike bölgesi; içinde danger düğme + onay
├─────────────────────────────────────┤
│ 3 · SONRAKİ YAYIN                   │  "Bir sonraki canlıya almada kullanılır"
│  Başlık   [__________________]      │
│  Kapak    ┌──┐┌──┐┌──┐┌──┐         │  küçük resim kart ızgarası, tek seçim,
│           └──┘└──┘└──┘└──┘         │  seçili kart pembe çerçeve + ✓
│           [ + Galeriden ekle ]      │
│  Pomodoro            (○━ ) switch   │  switch
│    └ açıkken: Süre (50+10|30+10|45+15|Özel) segmented; Özel → metin
│    └ ▸ Çalışma görselleri · 3 seçili│  açık/kapalı; açıkken görünür
│    └ ▸ Mola görselleri · 2 seçili   │
│ ▸ Açıklama                          │  kapalı; özet
│ ▸ Müzik: tüm kütüphane çalar        │  bilgi (SSH notu kaldırılır, bkz. §7 Soru 2)
├─────────────────────────────────────┤
│ 4 · YENİ EŞZAMANLI YAYIN            │
│ [ + Yeni yayın aç… ]                │  ?new=1 (mevcut akış; form 3 adımlı değil, aynı alanlar,
│                                     │  "Gelişmiş" altında: görünürlük, kapak, albümler)
└─────────────────────────────────────┘
╔═════════════════════════════════════╗  yalnızca plan formu değişince görünür (sticky alt)
║ ● Kaydedilmemiş değişiklik          ║
║ [ Kaydet ]  [ Kaydet ve yeniden… ▾ ]║
╚═════════════════════════════════════╝
```

**Gerekçe — başlangıç sırasından sapmalar:**
- "Primary action" sayfa genelinde tek değil: iki gerçek görev var (yayını yönet / planı kaydet). Bu yüzden **bölüm başına bir primary** (Başlat/Durdur, Bu Yayına Uygula, Kaydet) ve sayfa düzeyinde yalnızca *değişiklik varken* beliren sabit çubuk.
- "Selection summary" ayrı bir blok değil; **katlanmış bölümlerin özet satırları** ve sabit çubukta değişiklik sayısı bu rolü görür (sayfa zaten uzun, ek özet bloğu tekrar olurdu).
- Yeni-yayın akışı için adımlı sihirbaz **önerilmiyor**: 7 alan, hepsi aynı sayfada rahat sığıyor; "Gelişmiş" katlama yeterli.

---

## 4. Seçim kontrolleri haritası

| Alan | Şimdi | Yeni | Neden |
|---|---|---|---|
| Görünürlük (3 seçenek, 2 yerde) | `<select>` | **Segmented control** (gizli `radio` + stillenmiş `label`; alan adı `privacy` aynı) | 3 seçenek tek bakışta, tek dokunuş; yerel menü gerekmiyor |
| Pomodoro Açık | onay kutusu satırı | **Switch** (stillenmiş `checkbox`, `pomodoroEnabled`) | Aç/kapa semantiği |
| Pomodoro süresi | serbest metin | **Segmented** 50+10 / 30+10 / 45+15 / **Özel** (Özel → metin alanı). Alan `pomodoroType` aynı | Hata yapmayı azaltır; sunucu her biçimi (`N+M`) kabul ettiği için "Özel" kayıpsız |
| Pomodoro bağımlılığı | her zaman görünür | Switch kapalıyken süre+klip bölümü **gizli/pasif**; kapalıyken sunucuya zaten alan olarak gitmez ama değerler korunur (CSS ile gizlenir, `disabled` YAPILMAZ ki gönderim davranışı değişmesin) | Bağımlılık görünür |
| Kapak (sonraki yayın) | radyo listesi satırları | **Küçük resim kart ızgarası** (radyo + görsel, 3 sütun; "Varsayılan" ilk kart) | Kapak görsel bir seçim; listeden çok daha hızlı karşılaştırılır |
| Kapak (mevcut yayın) | önizlemesiz `<select>` | Aynı **kart ızgarası** + "Değiştirme" ilk kart | İki yerde tek bileşen (P3, tutarlılık) |
| Klip havuzları | iki uzun onay listesi | `<details>` + özet ("3 seçili"), içinde **2 sütun küçük resim ızgarası** (onay kutusu) | En uzun bölüm varsayılan kapalı |
| Albümler (yeni yayın) | onay listesi | Aynı küçük resim ızgarası, "Gelişmiş" altı; boşsa "hepsi çalar" özeti | Varsayılanla çalışan alan |
| Ana yayın Başlat/Durdur | iki düğme, biri pasif | **Bağlamsal tek düğme** (aynı `POST /config`, `action=start|stop`) | P6 |
| Yayın seçici | `<details>` özel menü | **Korunur** (zaten iyi; küçük görsel + etiket) | Çalışan, testli çözüm |

Seçili durum: kenarlık + dolgu + **✓ işareti** (yalnızca renge bağlı olmasın).

---

## 5. Görsel tasarım dili

Mevcut paleti **token'lara** bağla (davranış/renk kimliği aynı kalır, yalnızca düzenli hâle gelir):

```
--bg #1c0f17   --surface #241320   --surface-2 #2e1a28   --line #4a2a3c
--text #fbe6f0   --muted #c98cae (6.9:1 ✓)   --accent #ec4899
--accent-strong #be185d   (birincil buton dolgusu; beyaz metin ≈ 5.9:1 — kullanımdan önce hesapla/doğrula)
--danger #7a1f3d (10:1 ✓)   --ok #34d399   --warn #fbbf24
--radius 12px   --space: 4/8/12/16/24   --tap 48px
```
- **Birincil buton:** `--accent-strong` dolgu + beyaz, tam genişlik. **İkincil:** çerçeveli (kenarlık `--line` → `--text` %60), dolgusuz — kart zeminiyle karışmaz (P10). **Tehlike:** yalnızca katlı "bitir" bölümünde.
- **Tipografi:** mevcut sistem fontu. H1 22/700; bölüm başlığı 13px büyük harf yerine **16/600 sentence-case** + numara/ikon yok (okunurluk); alan etiketi 14/600; ipucu 13 `--muted`. Büyük harf yalnızca grup etiketlerinde.
- **Kartlar yalnızca gruplamak için** (bölüm başına bir yüzey); iç içe kart yok; satır ayırıcı çizgi.
- **Durum noktası + metin** (yeşil/gri/sarı + "Çalışıyor/Durmuş/Bilinmiyor"); sadece renk değil.
- **Hareket:** `<details>` açılışında 150ms yükseklik/opaklık, düğme basma `transform: scale(.98)`; `@media (prefers-reduced-motion: reduce)` ile kapalı.
- **Erişilebilirlik:** her alan gerçek `<label for>`; sonuç bandı `role="status" aria-live="polite"` (hata `role="alert"`); segmented/switch klavye ve odak halkası; hedef ≥48px (mevcut test 44px kuralı korunur ya da yükselir).
- Tema: şimdilik yalnızca koyu (marka). `prefers-color-scheme: light` desteği kapsam dışı, backlog.

## 6. Responsive

- ≤480px: tek sütun, yatay taşma yok (görsel ızgaralar `grid-template-columns: repeat(3, 1fr)` → ≤360px'de 2).
- ≥640px (iPad/masaüstü): içerik `max-width: 720px`; bölüm 3'te kapak ızgarası 4-5 sütun; **sabit çubuk içerik sütunu genişliğinde**. İki sütunlu panel düzeni yapılmaz (tek sayfa modeli korunur).
- Klavye: sabit çubuk `position: sticky; bottom: 0` + `env(safe-area-inset-bottom)`; `visualViewport` ile ayrıca bir şey yapılmaz — sticky çubuk klavyenin üstünde kalır. Odaklanan alan çubuğun altında kalmasın diye form altına çubuk yüksekliği kadar `padding-bottom`.
- Çubuk **yalnızca değişiklik varsa** görünür; boşken yer kaplamaz → "içeriği kapatır" riski sınırlı.

## 7. Davranış korunumu ve "yalnızca gerekçeli" değişiklikler

Aşağıdakiler mevcut davranışı **değiştirir**; gerekçeleri yazılı, onayına sunuluyor:

| # | Değişiklik | Neden | Risk/Not |
|---|---|---|---|
| D1 | "Kaydet ve Yeniden Başlat" **onay** ister (`confirm`, yalnızca yayın çalışıyorsa) | P2; canlı yayını keser | Düşük; UI-only |
| D2 | Galeri dosyası seçilince **anında gönderme yerine**: değişiklik varsa uyar (`confirm`), yoksa gönder | P5 | Düşük; UI-only; JS kapalıysa eski davranış |
| D3 | Kaydedilmemiş değişiklikle yayın değiştirme/yenileme öncesi uyarı (`beforeunload`+seçici bağlantıları) | P5 | Düşük; UI-only |
| D4 | İşlem sırasında gönderen düğmede "…yapılıyor", diğerleri pasif (çift gönderim önlenir) | P9 | Düşük |
| D5 | Müzik notundaki "`npm run plan`" (SSH) metni kaldırılıp "Tüm kütüphane çalar" özeti | Sayfanın amacı SSH'sız çalışmak; metin yanıltıcı | Özellik değil metin; **albüm seçimini ana plana taşımak ayrı bir özelliktir ve bu planın dışındadır** |
| D6 *(Faz 4, backend)* | POST → 303 → GET (PRG) + bildirimin sorgu/çerezle taşınması; 401/429/404 için `Accept: text/html` ise okunur HTML | P11, P12 | `golive-server.js` + testler değişir; **ayrı onay** |

**Kaldırılan/taşınan öğe yok.** Her mevcut düğme/alanın yeni yeri:

| Mevcut | Yeni konum |
|---|---|
| Yayın seçici, apply, Bitir | Bölüm 2 (Bitir → katlı "Yayını bitir…" + aynı `confirm`) |
| Başlat/Durdur (ana) | Bölüm 1, bağlamsal tek düğme |
| Ek yayın Başlat/Canlıya Al/Durdur | Bölüm 1 ek yayın kartı (ana düğme + ⋯; üçü de erişilebilir) |
| Sonraki yayın başlık/açıklama/kapak/Pomodoro/klipler | Bölüm 3 |
| Galeriden ekle | Bölüm 3 kapak ızgarası ("+ Galeriden ekle") |
| Yeni yayın formu | Bölüm 4 → `?new=1` (alanlar aynı) |
| Kaydet / Kaydet ve Yeniden Başlat | Sticky eylem çubuğu (+ JS yoksa form sonunda statik) |

**Soru (onayına):** (1) D1-D5'i istiyor musun? (2) Albüm seçimini ana plana eklemek (mevcut sınırlama v1 kararı) bu işe dahil olmasın mı? (3) Faz 4 (backend: PRG + HTML hata sayfaları) planda kalsın mı, ertelensin mi?

---

## 8. Etkilenecek dosyalar

| Dosya | Faz | Değişiklik |
|---|---|---|
| `src/ui/config-page.js` | 1-3 | Tamamı: CSS token'ları, bölüm sırası, yeni bileşen yardımcıları (`segmented`, `switchRow`, `coverGrid`, `collapsible`, `statusDot`), ~30 satır satır içi JS (sticky çubuk/dirty/onay/busy) |
| `test/ui/config-page.test.js` | 1-3 | 37 testin bir kısmı HTML kalıplarını (radyo satırı, `<select name="privacy">`, `.row`, iki düğme) doğruluyor → güncellenir; **davranış testleri** (alan adları, onay metinleri, kaçış, token, form ayrımı, seçili yayının taşınması) korunur |
| `src/infrastructure/golive-server.js` | 4 | PRG, hata sayfaları (yalnızca onayla) |
| `test/infrastructure/golive-server.test.js` | 4 | PRG/Accept testleri |
| `scripts/deploy/README.md`, `KARARLAR.md` | 3 | Yeni düzen + karar kaydı (projenin mevcut alışkanlığı) |

Değişmez: `config-api.js`, `broadcast-admin.js`, `stream-*.js`, `stream-plan.js`, wiring, deploy betikleri.

## 9. Aşamalı uygulama

Her faz sonunda tek commit (proje kuralı) ve tüm testler yeşil olmadan sonraki faza geçilmez.

1. **Faz 1 — Temel (görünüm, davranış sabit):** CSS token'ları, kontrast düzeltmesi (P10), gerçek `<label>`'lar (P7), tip ölçeği, bölüm başlıkları, bölümlerin yeni sırası ve `<details>` katlamaları, ana yayın bağlamsal tek düğme, ek yayın kartları, durum şeridi. *Form alan adları ve rotalar aynı.*
2. **Faz 2 — Seçim kontrolleri:** segmented (görünürlük, Pomodoro süresi + "Özel"), switch, kapak/klip/albüm küçük resim ızgaraları, Pomodoro bağımlılık görünürlüğü, özet satırları, ortak `coverGrid` (P3).
3. **Faz 3 — Geri bildirim ve güvenlik ağı:** sticky eylem çubuğu + dirty durumu, D1-D4, aria-live bildirim, busy durumu, yeni-yayın formu "Gelişmiş" katlaması, responsive ayarları (§6), dokümantasyon.
4. **Faz 4 — (onaya bağlı) backend iyileştirmeleri:** PRG + seçili yayın bağlamı taşıma, okunur HTML hata sayfaları.

## 10. Test planı

**Otomatik (mevcut altyapı: `node --test`, `npm test`):**
- Mevcut davranış testleri aynen geçmeli: alan adları/değerler, `esc` kaçışları, token'ın tüm action'larda olması, başlat/durdur formunun plan formundan ayrılığı, seçili yayının `&broadcast=` ile taşınması, onay metinleri (`confirm(...)`), güvenli küçük resim, kapak/klip listede olmayan yol davranışları (sunucu tarafı testleri zaten var).
- Yeni testler: segmented/switch'in doğru `name`/`value` ile aynı form verisini ürettiği (form alanı eşdeğerlik testi: eski ve yeni HTML'den çıkarılan `URLSearchParams` aynı), Pomodoro kapalıyken değerlerin gönderilmesi, her `input`'un bir `label`'a bağlı olması, `role=status/alert`, sticky çubuğun JS'siz de eylemleri barındırması, bağlamsal düğme (running→Durdur, stopped→Başlat, unknown→ikisi).
- Kontrast betiği: token çiftleri için ≥4.5:1 (metin) / ≥3:1 (bileşen kenarı).

**El ile (cihazda — şu an hiç yapılmamış borç):** Android Chrome (genişlik 360/412), iPad Safari dikey/yatay: yatay taşma yok, klavye açıkken sticky çubuk ve odaklı alan, `<details>` ve segmented dokunma hedefleri, galeri yükleme+uyarı, onay pencereleri, yeniden başlat akışı, ana ekran kısayolu. Gerçek hesapla uçtan uca yalnızca kullanıcı onayı ve ortamıyla (YouTube/systemd).

**Başarı ölçütü (gözlemlenebilir):** (1) "yayın çalışıyor mu" ilk ekranda; (2) yaygın görevler (başlık değiştir, kapak seç+kaydet, Pomodoro aç) için kaydırma/dokunma sayısı azalmış; (3) sayfa ilk ekran yüksekliğinin ~üçte biri klip listesi yerine durum/ana görevlerle dolu; (4) kaydedilmemiş değişiklik kaybı ve onaysız yeniden başlatma yok.

## 11. Riskler

- Satır içi JS miktarı büyür → küçük tutulur (yalnızca dirty/confirm/busy), tamamı JS'siz de çalışır (progressive enhancement).
- Switch/segmented'ın gizli `input`+`label` ile yapılması odak/erişilebilirliği bozabilir → `:focus-visible` ve klavye testi.
- Gerçek cihaz testi eksik → her faz sonunda elle kontrol listesi.
- Küçük resim ızgarası çok sayıda klipte daha çok `/config/thumb` isteği (120/dk sınırı) → mevcut `loading="lazy"` korunur; katlı bölümde resimler açılana kadar yüklenmez (`details` kapalıyken `lazy` zaten tetiklenmez).
