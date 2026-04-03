const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { parseWithClaude, RECIPE_PARSE_SYSTEM, hashText } = require("../services/parser");
const { lookupFood, calcMacros } = require("../services/foodLookup");

// POST /api/analyze-recipe
// Body: { text: "1000g rohes Hühnchen\n1 Dose Tomaten\n..." }
// Returns: { items: [...], totals: {kcal, protein, carbs, fat}, raw_weight_g }
router.post("/", async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text required" });

  const inputHash = "recipe_" + hashText(text.toLowerCase().trim());

  // Parse-Cache prüfen
  const parseCached = await pool.query(
    "SELECT result FROM parse_cache WHERE input_hash = $1",
    [inputHash]
  );

  let parsed;
  if (parseCached.rows.length > 0) {
    parsed = parseCached.rows[0].result;
  } else {
    try {
      parsed = await parseWithClaude(text, RECIPE_PARSE_SYSTEM);
    } catch (err) {
      return res.status(500).json({ error: "Parse error: " + err.message });
    }
    await pool.query(
      "INSERT INTO parse_cache (input_hash, input_text, result) VALUES ($1, $2, $3) ON CONFLICT (input_hash) DO NOTHING",
      [inputHash, text, JSON.stringify(parsed)]
    );
  }

  // Makros für alle Zutaten holen
  const items = await Promise.all(
    (parsed.items || []).map(async (item) => {
      const food = await lookupFood(item.name_en, item.name_de, item.usda_query);
      if (food) {
        const macros = calcMacros(food, item.weight_g);
        return {
          name_de:   item.name_de || food.name,
          name_usda: food.usda_name || food.name,
          weight_g:  item.weight_g,
          ...macros,
          source:    food.from_cache ? "cache" : "usda",
          found:     true,
        };
      }
      return {
        name_de:  item.name_de || item.name_en,
        weight_g: item.weight_g,
        kcal: 0, protein: 0, carbs: 0, fat: 0,
        source: "not_found",
        found: false,
      };
    })
  );

  const totals = items.reduce(
    (a, it) => ({ kcal: a.kcal + it.kcal, protein: a.protein + it.protein, carbs: a.carbs + it.carbs, fat: a.fat + it.fat }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  );

  const rawWeightG = items.reduce((s, it) => s + it.weight_g, 0);

  res.json({ items, totals, raw_weight_g: rawWeightG });
});

module.exports = router;
