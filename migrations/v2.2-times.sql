-- The Pantries — migration v2.2: how long a recipe takes
--
-- Until now a recipe recorded how many it serves but not how long it takes,
-- which is usually the first thing you want to know when deciding what to cook.
--
-- Both default to 0, which the app reads as "not set" and shows as an em dash.
-- Nothing looks broken on recipes you haven't filled in yet.
--
-- Safe to run on a live database; only adds columns.
-- Paste into the D1 Console and Execute.

ALTER TABLE recipes ADD COLUMN prep_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recipes ADD COLUMN cook_minutes INTEGER NOT NULL DEFAULT 0;
