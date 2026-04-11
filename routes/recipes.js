const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// GET /api/recipes
router.get("/", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM recipes WHERE user_id = $1 ORDER BY created_at DESC",
    [req.userId]
  );
  res.json(result.rows);
});

// POST /api/recipes
router.post("/", async (req, res) => {
  const { name, total_weight, kcal_total, protein_total, carbs_total, fat_total, ingredients, items, portion_g } = req.body;
  if (!name || !total_weight) return res.status(400).json({ error: "name und total_weight erforderlich" });

  const tw = parseFloat(total_weight);
  const result = await pool.query(
    `INSERT INTO recipes (user_id, name, total_weight, kcal_total, protein_total, carbs_total, fat_total,
       kcal_100, protein_100, carbs_100, fat_100, ingredients, items, portion_g)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      req.userId, name, tw,
      kcal_total, protein_total, carbs_total, fat_total,
      (kcal_total    / tw * 100),
      (protein_total / tw * 100),
      (carbs_total   / tw * 100),
      (fat_total     / tw * 100),
      ingredients,
      items ? JSON.stringify(items) : null,
      portion_g ? parseFloat(portion_g) : null,
    ]
  );
  res.status(201).json(result.rows[0]);
});

// PUT /api/recipes/:id
router.put("/:id", async (req, res) => {
  const { name, total_weight, kcal_total, protein_total, carbs_total, fat_total, ingredients, items, portion_g } = req.body;
  if (!name || !total_weight) return res.status(400).json({ error: "name und total_weight erforderlich" });

  const tw = parseFloat(total_weight);
  const result = await pool.query(
    `UPDATE recipes SET
       name=$1, total_weight=$2, kcal_total=$3, protein_total=$4, carbs_total=$5, fat_total=$6,
       kcal_100=$7, protein_100=$8, carbs_100=$9, fat_100=$10, ingredients=$11, items=$12, portion_g=$13
     WHERE id=$14 AND user_id=$15
     RETURNING *`,
    [
      name, tw, kcal_total, protein_total, carbs_total, fat_total,
      (kcal_total    / tw * 100),
      (protein_total / tw * 100),
      (carbs_total   / tw * 100),
      (fat_total     / tw * 100),
      ingredients,
      items ? JSON.stringify(items) : null,
      portion_g ? parseFloat(portion_g) : null,
      req.params.id, req.userId,
    ]
  );
  if (!result.rows.length) return res.status(404).json({ error: "nicht gefunden" });
  res.json(result.rows[0]);
});

// DELETE /api/recipes/:id
router.delete("/:id", async (req, res) => {
  await pool.query("DELETE FROM recipes WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]);
  res.json({ ok: true });
});

module.exports = router;
