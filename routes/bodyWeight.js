const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// GET /api/body-weight?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/", async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: "Ungültige Parameter" });
  }
  try {
    const result = await pool.query(
      `SELECT date::text, weight_kg, burned_kcal FROM body_weight WHERE user_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date`,
      [req.userId, from, to]
    );
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Fehler beim Laden" });
  }
});

// POST /api/body-weight — upsert für ein Datum (weight_kg und/oder burned_kcal)
router.post("/", async (req, res) => {
  const { date, weight_kg, burned_kcal } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Ungültiges Datum" });

  const w = weight_kg != null ? parseFloat(weight_kg) : null;
  const b = burned_kcal != null ? parseFloat(burned_kcal) : null;

  if (w != null && (w < 20 || w > 500)) return res.status(400).json({ error: "Gewicht muss zwischen 20 und 500 kg liegen" });
  if (b != null && (b < 0 || b > 10000)) return res.status(400).json({ error: "Verbrannte kcal ungültig" });
  if (w == null && b == null) return res.status(400).json({ error: "weight_kg oder burned_kcal erforderlich" });

  try {
    const result = await pool.query(
      `INSERT INTO body_weight (user_id, date, weight_kg, burned_kcal)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, date) DO UPDATE SET
         weight_kg   = COALESCE($3, body_weight.weight_kg),
         burned_kcal = COALESCE($4, body_weight.burned_kcal)
       RETURNING date::text, weight_kg, burned_kcal`,
      [req.userId, date, w, b]
    );
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: "Fehler beim Speichern" });
  }
});

module.exports = router;
