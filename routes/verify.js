const express = require("express");
const router  = express.Router();
const { pool } = require("../db");

const html = (title, body, isError) => `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} – makro.</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0c0c0c;color:#efefef;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{max-width:420px;width:100%;text-align:center}
    .logo{font-size:36px;font-weight:800;letter-spacing:-1.5px;margin-bottom:8px}
    .dot{color:#f59e0b}
    .icon{font-size:52px;margin:28px 0 18px}
    h1{font-size:20px;font-weight:700;margin-bottom:10px}
    p{color:#888;font-size:14px;line-height:1.7;margin-bottom:28px}
    a{display:inline-block;background:#f59e0b;color:#000;font-weight:700;padding:13px 28px;border-radius:8px;text-decoration:none;font-size:14px}
    .err a{background:#f87171;color:#fff}
  </style>
</head>
<body>
  <div class="card ${isError ? "err" : ""}">
    <div class="logo">makro<span class="dot">.</span></div>
    <div class="icon">${isError ? "✗" : "✓"}</div>
    <h1>${title}</h1>
    <p>${body}</p>
    <a href="https://leonardthesandner.github.io/makro/makro-app/makro/">Zur App →</a>
  </div>
</body>
</html>`;

router.get("/", async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send(html("Ungültiger Link", "Kein Bestätigungs-Token gefunden.", true));
  }

  try {
    const result = await pool.query(
      "SELECT id, email FROM users WHERE verification_token = $1 AND email_verified = false",
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).send(html(
        "Link ungültig oder abgelaufen",
        "Dieser Bestätigungslink ist nicht mehr gültig. Bitte fordere einen neuen an.",
        true
      ));
    }

    const user = result.rows[0];
    await pool.query(
      "UPDATE users SET email_verified = true, verification_token = NULL WHERE id = $1",
      [user.id]
    );

    console.log(`✅ E-Mail bestätigt: ${user.email}`);
    res.send(html(
      "E-Mail bestätigt!",
      "Deine E-Mail-Adresse wurde erfolgreich bestätigt. Du kannst dich jetzt anmelden."
    ));
  } catch (err) {
    console.error("Verify error:", err);
    res.status(500).send(html("Fehler", "Ein Serverfehler ist aufgetreten. Bitte versuch es später erneut.", true));
  }
});

module.exports = router;
