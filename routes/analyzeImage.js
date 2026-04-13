const express = require("express");
const router = express.Router();
const multer = require("multer");
const Anthropic = require("@anthropic-ai/sdk");
const { lookupFood, calcMacros } = require("../services/foodLookup");
const { pool } = require("../db");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const IMAGE_SYSTEM = `You are a nutrition expert analyzing meal photos.
Identify ALL visible foods and estimate realistic portion sizes.

Respond ONLY with a JSON object, no markdown, no explanations.

Format:
{
  "items": [
    {
      "name_en": "chicken breast",
      "name_de": "Hähnchenbrust",
      "weight_g": 180,
      "usda_query": "chicken breast cooked"
    }
  ]
}

Rules:
- List EVERY visible food separately
- Estimate realistic gram portions based on visual appearance
- name_de: German display name
- name_en: English name for database lookup
- usda_query: optimized English search term for USDA (e.g. "cooked", "raw")
- Typical portions: meat/poultry 150-200g, side dishes 100-200g, vegetables 80-150g, sauces 50-100g
- Be conservative and realistic`;

// POST /api/analyze-image
// Body: multipart/form-data, field "image" = image file
// Returns: { items: [...], description: "..." }
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
            text: IMAGE_SYSTEM,
          },
        ],
      }],
    });

    const raw = msg.content.map(b => b.text || "").join("");
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    console.log(`📸 Image analysis: ${parsed.items?.length || 0} items`);

    // Lookup macros for each item (same pipeline as analyze.js)
    const items = await Promise.all(
      (parsed.items || []).map(async (item) => {
        const searchTerm = (item.name_de || item.name_en || "").toLowerCase().trim();

        // Personal foods first — zweistufig gegen Fehlmatcher
        // Stufe A: Exakt oder Name beginnt mit Suchbegriff
        let personalResult = await pool.query(
          `SELECT * FROM user_foods
           WHERE user_id = $1
             AND (LOWER(name) = $2 OR LOWER(name) LIKE $3)
           ORDER BY
             CASE WHEN LOWER(name) = $2 THEN 0 ELSE 1 END,
             LENGTH(name) ASC
           LIMIT 1`,
          [req.userId, searchTerm, `${searchTerm}%`]
        );

        // Stufe B: "Enthält"-Suche nur mit Similarity-Schwellenwert >= 0.40
        if (personalResult.rows.length === 0 && searchTerm.length >= 4) {
          personalResult = await pool.query(
            `SELECT * FROM user_foods
             WHERE user_id = $1
               AND LOWER(name) ILIKE $2
               AND SIMILARITY(LOWER(name), $3) >= 0.40
             ORDER BY SIMILARITY(LOWER(name), $3) DESC, LENGTH(name) ASC
             LIMIT 1`,
            [req.userId, `%${searchTerm}%`, searchTerm]
          );
        }
        if (personalResult.rows.length > 0) {
          const pf = personalResult.rows[0];
          const macros = calcMacros(pf, item.weight_g);
          return {
            name_de: item.name_de || pf.name, weight_g: item.weight_g, ...macros,
            kcal_100: parseFloat(pf.kcal_100), protein_100: parseFloat(pf.protein_100),
            carbs_100: parseFloat(pf.carbs_100), fat_100: parseFloat(pf.fat_100),
            source: "personal", found: true,
          };
        }

        // Global food DB
        const food = await lookupFood(item.name_en, item.name_de, item.usda_query, true);
        if (food) {
          const macros = calcMacros(food, item.weight_g);
          return {
            name_de: item.name_de || food.name, weight_g: item.weight_g, ...macros,
            kcal_100: food.kcal_100, protein_100: food.protein_100,
            carbs_100: food.carbs_100, fat_100: food.fat_100,
            source: food.from_cache ? "cache" : "ai", food_id: food.id, found: true,
          };
        }

        return {
          name_de: item.name_de || item.name_en, weight_g: item.weight_g,
          kcal: 0, protein: 0, carbs: 0, fat: 0, source: "not_found", found: false,
        };
      })
    );

    res.json({ items });
  } catch (err) {
    console.error("analyzeImage error:", err);
    res.status(500).json({ error: "Bildanalyse fehlgeschlagen: " + err.message });
  }
});

module.exports = router;
