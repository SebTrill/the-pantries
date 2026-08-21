# Migrations

Paste each file into the **D1 Console** and Execute, lowest number first.

Nothing here drops a column, deletes a row, or changes data that is already
right. Running one a second time cannot damage anything — but two of the three
kinds behave differently, and it is worth knowing which you are looking at
before a red error message alarms you:

- **`CREATE TABLE IF NOT EXISTS`** (004, 007) — runs cleanly however many times
  you run it.
- **`INSERT ... WHERE NOT EXISTS`** (009) — runs cleanly too, and will not
  duplicate what it already inserted. Verified by running it twice against a
  copy of a real database.
- **`ALTER TABLE ADD COLUMN`** (002, 003, 006, 008, 010) — these **fail with
  `duplicate column name` if you run them twice**, and D1 stops executing the
  file at that point. That is noisy but harmless: the column is already there,
  and any backfill further down the file already ran on the first pass. If you
  see that error, the migration was already applied. Nothing is left half-done.

SQLite has no `ADD COLUMN IF NOT EXISTS`, which is why the third kind cannot be
made quiet.

**A database created from `schema.sql` needs none of these.** `schema.sql` is
always the current shape; these exist only to carry an already-deployed
database forward. If you are setting the site up fresh, run `setup-database.sql`
and skip this folder entirely.

There is no migration 001 — that was the original `schema.sql`.

| # | File | Adds | Shipped with |
|---|------|------|--------------|
| 002 | `002-cookbooks.sql` | recipe notes, the `cookbooks` table and the link from a recipe to a book | cookbooks |
| 003 | `003-focal.sql` | focal points on images, so a cover crops to the part you meant | photo handling |
| 004 | `004-cook-log.sql` | the `cook_events` table — one row per meal, with a date | update 10 |
| 005 | `005-local-days.sql` | repairs cook days that were recorded in UTC and landed a day late | update 10 |
| 006 | `006-times.sql` | prep and cook minutes (0 means "not recorded" and shows as an em dash) | update 10 |
| 007 | `007-emoji.sql` | the `emoji_palette` table for emoji you add yourself | update 12 |
| 008 | `008-shopping.sql` | `sources` and `alt` on shopping items, so a merged row remembers every recipe that wants it and never converts one unit into another | update 15 |
| 009 | `009-cook-dates.sql` | backfills `cook_events` from every dated rating | update 16 |
| 010 | `010-macros.sql` | six nullable per-serving macro columns on `recipes` | update 17 |

## Two of these correct earlier mistakes

**005** exists because `dayKey()` built calendar days from `toISOString()`, which
is UTC. An evening meal cooked at 7pm in a western timezone was filed under the
next day. It rewrites the affected rows using the day the browser reported.

**009** exists because **004 was wrong about what could be recovered.** It said
past cooks had no dates and declined to invent any — correct for the bare
counter, but ratings have always carried the day they were made, and rating a
recipe has always meant you cooked it. Those were recoverable and 004 threw them
away. 009 turns each dated rating into the cook event it always was. It invents
nothing: a rating dated 2026-08-20 produces one cook on 2026-08-20 and nothing
else does.

Run 009 after 004, or it will find no table to insert into.
