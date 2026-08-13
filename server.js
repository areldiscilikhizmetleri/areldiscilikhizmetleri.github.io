/* =====================================================================
   Diş Protez Teknolojisi — Eğitim Sunucusu
   Kimlik doğrulama · ilerleme kaydı · süre takibi · notlar · admin API
   ===================================================================== */
require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const MS_CLIENT_ID = process.env.MS_CLIENT_ID || "";
const MS_TENANT = process.env.MS_TENANT || "common";
const ALLOWED_SUFFIX = (process.env.ALLOWED_SUFFIX || ".edu.tr").toLowerCase();
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
const DEV_LOGIN = process.env.DEV_LOGIN === "true";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

if (!SECRET || SECRET.length < 24) {
  console.error("HATA: JWT_SECRET tanımlı değil veya çok kısa. .env dosyasını doldurun.");
  process.exit(1);
}

/* ---------------------------------------------------------------------
   Veritabanı
   --------------------------------------------------------------------- */
const db = new Database(path.join(__dirname, "data.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  provider     TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'student',
  created_at   TEXT NOT NULL,
  first_login  TEXT,
  last_login   TEXT,
  last_seen    TEXT,
  login_count  INTEGER NOT NULL DEFAULT 0,
  total_seconds INTEGER NOT NULL DEFAULT 0,
  progress     TEXT NOT NULL DEFAULT '{}',
  admin_note   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  seconds    INTEGER NOT NULL DEFAULT 0,
  ip         TEXT,
  agent      TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  user_id    TEXT NOT NULL,
  module_id  TEXT NOT NULL,
  text       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, module_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

const nowISO = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/* ---------------------------------------------------------------------
   Uygulama
   --------------------------------------------------------------------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);   // nginx/Apache arkasında gerçek IP için
app.use(express.json({ limit: "512kb" }));

// CORS — yalnızca izin verilen sitelerden
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// iframe ile gömülmeye izin ver (yalnızca listelenen sitelerde)
app.use((req, res, next) => {
  if (ALLOWED_ORIGINS.length) {
    res.setHeader("Content-Security-Policy",
      "frame-ancestors 'self' " + ALLOWED_ORIGINS.join(" "));
  }
  next();
});

// Basit hız sınırı (kimlik uçları için)
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + ":" + req.path;
    const now = Date.now();
    const rec = hits.get(key) || { n: 0, t: now };
    if (now - rec.t > windowMs) { rec.n = 0; rec.t = now; }
    rec.n++; hits.set(key, rec);
    if (rec.n > max) return res.status(429).json({ error: "Çok fazla deneme. Biraz sonra tekrar deneyin." });
    next();
  };
}

/* ---------------------------------------------------------------------
   Yardımcılar
   --------------------------------------------------------------------- */
function domainOk(email) {
  const e = String(email || "").toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return false;
  if (ADMIN_EMAILS.includes(e)) return true;      // adminler uzantı kuralından muaf
  return e.endsWith(ALLOWED_SUFFIX);
}

function upsertUser({ email, name, provider }) {
  const e = email.toLowerCase().trim();
  const role = ADMIN_EMAILS.includes(e) ? "admin" : "student";
  let u = db.prepare("SELECT * FROM users WHERE email = ?").get(e);
  const t = nowISO();
  if (!u) {
    const id = uid();
    db.prepare(`INSERT INTO users (id,email,name,provider,role,created_at,first_login,last_login,last_seen,login_count)
                VALUES (?,?,?,?,?,?,?,?,?,1)`).run(id, e, name || e.split("@")[0], provider, role, t, t, t, t);
    u = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  } else {
    db.prepare(`UPDATE users SET name=?, provider=?, role=?, last_login=?, last_seen=?, login_count=login_count+1
                WHERE id=?`).run(name || u.name, provider, role, t, t, u.id);
    u = db.prepare("SELECT * FROM users WHERE id = ?").get(u.id);
  }
  return u;
}

function startSession(user, req) {
  const id = uid(), t = nowISO();
  db.prepare(`INSERT INTO sessions (id,user_id,started_at,last_seen,seconds,ip,agent)
              VALUES (?,?,?,?,0,?,?)`)
    .run(id, user.id, t, t, (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim(),
         String(req.headers["user-agent"] || "").slice(0, 200));
  return id;
}

function issueToken(user, sessionId) {
  return jwt.sign({ uid: user.id, sid: sessionId, role: user.role }, SECRET, { expiresIn: "12h" });
}

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, provider: u.provider,
    firstLogin: u.first_login, lastLogin: u.last_login, loginCount: u.login_count,
    totalSeconds: u.total_seconds
  };
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: "Oturum bulunamadı." });
  try {
    const p = jwt.verify(t, SECRET);
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(p.uid);
    if (!u) return res.status(401).json({ error: "Kullanıcı bulunamadı." });
    req.user = u; req.sid = p.sid;
    next();
  } catch {
    return res.status(401).json({ error: "Oturum süresi doldu. Yeniden giriş yapın." });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Bu alan yalnızca yöneticilere açıktır." });
  next();
}

