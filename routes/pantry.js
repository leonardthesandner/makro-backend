const express = require("express");
const router  = express.Router();
const multer  = require("multer");
const Anthropic = require("@anthropic-ai/sdk");
const { pool } = require("../db");
const { lookupFood } = require("../services/foodLookup");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Haiku macro estimator ────────────────────────────────────────────────────
async function estimateMacros(name) {
  try {
    // 1. Try DB lookup first (free + fast)
    const food = await lookupFood(name, name, name, false).catch(() => null);
    if (food) return { kcal_100: food.kcal_100, protein_100: food.protein_100, carbs_100: food.carbs_100, fat_100: food.fat_100, macro_source: "db" };

    // 2. Haiku estimate
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{ role: "user", content: `Nährwerte pro 100g für "${name}". Nur JSON, kein Markdown: {"kcal_100":X,"protein_100":X,"carbs_100":X,"fat_100":X}` }],
    });
    const raw = msg.content.map(b => b.text || "").join("").trim();
    const macros = JSON.parse(raw.replace(/```json|```/g, "").trim());
    return { ...macros, macro_source: "ki" };
  } catch { return null; }
}

// ─── GET /api/pantry ──────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM pantry_items WHERE user_id = $1 ORDER BY category, LOWER(name)",
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/pantry ─────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  let { name, quantity, unit, category, food_id, kcal_100, protein_100, carbs_100, fat_100 } = req.body;
  if (!name) return res.status(400).json({ error: "Name erforderlich" });
  try {
    let macro_source = req.body.macro_source || null;
    // Auto-analyze macros if not provided
    if (!kcal_100) {
      const macros = await estimateMacros(name.trim());
      if (macros) { kcal_100 = macros.kcal_100; protein_100 = macros.protein_100; carbs_100 = macros.carbs_100; fat_100 = macros.fat_100; macro_source = macros.macro_source; }
    }
    const result = await pool.query(
      `INSERT INTO pantry_items (user_id, name, quantity, unit, category, food_id, kcal_100, protein_100, carbs_100, fat_100, macro_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.userId, name.trim(), quantity ?? 1, unit || "Stück", category || "pantry",
       food_id || null, kcal_100 || null, protein_100 || null, carbs_100 || null, fat_100 || null, macro_source]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/pantry/bulk ────────────────────────────────────────────────────
router.post("/bulk", async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "items[] erforderlich" });
  try {
    const results = [];
    for (const item of items) {
      if (!item.name) continue;
      let { kcal_100, protein_100, carbs_100, fat_100, macro_source } = item;
      // Auto-analyze macros if missing
      if (!kcal_100) {
        const macros = await estimateMacros(item.name.trim());
        if (macros) { kcal_100 = macros.kcal_100; protein_100 = macros.protein_100; carbs_100 = macros.carbs_100; fat_100 = macros.fat_100; macro_source = macros.macro_source; }
      } else if (item.matched) {
        macro_source = "db";
      }
      const r = await pool.query(
        `INSERT INTO pantry_items (user_id, name, quantity, unit, category, food_id, kcal_100, protein_100, carbs_100, fat_100, macro_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [req.userId, item.name.trim(), item.quantity ?? 1, item.unit || "Stück", item.category || "pantry",
         item.food_id || null, kcal_100 || null, protein_100 || null, carbs_100 || null, fat_100 || null, macro_source || null]
      );
      results.push(r.rows[0]);
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/pantry/:id ────────────────────────────────────────────────────
router.patch("/:id", async (req, res) => {
  const { name, quantity, unit, category } = req.body;
  try {
    const result = await pool.query(
      `UPDATE pantry_items
       SET name     = COALESCE($1, name),
           quantity = COALESCE($2, quantity),
           unit     = COALESCE($3, unit),
           category = COALESCE($4, category),
           updated_at = NOW()
       WHERE id = $5 AND user_id = $6 RETURNING *`,
      [name || null, quantity ?? null, unit || null, category || null, req.params.id, req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Nicht gefunden" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/pantry/:id ───────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM pantry_items WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/pantry/deduct ──────────────────────────────────────────────────
// Reduces pantry quantities after a diary entry is added
// Body: { items: [{ name, weight_g, food_id }] }
router.post("/deduct", async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: "items[] erforderlich" });
  try {
    const deducted = [];
    for (const item of items) {
      let pantryItem = null;

      // 1. Match by food_id
      if (item.food_id) {
        const r = await pool.query(
          "SELECT * FROM pantry_items WHERE user_id=$1 AND food_id=$2 AND quantity > 0 ORDER BY quantity DESC LIMIT 1",
          [req.userId, item.food_id]
        );
        if (r.rows.length) pantryItem = r.rows[0];
      }

      // 2. Match by name (fuzzy)
      if (!pantryItem && item.name) {
        const searchName = item.name.toLowerCase();
        const r = await pool.query(
          "SELECT * FROM pantry_items WHERE user_id=$1 AND LOWER(name) ILIKE $2 AND quantity > 0 LIMIT 1",
          [req.userId, `%${searchName}%`]
        );
        if (r.rows.length) pantryItem = r.rows[0];
      }

      if (!pantryItem) continue;

      // Convert weight_g to pantry unit
      const unit = pantryItem.unit.toLowerCase();
      let deductAmt = 0;
      if (["g", "ml"].includes(unit)) {
        deductAmt = parseFloat(item.weight_g) || 0;
      } else if (["kg", "l"].includes(unit)) {
        deductAmt = (parseFloat(item.weight_g) || 0) / 1000;
      } else {
        deductAmt = 1; // Stück, Packung etc. → 1 abziehen
      }

      const newQty = Math.max(0, parseFloat(pantryItem.quantity) - deductAmt);
      await pool.query(
        "UPDATE pantry_items SET quantity=$1, updated_at=NOW() WHERE id=$2",
        [newQty, pantryItem.id]
      );
      deducted.push({ id: pantryItem.id, name: pantryItem.name, deducted: deductAmt, remaining: newQty });
    }
    res.json({ deducted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/pantry/scan ────────────────────────────────────────────────────
// Scans a receipt image and extracts food items
router.post("/scan", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Kein Bild übermittelt" });
  try {
    const imageBase64 = req.file.buffer.toString("base64");
    const mediaType   = req.file.mimetype || "image/jpeg";

    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: `Du analysierst einen deutschen Kassenbon. Extrahiere alle Lebensmittel.

WICHTIG: Erkenne automatisch die Packungsgröße aus dem Produktnamen auf dem Bon.
Beispiele:
- "Vollmilch 3,5% 1L" → name: "Vollmilch 3,5%", quantity: 1, unit: "L"
- "Nudeln 500g" → name: "Nudeln", quantity: 500, unit: "g"
- "Joghurt 6x150g" → name: "Joghurt", quantity: 900, unit: "g"
- "Mineralwasser 1,5L" → name: "Mineralwasser", quantity: 1.5, unit: "L"
- "Eier 10 Stück" → name: "Eier", quantity: 10, unit: "Stück"
- "Butter 250g" → name: "Butter", quantity: 250, unit: "g"

Falls keine Größe erkennbar: quantity: 1, unit: "Stück"

Für jedes Lebensmittel:
- name: Produktname auf Deutsch (ohne Größenangabe)
- quantity: Packungsgröße als Zahl
- unit: Einheit (g, kg, ml, L, Stück, Packung)
- category: "fridge" für Kühlware (Milch, Joghurt, Fleisch, Wurst, Käse, Eier, Obst, Gemüse) oder "pantry" für Trockenwaren (Nudeln, Reis, Konserven, Öl, Getränke, Süßigkeiten)
- barcode: EAN-Barcode falls auf dem Bon sichtbar, sonst null

Antworte NUR mit einem JSON-Array ohne Markdown:
[{"name":"Vollmilch 3,5%","quantity":1,"unit":"L","category":"fridge","barcode":null}]` }
        ]
      }]
    });

    const raw    = msg.content.map(b => b.text || "").join("");
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    console.log(`🧾 Receipt scan: ${parsed.length} items erkannt`);

    // Enrich each item with nutritional data
    const enriched = await Promise.all(parsed.map(async (item) => {
      let food = null;

      // 1. Barcode lookup
      if (item.barcode) {
        const r = await pool.query("SELECT * FROM foods WHERE barcode = $1 LIMIT 1", [item.barcode]);
        if (r.rows.length) food = r.rows[0];
      }

      // 2. DB name lookup
      if (!food) {
        food = await lookupFood(item.name, item.name, item.name, false).catch(() => null);
      }

      return {
        name:         item.name,
        quantity:     item.quantity || 1,
        unit:         item.unit || "Stück",
        category:     item.category || "pantry",
        food_id:      food?.id    || null,
        kcal_100:     food?.kcal_100    ?? null,
        protein_100:  food?.protein_100 ?? null,
        carbs_100:    food?.carbs_100   ?? null,
        fat_100:      food?.fat_100     ?? null,
        matched:      !!food,
        macro_source: food ? "db" : null,
      };
    }));

    res.json(enriched);
  } catch (err) {
    console.error("Receipt scan error:", err);
    res.status(500).json({ error: "Scan fehlgeschlagen: " + err.message });
  }
});

// ─── POST /api/pantry/recipes ─────────────────────────────────────────────────
// Body: { remaining_macros: {kcal,protein,carbs,fat}, prompt?: string }
router.post("/recipes", async (req, res) => {
  const { remaining_macros, prompt } = req.body;
  try {
    const pantryResult = await pool.query(
      "SELECT name, quantity, unit, category FROM pantry_items WHERE user_id=$1 AND quantity > 0 ORDER BY category, name",
      [req.userId]
    );

    if (!pantryResult.rows.length) {
      return res.json({ recipes: [], message: "Keine Vorräte vorhanden." });
    }

    const fridge  = pantryResult.rows.filter(i => i.category === "fridge");
    const pantry  = pantryResult.rows.filter(i => i.category === "pantry");
    const fmt     = (rows) => rows.map(i => `  - ${i.name}: ${parseFloat(i.quantity)} ${i.unit}`).join("\n");

    const macroText = remaining_macros
      ? `Verbleibende Tagesmakros:\n  - Kalorien: ${Math.round(remaining_macros.kcal || 0)} kcal\n  - Eiweiß: ${Math.round(remaining_macros.protein || 0)}g\n  - Kohlenhydrate: ${Math.round(remaining_macros.carbs || 0)}g\n  - Fett: ${Math.round(remaining_macros.fat || 0)}g`
      : "";

    const userMsg = prompt
      ? `Nutzeranfrage: "${prompt}"\n\n`
      : "";

    const aiPrompt = `${userMsg}Du bist ein Ernährungscoach. Schlage 2-3 einfache Gerichte vor.

Verfügbare Vorräte:
Kühlschrank:
${fridge.length ? fmt(fridge) : "  (leer)"}
Vorratskammer:
${pantry.length ? fmt(pantry) : "  (leer)"}

${macroText}

Verwende nur Zutaten die im Vorrat vorhanden sind. Die Rezepte sollen zu den verbleibenden Makros passen.

Antworte NUR mit einem JSON-Array (kein Markdown):
[{
  "name": "Rezeptname",
  "description": "Ein Satz Beschreibung",
  "ingredients": [{"name": "Zutat", "quantity": 100, "unit": "g"}],
  "steps": ["Schritt 1", "Schritt 2", "Schritt 3"],
  "macros": {"kcal": 400, "protein": 30, "carbs": 40, "fat": 12}
}]`;

    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: aiPrompt }]
    });

    const raw     = msg.content.map(b => b.text || "").join("");
    const recipes = JSON.parse(raw.replace(/```json|```/g, "").trim());
    console.log(`🍳 Pantry recipes: ${recipes.length} Vorschläge`);
    res.json({ recipes });
  } catch (err) {
    console.error("Pantry recipes error:", err);
    res.status(500).json({ error: "Rezeptvorschläge fehlgeschlagen: " + err.message });
  }
});

module.exports = router;
