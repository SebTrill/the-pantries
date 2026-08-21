-- The Pantries — migration v3.2: macros
--
-- Six figures per recipe, all optional, all per serving.
--
-- WHY THESE ARE NULLABLE AND prep_minutes IS NOT.
-- Elsewhere in this schema 0 stands in for "not recorded" — a recipe with
-- prep_minutes = 0 shows an em dash, because no recipe takes zero minutes to
-- prepare, so the number is free to mean something else.
--
-- Macros are not like that. A glass of water has 0 calories. A roast has 0
-- sugar. Those are answers, not silence, and the recipe page is required to
-- show them while showing nothing at all for a figure you never filled in. So
-- "not recorded" has to be NULL here, and every read and write of these six
-- columns has to keep NULL and 0 apart.
--
-- Units: calories in kcal, everything else in grams. Stored as REAL because
-- 6.2 g of protein is a normal thing to write down.
--
-- Safe to run on a live database; only adds. Running it twice fails with
-- "duplicate column name" and changes nothing — see this folder's README.
-- Paste into the D1 Console and Execute.

ALTER TABLE recipes ADD COLUMN kcal      REAL;
ALTER TABLE recipes ADD COLUMN protein_g REAL;
ALTER TABLE recipes ADD COLUMN fat_g     REAL;
ALTER TABLE recipes ADD COLUMN carbs_g   REAL;
ALTER TABLE recipes ADD COLUMN sugar_g   REAL;
ALTER TABLE recipes ADD COLUMN fiber_g   REAL;
