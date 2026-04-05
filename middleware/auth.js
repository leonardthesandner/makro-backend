const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Nicht angemeldet" });
  try {
    const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    req.userId = String(payload.user_id);
    req.userEmail = payload.email;
    next();
  } catch {
    res.status(401).json({ error: "Token ungültig oder abgelaufen" });
  }
}

module.exports = { requireAuth };
