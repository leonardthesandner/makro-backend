const express = require("express");
const router = express.Router();
const { parseWithClaude } = require("../services/parser");

const GOAL_LABELS = {
  abnehmen:  "Abnehmen (Kaloriendefizit 400 kcal)",
  halten:    "Gewicht halten (ausgeglichen)",
  aufbauen:  "Muskeln aufbauen (Überschuss 200 kcal)",
};

function formulaCalc(weight, goal, gender, age, height) {
  let tdee;
  if (gender && age && height) {
    const bmr = gender === "m"
      ? 10 * weight + 6.25 * height - 5 * age + 5
      : 10 * weight + 6.25 * height - 5 * age - 161;
    tdee = bmr * 1.55;
  } else {
    tdee = weight * 33;
  }
  if (goal === "abnehmen") tdee -= 400;
  else if (goal === "aufbauen") tdee += 200;
  const kcal    = Math.round(tdee / 50) * 50;
  const protein = Math.round(weight * 2);
  const fat     = Math.round(kcal * 0.28 / 9);
  const carbs   = Math.round((kcal - protein * 4 - fat * 9) / 4);
  return { kcal, protein, carbs, fat };
}

// POST /api/calculate-macros
// Body: { weight, goal, gender?, age?, height? }
router.post("/", async (req, res) => {
  const { weight, goal, gender, age, height } = req.body;
  if (!weight || !goal) return res.status(400).json({ error: "weight und goal erforderlich" });

  const w = parseFloat(weight);
  if (!w || w <= 0 || w > 500) return res.status(400).json({ error: "Ungültiges Gewicht" });
  if (!["abnehmen", "halten", "aufbauen"].includes(goal)) return res.status(400).json({ error: "Ungültiges Ziel" });
  if (gender && !["m", "f"].includes(gender)) return res.status(400).json({ error: "Ungültiges Geschlecht" });
  if (age && (parseFloat(age) < 10 || parseFloat(age) > 120)) return res.status(400).json({ error: "Ungültiges Alter" });
  if (height && (parseFloat(height) < 100 || parseFloat(height) > 250)) return res.status(400).json({ error: "Ungültige Größe" });

  const profileLines = [
    `Körpergewicht: ${w} kg`,
    `Ziel: ${GOAL_LABELS[goal] || goal}`,
    gender ? `Geschlecht: ${gender === "m" ? "männlich" : "weiblich"}` : null,
    age    ? `Alter: ${age} Jahre` : null,
    height ? `Größe: ${height} cm` : null,
  ].filter(Boolean).join(", ");

  const prompt = `Berechne tägliche Makroziele für: ${profileLines}. Antworte NUR mit JSON: {"kcal":2100,"protein":160,"carbs":215,"fat":65}`;
  const system = `Du bist ein Ernährungsberater. Regeln: Protein 1.8-2.2g/kg, Fett 25-30% der Kalorien, Kohlenhydrate Rest. Antworte ausschließlich mit einem JSON-Objekt, kein Text davor oder danach.`;

  try {
    const parsed = await parseWithClaude(prompt, system);
    const { kcal, protein, carbs, fat } = parsed;
    if (!kcal || !protein || !carbs || !fat) throw new Error("Unvollständige KI-Antwort");
    console.log(`✅ calculate-macros (KI): kcal=${kcal} p=${protein} c=${carbs} f=${fat}`);
    res.json({ kcal: Math.round(kcal), protein: Math.round(protein), carbs: Math.round(carbs), fat: Math.round(fat), source: "ai" });
  } catch (err) {
    console.warn("⚠️ Claude fehlgeschlagen, Fallback-Formel:", err.message);
    const result = formulaCalc(w, goal, gender, parseFloat(age), parseFloat(height));
    console.log(`✅ calculate-macros (Formel): kcal=${result.kcal} p=${result.protein} c=${result.carbs} f=${result.fat}`);
    res.json({ ...result, source: "formula" });
  }
});

module.exports = router;
