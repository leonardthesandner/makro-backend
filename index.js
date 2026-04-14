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

// Admin-Routen: x-admin-key + striktes Rate Limiting
// Allgemeines Limit: 30 Anfragen/15 Min (legitime Session hat max ~5-10 Calls gleichzeitig)
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Zu viele Admin-Anfragen." },
  skipSuccessfulRequests: false,
});
// Spezielles Auth-Limit: nur 5 Versuche/15 Min für jeden Endpoint-Zugriff mit falschem Key
// verhindert Key-Brute-Force effektiv
const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Zu viele fehlgeschlagene Admin-Zugriffsversuche. Bitte 15 Minuten warten." },
  skipSuccessfulRequests: true, // zählt nur 401-Responses
  keyGenerator: (req) => req.ip,
});
app.use("/api/admin", adminAuthLimiter, adminLimiter, require("./routes/admin"));

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
