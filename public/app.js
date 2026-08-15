/* ============ STORE (loaded from the server) ============ */
const uid = () => Math.random().toString(36).slice(2,9);

let recipes = [];
let cookbooks = [];
let globalSubs = [];
let allCategories = [];
let shoppingList = [];
let scanEnabled = false;
let userEmail = null;

/* ============ API LAYER ============ */
let busyDepth = 0;
function setBusy(on){
  busyDepth = Math.max(0, busyDepth + (on ? 1 : -1));
  const el = document.getElementById('busy');
  if (el) el.className = busyDepth > 0 ? 'busy show' : 'busy';
}
async function api(path, opts = {}, quiet = false){
  if (!quiet) setBusy(true);
  try {
    const res = await fetch(path, opts);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : null;
    if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    return data;
  } finally { if (!quiet) setBusy(false); }
}
/** Most write endpoints return the whole refreshed state, so applying it keeps
 *  every view consistent without hand-patching local arrays. */
function applyState(st){
  if (!st) return;
  if (st.recipes) recipes = st.recipes;
  if (st.cookbooks) cookbooks = st.cookbooks;
  if (st.globalSubs) globalSubs = st.globalSubs;
  if (st.allCategories) allCategories = st.allCategories;
  if (st.shoppingList) shoppingList = st.shoppingList;
}
async function apiJSON(path, method, body){
  const st = await api(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  applyState(st);
  return st;
}
function apiError(e){
  console.error(e);
  showModal({
    title: 'Something went wrong',
    body: '<p>' + esc(e && e.message ? e.message : String(e)) + '</p>' +
          '<p class="subtle" style="margin-top:10px;">Your saved data was not changed. ' +
          'Check your connection and try again.</p>',
    buttons: [{ label: 'OK', style: 'primary' }],
  });
}
/* Shrink before upload: phone photos are often 5-10MB, which is slow and wasteful. */
function fileToDownscaledDataUrl(file, max = 1400){
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = e => downscale(e.target.result, resolve, max);
    fr.onerror = () => reject(new Error('Could not read that file.'));
    fr.readAsDataURL(file);
  });
}
async function uploadPhotoDataUrl(recipeId, dataUrl, caption){
  const blob = await (await fetch(dataUrl)).blob();
  const fd = new FormData();
  fd.append('file', blob, 'photo.jpg');
  fd.append('caption', caption || '');
  const st = await api('/api/recipes/' + recipeId + '/photos', { method: 'POST', body: fd });
  applyState(st);
}
function downloadBackup(){ window.location.href = '/api/export'; }


/* ============ STATE ============ */
let state = {
  view:'home', currentRecipeId:null, currentBookId:null, editingBook:null,
  bookSearch:'', bookRecipeSearch:'', detailTab:'ingredients', discoverIds:[],
  searchQuery:'', categoryFilter:'all', sortBy:'newest',
  subSearch:'', scale:{}, editing:null, starDraft:0,
  appliedSubs:{},        // recipeId -> { ingredientId: {ingredientName, substitute, notes} }
  expandedShopSubs:{},   // shoppingItemId -> bool
  showRecipeSubForm:false,
};
let focusId=null, focusPos=null;

/* ============ TEXT + QUANTITY NORMALIZATION ============ */
const SMALL_WORDS = new Set(['a','an','and','as','at','but','by','for','in','of','on','or','the','to','with','from','into','per','over']);
function titleCase(str){
  if(str==null) return str;
  const s=String(str).trim().replace(/\s+/g,' ').toLowerCase();
  if(!s) return '';
  return s.split(' ').map((word,wi)=>
    word.split(/([-/&])/).map((part,pi)=>{
      if(!part || /^[-/&]$/.test(part)) return part;
      if(wi>0 && pi===0 && SMALL_WORDS.has(part)) return part;
      return part.charAt(0).toUpperCase()+part.slice(1);
    }).join('')
  ).join(' ');
}
const UNICODE_FRAC={'½':0.5,'⅓':1/3,'⅔':2/3,'¼':0.25,'¾':0.75,'⅕':0.2,'⅖':0.4,'⅗':0.6,'⅘':0.8,'⅙':1/6,'⅚':5/6,'⅛':0.125,'⅜':0.375,'⅝':0.625,'⅞':0.875};
/* Handles "1/2", "1 1/2", "½", "1½", "1.5", "2" — never silently truncates a fraction */
function parseQty(str){
  if(typeof str==='number') return isNaN(str)?0:str;
  let s=String(str==null?'':str).trim();
  if(!s) return 0;
  let total=0, matched=false;
  for(const ch in UNICODE_FRAC){
    while(s.includes(ch)){ total+=UNICODE_FRAC[ch]; s=s.replace(ch,' '); matched=true; }
  }
  s.trim().split(/\s+/).filter(Boolean).forEach(p=>{
    const fr=p.match(/^(\d+)\/(\d+)$/);
    if(fr){ const d=+fr[2]; if(d){ total+=(+fr[1])/d; matched=true; } return; }
    const f=parseFloat(p);
    if(!isNaN(f)){ total+=f; matched=true; }
  });
  return matched?total:0;
}
/* ============ PHOTOS ============ */
function coverImage(r){
  if(!r.images||!r.images.length) return null;
  return r.images.find(i=>i.favorite) || r.images[0];
}
/* Shrinks big phone photos before storing so the page stays fast */
function downscale(dataUrl, cb, max=1400){
  const img=new Image();
  img.onload=()=>{
    let w=img.width, h=img.height;
    if(w>max||h>max){ const s=Math.min(max/w,max/h); w=Math.round(w*s); h=Math.round(h*s); }
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    const ctx=c.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,w,h);
    ctx.drawImage(img,0,0,w,h);
    try{ cb(c.toDataURL('image/jpeg',0.85)); }catch(e){ cb(dataUrl); }
  };
  img.onerror=()=>cb(dataUrl);
  img.src=dataUrl;
}
async function handlePhotoUpload(ev,recipeId){
  const files=[...ev.target.files].filter(f=>f.type.startsWith('image/'));
  ev.target.value='';
  if(!files.length) return;
  setBusy(true);
  try{
    for(const f of files){
      const url=await fileToDownscaledDataUrl(f);
      await uploadPhotoDataUrl(recipeId,url,f.name.replace(/\.[^.]+$/,''));
    }
    render(); toast(`${files.length} photo${files.length!==1?'s':''} added.`);
  }catch(e){ apiError(e); }
  finally{ setBusy(false); }
}
async function setCoverImage(recipeId,imgId){
  try{
    await apiJSON('/api/photos/'+imgId+'/cover','POST');
    render(); toast('Cover photo updated — now shows on the search page.');
  }catch(e){ apiError(e); }
}
function confirmDeletePhoto(recipeId,imgId){
  const r=recipes.find(x=>x.id===recipeId);
  const img=r.images.find(i=>i.id===imgId);
  showModal({
    title:'Delete this photo?',
    body:`This photo will be removed from <b>${esc(r.title)}</b>.${img.favorite?' It\'s currently the cover photo — the next photo will take its place.':''}`,
    buttons:[
      {label:'Cancel'},
      {label:'Delete photo', style:'danger', action:async()=>{
        try{
          await apiJSON('/api/photos/'+imgId,'DELETE');
          render(); toast('Photo deleted.');
        }catch(e){ apiError(e); }
      }}
    ]
  });
}
/* ============ HELPERS ============ */
function avgRating(r){ return r.ratings.length ? r.ratings.reduce((a,b)=>a+b.stars,0)/r.ratings.length : 0; }
function starString(n){ const f=Math.round(n); return '★★★★★☆☆☆☆☆'.slice(5-f,10-f); }
function fmtQty(q){
  const m={0.125:'⅛',0.1667:'⅙',0.2:'⅕',0.25:'¼',0.333:'⅓',0.375:'⅜',0.4:'⅖',
           0.5:'½',0.6:'⅗',0.625:'⅝',0.667:'⅔',0.75:'¾',0.8:'⅘',0.833:'⅚',0.875:'⅞'};
  const w=Math.floor(q+1e-6), fr=q-w; let fs='';
  for(const k in m){ if(Math.abs(fr-parseFloat(k))<0.02){ fs=m[k]; break; } }
  if(!fs && fr>0.02) fs=(Math.round(fr*100)/100).toString();
  if(w===0&&fs) return fs;
  if(w>0&&fs) return w+' '+fs;
  if(w===0&&!fs) return '0';
  return w.toString();
}
function normIng(name){ return (name||'').toLowerCase().split(',')[0].replace(/\s+/g,' ').trim(); }
function subMatches(subIngName, ingName){
  const a=normIng(subIngName), b=normIng(ingName);
  if(!a||!b) return false;
  if(a===b) return true;
  if(b.includes(a) || a.includes(b)) return true;
  if(b===a+'s' || a===b+'s') return true;
  return false;
}
/* Auto-matching engine: runs against every recipe, no manual linking needed */
function subsForRecipe(r){
  const pool = [...globalSubs.map(s=>({...s,scope:'library'})), ...((r.localSubs||[]).map(s=>({...s,scope:'recipe'})))];
  const out=[], seen=new Set();
  pool.forEach(s=>{ r.ingredients.forEach(i=>{
    if(subMatches(s.ingredient,i.name)){
      const key=s.id+'|'+i.id;
      if(!seen.has(key)){ seen.add(key); out.push({sub:s, ing:i}); }
    }
  });});
  return out;
}
function subsForName(name){
  return globalSubs.filter(s=>subMatches(s.ingredient,name));
}
function relevanceScore(r,q){
  if(!q) return 0; q=q.toLowerCase(); let s=0;
  if(r.title.toLowerCase().includes(q)) s+=10;
  if(r.title.toLowerCase().startsWith(q)) s+=5;
  r.tags.forEach(t=>{ if(t.toLowerCase().includes(q)) s+=4; });
  r.ingredients.forEach(i=>{ if(i.name.toLowerCase().includes(q)) s+=2; });
  r.categories.forEach(c=>{ if(c.toLowerCase().includes(q)) s+=3; });
  return s;
}
function filteredSorted(){
  let list = recipes.filter(r=>{
    const catOk = state.categoryFilter==='all' || r.categories.includes(state.categoryFilter);
    const q = state.searchQuery.trim().toLowerCase();
    return catOk && (!q || relevanceScore(r,q)>0);
  });
  let sortBy = state.sortBy;
  if(!state.searchQuery.trim() && sortBy==='relevant') sortBy='newest';
  const cmp = {
    newest:(a,b)=>new Date(b.dateAdded)-new Date(a.dateAdded),
    oldest:(a,b)=>new Date(a.dateAdded)-new Date(b.dateAdded),
    relevant:(a,b)=>relevanceScore(b,state.searchQuery.toLowerCase())-relevanceScore(a,state.searchQuery.toLowerCase()),
    mostUsed:(a,b)=>b.timesCooked-a.timesCooked,
    topRated:(a,b)=>avgRating(b)-avgRating(a),
  }[sortBy];
  return list.sort(cmp);
}
function storeLink(store,item){
  const q=encodeURIComponent(item);
  return {amazon:`https://www.amazon.com/s?k=${q}`,target:`https://www.target.com/s?searchTerm=${q}`,walmart:`https://www.walmart.com/search?q=${q}`}[store];
}
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escA(s){ return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

/* ============ MODAL + TOAST ============ */
let modalCfg=null;
function showModal(cfg){ modalCfg=cfg; renderModal(); }
function closeModal(){ modalCfg=null; renderModal(); }
function modalBtn(i){ const b=modalCfg.buttons[i]; closeModal(); if(b.action) b.action(); }
function renderModal(){
  const root=document.getElementById('modalRoot');
  if(!modalCfg){ root.className=''; root.innerHTML=''; return; }
  root.className='show';
  root.innerHTML=`<div class="modal">
    <h3>${modalCfg.title}</h3>
    <div class="mbody">${modalCfg.body}</div>
    <div class="mbtns">${modalCfg.buttons.map((b,i)=>`<button class="icon-btn ${b.style||''}" onclick="modalBtn(${i})">${b.label}</button>`).join('')}</div>
  </div>`;
}
let toastTimer=null;
function toast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.className='toast show';
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>{ t.className='toast'; },2200);
}

