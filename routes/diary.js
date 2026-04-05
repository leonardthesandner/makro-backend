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

  // Cache AI-estimated foods now that user has confirmed the values
  const items = entry.items || [];
  for (const item of items) {
    if (item.source !== "ai") continue;
    const w = parseFloat(item.weight_g);
    if (!w || w <= 0) continue;

    const nameDe = (item.name_de || item.name || "").toLowerCase().trim();
    if (!nameDe) continue;

    // Convert per-serving to per-100g
    const kcal_100    = (item.kcal    || 0) / w * 100;
    const protein_100 = (item.protein || 0) / w * 100;
    const carbs_100   = (item.carbs   || 0) / w * 100;
    const fat_100     = (item.fat     || 0) / w * 100;

    // Basic plausibility check
    if (kcal_100 <= 0 || kcal_100 > 900) continue;

    try {
      // Upsert into foods table (skip if already exists)
      const existing = await pool.query(
        "SELECT id FROM foods WHERE LOWER(name_de) = $1",
        [nameDe]
      );

      let foodId;
      if (existing.rows.length > 0) {
        foodId = existing.rows[0].id;
      } else {
        const nameEn = (item.name_en || item.name || nameDe).trim();
        const inserted = await pool.query(
          `INSERT INTO foods (name_de, name_en, kcal_100, protein_100, carbs_100, fat_100, aliases, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'ai') RETURNING id`,
          [nameDe, nameEn, Math.round(kcal_100 * 10) / 10, Math.round(protein_100 * 10) / 10,
           Math.round(carbs_100 * 10) / 10, Math.round(fat_100 * 10) / 10, []]
        );
        foodId = inserted.rows[0].id;
      }

      // Cache the search term
      const alreadyCached = await pool.query(
        "SELECT id FROM food_searches WHERE search_term = $1",
        [nameDe]
      );
      if (alreadyCached.rows.length === 0) {
        await pool.query(
          "INSERT INTO food_searches (search_term, food_id) VALUES ($1, $2)",
          [nameDe, foodId]
        );
      }

      console.log(`✅ Food cached after user save: ${nameDe} (${Math.round(kcal_100)} kcal/100g)`);
    } catch (cacheErr) {
      console.error(`⚠️ Could not cache food ${nameDe}:`, cacheErr.message);
      // Don't fail the diary save if caching fails
    }
  }

  res.status(201).json({ ...result.rows[0].entry, id: result.rows[0].id });
});

// DELETE /api/diary/:id
router.delete("/:id", async (req, res) => {
  await pool.query("DELETE FROM diary_entries WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]);
  res.json({ ok: true });
});

module.exports = router;
