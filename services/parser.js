const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Claude's only job: extract structured items from free text
// Makros kommen von USDA, nicht von Claude
const PARSE_SYSTEM = `Du bist ein Lebensmittel-Parser. Deine einzige Aufgabe ist es, freien Text in strukturierte Lebensmittel-Einträge umzuwandeln.

Antworte NUR mit einem JSON-Objekt, kein Markdown, keine Erklärungen.

Format:
{
  "items": [
    {
      "name_en": "chicken breast",
      "name_de": "Hähnchenbrust",
      "amount": 300,
      "unit": "g",
      "weight_g": 300,
      "is_recipe": false,
      "recipe_name": null,
      "usda_query": "chicken breast raw"
    }
  ]
}

Regeln:
- name_en: englischer Name für USDA-Suche (USDA-Datenbank ist englisch)
- name_de: deutscher Originalname zur Anzeige
- weight_g: Gewicht in Gramm (Stückangaben schätzen: 1 Ei = 60g, 1 Breze = 100g, 1 Dose Tomaten = 400g, 1 EL Öl = 10g, 1 Packung Sahne 200ml = 200g)
- usda_query: optimierter englischer Suchbegriff für USDA (z.B. "raw" für rohes Fleisch, "cooked" für gekochtes)
- is_recipe: true wenn ein gespeicherter Rezeptname erkannt wird
- recipe_name: exakter Name des Rezepts wenn is_recipe=true
- Keine Makros schätzen – das macht die Datenbank`;

const RECIPE_PARSE_SYSTEM = `Du bist ein Lebensmittel-Parser für Rezept-Zutaten. Wandle Zutaten in strukturierte Einträge um.

Antworte NUR mit einem JSON-Objekt, kein Markdown.

Format:
{
  "items": [
    {
      "name_en": "chicken breast",
      "name_de": "Hühnchenbrust",
      "amount": 1000,
      "unit": "g",
      "weight_g": 1000,
      "usda_query": "chicken breast raw"
    }
  ]
}

Regeln:
- Rohgewichte verwenden (vor dem Kochen)
- Stückangaben in Gramm umrechnen: 1 Dose Tomaten = 400g, 1 EL Öl = 10g, 1 Packung Sahne 20% = 200g, 1 Knoblauchzehe = 5g
- usda_query auf Englisch, optimiert für USDA-Suche
- Keine Makros schätzen`;

function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

async function parseWithClaude(text, systemPrompt) {
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: "user", content: text }],
  });
  const raw = msg.content.map((b) => b.text || "").join("");
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

module.exports = { parseWithClaude, PARSE_SYSTEM, RECIPE_PARSE_SYSTEM, hashText };