function finishLogin(user, req, res) {
  const sid = startSession(user, req);
  const notes = {};
  db.prepare("SELECT module_id, text FROM notes WHERE user_id = ?").all(user.id)
    .forEach(n => notes[n.module_id] = n.text);
  res.json({
    token: issueToken(user, sid),
    user: publicUser(user),
    progress: JSON.parse(user.progress || "{}"),
    notes
  });
}

/* ---------------------------------------------------------------------
   Genel yapılandırma (istemci bunu okuyup düğmeleri kurar)
   --------------------------------------------------------------------- */
app.get("/api/config", (req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID,
    msClientId: MS_CLIENT_ID,
    msTenant: MS_TENANT,
    allowedSuffix: ALLOWED_SUFFIX,
    devLogin: DEV_LOGIN
  });
});

/* ---------------------------------------------------------------------
   GİRİŞ — Google
   Tarayıcıdan gelen id_token Google'ın kendi ucunda doğrulanır.
   --------------------------------------------------------------------- */
app.post("/api/auth/google", rateLimit(20, 60_000), async (req, res) => {
  try {
    const credential = req.body.credential;
    if (!credential) return res.status(400).json({ error: "Kimlik bilgisi eksik." });

    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
    if (!r.ok) return res.status(401).json({ error: "Google kimliği doğrulanamadı." });
    const p = await r.json();

    if (p.aud !== GOOGLE_CLIENT_ID) return res.status(401).json({ error: "Kimlik başka bir uygulamaya ait." });
    if (!["accounts.google.com", "https://accounts.google.com"].includes(p.iss))
      return res.status(401).json({ error: "Kimlik kaynağı geçersiz." });
    if (Number(p.exp) * 1000 < Date.now()) return res.status(401).json({ error: "Kimlik süresi dolmuş." });
    if (p.email_verified !== "true" && p.email_verified !== true)
      return res.status(401).json({ error: "E-posta adresi doğrulanmamış." });
    if (!domainOk(p.email))
      return res.status(403).json({ error: `Yalnızca ${ALLOWED_SUFFIX} uzantılı üniversite adresleri kabul edilir.` });

    finishLogin(upsertUser({ email: p.email, name: p.name, provider: "Google" }), req, res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Giriş sırasında sunucu hatası oluştu." });
  }
});

/* ---------------------------------------------------------------------
   GİRİŞ — Microsoft / Outlook
   Tarayıcıdan gelen access_token ile Microsoft Graph'a sorulur.
   --------------------------------------------------------------------- */
app.post("/api/auth/microsoft", rateLimit(20, 60_000), async (req, res) => {
  try {
    const accessToken = req.body.accessToken;
    if (!accessToken) return res.status(400).json({ error: "Kimlik bilgisi eksik." });

    const r = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: "Bearer " + accessToken }
    });
    if (!r.ok) return res.status(401).json({ error: "Microsoft kimliği doğrulanamadı." });
    const p = await r.json();

    const email = (p.mail || p.userPrincipalName || "").toLowerCase();
    if (!domainOk(email))
      return res.status(403).json({ error: `Yalnızca ${ALLOWED_SUFFIX} uzantılı üniversite adresleri kabul edilir.` });

    finishLogin(upsertUser({ email, name: p.displayName, provider: "Microsoft" }), req, res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Giriş sırasında sunucu hatası oluştu." });
  }
});

