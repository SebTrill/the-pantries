-- v3.5 — rate limiting for the site-password gate.
--
-- One row per IP that has guessed wrong, not one per attempt: the row is the
-- running count, and a correct password deletes it. Nothing here is read unless
-- SITE_PASSWORD is set, so a site behind Cloudflare Access never touches it.
--
-- Safe to re-run: CREATE TABLE IF NOT EXISTS, unlike the ALTER TABLE migrations.

CREATE TABLE IF NOT EXISTS login_attempts (
  ip            TEXT PRIMARY KEY,
  fails         INTEGER NOT NULL DEFAULT 0,
  first_at      INTEGER NOT NULL,      -- start of the current 15-minute window
  blocked_until INTEGER NOT NULL DEFAULT 0
);
