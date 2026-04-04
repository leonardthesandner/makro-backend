const { pool } = require("../db");
const { searchUSDA } = require("./usda");

// Sucht ein Lebensmittel: erst in DB, dann USDA, dann cachen
async function lookupFood(nameEn, nameDe, usdaQuery) {
  const searchTerm = (usdaQuery || nameEn || nameDe).toLowerCase().trim();

  // 1. In food_searches nachschauen (exakter Query-Cache)
  const cached = await pool.query(
    "SELECT f.* FROM food_searches fs JOIN foods f ON f.id = fs.food_id WHERE fs.query_norm = $1",
    [searchTerm]
  );
  if (cached.rows.length > 0 && parseFloat(cached.rows[0].kcal_100) > 0) {
    return { ...cached.rows[0], from_cache: true };
  }

  // 2. In foods tabelle suchen (Namens-Match)
  const nameMatch = await pool.query(
    `SELECT * FROM foods
     WHERE (name_lower ILIKE $1 OR $2 = ANY(aliases))
       AND kcal_100 > 0
     ORDER BY CASE WHEN name_lower = $2 THEN 0 ELSE 1 END
     LIMIT 1`,
    [`%${searchTerm}%`, searchTerm]
  );
  if (nameMatch.rows.length > 0) {
    // Query in Suchcache eintragen
    await saveFoodSearch(searchTerm, nameMatch.rows[0].id);
    return { ...nameMatch.rows[0], from_cache: true };
  }

  // 3. USDA API anfragen
  try {
    const results = await searchUSDA(usdaQuery || nameEn, 5);
    if (results.length === 0) return null;

    // Bestes Ergebnis nehmen (erstes = relevantestes laut USDA)
    const best = results[0];
    if (!best.kcal_100 || best.kcal_100 <= 0) return null;

    // In foods Tabelle speichern
    const saved = await pool.query(
      `INSERT INTO foods (fdc_id, name, kcal_100, protein_100, carbs_100, fat_100, source, aliases)
       VALUES ($1, $2, $3, $4, $5, $6, 'usda', $7)
       ON CONFLICT (fdc_id) DO UPDATE SET
         kcal_100 = EXCLUDED.kcal_100,
         protein_100 = EXCLUDED.protein_100,
         carbs_100 = EXCLUDED.carbs_100,
         fat_100 = EXCLUDED.fat_100
       RETURNING *`,
      [
        best.fdc_id,
        nameDe || best.name, // deutschen Namen bevorzugen
        best.kcal_100,
        best.protein_100,
        best.carbs_100,
        best.fat_100,
        nameDe ? [nameDe.toLowerCase(), nameEn?.toLowerCase(), searchTerm].filter(Boolean) : [searchTerm],
      ]
    );

    const food = saved.rows[0];
    await saveFoodSearch(searchTerm, food.id);
    return { ...food, from_cache: false, usda_name: best.name };
  } catch (err) {
    console.error("USDA lookup failed:", err.message);
    return null;
  }
}

async function saveFoodSearch(queryNorm, foodId) {
  await pool.query(
    `INSERT INTO food_searches (query, food_id) VALUES ($1, $2)
     ON CONFLICT (query_norm) DO UPDATE SET food_id = EXCLUDED.food_id`,
    [queryNorm, foodId]
  );
}

// Makros für eine bestimmte Menge berechnen
function calcMacros(food, weightG) {
  const f = weightG / 100;
  return {
    kcal:    Math.round(food.kcal_100    * f),
    protein: Math.round(food.protein_100 * f * 10) / 10,
    carbs:   Math.round(food.carbs_100   * f * 10) / 10,
    fat:     Math.round(food.fat_100     * f * 10) / 10,
  };
}

module.exports = { lookupFood, calcMacros };
