const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

// ── Public router (webhook + OAuth callback) ─────────────────────────────────
const publicRouter = express.Router();

// In-memory state store for OAuth (userId → state token, TTL 10min)
const oauthStates = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [state, { ts }] of oauthStates) {
    if (now - ts > 10 * 60 * 1000) oauthStates.delete(state);
  }
}, 60 * 1000);

// GET /api/strava/callback — Strava redirects here after user authorizes
publicRouter.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const FRONTEND = "https://leonardthesandner.github.io/makro/";

  if (error || !code || !state) {
    return res.redirect(FRONTEND + "?strava=error");
  }

  const entry = oauthStates.get(state);
  if (!entry) return res.redirect(FRONTEND + "?strava=error");
  oauthStates.delete(state);

  try {
    // Exchange code for tokens
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id:     process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
      }),
    });
    const data = await tokenRes.json();
    if (!data.access_token) return res.redirect(FRONTEND + "?strava=error");

    const athleteName = [data.athlete?.firstname, data.athlete?.lastname].filter(Boolean).join(" ") || "Strava";

    await pool.query(
      `INSERT INTO strava_tokens (user_id, athlete_id, access_token, refresh_token, expires_at, athlete_name)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id) DO UPDATE SET
         athlete_id=EXCLUDED.athlete_id, access_token=EXCLUDED.access_token,
         refresh_token=EXCLUDED.refresh_token, expires_at=EXCLUDED.expires_at,
         athlete_name=EXCLUDED.athlete_name`,
      [entry.userId, data.athlete.id, data.access_token, data.refresh_token, data.expires_at, athleteName]
    );

    console.log(`✅ Strava connected: user ${entry.userId} ↔ athlete ${data.athlete.id}`);
    res.redirect(FRONTEND + "?strava=connected");
  } catch (err) {
    console.error("Strava callback error:", err);
    res.redirect(FRONTEND + "?strava=error");
  }
});

// GET /api/strava/webhook — Strava webhook verification challenge
publicRouter.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Strava webhook verified");
    return res.json({ "hub.challenge": challenge });
  }
  res.status(403).json({ error: "Forbidden" });
});

// POST /api/strava/webhook — incoming Strava activity events
publicRouter.post("/webhook", express.json(), async (req, res) => {
  res.status(200).send("EVENT_RECEIVED"); // Strava erwartet sofortige 200-Antwort

  const { object_type, aspect_type, object_id, owner_id } = req.body;
  if (object_type !== "activity" || aspect_type !== "create") return;

  try {
    // Find user by Strava athlete ID
    const { rows } = await pool.query(
      "SELECT * FROM strava_tokens WHERE athlete_id = $1", [owner_id]
    );
    if (!rows.length) return;
    const tokenRow = rows[0];

    // Get valid access token (refresh if expired)
    const accessToken = await getValidToken(tokenRow);

    // Fetch activity details from Strava
    const actRes = await fetch(`https://www.strava.com/api/v3/activities/${object_id}`, {
      headers: { "Authorization": `Bearer ${accessToken}` },
    });
    const activity = await actRes.json();
    if (!actRes.ok || !activity.id) return;

    const calories = activity.calories || Math.round((activity.kilojoules || 0) / 4.184);
    if (!calories || calories <= 0) return;

    const date = (activity.start_date_local || activity.start_date || "").slice(0, 10);
    if (!date) return;

    // Save individual activity
    await pool.query(
      `INSERT INTO strava_activities (user_id, strava_id, date, name, type, calories, distance_m, duration_s)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (strava_id) DO UPDATE SET
         calories=EXCLUDED.calories, name=EXCLUDED.name`,
      [tokenRow.user_id, activity.id, date, activity.name, activity.type,
       calories, activity.distance || null, activity.moving_time || null]
    );

    // Update daily burned_kcal total
    const { rows: acts } = await pool.query(
      "SELECT SUM(calories) AS total FROM strava_activities WHERE user_id=$1 AND date=$2",
      [tokenRow.user_id, date]
    );
    const total = parseInt(acts[0]?.total || 0);
    await pool.query(
      `INSERT INTO body_weight (user_id, date, burned_kcal)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id, date) DO UPDATE SET burned_kcal=EXCLUDED.burned_kcal`,
      [tokenRow.user_id, date, total]
    );

    console.log(`🏃 Strava: "${activity.name}" ${calories} kcal für user ${tokenRow.user_id} am ${date}`);
  } catch (err) {
    console.error("Strava webhook handler error:", err);
  }
});

// GET /api/strava/connect?token=... — in public router so global requireAuth doesn't block it
const jwt = require("jsonwebtoken");
publicRouter.get("/connect", (req, res) => {
  let userId;
  try {
    const payload = jwt.verify(req.query.token || "", process.env.JWT_SECRET);
    userId = String(payload.user_id);
  } catch {
    return res.status(401).json({ error: "Nicht angemeldet" });
  }
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  oauthStates.set(state, { userId, ts: Date.now() });

  const params = new URLSearchParams({
    client_id:     process.env.STRAVA_CLIENT_ID,
    redirect_uri:  `https://makro-backend-production.up.railway.app/api/strava/callback`,
    response_type: "code",
    approval_prompt: "auto",
    scope:         "activity:read_all",
    state,
  });

  res.redirect(`https://www.strava.com/oauth/authorize?${params}`);
});

// ── Protected router (status + disconnect) ───────────────────────────────────
const authRouter = express.Router();
authRouter.use(requireAuth);

// GET /api/strava/activities?from=YYYY-MM-DD&to=YYYY-MM-DD
authRouter.get("/activities", async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from + to required" });
  const { rows } = await pool.query(
    `SELECT strava_id, date, name, type, calories, distance_m, duration_s
     FROM strava_activities WHERE user_id=$1 AND date>=$2 AND date<=$3 ORDER BY date DESC`,
    [req.userId, from, to]
  );
  res.json(rows);
});

// GET /api/strava/status — check connection status
authRouter.get("/status", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT athlete_name, athlete_id FROM strava_tokens WHERE user_id = $1", [req.userId]
  );
  if (!rows.length) return res.json({ connected: false });
  res.json({ connected: true, athleteName: rows[0].athlete_name });
});

// DELETE /api/strava/disconnect
authRouter.delete("/disconnect", async (req, res) => {
  await pool.query("DELETE FROM strava_tokens WHERE user_id = $1", [req.userId]);
  res.json({ ok: true });
});

// ── Shared helper ─────────────────────────────────────────────────────────────
async function getValidToken(row) {
  if (Math.floor(Date.now() / 1000) < row.expires_at - 300) return row.access_token;

  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id:     process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type:    "refresh_token",
      refresh_token: row.refresh_token,
    }),
  });
  const data = await r.json();
  await pool.query(
    "UPDATE strava_tokens SET access_token=$1, refresh_token=$2, expires_at=$3 WHERE user_id=$4",
    [data.access_token, data.refresh_token, data.expires_at, row.user_id]
  );
  return data.access_token;
}

module.exports = { publicRouter, authRouter };
