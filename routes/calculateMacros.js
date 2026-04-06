const express = require("express");
const router = express.Router();
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const GOAL_LABELS = {
  abnehmen:  "Abnehmen (Kaloriendefizit)",
  halten:    "Gewicht halten (ausgeglichen)",
  aufbauen:  "Muskeln aufbauen (Kalorienüberschuss)",
};

// POST /api/calculate-macros
// Body: { weight, goal, gender?, age?, height? }
// Returns: { kcal, protein, carbs, fat }
router.post("/", async (req, res) => {
  const { weight, goal, gender, age, height } = req.body;
  if (!weight || !goal) return res.status(400).json({ error: "weight und goal erforderlich" });

  const profileLines = [
    `- Körpergewicht: ${weight} kg`,
    `- Ziel: ${GOAL_LABELS[goal] || goal}`,
    gender  ? `- Geschlecht: ${gender === "m" ? "männlich" : "weiblich"}` : null,
    age     ? `- Alter: ${age} Jahre` : null,
    height  ? `- Größe: ${height} cm` : null,
  ].filter(Boolean).join("\n");

  const prompt = `Berechne tägliche Makroziele für folgendes Profil:\n${profileLines}\n\nRegeln:\n- Protein: 1.8–2.2 g pro kg Körpergewicht\n- Fett: 25–30 % der Gesamtkalorien\n- Kohlenhydrate: verbleibende Kalorien\n- Abnehmen: 300–500 kcal Defizit zum Erhaltungsbedarf\n- Aufbauen: 200–300 kcal Überschuss\n- Halten: ausgeglichen\n- Werte realistisch und auf 5 gerundet\n\nAntworte NUR mit JSON, kein Markdown, keine Erklärung:\n{"kcal": 2100, "protein": 160, "carbs": 215, "fat": 65}`;

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = msg.content.map(b => b.text || "").join("").trim();
    const result = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (!result.kcal || !result.protein || !result.carbs || !result.fat)
      throw new Error("Unvollständige Antwort");
    res.json({
      kcal:    Math.round(result.kcal),
      protein: Math.round(result.protein),
      carbs:   Math.round(result.carbs),
      fat:     Math.round(result.fat),
    });
  } catch (err) {
    console.error("calculateMacros error:", err);
    res.status(500).json({ error: "Berechnung fehlgeschlagen: " + err.message });
  }
});

module.exports = router;