/* ---------------------------------------------------------------------
   GİRİŞ — geliştirme modu (yalnızca DEV_LOGIN=true iken)
   --------------------------------------------------------------------- */
app.post("/api/auth/dev", rateLimit(10, 60_000), (req, res) => {
  if (!DEV_LOGIN) return res.status(403).json({ error: "Parolasız giriş kapalı. Google veya Microsoft ile giriş yapın." });
  const { name, email } = req.body || {};
  if (!name || String(name).trim().length < 3) return res.status(400).json({ error: "Ad ve soyad gerekli." });
  if (!domainOk(email)) return res.status(403).json({ error: `Yalnızca ${ALLOWED_SUFFIX} uzantılı adresler kabul edilir.` });
  finishLogin(upsertUser({ email, name: String(name).trim(), provider: "e-posta" }), req, res);
});

/* ---------------------------------------------------------------------
   Öğrenci uçları
   --------------------------------------------------------------------- */
app.get("/api/me", auth, (req, res) => {
  const notes = {};
  db.prepare("SELECT module_id, text FROM notes WHERE user_id = ?").all(req.user.id)
    .forEach(n => notes[n.module_id] = n.text);
  res.json({ user: publicUser(req.user), progress: JSON.parse(req.user.progress || "{}"), notes });
});

app.post("/api/progress", auth, (req, res) => {
  const prog = req.body && req.body.progress;
  if (typeof prog !== "object" || prog === null) return res.status(400).json({ error: "Geçersiz ilerleme verisi." });
  const s = JSON.stringify(prog);
  if (s.length > 200_000) return res.status(413).json({ error: "İlerleme verisi çok büyük." });
  db.prepare("UPDATE users SET progress = ?, last_seen = ? WHERE id = ?").run(s, nowISO(), req.user.id);
  res.json({ ok: true });
});

// Süre takibi: istemci düzenli aralıklarla çağırır, süreyi sunucu sayar.
app.post("/api/heartbeat", auth, (req, res) => {
  const t = Date.now();
  const s = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.sid);
  let add = 0;
  if (s) {
    const delta = Math.floor((t - new Date(s.last_seen).getTime()) / 1000);
    add = Math.max(0, Math.min(delta, 120));  // sekme kapalıysa şişmesin: en çok 2 dakika
    db.prepare("UPDATE sessions SET last_seen = ?, seconds = seconds + ? WHERE id = ?")
      .run(new Date(t).toISOString(), add, req.sid);
  }
  db.prepare("UPDATE users SET total_seconds = total_seconds + ?, last_seen = ? WHERE id = ?")
    .run(add, new Date(t).toISOString(), req.user.id);
  const u = db.prepare("SELECT total_seconds FROM users WHERE id = ?").get(req.user.id);
  res.json({ ok: true, totalSeconds: u.total_seconds });
});