/* ============ NAV (with unsaved-substitution guard) ============ */
function appliedCount(recipeId){ return Object.keys(state.appliedSubs[recipeId]||{}).length; }
function attemptNav(fn){
  const rid = state.currentRecipeId;
  if(state.view==='detail' && rid && appliedCount(rid)>0){
    const n=appliedCount(rid);
    showModal({
      title:'Revert temporary substitutions?',
      body:`You have <b>${n} temporary substitution${n!==1?'s':''}</b> applied to this recipe's ingredient list. These were never saved to the recipe — leaving this page will revert the ingredients back to the original.`,
      buttons:[
        {label:'Stay on page'},
        {label:'Leave & revert', style:'primary', action:()=>{ delete state.appliedSubs[rid]; fn(); }}
      ]
    });
  } else fn();
}
function goto(view){ attemptNav(()=>{ state.view=view; state.detailTab='ingredients'; state.showRecipeSubForm=false; render(); }); }
function openRecipe(id){
  state.view='detail'; state.currentRecipeId=id; state.detailTab='ingredients';
  state.showRecipeSubForm=false; state.starDraft=0;
  if(!state.scale[id]) state.scale[id]=1;
  render();
}

/* ============ RENDER SHELL ============ */
function render(){
  document.getElementById('app').innerHTML=`
    <div class="topbar no-print">
      <div class="brand" style="cursor:pointer;" onclick="goto('home')">🍲 The <span>Pantries</span></div>
      <button class="navbtn ${state.view==='home'?'active':''}" onclick="goto('home')">
        <span class="ic">🏠</span> Home</button>
      <button class="navbtn ${['browse','detail','editRecipe'].includes(state.view)?'active':''}" onclick="goto('browse')">
        <span class="ic">📖</span> Browse Recipes<span class="count">${recipes.length}</span></button>
      <button class="navbtn ${['cookbooks','cookbookDetail','editCookbook'].includes(state.view)?'active':''}" onclick="goto('cookbooks')">
        <span class="ic">📚</span> Cookbooks${cookbooks.length?`<span class="count">${cookbooks.length}</span>`:''}</button>
      <button class="navbtn ${state.view==='substitutions'?'active':''}" onclick="goto('substitutions')">
        <span class="ic">🔁</span> Substitutions<span class="count">${globalSubs.length}</span></button>
      <button class="navbtn ${state.view==='shopping'?'active':''}" onclick="goto('shopping')">
        <span class="ic">🛒</span> Shopping List${shoppingList.length?`<span class="count">${shoppingList.filter(i=>!i.checked).length}</span>`:''}</button>
      <button class="addbtn" onclick="startAddRecipe()">+ Add Recipe</button>
      <button class="navbtn" title="Download a backup of everything" onclick="downloadBackup()">
        <span class="ic">⬇</span></button>
    </div>
    <div class="main" id="main"></div>
    <div class="app-foot no-print">
      ${userEmail?`Signed in as ${esc(userEmail)} · `:''}The Pantries ·
      <a href="#" onclick="event.preventDefault();downloadBackup();" style="color:var(--accent-dark);">Download backup</a>
    </div>`;
  renderMain();
}
function renderMain(){
  const m=document.getElementById('main');
  m.innerHTML = ({home:viewHome,browse:viewBrowse,detail:viewDetail,substitutions:viewSubstitutions,
    shopping:viewShopping,editRecipe:viewEditRecipe,scanning:viewScanning,
    cookbooks:viewCookbooks,cookbookDetail:viewCookbookDetail,editCookbook:viewEditCookbook}[state.view])();
  if(focusId){ const el=document.getElementById(focusId); if(el){ el.focus(); try{el.setSelectionRange(focusPos,focusPos);}catch(e){} } }
}

