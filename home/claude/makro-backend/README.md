# makro-backend – Deployment auf Railway

## Was du brauchst
- GitHub Account
- Railway Account (railway.app) – kostenlos starten, ~5$/Monat

---

## Schritt 1: API Keys besorgen

### Anthropic API Key
1. https://console.anthropic.com
2. "API Keys" → "Create Key"
3. Kopieren → später in Railway eintragen

### USDA FoodData Central API Key
1. https://fdc.nal.usda.gov/api-key-signup.html
2. Formular ausfüllen → Key kommt per E-Mail (sofort)
3. Kostenlos, kein Limit für normale Nutzung

### App Secret (selbst generieren)
```bash
# Im Terminal:
openssl rand -hex 32
# Ergibt z.B.: a3f9b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1
```
Diesen String brauchst du auch in der App (als BACKEND_SECRET).

---

## Schritt 2: GitHub Repository anlegen

1. github.com → "New repository" → Name: `makro-backend` → Create
2. Im Terminal:
```bash
cd makro-backend
git init
git add .
git commit -m "initial"
git remote add origin https://github.com/DEIN-USERNAME/makro-backend.git
git push -u origin main
```

---

## Schritt 3: Railway Setup

1. railway.app → "New Project"
2. "Deploy from GitHub repo" → `makro-backend` auswählen
3. Railway erkennt Node.js automatisch

### Datenbank hinzufügen:
1. Im Railway-Projekt: "+ New" → "Database" → "PostgreSQL"
2. Die `DATABASE_URL` wird automatisch als Variable gesetzt

### Environment Variables setzen:
Im Railway-Projekt → "Variables" → folgende eintragen:
```
ANTHROPIC_API_KEY    = sk-ant-...
USDA_API_KEY         = dein-usda-key
APP_SECRET           = dein-generierter-string
NODE_ENV             = production
```

4. Deploy läuft automatisch durch
5. Unter "Settings" → "Domains" → "Generate Domain" → du bekommst eine URL wie:
   `https://makro-backend-production-xxxx.up.railway.app`

---

## Schritt 4: App konfigurieren

In der App (index.html oder .jsx) diese zwei Werte eintragen:
```javascript
const BACKEND_URL = "https://makro-backend-production-xxxx.up.railway.app";
const BACKEND_SECRET = "dein-app-secret";
```

---

## API-Endpunkte

Alle Requests brauchen Header: `x-api-key: APP_SECRET`

| Method | Endpoint | Beschreibung |
|--------|----------|--------------|
| POST | `/api/analyze` | Freitext → Makros |
| POST | `/api/analyze-recipe` | Zutaten → Rezept-Makros |
| GET | `/api/recipes?user_id=xxx` | Rezepte laden |
| POST | `/api/recipes` | Rezept speichern |
| DELETE | `/api/recipes/:id` | Rezept löschen |
| GET | `/api/foods/search?q=Hähnchen` | Lebensmittel suchen |
| GET | `/api/foods/stats` | DB-Statistiken |
| GET | `/health` | Status-Check |

---

## Kosten-Überblick

| Service | Kosten |
|---------|--------|
| Railway Starter Plan | ~5$/Monat (Backend + DB) |
| USDA API | Kostenlos |
| Anthropic (Haiku) | ~0.001$ pro Analyse |
| Nach DB-Aufbau (Cache) | Fast 0$ (kaum neue Claude-Calls) |

---

## DB wächst mit jeder Anfrage

Nach 100 verschiedenen Lebensmittel-Anfragen sind 100 Einträge gecacht.
Danach kaum noch USDA-Calls nötig. Claude nur noch bei neuen Texten.
