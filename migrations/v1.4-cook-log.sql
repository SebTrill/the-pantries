-- The Pantries — migration v1.4: a cook log
-- Until now we stored only a counter ("cooked 14 times") with no record of WHEN.
-- This table logs one row per cook, which is what the activity calendar,
-- streaks and any future "on this day" feature need.
--
-- It starts empty on purpose: those past cooks have no dates to recover, and
-- inventing them would put fiction in your history. The calendar fills in from
-- the first meal you log after deploying this.
--
-- Safe to run on a live database; only adds.

CREATE TABLE IF NOT EXISTS cook_events (
  id        TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  cooked_at INTEGER NOT NULL,          -- epoch ms
  cooked_on TEXT NOT NULL,             -- YYYY-MM-DD, for cheap grouping
  source    TEXT NOT NULL DEFAULT 'button'   -- 'button' | 'rating'
);

CREATE INDEX IF NOT EXISTS idx_cook_events_day    ON cook_events(cooked_on);
CREATE INDEX IF NOT EXISTS idx_cook_events_recipe ON cook_events(recipe_id, cooked_at DESC);
