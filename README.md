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

**Migrations** live in `migrations/`, numbered `00N-name.sql`, and are meant to be pasted into
the D1 Console and executed in order. They are all additive and safe to re-run — see
`migrations/README.md` for what each one does and which release it belongs to. `schema.sql`
already contains everything they add, so a database created from scratch needs none of them.

**The emoji palette holds emoji, not counts.** `emoji_palette` stores only what you added; how often
each one is used is read live from the `recipes` and `cookbooks` tables in `loadEmojiPalette()`. That
is deliberate — a stored tally would eventually disagree with the data, and there is no way to notice
when it does. The palette shows the twelve most-used, with the rest behind the + button.

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

## The recipe page

Ingredients are pinned in the left column and never move. The right column tabs between
Instructions and Substitutions. Both panels are **rendered into the page**, with the inactive one
hidden by CSS (`.tab-panel.is-hidden`). That is not an implementation detail you can tidy away —
see the print warning below.

Applying a substitution rewrites the instruction text to match: "cream the butter" reads "cream the
coconut oil". Two rules keep that honest, and both live in `renderStepHtml()`:

1. A swapped word is always marked (`.swapword`) and names its original on hover. If the steps could
   silently change, they would stop matching the cookbook they were copied from.
2. A mention that *opens* a sentence is left alone by default, because that is where the cooking verb
   lives — "Butter a 9×5 pan" means grease the pan. Swapping it would produce "Coconut oil a 9×5 pan".
   When one turns up, `promptAmbiguousMentions()` asks rather than guessing, and the answer applies to
   that one mention only.

Per-mention answers live in `state.mentionChoices`, keyed `recipeId|ingredientId|stepIndex|occurrence`.
`scanStep()` is deliberately the single source of that numbering — it is used both to draw a step and
to find its ambiguous mentions, so the two can never disagree about which occurrence is which.

---

## The cookbook page

It reads as a table of contents, because that is what you want when you are holding the book: page
number first, ordered by page. Recipes whose page you never wrote down collect under a "No page
recorded" heading rather than interleaving invisibly, so the gap is countable.

**Why this needed fixing:** `cardSourceLine()` suppresses the "from this book" line on a cookbook's own
page — correctly, since every card would repeat the same title. But the page number lived on that line,
so it disappeared with it. The one screen where the page number matters most was the one screen that
did not show it.

`pageNum()` reads the first integer out of the free-text page field, so "112", "p. 44" and "44-45" all
sort. Anything without a digit counts as unrecorded.

Book notes edit in place, and unlike a recipe this can safely go through `PUT /api/cookbooks/:id` —
that endpoint only touches columns, while photos and files live in their own table. The recipe
equivalent needs its own PATCH; see the warning further down.

---

## Ways into a recipe

Four: type it in, from a link, copy one you have, scan a photo. Typing one in from scratch is the least
common way you actually acquire a recipe, and for a long time it was one of only two.

**Copying** resets what was earned rather than given — cook count, ratings, `lastCookedAt` — and drops
photos, which live in object storage keyed to the original recipe.

**From a link** reads the schema.org JSON-LD that most recipe sites publish for search engines. No
markup guessing, no model call, no API key. `findRecipeNode()` handles the shapes that actually occur:
bare, in an array, under `@graph` (what WordPress emits), and `@type` arrays that merely include
"Recipe". `flattenInstructions()` handles strings, `HowToStep`, and `HowToSection` wrapping more steps.

One trap worth remembering there: when instructions arrive as a blob of HTML, block tags are the step
boundaries, so they are converted to newlines and **split before** `stripTags` runs. Stripping first
collapses all whitespace — newlines included — and every paragraph merges into one run-on step.

Both a copy and an import arrive holding real work before you have typed anything, so
`markEditBaseline(true)` marks them dirty from the start and the unsaved-work guard covers them.

