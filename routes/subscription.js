const express = require("express");
const router = express.Router();
const { pool } = require("../db");

const TRIAL_DAYS = 3;

// GET /api/subscription
// Gibt den aktuellen Abo-Status zurück
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT is_pro, trial_start FROM users WHERE id = $1",
      [req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "User not found" });

    const { is_pro, trial_start } = result.rows[0];
    const now = new Date();
    const trialMs = trial_start ? now - new Date(trial_start) : Infinity;
    const isTrial = trialMs < TRIAL_DAYS * 86400000;
    const daysLeft = trial_start
      ? Math.max(0, TRIAL_DAYS - Math.floor(trialMs / 86400000))
      : 0;

    res.json({
      isPro: is_pro,
      trialStart: trial_start ? new Date(trial_start).getTime() : null,
      isTrial,
      daysLeft,
      hasAccess: is_pro || isTrial,
    });
  } catch (err) {
    console.error("subscription GET error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/subscription/init
// Setzt trial_start beim ersten Login (falls noch nicht gesetzt)
router.post("/init", async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET trial_start = NOW()
       WHERE id = $1 AND trial_start IS NULL`,
      [req.userId]
    );

    const result = await pool.query(
      "SELECT is_pro, trial_start FROM users WHERE id = $1",
      [req.userId]
    );
    const { is_pro, trial_start } = result.rows[0];
    const now = new Date();
    const trialMs = trial_start ? now - new Date(trial_start) : Infinity;
    const isTrial = trialMs < TRIAL_DAYS * 86400000;
    const daysLeft = trial_start
      ? Math.max(0, TRIAL_DAYS - Math.floor(trialMs / 86400000))
      : 0;

    res.json({
      isPro: is_pro,
      trialStart: trial_start ? new Date(trial_start).getTime() : null,
      isTrial,
      daysLeft,
      hasAccess: is_pro || isTrial,
    });
  } catch (err) {
    console.error("subscription init error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/subscription/activate
// Testphase: Pro direkt freischalten (wird später durch RevenueCat ersetzt)
router.post("/activate", async (req, res) => {
  try {
    await pool.query(
      "UPDATE users SET is_pro = true WHERE id = $1",
      [req.userId]
    );
    res.json({ isPro: true, isTrial: false, daysLeft: 0, hasAccess: true });
  } catch (err) {
    console.error("subscription activate error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
