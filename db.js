const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS foods (
      id          SERIAL PRIMARY KEY,
      fdc_id      INTEGER UNIQUE,
      name        TEXT NOT NULL,
      name_lower  TEXT GENERATED ALWAYS AS (LOWER(name)) STORED,
      aliases     TEXT[] DEFAULT '{}',
      kcal_100    DECIMAL(8,2),
      protein_100 DECIMAL(8,2),
      carbs_100   DECIMAL(8,2),
      fat_100     DECIMAL(8,2),
      source      TEXT DEFAULT 'usda',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS foods_name_lower_idx ON foods (name_lower);
    CREATE INDEX IF NOT EXISTS foods_aliases_idx ON foods USING GIN (aliases);

    CREATE TABLE IF NOT EXISTS food_searches (
      id         SERIAL PRIMARY KEY,
      query      TEXT NOT NULL,
      query_norm TEXT GENERATED ALWAYS AS (LOWER(TRIM(query))) STORED,
      food_id    INTEGER REFERENCES foods(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS food_searches_query_norm_idx ON food_searches (query_norm);

    CREATE TABLE IF NOT EXISTS parse_cache (
      id          SERIAL PRIMARY KEY,
      input_hash  TEXT UNIQUE NOT NULL,
      input_text  TEXT NOT NULL,
      result      JSONB NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS recipes (
      id             SERIAL PRIMARY KEY,
      user_id        TEXT NOT NULL,
      name           TEXT NOT NULL,
      total_weight   DECIMAL(10,2),
      kcal_total     DECIMAL(10,2),
      protein_total  DECIMAL(8,2),
      carbs_total    DECIMAL(8,2),
      fat_total      DECIMAL(8,2),
      kcal_100       DECIMAL(8,2),
      protein_100    DECIMAL(8,2),
      carbs_100      DECIMAL(8,2),
      fat_100        DECIMAL(8,2),
      ingredients    TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS recipes_user_id_idx ON recipes (user_id);

    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL,
      email_lower   TEXT GENERATED ALWAYS AS (LOWER(email)) STORED,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (email_lower);

    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT;
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_idx ON users (google_id) WHERE google_id IS NOT NULL;

    ALTER TABLE foods ADD COLUMN IF NOT EXISTS barcode TEXT;
    ALTER TABLE foods ADD COLUMN IF NOT EXISTS serving_g DECIMAL(8,2);
    CREATE INDEX IF NOT EXISTS foods_barcode_idx ON foods (barcode) WHERE barcode IS NOT NULL;

    CREATE TABLE IF NOT EXISTS diary_entries (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      date        DATE NOT NULL,
      entry       JSONB NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS diary_entries_user_date_idx ON diary_entries (user_id, date);

    CREATE TABLE IF NOT EXISTS mealprep_archive (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      recipe      JSONB NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS mealprep_archive_user_idx ON mealprep_archive (user_id);

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id     TEXT PRIMARY KEY,
      settings    JSONB NOT NULL DEFAULT '{}',
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_foods (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      kcal_100    DECIMAL(8,2) NOT NULL,
      protein_100 DECIMAL(8,2) NOT NULL DEFAULT 0,
      carbs_100   DECIMAL(8,2) NOT NULL DEFAULT 0,
      fat_100     DECIMAL(8,2) NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS user_foods_user_id_idx ON user_foods (user_id);
    ALTER TABLE user_foods ADD COLUMN IF NOT EXISTS serving_g DECIMAL(8,2);

    CREATE TABLE IF NOT EXISTS body_weight (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      date        DATE NOT NULL,
      weight_kg   DECIMAL(5,2),
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, date)
    );
    CREATE INDEX IF NOT EXISTS body_weight_user_date_idx ON body_weight (user_id, date);
    ALTER TABLE body_weight ALTER COLUMN weight_kg DROP NOT NULL;
    ALTER TABLE body_weight ADD COLUMN IF NOT EXISTS burned_kcal DECIMAL(8,2);

    ALTER TABLE recipes ADD COLUMN IF NOT EXISTS items JSONB;
    ALTER TABLE recipes ADD COLUMN IF NOT EXISTS portion_g NUMERIC;

    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_pro BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_start TIMESTAMPTZ;

    ALTER TABLE foods ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;

    CREATE TABLE IF NOT EXISTS strava_tokens (
      user_id       TEXT PRIMARY KEY,
      athlete_id    BIGINT UNIQUE NOT NULL,
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at    BIGINT NOT NULL,
      athlete_name  TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS strava_activities (
      id            SERIAL PRIMARY KEY,
      user_id       TEXT NOT NULL,
      strava_id     BIGINT UNIQUE NOT NULL,
      date          DATE NOT NULL,
      name          TEXT,
      type          TEXT,
      calories      INTEGER NOT NULL DEFAULT 0,
      distance_m    DECIMAL(10,1),
      duration_s    INTEGER,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS strava_activities_user_date_idx ON strava_activities (user_id, date);
  `);

  // pg_trgm für Ähnlichkeitssuche (Duplikat-Check)
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  // Fehlhafte Cache-Einträge für sehr kurze Suchbegriffe entfernen
  // (z.B. "ei" → traf fälschlicherweise "Eiweiß")
  await pool.query(`DELETE FROM food_searches WHERE LENGTH(query_norm) <= 3`);

  console.log("✅ Database schema ready");
}

module.exports = { pool, initDB };
