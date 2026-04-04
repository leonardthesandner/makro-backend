require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { initDB } = require("./db");

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-key"],
}));
app.options("*", cors());
app.use(express.json());

// Einfacher API-Key-Schutz – verhindert fremde Nutzung
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const key = req.headers["x-api-key"];
  if (key !== process.env.APP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Routes
app.use("/api/analyze",        require("./routes/analyze"));
app.use("/api/analyze-recipe", require("./routes/analyzeRecipe"));
app.use("/api/recipes",        require("./routes/recipes"));
app.use("/api/foods",          require("./routes/foods"));

// Health check (kein API Key nötig)
app.get("/health", (req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 makro-backend läuft auf Port ${PORT}`);
      console.log(`🤖 Anthropic Key: ${process.env.ANTHROPIC_API_KEY ? "✅" : "❌ fehlt"}`);
      console.log(`🔐 App Secret:    ${process.env.APP_SECRET ? "✅" : "❌ fehlt"}`);
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
