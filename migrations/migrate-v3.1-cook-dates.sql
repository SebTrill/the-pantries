-- The Pantries — migration v3.1: the cook count becomes the cook dates
--
-- Until now "cooked 14 times" was a plain integer on the recipe, written by
-- three different things — the cook button, rating a recipe, and the number
-- field on the edit form — only one of which also wrote a dated row to
-- cook_events. So the counter and the calendar could disagree, and did: a
-- recipe could read "cooked once" with an empty calendar and nothing anywhere
-- to say which was right.
--
-- From here the count is COUNTED, not stored. recipes.times_cooked is left in
-- place so an older deploy rolling back still reads something sane, but nothing
-- writes to it any more and nothing reads it.
--
-- MIGRATION 004 GOT ONE THING WRONG, AND THIS FIXES IT.
-- It said past cooks had no dates to recover. That was true of the bare
-- counter, but not of ratings: every rating carries the day it was made, and
-- rating a recipe has always meant you cooked it. So each dated rating becomes
-- the cook event it always was. Nothing is invented — a rating dated
-- 2026-08-20 produces a cook on 2026-08-20 and nothing else does.
--
-- The NOT EXISTS guard makes this safe to run more than once, and stops it
-- duplicating a rating that already logged its own cook.
--
-- Safe to run on a live database; only adds.
-- Paste into the D1 Console and Execute.

INSERT INTO cook_events (id, recipe_id, cooked_at, cooked_on, source)
SELECT
  lower(hex(randomblob(6))),
  r.recipe_id,
  r.created_at,
  r.date,
  'rating'
FROM ratings r
WHERE r.date IS NOT NULL
  AND r.date <> ''
  AND NOT EXISTS (
    SELECT 1 FROM cook_events c
     WHERE c.recipe_id = r.recipe_id
       AND c.cooked_on = r.date
  );
