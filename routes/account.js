const express = require("express");
const router  = express.Router();
const { pool } = require("../db");

// DELETE /api/account — löscht Nutzer + alle Daten (transaktional)
router.delete("/", async (req, res) => {
  const userId = req.userId;
  try {
    await pool.query("BEGIN");
    await pool.query("DELETE FROM diary_entries    WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM recipes          WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM mealprep_archive WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM user_settings    WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM user_foods       WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM body_weight      WHERE user_id = $1", [userId]);
    await pool.query("DELETE FROM users            WHERE id      = $1", [userId]);
    await pool.query("COMMIT");
    console.log(`🗑️  Account gelöscht: user_id=${userId}`);
    res.json({ ok: true });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("Account deletion error:", err);
    res.status(500).json({ error: "Fehler beim Löschen." });
  }
});

module.exports = router;
