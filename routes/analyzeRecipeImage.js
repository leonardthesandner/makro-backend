const express = require("express");
const router = express.Router();
const multer = require("multer");
const Anthropic = require("@anthropic-ai/sdk");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// POST /api/analyze-recipe-image
// Body: multipart/form-data, field "image" = recipe image / screenshot
// Returns: { text: "500g Hähnchen\n2 EL Olivenöl\n..." }
router.post("/", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Kein Bild übermittelt" });

  const imageBase64 = req.file.buffer.toString("base64");
  const mediaType = req.file.mimetype || "image/jpeg";

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: imageBase64 },
          },
          {
            type: "text",
            text: `Du bist ein Koch-Assistent. Dieses Bild zeigt ein Rezept (Screenshot, Foto einer Rezeptkarte oder ähnliches).

Extrahiere NUR die Zutatenliste aus dem Bild.

Regeln:
- Eine Zutat pro Zeile
- Format: "Menge Einheit Zutatename" (z.B. "500g Hähnchenbrust", "2 EL Olivenöl", "1 Dose Tomaten 400g")
- Wenn die Menge in Gramm angegeben ist, behalte sie bei
- Wenn nur Stück/Scheiben/EL/TL angegeben: behalte die Original-Angabe
- Keine Überschriften, keine Schritte, keine Erklärungen
- Nur die reinen Zutaten als einfacher Text

Falls kein Rezept erkennbar ist (z.B. Tellerfoto oder anderes Bild), antworte mit: KEIN_REZEPT`,
          },
        ],
      }],
    });

    const text = msg.content.map(b => b.text || "").join("").trim();

    if (text === "KEIN_REZEPT") {
      return res.status(422).json({ error: "Kein Rezept erkannt. Bitte ein Foto eines Rezepts oder einen Screenshot hochladen." });
    }

    console.log(`📸 Recipe image analysis: extracted ${text.split("\n").length} ingredients`);
    res.json({ text });
  } catch (err) {
    console.error("analyzeRecipeImage error:", err);
    res.status(500).json({ error: "Bildanalyse fehlgeschlagen: " + err.message });
  }
});

module.exports = router;
