-- The Pantries — migration v2.3: your own emoji palette
--
-- The emoji pickers on the edit pages ship with a sensible default row, but the
-- useful set is personal — you cook what you cook. This table holds emoji you
-- added yourself. It does NOT hold usage counts: how often an emoji is used is
-- read live from the recipes and cookbooks tables, so the ordering can never
-- drift out of step with reality.
--
-- kind is 'recipe' or 'cookbook', because a recipe wants 🍋 and a book wants 📕.
--
-- Safe to run on a live database; only adds.
-- Paste into the D1 Console and Execute.

CREATE TABLE IF NOT EXISTS emoji_palette (
  kind     TEXT NOT NULL,          -- 'recipe' | 'cookbook'
  emoji    TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (kind, emoji)
);
