/**
 * The Pantries — Cloudflare Worker API
 *
 * Routes:
 *   GET    /api/bootstrap            everything the app needs on load
 *   POST   /api/recipes              create
 *   PUT    /api/recipes/:id          update
 *   DELETE /api/recipes/:id          delete (cascades)
 *   POST   /api/recipes/:id/cook     increment cook counter + log the cook
 *                                    body: {day} — the cook's LOCAL date
 *   POST   /api/recipes/:id/ratings  add rating + increment cook counter
 *   POST   /api/recipes/:id/photos   upload photo -> R2
 *   DELETE /api/photos/:id           delete photo (promotes a new cover if needed)
 *   POST   /api/photos/:id/cover     make photo the cover
 *   GET    /photos/:key              serve image bytes from R2
 *   GET    /api/substitutions        library + recipe-local
 *   POST   /api/substitutions        create
 *   PUT    /api/substitutions/:id    update
 *   DELETE /api/substitutions/:id    delete
 *   GET    /api/shopping             shopping list
 *   POST   /api/shopping             add one or many items
 *   PATCH  /api/shopping/:id         toggle/edit item
 *   DELETE /api/shopping/:id         remove item
 *   POST   /api/shopping/clear-checked
 *   GET    /files/:key               download a scanned cookbook file from R2
 *   POST   /api/cookbooks            create
 *   PUT    /api/cookbooks/:id        update
 *   DELETE /api/cookbooks/:id        delete (recipes survive, link cleared)
 *   POST   /api/cookbooks/:id/files  upload a photo or scanned file
 *   POST   /api/cookbook-files/:id/cover   make photo the book's cover
 *   POST   /api/photos/:id/focal        set which part of a photo shows when cropped
 *   POST   /api/cookbook-files/:id/focal   same, for book photos
 *   DELETE /api/cookbook-files/:id   delete a photo or file
 *   POST   /api/scan                 photo -> structured recipe (Anthropic vision)
 *   GET    /api/export               full JSON backup
 *   GET    /api/whoami               logged-in identity (via Cloudflare Access)
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const err = (message, status = 400) => json({ error: message }, status);

const uid = () =>
  crypto.randomUUID().replace(/-/g, '').slice(0, 12);

const now = () => Date.now();
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

/** A request body that may be empty — POSTs without a body are normal here. */
async function readJson(request) {
  try { return await request.json(); } catch (e) { return {}; }
}

/**
 * Which calendar day a meal belongs to.
 *
 * The Worker's clock is UTC, so stamping the day from it puts anything cooked
 * after early evening in the Americas on TOMORROW's square — the meal is logged
 * but shows up on the wrong day, or on no day you'd think to look at. The
 * browser is the only party that knows the cook's real local date, so it sends
 * it. We sanity-check it against our own clock (a day either way is plausible;
 * anything further is a broken or spoofed client) and fall back to the timezone
 * Cloudflare attaches to the request, then to UTC.
 */
function localDay(body, request, ts) {
  const claimed = body && typeof body.day === 'string' ? body.day.trim() : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(claimed)) {
    const noon = Date.parse(claimed + 'T12:00:00Z');
    if (Number.isFinite(noon) && Math.abs(noon - ts) < 36 * 3600 * 1000) return claimed;
  }
  const tz = request && request.cf && request.cf.timezone;
  if (tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(ts));
    } catch (e) { /* unknown zone: fall through to UTC */ }
  }
  return dayKey(ts);
}

/** Records one cooked meal. Called by the cook button and by rating a recipe. */
function logCook(db, recipeId, ts, day, source) {
  return db.prepare(
    'INSERT INTO cook_events (id,recipe_id,cooked_at,cooked_on,source) VALUES (?,?,?,?,?)'
  ).bind(uid(), recipeId, ts, day, source);
}

/* ---------- text + quantity normalization (mirrors the client) ---------- */

const SMALL_WORDS = new Set(['a','an','and','as','at','but','by','for','in','of','on','or',
  'the','to','with','from','into','per','over']);

