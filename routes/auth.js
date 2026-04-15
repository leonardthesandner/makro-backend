const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt    = require("jsonwebtoken");
const crypto = require("crypto");
const { pool } = require("../db");
const { sendVerificationEmail, sendPasswordResetEmail } = require("../services/email");
const { OAuth2Client } = require("google-auth-library");
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const appleSignin = require("apple-signin-auth");
const APPLE_PRIVATE_KEY = (process.env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

// POST /api/auth/register
router.post("/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email und Passwort erforderlich" });
  if (password.length < 8) return res.status(400).json({ error: "Passwort mindestens 8 Zeichen" });

  try {
    const exists = await pool.query("SELECT id FROM users WHERE email_lower = $1", [email.toLowerCase()]);
    if (exists.rows.length > 0) return res.status(409).json({ error: "Email bereits registriert" });

    const hash  = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(32).toString("hex");

    await pool.query(
      "INSERT INTO users (email, password_hash, email_verified, verification_token) VALUES ($1, $2, false, $3)",
      [email.toLowerCase(), hash, token]
    );

    await sendVerificationEmail(email.toLowerCase(), token);
    console.log(`📧 Registrierung: ${email.toLowerCase()} – Bestätigungsmail gesendet`);
    res.json({ pending: true, message: "Bitte bestätige deine E-Mail-Adresse." });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Registrierung fehlgeschlagen." });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email und Passwort erforderlich" });

  try {
    const result = await pool.query("SELECT * FROM users WHERE email_lower = $1", [email.toLowerCase()]);
    if (result.rows.length === 0) return res.status(401).json({ error: "Ungültige Anmeldedaten" });

    const user  = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Ungültige Anmeldedaten" });

    if (!user.email_verified) {
      return res.status(403).json({ error: "email_not_verified", message: "Bitte bestätige zuerst deine E-Mail-Adresse." });
    }

    const token = jwt.sign({ user_id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });
    console.log(`🔑 Login: ${user.email}`);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Anmeldung fehlgeschlagen." });
  }
});

// POST /api/auth/resend-verification
router.post("/resend-verification", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email erforderlich" });

  try {
    const result = await pool.query("SELECT * FROM users WHERE email_lower = $1", [email.toLowerCase()]);
    if (result.rows.length === 0) return res.json({ ok: true }); // don't reveal existence

    const user = result.rows[0];
    if (user.email_verified) return res.json({ ok: true });

    const token = crypto.randomBytes(32).toString("hex");
    await pool.query("UPDATE users SET verification_token = $1 WHERE id = $2", [token, user.id]);
    await sendVerificationEmail(user.email, token);
    console.log(`📧 Resend verification: ${user.email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Resend error:", err);
    res.status(500).json({ error: "Fehler beim Senden." });
  }
});

// POST /api/auth/forgot-password
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email erforderlich" });
  try {
    const result = await pool.query("SELECT id, email FROM users WHERE email_lower = $1", [email.toLowerCase()]);
    if (result.rows.length > 0) {
      const user  = result.rows[0];
      const token = crypto.randomBytes(32).toString("hex");
      const exp   = new Date(Date.now() + 60 * 60 * 1000); // 1 Stunde
      await pool.query("UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3", [token, exp, user.id]);
      await sendPasswordResetEmail(user.email, token);
    }
    res.json({ ok: true }); // immer ok – verrate keine Email-Existenz
  } catch (err) {
    console.error("Forgot-password error:", err);
    res.status(500).json({ error: "Fehler beim Senden." });
  }
});

// POST /api/auth/reset-password
router.post("/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "Token und Passwort erforderlich" });
  if (password.length < 8) return res.status(400).json({ error: "Passwort mindestens 8 Zeichen" });
  try {
    const result = await pool.query(
      "SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()",
      [token]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: "Link ungültig oder abgelaufen" });
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      "UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2",
      [hash, result.rows[0].id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Reset-password error:", err);
    res.status(500).json({ error: "Fehler beim Zurücksetzen." });
  }
});

// POST /api/auth/google
router.post("/google", async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: "Google-Token fehlt" });
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email    = payload.email;

    // 1. Nutzer über google_id finden
    let result = await pool.query("SELECT * FROM users WHERE google_id = $1", [googleId]);

    if (result.rows.length === 0) {
      // 2. Gleiche E-Mail vorhanden? → verknüpfen
      const byEmail = await pool.query("SELECT * FROM users WHERE email_lower = $1", [email.toLowerCase()]);
      if (byEmail.rows.length > 0) {
        await pool.query("UPDATE users SET google_id = $1, email_verified = true WHERE id = $2", [googleId, byEmail.rows[0].id]);
        result = await pool.query("SELECT * FROM users WHERE id = $1", [byEmail.rows[0].id]);
      } else {
        // 3. Neuen Nutzer anlegen
        result = await pool.query(
          "INSERT INTO users (email, google_id, email_verified) VALUES ($1, $2, true) RETURNING *",
          [email.toLowerCase(), googleId]
        );
      }
    }

    const user  = result.rows[0];
    const token = jwt.sign({ user_id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });
    console.log(`🔑 Google-Login: ${user.email}`);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error("Google-Auth error:", err);
    res.status(401).json({ error: "Google-Anmeldung fehlgeschlagen" });
  }
});

// POST /api/auth/apple
router.post("/apple", async (req, res) => {
  const { id_token, user } = req.body;
  if (!id_token) return res.status(400).json({ error: "Apple-Token fehlt" });
  try {
    const appleUser = await appleSignin.verifyIdToken(id_token, {
      audience: process.env.APPLE_CLIENT_ID,
      ignoreExpiration: false,
    });

    const appleId = appleUser.sub;
    const email   = appleUser.email || (user && user.email) || `apple_${appleId}@privaterelay.appleid.com`;

    let result = await pool.query("SELECT * FROM users WHERE apple_id = $1", [appleId]);

    if (result.rows.length === 0) {
      const byEmail = await pool.query("SELECT * FROM users WHERE email_lower = $1", [email.toLowerCase()]);
      if (byEmail.rows.length > 0) {
        await pool.query("UPDATE users SET apple_id = $1, email_verified = true WHERE id = $2", [appleId, byEmail.rows[0].id]);
        result = await pool.query("SELECT * FROM users WHERE id = $1", [byEmail.rows[0].id]);
      } else {
        result = await pool.query(
          "INSERT INTO users (email, apple_id, email_verified) VALUES ($1, $2, true) RETURNING *",
          [email.toLowerCase(), appleId]
        );
      }
    }

    const dbUser = result.rows[0];
    const token  = jwt.sign({ user_id: dbUser.id, email: dbUser.email }, process.env.JWT_SECRET, { expiresIn: "7d" });
    console.log(`🍎 Apple-Login: ${dbUser.email}`);
    res.json({ token, user: { id: dbUser.id, email: dbUser.email } });
  } catch (err) {
    console.error("Apple-Auth error:", err);
    res.status(401).json({ error: "Apple-Anmeldung fehlgeschlagen" });
  }
});

module.exports = router;
