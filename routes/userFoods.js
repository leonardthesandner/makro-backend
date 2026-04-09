const express = require("express");
const router  = express.Router();
const { pool } = require("../db");

// GET /api/user-foods
router.get("/", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM user_foods WHERE user_id = $1 ORDER BY created_at DESC",
    [req.userId]
  );
  res.json(result.rows);
});

// POST /api/user-foods
router.post("/", async (req, res) => {
  const { name, kcal_100, protein_100, carbs_100, fat_100, serving_g } = req.body;
  if (!name?.trim() || kcal_100 == null) return res.status(400).json({ error: "name und kcal_100 erforderlich" });
  const result = await pool.query(
    `INSERT INTO user_foods (user_id, name, kcal_100, protein_100, carbs_100, fat_100, serving_g)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [req.userId, name.trim(), parseFloat(kcal_100), parseFloat(protein_100)||0, parseFloat(carbs_100)||0, parseFloat(fat_100)||0, serving_g ? parseFloat(serving_g) : null]
  );
  res.status(201).json(result.rows[0]);
});

// PATCH /api/user-foods/:id
router.patch("/:id", async (req, res) => {
  const { name, kcal_100, protein_100, carbs_100, fat_100, serving_g } = req.body;
  if (!name?.trim() || kcal_100 == null) return res.status(400).json({ error: "name und kcal_100 erforderlich" });
  const result = await pool.query(
    `UPDATE user_foods SET name=$1, kcal_100=$2, protein_100=$3, carbs_100=$4, fat_100=$5, serving_g=$6
     WHERE id=$7 AND user_id=$8 RETURNING *`,
    [name.trim(), parseFloat(kcal_100), parseFloat(protein_100)||0, parseFloat(carbs_100)||0, parseFloat(fat_100)||0, serving_g ? parseFloat(serving_g) : null, req.params.id, req.userId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Nicht gefunden" });
  res.json(result.rows[0]);
});

// DELETE /api/user-foods/:id
router.delete("/:id", async (req, res) => {
  await pool.query("DELETE FROM user_foods WHERE id=$1 AND user_id=$2", [req.params.id, req.userId]);
  res.json({ ok: true });
});

module.exports = router;
