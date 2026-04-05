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
  `);

  console.log("✅ Database schema ready");
}

module.exports = { pool, initDB };
