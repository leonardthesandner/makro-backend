const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// GET /api/diary?date=YYYY-MM-DD  OR  ?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/", async (req, res) => {
  const { date, from, to } = req.query;
  if (date) {
    const result = await pool.query(
      "SELECT id, entry FROM diary_entries WHERE user_id = $1 AND date = $2 ORDER BY created_at ASC",
      [req.userId, date]
    );
    return res.json(result.rows.map(r => ({ ...r.entry, id: r.id })));
  }
  if (from && to) {
    const result = await pool.query(
      "SELECT id, date, entry FROM diary_entries WHERE user_id = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC, created_at ASC",
      [req.userId, from, to]
    );
    // group by date
    const map = {};
    result.rows.forEach(r => {
      const d = r.date.toISOString().split("T")[0];
      if (!map[d]) map[d] = [];
      map[d].push({ ...r.entry, id: r.id });
    });
    return res.json(map);
  }
  res.status(400).json({ error: "date oder from+to erforderlich" });
});

// POST /api/diary  body: { date, entry }
router.post("/", async (req, res) => {
  const { date, entry } = req.body;
  if (!date || !entry) return res.status(400).json({ error: "date und entry erforderlich" });
  const result = await pool.query(
    "INSERT INTO diary_entries (user_id, date, entry) VALUES ($1, $2, $3) RETURNING id, entry",
    [req.userId, date, JSON.stringify(entry)]
  );

  // Cache AI-estimated and barcode-scanned foods into global foods table
  const items = entry.items || [];
  for (const item of items) {
    const isAi      = item.source === "ai";
    const isBarcode = item.source === "barcode";
    if (!isAi && !isBarcode) continue;

    const w = parseFloat(item.weight_g);
    if (!w || w <= 0) continue;

    const nameDe = (item.name_de || item.name || "").toLowerCase().trim();
    if (!nameDe) continue;

    // Per-100g: barcode items already carry kcal_100 etc., AI items need conversion
    let kcal_100    = parseFloat(item.kcal_100);
    let protein_100 = parseFloat(item.protein_100);
    let carbs_100   = parseFloat(item.carbs_100);
    let fat_100     = parseFloat(item.fat_100);
    if (!(kcal_100 > 0)) {
      kcal_100    = (item.kcal    || 0) / w * 100;
      protein_100 = (item.protein || 0) / w * 100;
      carbs_100   = (item.carbs   || 0) / w * 100;
      fat_100     = (item.fat     || 0) / w * 100;
    }

    // Basic plausibility check
    if (kcal_100 <= 0 || kcal_100 > 900) continue;

    const barcode = item.barcode || null;
    const source  = isBarcode ? "barcode" : "ai";

    try {
      // For barcode items: match by barcode if available, otherwise by name
      let existing;
      if (barcode) {
        existing = await pool.query(
          "SELECT id FROM foods WHERE barcode = $1",
          [barcode]
        );
      }
      if (!existing || existing.rows.length === 0) {
        existing = await pool.query(
          "SELECT id FROM foods WHERE LOWER(name) = $1",
          [nameDe]
        );
      }

      let foodId;
      if (existing.rows.length > 0) {
        foodId = existing.rows[0].id;
        // For barcode items: update barcode field if it was missing
        if (barcode) {
          await pool.query(
            "UPDATE foods SET barcode = $1 WHERE id = $2 AND barcode IS NULL",
            [barcode, foodId]
          );
        }
      } else {
        const inserted = await pool.query(
          `INSERT INTO foods (name, kcal_100, protein_100, carbs_100, fat_100, aliases, source, barcode)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [nameDe,
           Math.round(kcal_100 * 10) / 10, Math.round(protein_100 * 10) / 10,
           Math.round(carbs_100 * 10) / 10, Math.round(fat_100 * 10) / 10,
           [], source, barcode]
        );
        foodId = inserted.rows[0].id;
      }

      // Cache the search term
      const alreadyCached = await pool.query(
        "SELECT id FROM food_searches WHERE query_norm = $1",
        [nameDe]
      );
      if (alreadyCached.rows.length === 0) {
        await pool.query(
          "INSERT INTO food_searches (query, food_id) VALUES ($1, $2) ON CONFLICT (query_norm) DO NOTHING",
          [nameDe, foodId]
        );
      }

      console.log(`✅ Food cached (${source}): ${nameDe} (${Math.round(kcal_100)} kcal/100g)${barcode ? ` [${barcode}]` : ""}`);
    } catch (cacheErr) {
      console.error(`⚠️ Could not cache food ${nameDe}:`, cacheErr.message);
      // Don't fail the diary save if caching fails
    }
  }

  // Bestätigte Lebensmittel in persönliche Datenbank übernehmen
  for (const item of items) {
    // Rezepte und bereits persönliche Einträge überspringen
    if (item.source === "recipe" || item.source === "personal") continue;

    const name = (item.name_de || item.name || "").trim();
    if (!name) continue;

    // Per-100g Werte: direkt aus item oder aus Portion hochrechnen
    let k = parseFloat(item.kcal_100);
    let p = parseFloat(item.protein_100);
    let c = parseFloat(item.carbs_100);
    let f = parseFloat(item.fat_100);
    if (!(k > 0)) {
      const w = parseFloat(item.weight_g);
      if (!w || w <= 0) continue;
      k = (parseFloat(item.kcal)    || 0) / w * 100;
      p = (parseFloat(item.protein) || 0) / w * 100;
      c = (parseFloat(item.carbs)   || 0) / w * 100;
      f = (parseFloat(item.fat)     || 0) / w * 100;
    }
    if (!(k > 0) || k > 900) continue;

    const serving = parseFloat(item.weight_g) > 0 ? parseFloat(item.weight_g) : null;
    try {
      const exists = await pool.query(
        "SELECT id FROM user_foods WHERE user_id = $1 AND LOWER(name) = $2",
        [req.userId, name.toLowerCase()]
      );
      if (exists.rows.length === 0) {
        await pool.query(
          "INSERT INTO user_foods (user_id, name, kcal_100, protein_100, carbs_100, fat_100, serving_g) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [req.userId, name, Math.round(k*10)/10, Math.round(p*10)/10, Math.round(c*10)/10, Math.round(f*10)/10, serving]
        );
        console.log(`⭐ Zu persönl. DB hinzugefügt: "${name}" für User ${req.userId}`);
      } else if (serving) {
        // Portionsgröße aktualisieren, wenn sich die Nutzungsgewohnheit ändert
        await pool.query(
          "UPDATE user_foods SET serving_g = $1 WHERE id = $2",
          [serving, exists.rows[0].id]
        );
      }
    } catch (err) {
      console.error(`⚠️ user_foods insert failed für "${name}":`, err.message);
    }
  }

  res.status(201).json({ ...result.rows[0].entry, id: result.rows[0].id });
});

// PATCH /api/diary/:id  body: { entry }
router.patch("/:id", async (req, res) => {
  const { entry } = req.body;
  if (!entry) return res.status(400).json({ error: "entry erforderlich" });
  const result = await pool.query(
    "UPDATE diary_entries SET entry = $1 WHERE id = $2 AND user_id = $3 RETURNING id, entry",
    [JSON.stringify(entry), req.params.id, req.userId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Eintrag nicht gefunden" });
  res.json({ ...result.rows[0].entry, id: result.rows[0].id });
});

// DELETE /api/diary/:id
router.delete("/:id", async (req, res) => {
  await pool.query("DELETE FROM diary_entries WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]);
  res.json({ ok: true });
});

module.exports = router;
