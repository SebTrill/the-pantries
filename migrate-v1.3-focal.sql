-- The Pantries — migration v1.3: image focal points
-- Lets you choose which part of a photo shows when it's cropped into a cover.
-- 50/50 is dead centre, which is what every existing image gets.
-- Safe to run on a live database; only adds columns.

ALTER TABLE photos ADD COLUMN focal_x REAL NOT NULL DEFAULT 50;
ALTER TABLE photos ADD COLUMN focal_y REAL NOT NULL DEFAULT 50;

ALTER TABLE cookbook_files ADD COLUMN focal_x REAL NOT NULL DEFAULT 50;
-- Book covers default to the upper third, where titles usually sit.
ALTER TABLE cookbook_files ADD COLUMN focal_y REAL NOT NULL DEFAULT 30;
