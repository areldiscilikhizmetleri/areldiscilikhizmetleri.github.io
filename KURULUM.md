# Kurulum ve Siteye Entegrasyon Kılavuzu

Diş Protez Teknolojisi İnteraktif Eğitim Uygulaması — sunucu, öğrenci arayüzü ve yönetim paneli.

## Dosyalar

```
server.js            Sunucu: kimlik doğrulama, ilerleme, süre takibi, notlar, admin API
package.json         Bağımlılıklar
.env.example         Ayar şablonu (kopyalayıp .env yapın)
public/index.html    Öğrenci uygulaması (12 modül)
public/admin.html    Yönetim paneli
data.db              İlk çalıştırmada kendiliğinden oluşur (SQLite)
```

---

## 1. Sunucuyu çalıştırma

Gereken: **Node.js 18.17 veya üzeri**.

```bash
npm install
cp .env.example .env      # sonra .env dosyasını doldurun
npm start
```

`.env` içinde en az şunlar dolu olmalı:

```
JWT_SECRET=...            # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
GOOGLE_CLIENT_ID=...
MS_CLIENT_ID=...
ADMIN_EMAILS=sizin.adresiniz@universite.edu.tr
DEV_LOGIN=false           # canlıda mutlaka false
ALLOWED_ORIGINS=https://www.universite.edu.tr
```

Açılınca: öğrenci arayüzü `http://localhost:3000`, yönetim paneli `http://localhost:3000/admin`.

**ADMIN_EMAILS listesindeki adresler otomatik olarak yönetici olur.** Panele girmek için ayrı bir parola yoktur; aynı Google/Microsoft hesabıyla giriş yapılır, sunucu rolü kendisi belirler.

---

## 2. Google girişini açma

