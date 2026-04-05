const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// GET /api/diary?date=YYYY-MM-DD  OR  ?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/", async (req, res) => {
  const { date, from, to } = req.query;
  if (date) {
    const result = await pool.query(
      "SELECT id, entry FROM diary_entries WHERE user_id = $1 AND date = $2 ORDER BY created_at ASC",
      [req.userId, date]
    );
    return res.json(result.rows.map(r => ({ ...r.entry, id: r.id })));
  }
  if (from && to) {
    const result = await pool.query(
      "SELECT id, date, entry FROM diary_entries WHERE user_id = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC, created_at ASC",
      [req.userId, from, to]
    );
    // group by date
    const map = {};
    result.rows.forEach(r => {
      const d = r.date.toISOString().split("T")[0];
      if (!map[d]) map[d] = [];
      map[d].push({ ...r.entry, id: r.id });
    });
    return res.json(map);
  }
  res.status(400).json({ error: "date oder from+to erforderlich" });
});

// POST /api/diary  body: { date, entry }
router.post("/", async (req, res) => {
  const { date, entry } = req.body;
  if (!date || !entry) return res.status(400).json({ error: "date und entry erforderlich" });
  const result = await pool.query(
    "INSERT INTO diary_entries (user_id, date, entry) VALUES ($1, $2, $3) RETURNING id, entry",
    [req.userId, date, JSON.stringify(entry)]
  );
  res.status(201).json({ ...result.rows[0].entry, id: result.rows[0].id });
});

// DELETE /api/diary/:id
router.delete("/:id", async (req, res) => {
  await pool.query("DELETE FROM diary_entries WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]);
  res.json({ ok: true });
});

module.exports = router;
