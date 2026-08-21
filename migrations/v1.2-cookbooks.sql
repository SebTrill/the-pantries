-- The Pantries — migration v1.2: notes + cookbooks
-- Safe to run on a live database. Only adds; nothing is dropped or rewritten,
-- so existing recipes, ratings and photos are untouched.
-- Paste this into the D1 Console and Execute.

-- 1. Free-form notes on a recipe
ALTER TABLE recipes ADD COLUMN notes TEXT NOT NULL DEFAULT '';

-- 2. Which cookbook a recipe came from (NULL = not from a book)
ALTER TABLE recipes ADD COLUMN cookbook_id TEXT;
ALTER TABLE recipes ADD COLUMN cookbook_page TEXT NOT NULL DEFAULT '';

-- 3. The cookbook shelf
CREATE TABLE IF NOT EXISTS cookbooks (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  author     TEXT NOT NULL DEFAULT '',
  publisher  TEXT NOT NULL DEFAULT '',
  published  TEXT NOT NULL DEFAULT '',   -- free text: "1997", "March 2011"
  edition    TEXT NOT NULL DEFAULT '',
  isbn       TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  emoji      TEXT NOT NULL DEFAULT '📕',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 4. Photos of a book and scanned files, in one table.
--    kind='photo' renders in the gallery; kind='file' lists as a download.
CREATE TABLE IF NOT EXISTS cookbook_files (
  id           TEXT PRIMARY KEY,
  cookbook_id  TEXT NOT NULL REFERENCES cookbooks(id) ON DELETE CASCADE,
  r2_key       TEXT NOT NULL,
  filename     TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL DEFAULT 'file',
  is_cover     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recipes_cookbook   ON recipes(cookbook_id);
CREATE INDEX IF NOT EXISTS idx_cookbook_files_bk  ON cookbook_files(cookbook_id, kind);
