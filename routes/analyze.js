const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { parseWithClaude, PARSE_SYSTEM, hashText } = require("../services/parser");
const { lookupFood, calcMacros } = require("../services/foodLookup");

// POST /api/analyze
// Body: { text: "300g Hähnchen, 200g Reis", recipes: [{name, total_weight, kcal_100, ...}] }
// Returns: { items: [{name_de, weight_g, kcal, protein, carbs, fat, source, found}] }
router.post("/", async (req, res) => {
  console.log("🆕 analyze v2 (no USDA)");
  const { text, recipes = [] } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text required" });

  const inputHash = hashText(text.toLowerCase().trim() + "_v2");

  // 1. Parse-Cache prüfen (gleicher Input → gleiche Struktur)
  const parseCached = await pool.query(
    "SELECT result FROM parse_cache WHERE input_hash = $1",
    [inputHash]
  );

  let parsed;
  if (parseCached.rows.length > 0) {
    parsed = parseCached.rows[0].result;
    console.log(`📦 Parse cache hit: "${text.substring(0, 40)}"`);
  } else {
    const recipeNames = recipes.map((r) => r.name).join(", ");
    const systemWithRecipes = PARSE_SYSTEM +
      (recipeNames ? `\n\nGespeicherte Rezepte des Nutzers: ${recipeNames}` : "");

    try {
      parsed = await parseWithClaude(text, systemWithRecipes);
    } catch (err) {
      return res.status(500).json({ error: "Parse error: " + err.message });
    }

    await pool.query(
      "INSERT INTO parse_cache (input_hash, input_text, result) VALUES ($1, $2, $3) ON CONFLICT (input_hash) DO NOTHING",
      [inputHash, text, JSON.stringify(parsed)]
    );
    console.log(`🤖 Claude parsed: "${text.substring(0, 40)}"`);
  }

  // 2. Für jedes Item Makros aus DB holen (oder Claude schätzen lassen)
  const items = await Promise.all(
    (parsed.items || []).map(async (item) => {
      // Rezept-Referenz: Makros anteilig berechnen
      if (item.is_recipe && item.recipe_name) {
        const recipe = recipes.find(
          (r) => r.name.toLowerCase() === item.recipe_name.toLowerCase()
        );
        if (recipe) {
          const f = item.weight_g / recipe.total_weight;
          return {
            name_de:  `${recipe.name} · ${item.weight_g}g`,
            weight_g: item.weight_g,
            kcal:     Math.round(recipe.kcal_total * f),
            protein:  Math.round(recipe.protein_total * f * 10) / 10,
            carbs:    Math.round(recipe.carbs_total  * f * 10) / 10,
            fat:      Math.round(recipe.fat_total    * f * 10) / 10,
            source:   "recipe",
            found:    true,
          };
        }
      }

      // 0. Nutzereigene Datenbank zuerst prüfen
      const searchTerm = (item.name_de || item.name_en || "").toLowerCase().trim();
      const personalResult = await pool.query(
        `SELECT * FROM user_foods WHERE user_id = $1 AND (LOWER(name) = $2 OR LOWER(name) ILIKE $3) LIMIT 1`,
        [req.userId, searchTerm, `%${searchTerm}%`]
      );
      if (personalResult.rows.length > 0) {
        const pf = personalResult.rows[0];
        const macros = calcMacros(pf, item.weight_g);
        console.log(`⭐ Personal food hit: "${pf.name}" für User ${req.userId}`);
        return {
          name_de:     item.name_de || pf.name,
          weight_g:    item.weight_g,
          ...macros,
          kcal_100:    parseFloat(pf.kcal_100),
          protein_100: parseFloat(pf.protein_100),
          carbs_100:   parseFloat(pf.carbs_100),
          fat_100:     parseFloat(pf.fat_100),
          source:      "personal",
          found:       true,
        };
      }

      // 1. Globaler DB-Lookup (oder Claude-Schätzung ohne Speicherung — wird erst beim Diary-Save gecacht)
      const food = await lookupFood(item.name_en, item.name_de, item.usda_query, true);

      if (food) {
        const macros = calcMacros(food, item.weight_g);
        return {
          name_de:    item.name_de || food.name,
          weight_g:   item.weight_g,
          ...macros,
          kcal_100:    food.kcal_100,
          protein_100: food.protein_100,
          carbs_100:   food.carbs_100,
          fat_100:     food.fat_100,
          source:     food.from_cache ? "cache" : "ai",
          food_id:    food.id,
          found:      true,
        };
      }

      return {
        name_de:  item.name_de || item.name_en,
        weight_g: item.weight_g,
        kcal: 0, protein: 0, carbs: 0, fat: 0,
        source:   "not_found",
        found:    false,
      };
    })
  );

  const sources = items.reduce((acc, i) => {
    acc[i.source] = (acc[i.source] || 0) + 1;
    return acc;
  }, {});
  console.log("📊 Sources:", sources);

  res.json({ items });
});

module.exports = router;
