const express = require("express");
const router = express.Router();
const { lookupFood } = require("../services/foodLookup");
const { pool } = require("../db");

// GET /api/foods/search?q=Hähnchenbrust
router.get("/search", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "q required" });

  const food = await lookupFood(q, q, q);
  if (!food) return res.status(404).json({ error: "not found" });
  res.json(food);
});

// GET /api/foods/stats – wie viele Einträge in der DB
router.get("/stats", async (req, res) => {
  const foods = await pool.query("SELECT COUNT(*) FROM foods");
  const searches = await pool.query("SELECT COUNT(*) FROM food_searches");
  const cache = await pool.query("SELECT COUNT(*) FROM parse_cache");
  res.json({
    foods:        parseInt(foods.rows[0].count),
    searches:     parseInt(searches.rows[0].count),
    parse_cache:  parseInt(cache.rows[0].count),
  });
});

module.exports = router;
