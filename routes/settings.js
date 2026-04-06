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

// POST /api/settings  body: { targets?, onboarding_done?, ... }
router.post("/", async (req, res) => {
  const { targets, onboarding_done } = req.body;
  // Merge with existing settings
  const existing = await pool.query(
    "SELECT settings FROM user_settings WHERE user_id = $1",
    [req.userId]
  );
  const current = existing.rows[0]?.settings || {};
  const updated = { ...current };
  if (targets !== undefined) updated.targets = targets;
  if (onboarding_done !== undefined) updated.onboarding_done = onboarding_done;
  await pool.query(
    `INSERT INTO user_settings (user_id, settings, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET settings = $2, updated_at = NOW()`,
    [req.userId, JSON.stringify(updated)]
  );
  res.json({ ok: true });
});

module.exports = router;
