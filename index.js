require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { initDB } = require("./db");
const { requireAuth } = require("./middleware/auth");

const app = express();

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false, // CSP separat konfigurieren falls nötig
}));

const ALLOWED_ORIGINS = [
  "https://leonardthesandner.github.io",
  "https://makro-tracking.com",
  "https://www.makro-tracking.com",
  "capacitor://localhost",
  "https://localhost",
  "http://localhost",
  "http://localhost:3000",
  ...(process.env.EXTRA_ORIGIN ? [process.env.EXTRA_ORIGIN] : []),
];

app.use(cors({
  origin: (origin, cb) => {
    // Kein Origin = direkte Anfrage (curl, Postman, Railway health checks)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error("CORS: Origin nicht erlaubt"));
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"],
}));
app.options("*", cors());
app.use(express.json({ limit: "50kb" }));

// Trust proxy: Railway/Cloudflare setzen X-Forwarded-For korrekt
// → Rate-Limiter nutzt echte Client-IP statt Proxy-IP
// → verhindert IP-Spoofing-Bypass via gefälschtem X-Forwarded-For
app.set("trust proxy", 1);

// Rate Limiter
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minuten
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zu viele Versuche, bitte später erneut." },
});
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 Minute
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zu viele Anfragen, bitte warten." },
});

// Health check (kein Auth nötig)
app.get("/health", (req, res) => res.json({ status: "ok" }));

// E-Mail-Verifikation (öffentlich, kein Auth nötig)
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: "Zu viele Anfragen." } });
app.use("/verify", verifyLimiter, require("./routes/verify"));

// Strava public routes (webhook + OAuth callback — kein JWT nötig)
const { publicRouter: stravaPublic, authRouter: stravaAuth } = require("./routes/strava");
app.use("/api/strava", stravaPublic);

// Auth-Routen: Rate-Limit statt APP_SECRET
app.use("/api/auth", authLimiter, require("./routes/auth"));

// Admin-Routen: stufenweise IP-Sperre nach Fehlversuchen
// Stufe 1: 5 Fehlversuche → 30 Sekunden gesperrt
// Stufe 2: nächste 5 Fehlversuche → 5 Minuten gesperrt
// Stufe 3: nächste 5 Fehlversuche → 30 Minuten gesperrt
const adminAuthLimiter1 = rateLimit({
  windowMs: 30 * 1000,           // 30 Sekunden
  max: 5,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `admin_l1_${req.ip}`,
  message: { error: "Zu viele Fehlversuche. Bitte 30 Sekunden warten." },
});
const adminAuthLimiter2 = rateLimit({
  windowMs: 5 * 60 * 1000,       // 5 Minuten
  max: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `admin_l2_${req.ip}`,
  message: { error: "Zu viele Fehlversuche. Bitte 5 Minuten warten." },
});
const adminAuthLimiter3 = rateLimit({
  windowMs: 30 * 60 * 1000,      // 30 Minuten
  max: 15,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `admin_l3_${req.ip}`,
  message: { error: "Zu viele Fehlversuche. IP für 30 Minuten gesperrt." },
});
// Allgemeines Limit: 30 Anfragen/15 Min für eingeloggte Session
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Zu viele Admin-Anfragen." },
  skipSuccessfulRequests: false,
});
app.use("/api/admin", adminAuthLimiter1, adminAuthLimiter2, adminAuthLimiter3, adminLimiter, require("./routes/admin"));

// IP-Sperre aufheben (eigener Secret – unabhängig vom Admin-Key)
app.post("/api/admin-unlock", (req, res) => {
  const { secret, ip } = req.body;
  if (!process.env.UNLOCK_SECRET || secret !== process.env.UNLOCK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!ip) return res.status(400).json({ error: "ip erforderlich" });
  // Reset alle drei Limiter-Stufen für diese IP
  adminAuthLimiter1.resetKey(`admin_l1_${ip}`);
  adminAuthLimiter2.resetKey(`admin_l2_${ip}`);
  adminAuthLimiter3.resetKey(`admin_l3_${ip}`);
  console.log(`🔓 Admin-IP entsperrt: ${ip}`);
  res.json({ ok: true, ip });
});

// RevenueCat webhook (kein JWT – validiert eigenen Shared Secret)
// Muss VOR requireAuth registriert sein!
app.post("/api/subscription/revenuecat-webhook", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (secret && authHeader !== secret) {
    console.warn("RevenueCat webhook: ungültiger Secret");
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { pool } = require("./db");
  const event = req.body;
  const type  = event?.event?.type;
  const appUserId = event?.event?.app_user_id;
  console.log(`📱 RevenueCat webhook: type=${type}, user=${appUserId}`);
  if (!appUserId) return res.status(400).json({ error: "app_user_id fehlt" });
  try {
    const proActive   = ["INITIAL_PURCHASE","RENEWAL","UNCANCELLATION","BILLING_ISSUE_RESOLVED","PRODUCT_CHANGE"].includes(type);
    const proInactive = ["EXPIRATION","CANCELLATION"].includes(type);
    if (proActive)   { await pool.query("UPDATE users SET is_pro = true  WHERE id = $1", [appUserId]); console.log(`✅ is_pro=true  User ${appUserId}`); }
    if (proInactive) { await pool.query("UPDATE users SET is_pro = false WHERE id = $1", [appUserId]); console.log(`❌ is_pro=false User ${appUserId}`); }
    res.json({ ok: true });
  } catch (err) {
    console.error("RevenueCat webhook error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Alle anderen Routen: JWT erforderlich
app.use("/api", requireAuth);
app.use("/api/analyze",          aiLimiter, require("./routes/analyze"));
app.use("/api/analyze-recipe",       aiLimiter, require("./routes/analyzeRecipe"));
app.use("/api/analyze-recipe-image", aiLimiter, require("./routes/analyzeRecipeImage"));
app.use("/api/calculate-macros", aiLimiter, require("./routes/calculateMacros"));
app.use("/api/transcribe",       aiLimiter, require("./routes/transcribe"));
app.use("/api/analyze-image",    aiLimiter, require("./routes/analyzeImage"));
app.use("/api/recipes",        require("./routes/recipes"));
app.use("/api/foods",          require("./routes/foods"));
app.use("/api/diary",          require("./routes/diary"));
app.use("/api/archive",        require("./routes/archive"));
app.use("/api/settings",       require("./routes/settings"));
app.use("/api/barcode",        require("./routes/barcode"));
app.use("/api/user-foods",    require("./routes/userFoods"));
app.use("/api/body-weight",  require("./routes/bodyWeight"));
app.use("/api/account",      require("./routes/account"));
app.use("/api/subscription", require("./routes/subscription"));
app.use("/api/strava",      stravaAuth);
app.use("/api/pantry",     require("./routes/pantry"));

const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 makro-backend läuft auf Port ${PORT}`);
      console.log(`🤖 Anthropic Key: ${process.env.ANTHROPIC_API_KEY ? "✅" : "❌ fehlt"}`);
      console.log(`🔐 App Secret:    ${process.env.APP_SECRET ? "✅" : "❌ fehlt"}`);
      console.log(`🔑 JWT Secret:    ${process.env.JWT_SECRET ? "✅" : "❌ fehlt"}`);
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
