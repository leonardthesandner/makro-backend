const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// GET /api/archive
router.get("/", async (req, res) => {
  const result = await pool.query(
    "SELECT id, recipe FROM mealprep_archive WHERE user_id = $1 ORDER BY created_at ASC",
    [req.userId]
  );
  res.json(result.rows.map(r => ({ ...r.recipe, _archive_id: r.id })));
});

// POST /api/archive  body: { recipe }
router.post("/", async (req, res) => {
  const { recipe } = req.body;
  if (!recipe) return res.status(400).json({ error: "recipe erforderlich" });
  const result = await pool.query(
    "INSERT INTO mealprep_archive (user_id, recipe) VALUES ($1, $2) RETURNING id, recipe",
    [req.userId, JSON.stringify(recipe)]
  );
  res.status(201).json({ ...result.rows[0].recipe, _archive_id: result.rows[0].id });
});

// DELETE /api/archive/:id
router.delete("/:id", async (req, res) => {
  await pool.query("DELETE FROM mealprep_archive WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]);
  res.json({ ok: true });
});

module.exports = router;