/* ============ HOME ============ */
function mostCooked(n=3){
  return recipes.slice().sort((a,b)=>b.timesCooked-a.timesCooked || avgRating(b)-avgRating(a)).slice(0,n);
}
function topRanked(n=10){
  return recipes.slice().sort((a,b)=>
    (avgRating(b)-avgRating(a)) || (b.timesCooked-a.timesCooked) || a.title.localeCompare(b.title)
  ).slice(0,n);
}
/* Discovery: favors recipes you cook least / haven't rated, so they don't stay buried */
function shuffleDiscover(){
  const skip=new Set(mostCooked().map(r=>r.id));
  let pool=recipes.filter(r=>!skip.has(r.id));
  if(pool.length<3){
    // Small library: nothing is left over, so fall back to the least-cooked recipes
    // (minus your #1) rather than repeating the Most Cooked row verbatim.
    const excl=new Set(mostCooked(1).map(r=>r.id));
    pool=recipes.filter(r=>!excl.has(r.id)).sort((a,b)=>a.timesCooked-b.timesCooked).slice(0,6);
  }
  const weight=r=>(r.ratings.length?0:2)+(r.timesCooked<=2?1.5:0)+Math.random()*2.5;
  state.discoverIds=pool.map(r=>({r,k:weight(r)})).sort((a,b)=>b.k-a.k).slice(0,3).map(x=>x.r.id);
}
function refreshDiscover(){ shuffleDiscover(); renderMain(); toast('Shuffled — showing different recipes.'); }
function recentActivity(n=6){
  const feed=[];
  recipes.forEach(r=>(r.ratings||[]).forEach(c=>feed.push({r,c})));
  return feed.sort((a,b)=>(b.c.ts||Date.parse(b.c.date)||0)-(a.c.ts||Date.parse(a.c.date)||0)).slice(0,n);
}
function runHomeSearch(){
  const el=document.getElementById('homeSearch');
  const v=el?el.value.trim():'';
  state.searchQuery=v;
  state.sortBy=v?'relevant':'newest';
  state.categoryFilter='all';
  goto('browse');
}
function viewHome(){
  const cooked=mostCooked(3);
  let discover=(state.discoverIds||[]).map(id=>recipes.find(r=>r.id===id)).filter(Boolean);
  if(discover.length<Math.min(3,recipes.length)){ shuffleDiscover(); discover=(state.discoverIds||[]).map(id=>recipes.find(r=>r.id===id)).filter(Boolean); }
  const feed=recentActivity(6);
  const top=topRanked(10);
  return `
    <div class="home-hero">
      <h1>What are you cooking today?</h1>
      <p>${recipes.length} recipes · ${globalSubs.length} substitutions · ${recipes.reduce((a,r)=>a+r.timesCooked,0)} meals cooked</p>
      <div class="home-search">
        <input id="homeSearch" type="text" placeholder="Search recipes by name, ingredient, category, or tag..."
          onkeydown="if(event.key==='Enter'){event.preventDefault();runHomeSearch();}">
        <button class="icon-btn primary" onclick="runHomeSearch()">🔍 Search</button>
      </div>
    </div>
    <div class="home-grid">
      <div>
        <div class="home-sec">
          <div class="sec-head"><h2>🔥 Most Cooked</h2>
            <button class="link" onclick="state.searchQuery='';state.sortBy='mostUsed';goto('browse')">See all →</button></div>
          ${cooked.length?`<div class="grid">${cooked.map(recipeCard).join('')}</div>`
            :`<div class="empty">Cook something and it'll show up here.</div>`}
        </div>
        <div class="home-sec">
          <div class="sec-head"><h2>✨ Rediscover</h2>
            <button class="link" onclick="refreshDiscover()">🔄 Shuffle</button></div>
          <p class="subtle" style="margin:-8px 0 14px;">Recipes you haven't made much lately — so they don't get lost in the pile.</p>
          ${discover.length?`<div class="grid">${discover.map(recipeCard).join('')}</div>`
            :`<div class="empty">Add a few more recipes to start getting suggestions.</div>`}
        </div>
      </div>
      <div>
        <div class="side-card">
          <h3>💬 Latest Ratings & Comments</h3>
          <div class="side-sub">Newest activity across all your recipes</div>
          ${feed.length?feed.map(f=>`
            <div class="feed-item">
              <div class="feed-top">
                <button class="feed-link" onclick="openRecipe('${f.r.id}')">${esc(f.r.title)}</button>
                <span class="stars" style="font-size:12px;">${'★'.repeat(f.c.stars)}${'☆'.repeat(5-f.c.stars)}</span>
              </div>
              ${f.c.comment?`<div class="ftext">"${esc(f.c.comment)}"</div>`:`<div class="ftext" style="color:var(--ink-soft);">Rated with no comment</div>`}
              <div class="fdate">${f.c.date}</div>
            </div>`).join('')
          :`<div class="empty" style="padding:12px 0;font-size:13px;">No ratings yet.</div>`}
        </div>
        <div class="side-card">
          <h3>🏆 Top 10 Recipes</h3>
          <div class="side-sub">Ranked by rating, then times cooked</div>
          ${top.map((r,i)=>`
            <div class="top-item">
              <span class="rank ${i<3?'gold':''}">${i+1}</span>
              <div style="min-width:0;">
                <button class="feed-link" onclick="openRecipe('${r.id}')">${esc(r.title)}</button>
                <div class="cats">${r.categories.join(' · ')}</div>
                <div class="tmeta">${r.ratings.length?`★ ${avgRating(r).toFixed(1)} (${r.ratings.length})`:'unrated'} · 👨‍🍳 ${r.timesCooked}×</div>
              </div>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
}


/* ============ COOKBOOKS ============ */
function openCookbook(id){
  attemptNav(()=>{
    if(state.currentBookId!==id) state.bookRecipeSearch='';
    state.view='cookbookDetail'; state.currentBookId=id; render();
  });
}
function recipesInBook(id){ return recipes.filter(r=>r.cookbookId===id); }
function fmtBytes(n){
  if(!n) return '';
  if(n<1024) return n+' B';
  if(n<1024*1024) return Math.round(n/1024)+' KB';
  return (n/1024/1024).toFixed(1)+' MB';
}
function onBookSearch(el){ focusId='bookSearch'; focusPos=el.selectionStart; state.bookSearch=el.value; renderMain(); }

function viewCookbooks(){
  const q=state.bookSearch.trim().toLowerCase();
  const list=cookbooks.filter(b=>!q ||
    b.title.toLowerCase().includes(q) || (b.author||'').toLowerCase().includes(q) ||
    (b.publisher||'').toLowerCase().includes(q));
  return `
    <div class="sec-head" style="margin-bottom:4px;">
      <h1 class="title">Cookbooks</h1>
      <button class="icon-btn primary no-print" onclick="startAddCookbook()">+ Add Cookbook</button>
    </div>
    <p class="subtle">${cookbooks.length} book${cookbooks.length!==1?'s':''} on the shelf</p>
    ${cookbooks.length?`<div class="controls">
      <div class="search-wrap"><span class="sicon">🔍</span>
        <input id="bookSearch" type="text" placeholder="Search by title, author, or publisher..."
          value="${escA(state.bookSearch)}" oninput="onBookSearch(this)"></div>
    </div>`:''}
    ${list.length===0?`<div class="empty">${cookbooks.length
      ? `No cookbooks match "${esc(state.bookSearch)}".`
      : 'No cookbooks yet. Add the books your recipes come from, and you can link recipes to them.'}</div>`
    :`<div class="grid">${list.map(b=>{
      const cover=bookCover(b), n=recipesInBook(b.id).length;
      return `<div class="rcard" onclick="openCookbook('${b.id}')">
        <button class="card-del no-print" title="Remove cookbook"
          onclick="event.stopPropagation(); confirmDeleteCookbook('${b.id}')">×</button>
        <div class="thumb book-thumb">${cover
          ? `<img src="${cover.url}" alt="${escA(b.title)}" style="${focalStyle(cover)}">`
          : b.emoji}</div>
        <div class="body">
          <h3>${esc(b.title)}</h3>
          ${b.author?`<div class="book-author">${esc(b.author)}</div>`:''}
          <div class="rmeta">
            <span>${b.published?esc(b.published):'—'}</span>
            <span>${n} recipe${n!==1?'s':''}</span>
          </div>
        </div>
      </div>`;}).join('')}</div>`}`;
}

const BOOK_RECIPE_LIMIT = 10;
function onBookRecipeSearch(el){
  focusId='bookRecipeSearch'; focusPos=el.selectionStart;
  state.bookRecipeSearch=el.value; renderMain();
}
/* Recipes linked to this book, searchable, capped so a big book doesn't
   bury the rest of the page. */
function renderBookRecipes(b, mine){
  const q=(state.bookRecipeSearch||'').trim().toLowerCase();
  const matched = q
    ? mine.filter(r => relevanceScore(r,q) > 0)
        .sort((a,c)=>relevanceScore(c,q)-relevanceScore(a,q))
    : mine.slice().sort((a,c)=>c.timesCooked-a.timesCooked);
  const shown = matched.slice(0, BOOK_RECIPE_LIMIT);
  const hidden = matched.length - shown.length;
  return `
    <div class="section-head"><h2>🍳 Recipes From This Book</h2>
      <span class="subtle" style="margin:0;">${mine.length} linked</span></div>
    ${mine.length > 4 ? `<div class="controls no-print" style="margin-bottom:14px;">
      <div class="search-wrap"><span class="sicon">🔍</span>
        <input id="bookRecipeSearch" type="text"
          placeholder="Search this book's recipes by name, ingredient, or tag..."
          value="${escA(state.bookRecipeSearch||'')}" oninput="onBookRecipeSearch(this)"></div>
    </div>` : ''}
    ${mine.length === 0
      ? `<div class="empty">No recipes linked yet. Open a recipe, hit Edit, and choose this book
          under "From a cookbook?".</div>`
      : shown.length === 0
        ? `<div class="empty">Nothing in this book matches "${esc(state.bookRecipeSearch)}".</div>`
        : `<div class="grid">${shown.map(recipeCard).join('')}</div>
           ${hidden > 0 ? `<div class="subtle" style="margin-top:12px;text-align:center;">
             Showing ${shown.length} of ${matched.length} — ${q?'refine your search':'search above'} to narrow it down.
           </div>` : ''}`}`;
}

function viewCookbookDetail(){
  const b=cookbooks.find(x=>x.id===state.currentBookId);
  if(!b) return `<div class="empty">Cookbook not found.</div>`;
  const cover=bookCover(b), mine=recipesInBook(b.id);
  const facts=[['Author',b.author],['Publisher',b.publisher],['Published',b.published],
               ['Edition',b.edition],['ISBN',b.isbn]].filter(f=>f[1]);
  return `
    <button class="back no-print" onclick="goto('cookbooks')">← Back to cookbooks</button>
    <div class="book-head">
      <div class="book-cover">${cover
        ? `<img src="${cover.url}" alt="${escA(b.title)}" style="${focalStyle(cover)}">
           <button class="hero-adjust no-print" onclick="openFocalEditor('book','${cover.id}')"
             title="Choose which part of the cover shows">⤧</button>`
        : `<div class="book-cover-blank">${b.emoji}</div>`}</div>
      <div style="flex:1;min-width:240px;">
        <h1 class="title" style="font-size:26px;">${esc(b.title)}</h1>
        ${b.author?`<p class="subtle" style="margin:2px 0 14px;font-size:15px;">${esc(b.author)}</p>`:''}
        ${facts.length?`<dl class="facts">${facts.map(f=>
          `<dt>${f[0]}</dt><dd>${esc(f[1])}</dd>`).join('')}</dl>`:''}
        <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;" class="no-print">
          <button class="icon-btn" onclick="startEditCookbook('${b.id}')">✏️ Edit details</button>
          <button class="icon-btn" onclick="window.print()">🖨️ Print</button>
        </div>
      </div>
    </div>

    ${b.notes?`<div class="section-head"><h2>📝 Notes</h2></div>
      <div class="notes-body">${esc(b.notes).replace(/\n/g,'<br>')}</div>`:''}

    ${renderBookRecipes(b, mine)}

    <div class="section-head"><h2>📷 Photos</h2>
      <span class="subtle" style="margin:0;">${(b.images||[]).length} photo${(b.images||[]).length!==1?'s':''}${(b.images||[]).length?' · ★ marks the cover':''}</span></div>
    ${(b.images||[]).length?`<div class="photo-grid">${b.images.map(im=>`
      <div class="photo ${im.favorite?'is-cover':''}">
        <img src="${im.url}" alt="${escA(im.filename||b.title)}">
        <div class="photo-actions no-print">
          <button class="pbtn fav ${im.favorite?'on':''}" title="${im.favorite?'Reposition this cover':'Make this the cover'}"
            onclick="${im.favorite?`openFocalEditor('book','${im.id}')`:`setBookCover('${im.id}')`}">${im.favorite?'★':'☆'}</button>
          ${im.favorite?`<button class="pbtn" title="Reposition" onclick="openFocalEditor('book','${im.id}')">⤧</button>`:''}
          <button class="pbtn del" title="Delete" onclick="confirmDeleteBookFile('${b.id}','${im.id}')">×</button>
        </div>
        ${im.favorite?`<span class="cover-badge">★ Cover</span>`:''}
      </div>`).join('')}</div>`:''}
    <label class="upload-zone no-print">
      📁 ${(b.images||[]).length?'Add more photos':'Add photos of the book'} — click to choose
      <input type="file" accept="image/*" multiple onchange="handleBookUpload(event,'${b.id}')">
    </label>

    <div class="section-head"><h2>📄 Scanned Files</h2>
      <span class="subtle" style="margin:0;">${(b.files||[]).length} file${(b.files||[]).length!==1?'s':''}</span></div>
    ${(b.files||[]).length?`<div class="file-list">${b.files.map(f=>`
      <div class="file-row">
        <span class="file-ico">${(f.contentType||'').includes('pdf')?'📕':'📄'}</span>
        <div style="flex:1;min-width:0;">
          <a class="file-name" href="${f.url}" download>${esc(f.filename||'file')}</a>
          <div class="file-meta">${esc(f.contentType||'')} ${fmtBytes(f.sizeBytes)}</div>
        </div>
        <button class="rm-btn no-print" onclick="confirmDeleteBookFile('${b.id}','${f.id}')">×</button>
      </div>`).join('')}</div>`
      :`<div class="empty" style="padding:14px 0;">Nothing scanned yet. PDFs or scans of the book go here.</div>`}
    <label class="upload-zone no-print">
      📎 Upload a scan or document (PDF, images, anything)
      <input type="file" multiple onchange="handleBookUpload(event,'${b.id}')">
    </label>`;
}

function startAddCookbook(){
  attemptNav(()=>{
    state.editingBook={id:null,title:'',author:'',publisher:'',published:'',edition:'',isbn:'',notes:'',emoji:'📕'};
    state.view='editCookbook'; render();
  });
}
function startEditCookbook(id){
  attemptNav(()=>{
    state.editingBook=JSON.parse(JSON.stringify(cookbooks.find(b=>b.id===id)));
    state.view='editCookbook'; render();
  });
}
function viewEditCookbook(){
  const b=state.editingBook, isNew=!b.id;
  return `
    <button class="back" onclick="cancelBookEdit()">← Cancel</button>
    <h1 class="title">${isNew?'Add a Cookbook':'Edit Cookbook'}</h1>
    <p class="subtle">Only the title is required — fill in whatever else you know.</p>
    <div style="max-width:640px;">
      <div class="form-row"><label>Title</label>
        <input type="text" id="b_title" value="${escA(b.title)}" placeholder="The Joy of Cooking"></div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;">
        <div class="form-row" style="flex:2;min-width:220px;"><label>Author</label>
          <input type="text" id="b_author" value="${escA(b.author)}" placeholder="Irma S. Rombauer"></div>
        <div class="form-row" style="flex:1;min-width:110px;"><label>Cover emoji</label>
          <input type="text" id="b_emoji" value="${escA(b.emoji)}"></div>
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;">
        <div class="form-row" style="flex:2;min-width:200px;"><label>Publisher</label>
          <input type="text" id="b_publisher" value="${escA(b.publisher)}" placeholder="Scribner"></div>
        <div class="form-row" style="flex:1;min-width:130px;"><label>Published</label>
          <input type="text" id="b_published" value="${escA(b.published)}" placeholder="1997"></div>
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;">
        <div class="form-row" style="flex:1;min-width:130px;"><label>Edition</label>
          <input type="text" id="b_edition" value="${escA(b.edition)}" placeholder="75th Anniversary"></div>
        <div class="form-row" style="flex:2;min-width:200px;"><label>ISBN</label>
          <input type="text" id="b_isbn" value="${escA(b.isbn)}" placeholder="978-0-7432-4626-2"></div>
      </div>
      <div class="form-row"><label>Notes</label>
        <textarea id="b_notes" rows="4" placeholder="Where it came from, who gave it to you, which sections are worth cooking from..."
          style="width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--line);font-size:14px;font-family:inherit;">${esc(b.notes)}</textarea></div>
      <button class="icon-btn primary" onclick="saveCookbook()">💾 Save Cookbook</button>
      ${isNew?`<div class="subtle" style="margin-top:10px;font-size:12.5px;">
        You can add photos and scanned files once it's saved.</div>`:''}
    </div>`;
}
function cancelBookEdit(){ state.editingBook=null; state.view='cookbooks'; render(); }
async function saveCookbook(){
  const g=id=>document.getElementById(id).value;
  const b=state.editingBook;
  const payload={
    title:g('b_title').trim(), author:g('b_author').trim(), publisher:g('b_publisher').trim(),
    published:g('b_published').trim(), edition:g('b_edition').trim(), isbn:g('b_isbn').trim(),
    notes:g('b_notes'), emoji:g('b_emoji').trim()||'📕',
  };
  if(!payload.title){ toast('A cookbook needs a title.'); return; }
  try{
    const res = b.id ? await apiJSON('/api/cookbooks/'+b.id,'PUT',payload)
                     : await apiJSON('/api/cookbooks','POST',payload);
    const id = b.id || res.id;
    state.editingBook=null;
    openCookbook(id);
    toast(b.id?'Cookbook updated.':'Cookbook added.');
  }catch(e){ apiError(e); }
}
function confirmDeleteCookbook(id){
  const b=cookbooks.find(x=>x.id===id); if(!b) return;
  const n=recipesInBook(id).length;
  showModal({
    title:'Remove this cookbook?',
    body:`<b>${esc(b.title)}</b> will be removed, along with its photos and scanned files.` +
      (n?`<br><br>The <b>${n} recipe${n!==1?'s':''}</b> linked to it will <b>not</b> be deleted —
          they just stop showing a source.`:''),
    buttons:[
      {label:'Cancel'},
      {label:'Remove cookbook', style:'danger', action:async()=>{
        try{
          await apiJSON('/api/cookbooks/'+id,'DELETE');
          if(state.currentBookId===id){ state.currentBookId=null; state.view='cookbooks'; }
          render(); toast(`"${b.title}" removed.`);
        }catch(e){ apiError(e); }
      }}
    ]
  });
}
async function handleBookUpload(ev,bookId){
  const files=[...ev.target.files];
  ev.target.value='';
  if(!files.length) return;
  setBusy(true);
  try{
    for(const f of files){
      const fd=new FormData();
      // shrink photos before upload; leave documents byte-for-byte
      if(f.type.startsWith('image/')){
        const url=await fileToDownscaledDataUrl(f);
        fd.append('file', await (await fetch(url)).blob(), f.name);
      } else {
        fd.append('file', f, f.name);
      }
      fd.append('filename', f.name);
      applyState(await api('/api/cookbooks/'+bookId+'/files',{method:'POST',body:fd}));
    }
    render(); toast(`${files.length} file${files.length!==1?'s':''} added.`);
  }catch(e){ apiError(e); }
  finally{ setBusy(false); }
}
async function setBookCover(fileId){
  try{ await apiJSON('/api/cookbook-files/'+fileId+'/cover','POST');
    render(); toast('Cover updated.'); }catch(e){ apiError(e); }
}
function confirmDeleteBookFile(bookId,fileId){
  const b=cookbooks.find(x=>x.id===bookId); if(!b) return;
  const item=[...(b.images||[]),...(b.files||[])].find(f=>f.id===fileId);
  showModal({
    title:'Delete this?',
    body:`<b>${esc(item&&item.filename?item.filename:'This item')}</b> will be removed from ${esc(b.title)}.`,
    buttons:[
      {label:'Cancel'},
      {label:'Delete', style:'danger', action:async()=>{
        try{ await apiJSON('/api/cookbook-files/'+fileId,'DELETE'); render(); toast('Deleted.'); }
        catch(e){ apiError(e); }
      }}
    ]
  });
}

/* ============ BROWSE ============ */
function viewBrowse(){
  const list=filteredSorted();
  return `
    <h1 class="title">Browse Recipes</h1>
    <p class="subtle">${recipes.length} recipes in your pantry</p>
    <div class="controls">
      <div class="search-wrap"><span class="sicon">🔍</span>
        <input id="searchInput" type="text" placeholder="Search by name, ingredient, category, or tag..." value="${escA(state.searchQuery)}" oninput="onSearch(this)"></div>
      <select onchange="state.categoryFilter=this.value; renderMain();">
        <option value="all">All Categories</option>
        ${allCategories.map(c=>`<option value="${escA(c)}" ${state.categoryFilter===c?'selected':''}>${esc(c)}</option>`).join('')}
      </select>
      <select onchange="state.sortBy=this.value; renderMain();">
        <option value="newest" ${state.sortBy==='newest'?'selected':''}>Newest to Oldest</option>
        <option value="oldest" ${state.sortBy==='oldest'?'selected':''}>Oldest to Newest</option>
        <option value="relevant" ${state.sortBy==='relevant'?'selected':''}>Most Relevant</option>
        <option value="mostUsed" ${state.sortBy==='mostUsed'?'selected':''}>Most Used (times cooked)</option>
        <option value="topRated" ${state.sortBy==='topRated'?'selected':''}>Highest Rated</option>
      </select>
    </div>
    ${list.length===0?`<div class="empty">No recipes match your search/filters.</div>`:`
    <div class="grid">${list.map(recipeCard).join('')}</div>`}`;
}
function recipeCard(r){
  return `<div class="rcard" onclick="openRecipe('${r.id}')">
    <button class="card-del no-print" title="Remove recipe" onclick="event.stopPropagation(); confirmDeleteRecipe('${r.id}')">×</button>
    <div class="thumb">${coverImage(r)
      ? `<img src="${coverImage(r).url}" alt="${escA(r.title)}" style="${focalStyle(coverImage(r))}">`
      : r.emoji}</div>
    <div class="body">
      <div>${r.categories.map(c=>`<span class="badge">${esc(c)}</span>`).join('')}</div>
      <h3>${esc(r.title)}</h3>
      <div class="rmeta">
        <span class="stars">${r.ratings.length?starString(avgRating(r)):'☆☆☆☆☆'} ${r.ratings.length?`(${r.ratings.length})`:''}</span>
        <span>👨‍🍳 ${r.timesCooked}×</span>
      </div>
    </div>
  </div>`;
}
function confirmDeleteRecipe(id){
  const r=recipes.find(x=>x.id===id);
  if(!r) return;
  showModal({
    title:'Remove this recipe?',
    body:`<b>${esc(r.title)}</b> will be permanently removed, along with its
      ${r.ratings.length} rating${r.ratings.length!==1?'s':''}, comments, and its record of being cooked ${r.timesCooked} times.
      <br><br>Your substitutions library won't be affected.`,
    buttons:[
      {label:'Cancel'},
      {label:'Remove recipe', style:'danger', action:async()=>{
        try{
          await apiJSON('/api/recipes/'+id,'DELETE');
          delete state.appliedSubs[id];
          if(state.currentRecipeId===id){ state.currentRecipeId=null; state.view='browse'; }
          render(); toast(`"${r.title}" removed.`);
        }catch(e){ apiError(e); }
      }}
    ]
  });
}
function onSearch(el){
  focusId='searchInput'; focusPos=el.selectionStart;
  state.searchQuery=el.value;
  if(state.searchQuery.trim() && state.sortBy==='newest') state.sortBy='relevant';
  renderMain();
}