function titleCase(str) {
  if (str == null) return '';
  const s = String(str).trim().replace(/\s+/g, ' ').toLowerCase();
  if (!s) return '';
  return s.split(' ').map((word, wi) =>
    word.split(/([-/&])/).map((part, pi) => {
      if (!part || /^[-/&]$/.test(part)) return part;
      if (wi > 0 && pi === 0 && SMALL_WORDS.has(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    }).join('')
  ).join(' ');
}

const UNICODE_FRAC = { '½':0.5,'⅓':1/3,'⅔':2/3,'¼':0.25,'¾':0.75,'⅕':0.2,'⅖':0.4,'⅗':0.6,
  '⅘':0.8,'⅙':1/6,'⅚':5/6,'⅛':0.125,'⅜':0.375,'⅝':0.625,'⅞':0.875 };

/** "1 1/2" -> 1.5, "¾" -> 0.75. Never truncates a fraction the way parseFloat does. */
function parseQty(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : 0;
  let s = String(input ?? '').trim();
  if (!s) return 0;
  let total = 0, matched = false;
  for (const ch in UNICODE_FRAC) {
    while (s.includes(ch)) { total += UNICODE_FRAC[ch]; s = s.replace(ch, ' '); matched = true; }
  }
  for (const part of s.trim().split(/\s+/).filter(Boolean)) {
    const fr = part.match(/^(\d+)\/(\d+)$/);
    if (fr) { const d = +fr[2]; if (d) { total += (+fr[1]) / d; matched = true; } continue; }
    const f = parseFloat(part);
    if (!Number.isNaN(f)) { total += f; matched = true; }
  }
  return matched ? total : 0;
}

/* ---------- data loading ---------- */

async function loadRecipes(db) {
  const [recipes, ings, steps, cats, tags, ratings, photos] = await Promise.all([
    db.prepare('SELECT * FROM recipes ORDER BY date_added DESC').all(),
    db.prepare('SELECT * FROM ingredients ORDER BY recipe_id, position').all(),
    db.prepare('SELECT * FROM instructions ORDER BY recipe_id, position').all(),
    db.prepare(`SELECT rc.recipe_id, c.name FROM recipe_categories rc
                JOIN categories c ON c.id = rc.category_id ORDER BY c.name`).all(),
    db.prepare('SELECT * FROM tags').all(),
    db.prepare('SELECT * FROM ratings ORDER BY created_at ASC').all(),
    db.prepare('SELECT * FROM photos ORDER BY created_at ASC').all(),
  ]);

  const byId = new Map();
  for (const r of recipes.results) {
    byId.set(r.id, {
      id: r.id,
      title: r.title,
      emoji: r.emoji,
      baseServings: r.base_servings,
      timesCooked: r.times_cooked,
      dateAdded: r.date_added,
      notes: r.notes || '',
      cookbookId: r.cookbook_id || null,
      cookbookPage: r.cookbook_page || '',
      categories: [],
      tags: [],
      ingredients: [],
      instructions: [],
      ratings: [],
      images: [],
      localSubs: [],
    });
  }
  const push = (rows, key, fn) => {
    for (const row of rows.results) {
      const r = byId.get(row.recipe_id);
      if (r) r[key].push(fn(row));
    }
  };
  push(ings, 'ingredients', i => ({
    id: i.id, qty: i.qty, qtyRaw: i.qty_raw, unit: i.unit, name: i.name }));
  push(steps, 'instructions', s => s.text);
  push(cats, 'categories', c => c.name);
  push(tags, 'tags', t => t.name);
  push(ratings, 'ratings', c => ({
    id: c.id, stars: c.stars, comment: c.comment, date: c.date, ts: c.created_at }));
  push(photos, 'images', p => ({
    id: p.id, url: `/photos/${p.r2_key}`, caption: p.caption, favorite: !!p.is_cover,
    focalX: p.focal_x == null ? 50 : p.focal_x, focalY: p.focal_y == null ? 50 : p.focal_y }));

  return [...byId.values()];
}

async function loadCookbooks(db) {
  const [books, files] = await Promise.all([
    db.prepare('SELECT * FROM cookbooks ORDER BY title COLLATE NOCASE').all(),
    db.prepare('SELECT * FROM cookbook_files ORDER BY created_at').all(),
  ]);
  const byId = new Map();
  for (const b of books.results) {
    byId.set(b.id, {
      id: b.id, title: b.title, author: b.author, publisher: b.publisher,
      published: b.published, edition: b.edition, isbn: b.isbn,
      notes: b.notes, emoji: b.emoji, images: [], files: [],
    });
  }
  for (const f of files.results) {
    const b = byId.get(f.cookbook_id);
    if (!b) continue;
    const entry = {
      id: f.id,
      url: (f.kind === 'photo' ? '/photos/' : '/files/') + f.r2_key,
      filename: f.filename, contentType: f.content_type,
      sizeBytes: f.size_bytes, favorite: !!f.is_cover,
      focalX: f.focal_x == null ? 50 : f.focal_x,
      focalY: f.focal_y == null ? 30 : f.focal_y,
    };
    (f.kind === 'photo' ? b.images : b.files).push(entry);
  }
  return [...byId.values()];
}

async function bootstrap(db) {
  const since = dayKey(Date.now() - 400 * 86400000);   // a full year of history, plus slack
  const [recipes, subs, shopping, cats, cookbooks, activity, lastCooked] = await Promise.all([
    loadRecipes(db),
    db.prepare('SELECT * FROM substitutions ORDER BY ingredient').all(),
    db.prepare('SELECT * FROM shopping_items ORDER BY created_at').all(),
    db.prepare('SELECT name FROM categories ORDER BY name').all(),
    loadCookbooks(db),
    db.prepare(`SELECT cooked_on AS day, COUNT(*) AS n FROM cook_events
                WHERE cooked_on >= ? GROUP BY cooked_on`).bind(since).all(),
    db.prepare(`SELECT recipe_id, MAX(cooked_at) AS last FROM cook_events GROUP BY recipe_id`).all(),
  ]);
  const lastById = new Map(lastCooked.results.map(r => [r.recipe_id, r.last]));
  for (const r of recipes) r.lastCookedAt = lastById.get(r.id) || null;

  const globalSubs = [];
  const localByRecipe = new Map();
  for (const s of subs.results) {
    const entry = { id: s.id, ingredient: s.ingredient, substitute: s.substitute, notes: s.notes };
    if (s.recipe_id) {
      if (!localByRecipe.has(s.recipe_id)) localByRecipe.set(s.recipe_id, []);
      localByRecipe.get(s.recipe_id).push(entry);
    } else {
      globalSubs.push(entry);
    }
  }
  for (const r of recipes) r.localSubs = localByRecipe.get(r.id) || [];

  return {
    recipes,
    cookbooks,
    activity: activity.results.map(a => ({ day: a.day, n: a.n })),
    globalSubs,
    allCategories: cats.results.map(c => c.name),
    shoppingList: shopping.results.map(s => ({
      id: s.id, name: s.name, qty: s.qty, unit: s.unit,
      checked: !!s.checked, fromRecipe: s.from_recipe, origName: s.orig_name || undefined,
    })),
  };
}

/* ---------- recipe writes ---------- */

async function categoryIds(db, names) {
  const ids = [];
  for (const raw of names) {
    const name = titleCase(raw);
    if (!name) continue;
    await db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').bind(name).run();
    const row = await db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE')
      .bind(name).first();
    if (row) ids.push(row.id);
  }
  return ids;
}

async function saveRecipe(db, body, existingId) {
  const id = existingId || uid();
  const ts = now();
  const title = String(body.title || '').trim() || 'Untitled Recipe';
  const emoji = body.emoji || '🍽️';
  const baseServings = parseQty(body.baseServings) || 1;
  const dateAdded = body.dateAdded || new Date().toISOString().slice(0, 10);

  const notes = String(body.notes || '').trim();
  const cookbookId = body.cookbookId ? String(body.cookbookId) : null;
  const cookbookPage = String(body.cookbookPage || '').trim();

  if (existingId) {
    await db.prepare(
      `UPDATE recipes SET title=?, emoji=?, base_servings=?, notes=?,
                          cookbook_id=?, cookbook_page=?, updated_at=? WHERE id=?`
    ).bind(title, emoji, baseServings, notes, cookbookId, cookbookPage, ts, id).run();

    if (body.timesCooked !== undefined && body.timesCooked !== null) {
      const n = Math.max(0, Math.round(Number(body.timesCooked)));
      if (Number.isFinite(n)) {
        await db.prepare('UPDATE recipes SET times_cooked=? WHERE id=?').bind(n, id).run();
      }
    }
  } else {
    await db.prepare(
      `INSERT INTO recipes (id,title,emoji,base_servings,times_cooked,date_added,
                            notes,cookbook_id,cookbook_page,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, title, emoji, baseServings, body.timesCooked || 0, dateAdded,
           notes, cookbookId, cookbookPage, ts, ts).run();
  }

  const catIds = await categoryIds(db, body.categories || []);

  const stmts = [
    db.prepare('DELETE FROM ingredients   WHERE recipe_id = ?').bind(id),
    db.prepare('DELETE FROM instructions  WHERE recipe_id = ?').bind(id),
    db.prepare('DELETE FROM tags          WHERE recipe_id = ?').bind(id),
    db.prepare('DELETE FROM recipe_categories WHERE recipe_id = ?').bind(id),
  ];

  (body.ingredients || []).filter(i => String(i.name || '').trim()).forEach((i, idx) => {
    const qtyRaw = i.qtyRaw != null ? String(i.qtyRaw) : String(i.qty ?? '');
    stmts.push(db.prepare(
      `INSERT INTO ingredients (id,recipe_id,position,qty,qty_raw,unit,name) VALUES (?,?,?,?,?,?,?)`
    ).bind(uid(), id, idx, parseQty(qtyRaw), qtyRaw, String(i.unit || '').trim(), titleCase(i.name)));
  });

  (body.instructions || []).filter(s => String(s || '').trim()).forEach((s, idx) => {
    stmts.push(db.prepare(
      'INSERT INTO instructions (id,recipe_id,position,text) VALUES (?,?,?,?)'
    ).bind(uid(), id, idx, String(s).trim()));
  });

  [...new Set((body.tags || []).map(titleCase).filter(Boolean))].forEach(t => {
    stmts.push(db.prepare('INSERT OR IGNORE INTO tags (recipe_id,name) VALUES (?,?)').bind(id, t));
  });

  catIds.forEach(cid => {
    stmts.push(db.prepare(
      'INSERT OR IGNORE INTO recipe_categories (recipe_id,category_id) VALUES (?,?)'
    ).bind(id, cid));
  });

  await db.batch(stmts);
  return id;
}

/* ---------- AI recipe scanning ---------- */

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Recipe name. If none is visible, invent a short descriptive one.' },
    emoji: { type: 'string', description: 'A single emoji that suits the dish.' },
    baseServings: { type: 'number', description: 'Servings/yield the recipe as written makes. Default 4 if unstated.' },
    categories: {
      type: 'array', items: { type: 'string' },
      description: 'One to three of: Breakfast, Lunch, Dinner, Dessert, Soup, Side, Snack, Drink, Vegetarian, Quick & Easy.',
    },
    tags: { type: 'array', items: { type: 'string' }, description: 'Two to five short keywords.' },
    ingredients: {
      type: 'array',
      description: 'Every ingredient, in order.',
      items: {
        type: 'object',
        properties: {
          qtyRaw: { type: 'string', description: 'Quantity EXACTLY as written: "1 1/2", "3/4", "2". Empty string if none.' },
          unit: { type: 'string', description: 'Unit only: cup, cups, tbsp, tsp, oz, lb, cloves. Empty if none.' },
          name: { type: 'string', description: 'Ingredient name and prep, e.g. "butter, melted". No quantity or unit here.' },
          uncertain: { type: 'boolean', description: 'True if the quantity or name was hard to read and should be double-checked.' },
        },
        required: ['qtyRaw', 'unit', 'name', 'uncertain'],
      },
    },
    instructions: { type: 'array', items: { type: 'string' }, description: 'Numbered steps in order, one per array entry.' },
    notes: { type: 'string', description: 'Anything unreadable or worth flagging to the user. Empty string if all clear.' },
  },
  required: ['title', 'emoji', 'baseServings', 'categories', 'tags', 'ingredients', 'instructions', 'notes'],
};

const SCAN_PROMPT = `You are reading a photograph of a recipe — it may be a cookbook page, a handwritten
index card, a screenshot, or a printout. Transcribe it into structured data.

Rules that matter:
- Split every ingredient into quantity, unit, and name as SEPARATE fields. "1 1/2 cups all-purpose flour"
  becomes qtyRaw "1 1/2", unit "cups", name "all-purpose flour".
- Preserve fractions exactly as written. Never convert 1/3 to 0.33 and never round.
- If a quantity is genuinely ambiguous (1/3 vs 1/2 is the classic case) still give your best reading,
  but set uncertain to true for that ingredient.
- Keep preparation notes with the name: "butter, melted", "onion, finely chopped".
- Transcribe instructions as separate steps. Merge run-on text into sensible individual steps.
- Do not invent ingredients or steps that are not visible. If part of the image is cut off or
  illegible, say so in notes.
- If the image is not a recipe at all, set title to "Not a recipe" and leave the arrays empty.`;

async function scanRecipe(env, imageBase64, mediaType) {
  if (!env.ANTHROPIC_API_KEY) {
    return { error: 'Recipe scanning is not configured — the ANTHROPIC_API_KEY secret is missing.' };
  }
  const model = env.SCAN_MODEL || 'claude-sonnet-4-5';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      tools: [{ name: 'save_recipe', description: 'Record the transcribed recipe.', input_schema: SCAN_SCHEMA }],
      tool_choice: { type: 'tool', name: 'save_recipe' },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: SCAN_PROMPT },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return { error: `Vision API error (${res.status}): ${detail.slice(0, 300)}` };
  }
  const data = await res.json();
  const block = (data.content || []).find(c => c.type === 'tool_use');
  if (!block) return { error: 'The model did not return a structured recipe. Try a clearer photo.' };

  const out = block.input;
  const flagged = [];
  const ingredients = (out.ingredients || []).map((i, idx) => {
    if (i.uncertain) flagged.push(idx);
    const qtyRaw = String(i.qtyRaw ?? '').trim();
    return {
      id: uid(), qtyRaw, qty: parseQty(qtyRaw),
      unit: String(i.unit ?? '').trim(), name: titleCase(i.name || ''),
    };
  });

  return {
    recipe: {
      title: String(out.title || 'Untitled Recipe').trim(),
      emoji: out.emoji || '🍽️',
      baseServings: Number(out.baseServings) || 4,
      categories: (out.categories || []).map(titleCase),
      tags: (out.tags || []).map(titleCase),
      ingredients,
      instructions: (out.instructions || []).map(s => String(s).trim()).filter(Boolean),
    },
    flagged,
    notes: out.notes || '',
  };
}

/* ---------- interim password gate ----------
 * Only active when the SITE_PASSWORD secret is set AND the request did not come
 * through Cloudflare Access. Once Access protects the hostname it takes over and
 * this becomes a no-op, so you can safely leave the secret in place.
 */

async function signToken(password) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('the-pantries-v1'));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time compare so a wrong guess can't be narrowed down by timing. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const LOGIN_PAGE = (msg) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>The Pantries</title>
<meta name="theme-color" content="#181209">
<style>
@font-face{font-family:'Bevan';src:url('/fonts/bevan-400.woff2') format('woff2');font-weight:400;font-display:swap}
@font-face{font-family:'Petrona';src:url('/fonts/petrona-400.woff2') format('woff2');font-weight:400;font-display:swap}
@font-face{font-family:'PlexMono';src:url('/fonts/mono-400.woff2') format('woff2');font-weight:400;font-display:swap}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
 background:#181209;color:#F0E4CC;font-family:Petrona,Georgia,serif;
 background-image:radial-gradient(900px 420px at 74% -10%,rgba(217,164,65,.14),transparent 64%),
   radial-gradient(680px 380px at 8% 4%,rgba(180,85,47,.10),transparent 62%),
   radial-gradient(circle at 1px 1px,rgba(240,228,204,.028) 1px,transparent 0);
 background-size:auto,auto,5px 5px}
form{background:#221A11;border:1px solid #3A2D1E;border-top:3px solid #D9A441;border-radius:3px;
 padding:34px 30px;width:350px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.6)}
h1{font-family:Bevan;font-size:23px;margin:0 0 6px;color:#E4D5B8;letter-spacing:-.01em}
h1 span{color:#D9A441}
p{color:#A08D71;font-family:PlexMono,monospace;font-size:10.5px;letter-spacing:.2em;
 text-transform:uppercase;margin:0 0 20px}
.orn{color:#B4552F;letter-spacing:.6em;margin:0 0 18px;font-size:15px}
input{width:100%;padding:12px 14px;border:1px solid #3A2D1E;background:#181209;color:#F0E4CC;
 border-radius:3px;font-size:16px;font-family:Petrona,Georgia,serif;margin-bottom:12px}
input:focus{outline:none;border-color:#D9A441;box-shadow:0 0 0 3px rgba(217,164,65,.14)}
button{width:100%;padding:12px;border:none;border-radius:3px;background:#D9A441;color:#221A11;
 font-family:Bevan;font-size:13px;letter-spacing:.06em;cursor:pointer}
button:hover{filter:brightness(1.08)}
.e{color:#C96A3F;font-family:PlexMono,monospace;font-size:11px;letter-spacing:.1em;margin-bottom:12px}
</style></head>
<body><form method="POST" action="/__login">
<h1>The <span>Pantries</span></h1>
<div class="orn">❧ ❧ ❧</div>
<p>Enter the site password to continue</p>
${msg ? `<div class="e">${msg}</div>` : ''}
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
<button type="submit">Unlock</button></form></body></html>`;

async function gate(request, env, url) {
  if (!env.SITE_PASSWORD) return null;                                  // gate disabled
  if (url.pathname.startsWith('/fonts/')) return null;                  // let the login page load its type
  if (request.headers.get('Cf-Access-Authenticated-User-Email')) return null;  // Access handles it

  const expected = await signToken(env.SITE_PASSWORD);

  if (url.pathname === '/__login' && request.method === 'POST') {
    const form = await request.formData();
    if (String(form.get('password') || '') === env.SITE_PASSWORD) {
      return new Response(null, {
        status: 302,
        headers: {
          location: '/',
          'set-cookie': `pantry_auth=${expected}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
        },
      });
    }
    return new Response(LOGIN_PAGE('That password is not right.'), {
      status: 401, headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)pantry_auth=([a-f0-9]+)/);
  if (m && safeEqual(m[1], expected)) return null;                      // already unlocked

  if (url.pathname.startsWith('/api/')) return err('Not authorized', 401);
  return new Response(LOGIN_PAGE(''), {
    status: 401, headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/* ---------- router ---------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const db = env.DB;

    try {
      const blocked = await gate(request, env, url);
      if (blocked) return blocked;

      /* --- images out of R2 (public within the Access-protected hostname) --- */
      if (path.startsWith('/photos/')) {
        const key = decodeURIComponent(path.slice('/photos/'.length));
        const obj = await env.PHOTOS.get(key);
        if (!obj) return new Response('Not found', { status: 404 });
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set('etag', obj.httpEtag);
        headers.set('cache-control', 'public, max-age=31536000, immutable');
        return new Response(obj.body, { headers });
      }

      // Scanned cookbook files download rather than render inline.
      if (path.startsWith('/files/')) {
        const key = decodeURIComponent(path.slice('/files/'.length));
        const obj = await env.PHOTOS.get(key);
        if (!obj) return new Response('Not found', { status: 404 });
        const row = await db.prepare('SELECT filename FROM cookbook_files WHERE r2_key=?')
          .bind(key).first();
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set('etag', obj.httpEtag);
        headers.set('cache-control', 'private, max-age=3600');
        headers.set('content-disposition',
          `attachment; filename="${(row && row.filename ? row.filename : 'download').replace(/"/g, '')}"`);
        return new Response(obj.body, { headers });
      }

      if (!path.startsWith('/api/')) {
        const res = await env.ASSETS.fetch(request);
        // Real sub-pages (/recipe/edit, /shopping-list, ...) are the app's own
        // routes, not files on disk. Anything without a file extension that the
        // asset server doesn't know gets the app shell, which then routes itself.
        if (res.status === 404 && !/\.[a-z0-9]+$/i.test(path)) {
          return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
        }
        return res;
      }

      /* --- identity (populated by Cloudflare Access) --- */
      if (path === '/api/whoami') {
        return json({
          email: request.headers.get('Cf-Access-Authenticated-User-Email') || null,
          scanEnabled: !!env.ANTHROPIC_API_KEY,
          protectedBy: request.headers.get('Cf-Access-Authenticated-User-Email')
            ? 'access' : (env.SITE_PASSWORD ? 'password' : 'none'),
        });
      }

      if (path === '/api/bootstrap' && method === 'GET') {
        return json(await bootstrap(db));
      }

      if (path === '/api/export' && method === 'GET') {
        const data = await bootstrap(db);
        return new Response(JSON.stringify({
          exportedAt: new Date().toISOString(), version: 1, ...data,
        }, null, 2), {
          headers: {
            'content-type': 'application/json',
            'content-disposition': `attachment; filename="the-pantries-${new Date().toISOString().slice(0,10)}.json"`,
          },
        });
      }

      /* --- recipes --- */
      if (path === '/api/recipes' && method === 'POST') {
        const id = await saveRecipe(db, await request.json(), null);
        return json({ id, ...(await bootstrap(db)) }, 201);
      }

      const recipeMatch = path.match(/^\/api\/recipes\/([^/]+)(\/.*)?$/);
      if (recipeMatch) {
        const id = recipeMatch[1];
        const sub = recipeMatch[2] || '';

        if (!sub && method === 'PUT') {
          const exists = await db.prepare('SELECT id FROM recipes WHERE id=?').bind(id).first();
          if (!exists) return err('Recipe not found', 404);
          await saveRecipe(db, await request.json(), id);
          return json(await bootstrap(db));
        }

        if (!sub && method === 'DELETE') {
          const keys = await db.prepare('SELECT r2_key FROM photos WHERE recipe_id=?').bind(id).all();
          await db.prepare('DELETE FROM recipes WHERE id=?').bind(id).run();
          ctx.waitUntil(Promise.all(keys.results.map(k => env.PHOTOS.delete(k.r2_key))));
          return json(await bootstrap(db));
        }

        if (sub === '/cook' && method === 'POST') {
          const ts = now();
          const day = localDay(await readJson(request), request, ts);
          await db.batch([
            db.prepare('UPDATE recipes SET times_cooked = times_cooked + 1, updated_at=? WHERE id=?')
              .bind(ts, id),
            logCook(db, id, ts, day, 'button'),
          ]);
          return json(await bootstrap(db));
        }

        if (sub === '/ratings' && method === 'POST') {
          const body = await readJson(request);
          const stars = Math.min(5, Math.max(1, parseInt(body.stars, 10) || 5));
          const ts = now();
          const day = localDay(body, request, ts);
          await db.batch([
            db.prepare(`INSERT INTO ratings (id,recipe_id,stars,comment,date,created_at)
                        VALUES (?,?,?,?,?,?)`)
              .bind(uid(), id, stars, String(body.comment || '').trim(), day, ts),
            db.prepare('UPDATE recipes SET times_cooked = times_cooked + 1, updated_at=? WHERE id=?')
              .bind(ts, id),
            logCook(db, id, ts, day, 'rating'),
          ]);
          return json(await bootstrap(db), 201);
        }

        if (sub === '/photos' && method === 'POST') {
          const form = await request.formData();
          const file = form.get('file');
          if (!file || typeof file === 'string') return err('No file uploaded');
          const ext = (file.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '');
          const key = `${id}/${uid()}.${ext}`;
          await env.PHOTOS.put(key, file.stream(), {
            httpMetadata: { contentType: file.type || 'image/jpeg' },
          });
          const existing = await db.prepare('SELECT COUNT(*) AS n FROM photos WHERE recipe_id=?')
            .bind(id).first();
          const isCover = existing && existing.n === 0 ? 1 : 0;
          await db.prepare(
            `INSERT INTO photos (id,recipe_id,r2_key,caption,is_cover,created_at) VALUES (?,?,?,?,?,?)`
          ).bind(uid(), id, key, String(form.get('caption') || ''), isCover, now()).run();
          return json(await bootstrap(db), 201);
        }
      }

      /* --- photos --- */
      const photoMatch = path.match(/^\/api\/photos\/([^/]+)(\/cover|\/focal)?$/);
      if (photoMatch) {
        const pid = photoMatch[1];
        const row = await db.prepare('SELECT * FROM photos WHERE id=?').bind(pid).first();
        if (!row) return err('Photo not found', 404);

        if (photoMatch[2] === '/focal' && method === 'POST') {
          const b = await request.json();
          const x = Math.min(100, Math.max(0, Number(b.x)));
          const y = Math.min(100, Math.max(0, Number(b.y)));
          if (!Number.isFinite(x) || !Number.isFinite(y)) return err('Invalid focal point');
          await db.prepare('UPDATE photos SET focal_x=?, focal_y=? WHERE id=?').bind(x, y, pid).run();
          return json(await bootstrap(db));
        }

        if (photoMatch[2] === '/cover' && method === 'POST') {
          await db.batch([
            db.prepare('UPDATE photos SET is_cover=0 WHERE recipe_id=?').bind(row.recipe_id),
            db.prepare('UPDATE photos SET is_cover=1 WHERE id=?').bind(pid),
          ]);
          return json(await bootstrap(db));
        }

        if (method === 'DELETE') {
          await db.prepare('DELETE FROM photos WHERE id=?').bind(pid).run();
          ctx.waitUntil(env.PHOTOS.delete(row.r2_key));
          if (row.is_cover) {   // promote the next photo so a recipe never loses its cover
            const next = await db.prepare(
              'SELECT id FROM photos WHERE recipe_id=? ORDER BY created_at LIMIT 1'
            ).bind(row.recipe_id).first();
            if (next) await db.prepare('UPDATE photos SET is_cover=1 WHERE id=?').bind(next.id).run();
          }
          return json(await bootstrap(db));
        }
      }

      /* --- cookbooks --- */
      if (path === '/api/cookbooks' && method === 'POST') {
        const b = await request.json();
        const title = String(b.title || '').trim();
        if (!title) return err('A cookbook needs a title.');
        const id = uid(), ts = now();
        await db.prepare(
          `INSERT INTO cookbooks (id,title,author,publisher,published,edition,isbn,notes,emoji,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(id, title, String(b.author || '').trim(), String(b.publisher || '').trim(),
          String(b.published || '').trim(), String(b.edition || '').trim(),
          String(b.isbn || '').trim(), String(b.notes || '').trim(),
          b.emoji || '📕', ts, ts).run();
        return json({ id, ...(await bootstrap(db)) }, 201);
      }

      const bookMatch = path.match(/^\/api\/cookbooks\/([^/]+)(\/.*)?$/);
      if (bookMatch) {
        const bid = bookMatch[1];
        const bsub = bookMatch[2] || '';

        if (!bsub && method === 'PUT') {
          const b = await request.json();
          const title = String(b.title || '').trim();
          if (!title) return err('A cookbook needs a title.');
          await db.prepare(
            `UPDATE cookbooks SET title=?, author=?, publisher=?, published=?, edition=?,
                                  isbn=?, notes=?, emoji=?, updated_at=? WHERE id=?`
          ).bind(title, String(b.author || '').trim(), String(b.publisher || '').trim(),
            String(b.published || '').trim(), String(b.edition || '').trim(),
            String(b.isbn || '').trim(), String(b.notes || '').trim(),
            b.emoji || '📕', now(), bid).run();
          return json(await bootstrap(db));
        }

        if (!bsub && method === 'DELETE') {
          const keys = await db.prepare('SELECT r2_key FROM cookbook_files WHERE cookbook_id=?')
            .bind(bid).all();
          await db.batch([
            // recipes survive; they just stop pointing at a book
            db.prepare("UPDATE recipes SET cookbook_id=NULL, cookbook_page='' WHERE cookbook_id=?").bind(bid),
            db.prepare('DELETE FROM cookbook_files WHERE cookbook_id=?').bind(bid),
            db.prepare('DELETE FROM cookbooks WHERE id=?').bind(bid),
          ]);
          ctx.waitUntil(Promise.all(keys.results.map(k => env.PHOTOS.delete(k.r2_key))));
          return json(await bootstrap(db));
        }

        if (bsub === '/files' && method === 'POST') {
          const form = await request.formData();
          const file = form.get('file');
          if (!file || typeof file === 'string') return err('No file uploaded');
          const type = file.type || 'application/octet-stream';
          const isPhoto = type.startsWith('image/');
          const name = String(form.get('filename') || file.name || 'file');
          const ext = (name.split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8);
          const key = `cookbooks/${bid}/${uid()}.${ext}`;
          await env.PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: type } });
          const existing = await db.prepare(
            "SELECT COUNT(*) AS n FROM cookbook_files WHERE cookbook_id=? AND kind='photo'"
          ).bind(bid).first();
          const isCover = isPhoto && existing && existing.n === 0 ? 1 : 0;
          await db.prepare(
            `INSERT INTO cookbook_files (id,cookbook_id,r2_key,filename,content_type,size_bytes,kind,is_cover,created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`
          ).bind(uid(), bid, key, name, type, file.size || 0,
            isPhoto ? 'photo' : 'file', isCover, now()).run();
          return json(await bootstrap(db), 201);
        }
      }

      const bfMatch = path.match(/^\/api\/cookbook-files\/([^/]+)(\/cover|\/focal)?$/);
      if (bfMatch) {
        const fid = bfMatch[1];
        const row = await db.prepare('SELECT * FROM cookbook_files WHERE id=?').bind(fid).first();
        if (!row) return err('File not found', 404);

        if (bfMatch[2] === '/focal' && method === 'POST') {
          const b = await request.json();
          const x = Math.min(100, Math.max(0, Number(b.x)));
          const y = Math.min(100, Math.max(0, Number(b.y)));
          if (!Number.isFinite(x) || !Number.isFinite(y)) return err('Invalid focal point');
          await db.prepare('UPDATE cookbook_files SET focal_x=?, focal_y=? WHERE id=?')
            .bind(x, y, fid).run();
          return json(await bootstrap(db));
        }

        if (bfMatch[2] === '/cover' && method === 'POST') {
          await db.batch([
            db.prepare("UPDATE cookbook_files SET is_cover=0 WHERE cookbook_id=? AND kind='photo'")
              .bind(row.cookbook_id),
            db.prepare('UPDATE cookbook_files SET is_cover=1 WHERE id=?').bind(fid),
          ]);
          return json(await bootstrap(db));
        }

        if (method === 'DELETE') {
          await db.prepare('DELETE FROM cookbook_files WHERE id=?').bind(fid).run();
          ctx.waitUntil(env.PHOTOS.delete(row.r2_key));
          if (row.is_cover) {
            const next = await db.prepare(
              "SELECT id FROM cookbook_files WHERE cookbook_id=? AND kind='photo' ORDER BY created_at LIMIT 1"
            ).bind(row.cookbook_id).first();
            if (next) await db.prepare('UPDATE cookbook_files SET is_cover=1 WHERE id=?')
              .bind(next.id).run();
          }
          return json(await bootstrap(db));
        }
      }

      /* --- substitutions --- */
      if (path === '/api/substitutions' && method === 'POST') {
        const b = await request.json();
        const ingredient = titleCase(b.ingredient);
        const substitute = String(b.substitute || '').trim();
        if (!ingredient || !substitute) return err('Ingredient and substitute are both required.');
        await db.prepare(
          `INSERT INTO substitutions (id,recipe_id,ingredient,substitute,notes,created_at)
           VALUES (?,?,?,?,?,?)`
        ).bind(uid(), b.recipeId || null, ingredient, substitute,
          String(b.notes || '').trim(), now()).run();
        return json(await bootstrap(db), 201);
      }

      const subMatch = path.match(/^\/api\/substitutions\/([^/]+)$/);
      if (subMatch) {
        const sid = subMatch[1];
        if (method === 'PUT') {
          const b = await request.json();
          await db.prepare(
            'UPDATE substitutions SET ingredient=?, substitute=?, notes=? WHERE id=?'
          ).bind(titleCase(b.ingredient), String(b.substitute || '').trim(),
            String(b.notes || '').trim(), sid).run();
          return json(await bootstrap(db));
        }
        if (method === 'DELETE') {
          await db.prepare('DELETE FROM substitutions WHERE id=?').bind(sid).run();
          return json(await bootstrap(db));
        }
      }

      /* --- shopping list --- */
      if (path === '/api/shopping' && method === 'POST') {
        const b = await request.json();
        const items = Array.isArray(b.items) ? b.items : [b];
        const existing = await db.prepare('SELECT id,name,qty FROM shopping_items').all();
        const stmts = [];
        for (const raw of items) {
          const name = titleCase(raw.name);
          if (!name) continue;
          const qty = parseQty(raw.qty) || 1;
          const match = existing.results.find(e => e.name.toLowerCase() === name.toLowerCase());
          if (match) {
            stmts.push(db.prepare('UPDATE shopping_items SET qty=? WHERE id=?')
              .bind(match.qty + qty, match.id));
          } else {
            stmts.push(db.prepare(
              `INSERT INTO shopping_items (id,name,qty,unit,checked,from_recipe,created_at)
               VALUES (?,?,?,?,0,?,?)`
            ).bind(uid(), name, qty, String(raw.unit || ''), String(raw.fromRecipe || 'manual'), now()));
            existing.results.push({ id: 'pending', name, qty });
          }
        }
        if (stmts.length) await db.batch(stmts);
        return json(await bootstrap(db), 201);
      }

      if (path === '/api/shopping/clear-checked' && method === 'POST') {
        await db.prepare('DELETE FROM shopping_items WHERE checked=1').run();
        return json(await bootstrap(db));
      }

      const shopMatch = path.match(/^\/api\/shopping\/([^/]+)$/);
      if (shopMatch) {
        const sid = shopMatch[1];
        if (method === 'PATCH') {
          const b = await request.json();
          const sets = [], vals = [];
          if (b.checked !== undefined) { sets.push('checked=?'); vals.push(b.checked ? 1 : 0); }
          if (b.name !== undefined) {
            const cur = await db.prepare('SELECT name, orig_name FROM shopping_items WHERE id=?')
              .bind(sid).first();
            sets.push('name=?'); vals.push(titleCase(b.name));
            if (cur && !cur.orig_name) { sets.push('orig_name=?'); vals.push(cur.name); }
          }
          if (b.qty !== undefined) {
            // 0 would mean "buy none of it", which is what deleting the row is for
            sets.push('qty=?'); vals.push(Math.max(0.01, parseQty(b.qty) || 1));
          }
          if (b.unit !== undefined) { sets.push('unit=?'); vals.push(String(b.unit || '').trim()); }
          if (!sets.length) return err('Nothing to update');
          vals.push(sid);
          await db.prepare(`UPDATE shopping_items SET ${sets.join(', ')} WHERE id=?`).bind(...vals).run();
          return json(await bootstrap(db));
        }
        if (method === 'DELETE') {
          await db.prepare('DELETE FROM shopping_items WHERE id=?').bind(sid).run();
          return json(await bootstrap(db));
        }
      }

      /* --- AI scan --- */
      if (path === '/api/scan' && method === 'POST') {
        const b = await request.json();
        let data = String(b.image || '');
        let mediaType = b.mediaType || 'image/jpeg';
        const m = data.match(/^data:([^;]+);base64,(.*)$/);
        if (m) { mediaType = m[1]; data = m[2]; }
        if (!data) return err('No image provided');
        if (data.length > 7_000_000) return err('Image too large — please use a smaller photo.', 413);
        const result = await scanRecipe(env, data, mediaType);
        return result.error ? err(result.error, 502) : json(result);
      }

      return err('Not found', 404);
    } catch (e) {
      console.error('Unhandled error:', e && e.stack ? e.stack : e);
      return err(`Server error: ${e && e.message ? e.message : String(e)}`, 500);
    }
  },
};
