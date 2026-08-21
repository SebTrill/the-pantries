-- The Pantries — migration 005: put cooked meals on the right calendar day
--
-- THE BUG: the Worker's clock is UTC. A meal cooked at 7pm in Chicago is
-- already "tomorrow" in UTC, so it was filed on the next day's square — or on
-- a square you'd never think to look at. Anything cooked after 7pm (6pm in
-- winter) landed on the wrong day.
--
-- The fix has two halves. Going forward, the browser now sends its own local
-- date with every cook, so the day is stamped correctly at the source. This
-- migration repairs the rows already recorded.
--
-- The first statement is a safety net: if migration 004 was never run on this
-- database, the cook log doesn't exist yet and nothing was ever recorded.
-- Creating it here is harmless if it's already there.
--
-- Safe to run on a live database. Only adds and corrects; nothing is dropped.
-- Paste into the D1 Console and Execute.

CREATE TABLE IF NOT EXISTS cook_events (
  id        TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  cooked_at INTEGER NOT NULL,          -- epoch ms
  cooked_on TEXT NOT NULL,             -- YYYY-MM-DD, for cheap grouping
  source    TEXT NOT NULL DEFAULT 'button'
);

CREATE INDEX IF NOT EXISTS idx_cook_events_day    ON cook_events(cooked_on);
CREATE INDEX IF NOT EXISTS idx_cook_events_recipe ON cook_events(recipe_id, cooked_at DESC);

-- Recompute every logged day in US Central time, which is where these meals
-- were actually cooked. -5 hours is CDT; every row in the log so far was
-- recorded during daylight time, so one offset covers all of them.
UPDATE cook_events
   SET cooked_on = date(cooked_at / 1000, 'unixepoch', '-5 hours');

-- Comment dates were stamped the same way and drift for the same reason.
UPDATE ratings
   SET date = date(created_at / 1000, 'unixepoch', '-5 hours')
 WHERE created_at IS NOT NULL;