/* ============ RECIPE DETAIL ============ */
function setTab(t){ state.detailTab=t; state.showRecipeSubForm=false; renderMain(); }
function setScale(id,m){ state.scale[id]=m; renderMain(); }
async function logCooked(id){
  try{
    const res=await api('/api/recipes/'+id+'/cook',{method:'POST'});
    const r=recipes.find(x=>x.id===id);
    if(r) r.timesCooked=res.timesCooked;
    render(); toast(`Logged! You've cooked this ${res.timesCooked} time${res.timesCooked===1?'':'s'}.`);
  }catch(e){ apiError(e); }
}
function viewDetail(){
  const r=recipes.find(x=>x.id===state.currentRecipeId);
  if(!r) return `<div class="empty">Recipe not found.</div>`;
  const mult=state.scale[r.id]||1;
  const pairs=subsForRecipe(r);
  const applied=state.appliedSubs[r.id]||{};
  const nApplied=Object.keys(applied).length;
  const cover=coverImage(r);
  return `
    <button class="back no-print" onclick="goto('browse')">← Back to recipes</button>
    ${cover?`<div class="hero"><img src="${cover.url}" alt="${escA(r.title)}" style="${focalStyle(cover)}">
      <button class="hero-adjust no-print" onclick="openFocalEditor('recipe','${cover.id}')"
        title="Choose which part of the photo shows">⤧ Reposition</button></div>`:''}
    <div class="detail-head">
      <div>
        <div>${r.categories.map(c=>`<span class="badge">${esc(c)}</span>`).join('')}</div>
        <h1>${r.emoji} ${esc(r.title)}</h1>
        ${renderSourceLine(r)}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;" class="no-print">
        <button class="icon-btn sage" onclick="logCooked('${r.id}')">👨‍🍳 I cooked this</button>
        <button class="icon-btn" onclick="addRecipeToShoppingList('${r.id}')">🛒 Add to list</button>
        <button class="icon-btn" onclick="startEditRecipe('${r.id}')">✏️ Edit</button>
        <button class="icon-btn primary" onclick="window.print()">🖨️ Print</button>
      </div>
    </div>
    <div class="rating-summary">
      <span class="stars" style="font-size:20px;">${r.ratings.length?starString(avgRating(r)):'☆☆☆☆☆'}</span>
      <span class="subtle" style="margin:0;">${r.ratings.length} rating${r.ratings.length!==1?'s':''}</span>
      <span class="cooked-pill">👨‍🍳 Cooked ${r.timesCooked} time${r.timesCooked===1?'':'s'}</span>
      ${nApplied?`<span class="swap-tag" style="margin:0;">${nApplied} temporary substitution${nApplied!==1?'s':''} active</span>`:''}
    </div>
    <div class="scale-row no-print">
      <label>Scale recipe:</label>
      ${[0.5,1,2,3].map(v=>`<button class="scale-btn ${mult===v?'active':''}" onclick="setScale('${r.id}',${v})">${v===0.5?'½':v}×</button>`).join('')}
      <span style="color:var(--ink-soft);font-size:12.5px;">or custom:</span>
      <input type="number" min="0.1" step="0.1" value="${mult}" onchange="setScale('${r.id}', parseFloat(this.value)||1)">
      <span style="color:var(--ink-soft);font-size:12.5px;">→ serves ${Math.round(r.baseServings*mult*10)/10}</span>
    </div>
    <div class="tabs no-print">
      <button class="tab ${state.detailTab==='ingredients'?'active':''}" onclick="setTab('ingredients')">Ingredients</button>
      <button class="tab ${state.detailTab==='instructions'?'active':''}" onclick="setTab('instructions')">Instructions</button>
      <button class="tab ${state.detailTab==='substitutions'?'active':''}" onclick="setTab('substitutions')">Substitutions${pairs.length?` (${pairs.length})`:''}</button>
    </div>
    ${state.detailTab==='ingredients'?renderIngredients(r,mult,applied):''}
    ${state.detailTab==='instructions'?`<ol class="steps">${r.instructions.map(s=>`<li>${esc(s)}</li>`).join('')}</ol>`:''}
    ${state.detailTab==='substitutions'?renderSubTab(r,pairs,applied):''}
    ${renderNotesSection(r)}
    ${renderPhotoSection(r)}
    ${renderRatingsSection(r)}`;
}
function renderIngredients(r,mult,applied){
  return `<ul class="ing-list">${r.ingredients.map(i=>{
    const sw=applied[i.id];
    return `<li class="${sw?'swapped':''}">
      <span><span class="qty">${fmtQty(i.qty*mult)} ${esc(i.unit)}</span>
      ${sw?`<s>${esc(i.name)}</s> → <b>${esc(sw.substitute)}</b><span class="swap-tag">substituted</span>`:esc(i.name)}</span>
      <span style="display:flex;gap:6px;" class="no-print">
        ${sw?`<button class="ing-add" style="border-color:var(--swap-line);color:var(--swap-ink);" onclick="unapplySub('${r.id}','${i.id}')">↩ undo</button>`:''}
        <button class="ing-add" onclick="addSingleIngredient('${r.id}','${i.id}')">+ list</button>
      </span></li>`;
  }).join('')}</ul>
  ${Object.keys(applied).length?`<div class="notice no-print" style="margin-top:14px;">⚠️ Highlighted rows are <b>temporary</b> substitutions for this cooking session only. They'll revert when you leave the recipe.</div>`:''}`;
}
function renderSubTab(r,pairs,applied){
  return `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;" class="no-print">
      <button class="icon-btn" onclick="refreshSubs('${r.id}')">🔄 Refresh substitutions</button>
      <button class="icon-btn ${state.showRecipeSubForm?'primary':''}" onclick="state.showRecipeSubForm=!state.showRecipeSubForm; renderMain();">+ Add substitution</button>
    </div>
    ${state.showRecipeSubForm?`
    <div class="panel no-print" style="margin-bottom:18px;">
      <div class="form-row"><label>Which ingredient?</label>
        <select id="rs_ing">${r.ingredients.map(i=>`<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select></div>
      <div class="form-row"><label>Substitute with</label><input type="text" id="rs_sub" placeholder="e.g. almond milk"></div>
      <div class="form-row"><label>Notes (optional)</label><input type="text" id="rs_notes" placeholder="e.g. 1:1 ratio, slightly nuttier"></div>
      <button class="icon-btn primary" onclick="submitRecipeSub('${r.id}')">Check & add</button>
    </div>`:''}
    ${pairs.length===0?`<div class="empty">No substitutions match this recipe's ingredients yet.<br>Add one above, or build up your library in the Substitutions section.</div>`:
    pairs.map(p=>{
      const isApplied = applied[p.ing.id] && applied[p.ing.id].substitute===p.sub.substitute;
      return `<div class="sub-card">
        <div><b>${esc(p.sub.ingredient)}</b> → ${esc(p.sub.substitute)}
          <span class="scope-tag ${p.sub.scope==='library'?'scope-library':'scope-recipe'}">${p.sub.scope==='library'?'library':'this recipe'}</span>
          ${p.sub.notes?`<div class="note">${esc(p.sub.notes)}</div>`:''}
          <div class="note">matches ingredient: <i>${esc(p.ing.name)}</i></div></div>
        <button class="icon-btn sm no-print ${isApplied?'':'primary'}" onclick="${isApplied?`unapplySub('${r.id}','${p.ing.id}')`:`applySub('${r.id}','${p.ing.id}','${p.sub.id}')`}">
          ${isApplied?'✓ Applied — undo':'Use in list'}</button>
      </div>`;
    }).join('')}`;
}
/* ---- image focal point ----
 * Cropped covers use object-position so you choose what stays in frame
 * (a book's title, a dish rather than the tablecloth) without touching the file.
 */
function focalStyle(img){
  if(!img) return '';
  const x = img.focalX == null ? 50 : img.focalX;
  const y = img.focalY == null ? 50 : img.focalY;
  return `object-position:${x}% ${y}%;`;
}
function findImage(kind, id){
  if(kind==='recipe'){
    for(const r of recipes){ const m=(r.images||[]).find(i=>i.id===id); if(m) return m; }
  } else {
    for(const b of cookbooks){ const m=(b.images||[]).find(i=>i.id===id); if(m) return m; }
  }
  return null;
}
let focalDraft = null;
function openFocalEditor(kind, id){
  const img = findImage(kind, id);
  if(!img) return;
  focalDraft = { kind, id, url: img.url,
    x: img.focalX == null ? 50 : img.focalX,
    y: img.focalY == null ? 50 : img.focalY };
  renderFocalEditor();
}
function renderFocalEditor(){
  const d = focalDraft;
  if(!d){ closeModal(); return; }
  const root = document.getElementById('modalRoot');
  root.className = 'show';
  root.innerHTML = `<div class="modal" style="max-width:600px;">
    <h3>Reposition image</h3>
    <div class="mbody">
      <p style="margin:0 0 12px;">Click or drag on the photo to choose what stays in view when it's
      cropped. The preview underneath shows exactly how it will appear.</p>
      <div class="focal-pick" id="focalPick">
        <img src="${d.url}" alt="" draggable="false">
        <div class="focal-dot" id="focalDot" style="left:${d.x}%;top:${d.y}%;"></div>
      </div>
      <div class="focal-preview-label">Preview</div>
      <div class="focal-preview ${d.kind==='book'?'as-book':'as-hero'}">
        <img id="focalPreview" src="${d.url}" alt="" style="object-position:${d.x}% ${d.y}%;">
      </div>
    </div>
    <div class="mbtns">
      <button class="icon-btn" onclick="closeFocalEditor()">Cancel</button>
      <button class="icon-btn" onclick="setFocalFromEditor(50,50)">Recentre</button>
      <button class="icon-btn primary" onclick="saveFocal()">Save position</button>
    </div>
  </div>`;
  const pick = document.getElementById('focalPick');
  const move = (ev)=>{
    const rect = pick.getBoundingClientRect();
    const pt = ev.touches ? ev.touches[0] : ev;
    const x = Math.min(100, Math.max(0, ((pt.clientX - rect.left)/rect.width)*100));
    const y = Math.min(100, Math.max(0, ((pt.clientY - rect.top)/rect.height)*100));
    setFocalFromEditor(x, y);
  };
  let dragging = false;
  pick.addEventListener('mousedown', e=>{ dragging=true; move(e); e.preventDefault(); });
  window.addEventListener('mousemove', e=>{ if(dragging) move(e); });
  window.addEventListener('mouseup', ()=>{ dragging=false; });
  pick.addEventListener('touchstart', e=>{ move(e); }, {passive:true});
  pick.addEventListener('touchmove', e=>{ move(e); }, {passive:true});
}
function setFocalFromEditor(x,y){
  if(!focalDraft) return;
  focalDraft.x = x; focalDraft.y = y;
  const dot = document.getElementById('focalDot');
  const prev = document.getElementById('focalPreview');
  if(dot){ dot.style.left = x+'%'; dot.style.top = y+'%'; }
  if(prev){ prev.style.objectPosition = `${x}% ${y}%`; }
}
function closeFocalEditor(){ focalDraft = null; closeModal(); }
async function saveFocal(){
  const d = focalDraft;
  if(!d) return;
  const path = d.kind==='recipe' ? '/api/photos/'+d.id+'/focal' : '/api/cookbook-files/'+d.id+'/focal';
  focalDraft = null; closeModal();
  try{
    await apiJSON(path,'POST',{x:Math.round(d.x*10)/10, y:Math.round(d.y*10)/10});
    render(); toast('Image repositioned.');
  }catch(e){ apiError(e); }
}

function bookById(id){ return cookbooks.find(b=>b.id===id) || null; }
function bookCover(b){ return (b.images||[]).find(i=>i.favorite) || (b.images||[])[0] || null; }

/* "From <cookbook>, p. 42" under the recipe title, linking through to the book */
function renderSourceLine(r){
  const b = r.cookbookId ? bookById(r.cookbookId) : null;
  if(!b) return '';
  return `<div class="source-line">From
    <button class="book-link" onclick="openCookbook('${b.id}')">${b.emoji} ${esc(b.title)}</button>${
      r.cookbookPage?` <span class="page-ref">p. ${esc(r.cookbookPage)}</span>`:''}</div>`;
}

function renderNotesSection(r){
  const has = (r.notes||'').trim();
  return `
    <div class="section-head"><h2>📝 Notes</h2>
      <button class="icon-btn sm no-print" onclick="startEditRecipe('${r.id}')">✏️ Edit notes</button></div>
    ${has ? `<div class="notes-body">${esc(r.notes)}</div>`
          : `<div class="empty" style="padding:16px 0;">No notes yet — things like "double the garlic" or
             "Mom's version uses buttermilk" go here.</div>`}`;
}

function renderPhotoSection(r){
  const imgs=r.images||[];
  return `
    <div class="section-head"><h2>📷 Photos</h2>
      <span class="subtle" style="margin:0;">${imgs.length} photo${imgs.length!==1?'s':''}${imgs.length?' · ★ marks the cover':''}</span></div>
    ${imgs.length?`<div class="photo-grid">${imgs.map(im=>`
      <div class="photo ${im.favorite?'is-cover':''}">
        <img src="${im.url}" alt="${escA(im.caption||r.title)}">
        <div class="photo-actions no-print">
          <button class="pbtn fav ${im.favorite?'on':''}" title="${im.favorite?'Reposition this cover photo':'Make this the cover photo'}"
            onclick="${im.favorite?`openFocalEditor('recipe','${im.id}')`:`setCoverImage('${r.id}','${im.id}')`}">${im.favorite?'★':'☆'}</button>
          ${im.favorite?`<button class="pbtn" title="Reposition" onclick="openFocalEditor('recipe','${im.id}')">⤧</button>`:''}
          <button class="pbtn del no-print" title="Delete photo" onclick="confirmDeletePhoto('${r.id}','${im.id}')">×</button>
        </div>
        ${im.favorite?`<span class="cover-badge">★ Cover</span>`:''}
      </div>`).join('')}</div>`:''}
    <label class="upload-zone no-print">
      📁 ${imgs.length?'Add more photos':'Add photos of this dish'} — click to choose files
      <input type="file" accept="image/*" multiple onchange="handlePhotoUpload(event,'${r.id}')">
    </label>
    ${imgs.length?`<div class="subtle" style="margin-top:8px;font-size:12.5px;">Click ☆ on any photo to make it the cover — it shows at the top of this page and on the search page card.</div>`:''}`;
}
function renderRatingsSection(r){
  return `
    <div class="section-head"><h2>⭐ Ratings & Comments</h2>
      <span class="subtle" style="margin:0;">${r.ratings.length} review${r.ratings.length!==1?'s':''} · avg ${r.ratings.length?(avgRating(r)).toFixed(1):'—'}</span></div>
    <div class="panel no-print" style="margin-bottom:18px;">
      <div style="font-weight:700;font-size:13.5px;margin-bottom:8px;">Rate this recipe <span style="font-weight:400;color:var(--ink-soft);">(also logs a cook — bumps your Most Used count)</span></div>
      ${[1,2,3,4,5].map(n=>`<span class="starpick ${n<=state.starDraft?'on':''}" onclick="state.starDraft=${n}; renderMain();">★</span>`).join('')}
      <textarea id="commentDraft" placeholder="Optional comment — what worked, what you'd change..." rows="2" style="width:100%;margin-top:10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);font-size:13.5px;font-family:inherit;"></textarea>
      <button class="icon-btn primary" style="margin-top:10px;" onclick="submitRating('${r.id}')">Submit Rating</button>
    </div>
    ${r.ratings.length===0?`<div class="empty">No comments yet — be the first to rate it!</div>`:
    r.ratings.slice().reverse().map(c=>`<div class="comment">
      <div class="cstars">${'★'.repeat(c.stars)}${'☆'.repeat(5-c.stars)}</div>
      ${c.comment?`<div class="ctext">${esc(c.comment)}</div>`:''}
      <div class="cdate">${c.date}</div></div>`).join('')}`;
}
async function submitRating(id){
  const c=document.getElementById('commentDraft').value.trim();
  const stars=state.starDraft||5;
  try{
    await apiJSON('/api/recipes/'+id+'/ratings','POST',{stars,comment:c});
    state.starDraft=0;
    render(); toast('Rating saved — cook count updated.');
  }catch(e){ apiError(e); }
}

/* ---- substitution apply / unapply ---- */
function applySub(recipeId,ingId,subId){
  const r=recipes.find(x=>x.id===recipeId);
  const all=[...globalSubs,...(r.localSubs||[])];
  const s=all.find(x=>x.id===subId);
  const ing=r.ingredients.find(i=>i.id===ingId);
  if(!state.appliedSubs[recipeId]) state.appliedSubs[recipeId]={};
  state.appliedSubs[recipeId][ingId]={ingredientName:ing.name, substitute:s.substitute, notes:s.notes};
  state.detailTab='ingredients';
  render(); toast(`Swapped "${ing.name}" → "${s.substitute}" (temporary)`);
}
function unapplySub(recipeId,ingId){
  if(state.appliedSubs[recipeId]){
    delete state.appliedSubs[recipeId][ingId];
    if(!Object.keys(state.appliedSubs[recipeId]).length) delete state.appliedSubs[recipeId];
  }
  render(); toast('Reverted to original ingredient.');
}
function refreshSubs(recipeId){
  const r=recipes.find(x=>x.id===recipeId);
  const n=subsForRecipe(r).length;
  render();
  toast(n?`Re-scanned ingredients — ${n} substitution${n!==1?'s':''} found.`:'Re-scanned — no matches found in your library.');
}
/* Smart add: compares against library, offers merge/replace/add */
function submitRecipeSub(recipeId){
  const r=recipes.find(x=>x.id===recipeId);
  const ingId=document.getElementById('rs_ing').value;
  const subText=document.getElementById('rs_sub').value.trim();
  const notes=document.getElementById('rs_notes').value.trim();
  if(!subText){ toast('Enter a substitute first.'); return; }
  const ing=r.ingredients.find(i=>i.id===ingId);
  const similar=subsForName(ing.name);

  const after=(msg)=>{ state.showRecipeSubForm=false; state.detailTab='substitutions'; render(); toast(msg); };
  const addLocal=async()=>{
    try{ await apiJSON('/api/substitutions','POST',
      {recipeId:r.id, ingredient:ing.name, substitute:subText, notes});
      after('Added to this recipe only.'); }catch(e){ apiError(e); }
  };
  const addGlobal=async()=>{
    try{ await apiJSON('/api/substitutions','POST',
      {ingredient:normIng(ing.name), substitute:subText, notes});
      after('Added to your substitutions library.'); }catch(e){ apiError(e); }
  };
  const replaceGlobal=async(oldId)=>{
    const old=globalSubs.find(s=>s.id===oldId)||{};
    try{ await apiJSON('/api/substitutions/'+oldId,'PUT',
      {ingredient:old.ingredient||ing.name, substitute:subText, notes});
      after('Library entry replaced.'); }catch(e){ apiError(e); }
  };

  if(similar.length===0){
    showModal({
      title:'New substitution — add to your library?',
      body:`You're substituting <b>${esc(ing.name)}</b> with <b>${esc(subText)}</b>.<br><br>
        Nothing similar exists in your library yet. Adding it there means it will <b>automatically appear on every recipe</b> that uses ${esc(normIng(ing.name))}.`,
      buttons:[
        {label:'Cancel'},
        {label:'Just this recipe', action:addLocal},
        {label:'Add to library', style:'primary', action:addGlobal}
      ]
    });
  } else {
    showModal({
      title:'Similar substitution already exists',
      body:`Your library already has ${similar.length===1?'this entry':'these entries'} for <b>${esc(normIng(ing.name))}</b>:<br><br>
        ${similar.map(s=>`<div class="sub-card" style="margin-bottom:8px;"><div><b>${esc(s.ingredient)}</b> → ${esc(s.substitute)}${s.notes?`<div class="note">${esc(s.notes)}</div>`:''}</div></div>`).join('')}
        <br>You're adding: <b>${esc(subText)}</b>. What would you like to do?`,
      buttons:[
        {label:'Cancel'},
        {label:'Use here only', action:addLocal},
        {label:'Replace existing', action:()=>replaceGlobal(similar[0].id)},
        {label:'Add as another option', style:'primary', action:addGlobal}
      ]
    });
  }
}

