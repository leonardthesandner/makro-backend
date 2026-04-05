const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");

// POST /api/auth/register
router.post("/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email und Passwort erforderlich" });
  if (password.length < 6) return res.status(400).json({ error: "Passwort mindestens 6 Zeichen" });

  try {
    const exists = await pool.query("SELECT id FROM users WHERE email_lower = $1", [email.toLowerCase()]);
    if (exists.rows.length > 0) return res.status(409).json({ error: "Email bereits registriert" });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email",
      [email.toLowerCase(), hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ user_id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "30d" });
    console.log(`✅ Neuer User registriert: ${user.email}`);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email und Passwort erforderlich" });

  try {
    const result = await pool.query("SELECT * FROM users WHERE email_lower = $1", [email.toLowerCase()]);
    if (result.rows.length === 0) return res.status(401).json({ error: "Ungültige Anmeldedaten" });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Ungültige Anmeldedaten" });

    const token = jwt.sign({ user_id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "30d" });
    console.log(`🔑 Login: ${user.email}`);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
