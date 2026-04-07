const { pool } = require("../db");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Schätzt Makros per 100g via Claude und speichert sie in der DB
async function estimateAndSave(nameDe, nameEn) {
  const label = nameDe || nameEn;
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `Du bist ein Ernährungsexperte. Gib die Makronährstoffe PRO 100G für das genannte Lebensmittel an.
WICHTIG: Alle Werte müssen sich auf exakt 100g beziehen, nicht auf eine Portion.
Beispiele: Hähnchenbrust roh = 110 kcal, Vollmilch = 64 kcal, Weißbrot = 265 kcal (jeweils pro 100g).
Gib außerdem bis zu 5 Synonyme/alternative Bezeichnungen auf Deutsch an (Kurzformen, Markennamen, Schreibvarianten).
Antworte NUR mit JSON, keine Erklärungen:
{"kcal_100": number, "protein_100": number, "carbs_100": number, "fat_100": number, "synonyme": ["synonym1", "synonym2"]}`,
    messages: [{ role: "user", content: label }],
  });

  const raw = msg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
  const per100 = JSON.parse(raw);

  if (!per100.kcal_100 || per100.kcal_100 <= 0) throw new Error("Claude returned 0 kcal");
  if (per100.kcal_100 > 900) throw new Error(`Unrealistischer kcal-Wert: ${per100.kcal_100} (max 900/100g)`);
  const macroSum = (per100.protein_100 * 4) + (per100.carbs_100 * 4) + (per100.fat_100 * 9);
  if (macroSum > 0 && Math.abs(macroSum - per100.kcal_100) > per100.kcal_100 * 0.3) {
    console.warn(`⚠️ Makro-Plausibilität für "${label}": kcal=${per100.kcal_100}, berechnet=${Math.round(macroSum)}`);
  }

  // Synonyme normalisieren (max 5, lowercase)
  const synonyme = [label.toLowerCase(), ...(per100.synonyme || []).map(s => s.toLowerCase())]
    .filter((s, i, arr) => s && arr.indexOf(s) === i)
    .slice(0, 5);

  // In foods Tabelle speichern
  const saved = await pool.query(
    `INSERT INTO foods (name, kcal_100, protein_100, carbs_100, fat_100, source, aliases)
     VALUES ($1, $2, $3, $4, $5, 'ai', $6)
     RETURNING *`,
    [label, per100.kcal_100, per100.protein_100, per100.carbs_100, per100.fat_100, synonyme]
  );

  const food = saved.rows[0];
  console.log(`🤖 Claude schätzte "${label}": ${per100.kcal_100} kcal/100g, Synonyme: [${synonyme.join(", ")}] → id=${food.id}`);
  return food;
}

// Sucht ein Lebensmittel: erst in DB, dann Claude
async function lookupFood(nameEn, nameDe, usdaQuery, estimateOnly = false) {
  // name_de als primärer Such-Key (stabiler als usda_query)
  const searchTerm = (nameDe || nameEn || "").toLowerCase().trim();

  // 1. In food_searches nachschauen (exakter Query-Cache)
  const cached = await pool.query(
    "SELECT f.* FROM food_searches fs JOIN foods f ON f.id = fs.food_id WHERE fs.query_norm = $1",
    [searchTerm]
  );
  if (cached.rows.length > 0 && parseFloat(cached.rows[0].kcal_100) > 0) {
    console.log(`📦 DB cache hit: "${searchTerm}" (${cached.rows[0].kcal_100} kcal/100g)`);
    return { ...cached.rows[0], from_cache: true };
  }

  // 2. In foods Tabelle suchen (Name oder Synonym)
  // ILIKE nur bei Begriffen ≥ 4 Zeichen, sonst nur exakter Treffer (verhindert z.B. "ei" → "Eiweiß")
  const useIlike = searchTerm.length >= 4;
  const nameMatch = await pool.query(
    useIlike
      ? `SELECT * FROM foods
         WHERE (name_lower = $1 OR $1 = ANY(aliases) OR name_lower ILIKE $2)
           AND kcal_100 > 0
         ORDER BY CASE WHEN name_lower = $1 OR $1 = ANY(aliases) THEN 0 ELSE 1 END
         LIMIT 1`
      : `SELECT * FROM foods
         WHERE (name_lower = $1 OR $1 = ANY(aliases))
           AND kcal_100 > 0
         LIMIT 1`,
    useIlike ? [searchTerm, `%${searchTerm}%`] : [searchTerm]
  );
  if (nameMatch.rows.length > 0) {
    await saveFoodSearch(searchTerm, nameMatch.rows[0].id);
    console.log(`📦 DB name match: "${searchTerm}" → "${nameMatch.rows[0].name}"`);
    return { ...nameMatch.rows[0], from_cache: true };
  }

  // 3. Claude schätzt — speichert nur wenn estimateOnly === false
  try {
    if (estimateOnly) {
      // Nur schätzen, nicht in DB speichern
      const label = nameDe || nameEn;
      const msg = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: `Du bist ein Ernährungsexperte. Gib die Makronährstoffe PRO 100G für das genannte Lebensmittel an.
WICHTIG: Alle Werte müssen sich auf exakt 100g beziehen, nicht auf eine Portion.
Beispiele: Hähnchenbrust roh = 110 kcal, Vollmilch = 64 kcal, Weißbrot = 265 kcal (jeweils pro 100g).
Gib außerdem bis zu 5 Synonyme/alternative Bezeichnungen auf Deutsch an (Kurzformen, Markennamen, Schreibvarianten).
Antworte NUR mit JSON, keine Erklärungen:
{"kcal_100": number, "protein_100": number, "carbs_100": number, "fat_100": number, "synonyme": ["synonym1", "synonym2"]}`,
        messages: [{ role: "user", content: label }],
      });
      const raw = msg.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
      const per100 = JSON.parse(raw);
      if (!per100.kcal_100 || per100.kcal_100 <= 0) throw new Error("Claude returned 0 kcal");
      if (per100.kcal_100 > 900) throw new Error(`Unrealistischer kcal-Wert: ${per100.kcal_100} (max 900/100g)`);
      console.log(`🤖 Claude schätzte (estimateOnly) "${label}": ${per100.kcal_100} kcal/100g`);
      return {
        name: label,
        name_de: nameDe || label,
        name_en: nameEn || label,
        kcal_100:    per100.kcal_100,
        protein_100: per100.protein_100,
        carbs_100:   per100.carbs_100,
        fat_100:     per100.fat_100,
        source:      "ai",
        found:       true,
        from_cache:  false,
      };
    } else {
      const food = await estimateAndSave(nameDe, nameEn);
      await saveFoodSearch(searchTerm, food.id);
      return { ...food, from_cache: false };
    }
  } catch (err) {
    console.error(`❌ Claude estimation failed for "${nameDe || nameEn}":`, err.message);
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