Ingredients from a link go through the same `parseIngredientLine()` the paste-a-list dialog uses, so
"1 1/2 cups flour" splits identically however it arrived.

---

## The browse pages

Filters have to answer three questions at once: how many of your recipes you are looking at, what is
narrowing them, and how to undo one part of it. `renderActiveFilters()` draws a chip per active filter,
each removable on its own, with a clear-all beside them.

**Sort is deliberately not a filter.** It gets no chip and `browseFilterCount()` ignores it, because
reordering a list is not the same as hiding things from it. Adding sort to that row would make "Clear
all" mean two different things.

Quick filters (`QUICK_FILTERS`) are predicates over a recipe and stack with everything else — all of
them must pass. Their counts are computed against the whole collection, not the filtered view, so a
chip always tells you how many exist rather than how many survive the other filters.

**The list view earns its keep on a phone, not a desktop.** Measured on 22 recipes: at 1440px the grid
runs 1,576px and the list 1,350px, a 14% saving. At 430px the grid collapses to one column and runs
5,623px while the list stays 1,346px — 76% shorter. Grid is the default; the toggle is session state.
Narrow screens drop list columns rather than squeezing all eight.

**Cookbook covers are 3:4.** A book is portrait, and the old landscape thumbnail cropped a real cover
through the middle. Books with no photo get one of the cloth tones from the home-page shelf; those
selectors are written `.bcov.toneA` rather than `.toneA` so they outrank the hatched fallback on
`.bcard .bcov` instead of quietly losing the specificity contest.

---

## The edit forms

Save and Cancel live in a sticky bar at the top. Fields are capped at a readable width, grouped into
sections, and ingredients sit beside instructions — the same shape as the recipe page you are editing
toward. Times cooked and Delete live in a Record strip at the bottom, because both are corrections
rather than things you fill in while writing a recipe.

**The unsaved-work guard.** Dirtiness is *measured*, not tracked: `markEditBaseline()` snapshots the
draft when a form opens and `isEditDirty()` compares the live draft against it. A change you typed and
then undid is correctly not dirty. `guardEdit(leave, onStay)` fronts every exit — the top bar, Cancel,
the browser's back button, and `beforeunload` for closing the tab.

Back is the awkward one. By the time `popstate` fires the address has already changed, so choosing to
stay has to push the edit URL back on. That is what the `onStay` callback is for.

One trap worth remembering: `openRecipe()` guards on `inEditForm() && isEditDirty()`, not on
`inEditForm()` alone. Guarding on the latter recurses forever, because the retry callback calls
`openRecipe()` again while the view is still the form. Saving a recipe hits that path every time.

**Pasting a list.** `parseIngredientLine()` splits "1 1/2 cups all-purpose flour" into quantity, unit
and name using the same `parseQty()` that protects fractions everywhere else. It strips bullets and
list numbering, treats a leading "a"/"an" as a stand-in quantity so "a pinch of salt" reads correctly,
and only accepts a word as a unit if it is in `COMMON_UNITS`. Everything parsed is shown before
anything is added.

---

## The shopping list

The list is grouped the way a shop is laid out rather than in the order things were added, so you
walk it once. `AISLES` in `public/app.js` is both the classifier and the running order — the array's
order is the page's order, produce first and drinks last. Sections come out of the ingredient name;
anything unrecognised goes to **Other**, visibly, rather than being guessed into the wrong aisle.

`aisleFor()` asks the **end** of the name before the whole name. In English the last word is the thing
you are buying and everything before it describes it, so "chicken stock" is a stock and not a chicken.
Without that rule "chicken" wins for being the longer word and the row lands in the meat aisle. Two
things override it: a multi-word key beats a one-word key ("sour cream" beats "cream"), and "frozen"
beats the noun it modifies, because frozen peas are in the freezer and not with the fresh produce.

Ticked items leave their aisle and collect in the **Got it** drawer. They used to stay put at half
opacity, which made the part you still had to shop harder to read the further along you got.

