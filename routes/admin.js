const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Auth ─────────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────
router.get("/stats", requireAdmin, async (req, res) => {
  try {
    const [foods, users, diary, searches] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM foods"),
      pool.query("SELECT COUNT(*) FROM users"),
      pool.query("SELECT COUNT(*) FROM diary_entries"),
      pool.query("SELECT COUNT(*) FROM food_searches"),
    ]);
    res.json({
      foods:    parseInt(foods.rows[0].count),
      users:    parseInt(users.rows[0].count),
      diary:    parseInt(diary.rows[0].count),
      searches: parseInt(searches.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/admin/db-check ──────────────────────────────────────────────────
router.get("/db-check", requireAdmin, async (req, res) => {
  try {
    const [duplicates, macroErrors, suspicious] = await Promise.all([
      checkDuplicates(),
      checkMacroErrors(),
      checkSuspicious(),
    ]);
    res.json({ duplicates, macroErrors, suspicious });
  } catch (err) {
    console.error("db-check error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/admin/food/:id ───────────────────────────────────────────────
router.delete("/food/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM foods WHERE id = $1", [req.params.id]);
    await pool.query("DELETE FROM food_searches WHERE food_id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/admin/food/:id ────────────────────────────────────────────────
router.patch("/food/:id", requireAdmin, async (req, res) => {
  const { kcal_100, protein_100, carbs_100, fat_100 } = req.body;
  try {
    await pool.query(
      `UPDATE foods SET
        kcal_100    = COALESCE($2, kcal_100),
        protein_100 = COALESCE($3, protein_100),
        carbs_100   = COALESCE($4, carbs_100),
        fat_100     = COALESCE($5, fat_100)
       WHERE id = $1`,
      [req.params.id, kcal_100, protein_100, carbs_100, fat_100]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/food/:id/verify ─────────────────────────────────────────
router.post("/food/:id/verify", requireAdmin, async (req, res) => {
  try {
    await pool.query(
      "UPDATE foods SET is_verified = true WHERE id = $1",
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/ai-check ─────────────────────────────────────────────────
// Body: { items: [{ id, name, kcal_100, protein_100, carbs_100, fat_100, barcode }] }
router.post("/ai-check", requireAdmin, async (req, res) => {
  const { items } = req.body;
  if (!items?.length) return res.status(400).json({ error: "items required" });

  const list = items.map(i =>
    `ID ${i.id}: "${i.name}" — ${i.kcal_100} kcal, ${i.protein_100}g P, ${i.carbs_100}g K, ${i.fat_100}g F${i.barcode ? ` (Barcode: ${i.barcode})` : ""}`
  ).join("\n");

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `Du bist ein Ernährungsexperte. Beurteile folgende Lebensmitteleinträge aus einer Nährwertdatenbank (Werte pro 100g). Prüfe ob Name und Nährwerte realistisch und stimmig sind.

${list}

Antworte mit einem JSON-Array:
[{ "id": <id>, "ok": true/false, "reason": "<kurze Begründung auf Deutsch, max 1 Satz>" }]

Nur das JSON-Array zurückgeben, kein weiterer Text.`
      }]
    });

    const text = msg.content[0].text.trim();
    const json = JSON.parse(text.replace(/```json|```/g, "").trim());
    res.json({ results: json });
  } catch (err) {
    console.error("ai-check error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Checks (nur nicht-verifizierte Einträge) ─────────────────────────────────

async function checkDuplicates() {
  const result = await pool.query(`
    SELECT
      a.id AS id_a, a.name AS name_a, a.barcode AS barcode_a, a.is_verified AS verified_a,
      a.kcal_100 AS kcal_a, a.protein_100 AS protein_a, a.carbs_100 AS carbs_a, a.fat_100 AS fat_a,
      b.id AS id_b, b.name AS name_b, b.barcode AS barcode_b, b.is_verified AS verified_b,
      b.kcal_100 AS kcal_b, b.protein_100 AS protein_b, b.carbs_100 AS carbs_b, b.fat_100 AS fat_b,
      ROUND(SIMILARITY(a.name_lower, b.name_lower)::numeric, 2) AS similarity
    FROM foods a
    JOIN foods b ON a.id < b.id
    WHERE SIMILARITY(a.name_lower, b.name_lower) > 0.80
      AND (a.is_verified = false OR a.is_verified IS NULL)
      AND (b.is_verified = false OR b.is_verified IS NULL)
    ORDER BY similarity DESC
    LIMIT 100
  `);
  return result.rows;
}

async function checkMacroErrors() {
  const result = await pool.query(`
    SELECT
      id, name, barcode, is_verified,
      kcal_100, protein_100, carbs_100, fat_100,
      ROUND((protein_100 * 4 + carbs_100 * 4 + fat_100 * 9)::numeric, 1) AS kcal_calc,
      ROUND(ABS(kcal_100 - (protein_100 * 4 + carbs_100 * 4 + fat_100 * 9))::numeric, 1) AS diff,
      CASE WHEN kcal_100 > 0
        THEN ROUND((ABS(kcal_100 - (protein_100 * 4 + carbs_100 * 4 + fat_100 * 9)) / kcal_100 * 100)::numeric, 1)
        ELSE NULL
      END AS diff_pct
    FROM foods
    WHERE kcal_100 IS NOT NULL AND protein_100 IS NOT NULL
      AND carbs_100 IS NOT NULL AND fat_100 IS NOT NULL
      AND kcal_100 > 0
      AND ABS(kcal_100 - (protein_100 * 4 + carbs_100 * 4 + fat_100 * 9)) > kcal_100 * 0.15
      AND (is_verified = false OR is_verified IS NULL)
    ORDER BY diff_pct DESC
    LIMIT 100
  `);
  return result.rows;
}

async function checkSuspicious() {
  const result = await pool.query(`
    SELECT id, name, barcode, is_verified,
      kcal_100, protein_100, carbs_100, fat_100,
      CASE
        WHEN kcal_100 IS NULL OR protein_100 IS NULL OR carbs_100 IS NULL OR fat_100 IS NULL
          THEN 'Fehlende Werte'
        WHEN kcal_100 < 0 OR protein_100 < 0 OR carbs_100 < 0 OR fat_100 < 0
          THEN 'Negative Werte'
        WHEN kcal_100 > 900
          THEN 'Kcal > 900 pro 100g'
        WHEN protein_100 > 100
          THEN 'Protein > 100g pro 100g'
        WHEN carbs_100 > 100
          THEN 'Kohlenhydrate > 100g pro 100g'
        WHEN fat_100 > 100
          THEN 'Fett > 100g pro 100g'
        WHEN kcal_100 = 0 AND (protein_100 > 5 OR carbs_100 > 5 OR fat_100 > 5)
          THEN 'Kcal = 0 aber Makros vorhanden'
        WHEN (protein_100 + carbs_100 + fat_100) > 105
          THEN 'Makros summieren > 105g'
      END AS problem
    FROM foods
    WHERE (
      kcal_100 IS NULL OR protein_100 IS NULL OR carbs_100 IS NULL OR fat_100 IS NULL
      OR kcal_100 < 0 OR protein_100 < 0 OR carbs_100 < 0 OR fat_100 < 0
      OR kcal_100 > 900
      OR protein_100 > 100 OR carbs_100 > 100 OR fat_100 > 100
      OR (kcal_100 = 0 AND (protein_100 > 5 OR carbs_100 > 5 OR fat_100 > 5))
      OR (protein_100 + carbs_100 + fat_100) > 105
    ) AND (is_verified = false OR is_verified IS NULL)
    ORDER BY kcal_100 DESC NULLS LAST
    LIMIT 100
  `);
  return result.rows;
}

module.exports = router;