/* ============ ADD / EDIT RECIPE ============ */
function startAddRecipe(){
  attemptNav(()=>{
    showModal({
      title:'Add a recipe',
      body:`<div class="choice-grid">
        <div class="choice" onclick="closeModal(); startManualRecipe();">
          <div class="cico">✍️</div><h4>Type it in</h4>
          <p>Enter the ingredients and steps yourself.</p></div>
        ${scanEnabled?`<label class="choice">
          <div class="cico">📷</div><h4>Scan a photo</h4>
          <p>Snap a cookbook page, index card, or screenshot and let it read the recipe for you.</p>
          <input type="file" accept="image/*" style="display:none" onchange="handleScanUpload(event)">
        </label>`:`<div class="choice" style="opacity:.55;cursor:not-allowed;">
          <div class="cico">📷</div><h4>Scan a photo</h4>
          <p>Unavailable — no scanning API key is configured on this site.</p>
        </div>`}
      </div>`,
      buttons:[{label:'Cancel'}]
    });
  });
}
/* ---- Scan-to-recipe ---- */
async function handleScanUpload(ev){
  const f=ev.target.files[0];
  ev.target.value='';
  if(!f) return;
  closeModal();
  let timer=null;
  try{
    const url=await fileToDownscaledDataUrl(f,1600);
    state.scanImage=url; state.scanStep=0; state.view='scanning'; render();
    timer=setInterval(()=>{ if(state.scanStep<2){ state.scanStep++; renderMain(); } },1100);
    const res=await api('/api/scan',{
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({image:url}),
    },true);
    clearInterval(timer); timer=null;
    applyScanResult(res);
  }catch(e){
    if(timer) clearInterval(timer);
    state.view='browse'; state.scanImage=null; render();
    apiError(e);
  }
}
function applyScanResult(res){
  const r=res.recipe||{};
  const ings=(r.ingredients||[]).map(i=>({
    id:uid(), qty:i.qty, qtyRaw:i.qtyRaw, unit:i.unit, name:i.name }));
  if(!ings.length && !(r.instructions||[]).length){
    state.view='browse'; render();
    showModal({title:"Couldn't read a recipe there",
      body:'<p>Nothing recipe-shaped was found in that image. Try a clearer, straight-on photo with the '+
           'ingredients and steps both visible — or add it by hand.</p>',
      buttons:[{label:'OK'},{label:'Type it in', style:'primary', action:startManualRecipe}]});
    return;
  }
  state.editing={
    id:null, title:r.title||'Untitled Recipe',
    categories:(r.categories&&r.categories.length)?r.categories:['Dinner'],
    tags:r.tags||[], dateAdded:new Date().toISOString().slice(0,10),
    baseServings:r.baseServings||4, emoji:r.emoji||'🍽️',
    ratings:[], timesCooked:0, localSubs:[], images:[],
    notes:'', cookbookId:null, cookbookPage:'',
    ingredients:ings, instructions:r.instructions||[],
  };
  state.scanSource={image:state.scanImage, flagged:res.flagged||[], notes:res.notes||''};
  state.view='editRecipe'; render();
  const n=(res.flagged||[]).length;
  toast(n?`Recipe read — ${n} line${n!==1?'s':''} flagged for you to check.`:'Recipe read — please review before saving.');
}
async function clearChecked(){
  try{ await apiJSON('/api/shopping/clear-checked','POST'); render(); }catch(e){ apiError(e); }
}
function viewScanning(){
  const steps=['Reading the image','Finding ingredients and steps','Matching your substitutions library'];
  return `<div class="scanning">
    <div class="spinner"></div>
    <h1 class="title" style="font-size:20px;">Reading your recipe…</h1>
    <div class="scan-steps">${steps.map((s,i)=>
      `<div class="${i<state.scanStep?'done':''}">${i<state.scanStep?'✓':'○'} ${s}</div>`).join('')}</div>
    ${state.scanImage?`<img src="${state.scanImage}" style="max-width:230px;border-radius:12px;margin-top:22px;opacity:.6;">`:''}
  </div>`;
}
function startManualRecipe(){
  attemptNav(()=>{
    state.scanSource=null; state.scanImage=null;
    state.editing={id:null,title:'',categories:['Dinner'],tags:[],dateAdded:new Date().toISOString().slice(0,10),
      baseServings:4,emoji:'🍽️',ingredients:[{id:uid(),qty:1,qtyRaw:'1',unit:'',name:''}],instructions:[''],
      ratings:[],timesCooked:0,localSubs:[],images:[],notes:'',cookbookId:null,cookbookPage:''};
    state.view='editRecipe'; render();
  });
}
function startEditRecipe(id){
  attemptNav(()=>{
    state.scanSource=null; state.scanImage=null;
    state.editing=JSON.parse(JSON.stringify(recipes.find(x=>x.id===id)));
    state.view='editRecipe'; render();
  });
}
function viewEditRecipe(){
  const e=state.editing, isNew=!e.id;
  return `
    <button class="back" onclick="cancelEdit()">← Cancel</button>
    <h1 class="title">${state.scanSource?'Review Scanned Recipe':(isNew?'Add New Recipe':'Edit Recipe')}</h1>
    ${state.scanSource?`
      <div class="scan-panel">
        <img src="${state.scanSource.image}" alt="Scanned source">
        <div>
          <h4>📷 Read from your photo — please check it over</h4>
          <p>Everything below was pulled off the image and is fully editable. Highlighted lines are ones it was
          less sure about — quantities and fractions are the usual culprits. Nothing is saved until you hit Save Recipe,
          and the original photo gets attached to the recipe for reference.</p>
          ${state.scanSource.notes?`<p style="margin-top:8px;"><b>Note from the scan:</b> ${esc(state.scanSource.notes)}</p>`:''}
        </div>
      </div>`:
      `<div class="notice">Mockup form — in the real app this saves permanently. On save, ingredients are auto-scanned against your substitutions library.</div>`}
    <div class="form-row"><label>Title</label><input type="text" id="f_title" value="${escA(e.title)}"></div>
    <div class="form-row">
      <label>Categories (pick any number)</label>
      <div class="cat-picker">
        ${allCategories.map((c,i)=>`<span class="cat-chip ${e.categories.includes(c)?'on':''}" onclick="toggleCat(${i})">${e.categories.includes(c)?'✓':'+'} ${esc(c)}</span>`).join('')}
      </div>
      <div style="display:flex;gap:8px;max-width:420px;">
        <input type="text" id="f_newcat" placeholder="Create a new category..." style="flex:1;padding:9px 12px;border-radius:9px;border:1px solid var(--line);font-size:14px;">
        <button class="icon-btn" onclick="addCategory()">+ Add</button>
      </div>
    </div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;">
      <div class="form-row" style="flex:1;min-width:130px;"><label>Base Servings</label><input type="text" id="f_servings" value="${e.baseServings}"></div>
      <div class="form-row" style="flex:1;min-width:130px;"><label>Emoji</label><input type="text" id="f_emoji" value="${escA(e.emoji)}"></div>
      <div class="form-row" style="flex:2;min-width:200px;"><label>Tags (comma separated)</label><input type="text" id="f_tags" value="${escA(e.tags.join(', '))}"></div>
    </div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;">
      <div class="form-row" style="flex:2;min-width:240px;">
        <label>From a cookbook?</label>
        <select id="f_cookbook" onchange="stashEditForm()">
          <option value="">— Not from a cookbook —</option>
          ${cookbooks.map(b=>`<option value="${b.id}" ${e.cookbookId===b.id?'selected':''}>${esc(b.title)}${b.author?` — ${esc(b.author)}`:''}</option>`).join('')}
        </select>
        ${cookbooks.length?'':`<div class="subtle" style="font-size:12px;margin-top:6px;">
          No cookbooks yet — add one in the Cookbooks section and it will appear here.</div>`}
      </div>
      <div class="form-row" style="flex:1;min-width:120px;">
        <label>Page</label>
        <input type="text" id="f_cookbook_page" value="${escA(e.cookbookPage||'')}" placeholder="e.g. 142">
      </div>
    </div>

    <div class="form-row">
      <label>Notes</label>
      <textarea id="f_notes" rows="4" placeholder="Anything worth remembering — tweaks you made, what to serve it with, who liked it..."
        style="width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--line);font-size:14px;font-family:inherit;">${esc(e.notes||'')}</textarea>
    </div>

    <div class="form-row"><label>Ingredients</label>
      <div class="subtle" style="margin:-2px 0 8px;font-size:12px;">Quantities accept fractions — <code>1/2</code>, <code>1 1/2</code>, <code>¾</code>, or decimals.</div>
      ${e.ingredients.map((i,idx)=>{
        const flag=state.scanSource&&state.scanSource.flagged.includes(idx);
        return `<div class="ing-row-edit ${flag?'needs-review':''}">
        <input type="text" placeholder="qty" value="${escA(i.qtyRaw!=null?i.qtyRaw:fmtQty(i.qty))}" oninput="editIngField(${idx},'qty',this.value)" style="max-width:76px;">
        <input type="text" placeholder="unit" value="${escA(i.unit)}" oninput="editIngField(${idx},'unit',this.value)" style="max-width:90px;">
        <input type="text" placeholder="ingredient name" value="${escA(i.name)}" oninput="editIngField(${idx},'name',this.value)">
        ${flag?`<span class="review-flag">check</span>`:''}
        <button class="small-x" onclick="removeIng(${idx})">×</button></div>`;}).join('')}
      <button class="dashed-add" onclick="addIngRow()">+ Add ingredient</button></div>
    <div class="form-row"><label>Instructions</label>
      ${e.instructions.map((s,idx)=>`<div class="step-row-edit">
        <textarea oninput="editStep(${idx},this.value)">${esc(s)}</textarea>
        <button class="small-x" onclick="removeStep(${idx})">×</button></div>`).join('')}
      <button class="dashed-add" onclick="addStepRow()">+ Add step</button></div>
    <button class="icon-btn primary" onclick="saveEdit()">💾 Save Recipe</button>`;
}
function stashEditForm(){
  const e=state.editing;
  const g=id=>document.getElementById(id);
  if(g('f_title')) e.title=g('f_title').value;
  if(g('f_servings')) e.baseServings=parseFloat(g('f_servings').value)||1;
  if(g('f_emoji')) e.emoji=g('f_emoji').value||'🍽️';
  if(g('f_tags')) e.tags=g('f_tags').value.split(',').map(t=>t.trim()).filter(Boolean).map(titleCase);
  if(g('f_notes')) e.notes=g('f_notes').value;
  if(g('f_cookbook')) e.cookbookId=g('f_cookbook').value||null;
  if(g('f_cookbook_page')) e.cookbookPage=g('f_cookbook_page').value.trim();
}
function toggleCat(i){
  stashEditForm();
  const c=allCategories[i], e=state.editing;
  e.categories = e.categories.includes(c) ? e.categories.filter(x=>x!==c) : [...e.categories,c];
  renderMain();
}
function addCategory(){
  const el=document.getElementById('f_newcat'); const v=titleCase(el.value);
  if(!v) return;
  stashEditForm();
  if(!allCategories.some(c=>c.toLowerCase()===v.toLowerCase())) allCategories.push(v);
  const match=allCategories.find(c=>c.toLowerCase()===v.toLowerCase());
  if(!state.editing.categories.includes(match)) state.editing.categories.push(match);
  renderMain(); toast(`Category "${match}" created.`);
}
function cancelEdit(){ state.editing=null; state.scanSource=null; state.scanImage=null; state.view='browse'; render(); }
function editIngField(idx,f,v){
  const ing=state.editing.ingredients[idx];
  if(f==='qty'){ ing.qtyRaw=v; ing.qty=parseQty(v); }   // keeps "1/2" as typed AND stores 0.5 for math
  else ing[f]=v;
}
function addIngRow(){ stashEditForm(); state.editing.ingredients.push({id:uid(),qty:1,qtyRaw:'1',unit:'',name:''}); renderMain(); }
function removeIng(idx){ stashEditForm(); state.editing.ingredients.splice(idx,1); renderMain(); }
function editStep(idx,v){ state.editing.instructions[idx]=v; }
function addStepRow(){ stashEditForm(); state.editing.instructions.push(''); renderMain(); }
function removeStep(idx){ stashEditForm(); state.editing.instructions.splice(idx,1); renderMain(); }
async function saveEdit(){
  stashEditForm();
  const e=state.editing;
  if(!e.title.trim()) e.title='Untitled Recipe';
  if(!e.categories.length) e.categories=['Dinner'];
  const payload={
    title:e.title.trim(),
    emoji:e.emoji||'🍽️',
    baseServings:e.baseServings,
    dateAdded:e.dateAdded,
    categories:[...new Set(e.categories.map(titleCase))],
    tags:[...new Set((e.tags||[]).map(titleCase))].filter(Boolean),
    notes:e.notes||'',
    cookbookId:e.cookbookId||null,
    cookbookPage:e.cookbookPage||'',
    ingredients:e.ingredients.filter(i=>String(i.name||'').trim())
      .map(i=>({qtyRaw:i.qtyRaw!=null?String(i.qtyRaw):String(i.qty||''), unit:i.unit||'', name:i.name})),
    instructions:e.instructions.filter(s=>String(s||'').trim()),
  };
  const scan=state.scanSource;
  try{
    const res = e.id ? await apiJSON('/api/recipes/'+e.id,'PUT',payload)
                     : await apiJSON('/api/recipes','POST',payload);
    const id = e.id || res.id;
    // keep the scanned page with the recipe so you can always check the source
    if(scan && scan.image) await uploadPhotoDataUrl(id, scan.image, 'Original scan');
    state.editing=null; state.scanSource=null; state.scanImage=null;
    const saved=recipes.find(r=>r.id===id);
    const found=saved?subsForRecipe(saved).length:0;
    openRecipe(id);
    toast(found?`Saved — auto-found ${found} substitution${found!==1?'s':''} for these ingredients.`:'Recipe saved.');
  }catch(err){ apiError(err); }
}