app.post("/api/notes", auth, (req, res) => {
  const { moduleId, text } = req.body || {};
  if (!moduleId || typeof text !== "string") return res.status(400).json({ error: "Geçersiz not." });
  if (text.length > 20_000) return res.status(413).json({ error: "Not çok uzun." });
  db.prepare(`INSERT INTO notes (user_id, module_id, text, updated_at) VALUES (?,?,?,?)
              ON CONFLICT(user_id, module_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`)
    .run(req.user.id, String(moduleId).slice(0, 40), text, nowISO());
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------
   Admin uçları
   --------------------------------------------------------------------- */
app.get("/api/admin/users", auth, adminOnly, (req, res) => {
  const rows = db.prepare(`SELECT id,email,name,provider,role,first_login,last_login,last_seen,login_count,total_seconds,progress
                           FROM users ORDER BY last_seen DESC`).all();
  res.json(rows.map(r => ({
    id: r.id, email: r.email, name: r.name, provider: r.provider, role: r.role,
    firstLogin: r.first_login, lastLogin: r.last_login, lastSeen: r.last_seen,
    loginCount: r.login_count, totalSeconds: r.total_seconds,
    progress: JSON.parse(r.progress || "{}")
  })));
});

app.get("/api/admin/users/:id", auth, adminOnly, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!u) return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  const sessions = db.prepare(`SELECT started_at, last_seen, seconds, ip, agent FROM sessions
                               WHERE user_id = ? ORDER BY started_at DESC LIMIT 100`).all(u.id);
  const notes = db.prepare("SELECT module_id, text, updated_at FROM notes WHERE user_id = ?").all(u.id);
  res.json({
    user: { ...publicUser(u), lastSeen: u.last_seen, adminNote: u.admin_note },
    progress: JSON.parse(u.progress || "{}"),
    sessions, notes
  });
});

app.post("/api/admin/note", auth, adminOnly, (req, res) => {
  const { userId, text } = req.body || {};
  if (!userId || typeof text !== "string") return res.status(400).json({ error: "Geçersiz istek." });
  db.prepare("UPDATE users SET admin_note = ? WHERE id = ?").run(text.slice(0, 5000), userId);
  res.json({ ok: true });
});

app.get("/api/admin/export.csv", auth, adminOnly, (req, res) => {
  const rows = db.prepare("SELECT * FROM users ORDER BY name").all();
  const esc = v => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const head = ["Ad Soyad", "E-posta", "Sağlayıcı", "Rol", "İlk giriş", "Son giriş", "Giriş sayısı",
                "Toplam süre (dk)", "Genel ilerleme %", "Yönetici notu"];
  const lines = [head.map(esc).join(",")];
  for (const r of rows) {
    let pct = 0;
    try {
      const mods = JSON.parse(r.progress || "{}").modules || {};
      const vals = Object.values(mods).map(m => {
        const total = (m.total || 6);
        const done = (m.read || []).length + (m.match ? 1 : 0) + ((m.exam ?? 0) >= 70 ? 1 : 0);
        return Math.min(100, Math.round(done / total * 100));
      });
      pct = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / 12) : 0;
    } catch {}
    lines.push([r.name, r.email, r.provider, r.role, r.first_login, r.last_login, r.login_count,
                Math.round(r.total_seconds / 60), pct, r.admin_note].map(esc).join(","));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="ogrenci-raporu.csv"');
  res.send("\uFEFF" + lines.join("\n"));
});

app.get("/api/health", (req, res) => res.json({ ok: true, time: nowISO() }));

/* ---------------------------------------------------------------------
   Statik dosyalar
   --------------------------------------------------------------------- */
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

app.listen(PORT, () => {
  console.log(`Eğitim sunucusu çalışıyor: http://localhost:${PORT}`);
  console.log(`Öğrenci: /            Yönetici: /admin`);
  if (DEV_LOGIN) console.log("UYARI: DEV_LOGIN açık — parolasız giriş etkin. Canlıda kapatın.");
  if (!GOOGLE_CLIENT_ID) console.log("Not: GOOGLE_CLIENT_ID boş, Google girişi kapalı.");
  if (!MS_CLIENT_ID) console.log("Not: MS_CLIENT_ID boş, Microsoft girişi kapalı.");
});
