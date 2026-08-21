-- The Pantries — migration v2.6: a shopping list that merges honestly
--
-- Two columns, both about not losing information when the same ingredient
-- arrives from more than one recipe.
--
--   sources  JSON array of recipe titles. The list used to keep only the first
--            recipe that put an item on it, so adding Pancakes to a list that
--            already held Lemon Bread's flour left a row that said "from Lemon
--            Bread" and never mentioned Pancakes again.
--
--   alt      JSON array of {qty, unit} for amounts that CANNOT be added to the
--            row's main amount. The merge used to add the numbers without ever
--            comparing the units, so "2 cups flour" plus "1 lb flour" became
--            "3 cups" — a pound silently turned into a cup. Same unit still
--            adds up; a different unit is kept alongside instead of converted,
--            because a pound and a cup of flour are not a quantity anyone can
--            add.
--
-- Existing rows are backfilled from from_recipe, which stays as it is so
-- nothing that reads it breaks.
--
-- Safe to run on a live database; only adds.
-- Paste into the D1 Console and Execute.

ALTER TABLE shopping_items ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';
ALTER TABLE shopping_items ADD COLUMN alt     TEXT NOT NULL DEFAULT '[]';

UPDATE shopping_items
   SET sources = '["' || replace(replace(from_recipe, '\', '\\'), '"', '\"') || '"]'
 WHERE sources IN ('', '[]')
   AND from_recipe <> ''
   AND from_recipe <> 'manual';
