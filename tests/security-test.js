/* Update 20 — hardening.
 *
 * Four things get checked here, and each one is checked the way an attacker
 * would meet it rather than the way the code is written:
 *
 *   1. the security headers are on EVERY kind of response, including the ones
 *      that never touch the JSON helper — assets, R2 misses, 404s, redirects
 *   2. an upload that is not a photo or a PDF, or is too big, does not land
 *   3. hostile text — typed in, or imported from a page that publishes it in
 *      its JSON-LD — renders as characters rather than as markup
 *   4. the password gate refuses to be guessed at indefinitely
 *
 * Part 4 needs a Worker that actually has SITE_PASSWORD set, which the shared
 * test server does not, so it starts its own on port 8799 and tears it down.
 */
const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');

const B = 'http://127.0.0.1:8787';
const GATE_PORT = 8799;
const GATE = `http://127.0.0.1:${GATE_PORT}`;
const GATE_PASSWORD = 'correct horse battery staple';

const j = (p, m, b) => fetch(B + p, { method: m || 'GET',
  headers: { 'content-type': 'application/json' },
  body: b === undefined ? undefined : JSON.stringify(b) })
  .then(async r => ({ status: r.status, body: await r.text().then(t => t ? JSON.parse(t) : null) }));
const get = () => j('/api/bootstrap').then(r => r.body);

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++;
  console.log(`${c ? '  ok  ' : ' FAIL '} ${n}${extra ? ' — ' + extra : ''}`); };

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* a real 1x1 PNG, so the allowed case is allowed for the right reason */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const PDF_TINY = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

async function upload(path, { bytes, type, name, filename }) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  if (filename !== undefined) fd.append('filename', filename);
  const r = await fetch(B + path, { method: 'POST', body: fd });
  return { status: r.status, body: await r.text().then(t => { try { return JSON.parse(t); } catch (e) { return t; } }) };
}

/* ---------- part 4 needs its own server ---------- */

