const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// GET /api/recipes?user_id=xxx
router.get("/", async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: "user_id required" });

  const result = await pool.query(
    "SELECT * FROM recipes WHERE user_id = $1 ORDER BY created_at DESC",
    [user_id]
  );
  res.json(result.rows);
});

// POST /api/recipes
// Body: { user_id, name, total_weight, kcal_total, protein_total, carbs_total, fat_total, ingredients }
router.post("/", async (req, res) => {
  const { user_id, name, total_weight, kcal_total, protein_total, carbs_total, fat_total, ingredients } = req.body;
  if (!user_id || !name || !total_weight) return res.status(400).json({ error: "user_id, name, total_weight required" });

  const tw = parseFloat(total_weight);
  const result = await pool.query(
    `INSERT INTO recipes (user_id, name, total_weight, kcal_total, protein_total, carbs_total, fat_total,
       kcal_100, protein_100, carbs_100, fat_100, ingredients)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      user_id, name, tw,
      kcal_total, protein_total, carbs_total, fat_total,
      (kcal_total    / tw * 100),
      (protein_total / tw * 100),
      (carbs_total   / tw * 100),
      (fat_total     / tw * 100),
      ingredients,
    ]
  );
  res.status(201).json(result.rows[0]);
});

// DELETE /api/recipes/:id
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;
  await pool.query("DELETE FROM recipes WHERE id = $1 AND user_id = $2", [id, user_id]);
  res.json({ ok: true });
});

module.exports = router;
