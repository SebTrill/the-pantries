-- Recipe Dictionary — D1 (SQLite) schema
-- Every table uses ON DELETE CASCADE from recipes, so deleting a recipe
-- cleans up its ingredients, steps, ratings, photos and links automatically.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS recipes (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  emoji         TEXT NOT NULL DEFAULT '🍽️',
  base_servings REAL NOT NULL DEFAULT 4,
  times_cooked  INTEGER NOT NULL DEFAULT 0,
  date_added    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS recipe_categories (
  recipe_id   TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (recipe_id, category_id)
);

CREATE TABLE IF NOT EXISTS tags (
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  PRIMARY KEY (recipe_id, name)
);

-- qty holds the parsed number used for scaling maths.
-- qty_raw holds exactly what was typed ("1 1/2") so the editor round-trips
-- without ever destroying a fraction.
CREATE TABLE IF NOT EXISTS ingredients (
  id        TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  qty       REAL NOT NULL DEFAULT 0,
  qty_raw   TEXT NOT NULL DEFAULT '',
  unit      TEXT NOT NULL DEFAULT '',
  name      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instructions (
  id        TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  text      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ratings (
  id         TEXT PRIMARY KEY,
  recipe_id  TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment    TEXT NOT NULL DEFAULT '',
  date       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- recipe_id NULL  -> entry in the global substitutions library (auto-matches everywhere)
-- recipe_id SET   -> substitution that belongs to one recipe only
CREATE TABLE IF NOT EXISTS substitutions (
  id         TEXT PRIMARY KEY,
  recipe_id  TEXT REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient TEXT NOT NULL,
  substitute TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- Binary image data lives in R2; this table stores only the key plus metadata.
CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  recipe_id  TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,
  caption    TEXT NOT NULL DEFAULT '',
  is_cover   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shopping_items (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  qty         REAL NOT NULL DEFAULT 1,
  unit        TEXT NOT NULL DEFAULT '',
  checked     INTEGER NOT NULL DEFAULT 0,
  from_recipe TEXT NOT NULL DEFAULT 'manual',
  orig_name   TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingredients_recipe   ON ingredients(recipe_id, position);
CREATE INDEX IF NOT EXISTS idx_instructions_recipe  ON instructions(recipe_id, position);
CREATE INDEX IF NOT EXISTS idx_ratings_recipe       ON ratings(recipe_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ratings_recent       ON ratings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_photos_recipe        ON photos(recipe_id);
CREATE INDEX IF NOT EXISTS idx_subs_recipe          ON substitutions(recipe_id);
CREATE INDEX IF NOT EXISTS idx_subs_ingredient      ON substitutions(ingredient);
CREATE INDEX IF NOT EXISTS idx_recipe_cats_cat      ON recipe_categories(category_id);
CREATE INDEX IF NOT EXISTS idx_recipes_cooked       ON recipes(times_cooked DESC);
CREATE INDEX IF NOT EXISTS idx_recipes_added        ON recipes(date_added DESC);