### Merging, which had three bugs in it

Adding the same ingredient twice merges the rows. All three of the following were live:

**Units were never compared.** The merge added the numbers and kept the first row's unit — and the
query that looked for a match did not even `SELECT` the unit column. "2 cups flour" plus "1 lb flour"
came back as "3 cups". Now `unitKey()` normalises spelling (tablespoon / Tablespoons / Tbsp. all land
on `tbsp`) and `foldQty()` only adds when the units are actually the same. When they are not, the
other amount is kept beside the row in `alt` and shown as a note — never converted, because a pound
and a cup of flour are not a quantity anyone can add.

**Names were compared as whole strings**, so "Lemons, Zested and Juiced", "Lemons" and "Lemon" were
three rows and you would have bought lemons three times. `shopKey()` drops the preparation clause
after the comma, drops a few leading adjectives, and singularises.

It deliberately does **not** do substring matching. The client's `subMatches()` does, which is right
for offering a substitution and badly wrong for deciding what to buy — it would merge Butter into
Buttermilk. If you ever "improve" `shopKey()` by reusing `subMatches()`, `aisle-test.js` and
`shop-merge-test.js` will both tell you.

**Only the first recipe was remembered.** Adding Pancakes to a list that already held Lemon Bread's
flour left a row reading "from Lemon Bread" and never mentioning Pancakes. Sources accumulate in
`sources` now.

Two smaller consequences worth knowing. Merging shortens a name that carries a comma, because
"Lemons, Zested and Juiced" is not a thing to buy six of. And grouped **By recipe**, a shared row
appears under every recipe that wants it carrying the whole amount — so it says "shared · also for
…", which is the difference between "buy six lemons" and "buy six lemons for this salad".

The `Find` menu opens **sideways** into its own row, not downwards. Dropping it below covered the next
two rows' buttons, so a click meant for the row underneath landed on this row's shop link instead.

Migration `migrations/008-shopping.sql` adds `sources` and `alt` and backfills from `from_recipe`.

---

## Six details that are easy to break

**Calendar days come from the browser, not the server.** The Worker's clock is UTC. Stamp a
cook's day from it and a meal cooked at 7pm in Chicago is filed under tomorrow — logged, but
on the wrong square. So the browser sends its own local date with every cook and rating, the
Worker sanity-checks it (`localDay()` in `src/index.js`), and every day-key on the client is
built from `localDay()` rather than `toISOString()`. If you ever reach for
`toISOString().slice(0,10)` to get "today", you have just reintroduced this bug.

**"Unrated" and "rated zero" must not look alike.** Cards used to render `☆☆☆☆☆` for a recipe nobody
had rated, which reads as a one-star-out-of-five verdict rather than an absence. Unrated now says so in
words. If you ever collapse that back into a star row, fourteen of twenty-two recipes start looking
like failures again.

**A hover-only control does not exist on a phone.** The delete × on a card was `opacity:0` until
`:hover`, which is unreachable without a mouse. It is now visible at reduced opacity under
`@media (hover:none)`. Any new hover-revealed affordance needs the same treatment.

**Printing needs both tab panels in the DOM.** A print stylesheet can only hide what is already on
the page. The recipe page used to render just the open tab, so printing from Ingredients gave you a
recipe with no method and printing from Instructions gave you steps with no ingredients — whichever
tab you happened to be on became the whole printout. Both panels are now always rendered and the
inactive one is hidden with CSS, which is what lets `@media print` bring the instructions back. If
you ever "optimise" this by only rendering the active panel, that bug comes straight back.

**Notes have their own endpoint for a reason.** `PUT /api/recipes/:id` rebuilds a recipe from its
payload — it deletes and reinserts every ingredient, step, tag and category. A notes-only PUT would
therefore empty the recipe. Inline notes editing uses `PATCH /api/recipes/:id/notes`, which touches
one column. Do not route it back through PUT.

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