/* ============ SUBSTITUTIONS LIBRARY ============ */
function viewSubstitutions(){
  const q=state.subSearch.trim().toLowerCase();
  const list=globalSubs.filter(s=>!q || s.ingredient.toLowerCase().includes(q) || s.substitute.toLowerCase().includes(q) || (s.notes||'').toLowerCase().includes(q));
  return `
    <h1 class="title">Substitutions Library</h1>
    <p class="subtle">Entries here are auto-matched to any recipe using that ingredient — no manual linking needed.</p>
    <div class="controls">
      <div class="search-wrap"><span class="sicon">🔍</span>
        <input id="subSearch" type="text" placeholder="Search substitutions by ingredient, substitute, or note..." value="${escA(state.subSearch)}" oninput="onSubSearch(this)"></div>
      <span class="subtle" style="margin:0;">${list.length} of ${globalSubs.length}</span>
    </div>
    <div class="panel" style="max-width:660px;margin-bottom:22px;">
      <div class="form-row"><label>Ingredient</label><input type="text" id="sub_ing" placeholder="e.g. buttermilk"></div>
      <div class="form-row"><label>Substitute</label><input type="text" id="sub_replace" placeholder="e.g. milk + lemon juice"></div>
      <div class="form-row" style="margin-bottom:8px;"><label>Notes (optional)</label><input type="text" id="sub_notes" placeholder="e.g. let sit 5 minutes"></div>
      <button class="icon-btn primary" onclick="addGlobalSub()">+ Add Substitution</button>
    </div>
    <div style="max-width:660px;">
      ${list.length===0?`<div class="empty">No substitutions match "${esc(state.subSearch)}".</div>`:
      list.map(s=>{
        const used=recipes.filter(r=>r.ingredients.some(i=>subMatches(s.ingredient,i.name))).length;
        return `<div class="sub-card">
          <div><b>${esc(s.ingredient)}</b> → ${esc(s.substitute)}
            ${s.notes?`<div class="note">${esc(s.notes)}</div>`:''}
            <div class="note">${used?`auto-applies to ${used} recipe${used!==1?'s':''}`:'not used in any current recipe'}</div></div>
          <button class="small-x" onclick="removeGlobalSub('${s.id}')">×</button></div>`;
      }).join('')}
    </div>`;
}
function onSubSearch(el){ focusId='subSearch'; focusPos=el.selectionStart; state.subSearch=el.value; renderMain(); }
function addGlobalSub(){
  const ing=titleCase(document.getElementById('sub_ing').value);
  const rep=document.getElementById('sub_replace').value.trim();
  const notes=document.getElementById('sub_notes').value.trim();
  if(!ing||!rep){ toast('Fill in both ingredient and substitute.'); return; }
  const similar=subsForName(ing);
  const doAdd=async()=>{
    try{ await apiJSON('/api/substitutions','POST',{ingredient:ing,substitute:rep,notes});
      render(); toast('Substitution added.'); }catch(e){ apiError(e); }
  };
  if(similar.length){
    showModal({
      title:'Similar substitution already exists',
      body:`Your library already has ${similar.length===1?'an entry':'entries'} for <b>${esc(normIng(ing))}</b>:<br><br>
        ${similar.map(s=>`<div class="sub-card" style="margin-bottom:8px;"><div><b>${esc(s.ingredient)}</b> → ${esc(s.substitute)}</div></div>`).join('')}
        <br>Add <b>${esc(rep)}</b> as an additional option, or replace the existing one?`,
      buttons:[
        {label:'Cancel'},
        {label:'Replace existing', action:async()=>{
          try{ await apiJSON('/api/substitutions/'+similar[0].id,'PUT',{ingredient:ing,substitute:rep,notes});
            render(); toast('Replaced existing entry.'); }catch(e){ apiError(e); }
        }},
        {label:'Add as another option', style:'primary', action:doAdd}
      ]
    });
  } else doAdd();
}
async function removeGlobalSub(id){
  try{ await apiJSON('/api/substitutions/'+id,'DELETE'); render(); toast('Substitution removed.'); }
  catch(e){ apiError(e); }
}