1. [Google Cloud Console](https://console.cloud.google.com) → yeni proje.
2. **APIs & Services → OAuth consent screen** → Internal (üniversite Workspace hesabıysa) veya External.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
4. *Authorized JavaScript origins* alanına uygulamanın çalışacağı adresleri ekleyin:
   - `https://protez.universite.edu.tr`
   - geliştirme için `http://localhost:3000`
5. Üretilen **Client ID**'yi `.env` içindeki `GOOGLE_CLIENT_ID` alanına yazın.

Not: Yönlendirme (redirect URI) gerekmez; Google Identity Services jetonu doğrudan sayfaya verir, doğrulamayı sunucu yapar.

## 3. Microsoft / Outlook girişini açma

1. [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID → App registrations → New registration**.
2. *Supported account types*: yalnızca üniversite hesapları için "Single tenant"; kişisel Outlook adresleri de olacaksa "Multitenant".
3. *Redirect URI* → platform **Single-page application (SPA)** → uygulamanın adresi (`https://protez.universite.edu.tr/`).
4. **API permissions** → Microsoft Graph → Delegated → `User.Read` → ekleyin.
5. **Application (client) ID** değerini `.env` içindeki `MS_CLIENT_ID` alanına yazın.
   Tek kiracıysa `MS_TENANT` alanına Directory (tenant) ID'yi yazın; değilse `common` bırakın.

> `.edu.tr` denetimi her iki sağlayıcıda da **sunucu tarafında** yapılır. Kullanıcı tarayıcıdaki kodu değiştirse bile başka uzantılı adresle giriş yapamaz.

---

## 4. Siteye entegrasyon — üç yol

### A) Alt alan adı (önerilen)

`protez.universite.edu.tr` alt alan adını sunucuya yönlendirin, önüne nginx koyun:

```nginx
server {
  listen 443 ssl;
  server_name protez.universite.edu.tr;
  ssl_certificate     /etc/letsencrypt/live/protez.universite.edu.tr/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/protez.universite.edu.tr/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Sitenizin menüsünden bu adrese bağlantı verin. En temiz ve en az sorun çıkaran yöntem budur.

### B) Mevcut sitenin bir yolu altında

Ana sitede `/egitim` yolunu sunucuya yönlendirin:

```nginx
location /egitim/ { proxy_pass http://127.0.0.1:3000/; ... }
location /api/    { proxy_pass http://127.0.0.1:3000/api/; ... }
```

`/api` yolunun da aynı alan adında görünmesi gerekir; aksi halde `public/index.html` ve `public/admin.html` içindeki `apiBase` / `API` değerlerini tam adrese çevirin.

### C) iframe ile gömme

Sayfanıza:

```html
<iframe src="https://protez.universite.edu.tr/"
        style="width:100%;height:100vh;border:0"
        allow="fullscreen"></iframe>
```

Bunun için `.env` içindeki `ALLOWED_ORIGINS` alanına gömüleceği sitenin adresini eklemeniz gerekir; sunucu `frame-ancestors` başlığını buna göre kurar.

> Uyarı: Google giriş penceresi bazı tarayıcılarda iframe içinde engellenir. iframe kullanacaksanız giriş ekranına "yeni sekmede aç" bağlantısı koymak veya A seçeneğini tercih etmek daha güvenlidir.

### WordPress kullanıyorsanız

Bir sayfa oluşturup **Custom HTML** bloğuna yukarıdaki iframe kodunu yapıştırmanız yeterli. Sunucu yine ayrı çalışır; WordPress yalnızca çerçeveyi gösterir.

---

## 5. Yönetim panelinde ne görürsünüz

| Alan | İçerik |
|---|---|
| Üst şerit | Kayıtlı öğrenci, son 7 günde aktif, ortalama ilerleme, tüm modülleri bitiren, toplam çalışma süresi |
| Liste | Ad-soyad, e-posta, ilerleme yüzdesi, geçilen test sayısı, toplam süre, giriş sayısı, son etkinlik |
| Öğrenci detayı | İlk giriş, son giriş, son etkinlik, oturum geçmişi (başlangıç–bitiş–süre), modül modül döküm, her modüldeki test yüzdesi |
| Notlar | Öğrencinin modül not defteri + yalnızca yöneticilerin gördüğü değerlendirme notu |
| Dışa aktarma | Tüm öğrenciler için CSV (Excel'de açılır, Türkçe karakter uyumlu) |

Filtreler: arama, "son 7 gün aktif", "ilerlemesi %25 altı". Sütun başlıklarına tıklayınca sıralama değişir. Liste 2 dakikada bir kendiliğinden yenilenir.

---

## 6. Süre takibi nasıl çalışır

Öğrenci arayüzü 30 saniyede bir sunucuya sinyal gönderir. Sunucu iki sinyal arasındaki farkı sayar ve **en çok 120 saniye** ekler. Böylece sekme açık unutulduğunda ya da bilgisayar uyku moduna geçtiğinde süre şişmez. Sekme arka plandayken sinyal gönderilmez, yani yalnızca ekranda geçirilen zaman sayılır.

---

## 7. Güvenlik kontrol listesi

- [ ] `JWT_SECRET` rastgele ve uzun, kimseyle paylaşılmıyor
- [ ] `DEV_LOGIN=false`
- [ ] Site HTTPS üzerinden yayında (Let's Encrypt yeterli)
- [ ] `ALLOWED_ORIGINS` yalnızca kendi alan adlarınızı içeriyor
- [ ] `data.db` dosyası düzenli yedekleniyor (`cp data.db yedek/$(date +%F).db`)
- [ ] KVKK: öğrenci adı, e-posta, giriş zamanı ve süre kaydedildiği için aydınlatma metni yayımlanmalı

Sunucuyu sürekli açık tutmak için:

```bash
sudo npm install -g pm2
pm2 start server.js --name protez-egitim
pm2 save && pm2 startup
```

---

## 8. Video ekleme

`public/index.html` içindeki `CONFIG.videos` alanına modül kimliği ve YouTube video kimliğini yazın:

```js
videos: { m1:"AbCdEfGhIjK", m2:"LmNoPqRsTuV" }
```

Kimlik, `youtube.com/watch?v=` kısmından sonraki bölümdür. Boş bırakılan modüllerde yer tutucu görünür.

---

## 9. Sık karşılaşılan sorunlar

**"Sunucuya bağlanılamadı" uyarısı**  
`apiBase` yanlış ya da sunucu kapalı. `https://adresiniz/api/health` adresini tarayıcıda açıp `{"ok":true}` dönüyor mu bakın.

**Google düğmesi tepki vermiyor**  
Client ID boş veya sitenin adresi *Authorized JavaScript origins* listesinde yok.

**"Bu hesabın yönetici yetkisi yok"**  
E-posta `ADMIN_EMAILS` içinde değil ya da sunucu `.env` değişikliğinden sonra yeniden başlatılmadı.

**Microsoft girişi açılıp kapanıyor**  
Azure kaydında platform "Single-page application" olarak seçilmemiş olabilir; "Web" seçiliyse jeton tarayıcıya verilmez.
