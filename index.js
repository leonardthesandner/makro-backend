require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { initDB } = require("./db");
const { requireAuth } = require("./middleware/auth");

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-key", "Authorization"],
}));
app.options("*", cors());
app.use(express.json());

// Health check (kein Auth nötig)
app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// Auth-Routen: nur APP_SECRET nötig (kein JWT)
app.use("/api/auth", (req, res, next) => {
  if (req.headers["x-api-key"] !== process.env.APP_SECRET)
    return res.status(401).json({ error: "Unauthorized" });
  next();
}, require("./routes/auth"));

// Alle anderen Routen: JWT erforderlich
app.use("/api", requireAuth);
app.use("/api/analyze",        require("./routes/analyze"));
app.use("/api/analyze-recipe", require("./routes/analyzeRecipe"));
app.use("/api/recipes",        require("./routes/recipes"));
app.use("/api/foods",          require("./routes/foods"));

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