/* ============ SHOPPING LIST ============ */
async function addRecipeToShoppingList(recipeId){
  const r=recipes.find(x=>x.id===recipeId);
  const mult=state.scale[r.id]||1;
  const applied=state.appliedSubs[r.id]||{};
  const items=r.ingredients.map(i=>({
    name: applied[i.id] ? applied[i.id].substitute : i.name,
    qty: i.qty*mult, unit:i.unit, fromRecipe:r.title,
  }));
  try{
    await apiJSON('/api/shopping','POST',{items});
    state.view='shopping'; render();
    toast(`Added ${items.length} ingredients to your list.`);
  }catch(e){ apiError(e); }
}
async function addSingleIngredient(recipeId,ingId){
  const r=recipes.find(x=>x.id===recipeId);
  const i=r.ingredients.find(x=>x.id===ingId);
  const mult=state.scale[r.id]||1;
  const applied=state.appliedSubs[r.id]||{};
  const name=applied[ingId]?applied[ingId].substitute:i.name;
  try{
    await apiJSON('/api/shopping','POST',{name,qty:i.qty*mult,unit:i.unit,fromRecipe:r.title});
    render(); toast(`"${name}" added to shopping list.`);
  }catch(e){ apiError(e); }
}
async function toggleShopItem(id){
  const it=shoppingList.find(s=>s.id===id);
  it.checked=!it.checked; renderMain();            // optimistic: checkboxes must feel instant
  try{ await apiJSON('/api/shopping/'+id,'PATCH',{checked:it.checked}); render(); }
  catch(e){ it.checked=!it.checked; render(); apiError(e); }
}
async function removeShopItem(id){
  try{ await apiJSON('/api/shopping/'+id,'DELETE'); render(); }catch(e){ apiError(e); }
}
function toggleShopSubs(id){ state.expandedShopSubs[id]=!state.expandedShopSubs[id]; renderMain(); }
async function swapShopItem(id,subId){
  const s=globalSubs.find(x=>x.id===subId);
  try{
    await apiJSON('/api/shopping/'+id,'PATCH',{name:s.substitute});
    render(); toast(`Swapped to "${s.substitute}" on your list.`);
  }catch(e){ apiError(e); }
}
async function addManualShopItem(){
  const el=document.getElementById('manualItem'); const v=titleCase(el.value);
  if(!v) return;
  try{
    await apiJSON('/api/shopping','POST',{name:v,qty:1,fromRecipe:'manual'});
    render(); toast('Item added.');
  }catch(e){ apiError(e); }
}
function viewShopping(){
  return `
    <h1 class="title">Shopping List</h1>
    <p class="subtle">Ingredients pulled from recipes, plus anything you add by hand. Each item shows substitutions from your library.</p>
    <div class="controls no-print">
      <div class="search-wrap" style="flex:2;"><input id="manualItem" type="text" placeholder="Add an item manually, e.g. paper towels" style="padding-left:14px;"></div>
      <button class="icon-btn primary" onclick="addManualShopItem()">+ Add</button>
      <button class="icon-btn" onclick="window.print()">🖨️ Print list</button>
      <button class="icon-btn" onclick="clearChecked()">Clear checked</button>
    </div>
    ${shoppingList.length===0?`<div class="empty">Your list is empty. Open a recipe and click "Add to list."</div>`:
    shoppingList.map(it=>{
      const subs=subsForName(it.origName||it.name);
      const open=state.expandedShopSubs[it.id];
      return `<div class="shop-item ${it.checked?'checked':''}">
        <div class="shop-row">
          <input type="checkbox" ${it.checked?'checked':''} onchange="toggleShopItem('${it.id}')">
          <div>
            <div class="sname">${fmtQty(it.qty)} ${esc(it.unit)} ${esc(it.name)}</div>
            <div class="sfrom">${it.fromRecipe==='manual'?'added manually':'from '+esc(it.fromRecipe)}${it.origName?` · swapped from ${esc(it.origName)}`:''}</div>
          </div>
          <div class="store-links no-print">
            <a class="store-link" target="_blank" href="${storeLink('amazon',it.name)}">Amazon</a>
            <a class="store-link" target="_blank" href="${storeLink('target',it.name)}">Target</a>
            <a class="store-link" target="_blank" href="${storeLink('walmart',it.name)}">Walmart</a>
          </div>
          <button class="rm-btn no-print" onclick="removeShopItem('${it.id}')">×</button>
        </div>
        ${subs.length?`<button class="sub-toggle no-print" onclick="toggleShopSubs('${it.id}')">${open?'▾':'▸'} ${subs.length} substitution${subs.length!==1?'s':''} available</button>`:''}
        ${subs.length&&open?`<div class="shop-subs">${subs.map(s=>`
          <div class="srow"><div>→ <b>${esc(s.substitute)}</b>${s.notes?`<div class="note" style="font-size:11.5px;color:var(--ink-soft);">${esc(s.notes)}</div>`:''}</div>
          <button class="icon-btn sm no-print" onclick="swapShopItem('${it.id}','${s.id}')">Buy this instead</button></div>`).join('')}</div>`:''}
      </div>`;
    }).join('')}`;
}

/* ============ BOOT ============ */
async function boot(){
  render();
  try{
    const [state0, me] = await Promise.all([
      api('/api/bootstrap'),
      api('/api/whoami', {}, true).catch(()=>({})),
    ]);
    applyState(state0);
    scanEnabled = !!(me && me.scanEnabled);
    userEmail = (me && me.email) || null;
    shuffleDiscover();
    render();
  }catch(e){
    document.getElementById('app').innerHTML =
      '<div class="boot-error"><h1>Could not load your recipes</h1>' +
      '<p>' + esc(e.message || String(e)) + '</p>' +
      '<button class="icon-btn primary" onclick="location.reload()">Try again</button></div>';
  }
}
boot();