function startGateServer() {
  execSync(`rm -rf .wrangler-sec && npx wrangler d1 execute pantries-db --local ` +
           `--file=./schema.sql --persist-to=.wrangler-sec`, { stdio: 'ignore' });
  const child = spawn('npx', ['wrangler', 'dev', '--port', String(GATE_PORT),
    '--persist-to', '.wrangler-sec', '--var', `SITE_PASSWORD:${GATE_PASSWORD}`],
    { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

async function waitForGate() {
  for (let i = 0; i < 45; i++) {
    try {
      const r = await fetch(GATE + '/api/bootstrap');
      if (r.status === 401) return true;      // gate up and refusing, which is the point
      if (r.status === 200) return 'open';    // running, but the var did not take
    } catch (e) { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

(async () => {
  const s = await get();
  const recipe = s.recipes[0];
  const book = (s.cookbooks || [])[0];

  /* ============ 1. headers ============ */
  console.log('\n— the headers are on every kind of response —');

  const MUST = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
  };

  const surfaces = [
    ['a JSON api response', '/api/bootstrap'],
    ['a 404 from the api', '/api/there-is-no-such-route'],
    ['the app shell', '/'],
    ['a static asset', '/styles.css?v=20'],
    ['an app route with no file behind it', '/browse-recipes'],
    ['a miss on the R2 photo path', '/photos/nothing-here.jpg'],
  ];
  for (const [label, path] of surfaces) {
    const r = await fetch(B + path);
    const missing = Object.entries(MUST).filter(([k, v]) => r.headers.get(k) !== v).map(([k]) => k);
    const csp = r.headers.get('content-security-policy');
    ok(`${label} carries all of them`, missing.length === 0 && !!csp,
      missing.length ? 'missing ' + missing.join(', ') : (csp ? '' : 'no CSP'));
  }

  const csp = (await fetch(B + '/')).headers.get('content-security-policy');
  ok('CSP refuses to be framed', /frame-ancestors 'none'/.test(csp));
  ok('CSP allows no plugins or objects', /object-src 'none'/.test(csp));
  ok('CSP pins fetch and XHR to this origin', /connect-src 'self'/.test(csp), csp);
  ok('CSP pins images to this origin, data and blob', /img-src 'self' data: blob:/.test(csp));
  ok('CSP nails <base> shut', /base-uri 'none'/.test(csp));
  ok('HSTS is set', /max-age=\d+/.test(
    (await fetch(B + '/')).headers.get('strict-transport-security') || ''));

  // the wrapper rebuilds every response, so a status that may not carry a body
  // is the one that would throw if the guard were missing
  const asset = await fetch(B + '/styles.css?v=20');
  const etag = asset.headers.get('etag');
  if (etag) {
    const again = await fetch(B + '/styles.css?v=20', { headers: { 'if-none-match': etag } });
    ok('a conditional request survives the header wrapper',
      again.status === 304 || again.status === 200, 'status ' + again.status);
    ok('and a 304 still carries the headers',
      again.status !== 304 || again.headers.get('x-content-type-options') === 'nosniff');
  } else {
    ok('a conditional request survives the header wrapper', true, 'no etag served, skipped');
    ok('and a 304 still carries the headers', true, 'no etag served, skipped');
  }

  ok('the JSON content-type is not clobbered by the wrapper',
    /application\/json/.test((await fetch(B + '/api/bootstrap')).headers.get('content-type') || ''));
  ok('the stylesheet is still served as CSS',
    /text\/css/.test((await fetch(B + '/styles.css?v=20')).headers.get('content-type') || ''));

  /* ============ 2. uploads ============ */
  console.log('\n— what may be uploaded —');

  const photoPath = `/api/recipes/${recipe.id}/photos`;

  let r = await upload(photoPath, { bytes: Buffer.from('<html>hi</html>'), type: 'text/html', name: 'x.html' });
  ok('an html file is not a photo', r.status === 415, 'status ' + r.status);

  r = await upload(photoPath, { bytes: Buffer.from('note'), type: 'text/plain', name: 'notes.txt' });
  ok('a text file is not a photo', r.status === 415, 'status ' + r.status);

  r = await upload(photoPath, { bytes: Buffer.from('<svg onload=alert(1)>'), type: 'image/svg+xml', name: 'x.svg' });
  ok('an SVG is not a photo either, because it can carry script',
    r.status === 415, 'status ' + r.status);

  r = await upload(photoPath, { bytes: Buffer.alloc(0), type: 'image/png', name: 'empty.png' });
  ok('an empty file is refused', r.status === 400, 'status ' + r.status);

  r = await upload(photoPath, { bytes: Buffer.alloc(12.6 * 1024 * 1024), type: 'image/png', name: 'huge.png' });
  ok('a photo over 12 MB is refused', r.status === 413, 'status ' + r.status);
  ok('and the refusal says how big it was and what the limit is',
    typeof r.body === 'object' && /MB/.test(r.body.error || ''), JSON.stringify(r.body));

  const before = (await get()).recipes.find(x => x.id === recipe.id).images.length;
  r = await upload(photoPath, { bytes: PNG_1X1, type: 'image/png', name: 'ok.png' });
  ok('a real PNG is accepted', r.status === 201, 'status ' + r.status);
  const after = (await get()).recipes.find(x => x.id === recipe.id);
  ok('and it actually landed', after.images.length === before + 1);
  ok('stored under an extension taken from the type, not the filename',
    /\.png$/.test(after.images[after.images.length - 1].url), after.images[after.images.length - 1].url);

  // the type the browser sends is often decorated; that must not fail a good file
  r = await upload(photoPath, { bytes: PNG_1X1, type: 'image/png; charset=binary', name: 'ok2.png' });
  ok('a content-type with parameters still reads as PNG', r.status === 201, 'status ' + r.status);

  if (book) {
    const filePath = `/api/cookbooks/${book.id}/files`;
    r = await upload(filePath, { bytes: PDF_TINY, type: 'application/pdf', name: 'scan.pdf' });
    ok('a cookbook may hold a PDF', r.status === 201, 'status ' + r.status);

    r = await upload(filePath, { bytes: Buffer.from('#!/bin/sh\nrm -rf /'), type: 'application/x-sh', name: 'go.sh' });
    ok('but not a shell script', r.status === 415, 'status ' + r.status);

    r = await upload(filePath, { bytes: Buffer.alloc(26 * 1024 * 1024), type: 'application/pdf', name: 'big.pdf' });
    ok('and not a 26 MB one', r.status === 413, 'status ' + r.status);

    r = await upload(filePath, { bytes: PDF_TINY, type: 'application/pdf', name: 'a.pdf',
      filename: '../../etc/pass"wd.pdf' });
    ok('a filename cannot smuggle a path or a quote', r.status === 201, 'status ' + r.status);
    const bk = (await get()).cookbooks.find(x => x.id === book.id);
    const stored = bk.files[bk.files.length - 1].filename;
    ok('the stored filename has no slashes or quotes left in it',
      !/[\\/"]/.test(stored), JSON.stringify(stored));
  } else {
    ok('a cookbook may hold a PDF', true, 'no cookbook in this seed, skipped');
  }

  /* ============ 3. hostile text renders as text ============ */
  console.log('\n— hostile text is text —');

  const XSS = '<img src=x onerror="window.__xss=1">';
  const made = await j('/api/recipes', 'POST', {
    title: `Pwn ${XSS}`,
    emoji: '<script>window.__xss=2</script>',
    baseServings: 4,
    categories: ['<b>Zesty</b>', 'Dinner'],
    tags: ['<i>tag</i>'],
    notes: `notes ${XSS}`,
    ingredients: [{ qtyRaw: '1', unit: 'cup', name: `Flour ${XSS}` }],
    instructions: [{ text: `Stir ${XSS}`, minutes: 0 }],
  });
  ok('the recipe with markup in it saves', made.status === 201, 'status ' + made.status);
  const hostileId = made.body && made.body.recipes
    ? made.body.recipes.find(x => /^Pwn /.test(x.title)).id : null;

  const saved = (await get()).recipes.find(x => x.id === hostileId);
  ok('an emoji field that is a script tag falls back to the default',
    saved.emoji === '🍽️', JSON.stringify(saved.emoji));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  // Enough cooks to take first place in home's top ten, which is where the
  // category line that had no escaping until this update is rendered. The big
  // seed's busiest recipe has 12, and a tie sorts behind it, so 13 it is.
  for (let i = 0; i < 13; i++) await j(`/api/recipes/${hostileId}/cook`, 'POST', {});

  // the detail route is /recipe?id=… — /recipe/<id> is not a route and falls
  // back to Home, which would quietly test the wrong page
  for (const [label, path] of [
    ['the recipe page', `/recipe?id=${hostileId}`],
    ['the browse list', '/browse-recipes'],
    ['home', '/home'],
  ]) {
    await page.goto(B + path);
    await page.waitForTimeout(900);
    const fired = await page.evaluate(() => window.__xss);
    const injected = await page.evaluate(() => document.querySelectorAll('img[src="x"]').length);
    ok(`${label} does not run it`, fired === undefined, 'window.__xss = ' + JSON.stringify(fired));
    ok(`${label} does not build the tag`, injected === 0, injected + ' injected <img>');
  }

  await page.goto(B + `/recipe?id=${hostileId}`);
  await page.waitForTimeout(900);
  const h1 = await page.textContent('h1');
  ok('the title is on the page it belongs to', /Pwn/.test(h1), h1);
  ok('the markup is visible as characters, which is the whole idea',
    h1.includes('<img src=x'), h1);
  ok('the category shows as text on the recipe page',
    /<b>zesty<\/B>/i.test(await page.innerText('body')));

  /* home's top-ten category line had no escaping until this update */
  await page.goto(B + '/home');
  await page.waitForTimeout(900);
  const cats = await page.$$eval('.cats', els => els.map(e => e.innerText).join(' | '));
  ok('home renders a hostile category as text, not markup',
    /<b>zesty<\/B>/i.test(cats), cats.slice(0, 120));
  ok('and builds no element out of it',
    (await page.$$eval('.cats b', els => els.length)) === 0);

  /* ---- and the same thing arriving from a page we did not write ---- */
  const hostilePage = `<!doctype html><html><head><script type="application/ld+json">${
    JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Recipe',
      name: 'Imported <img src=x onerror="window.__xss=3">',
      recipeIngredient: ['2 cups flour <img src=x onerror="window.__xss=4">'],
      recipeInstructions: ['Mix well <img src=x onerror="window.__xss=5">'],
      recipeCategory: ['<b>Imported</b>'],
      recipeYield: '4 servings',
    })}<\/script></head><body>a recipe</body></html>`;

  const http = require('http');
  const site = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(hostilePage);
  });
  await new Promise(res => site.listen(8899, '127.0.0.1', res));

  const imported = await j('/api/import', 'POST', { url: 'http://127.0.0.1:8899/recipe' });
  ok('a page publishing JSON-LD imports', imported.status === 200, 'status ' + imported.status);
  if (imported.status === 200) {
    const draft = imported.body.recipe;
    ok('the imported title has the tag stripped server-side',
      !/<img/i.test(draft.title), JSON.stringify(draft.title));

    const savedImport = await j('/api/recipes', 'POST', {
      title: draft.title, emoji: '🍽️', baseServings: draft.baseServings,
      categories: draft.categories, tags: draft.tags, notes: '',
      ingredients: draft.ingredients.map(i => ({ qtyRaw: String(i.qty || ''), unit: i.unit || '', name: i.name })),
      instructions: draft.instructions,
    });
    const impId = savedImport.body.recipes.find(x => /^Imported/.test(x.title));
    if (impId) {
      await page.goto(B + `/recipe?id=${impId.id}`);
      await page.waitForTimeout(900);
      const fired = await page.evaluate(() => window.__xss);
      ok('nothing from the imported recipe runs', fired === undefined,
        'window.__xss = ' + JSON.stringify(fired));
    }
  }
  site.close();

  ok('no javascript errors throughout', errs.length === 0, errs.join(' | '));
  await browser.close();

  /* ============ 4. the password gate ============ */
  console.log('\n— guessing the site password —');

  const child = startGateServer();
  const up = await waitForGate();

  if (up === true) {
    let g = await fetch(GATE + '/api/bootstrap');
    ok('the api refuses an unlocked browser', g.status === 401, 'status ' + g.status);
    ok('and refuses it as JSON, not as a login page',
      /json/.test(g.headers.get('content-type') || ''), g.headers.get('content-type'));

    g = await fetch(GATE + '/home');
    ok('a page request gets the login form', g.status === 401 && /Enter the site password/.test(await g.text()));

    ok('the login page carries the security headers too',
      (await fetch(GATE + '/home')).headers.get('x-frame-options') === 'DENY');

    const login = (pw) => {
      const body = new URLSearchParams({ password: pw });
      return fetch(GATE + '/__login', { method: 'POST', body, redirect: 'manual' });
    };

    g = await login(GATE_PASSWORD);
    ok('the right password is accepted', g.status === 302, 'status ' + g.status);
    const cookie = g.headers.get('set-cookie') || '';
    ok('the cookie is HttpOnly', /HttpOnly/i.test(cookie), cookie);
    ok('the cookie is Secure', /Secure/i.test(cookie));
    ok('the cookie is SameSite=Lax', /SameSite=Lax/i.test(cookie));
    ok('the cookie lasts 30 days rather than a year',
      /Max-Age=2592000\b/.test(cookie), (cookie.match(/Max-Age=\d+/) || [''])[0]);

    const token = (cookie.match(/pantry_auth=([a-f0-9]+)/) || [])[1];
    g = await fetch(GATE + '/api/bootstrap', { headers: { cookie: `pantry_auth=${token}` } });
    ok('the cookie unlocks the api', g.status === 200, 'status ' + g.status);

    g = await fetch(GATE + '/api/bootstrap', { headers: { cookie: 'pantry_auth=' + 'f'.repeat(64) } });
    ok('a made-up cookie does not', g.status === 401, 'status ' + g.status);

    let lockedAt = 0;
    for (let i = 1; i <= 10; i++) {
      const res = await login('not the password ' + i);
      if (res.status === 429) { lockedAt = i; break; }
    }
    ok('guessing gets locked out', lockedAt > 0, lockedAt ? `at attempt ${lockedAt}` : 'never locked');
    ok('and not before a genuine typo or two', lockedAt === 0 || lockedAt >= 5, 'locked at ' + lockedAt);

    g = await login('wrong again');
    ok('the lockout answers 429', g.status === 429, 'status ' + g.status);
    ok('and says when to come back', !!g.headers.get('retry-after'), g.headers.get('retry-after'));

    g = await login(GATE_PASSWORD);
    ok('even the right password waits out the lockout', g.status === 429, 'status ' + g.status);
  } else if (up === 'open') {
    ok('the gate server came up with SITE_PASSWORD set', false,
      'server answered 200 — the --var did not take, gate tests skipped');
  } else {
    ok('the gate server came up', false, 'never became ready, gate tests skipped');
  }

  try { process.kill(-child.pid); } catch (e) { /* already gone */ }
  try { execSync('rm -rf .wrangler-sec', { stdio: 'ignore' }); } catch (e) { /* fine */ }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
