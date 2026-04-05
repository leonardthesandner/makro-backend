const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// GET /api/settings
router.get("/", async (req, res) => {
  const result = await pool.query(
    "SELECT settings FROM user_settings WHERE user_id = $1",
    [req.userId]
  );
  if (result.rows.length === 0) return res.json(null);
  res.json(result.rows[0].settings);
});

// POST /api/settings  body: { targets: {...} }
router.post("/", async (req, res) => {
  const { targets } = req.body;
  if (!targets) return res.status(400).json({ error: "targets erforderlich" });
  await pool.query(
    `INSERT INTO user_settings (user_id, settings, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET settings = $2, updated_at = NOW()`,
    [req.userId, JSON.stringify({ targets })]
  );
  res.json({ ok: true });
});

module.exports = router;
