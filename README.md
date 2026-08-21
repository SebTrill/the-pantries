# The Pantries

A personal recipe site: search and filter, ingredient scaling with real fractions, an
auto-matching substitutions library, a shopping list with store links, photo galleries,
and AI recipe import from a photo.

Runs entirely on Cloudflare's free tiers.

---

## How it's put together

| Piece | What it does |
|---|---|
| **Cloudflare Workers** | Serves the site and runs the API (`src/index.js`) |
| **D1** | SQLite database — recipes, ingredients, ratings, substitutions, shopping list |
| **R2** | Object storage for photos |
| **Cloudflare Access** | Email login in front of the whole site |
| **Anthropic API** | Reads photographed recipes into structured data |

```
public/          the site you see in the browser
  index.html       page shell
  styles.css       all styling
  app.js           the whole app: views, state, API calls
src/index.js     the Worker: API routes, R2 photo serving, AI scanning
schema.sql       database structure
seed.sql         starter substitutions
wrangler.jsonc   Cloudflare config (bindings, deploy settings)
```

There is no build step and no framework. `app.js` is plain JavaScript that renders HTML
strings — open it and you can read straight through it.

---

## First-time deploy

Run everything from inside the project folder, on your own computer.
You need [Node.js](https://nodejs.org) installed (the LTS version is fine).

```bash
npm install
npx wrangler login          # opens a browser — no API token needed
```

### Stage 1 — get it live on the free URL

**1. The database is already created and wired into `wrangler.jsonc`.**

**2. Create the photo bucket:**
```bash
npx wrangler r2 bucket create pantries-photos
```

**3. Build the tables and load the starter substitutions:**
```bash
npm run db:init
npm run db:seed
```

**4. Set a site password.** Until Cloudflare Access is switched on this is the only thing
standing between your recipes and anyone who guesses the URL — do not skip it:
```bash
npx wrangler secret put SITE_PASSWORD
```

**5. Add your Anthropic key** so photo scanning works. Skip it and the site runs fine with
the scan option greyed out:
```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

**6. Deploy:**
```bash
npm run deploy
```

It prints a URL like `https://the-pantries.<your-subdomain>.workers.dev`. Open it, enter
your password, and you have a working site.

### Stage 2 — move it to the-pantries.com

Once the domain is registered and active in your Cloudflare account, uncomment the
`routes` block at the bottom of `wrangler.jsonc` and deploy again:

```bash
npm run deploy
```

Then set up Access (below). Once Access is protecting the hostname the password gate
detects it and steps aside automatically — you can leave the secret in place.

---

## Locking it down with Cloudflare Access

This replaces the shared password with proper per-person email login. It requires the
site to be on the-pantries.com first — Access cannot protect a `.workers.dev` URL.

1. Cloudflare dashboard → **Zero Trust** → choose a team name if prompted
2. **Access → Applications → Add an application → Self-hosted**
3. Application domain: `the-pantries.com`
4. Add a policy: Action **Allow**, rule type **Emails**, then your email address
   (add family members here too — free for up to 50 people)
5. Leave the default one-time-PIN login method and save

Visiting the site now emails you a six-digit code. The verified email shows in the footer.

**How the two layers interact:** the Worker checks for Cloudflare's verified-identity
header first. If it is present, the password gate is skipped entirely. If Access is ever
removed, the password gate automatically takes over again — so there is no window where
the site sits unprotected.

---

## Working on it locally

```bash
npm run db:init:local     # once
npm run db:seed:local     # once
npm run dev               # http://localhost:8787
```

The local database is completely separate from the live one, so experiment freely.
Scanning won't work locally unless you also put `ANTHROPIC_API_KEY` in a `.dev.vars`
file (never commit that file).

---

## Backups

Click **Download backup** in the footer, or hit `/api/export`. You get one JSON file with
every recipe, rating, substitution, and shopping item. Photos stay in R2 — the export
references them by URL.

For a database-level snapshot:
```bash
npm run backup            # writes backup.sql
```

Worth doing occasionally. The whole point of the export button is that your recipes are
never trapped in someone else's platform.

---

## Things you might want to change later

**Change the site password** — set the secret again and redeploy:
```bash
npx wrangler secret put SITE_PASSWORD
```

**Swap the scanning model** — set a different model in `wrangler.jsonc`:
```jsonc
"vars": { "SCAN_MODEL": "claude-sonnet-4-5" }
```

**Adjust how substitutions match ingredients** — `subMatches()` in both `public/app.js`
and `src/index.js`. It normalizes names (drops everything after a comma, handles plurals)
and matches loosely, which is why "Butter" also matches "Butter, Melted".

**Change the look** — `public/styles.css` holds the whole design in one place. The palette
lives in `:root` at the top: a brown-black ground with ochre, brick and olive accents drawn
from printing inks rather than screen colours. Three typefaces, each with one job — Bevan
(slab) for headings and numerals, Petrona for anything you read while cooking, IBM Plex Mono
for quantities and labels. All three are self-hosted in `public/fonts/`, so there is no
third-party font request and the site works offline.

Bevan has no light weights and gets clumsy below about 15px — keep it to headings, section
labels and big numbers, never body text or dense UI.

**Change photo size on upload** — the `max` argument in `downscale()` in `public/app.js`,
currently 1400px. Photos are re-encoded as JPEG before upload to keep the site quick.

**Migrations** live in the repo root as `migrate-00N-*.sql` and are meant to be pasted into
the D1 Console and executed. They are all additive and safe to re-run. Run them in order;
`migrate-005-local-days.sql` is the most recent and repairs cook days that were recorded in
UTC.

**Add a field to every recipe** (prep time, source, oven temperature) — this one needs a
migration, since existing rows need the new column:
```bash
npx wrangler d1 execute pantries-db --remote --command "ALTER TABLE recipes ADD COLUMN prep_minutes INTEGER"
```
then surface it in `saveRecipe()`, `loadRecipes()`, and the edit form.

---

## The URL is derived from state, never the other way round

Every view is a real page — `/home`, `/browse-recipes`, `/recipe?id=…`, `/recipe/edit?id=…`,
`/browse-cookbooks`, `/cookbook?id=…`, `/cookbook/edit`, `/shopping-list`, `/substitutions`,
`/add-recipe`. Back, forward, refresh and bookmarks all work, and a link to a recipe is a
link to that recipe.

The rule that keeps it simple: `urlForState()` computes the address from the current view,
and `render()` calls `syncUrl()` at the end. No navigation has to remember to update the
URL — it just falls out. Going the other way, `applyUrl()` reads the address into state and
runs on first load and on `popstate`. Deep links that name a record (`/recipe?id=…`) need
the data loaded first, which is why `applyUrl()` runs after `/api/bootstrap` returns rather
than at page load.

If you add a view, add it to both `urlForState()` and `applyUrl()`. Miss one and the address
bar and the page quietly disagree.

The Worker serves the app shell for any non-API path without a file extension that the asset
server doesn't recognise, so a hard refresh on `/recipe/edit` works.

---

## Three details that are easy to break

**Calendar days come from the browser, not the server.** The Worker's clock is UTC. Stamp a
cook's day from it and a meal cooked at 7pm in Chicago is filed under tomorrow — logged, but
on the wrong square. So the browser sends its own local date with every cook and rating, the
Worker sanity-checks it (`localDay()` in `src/index.js`), and every day-key on the client is
built from `localDay()` rather than `toISOString()`. If you ever reach for
`toISOString().slice(0,10)` to get "today", you have just reintroduced this bug.

**Quantities are stored twice, on purpose.** `qty` is a number for scaling maths; `qty_raw`
is the text exactly as typed. If you ever collapse those into one field, `1/2` will silently
become `1` — JavaScript's `parseFloat("1/2")` returns `1`. That is why `parseQty()` exists
and why it is duplicated on both the client and the server.

**Applied substitutions are deliberately temporary.** Swapping an ingredient on a recipe
page lives in browser memory only and never touches the database. Leaving the page warns
you and reverts. Don't "fix" this by persisting it — a substitution you used once on a
Tuesday shouldn't permanently rewrite the recipe.

---

## Running costs

Free at personal scale. The free tiers are 5 GB of database, 10 GB of photo storage, and
100,000 database writes a day — a recipe is a few kilobytes and a photo about 250 KB after
downscaling, so a library of thousands of recipes stays comfortably inside them.

The only metered cost is recipe scanning, at roughly a cent or two per photo, billed by
Anthropic.
