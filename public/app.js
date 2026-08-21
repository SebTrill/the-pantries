/* ============ STORE (loaded from the server) ============ */
const uid = () => Math.random().toString(36).slice(2,9);

/* ============ DATES ============
 * toISOString() is UTC. Used for calendar days it silently files an evening
 * meal under tomorrow — the cook happened at 7pm here, midnight there. Every
 * day-key in the app is built from the local clock instead, and the cook log
 * sends this same string to the server so both ends agree.
 */
const pad2 = n => String(n).padStart(2,'0');
function localDay(d){
  const x = d ? new Date(d) : new Date();
  return x.getFullYear()+'-'+pad2(x.getMonth()+1)+'-'+pad2(x.getDate());
}
function localMonth(d){
  const x = d ? new Date(d) : new Date();
  return x.getFullYear()+'-'+pad2(x.getMonth()+1);
}

let recipes = [];
let cookbooks = [];
let activity = [];
let globalSubs = [];
let allCategories = [];
let shoppingList = [];
let emojiPalette = { recipe:[], cookbook:[] };
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
  if (st.activity) activity = st.activity;
  if (st.globalSubs) globalSubs = st.globalSubs;
  if (st.allCategories) allCategories = st.allCategories;
  if (st.shoppingList) shoppingList = st.shoppingList;
  if (st.emojiPalette) emojiPalette = st.emojiPalette;
  lastSig = storeSig();
}

/* ============ BACKGROUND REFRESH ============
 * Navigating inside the app renders from memory, so a tab left open goes stale
 * when you cook something on another device. Returning to the tab re-checks the
 * server and redraws only if something actually changed.
 */
let lastSig = '';
let lastFetchAt = 0;
let lastDay = localDay();
const REFRESH_MIN_GAP = 15000;

const sigOf = st => JSON.stringify(
  [st.recipes, st.cookbooks, st.globalSubs, st.allCategories, st.shoppingList, st.activity]);
const storeSig = () => sigOf({recipes, cookbooks, globalSubs, allCategories, shoppingList, activity});

/** Refusing to refresh matters more than refreshing: a redraw mid-edit would
 *  throw away whatever is being typed. */
function safeToRefresh(){
  if (['editRecipe','editCookbook','scanning'].includes(state.view)) return false;
  if (modalCfg || focalDraft || pasteDraft || state.notesDraft) return false;
  if (busyDepth > 0) return false;
  return true;
}

async function backgroundRefresh(force){
  if (!safeToRefresh()) return;
  if (!force && Date.now() - lastFetchAt < REFRESH_MIN_GAP) return;
  lastFetchAt = Date.now();
  let st;
  try {
    st = await api('/api/bootstrap', {}, true);   // quiet: no spinner for a check nobody asked for
  } catch (e) {
    return;                                       // offline or a blip: keep showing what we have
  }
  const today = localDay();
  const rolledOver = today !== lastDay;           // left open past midnight
  if (sigOf(st) === lastSig && !rolledOver) return;
  lastDay = today;
  const y = window.scrollY;
  applyState(st);
  render();
  window.scrollTo(0, y);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) backgroundRefresh(); });
window.addEventListener('focus', () => backgroundRefresh());
window.addEventListener('online', () => backgroundRefresh(true));
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
  bookSearch:'', bookRecipeSearch:'', detailTab:'ingredients', activityRange:'6m',
  pantry:[], tonightId:null,
  searchQuery:'', categoryFilter:'all', sortBy:'newest',
  subSearch:'', scale:{}, editing:null, starDraft:0,
  appliedSubs:{},        // recipeId -> { ingredientId: {ingredientName, substitute, notes} }
  expandedShopSubs:{},   // shoppingItemId -> bool
  showRecipeSubForm:false,
  collapsed:{},          // home sections folded away — deliberately memory-only
  mentionChoices:{},     // per-mention "swap this word or not", also memory-only
  subScope:'all',        // library page filter: all / library / recipe-only / unused
  expandedSubGroups:{},  // which ingredient groups have their recipe list open
  showSubAddForm:false,
  emojiOpen:null,        // which emoji palette has its "more" panel open
  bookFilter:'all',      // browse: all | any | none | <cookbookId>
  quickFilters:[],       // browse: never / unrated / nophoto / quick
  browseView:'grid',     // grid | list
  bookSort:'recipes',
  recipeSubSearch:'',    // filter inside a recipe's substitutions tab
  notesDraft:null,       // {id,text} while notes are being edited in place
  showRateForm:false,
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
    const ctx=c.getContext('2d'); ctx.fillStyle='#181209'; ctx.fillRect(0,0,w,h);
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
  // the book a recipe came from is part of how you remember it
  const b = r.cookbookId ? bookById(r.cookbookId) : null;
  if(b){
    if(b.title.toLowerCase().includes(q)) s+=6;
    if(b.title.toLowerCase().startsWith(q)) s+=3;
    if((b.author||'').toLowerCase().includes(q)) s+=4;
  }
  return s;
}
function filteredSorted(){
  const q = state.searchQuery.trim().toLowerCase();
  let list = recipes.filter(r=>{
    if(state.categoryFilter!=='all' && !r.categories.includes(state.categoryFilter)) return false;
    if(state.bookFilter==='any'  && !r.cookbookId) return false;
    if(state.bookFilter==='none' && r.cookbookId) return false;
    if(!['all','any','none'].includes(state.bookFilter) && r.cookbookId!==state.bookFilter) return false;
    for(const key of state.quickFilters){
      const qf=QUICK_FILTERS.find(x=>x.key===key);
      if(qf && !qf.test(r)) return false;
    }
    return !q || relevanceScore(r,q)>0;
  });
  let sortBy = state.sortBy;
  if(!q && sortBy==='relevant') sortBy='newest';
  // an untimed or never-cooked recipe sorts last rather than first, so a blank
  // doesn't masquerade as "quickest" or "most recent"
  const timeOf = r => totalMinutes(r) || Infinity;
  const lastOf = r => r.lastCookedAt || 0;
  const cmp = {
    newest:(a,b)=>new Date(b.dateAdded)-new Date(a.dateAdded),
    oldest:(a,b)=>new Date(a.dateAdded)-new Date(b.dateAdded),
    az:(a,b)=>a.title.localeCompare(b.title),
    za:(a,b)=>b.title.localeCompare(a.title),
    relevant:(a,b)=>relevanceScore(b,q)-relevanceScore(a,q),
    mostUsed:(a,b)=>b.timesCooked-a.timesCooked || a.title.localeCompare(b.title),
    topRated:(a,b)=>avgRating(b)-avgRating(a) || b.ratings.length-a.ratings.length,
    lastCooked:(a,b)=>lastOf(b)-lastOf(a) || a.title.localeCompare(b.title),
    time:(a,b)=>timeOf(a)-timeOf(b) || a.title.localeCompare(b.title),
  }[sortBy] || ((a,b)=>new Date(b.dateAdded)-new Date(a.dateAdded));
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

/* ============ ROUTING ============
 * Every view is a real page: /home, /browse-recipes, /recipe?id=…, and so on.
 * Back, forward, refresh and bookmarks all behave the way they look like they
 * should, and a link to a recipe is a link to that recipe.
 *
 * The URL is derived from state, never the reverse. render() calls syncUrl()
 * at the end, so the address bar follows automatically wherever the app goes
 * without every navigation having to remember to update it.
 */
let routeReady = false;      // stays false until the first load has data to route with

function urlForState(){
  const q = id => '?id=' + encodeURIComponent(id);
  switch(state.view){
    case 'home':           return '/home';
    case 'browse':         return '/browse-recipes';
    case 'detail':         return state.currentRecipeId ? '/recipe'+q(state.currentRecipeId) : '/browse-recipes';
    case 'editRecipe':     return (state.editing && state.editing.id)
                                  ? '/recipe/edit'+q(state.editing.id) : '/add-recipe';
    case 'scanning':       return '/add-recipe';
    case 'cookbooks':      return '/browse-cookbooks';
    case 'cookbookDetail': return state.currentBookId ? '/cookbook'+q(state.currentBookId) : '/browse-cookbooks';
    case 'editCookbook':   return (state.editingBook && state.editingBook.id)
                                  ? '/cookbook/edit'+q(state.editingBook.id) : '/cookbook/edit';
    case 'shopping':       return '/shopping-list';
    case 'substitutions':  return '/substitutions';
    default:               return '/home';
  }
}
function syncUrl(replace){
  if(!routeReady) return;
  const next = urlForState();
  if(next === location.pathname + location.search) return;
  try{ history[replace?'replaceState':'pushState']({v:state.view}, '', next); }catch(e){}
}
const blankRecipeDraft = () => ({
  id:null,title:'',categories:['Dinner'],tags:[],dateAdded:localDay(),
  baseServings:4,emoji:'🍽️',ingredients:[{id:uid(),qty:1,qtyRaw:'1',unit:'',name:''}],
  instructions:[''],ratings:[],timesCooked:0,localSubs:[],images:[],
  notes:'',cookbookId:null,cookbookPage:'',prepMinutes:0,cookMinutes:0,
});
const blankBookDraft = () => ({
  id:null,title:'',author:'',publisher:'',published:'',edition:'',isbn:'',notes:'',emoji:'📕',
});
/** Read the address bar into view state. Anything unrecognised lands on Home. */
function applyUrl(){
  const path = location.pathname.replace(/\/+$/,'') || '/';
  const id = new URLSearchParams(location.search).get('id');
  state.showRecipeSubForm = false;

  if(path === '/recipe' && id){
    state.view='detail'; state.currentRecipeId=id; state.detailTab='instructions';
    state.recipeSubSearch=''; state.showRateForm=false; state.notesDraft=null;
    if(!state.scale[id]) state.scale[id]=1;
    return;
  }
  if(path === '/recipe/edit'){
    const r = id && recipes.find(x=>x.id===id);
    if(r){ state.editing=JSON.parse(JSON.stringify(r)); state.scanSource=null; state.scanImage=null;
           state.view='editRecipe'; markEditBaseline(); return; }
    state.view='browse'; return;                       // stale link to a deleted recipe
  }
  if(path === '/add-recipe'){
    // arriving here directly means you already chose to type one in
    if(!state.editing || state.editing.id) state.editing = blankRecipeDraft();
    state.scanSource=null; state.scanImage=null; state.view='editRecipe'; markEditBaseline(); return;
  }
  if(path === '/cookbook' && id){ state.view='cookbookDetail'; state.currentBookId=id; return; }
  if(path === '/cookbook/edit'){
    const b = id && cookbooks.find(x=>x.id===id);
    state.editingBook = b ? JSON.parse(JSON.stringify(b)) : blankBookDraft();
    state.view='editCookbook'; markEditBaseline(); return;
  }
  const simple = {
    '/':'home', '/home':'home', '/index.html':'home',
    '/browse-recipes':'browse', '/recipe':'browse',
    '/browse-cookbooks':'cookbooks', '/cookbook':'cookbooks',
    '/shopping-list':'shopping', '/substitutions':'substitutions',
  };
  state.view = simple[path] || 'home';
}
/* Back/forward can't pop a confirmation dialog without fighting the history
   stack, so temporary substitutions are simply reverted and called out. */
window.addEventListener('popstate', ()=>{
  // the address has already changed by now, so staying means pushing it back
  if(inEditForm() && isEditDirty()){
    const stayUrl = urlForState();
    guardEdit(()=>{ applyUrl(); render(); },
              ()=>{ try{ history.pushState({}, '', stayUrl); }catch(e){} });
    return;
  }
  const rid = state.currentRecipeId;
  const hadSubs = state.view==='detail' && rid && appliedCount(rid)>0;
  if(hadSubs) delete state.appliedSubs[rid];
  applyUrl();
  render();
  if(hadSubs) toast('Temporary substitutions reverted.');
});

/* ============ NAV (with unsaved-substitution guard) ============ */
function appliedCount(recipeId){ return Object.keys(state.appliedSubs[recipeId]||{}).length; }
function attemptNav(fn){
  if(inEditForm()){ guardEdit(fn); return; }      // unsaved recipe or cookbook draft
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
function goto(view){ attemptNav(()=>{ state.view=view; state.detailTab='instructions'; state.showRecipeSubForm=false; render(); }); }
function openRecipe(id){
  // must test dirtiness, not merely "am I in a form" — otherwise the retry
  // lands right back here and recurses forever
  if(inEditForm() && isEditDirty()){
    guardEdit(()=>{ clearEditDraft(); openRecipe(id); });
    return;
  }
  state.view='detail'; state.currentRecipeId=id; state.detailTab='instructions';
  state.showRecipeSubForm=false; state.starDraft=0; state.recipeSubSearch='';
  state.showRateForm=false; state.notesDraft=null;
  if(!state.scale[id]) state.scale[id]=1;
  render();
}

/* ============ RENDER SHELL ============ */
function render(){
  document.getElementById('app').innerHTML=`
    <div class="topbar no-print">
      <div class="brand" style="cursor:pointer;" onclick="goto('home')">🍲 The <span>Pantries</span></div>
      <nav class="topbar-nav">
        <button class="navbtn ${state.view==='home'?'active':''}" onclick="goto('home')">
          <span class="ic">🏠</span> Home</button>
        <button class="navbtn ${['browse','detail','editRecipe'].includes(state.view)?'active':''}" onclick="goto('browse')">
          <span class="ic">📖</span> Recipes<span class="count">${recipes.length}</span></button>
        <button class="navbtn ${['cookbooks','cookbookDetail','editCookbook'].includes(state.view)?'active':''}" onclick="goto('cookbooks')">
          <span class="ic">📚</span> Cookbooks${cookbooks.length?`<span class="count">${cookbooks.length}</span>`:''}</button>
        <button class="navbtn ${state.view==='substitutions'?'active':''}" onclick="goto('substitutions')">
          <span class="ic">🔁</span> Substitutions<span class="count">${globalSubs.length}</span></button>
        <button class="navbtn ${state.view==='shopping'?'active':''}" onclick="goto('shopping')">
          <span class="ic">🛒</span> Shopping List${shoppingList.length?`<span class="count">${shoppingList.filter(i=>!i.checked).length}</span>`:''}</button>
      </nav>
      <div class="topbar-right">
        <button class="navbtn iconly" title="Download a backup of everything" onclick="downloadBackup()">
          <span class="ic">⬇</span></button>
        <button class="addbtn" onclick="startAddRecipe()">+ Add Recipe</button>
      </div>
    </div>
    <div class="main" id="main"></div>
    <div class="app-foot no-print">
      ${userEmail?`Signed in as ${esc(userEmail)} · `:''}The Pantries ·
      <a href="#" onclick="event.preventDefault();downloadBackup();" style="color:var(--ochre);">Download backup</a>
    </div>`;
  renderMain();
  syncUrl();
}
function renderMain(){
  const m=document.getElementById('main');
  m.innerHTML = ({home:viewHome,browse:viewBrowse,detail:viewDetail,substitutions:viewSubstitutions,
    shopping:viewShopping,editRecipe:viewEditRecipe,scanning:viewScanning,
    cookbooks:viewCookbooks,cookbookDetail:viewCookbookDetail,editCookbook:viewEditCookbook}[state.view])();
  if(focusId){ const el=document.getElementById(focusId); if(el){ el.focus(); try{el.setSelectionRange(focusPos,focusPos);}catch(e){} } }
}

/* ============ HOME ============ */
/* ---------- collapsible sections ----------
 * Folding a section away is a decluttering move for the session you're in, not
 * a preference. It lives in memory only — no storage, no cookie — so opening
 * the site again always starts with everything visible.
 */
function toggleSection(key){ state.collapsed[key]=!state.collapsed[key]; renderMain(); }
function isCollapsed(key){ return !!state.collapsed[key]; }
/** A section header that folds its own body away. `extra` is hidden while
 *  collapsed, since controls for something you can't see are just noise. */
function secHead(key, title, extra){
  const off=isCollapsed(key);
  return `<div class="sec-head${off?' folded':''}">
    <h2 class="foldable" onclick="toggleSection('${key}')" role="button" tabindex="0"
      aria-expanded="${!off}" title="${off?'Show this section':'Hide this section'}"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleSection('${key}');}"
      ><span class="caret">${off?'▸':'▾'}</span>${title}</h2>
    ${off?'':(extra||'')}</div>`;
}
function sideHead(key, title, sub){
  const off=isCollapsed(key);
  return `<h3 class="foldable" onclick="toggleSection('${key}')" role="button" tabindex="0"
      aria-expanded="${!off}" title="${off?'Show this section':'Hide this section'}"
      onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleSection('${key}');}"
      ><span class="caret">${off?'▸':'▾'}</span>${title}</h3>
    ${off?'':`<div class="side-sub">${sub}</div>`}`;
}

function mostCooked(n=3){
  return recipes.slice().sort((a,b)=>b.timesCooked-a.timesCooked || avgRating(b)-avgRating(a)).slice(0,n);
}
function topRanked(n=10){
  return recipes.slice().sort((a,b)=>
    (avgRating(b)-avgRating(a)) || (b.timesCooked-a.timesCooked) || a.title.localeCompare(b.title)
  ).slice(0,n);
}
function recentActivity(n=6){
  const feed=[];
  recipes.forEach(r=>(r.ratings||[]).forEach(c=>feed.push({r,c})));
  return feed.sort((a,b)=>(b.c.ts||Date.parse(b.c.date)||0)-(a.c.ts||Date.parse(a.c.date)||0)).slice(0,n);
}
function runHomeSearch(){
  const el=document.getElementById('homeSearch');
  const v=el?el.value.trim():'';
  clearBrowseFilters();
  state.searchQuery=v;
  state.sortBy=v?'relevant':'newest';
  goto('browse');
}
/* ---------- home page stats ---------- */
function totalCooked(){ return recipes.reduce((a,r)=>a+(r.timesCooked||0),0); }
function ratedRecipes(){ return recipes.filter(r=>r.ratings.length); }
function overallAvg(){
  const rated = ratedRecipes();
  if(!rated.length) return 0;
  return rated.reduce((a,r)=>a+avgRating(r),0)/rated.length;
}
function monthKey(d){ return String(d).slice(0,7); }
function lastSixMonthKeys(){
  const out=[], now=new Date();
  for(let i=5;i>=0;i--){
    const d=new Date(now.getFullYear(), now.getMonth()-i, 1);
    out.push(localMonth(d));
  }
  return out;
}
function cooksInLastDays(n){
  const cutoff = localDay(Date.now()-n*86400000);
  return (activity||[]).filter(a=>a.day>=cutoff).reduce((t,a)=>t+a.n,0);
}
function sparkBars(values){
  const max = Math.max(1, ...values);
  return `<div class="k-spark">${values.map((v,i)=>
    `<i class="${i===values.length-1?'hi':''}" style="height:${Math.max(6, Math.round(v/max*100))}%"
       title="${v}"></i>`).join('')}</div>`;
}

function renderKpiRow(){
  const months = lastSixMonthKeys();
  const addedPerMonth = months.map(m=>recipes.filter(r=>monthKey(r.dateAdded)===m).length);
  const cooksPerMonth = months.map(m=>(activity||[]).filter(a=>monthKey(a.day)===m).reduce((t,a)=>t+a.n,0));
  const thisMonth = addedPerMonth[addedPerMonth.length-1];
  const never = recipes.filter(r=>!r.timesCooked).length;
  const avg = overallAvg();
  return `<div class="kpi-row">
    <div class="kpi"><div class="k-label">Recipes</div>
      <div class="k-value">${recipes.length}</div>
      <div class="k-sub">${thisMonth?`+${thisMonth} this month`:'none added this month'}</div>
      ${sparkBars(addedPerMonth)}</div>
    <div class="kpi"><div class="k-label">Meals cooked</div>
      <div class="k-value">${totalCooked()}</div>
      <div class="k-sub">${cooksInLastDays(30)} in the last 30 days</div>
      ${sparkBars(cooksPerMonth)}</div>
    <div class="kpi"><div class="k-label">Average rating</div>
      <div class="k-value">${avg?avg.toFixed(1):'—'}</div>
      <div class="k-sub">${ratedRecipes().length} rated recipe${ratedRecipes().length===1?'':'s'}</div></div>
    <div class="kpi ${never?'kpi-nudge':''} ${never?'kpi-link':''}"
      ${never?`onclick="browseNeverCooked()" title="See them"`:''}>
      <div class="k-label">Never cooked</div>
      <div class="k-value">${never}</div>
      <div class="k-sub">${never?'waiting for a first try →':'every recipe has been made'}</div></div>
  </div>`;
}

/* ---------- cook this tonight ---------- */
function tonightCandidates(){
  return recipes.filter(r=>r.instructions.length || r.ingredients.length);
}
function pickTonight(){
  const pool = tonightCandidates();
  if(!pool.length){ state.tonightId=null; return; }
  const score = r => {
    const rating = r.ratings.length ? avgRating(r) : 3.6;      // unrated gets a fair shake
    const staleness = r.lastCookedAt
      ? Math.min(1, (Date.now()-r.lastCookedAt)/(90*86400000))
      : 0.8;
    return rating*0.9 + staleness*2.2 + Math.random()*2.4;
  };
  const ranked = pool.map(r=>({r,k:score(r)})).sort((a,b)=>b.k-a.k);
  const next = ranked.find(x=>x.r.id!==state.tonightId) || ranked[0];
  state.tonightId = next.r.id;
}
function rerollTonight(){ pickTonight(); renderMain(); }
function tonightReason(r){
  const bits=[];
  if(r.ratings.length) bits.push(`Rated ★${avgRating(r).toFixed(1)}`);
  if(!r.timesCooked) bits.push("you've never made this one");
  else if(r.lastCookedAt){
    const days=Math.round((Date.now()-r.lastCookedAt)/86400000);
    bits.push(days<1?'cooked today':days===1?'cooked yesterday':`last cooked ${days} days ago`);
  } else bits.push(`cooked ${r.timesCooked} time${r.timesCooked===1?'':'s'}`);
  const b = r.cookbookId ? bookById(r.cookbookId) : null;
  if(b) bits.push(`from ${b.title}`);
  return bits.join(' · ');
}
function renderTonight(){
  let r = recipes.find(x=>x.id===state.tonightId);
  if(!r){ pickTonight(); r = recipes.find(x=>x.id===state.tonightId); }
  if(!r) return '';
  const cover = coverImage(r);
  return `
    ${secHead('tonight','🍽️ Cook this tonight',
      `<button class="link" onclick="rerollTonight()">🎲 Roll again</button>`)}
    ${isCollapsed('tonight')?'':`
    <div class="tonight">
      <div class="t-img" onclick="openRecipe('${r.id}')">${cover
        ? `<img src="${cover.url}" alt="${escA(r.title)}" style="${focalStyle(cover)}">`
        : r.emoji}</div>
      <div style="min-width:0;">
        <h3>${esc(r.title)}</h3>
        <div class="t-why">${esc(tonightReason(r))}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="icon-btn primary" onclick="openRecipe('${r.id}')">Open recipe</button>
          <button class="icon-btn" onclick="addRecipeToShoppingList('${r.id}')">🛒 Add ingredients</button>
        </div>
      </div>
    </div>`}`;
}

/* ---------- pantry matcher ---------- */
function addPantryItem(){
  const el=document.getElementById('pantryInput');
  const v=titleCase(el.value);
  if(!v) return;
  if(!state.pantry.includes(v)) state.pantry.push(v);
  el.value='';
  renderMain();
  const again=document.getElementById('pantryInput'); if(again) again.focus();
}
function removePantryItem(i){ state.pantry.splice(i,1); renderMain(); }
function pantryMatches(){
  if(!state.pantry.length) return [];
  const have = state.pantry.map(normIng);
  return recipes.map(r=>{
    const names = r.ingredients.map(i=>normIng(i.name));
    const usedYours = have.filter(h=>names.some(n=>n===h||n.includes(h)||h.includes(n))).length;
    const missing = names.filter(n=>!have.some(h=>n===h||n.includes(h)||h.includes(n))).length;
    return {r, usedYours, missing};
  }).filter(m=>m.usedYours>0)
    .sort((a,b)=> b.usedYours-a.usedYours || a.missing-b.missing)
    .slice(0,6);
}
function renderPantry(){
  const matches=pantryMatches();
  if(isCollapsed('pantry')) return secHead('pantry',"🥫 What's in your pantry");
  return `
    ${secHead('pantry',"🥫 What's in your pantry")}
    <div class="pantry-box">
      <div class="subtle" style="margin:0 0 10px;font-size:12.5px;">
        List what you have on hand and see what it gets you.</div>
      <div class="chiprow">
        ${state.pantry.map((p,i)=>`<span class="ichip">${esc(p)}
          <button class="x" onclick="removePantryItem(${i})" title="Remove">×</button></span>`).join('')}
      </div>
      <div style="display:flex;gap:8px;">
        <input type="text" id="pantryInput" placeholder="e.g. chicken, rice, butter"
          onkeydown="if(event.key==='Enter'){event.preventDefault();addPantryItem();}"
          style="flex:1;padding:9px 12px;border-radius:3px;border:1px solid var(--rule);font-size:14px;background:var(--panel);color:var(--cream);font-family:var(--body);">
        <button class="icon-btn" onclick="addPantryItem()">+ Add</button>
      </div>
      ${state.pantry.length===0
        ? `<div class="empty" style="padding:18px 0 4px;font-size:13px;">
            Add an ingredient or two to see what you could cook.</div>`
        : matches.length===0
          ? `<div class="empty" style="padding:18px 0 4px;font-size:13px;">
              Nothing in your collection uses ${state.pantry.length===1?'that':'those'} yet.</div>`
          : `<div style="margin-top:14px;">${matches.map(m=>`
              <div class="match" onclick="openRecipe('${m.r.id}')">
                <div class="m-ico">${m.r.emoji}</div>
                <div style="flex:1;min-width:0;">
                  <div class="m-name">${esc(m.r.title)}</div>
                  <div class="m-uses">uses ${m.usedYours} of your ${state.pantry.length}</div>
                </div>
                <span class="m-have ${m.missing===0?'m-full':'m-near'}">${
                  m.missing===0?'have it all':`needs ${m.missing} more`}</span>
              </div>`).join('')}</div>`}
    </div>`;
}

/* ---------- category magnitudes ---------- */
function renderCategoryChart(){
  const counts=new Map();
  recipes.forEach(r=>r.categories.forEach(c=>counts.set(c,(counts.get(c)||0)+1)));
  const rows=[...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,7);
  const max=Math.max(1,...rows.map(r=>r[1]));
  if(isCollapsed('categories')) return secHead('categories','📊 Recipes by category');
  return `
    ${secHead('categories','📊 Recipes by category')}
    <div class="panel">
      ${rows.length===0?`<div class="empty" style="padding:12px 0;font-size:13px;">No categories yet.</div>`
      :`<div class="barchart">${rows.map(([name,n])=>`
        <button class="barrow" onclick="browseCategory('${escA(name)}')" title="Browse ${escA(name)}">
          <span class="b-name">${esc(name)}</span>
          <span class="track"><span class="fill" style="width:${Math.round(n/max*100)}%"></span></span>
          <span class="num">${n}</span>
        </button>`).join('')}</div>
      <div class="subtle" style="margin:14px 0 0;font-size:12px;">Click a bar to browse that category.</div>`}
    </div>`;
}
function browseNeverCooked(){
  clearBrowseFilters();
  state.quickFilters=['never']; state.sortBy='az';
  goto('browse');
}
function browseCategory(name){
  clearBrowseFilters();
  state.categoryFilter=name; state.sortBy='mostUsed'; goto('browse');
}

/* ---------- activity calendar ---------- */
function activityByDay(){
  const m=new Map();
  (activity||[]).forEach(a=>m.set(a.day,a.n));
  return m;
}
function cookStreakWeeks(map){
  let streak=0;
  for(let w=0; w<52; w++){
    const end=new Date(); end.setDate(end.getDate()-w*7);
    let any=false;
    for(let d=0; d<7; d++){
      const day=new Date(end); day.setDate(day.getDate()-d);
      if(map.get(localDay(day))) { any=true; break; }
    }
    if(any) streak++; else break;
  }
  return streak;
}
const ACTIVITY_RANGES = [
  // cell = the size a square wants to be; it shrinks to fit when the range is
  // long, so short ranges get chunky readable squares instead of a stranded strip
  {key:'3m', label:'3M', weeks:14, name:'3 months', cell:44},
  {key:'6m', label:'6M', weeks:27, name:'6 months', cell:24},
  {key:'1y', label:'1Y', weeks:53, name:'year',     cell:13},
];
function setActivityRange(key){ state.activityRange=key; renderMain(); }

function renderActivity(){
  const map=activityByDay();
  const range = ACTIVITY_RANGES.find(r=>r.key===state.activityRange)
    || ACTIVITY_RANGES[ACTIVITY_RANGES.length-1];
  const WEEKS = range.weeks;
  const today=new Date();
  const end=new Date(today); end.setDate(end.getDate()+(6-end.getDay()));   // end of this week
  // Month labels crowd as columns get thinner, so demand more spacing at longer ranges.
  const minGap = WEEKS>40 ? 4 : WEEKS>20 ? 3 : 2;
  const showNums = range.cell >= 34;

  let cols='', monthRow='', lastMonth='', lastLabelCol=-9, inRange=0, daysWithCooking=0;
  for(let w=WEEKS-1, col=0; w>=0; w--, col++){
    const colStart=new Date(end); colStart.setDate(colStart.getDate()-w*7-6);
    const mon=colStart.toLocaleDateString(undefined,{month:'short'});
    // a wider gap wherever a new month begins, so month boundaries read at a glance
    const boundary = (mon!==lastMonth && col>0) ? ' month-start' : '';
    const label = (mon!==lastMonth && col-lastLabelCol>=minGap) ? mon : '';
    if(label) lastLabelCol=col;
    monthRow += `<span class="hm${boundary}">${label}</span>`;
    lastMonth=mon;

    let cells='';
    for(let d=0; d<7; d++){
      const day=new Date(colStart); day.setDate(day.getDate()+d);
      const key=localDay(day);
      const n=map.get(key)||0;
      const future=day>today;
      if(!future){ inRange+=n; if(n) daysWithCooking++; }
      const lvl=n===0?0:n===1?1:n===2?2:n<=3?3:4;
      const nice=day.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
      // once squares are big enough to read, the count goes inside them
      const inner = (showNums && n && !future) ? `<b class="hc-n${lvl>=3?' on-dark':''}">${n}</b>` : '';
      cells += `<div class="heat-cell${future?' future':''}" style="background:var(--seq-${lvl})"
        title="${nice} — ${n} meal${n===1?'':'s'}">${inner}</div>`;
    }
    cols += `<div class="heat-col${boundary}">${cells}</div>`;
  }
  const streak=cookStreakWeeks(map);
  const totalAll=[...map.values()].reduce((a,b)=>a+b,0);

  return `
    ${secHead('activity','📅 Cooking activity',
      `<div class="range-group no-print">
        ${ACTIVITY_RANGES.map(r=>`<button class="range-btn ${r.key===range.key?'on':''}"
          onclick="setActivityRange('${r.key}')">${r.label}</button>`).join('')}
      </div>`)}
    ${isCollapsed('activity')?'':`
    <div class="panel" style="margin-bottom:32px;">
      ${totalAll===0?`<div class="empty" style="padding:10px 0 18px;">
        Nothing logged yet. Every time you hit <b>I cooked this</b> or rate a recipe from now on,
        a square lights up here.</div>`
      :`<div class="heat-summary"><b>${inRange}</b> meal${inRange===1?'':'s'} over the past ${range.name}
         · cooked on <b>${daysWithCooking}</b> day${daysWithCooking===1?'':'s'}</div>`}
      <div class="heat-wrap" style="--cell:${range.cell}px">
        <div class="heat-days${range.cell>=20?'':' compact'}">${
          (range.cell>=20
            ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
            : ['S','M','T','W','T','F','S']
          ).map(d=>`<span>${d}</span>`).join('')}</div>
        <div class="heat-inner">
          <div class="heat-months">${monthRow}</div>
          <div class="heat">${cols}</div>
        </div>
      </div>
      <div class="heat-legend">
        <span>Less</span>
        ${[0,1,2,3,4].map(l=>`<span class="sw" style="background:var(--seq-${l})"></span>`).join('')}
        <span>More</span>
        ${streak>0?`<span class="streak">🔥 ${streak}-week streak</span>`:''}
      </div>
    </div>`}`;
}

/* ---------- cookbook shelf ---------- */
function renderShelf(){
  if(!cookbooks.length) return '';
  // cloth bindings, warm inks — deliberately darker than the page so the shelf reads as objects
  const tones=['linear-gradient(155deg,#8E3E23,#4A1F11)','linear-gradient(155deg,#5C6640,#2C3320)',
    'linear-gradient(155deg,#8A6524,#463314)','linear-gradient(155deg,#6B4430,#372117)',
    'linear-gradient(155deg,#4A3A55,#241C2B)'];
  if(isCollapsed('shelf')) return secHead('shelf','📚 Your shelf');
  return `
    ${secHead('shelf','📚 Your shelf',
      `<button class="link" onclick="goto('cookbooks')">All cookbooks →</button>`)}
    <div class="shelf">
      ${cookbooks.map((b,i)=>{
        const cover=bookCover(b), n=recipesInBook(b.id).length;
        return `<div class="spine" onclick="openCookbook('${b.id}')">
          <div class="cov" style="${cover?'':'background:'+tones[i%tones.length]+';'}">
            ${cover?`<img src="${cover.url}" alt="${escA(b.title)}" style="${focalStyle(cover)}">`:b.emoji}</div>
          <div class="nm">${esc(b.title)}</div>
          <div class="ct">${n} recipe${n===1?'':'s'}</div>
        </div>`;}).join('')}
    </div>`;
}

/* ---------- tidy-up prompts ---------- */
function tidyItems(){
  const out=[];
  for(const r of recipes){
    if(!r.instructions.length) out.push({r,tag:'no steps',act:'Finish it',fn:`startEditRecipe('${r.id}')`});
    else if(!(r.images||[]).length) out.push({r,tag:'no photo',act:'Add one',fn:`openRecipe('${r.id}')`});
    else if(!r.ratings.length) out.push({r,tag:'never rated',act:'Rate it',fn:`openRecipe('${r.id}')`});
    else if(cookbooks.length && !r.cookbookId) out.push({r,tag:'no source',act:'Link a book',fn:`startEditRecipe('${r.id}')`});
  }
  return out.slice(0,5);
}
function renderTidy(){
  const items=tidyItems();
  if(!items.length) return '';
  if(isCollapsed('tidy')) return secHead('tidy','✨ Needs a little love');
  return `
    ${secHead('tidy','✨ Needs a little love',
      `<span class="subtle" style="margin:0;">tidy-up suggestions</span>`)}
    <div class="panel" style="margin-bottom:32px;">
      ${items.map(t=>`<div class="tidy">
        <span class="t-tag">${t.tag}</span>
        <span class="t-name">${esc(t.r.title)}</span>
        <button class="icon-btn sm" onclick="${t.fn}">${t.act}</button>
      </div>`).join('')}
    </div>`;
}

/* ---------- the page ---------- */
function viewHome(){
  const cooked=mostCooked(3);
  const feed=recentActivity(6);
  const top=topRanked(10);
  const topMax=Math.max(1,...top.map(r=>r.timesCooked||0));

  if(!recipes.length){
    return `
      <div class="home-hero">
        <h1>Welcome to your pantry</h1>
        <p>Nothing in here yet — add your first recipe and this page fills itself in.</p>
        <div style="margin-top:20px;"><button class="icon-btn primary" onclick="startAddRecipe()">+ Add your first recipe</button></div>
      </div>`;
  }

  return `
    <div class="home-hero">
      <h1>What are you cooking today?</h1>
      <p>${recipes.length} recipe${recipes.length===1?'':'s'} · ${globalSubs.length} substitutions ·
         ${totalCooked()} meal${totalCooked()===1?'':'s'} cooked</p>
      <div class="home-search">
        <input id="homeSearch" type="text" placeholder="Search recipes by name, ingredient, cookbook, or tag..."
          onkeydown="if(event.key==='Enter'){event.preventDefault();runHomeSearch();}">
        <button class="icon-btn primary" onclick="runHomeSearch()">🔍 Search</button>
      </div>
    </div>

    ${renderKpiRow()}

    <div class="home-grid">
      <div>
        <div class="home-sec">
          ${secHead('mostCooked','🔥 Most Cooked',
            `<button class="link" onclick="clearBrowseFilters();state.sortBy='mostUsed';goto('browse')">See all →</button>`)}
          ${isCollapsed('mostCooked')?''
            :cooked.length?`<div class="grid">${cooked.map((r,i)=>rankedCard(r,i)).join('')}</div>`
            :`<div class="empty">Cook something and it'll show up here.</div>`}
        </div>

        <div class="split-2">
          <div>${renderPantry()}</div>
          <div>${renderCategoryChart()}</div>
        </div>

        ${renderTonight()}

        ${renderActivity()}
        ${renderShelf()}
        ${renderTidy()}
      </div>

      <div>
        <div class="side-card">
          ${sideHead('feed','💬 Latest Ratings &amp; Comments','Newest activity across all your recipes')}
          ${isCollapsed('feed')?'':feed.length?feed.map(f=>{
            const cov=coverImage(f.r);
            return `<div class="feed-item">
              <div class="feed-top">
                <span class="feed-thumb">${cov
                  ? `<img src="${cov.url}" alt="" style="${focalStyle(cov)}">` : f.r.emoji}</span>
                <button class="feed-link" onclick="openRecipe('${f.r.id}')">${esc(f.r.title)}</button>
                <span class="stars" style="font-size:12px;">${'★'.repeat(f.c.stars)}${'☆'.repeat(5-f.c.stars)}</span>
              </div>
              ${f.c.comment?`<div class="ftext">"${esc(f.c.comment)}"</div>`
                :`<div class="ftext" style="color:var(--dim);">Rated with no comment</div>`}
              <div class="fdate">${f.c.date}</div>
            </div>`;}).join('')
          :`<div class="empty" style="padding:12px 0;font-size:13px;">No ratings yet.</div>`}
        </div>

        <div class="side-card">
          ${sideHead('top10','🏆 Top 10 Recipes','Ranked by rating, then times cooked')}
          ${isCollapsed('top10')?'':top.map((r,i)=>`
            <div class="top-item">
              <span class="rank ${i<3?'gold':''}">${i+1}</span>
              <div style="min-width:0;flex:1;">
                <button class="feed-link" onclick="openRecipe('${r.id}')">${esc(r.title)}</button>
                <div class="cats">${r.categories.join(' · ')}</div>
                <div class="top-bar"><span style="width:${Math.round((r.timesCooked||0)/topMax*100)}%"></span></div>
                <div class="tmeta">${r.ratings.length?`★ ${avgRating(r).toFixed(1)} (${r.ratings.length})`:'unrated'} · 👨‍🍳 ${r.timesCooked}×</div>
              </div>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
}

/* A Most Cooked card with its rank badge. */
function rankedCard(r, i){
  const medal = ['①','②','③'][i] || '';
  return recipeCard(r).replace('<div class="thumb">',
    `<span class="rank-medal">${medal}</span><div class="thumb">`);
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

/* ---- Browse Cookbooks ----
 * A cookbook is portrait. The old card gave it a landscape thumbnail, which
 * cropped a real cover through the middle and left an emoji stranded in a wide
 * empty rectangle. These are 3:4, and a book with no photo gets one of the
 * cloth-binding tones the home-page shelf already uses.
 */
const BOOK_TONES = ['toneA','toneB','toneC','toneD','toneE'];
const BOOK_SORTS = [
  { key:'recipes',   label:'Most recipes' },
  { key:'az',        label:'A → Z' },
  { key:'author',    label:'By author' },
  { key:'published', label:'Most recent' },
];
function setBookSort(v){ state.bookSort=v; renderMain(); }
function sortedBooks(list){
  const n=b=>recipesInBook(b.id).length;
  const cmp={
    recipes:(a,b)=>n(b)-n(a) || a.title.localeCompare(b.title),
    az:(a,b)=>a.title.localeCompare(b.title),
    author:(a,b)=>(a.author||'~').localeCompare(b.author||'~') || a.title.localeCompare(b.title),
    published:(a,b)=>String(b.published||'').localeCompare(String(a.published||'')) || a.title.localeCompare(b.title),
  }[state.bookSort||'recipes'];
  return list.slice().sort(cmp);
}
/** Jump to the recipes that came from nowhere in particular. */
function browseUnlinked(){
  clearBrowseFilters();
  state.bookFilter='none'; state.sortBy='az';
  goto('browse');
}
function viewCookbooks(){
  const q=state.bookSearch.trim().toLowerCase();
  const matched=cookbooks.filter(b=>!q ||
    b.title.toLowerCase().includes(q) || (b.author||'').toLowerCase().includes(q) ||
    (b.publisher||'').toLowerCase().includes(q));
  const list=sortedBooks(matched);
  const linked=recipes.filter(r=>r.cookbookId).length;
  const loose=recipes.length-linked;
  return `
    <div class="browse-head">
      <h1 class="title">Cookbooks</h1>
      <span class="result-count">${q
        ? `<b>${list.length}</b> of ${cookbooks.length} books`
        : `<b>${cookbooks.length}</b> book${cookbooks.length===1?'':'s'}${
            recipes.length?` · ${linked} of your ${recipes.length} recipes`:''}`}</span>
      <div class="right no-print">
        ${cookbooks.length>1?`<select onchange="setBookSort(this.value)">
          ${BOOK_SORTS.map(s=>`<option value="${s.key}" ${(state.bookSort||'recipes')===s.key?'selected':''}>${s.label}</option>`).join('')}
        </select>`:''}
        <button class="icon-btn primary" onclick="startAddCookbook()">+ Add Cookbook</button>
      </div>
    </div>

    ${cookbooks.length?`<div class="controls no-print">
      <div class="search-wrap"><span class="sicon">🔍</span>
        <input id="bookSearch" type="text" placeholder="Search by title, author, or publisher..."
          value="${escA(state.bookSearch)}" oninput="onBookSearch(this)"></div>
      ${q?`<button class="icon-btn sm" onclick="state.bookSearch='';renderMain()">✕ Clear</button>`:''}
    </div>`:''}

    ${cookbooks.length===0
      ? `<div class="empty">No cookbooks yet. Add the books your recipes come from, and you can link
          recipes to them.</div>`
      : list.length===0
        ? `<div class="empty">No cookbooks match "${esc(state.bookSearch)}".</div>`
        : `<div class="bgrid">
            ${list.map((b,i)=>{
              const cover=bookCover(b), n=recipesInBook(b.id).length;
              return `<div class="bcard" onclick="openCookbook('${b.id}')">
                <button class="card-del no-print" title="Remove cookbook"
                  onclick="event.stopPropagation(); confirmDeleteCookbook('${b.id}')">×</button>
                <div class="bcov ${cover?'':BOOK_TONES[i%BOOK_TONES.length]}">${cover
                  ? `<img src="${cover.url}" alt="${escA(b.title)}" style="${focalStyle(cover)}">`
                  : b.emoji}</div>
                <h3>${esc(b.title)}</h3>
                <div class="ba">${b.author?esc(b.author):'—'}</div>
                <div class="bm"><span>${b.published?esc(b.published):'—'}${
                  b.edition?` · ${esc(b.edition)}`:''}</span>
                  <span>${n} recipe${n===1?'':'s'}</span></div>
              </div>`;}).join('')}
            ${loose&&!q?`<div class="bcard loose" onclick="browseUnlinked()"
              title="See the recipes that didn't come from a book">
              <div class="bcov">🗂️</div>
              <h3>Not from a book</h3>
              <div class="ba">your own and the internet's</div>
              <div class="bm"><span>—</span><span>${loose} recipe${loose===1?'':'s'}</span></div>
            </div>`:''}
          </div>`}`;
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
    state.editingBook=blankBookDraft();
    state.view='editCookbook'; markEditBaseline(); render();
  });
}
function startEditCookbook(id){
  attemptNav(()=>{
    state.editingBook=JSON.parse(JSON.stringify(cookbooks.find(b=>b.id===id)));
    state.view='editCookbook'; markEditBaseline(); render();
  });
}
function stashBookForm(){
  const b=state.editingBook;
  if(!b) return;
  const g=id=>document.getElementById(id);
  if(g('b_title')) b.title=g('b_title').value;
  if(g('b_author')) b.author=g('b_author').value;
  if(g('b_publisher')) b.publisher=g('b_publisher').value;
  if(g('b_published')) b.published=g('b_published').value;
  if(g('b_edition')) b.edition=g('b_edition').value;
  if(g('b_isbn')) b.isbn=g('b_isbn').value;
  if(g('b_notes')) b.notes=g('b_notes').value;
  if(g('b_emoji')) b.emoji=g('b_emoji').value;
}
function viewEditCookbook(){
  const b=state.editingBook, isNew=!b.id;
  const cover=bookCover(b);
  const linked=isNew?[]:recipesInBook(b.id);
  const files=(b.files||[]).length, photos=(b.images||[]).length;
  return `
    ${editBar(isNew?'Add a Cookbook':'Edit Cookbook','Save Cookbook','saveCookbook()','cancelBookEdit()')}
    <div class="book-cols">
      <div class="cover-box">
        <div class="cover-shot">${cover
          ? `<img src="${cover.url}" alt="${escA(b.title)}" style="${focalStyle(cover)}">`
          : `<span class="cover-emoji">${b.emoji||'📕'}</span>`}</div>
        ${isNew
          ? `<div class="subtle" style="font-size:12px;margin-top:11px;line-height:1.55;">
              Save the book first and you can add photos and scanned files to it.</div>`
          : `<div class="cover-btns">
              <label class="icon-btn" style="text-align:center;cursor:pointer;">
                📁 ${cover?'Change cover':'Add a photo'}
                <input type="file" accept="image/*" style="display:none"
                  onchange="handleBookUpload(event,'${b.id}')">
              </label>
              ${cover?`<button class="icon-btn" onclick="openFocalEditor('book','${cover.id}')">⤧ Reposition</button>`:''}
            </div>
            <div class="subtle" style="font-size:12px;margin-top:12px;line-height:1.55;">
              ${photos} photo${photos===1?'':'s'} · ${files} scanned file${files===1?'':'s'}.
              <button class="linkish" onclick="openCookbook('${b.id}')">Manage on the book page →</button></div>`}
      </div>

      <div>
        <div class="fsec">
          <h2>The book <span class="hint">only the title is required</span></h2>
          <div class="fsec-body">
            <div class="form-row"><label>Title</label>
              <input type="text" id="b_title" value="${escA(b.title)}" placeholder="The Joy of Cooking"
                oninput="stashBookForm()"></div>
            <div class="fgrid" style="grid-template-columns:1fr 130px;">
              <div class="form-row" style="margin:0;"><label>Author</label>
                <input type="text" id="b_author" value="${escA(b.author)}" placeholder="Irma S. Rombauer"
                  oninput="stashBookForm()"></div>
              <div class="form-row" style="margin:0;"><label>Cover emoji</label>
                <input type="text" id="b_emoji" value="${escA(b.emoji)}" style="text-align:center;"
                  oninput="stashBookForm()"></div>
            </div>
            ${renderEmojiPicker('cookbook', b.emoji, 'b_emoji')}
            <div class="fgrid" style="grid-template-columns:1fr 1fr;margin-top:20px;">
              <div class="form-row" style="margin:0;"><label>Publisher</label>
                <input type="text" id="b_publisher" value="${escA(b.publisher)}" placeholder="Scribner"
                  oninput="stashBookForm()"></div>
              <div class="form-row" style="margin:0;"><label>Published</label>
                <input type="text" id="b_published" value="${escA(b.published)}" placeholder="1997"
                  oninput="stashBookForm()"></div>
              <div class="form-row" style="margin:0;"><label>Edition</label>
                <input type="text" id="b_edition" value="${escA(b.edition)}" placeholder="75th Anniversary"
                  oninput="stashBookForm()"></div>
              <div class="form-row" style="margin:0;"><label>ISBN</label>
                <input type="text" id="b_isbn" value="${escA(b.isbn)}" placeholder="978-0-7432-4626-2"
                  oninput="stashBookForm()"></div>
            </div>
          </div>
        </div>

        <div class="fsec">
          <h2>Notes</h2>
          <div class="fsec-body">
            <textarea id="b_notes" rows="4" oninput="stashBookForm()"
              placeholder="Where it came from, who gave it to you, which sections are worth cooking from..."
              style="width:100%;padding:11px 13px;border-radius:3px;border:1px solid var(--rule);font-size:15px;background:var(--panel);color:var(--cream);font-family:var(--body);">${esc(b.notes)}</textarea>
          </div>
        </div>

        ${isNew?'':`
        <div class="fsec" style="margin-bottom:0;">
          <h2>Record</h2>
          <div class="fsec-body">
            <div class="record-strip">
              <div class="record-note" style="max-width:none;">
                <b style="color:var(--paper);font-style:normal;">${linked.length} recipe${linked.length===1?'':'s'}</b>
                linked to this book. Deleting it won't delete them — they just stop showing a source.</div>
              <div class="danger-side">
                <button class="icon-btn danger" onclick="confirmDeleteCookbook('${b.id}')">🗑 Delete this cookbook</button></div>
            </div>
          </div>
        </div>`}
      </div>
    </div>`;
}
function cancelBookEdit(){
  guardEdit(()=>{ clearEditDraft(); state.view='cookbooks'; render(); });
}
async function saveCookbook(){
  stashBookForm();
  const b=state.editingBook;
  const payload={
    title:(b.title||'').trim(), author:(b.author||'').trim(), publisher:(b.publisher||'').trim(),
    published:(b.published||'').trim(), edition:(b.edition||'').trim(), isbn:(b.isbn||'').trim(),
    notes:b.notes||'', emoji:(b.emoji||'').trim()||'📕',
  };
  if(!payload.title){ toast('A cookbook needs a title.'); return; }
  try{
    const res = b.id ? await apiJSON('/api/cookbooks/'+b.id,'PUT',payload)
                     : await apiJSON('/api/cookbooks','POST',payload);
    const id = b.id || res.id;
    clearEditDraft();
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
          if(state.view==='editCookbook'){ clearEditDraft(); state.view='cookbooks'; }
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

/* ============ BROWSE ============
 * Filters have to answer three questions at a glance: how many of your recipes
 * you are looking at, what is doing the narrowing, and how to undo any one part
 * of it. The old page answered none of them — the count was always the total and
 * the only way back was resetting three dropdowns one at a time.
 */
const QUICK_FILTERS = [
  { key:'never',   label:'Never cooked', test:r => !r.timesCooked },
  { key:'unrated', label:'Unrated',      test:r => !r.ratings.length },
  { key:'nophoto', label:'No photo',     test:r => !(r.images||[]).length },
  { key:'quick',   label:'Under 30 min', test:r => { const t=totalMinutes(r); return t>0 && t<=30; } },
];
const SORTS = [
  { key:'newest',     label:'Newest first' },
  { key:'oldest',     label:'Oldest first' },
  { key:'az',         label:'A → Z' },
  { key:'za',         label:'Z → A' },
  { key:'mostUsed',   label:'Most cooked' },
  { key:'topRated',   label:'Highest rated' },
  { key:'lastCooked', label:'Recently cooked' },
  { key:'time',       label:'Quickest first' },
  { key:'relevant',   label:'Most relevant' },
];
function quickOn(key){ return state.quickFilters.includes(key); }
function toggleQuick(key){
  state.quickFilters = quickOn(key)
    ? state.quickFilters.filter(k=>k!==key)
    : [...state.quickFilters, key];
  renderMain();
}
function setBookFilter(v){ state.bookFilter=v; renderMain(); }
function setBrowseView(v){ state.browseView=v; renderMain(); }
/** Sort by a column heading. Clicking the active column flips it. */
function sortByColumn(key){
  const flip={ az:'za', za:'az', newest:'oldest', oldest:'newest' };
  state.sortBy = (state.sortBy===key && flip[key]) ? flip[key] : key;
  renderMain();
}
function clearBrowseFilters(){
  state.searchQuery=''; state.categoryFilter='all'; state.bookFilter='all';
  state.quickFilters=[];
  if(state.sortBy==='relevant') state.sortBy='newest';
  renderMain();
}
const browseFiltered = () => filteredSorted();
/** True when something is hiding recipes. Sort is deliberately not counted —
 *  reordering a list is not the same as narrowing it. */
function browseFilterCount(){
  return (state.searchQuery.trim()?1:0) + (state.categoryFilter!=='all'?1:0)
       + (state.bookFilter!=='all'?1:0) + state.quickFilters.length;
}
function bookFilterLabel(){
  if(state.bookFilter==='none') return 'Not from a book';
  if(state.bookFilter==='any')  return 'From any cookbook';
  const b=bookById(state.bookFilter);
  return b?b.title:'Cookbook';
}
function renderActiveFilters(){
  if(!browseFilterCount()) return '';
  const chip=(label,clear)=>`<span class="fchip">${esc(label)}
    <button title="Remove this filter" onclick="${clear}">×</button></span>`;
  return `<div class="activerow no-print">
    <span class="lab">Filtering by</span>
    ${state.searchQuery.trim()?chip(`“${state.searchQuery.trim()}”`,`state.searchQuery='';renderMain()`):''}
    ${state.categoryFilter!=='all'?chip(state.categoryFilter,`state.categoryFilter='all';renderMain()`):''}
    ${state.bookFilter!=='all'?chip(bookFilterLabel(),`setBookFilter('all')`):''}
    ${state.quickFilters.map(k=>{
      const q=QUICK_FILTERS.find(x=>x.key===k);
      return q?chip(q.label,`toggleQuick('${k}')`):'';
    }).join('')}
    <button class="clearall" onclick="clearBrowseFilters()">✕ Clear all</button>
  </div>`;
}
function viewBrowse(){
  const list=browseFiltered();
  const filtering=browseFilterCount()>0;
  const linked=recipes.filter(r=>r.cookbookId).length;
  return `
    <div class="browse-head">
      <h1 class="title">Recipes</h1>
      <span class="result-count">${filtering
        ? `<b>${list.length}</b> of ${recipes.length} shown`
        : `<b>${recipes.length}</b> recipe${recipes.length===1?'':'s'}`}</span>
      <div class="right no-print">
        <div class="viewtog">
          <button class="${state.browseView==='list'?'':'on'}" onclick="setBrowseView('grid')">▦ Grid</button>
          <button class="${state.browseView==='list'?'on':''}" onclick="setBrowseView('list')">☰ List</button>
        </div>
        <button class="icon-btn primary" onclick="startAddRecipe()">+ Add Recipe</button>
      </div>
    </div>

    <div class="controls no-print">
      <div class="search-wrap"><span class="sicon">🔍</span>
        <input id="searchInput" type="text" placeholder="Search by name, ingredient, category, tag, or cookbook..."
          value="${escA(state.searchQuery)}" oninput="onSearch(this)"></div>
      <select onchange="state.categoryFilter=this.value; renderMain();">
        <option value="all">All categories</option>
        ${allCategories.map(c=>`<option value="${escA(c)}" ${state.categoryFilter===c?'selected':''}>${esc(c)}</option>`).join('')}
      </select>
      <select onchange="setBookFilter(this.value)">
        <option value="all">All cookbooks</option>
        <option value="any"  ${state.bookFilter==='any'?'selected':''}>— From any cookbook (${linked}) —</option>
        <option value="none" ${state.bookFilter==='none'?'selected':''}>— Not from a book (${recipes.length-linked}) —</option>
        ${cookbooks.map(b=>`<option value="${b.id}" ${state.bookFilter===b.id?'selected':''}>${esc(b.title)}</option>`).join('')}
      </select>
      <select onchange="state.sortBy=this.value; renderMain();">
        ${SORTS.map(s=>`<option value="${s.key}" ${state.sortBy===s.key?'selected':''}>${s.label}</option>`).join('')}
      </select>
    </div>

    <div class="quickrow no-print">
      ${QUICK_FILTERS.map(q=>{
        const n=recipes.filter(q.test).length;
        return `<button class="qchip ${quickOn(q.key)?'on':''}" onclick="toggleQuick('${q.key}')">
          ${q.label} <span class="n">${n}</span></button>`;
      }).join('')}
    </div>

    ${renderActiveFilters()}

    ${list.length===0
      ? `<div class="empty">${filtering
          ? `Nothing matches those filters.<br>
             <button class="icon-btn sm no-print" style="margin-top:14px;" onclick="clearBrowseFilters()">✕ Clear all filters</button>`
          : 'No recipes yet. Add your first one and it shows up here.'}</div>`
      : state.browseView==='list'
        ? renderRecipeList(list)
        : `<div class="grid">${list.map(recipeCard).join('')}</div>`}`;
}

/* ---- the list view ----
 * A collection without photos spends most of a grid card on an empty panel.
 * The list fits roughly three times as many recipes on a screen and has room
 * for the two things a card never did: how long it takes and when you last
 * made it.
 */
const LIST_COLS = [
  { key:null,         label:'',           cls:'' },
  { key:'az',         label:'Recipe',     cls:'' },
  { key:null,         label:'From',       cls:'col-from' },
  { key:'time',       label:'Time',       cls:'col-time num' },
  { key:'topRated',   label:'Rating',     cls:'col-rating' },
  { key:'mostUsed',   label:'Cooked',     cls:'num' },
  { key:'lastCooked', label:'Last made',  cls:'col-last num' },
  { key:null,         label:'',           cls:'' },
];
function sortArrow(key){
  if(key==='az'  && state.sortBy==='az')  return ' ↑';
  if(key==='az'  && state.sortBy==='za')  return ' ↓';
  return state.sortBy===key ? ' ↓' : '';
}
function renderRecipeList(list){
  return `<div class="rlist">
    <div class="rl-head">
      ${LIST_COLS.map(c=>c.key
        ? `<button class="sortable ${['az','za'].includes(state.sortBy)&&c.key==='az'||state.sortBy===c.key?'on':''} ${c.cls}"
             onclick="sortByColumn('${c.key}')">${c.label}${sortArrow(c.key)}</button>`
        : `<span class="${c.cls}">${c.label}</span>`).join('')}
    </div>
    ${list.map(r=>{
      const b=r.cookbookId?bookById(r.cookbookId):null;
      const t=totalMinutes(r);
      const last=agoLabel(r.lastCookedAt);
      return `<div class="rl-row" onclick="openRecipe('${r.id}')">
        <span class="rl-emoji">${r.emoji}</span>
        <span style="min-width:0;">
          <span class="rl-title">${esc(r.title)}</span>
          <div class="rl-cats">${r.categories.map(esc).join(' · ')}</div></span>
        <span class="rl-src col-from">${b?`${b.emoji} ${esc(b.title)}`:'—'}</span>
        <span class="rl-num col-time">${t?esc(fmtTotal(t)):'—'}</span>
        <span class="col-rating">${r.ratings.length
          ? `<span class="rl-stars">${starString(avgRating(r))}</span>
             <span class="rl-count">(${r.ratings.length})</span>`
          : `<span class="unrated">unrated</span>`}</span>
        <span class="rl-num">${r.timesCooked}×</span>
        <span class="rl-num col-last">${last?esc(last[1]?`${last[0]} ${last[1].toLowerCase()}`:last[0]):'—'}</span>
        <button class="rl-x no-print" title="Remove recipe"
          onclick="event.stopPropagation(); confirmDeleteRecipe('${r.id}')">×</button>
      </div>`;
    }).join('')}
  </div>`;
}

/* The source book on a card. Skipped on a cookbook's own page, where every
   card would repeat the same book name back at you. */
function cardSourceLine(r){
  if(state.view === 'cookbookDetail') return '';
  const b = r.cookbookId ? bookById(r.cookbookId) : null;
  if(!b) return '';
  return `<div class="card-source" title="From ${escA(b.title)}">${b.emoji} ${esc(b.title)}${
    r.cookbookPage ? ` · p. ${esc(r.cookbookPage)}` : ''}</div>`;
}

function recipeCard(r){
  const t=totalMinutes(r);
  return `<div class="rcard" onclick="openRecipe('${r.id}')">
    <button class="card-del no-print" title="Remove recipe" onclick="event.stopPropagation(); confirmDeleteRecipe('${r.id}')">×</button>
    <div class="thumb">${coverImage(r)
      ? `<img src="${coverImage(r).url}" alt="${escA(r.title)}" style="${focalStyle(coverImage(r))}">`
      : r.emoji}</div>
    <div class="body">
      <div>${r.categories.map(c=>`<span class="badge">${esc(c)}</span>`).join('')}</div>
      <h3>${esc(r.title)}</h3>
      ${cardSourceLine(r)}
      <div class="rmeta">
        ${/* five empty stars read as "rated zero"; nobody rating it is a different thing */''}
        <span class="stars">${r.ratings.length
          ? `${starString(avgRating(r))} <span class="rl-count">(${r.ratings.length})</span>`
          : `<span class="unrated">unrated</span>`}</span>
        <span>${t?`${esc(fmtTotal(t))} · `:''}👨‍🍳 ${r.timesCooked}×</span>
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
          if(state.view==='editRecipe'){ clearEditDraft(); state.view='browse'; }
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

/* ============ UNSAVED-WORK GUARD ============
 * Every exit from an edit form used to discard the work in silence — the top
 * bar, the browser's back button, the Cancel button, and reloading the tab.
 * All four now ask first, and the question names what would be lost.
 *
 * Dirtiness is measured, not tracked: a snapshot is taken when the form opens
 * and compared against the live draft. That way a change you typed and then
 * undid doesn't count as unsaved work.
 */
let editBaseline = null;
const inEditForm = () => ['editRecipe','editCookbook'].includes(state.view);

function currentDraft(){
  if(state.view==='editRecipe')   { stashEditForm(); return state.editing; }
  if(state.view==='editCookbook') { stashBookForm(); return state.editingBook; }
  return null;
}
function markEditBaseline(){
  const d = state.view==='editRecipe' ? state.editing
          : state.view==='editCookbook' ? state.editingBook : null;
  editBaseline = d ? JSON.stringify(d) : null;
}
function isEditDirty(){
  if(!inEditForm() || editBaseline==null) return false;
  try{ return JSON.stringify(currentDraft()) !== editBaseline; }
  catch(e){ return false; }
}
/** Plain-language list of what changed, so the warning is specific. */
function describeEditChanges(){
  let was, now;
  try{ was=JSON.parse(editBaseline); now=currentDraft(); }catch(e){ return []; }
  if(!was||!now) return [];
  const out=[];
  const same=(k)=>JSON.stringify(was[k])===JSON.stringify(now[k]);
  const cmp=(k,label)=>{ if(!same(k)) out.push(label); };
  if(state.view==='editRecipe'){
    cmp('title','title'); cmp('emoji','emoji'); cmp('categories','categories');
    cmp('tags','tags'); cmp('baseServings','servings');
    cmp('prepMinutes','prep time'); cmp('cookMinutes','cook time');
    cmp('cookbookId','cookbook'); cmp('cookbookPage','page');
    cmp('notes','notes'); cmp('timesCooked','times cooked');
    const countLabel=(a,b,word)=>{
      const d=b.length-a.length;
      return d>0 ? `${d} ${word}${d===1?'':'s'} added`
           : d<0 ? `${-d} ${word}${d===-1?'':'s'} removed`
           : `${word} edits`;
    };
    if(!same('ingredients')) out.push(countLabel(was.ingredients||[], now.ingredients||[], 'ingredient'));
    if(!same('instructions')) out.push(countLabel(was.instructions||[], now.instructions||[], 'step'));
  } else {
    cmp('title','title'); cmp('author','author'); cmp('publisher','publisher');
    cmp('published','published'); cmp('edition','edition'); cmp('isbn','ISBN');
    cmp('notes','notes'); cmp('emoji','emoji');
  }
  return out;
}
function clearEditDraft(){
  state.editing=null; state.editingBook=null;
  state.scanSource=null; state.scanImage=null;
  editBaseline=null;
}
/** Runs `leave` only once it's safe to lose the draft. `onStay` lets the caller
 *  put things back — the browser's back button needs the URL restored. */
function guardEdit(leave, onStay){
  if(!isEditDirty()){ leave(); return; }
  const d = currentDraft();
  const name = (d && String(d.title||'').trim()) || 'this draft';
  const what = describeEditChanges();
  showModal({
    title:'You have unsaved changes',
    body:`<p style="margin:0 0 10px;">You've edited <b>${esc(name)}</b> but haven't saved.
        Leaving this page will discard those changes.</p>
      ${what.length?`<p style="margin:0;color:var(--dim);font-size:14px;">Changed: ${esc(what.join(', '))}.</p>`:''}`,
    buttons:[
      {label:'Discard & leave', action:()=>{ clearEditDraft(); leave(); }},
      {label:'Keep editing', style:'primary', action:onStay||undefined},
    ]
  });
}
/* Closing the tab or reloading is the browser's to warn about, not ours. */
window.addEventListener('beforeunload', (e)=>{
  if(isEditDirty()){ e.preventDefault(); e.returnValue=''; }
});

/* ============ EMOJI PALETTE ============
 * The default row covers most cooking, but the useful set is personal. Anything
 * you add lives in the database rather than this browser, so the palette is the
 * same on your phone. Ordering is by how many recipes actually use each one,
 * counted server-side, so the ones you reach for drift to the front on their own.
 */
const EMOJI_VISIBLE = 12;
function toggleEmojiMore(kind){
  state.emojiOpen = state.emojiOpen===kind ? null : kind;
  renderMain();
  const el=document.getElementById('emojiNew_'+kind);
  if(el) el.focus();
}
function paletteFor(kind, current){
  const list=(emojiPalette[kind]||[]).slice();
  const top=list.slice(0, EMOJI_VISIBLE);
  // whatever you're using now belongs on the front row even if it's rare
  if(current && !top.some(e=>e.emoji===current)){
    const known=list.find(e=>e.emoji===current);
    if(top.length>=EMOJI_VISIBLE) top.pop();
    top.unshift(known||{emoji:current, uses:0, custom:true});
  }
  return { top, rest: list.filter(e=>!top.some(t=>t.emoji===e.emoji)) };
}
function renderEmojiPicker(kind, current, fieldId){
  const {top, rest} = paletteFor(kind, current);
  const open = state.emojiOpen===kind;
  return `<div class="emoji-pick">
    ${top.map(e=>`<button type="button" class="epick ${e.emoji===current?'on':''}"
      title="${e.uses?`used by ${e.uses} ${kind==='cookbook'?'book':'recipe'}${e.uses===1?'':'s'}`:'not used yet'}"
      onclick="pickEmoji('${kind}','${fieldId}','${jsq(e.emoji)}')">${e.emoji}</button>`).join('')}
    <button type="button" class="epick more ${open?'on':''}" onclick="toggleEmojiMore('${kind}')"
      title="Add your own${rest.length?` · ${rest.length} more in your palette`:''}"
      >＋${rest.length?`<span class="ecount">${rest.length}</span>`:''}</button>
  </div>
  ${open?`<div class="emoji-panel">
    ${rest.length?`<div class="ep-label">The rest of your palette</div>
      <div class="emoji-pick">${rest.map(e=>`<span class="epwrap">
        <button type="button" class="epick ${e.emoji===current?'on':''}"
          title="${e.uses?`used by ${e.uses}`:'not used yet'}"
          onclick="pickEmoji('${kind}','${fieldId}','${jsq(e.emoji)}')">${e.emoji}</button>
        ${e.custom&&!e.uses?`<button type="button" class="epkill" title="Remove from palette"
          onclick="removePaletteEmoji('${kind}','${jsq(e.emoji)}')">×</button>`:''}
      </span>`).join('')}</div>`:''}
    <div class="ep-label" style="margin-top:${rest.length?'14px':'0'};">Add one of your own</div>
    <div class="ep-add">
      <input type="text" id="emojiNew_${kind}" maxlength="8" placeholder="Paste or type an emoji"
        onkeydown="if(event.key==='Enter'){event.preventDefault();addPaletteEmoji('${kind}','${fieldId}');}">
      <button type="button" class="icon-btn" onclick="addPaletteEmoji('${kind}','${fieldId}')">+ Add</button>
    </div>
    <div class="subtle" style="font-size:12px;margin:9px 0 0;">
      Added emoji are kept with your account, so they show up on every device.</div>
  </div>`:''}`;
}
function pickEmoji(kind, fieldId, emoji){
  const el=document.getElementById(fieldId);
  if(el) el.value=emoji;
  if(kind==='cookbook'){ stashBookForm(); state.editingBook.emoji=emoji; }
  else { stashEditForm(); state.editing.emoji=emoji; }
  renderMain();
}
async function addPaletteEmoji(kind, fieldId){
  const el=document.getElementById('emojiNew_'+kind);
  const v=(el?el.value:'').trim();
  if(!v){ toast('Paste an emoji first.'); return; }
  if(/[a-z0-9]/i.test(v)){ toast('That looks like text, not an emoji.'); return; }
  if(kind==='cookbook') stashBookForm(); else stashEditForm();
  try{
    await apiJSON('/api/emoji','POST',{kind, emoji:v});
    pickEmoji(kind, fieldId, v);
    toast(`${v} added to your palette.`);
  }catch(e){ apiError(e); }
}
async function removePaletteEmoji(kind, emoji){
  if(kind==='cookbook') stashBookForm(); else stashEditForm();
  try{
    await apiJSON('/api/emoji','DELETE',{kind, emoji});
    renderMain(); toast('Removed from your palette.');
  }catch(e){ apiError(e); }
}

/* ============ PASTING A LIST ============
 * Typing fifteen ingredients into three boxes each is the slowest thing in the
 * app. This points the existing quantity parser at a block of text and shows
 * you what it read before anything is added, so a misread is visible rather
 * than buried in the form.
 */
const COMMON_UNITS = ['cup','cups','tbsp','tbs','tablespoon','tablespoons','tsp','teaspoon','teaspoons',
  'oz','ounce','ounces','lb','lbs','pound','pounds','g','gram','grams','kg','mg','ml','l','litre','litres',
  'liter','liters','clove','cloves','pinch','pinches','dash','dashes','can','cans','jar','jars','stick',
  'sticks','slice','slices','bunch','bunches','sprig','sprigs','head','heads','package','packages','pkg',
  'quart','quarts','pint','pints','gallon','gallons','handful','handfuls','piece','pieces','sheet','sheets',
  'stalk','stalks','fillet','fillets','strip','strips','cube','cubes','drop','drops','knob','knobs'];
const UNI_FRAC_CLASS = '[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]';

/** "1 1/2 cups all-purpose flour" -> {qtyRaw:"1 1/2", unit:"cups", name:"All-Purpose Flour"} */
function parseIngredientLine(line){
  let s=String(line||'').trim()
    .replace(/^[-*•·–—]\s+/,'')          // bullets
    .replace(/^\d{1,2}[.)]\s+/,'');      // list numbering, not a quantity
  if(!s) return null;

  let qtyRaw='';
  const m=s.match(new RegExp('^((?:\\d+\\s+\\d+\\/\\d+)|(?:\\d+\\/\\d+)|(?:\\d+(?:\\.\\d+)?)|'+UNI_FRAC_CLASS+')\\s*'));
  if(m){ qtyRaw=m[1].trim(); s=s.slice(m[0].length); }
  // a unicode fraction can trail a whole number: "1 ½ cups"
  const m2=s.match(new RegExp('^('+UNI_FRAC_CLASS+')\\s*'));
  if(m2 && qtyRaw){ qtyRaw+=' '+m2[1]; s=s.slice(m2[0].length); }
  // "a pinch of salt" — an article stands in for a quantity
  if(!qtyRaw) s=s.replace(/^(a|an)\s+/i,'');

  let unit='';
  const w=s.match(/^([A-Za-z]+)\.?\s+/);
  if(w && COMMON_UNITS.includes(w[1].toLowerCase())){ unit=w[1]; s=s.slice(w[0].length); }
  s=s.replace(/^of\s+/i,'').trim();
  if(!s) return null;
  return { qtyRaw, unit, name: titleCase(s) };
}
function parseIngredientBlock(text){
  return String(text||'').split(/\r?\n/).map(parseIngredientLine).filter(Boolean);
}
function parseStepBlock(text){
  const raw=String(text||'').trim();
  if(!raw) return [];
  // one per line normally; a single run-on paragraph splits on its own numbering
  const parts = /\r?\n/.test(raw) ? raw.split(/\r?\n+/) : raw.split(/(?=\b\d{1,2}[.)]\s)/);
  return parts.map(s=>s.trim().replace(/^[-*•·–—]\s+/,'').replace(/^\d{1,2}[.)]\s*/,'').trim())
    .filter(Boolean);
}

let pasteDraft=null;
function openPaste(kind){ pasteDraft={kind, text:''}; renderPaste(); }
function closePaste(){ pasteDraft=null; closeModal(); }
function renderPaste(){
  const d=pasteDraft;
  if(!d){ closeModal(); return; }
  const isIng = d.kind==='ingredients';
  const root=document.getElementById('modalRoot');
  root.className='show';
  root.innerHTML=`<div class="modal" style="max-width:620px;">
    <h3>${isIng?'Paste your ingredients':'Paste your steps'}</h3>
    <div class="mbody">
      <p style="margin:0 0 10px;">${isIng
        ? 'One per line, however it is written. Quantities, units and names get split apart for you.'
        : 'One step per line. Numbering like &quot;1.&quot; is stripped for you.'}</p>
      <textarea class="paste-area" id="pasteBox" oninput="updatePastePreview()"
        placeholder="${isIng?'1 1/2 cups all-purpose flour&#10;2 eggs&#10;a pinch of salt':'Heat the oven to 350°F.&#10;Cream the butter and sugar.'}">${esc(d.text)}</textarea>
      <div id="pastePreview"></div>
    </div>
    <div class="mbtns">
      <button class="icon-btn" onclick="closePaste()">Cancel</button>
      <button class="icon-btn primary" id="pasteGo" onclick="commitPaste()">Add</button>
    </div>
  </div>`;
  updatePastePreview();
  const box=document.getElementById('pasteBox'); if(box) box.focus();
}
function updatePastePreview(){
  if(!pasteDraft) return;
  const box=document.getElementById('pasteBox');
  pasteDraft.text = box ? box.value : '';
  const isIng = pasteDraft.kind==='ingredients';
  const rows = isIng ? parseIngredientBlock(pasteDraft.text) : parseStepBlock(pasteDraft.text);
  const prev=document.getElementById('pastePreview');
  const go=document.getElementById('pasteGo');
  if(go){
    go.textContent = rows.length
      ? `Add ${rows.length} ${isIng?'ingredient':'step'}${rows.length===1?'':'s'}`
      : 'Add';
    go.disabled = !rows.length;
  }
  if(!prev) return;
  if(!rows.length){
    prev.innerHTML = pasteDraft.text.trim()
      ? `<div class="subtle" style="margin:12px 0 0;">Nothing readable in that yet.</div>` : '';
    return;
  }
  prev.innerHTML = isIng
    ? `<div class="preview-tab">
        <div class="pt-head"><span>Qty</span><span>Unit</span><span>Ingredient</span></div>
        ${rows.map(r=>`<div class="pt-row">
          <span class="q">${r.qtyRaw?esc(fmtQty(parseQty(r.qtyRaw))):'—'}</span>
          <span class="u">${r.unit?esc(r.unit):'—'}</span>
          <span>${esc(r.name)}</span></div>`).join('')}
       </div>
       <p style="margin:12px 0 0;color:var(--dim);font-size:13.5px;">They land as normal editable rows,
         so anything read wrong is a click away from fixing.</p>`
    : `<div class="preview-tab">${rows.map((s,i)=>`<div class="pt-step">
        <span class="n">${i+1}</span><span>${esc(s)}</span></div>`).join('')}</div>`;
}
function commitPaste(){
  if(!pasteDraft) return;
  const isIng = pasteDraft.kind==='ingredients';
  const rows = isIng ? parseIngredientBlock(pasteDraft.text) : parseStepBlock(pasteDraft.text);
  if(!rows.length) return;
  stashEditForm();
  if(isIng){
    // an untouched starter row would otherwise sit above everything you pasted
    const ing=state.editing.ingredients;
    if(ing.length===1 && !String(ing[0].name||'').trim()) ing.length=0;
    rows.forEach(r=>ing.push({id:uid(), qtyRaw:r.qtyRaw, qty:parseQty(r.qtyRaw), unit:r.unit, name:r.name}));
  } else {
    const st=state.editing.instructions;
    if(st.length===1 && !String(st[0]||'').trim()) st.length=0;
    rows.forEach(s=>st.push(s));
  }
  closePaste();
  renderMain();
  toast(`Added ${rows.length} ${isIng?'ingredient':'step'}${rows.length===1?'':'s'}.`);
}

/* ---- dragging ingredient rows (steps have had this; ingredients hadn't) ---- */
let dragIngIndex=null;
function armIngDrag(el){ const r=el.closest('.ing-row2'); if(r) r.draggable=true; }
function disarmIngDrag(el){ const r=el.closest('.ing-row2'); if(r) r.draggable=false; }
function ingDragStart(ev,idx){
  dragIngIndex=idx; ev.dataTransfer.effectAllowed='move';
  try{ ev.dataTransfer.setData('text/plain',String(idx)); }catch(e){}
  ev.currentTarget.classList.add('dragging');
}
function ingDragOver(ev){
  if(dragIngIndex===null) return;
  ev.preventDefault(); ev.dataTransfer.dropEffect='move';
  ev.currentTarget.classList.add('drop-target');
}
function ingDragLeave(ev){ ev.currentTarget.classList.remove('drop-target'); }
function ingDrop(ev,idx){
  ev.preventDefault(); ev.currentTarget.classList.remove('drop-target');
  const from = dragIngIndex!==null ? dragIngIndex : parseInt(ev.dataTransfer.getData('text/plain'),10);
  dragIngIndex=null; moveIng(from, idx);
}
function ingDragEnd(ev){
  dragIngIndex=null; ev.currentTarget.draggable=false;
  document.querySelectorAll('.ing-row2').forEach(r=>r.classList.remove('dragging','drop-target'));
}
function moveIng(from,to){
  const arr=state.editing && state.editing.ingredients;
  if(!arr || !Number.isInteger(from) || !Number.isInteger(to)) return;
  if(from===to || from<0 || to<0 || from>=arr.length || to>=arr.length) return;
  stashEditForm();
  const [item]=arr.splice(from,1); arr.splice(to,0,item);
  renderMain();
}

/* ============ RECIPE DETAIL ============ */
function setTab(t){ state.detailTab=t; state.showRecipeSubForm=false; renderMain(); }
function setScale(id,m){ state.scale[id]=m; renderMain(); }
async function logCooked(id){
  try{
    await apiJSON('/api/recipes/'+id+'/cook','POST',{day:localDay()});
    const r=recipes.find(x=>x.id===id);
    const n=r?r.timesCooked:0;
    render(); toast(`Logged! You've cooked this ${n} time${n===1?'':'s'}.`);
  }catch(e){ apiError(e); }
}

/* ---- how long, how recently, how often ---- */
function fmtMinutes(n){
  if(!n) return '—';
  if(n<60) return `${n} <small>MIN</small>`;
  const h=Math.floor(n/60), m=n%60;
  return m ? `${h} <small>HR</small> ${m}` : `${h} <small>HR</small>`;
}
function totalMinutes(r){ return (r.prepMinutes||0)+(r.cookMinutes||0); }
function agoLabel(ts){
  if(!ts) return null;
  const days=Math.floor((Date.now()-ts)/86400000);
  if(days<=0) return ['Today',''];
  if(days===1) return ['Yesterday',''];
  if(days<31) return [String(days),'DAYS AGO'];
  const months=Math.round(days/30.44);
  if(months<24) return [String(months), months===1?'MONTH AGO':'MONTHS AGO'];
  return [String(Math.round(days/365)),'YEARS AGO'];
}
/** Six months of this recipe's own cooking, for the bar under the count. */
function recipeMonthBars(r){
  const months=lastSixMonthKeys();
  const counts=months.map(m=>(r.cookMonths&&r.cookMonths[m])||0);
  const max=Math.max(1,...counts);
  if(!counts.some(Boolean)) return '';
  return `<div class="histbar">${counts.map((n,i)=>
    `<i class="${i===counts.length-1&&n?'hi':''}" style="height:${Math.max(8,Math.round(n/max*100))}%"
       title="${months[i]}: ${n}"></i>`).join('')}</div>`;
}
function renderFacts(r){
  const last=agoLabel(r.lastCookedAt);
  const avg=avgRating(r);
  const cell=(label,value,extra)=>`<div class="fact"><div class="fl">${label}</div>
    <div class="fv">${value}</div>${extra||''}</div>`;
  return `<div class="facts-row">
    ${cell('Prep', fmtMinutes(r.prepMinutes))}
    ${cell('Cook', fmtMinutes(r.cookMinutes))}
    ${cell('Serves', esc(String(r.baseServings)))}
    ${cell('Rating', r.ratings.length
        ? `<span style="color:var(--ochre);">★ ${avg.toFixed(1)}</span> <small>(${r.ratings.length})</small>`
        : '—')}
    ${cell('Last made', last ? `${last[0]} ${last[1]?`<small>${last[1]}</small>`:''}` : '—')}
    ${cell('Cooked', `${r.timesCooked}×`, recipeMonthBars(r))}
  </div>`;
}

/* ---- notes, edited where you read them ---- */
function startNotesEdit(id){
  const r=recipes.find(x=>x.id===id); if(!r) return;
  state.notesDraft={id, text:r.notes||''};
  renderMain();
  const el=document.getElementById('notesDraft');
  if(el){ el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}
function cancelNotesEdit(){ state.notesDraft=null; renderMain(); }
async function saveNotesEdit(id){
  const el=document.getElementById('notesDraft');
  const text=el?el.value:'';
  try{
    // a notes-only endpoint: PUT would rebuild the recipe and drop every ingredient
    await apiJSON('/api/recipes/'+id+'/notes','PATCH',{notes:text});
    state.notesDraft=null;
    render(); toast('Notes saved.');
  }catch(e){ apiError(e); }
}
function renderNotesBand(r){
  const editing = state.notesDraft && state.notesDraft.id===r.id;
  if(editing){
    return `<div class="notes-band editing no-print">
      <span class="nlabel">📝 Your notes</span>
      <textarea id="notesDraft" rows="4"
        placeholder="Tweaks you made, what to serve it with, who liked it...">${esc(state.notesDraft.text)}</textarea>
      <div class="note-btns">
        <button class="icon-btn" onclick="cancelNotesEdit()">Cancel</button>
        <button class="icon-btn primary" onclick="saveNotesEdit('${r.id}')">💾 Save notes</button>
      </div>
    </div>`;
  }
  const has=(r.notes||'').trim();
  return `<div class="notes-band">
    <span class="nlabel">📝 Your notes</span>
    ${has ? `<div class="notes-body">${esc(r.notes)}</div>`
          : `<div class="notes-empty">Nothing yet — things like "double the garlic" or
             "add ten minutes if you're doubling it" go here.</div>`}
    <button class="edit-inline no-print" onclick="startNotesEdit('${r.id}')">✏️ Edit</button>
  </div>`;
}

/* ---- ingredient mentions inside the instructions ----
 *
 * Applying a substitution rewrites the steps to match: "cream the butter" reads
 * "cream the coconut oil". Two rules keep that honest.
 *
 * First, a swapped word is always marked, so you can tell what the app changed
 * from what the recipe actually says — otherwise the steps quietly stop matching
 * the book they came from.
 *
 * Second, a mention that OPENS a sentence is left alone by default, because that
 * is where the cooking verb lives: "Butter a 9x5 pan" means grease the pan, not
 * add butter. Swapping it would produce "Coconut oil a 9x5 pan", which is both
 * nonsense and wrong advice. When one turns up we ask rather than guess, and the
 * answer applies to that one mention only.
 */
function reEsc(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
/* Safe inside onclick="fn('…')" — the value crosses an HTML attribute AND a
   JavaScript string literal, so it needs escaping for both. */
function jsq(s){
  return String(s==null?'':s)
    .replace(/\\/g,'\\\\').replace(/'/g,"\\'")
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}
const mentionKey=(rid,ingId,step,occ)=>`${rid}|${ingId}|${step}|${occ}`;
/** Should this particular mention be swapped? Explicit choice wins; otherwise
 *  mid-sentence yes, sentence-initial no. */
function mentionSwaps(rid,ingId,step,occ,sentenceInitial){
  const c=state.mentionChoices[mentionKey(rid,ingId,step,occ)];
  if(c!==undefined) return c;
  return !sentenceInitial;
}
/** Every ingredient this recipe uses, longest name first so "brown sugar" wins
 *  over "sugar" when both could match. */
function stepMatchers(r,applied){
  return r.ingredients.map(i=>{
    const from=normIng(i.name);
    return from ? {ingId:i.id, name:i.name, from, to:applied[i.id]?applied[i.id].substitute:null} : null;
  }).filter(Boolean).sort((a,b)=>b.from.length-a.from.length);
}
/** One scan, used both to draw a step and to find its ambiguous mentions, so the
 *  occurrence numbering can never drift between the two. */
function scanStep(text, matchers){
  const esced=esc(text);
  if(!matchers.length) return {esced, hits:[]};
  const rx=new RegExp('\\b('+matchers.map(m=>reEsc(esc(m.from))).join('|')+')(es|s)?\\b','gi');
  const hits=[], seen={};
  let m;
  while((m=rx.exec(esced))!==null){
    if(m[0]==='') { rx.lastIndex++; continue; }
    const word=m[1].toLowerCase();
    const matcher=matchers.find(x=>esc(x.from).toLowerCase()===word);
    if(!matcher) continue;
    const before=esced.slice(0,m.index).replace(/\s+$/,'');
    const occ=(seen[matcher.ingId]||0);
    seen[matcher.ingId]=occ+1;
    hits.push({start:m.index, len:m[0].length, text:m[0], matcher, occ,
               sentenceInitial: before==='' || /[.!?;:]$/.test(before)});
  }
  return {esced, hits};
}
/** A substitution is stored title-cased ("Coconut Oil") but a step reads
 *  "cream the coconut oil". Take the casing from the word being replaced. */
function matchCase(replacement, original){
  const first=String(original||'').charAt(0);
  if(!first) return replacement;
  const rest=replacement.slice(1);
  return /[a-z]/.test(first)
    ? replacement.charAt(0).toLowerCase()+rest
    : replacement.charAt(0).toUpperCase()+rest;
}
function renderStepHtml(r, text, stepIdx, matchers){
  const {esced, hits}=scanStep(text, matchers);
  let out='', at=0, swapped=0;
  for(const h of hits){
    if(h.start<at) continue;                       // overlapping match, keep the first
    out+=esced.slice(at,h.start);
    const m=h.matcher;
    const doSwap = m.to && mentionSwaps(r.id, m.ingId, stepIdx, h.occ, h.sentenceInitial);
    if(doSwap){
      swapped++;
      out+=`<button class="swapword" title="Originally ${escA(m.name)}"
        onclick="openMentionNote(event,'${r.id}','${m.ingId}',${stepIdx},${h.occ})"
        >${esc(matchCase(m.to, h.text))}</button>`;
    } else if(h.sentenceInitial && !m.to){
      out+=esced.slice(h.start, h.start+h.len);     // a verb, and nothing to offer: leave it be
    } else {
      out+=`<button class="ingword" title="${m.to?'Left as written':'See substitutions for '+escA(m.name)}"
        onclick="openMentionNote(event,'${r.id}','${m.ingId}',${stepIdx},${h.occ})"
        >${esced.slice(h.start, h.start+h.len)}</button>`;
    }
    at=h.start+h.len;
  }
  out+=esced.slice(at);
  return {html:out, swapped};
}
function renderSteps(r, applied){
  const matchers=stepMatchers(r, applied);
  let total=0;
  const items=r.instructions.map((s,i)=>{
    const {html,swapped}=renderStepHtml(r, s, i, matchers);
    total+=swapped;
    return `<li>${html}</li>`;
  }).join('');
  const banner = total ? `<div class="swap-banner no-print">
      ⇄ ${total} mention${total===1?'':'s'} swapped in these steps
      <button onclick="undoAllSwaps('${r.id}')">↩ undo</button></div>` : '';
  return banner + (r.instructions.length
    ? `<ol class="steps">${items}</ol>`
    : `<div class="empty">No steps yet. Hit Edit to write them in.</div>`);
}
function undoAllSwaps(recipeId){
  delete state.appliedSubs[recipeId];
  clearMentionChoices(recipeId);
  render(); toast('Reverted to the original ingredients.');
}
function clearMentionChoices(recipeId, ingId){
  const prefix = ingId ? `${recipeId}|${ingId}|` : `${recipeId}|`;
  Object.keys(state.mentionChoices).forEach(k=>{
    if(k.indexOf(prefix)===0) delete state.mentionChoices[k];
  });
}

/* ---- the little popover on a mention ---- */
let mentionPop=null;
function closeMentionNote(){ if(mentionPop){ mentionPop.remove(); mentionPop=null; } }
function openMentionNote(ev, recipeId, ingId, stepIdx, occ){
  ev.stopPropagation();
  closeMentionNote();
  const r=recipes.find(x=>x.id===recipeId); if(!r) return;
  const ing=r.ingredients.find(i=>i.id===ingId); if(!ing) return;
  const sw=(state.appliedSubs[recipeId]||{})[ingId];
  // nothing applied: the click is simply "show me what I could use instead"
  if(!sw){ jumpToSubs(ing.name); return; }
  const key=mentionKey(recipeId,ingId,stepIdx,occ);
  const on=state.mentionChoices[key]!==undefined
    ? state.mentionChoices[key]
    : true;                                        // rendered as a swap, so it is on
  const el=document.createElement('div');
  el.className='mention-pop';
  el.innerHTML=`
    <div class="mp-orig">Recipe says <b>${esc(ing.name)}</b></div>
    <button class="mp-act" onclick="setMentionChoice('${jsq(key)}',${on?'false':'true'})">
      ${on?'↩ Leave just this one as written':'⇄ Change this one too'}</button>
    <button class="mp-act" onclick="undoAllSwaps('${recipeId}')">↩ Undo the whole swap</button>
    <button class="mp-act" onclick="jumpToSubs('${jsq(ing.name)}')">🔁 See substitutions</button>`;
  document.body.appendChild(el);
  const rect=ev.currentTarget.getBoundingClientRect();
  const left=Math.min(window.scrollX+rect.left,
    window.scrollX+document.documentElement.clientWidth-el.offsetWidth-10);
  el.style.left=Math.max(window.scrollX+8, left)+'px';
  el.style.top=(window.scrollY+rect.bottom+7)+'px';
  mentionPop=el;
  setTimeout(()=>document.addEventListener('click', closeMentionNote, {once:true}), 0);
}
function setMentionChoice(key, on){
  state.mentionChoices[key]=on;
  closeMentionNote();
  renderMain();
  toast(on?'Changed this mention.':'Left this mention as written.');
}
/** After applying a substitution, ask about any mention that opens a sentence
 *  rather than quietly deciding for you. */
function promptAmbiguousMentions(r, ingId){
  const applied=state.appliedSubs[r.id]||{};
  const sw=applied[ingId]; if(!sw) return;
  const matchers=stepMatchers(r, applied);
  const found=[];
  r.instructions.forEach((text,i)=>{
    scanStep(text, matchers).hits.forEach(h=>{
      if(h.matcher.ingId===ingId && h.sentenceInitial
         && state.mentionChoices[mentionKey(r.id,ingId,i,h.occ)]===undefined){
        found.push({stepIdx:i, occ:h.occ, word:h.text, text});
      }
    });
  });
  if(!found.length) return;

  const why=`A step that <i>opens</i> with an ingredient name is usually telling you to do something —
    grease the pan, dust the board — rather than naming something to add. Changing it would give you
    "${esc(sw.substitute)} a pan", which isn't what the recipe means.`;

  if(found.length===1){
    const f=found[0];
    showModal({
      title:'That one might be a verb',
      body:`<p style="margin:0 0 12px;">Step ${f.stepIdx+1} begins:</p>
        <div class="quoted">${esc(f.text)}</div>
        <p style="margin:12px 0 0;">${why}</p>
        <p style="margin:10px 0 0;">I've left it as written. Change this one to
          <b>${esc(sw.substitute)}</b> as well?</p>`,
      buttons:[
        {label:'Leave it as written', action:()=>{
          state.mentionChoices[mentionKey(r.id,ingId,f.stepIdx,f.occ)]=false; renderMain(); }},
        {label:'Change this one too', style:'primary', action:()=>{
          state.mentionChoices[mentionKey(r.id,ingId,f.stepIdx,f.occ)]=true;
          renderMain(); toast('Changed that mention too.'); }},
      ]
    });
    return;
  }
  showModal({
    title:`${found.length} mentions might be verbs`,
    body:`<p style="margin:0 0 12px;">These steps open with <b>${esc(sw.ingredientName)}</b>:</p>
      ${found.map((f,i)=>`<label class="amb-row">
        <input type="checkbox" id="amb${i}">
        <span><span class="amb-step">Step ${f.stepIdx+1}</span>${esc(f.text)}</span></label>`).join('')}
      <p style="margin:12px 0 0;">${why}</p>
      <p style="margin:10px 0 0;">Tick any you want changed to <b>${esc(sw.substitute)}</b> anyway.</p>`,
    buttons:[
      {label:'Leave them all', action:()=>{
        found.forEach(f=>{ state.mentionChoices[mentionKey(r.id,ingId,f.stepIdx,f.occ)]=false; });
        renderMain(); }},
      {label:'Apply ticked', style:'primary', action:()=>{
        let n=0;
        found.forEach((f,i)=>{
          const el=document.getElementById('amb'+i);
          const on=!!(el&&el.checked); if(on) n++;
          state.mentionChoices[mentionKey(r.id,ingId,f.stepIdx,f.occ)]=on;
        });
        renderMain();
        toast(n?`Changed ${n} more mention${n===1?'':'s'}.`:'Left them as written.');
      }},
    ]
  });
}

/* ---- jumping from an ingredient to what could replace it ---- */
function jumpToSubs(name){
  closeMentionNote();
  state.detailTab='substitutions';
  state.recipeSubSearch=name||'';
  state.showRecipeSubForm=false;
  renderMain();
  const tabs=document.getElementById('recipeTabs');
  if(tabs) tabs.scrollIntoView({block:'nearest'});
}
function onRecipeSubSearch(el){
  focusId='recipeSubSearch'; focusPos=el.selectionStart;
  state.recipeSubSearch=el.value; renderMain();
}

function viewDetail(){
  const r=recipes.find(x=>x.id===state.currentRecipeId);
  if(!r) return `<div class="empty">Recipe not found.</div>`;
  const mult=state.scale[r.id]||1;
  const pairs=subsForRecipe(r);
  const applied=state.appliedSubs[r.id]||{};
  const nApplied=Object.keys(applied).length;
  const cover=coverImage(r);
  const onSubs=state.detailTab==='substitutions';
  const total=totalMinutes(r);
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
    ${renderFacts(r)}
    ${renderNotesBand(r)}
    <div class="scale-row no-print">
      <label>Scale recipe:</label>
      ${[0.5,1,2,3].map(v=>`<button class="scale-btn ${mult===v?'active':''}" onclick="setScale('${r.id}',${v})">${v===0.5?'½':v}×</button>`).join('')}
      <span style="color:var(--dim);font-size:12.5px;">or custom:</span>
      <input type="number" min="0.1" step="0.1" value="${mult}" onchange="setScale('${r.id}', parseFloat(this.value)||1)">
      <span style="color:var(--dim);font-size:12.5px;">→ serves ${Math.round(r.baseServings*mult*10)/10}</span>
    </div>

    <div class="cook-cols">
      <div>
        <div class="col-head">Ingredients
          <span>${r.ingredients.length} item${r.ingredients.length===1?'':'s'}${
            nApplied?` · ${nApplied} swapped`:''}</span></div>
        ${renderIngredients(r,mult,applied)}
        <button class="icon-btn no-print" style="width:100%;margin-top:12px;"
          onclick="addRecipeToShoppingList('${r.id}')">🛒 Add all to shopping list</button>
      </div>
      <div>
        <div class="col-tabs no-print" id="recipeTabs">
          <button class="tab ${onSubs?'':'active'}" onclick="setTab('instructions')">Instructions</button>
          <button class="tab ${onSubs?'active':''}" onclick="setTab('substitutions')">Substitutions${pairs.length?` (${pairs.length})`:''}</button>
          <span class="meta">${onSubs
            ? `${nApplied} applied`
            : `${r.instructions.length} step${r.instructions.length===1?'':'s'}${total?` · ${total} min total`:''}`}</span>
        </div>
        <!-- Both panels are rendered and the inactive one is hidden with CSS.
             Leaving one out of the HTML is what used to make Print lose half the
             recipe, since a print stylesheet can only hide what is already there. -->
        <div class="tab-panel ${onSubs?'is-hidden':''}">${renderSteps(r, applied)}</div>
        <div class="tab-panel no-print ${onSubs?'':'is-hidden'}">${renderSubTab(r,pairs,applied)}</div>
      </div>
    </div>
    ${renderPhotoSection(r)}
    ${renderRatingsSection(r)}`;
}
function renderIngredients(r,mult,applied){
  return `<ul class="ing-list compact">${r.ingredients.map(i=>{
    const sw=applied[i.id];
    const subsHere=subsForName(i.name).length + (r.localSubs||[]).filter(s=>subMatches(s.ingredient,i.name)).length;
    return `<li class="${sw?'swapped':''}">
      <span><span class="qty">${fmtQty(i.qty*mult)} ${esc(i.unit)}</span>
      ${sw
        ? `<s>${esc(i.name)}</s> → <button class="ingword strong" onclick="jumpToSubs('${jsq(i.name)}')"
             title="See substitutions for ${escA(i.name)}">${esc(sw.substitute)}</button><span class="swap-tag">substituted</span>`
        : `<button class="ingword" onclick="jumpToSubs('${jsq(i.name)}')"
             title="${subsHere?`${subsHere} substitution${subsHere===1?'':'s'} available`:'See substitutions'}"
             >${esc(i.name)}</button>${subsHere?`<span class="sub-count">${subsHere}</span>`:''}`}</span>
      <span style="display:flex;gap:6px;" class="no-print">
        ${sw?`<button class="ing-add" style="border-color:var(--swap-line);color:var(--swap-ink);" onclick="unapplySub('${r.id}','${i.id}')">↩ undo</button>`:''}
        <button class="ing-add" onclick="addSingleIngredient('${r.id}','${i.id}')">+ list</button>
      </span></li>`;
  }).join('')}</ul>
  ${Object.keys(applied).length?`<div class="notice no-print" style="margin-top:14px;">⚠️ Highlighted rows are <b>temporary</b> substitutions for this cooking session only. They'll revert when you leave the recipe.</div>`:''}`;
}
function renderSubTab(r,pairs,applied){
  const q=(state.recipeSubSearch||'').trim().toLowerCase();
  const shown = q ? pairs.filter(p=>
      p.sub.ingredient.toLowerCase().includes(q) ||
      p.sub.substitute.toLowerCase().includes(q) ||
      (p.sub.notes||'').toLowerCase().includes(q) ||
      p.ing.name.toLowerCase().includes(q)) : pairs;
  return `
    <div class="controls no-print" style="margin-bottom:14px;">
      <div class="search-wrap"><span class="sicon">🔍</span>
        <input id="recipeSubSearch" type="text" placeholder="Filter this recipe's substitutions..."
          value="${escA(state.recipeSubSearch||'')}" oninput="onRecipeSubSearch(this)"></div>
      ${q?`<button class="icon-btn sm" onclick="jumpToSubs('')">✕ Clear</button>`:''}
    </div>
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
    ${pairs.length===0
      ? `<div class="empty">No substitutions match this recipe's ingredients yet.<br>Add one above, or build up your library in the Substitutions section.</div>`
      : shown.length===0
        ? `<div class="empty">Nothing here matches "${esc(state.recipeSubSearch)}".</div>`
        : shown.map(p=>{
      const isApplied = applied[p.ing.id] && applied[p.ing.id].substitute===p.sub.substitute;
      return `<div class="sub-card">
        <div><b>${esc(p.sub.ingredient)}</b> → ${esc(p.sub.substitute)}
          <span class="scope-tag ${p.sub.scope==='library'?'scope-library':'scope-recipe'}">${p.sub.scope==='library'?'library':'this recipe'}</span>
          ${p.sub.notes?`<div class="note">${esc(p.sub.notes)}</div>`:''}
          <div class="note">matches ingredient: <i>${esc(p.ing.name)}</i></div></div>
        <button class="icon-btn sm no-print ${isApplied?'':'primary'}" onclick="${isApplied?`unapplySub('${r.id}','${p.ing.id}')`:`applySub('${r.id}','${p.ing.id}','${p.sub.id}')`}">
          ${isApplied?'✓ Applied — undo':'Use in list'}</button>
      </div>`;
    }).join('')}
    ${q&&shown.length&&shown.length<pairs.length?`<div class="subtle" style="margin-top:12px;font-size:12.5px;">
      Showing ${shown.length} of ${pairs.length}.</div>`:''}`;
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
    ${state.showRateForm?`
    <div class="panel no-print" style="margin-bottom:18px;">
      <div style="font-weight:700;font-size:13.5px;margin-bottom:8px;">Rate this recipe <span style="font-weight:400;color:var(--dim);">(also logs a cook — bumps your Most Used count)</span></div>
      ${[1,2,3,4,5].map(n=>`<span class="starpick ${n<=state.starDraft?'on':''}" onclick="state.starDraft=${n}; renderMain();">★</span>`).join('')}
      <textarea id="commentDraft" placeholder="Optional comment — what worked, what you'd change..." rows="2" style="width:100%;margin-top:10px;padding:10px 12px;border-radius:3px;border:1px solid var(--rule);font-size:15px;background:var(--panel);color:var(--cream);font-family:var(--body);"></textarea>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="icon-btn" onclick="state.showRateForm=false; renderMain();">Cancel</button>
        <button class="icon-btn primary" onclick="submitRating('${r.id}')">Submit Rating</button>
      </div>
    </div>`:`
    <div class="rate-fold no-print">
      <button class="icon-btn primary" onclick="state.showRateForm=true; renderMain();">★ Rate this recipe</button>
      <span class="subtle" style="margin:0;font-size:13.5px;">Rating also logs a cook.</span>
    </div>`}
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
    await apiJSON('/api/recipes/'+id+'/ratings','POST',{stars,comment:c,day:localDay()});
    state.starDraft=0; state.showRateForm=false;
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
  clearMentionChoices(recipeId, ingId);
  state.detailTab='instructions';
  render(); toast(`Swapped "${ing.name}" → "${s.substitute}" (temporary)`);
  promptAmbiguousMentions(r, ingId);
}
function unapplySub(recipeId,ingId){
  if(state.appliedSubs[recipeId]){
    delete state.appliedSubs[recipeId][ingId];
    if(!Object.keys(state.appliedSubs[recipeId]).length) delete state.appliedSubs[recipeId];
  }
  clearMentionChoices(recipeId, ingId);
  closeMentionNote();
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

  const after=(msg)=>{ state.showRecipeSubForm=false; state.detailTab='substitutions'; state.recipeSubSearch=''; render(); toast(msg); };
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
    tags:r.tags||[], dateAdded:localDay(),
    baseServings:r.baseServings||4, emoji:r.emoji||'🍽️',
    ratings:[], timesCooked:0, localSubs:[], images:[],
    notes:'', cookbookId:null, cookbookPage:'', prepMinutes:0, cookMinutes:0,
    ingredients:ings, instructions:r.instructions||[],
  };
  state.scanSource={image:state.scanImage, flagged:res.flagged||[], notes:res.notes||''};
  state.view='editRecipe'; markEditBaseline(); render();
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
    state.editing=blankRecipeDraft();
    state.view='editRecipe'; markEditBaseline(); render();
  });
}
function startEditRecipe(id){
  attemptNav(()=>{
    state.scanSource=null; state.scanImage=null;
    state.editing=JSON.parse(JSON.stringify(recipes.find(x=>x.id===id)));
    state.view='editRecipe'; markEditBaseline(); render();
  });
}
function editBar(title, saveLabel, saveFn, cancelFn){
  const dirty = isEditDirty();
  return `<div class="editbar no-print">
    <h1>${esc(title)}</h1>
    ${dirty?`<span class="dirty">● unsaved changes</span>`:''}
    <div class="right">
      <button class="icon-btn" onclick="${cancelFn}">Cancel</button>
      <button class="icon-btn primary" onclick="${saveFn}">💾 ${esc(saveLabel)}</button>
    </div>
  </div>`;
}
function viewEditRecipe(){
  const e=state.editing, isNew=!e.id;
  const total=(e.prepMinutes||0)+(e.cookMinutes||0);
  return `
    ${editBar(state.scanSource?'Review Scanned Recipe':(isNew?'Add New Recipe':'Edit Recipe'),
      'Save Recipe','saveEdit()','cancelEdit()')}
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
      </div>`:''}

    <div class="fsec">
      <h2>The basics</h2>
      <div class="fsec-body">
        <div class="fgrid narrow" style="grid-template-columns:1fr 130px;">
          <div class="form-row" style="margin:0;"><label>Title</label>
            <input type="text" id="f_title" value="${escA(e.title)}" placeholder="Lemon Bread"></div>
          <div class="form-row" style="margin:0;"><label>Emoji</label>
            <input type="text" id="f_emoji" value="${escA(e.emoji)}" style="text-align:center;"
              oninput="stashEditForm()"></div>
        </div>
        ${renderEmojiPicker('recipe', e.emoji, 'f_emoji')}

        <div class="form-row" style="margin:22px 0 0;"><label>Categories</label>
          <div class="cat-picker">
            ${allCategories.map((c,i)=>`<span class="cat-chip ${e.categories.includes(c)?'on':''}" onclick="toggleCat(${i})">${e.categories.includes(c)?'✓':'+'} ${esc(c)}</span>`).join('')}
          </div>
          <div style="display:flex;gap:8px;max-width:420px;">
            <input type="text" id="f_newcat" placeholder="Create a new category..."
              onkeydown="if(event.key==='Enter'){event.preventDefault();addCategory();}"
              style="flex:1;padding:9px 12px;border-radius:3px;border:1px solid var(--rule);font-size:14px;background:var(--panel);color:var(--cream);font-family:var(--body);">
            <button class="icon-btn" onclick="addCategory()">+ Add</button>
          </div>
        </div>

        <div class="form-row narrow" style="margin:22px 0 0;"><label>Tags (comma separated)</label>
          <input type="text" id="f_tags" value="${escA(e.tags.join(', '))}" placeholder="citrus, baking"></div>
      </div>
    </div>

    <div class="fsec">
      <h2>Timing &amp; source <span class="hint">all optional</span></h2>
      <div class="fsec-body">
        <div class="fgrid" style="grid-template-columns:repeat(4,1fr);max-width:760px;">
          <div class="form-row" style="margin:0;"><label>Serves</label>
            <input type="text" id="f_servings" value="${escA(String(e.baseServings))}"></div>
          <div class="form-row" style="margin:0;"><label>Prep (min)</label>
            <input type="text" id="f_prep" value="${e.prepMinutes||''}" placeholder="15" inputmode="numeric"
              oninput="stashEditForm(); refreshTotalNote();"></div>
          <div class="form-row" style="margin:0;"><label>Cook (min)</label>
            <input type="text" id="f_cook" value="${e.cookMinutes||''}" placeholder="55" inputmode="numeric"
              oninput="stashEditForm(); refreshTotalNote();"></div>
          <div class="form-row" style="margin:0;"><label>Page</label>
            <input type="text" id="f_cookbook_page" value="${escA(e.cookbookPage||'')}" placeholder="112"></div>
        </div>
        <div class="total-note" id="totalNote">${total?`→ ${fmtTotal(total)} total`:'&nbsp;'}</div>
        <div class="form-row narrow" style="margin:16px 0 0;"><label>From a cookbook?</label>
          <select id="f_cookbook" onchange="stashEditForm()">
            <option value="">— Not from a cookbook —</option>
            ${cookbooks.map(b=>`<option value="${b.id}" ${e.cookbookId===b.id?'selected':''}>${esc(b.title)}${b.author?` — ${esc(b.author)}`:''}</option>`).join('')}
          </select>
          ${cookbooks.length?'':`<div class="subtle" style="font-size:12px;margin-top:6px;">
            No cookbooks yet — add one in the Cookbooks section and it will appear here.</div>`}
        </div>
      </div>
    </div>

    <div class="fsec">
      <h2>Notes <span class="hint">shown above the recipe when you cook it</span></h2>
      <div class="fsec-body">
        <textarea id="f_notes" rows="3" placeholder="Tweaks you made, what to serve it with, who liked it..."
          style="width:100%;max-width:640px;padding:11px 13px;border-radius:3px;border:1px solid var(--rule);font-size:15px;background:var(--panel);color:var(--cream);font-family:var(--body);"
          oninput="stashEditForm()">${esc(e.notes||'')}</textarea>
      </div>
    </div>

    <div class="edit-cols">
      <div class="fsec" style="margin-bottom:0;">
        <h2>Ingredients <span class="hint">${e.ingredients.length}</span></h2>
        <div class="fsec-body">
          <div class="ing-cols"><span></span><span>Qty</span><span>Unit</span><span>Ingredient</span><span></span></div>
          ${e.ingredients.map((i,idx)=>{
            const flag=state.scanSource&&state.scanSource.flagged.includes(idx);
            return `<div class="ing-row2 ${flag?'needs-review':''}" draggable="false"
              ondragstart="ingDragStart(event,${idx})" ondragover="ingDragOver(event)"
              ondragleave="ingDragLeave(event)" ondrop="ingDrop(event,${idx})" ondragend="ingDragEnd(event)">
            <span class="grip" title="Drag to reorder"
              onmousedown="armIngDrag(this)" onmouseup="disarmIngDrag(this)">⠿</span>
            <input class="mono" placeholder="1" value="${escA(i.qtyRaw!=null?i.qtyRaw:fmtQty(i.qty))}"
              oninput="editIngField(${idx},'qty',this.value)">
            <input class="mono" placeholder="—" value="${escA(i.unit)}"
              oninput="editIngField(${idx},'unit',this.value)" list="unitList">
            <input placeholder="ingredient name" value="${escA(i.name)}"
              oninput="editIngField(${idx},'name',this.value)">
            <button class="kill" title="Remove" onclick="removeIng(${idx})">×</button></div>`;}).join('')}
          <datalist id="unitList">${['cup','cups','tbsp','tsp','oz','lb','g','kg','ml','l','cloves','pinch','can','slices','sprigs']
            .map(u=>`<option value="${u}">`).join('')}</datalist>
          <div class="rowbtns">
            <button class="dashed-add" style="width:auto;flex:1;" onclick="addIngRow()">+ Add ingredient</button>
            <button class="icon-btn" onclick="openPaste('ingredients')">📋 Paste a list</button>
          </div>
          <div class="subtle" style="font-size:12px;margin:10px 0 0;">
            Quantities take fractions — <code>1/2</code>, <code>1 1/2</code>, <code>¾</code>.</div>
        </div>
      </div>

      <div class="fsec" style="margin-bottom:0;">
        <h2>Instructions <span class="hint">${e.instructions.length} step${e.instructions.length===1?'':'s'}</span></h2>
        <div class="fsec-body">
          ${e.instructions.map((s,idx)=>`<div class="step2" draggable="false"
              ondragstart="stepDragStart(event,${idx})" ondragover="stepDragOver(event)"
              ondragleave="stepDragLeave(event)" ondrop="stepDrop(event,${idx})" ondragend="stepDragEnd(event)">
            <span class="grip" title="Drag to reorder"
              onmousedown="armDrag(this)" onmouseup="disarmDrag(this)">⠿</span>
            <span class="num">${idx+1}</span>
            <textarea oninput="editStep(${idx},this.value)">${esc(s)}</textarea>
            <span>
              <button class="mv" title="Move up" ${idx===0?'disabled':''} onclick="moveStep(${idx},${idx-1})">↑</button>
              <button class="mv" title="Move down" ${idx===e.instructions.length-1?'disabled':''} onclick="moveStep(${idx},${idx+1})">↓</button>
            </span>
            <button class="kill" title="Remove" onclick="removeStep(${idx})">×</button></div>`).join('')}
          <div class="rowbtns">
            <button class="dashed-add" style="width:auto;flex:1;" onclick="addStepRow()">+ Add step</button>
            <button class="icon-btn" onclick="openPaste('steps')">📋 Paste steps</button>
          </div>
        </div>
      </div>
    </div>

    <div class="fsec" style="margin-top:34px;">
      <h2>Record</h2>
      <div class="fsec-body">
        <div class="record-strip">
          <div><span class="fl">Times cooked</span>
            <input type="text" id="f_cooked" value="${e.timesCooked||0}" inputmode="numeric"
              oninput="stashEditForm()"></div>
          <div class="record-note">Normally earned one meal at a time. Changing it here rewrites the history
            behind your Most Cooked rankings, so it asks before saving.</div>
          ${isNew?'':`<div class="danger-side">
            <button class="icon-btn danger" onclick="confirmDeleteRecipe('${e.id}')">🗑 Delete this recipe</button></div>`}
        </div>
      </div>
    </div>`;
}
function fmtTotal(n){
  if(!n) return '';
  if(n<60) return `${n} min`;
  const h=Math.floor(n/60), m=n%60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}
/* The total is the one thing on this form derived from other fields, so it
   updates in place rather than forcing a redraw that would cost you focus. */
/* The unsaved marker has to react to typing, but a redraw on every keystroke
   would steal the caret. This patches just the pill. */
function refreshDirtyFlag(){
  const bar=document.querySelector('.editbar');
  if(!bar) return;
  const on=isEditDirty();
  const pill=bar.querySelector('.dirty');
  if(on && !pill){
    const el=document.createElement('span');
    el.className='dirty'; el.textContent='● unsaved changes';
    bar.querySelector('h1').insertAdjacentElement('afterend', el);
  } else if(!on && pill){ pill.remove(); }
}
document.addEventListener('input', ()=>{ if(inEditForm()) refreshDirtyFlag(); });
function refreshTotalNote(){
  const el=document.getElementById('totalNote');
  if(!el || !state.editing) return;
  const t=(state.editing.prepMinutes||0)+(state.editing.cookMinutes||0);
  el.innerHTML = t ? `→ ${fmtTotal(t)} total` : '&nbsp;';
}
function stashEditForm(){
  const e=state.editing;
  const g=id=>document.getElementById(id);
  if(g('f_title')) e.title=g('f_title').value;
  if(g('f_servings')) e.baseServings=parseFloat(g('f_servings').value)||1;
  const mins=el=>{ const n=parseInt(el.value,10); return Number.isFinite(n)&&n>0?n:0; };
  if(g('f_prep')) e.prepMinutes=mins(g('f_prep'));
  if(g('f_cook')) e.cookMinutes=mins(g('f_cook'));
  if(g('f_emoji')) e.emoji=g('f_emoji').value||'🍽️';
  if(g('f_cooked')){
    const n=parseInt(g('f_cooked').value,10);
    e.timesCooked = Number.isFinite(n) && n>=0 ? n : 0;
  }
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
/* ---- reordering steps ----
 * The row is only draggable while the mouse is held on the handle, otherwise
 * selecting text inside the textarea would start a drag instead.
 */
let dragStepIndex = null;
function armDrag(el){ const row=el.closest('.step-row-edit'); if(row) row.draggable=true; }
function disarmDrag(el){ const row=el.closest('.step-row-edit'); if(row) row.draggable=false; }
function stepDragStart(ev, idx){
  dragStepIndex = idx;
  ev.dataTransfer.effectAllowed='move';
  try{ ev.dataTransfer.setData('text/plain', String(idx)); }catch(e){}
  ev.currentTarget.classList.add('dragging');
}
function stepDragOver(ev){
  if(dragStepIndex===null) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect='move';
  ev.currentTarget.classList.add('drop-target');
}
function stepDragLeave(ev){ ev.currentTarget.classList.remove('drop-target'); }
function stepDrop(ev, idx){
  ev.preventDefault();
  ev.currentTarget.classList.remove('drop-target');
  const from = dragStepIndex !== null ? dragStepIndex : parseInt(ev.dataTransfer.getData('text/plain'),10);
  dragStepIndex = null;
  moveStep(from, idx);
}
function stepDragEnd(ev){
  dragStepIndex = null;
  ev.currentTarget.draggable = false;
  document.querySelectorAll('.step-row-edit').forEach(r=>
    r.classList.remove('dragging','drop-target'));
}
function moveStep(from, to){
  const arr = state.editing && state.editing.instructions;
  if(!arr) return;
  if(!Number.isInteger(from) || !Number.isInteger(to)) return;
  if(from===to || from<0 || to<0 || from>=arr.length || to>=arr.length) return;
  const [item] = arr.splice(from,1);
  arr.splice(to,0,item);
  renderMain();
}

function cancelEdit(){
  guardEdit(()=>{ clearEditDraft(); state.view='browse'; render(); });
}
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
/* Cook count is normally earned one meal at a time, so an edit that changes it
   asks first — it's easy to fat-finger and impossible to recover afterwards. */
async function saveEdit(){
  stashEditForm();
  const e=state.editing;
  const original = e.id ? recipes.find(r=>r.id===e.id) : null;
  const was = original ? (original.timesCooked||0) : 0;
  const now = e.timesCooked||0;
  if(original && now !== was){
    showModal({
      title:'Change the cook count?',
      body:`<b>${esc(original.title)}</b> is recorded as cooked <b>${was} time${was===1?'':'s'}</b>.
        You're changing that to <b>${now} time${now===1?'':'s'}</b>.<br><br>
        This rewrites the history behind your Most Cooked rankings, and the old number isn't recoverable.
        Everything else on the form saves either way.`,
      buttons:[
        {label:'Keep it at '+was, action:()=>{ e.timesCooked = was; commitEdit(); }},
        {label:'Cancel'},
        {label:`Change to ${now}`, style:'primary', action:commitEdit},
      ]
    });
    return;
  }
  commitEdit();
}
async function commitEdit(){
  const e=state.editing;
  if(!e) return;
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
    prepMinutes:e.prepMinutes||0,
    cookMinutes:e.cookMinutes||0,
    timesCooked:e.timesCooked||0,
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
    clearEditDraft();
    const saved=recipes.find(r=>r.id===id);
    const found=saved?subsForRecipe(saved).length:0;
    openRecipe(id);
    toast(found?`Saved — auto-found ${found} substitution${found!==1?'s':''} for these ingredients.`:'Recipe saved.');
  }catch(err){ apiError(err); }
}

/* ============ SUBSTITUTIONS LIBRARY ============
 * Three substitutes for butter are one question with three answers, not three
 * unrelated rows — so entries are grouped by the ingredient they replace.
 * Recipe-only entries appear here too. They were previously invisible on this
 * page: saved, matched, working, and unreachable except by remembering which
 * recipe you added them from.
 */
function allSubEntries(){
  const out = globalSubs.map(s => ({ ...s, scope:'library', recipe:null }));
  recipes.forEach(r => (r.localSubs||[]).forEach(s =>
    out.push({ ...s, scope:'recipe', recipe:r })));
  return out;
}
function subGroups(){
  const map = new Map();
  allSubEntries().forEach(e => {
    const key = normIng(e.ingredient);
    if(!key) return;
    if(!map.has(key)) map.set(key, { key, name: titleCase(e.ingredient), entries: [] });
    map.get(key).entries.push(e);
  });
  const groups = [...map.values()];
  groups.forEach(g => {
    g.recipes = recipes.filter(r => r.ingredients.some(i => subMatches(g.name, i.name)));
    g.localCount = g.entries.filter(e => e.scope === 'recipe').length;
  });
  // what you can actually use comes first; the rest is still there, just later
  return groups.sort((a,b) => b.recipes.length - a.recipes.length || a.name.localeCompare(b.name));
}
const SUB_SCOPES = [
  { key:'all',     label:'All' },
  { key:'library', label:'Library' },
  { key:'recipe',  label:'Recipe-only' },
  { key:'unused',  label:'Unused' },
];
function setSubScope(k){ state.subScope=k; renderMain(); }
function toggleSubGroup(k){ state.expandedSubGroups[k]=!state.expandedSubGroups[k]; renderMain(); }
function onSubSearch(el){ focusId='subSearch'; focusPos=el.selectionStart; state.subSearch=el.value; renderMain(); }

function visibleSubGroups(){
  const q = state.subSearch.trim().toLowerCase();
  const scope = state.subScope || 'all';
  return subGroups().map(g => {
    let entries = g.entries;
    if(scope === 'library') entries = entries.filter(e => e.scope === 'library');
    if(scope === 'recipe')  entries = entries.filter(e => e.scope === 'recipe');
    if(q) entries = entries.filter(e =>
      e.ingredient.toLowerCase().includes(q) ||
      e.substitute.toLowerCase().includes(q) ||
      (e.notes||'').toLowerCase().includes(q) ||
      g.recipes.some(r => r.title.toLowerCase().includes(q)));
    return { ...g, entries };
  }).filter(g => g.entries.length && (state.subScope !== 'unused' || g.recipes.length === 0));
}
async function promoteSub(id){
  try{
    await apiJSON('/api/substitutions/'+id+'/promote','POST');
    render(); toast('Moved into your library — it now applies to every recipe using that ingredient.');
  }catch(e){ apiError(e); }
}
function openSubRecipe(id){ openRecipe(id); }

function renderSubGroup(g){
  const open = !!state.expandedSubGroups[g.key];
  const n = g.recipes.length;
  const onlyLocal = g.entries.every(e => e.scope === 'recipe');
  const applies = n === 0
    ? `No recipe uses ${g.name.toLowerCase()} yet`
    : `${open ? '▾' : '▸'} Applies to ${n} recipe${n===1?'':'s'}`;
  return `<div class="ing-group${onlyLocal?' local':''}${n===0?' idle':''}">
    <div class="ig-head">
      <span class="ig-name">${esc(g.name)}</span>
      ${onlyLocal?`<span class="scope-tag scope-recipe">this recipe only</span>`:''}
      <span class="ig-count">${g.entries.length} option${g.entries.length===1?'':'s'}${
        n?` · ${n} recipe${n===1?'':'s'}`:''}</span>
    </div>
    ${g.entries.map(e => `<div class="ig-opt">
      <span class="ig-arrow">→</span>
      <div style="min-width:0;flex:1;">
        <div class="ig-sub">${esc(e.substitute)}${
          e.scope==='recipe' && !onlyLocal
            ? `<span class="scope-tag scope-recipe">only on ${esc(e.recipe?e.recipe.title:'a recipe')}</span>` : ''}</div>
        ${e.notes?`<div class="ig-note">${esc(e.notes)}</div>`:''}
        ${e.scope==='recipe'&&e.recipe?`<div class="ig-note">added while cooking
          <button class="feed-link" style="font-size:11.5px;"
            onclick="openSubRecipe('${e.recipe.id}')">${esc(e.recipe.title)}</button></div>`:''}
      </div>
      ${e.scope==='recipe'
        ? `<button class="promote" title="Make this apply to every recipe using ${escA(g.name)}"
             onclick="promoteSub('${e.id}')">↑ Promote to library</button>`
        : ''}
      <button class="ig-x" title="Remove" onclick="removeGlobalSub('${e.id}')">×</button>
    </div>`).join('')}
    <div class="ig-foot">
      <button class="applies"${n?` onclick="toggleSubGroup('${jsq(g.key)}')"`:''}>${applies}</button>
      ${open&&n?`<div class="rchips">${g.recipes.map(r=>`
        <button class="rchip" onclick="openSubRecipe('${r.id}')"><i>${r.emoji}</i>${esc(r.title)}</button>`).join('')}</div>`:''}
    </div>
  </div>`;
}

function viewSubstitutions(){
  const groups = visibleSubGroups();
  const all = subGroups();
  const totalEntries = allSubEntries().length;
  const localTotal = all.reduce((t,g)=>t+g.localCount, 0);
  const unusedTotal = all.filter(g=>g.recipes.length===0).length;
  const counts = { all: totalEntries, library: globalSubs.length,
                   recipe: localTotal, unused: unusedTotal };
  return `
    <div class="sec-head" style="border:none;padding:0;margin-bottom:4px;">
      <h1 class="title">Substitutions</h1>
      <button class="icon-btn primary no-print"
        onclick="state.showSubAddForm=!state.showSubAddForm; renderMain();">
        ${state.showSubAddForm?'✕ Close':'+ Add substitution'}</button>
    </div>
    <p class="subtle">${totalEntries} entr${totalEntries===1?'y':'ies'} across ${all.length}
      ingredient${all.length===1?'':'s'}${localTotal?` · ${localTotal} tied to a single recipe`:''}.
      Every one is matched to any recipe using that ingredient automatically.</p>

    ${state.showSubAddForm?`
    <div class="panel no-print" style="max-width:660px;margin-bottom:22px;">
      <div class="form-row"><label>Ingredient</label><input type="text" id="sub_ing" placeholder="e.g. buttermilk"></div>
      <div class="form-row"><label>Substitute</label><input type="text" id="sub_replace" placeholder="e.g. milk + lemon juice"></div>
      <div class="form-row" style="margin-bottom:8px;"><label>Notes (optional)</label><input type="text" id="sub_notes" placeholder="e.g. let sit 5 minutes"></div>
      <button class="icon-btn primary" onclick="addGlobalSub()">+ Add Substitution</button>
    </div>`:''}

    <div class="controls">
      <div class="search-wrap"><span class="sicon">🔍</span>
        <input id="subSearch" type="text" placeholder="Search by ingredient, substitute, note, or recipe..."
          value="${escA(state.subSearch)}" oninput="onSubSearch(this)"></div>
      <div class="scope-chips no-print">
        ${SUB_SCOPES.map(sc=>`<button class="schip ${((state.subScope||'all')===sc.key)?'on':''}"
          onclick="setSubScope('${sc.key}')">${sc.label} ${counts[sc.key]}</button>`).join('')}
      </div>
    </div>

    ${groups.length===0
      ? `<div class="empty">${totalEntries===0
          ? 'Nothing here yet. Add a substitution and it will apply to every recipe using that ingredient.'
          : state.subSearch.trim()
            ? `Nothing matches "${esc(state.subSearch)}".`
            : 'Nothing in this filter.'}</div>`
      : `<div class="sub-grid">${groups.map(renderSubGroup).join('')}</div>`}`;
}
function addGlobalSub(){
  const ing=titleCase(document.getElementById('sub_ing').value);
  const rep=document.getElementById('sub_replace').value.trim();
  const notes=document.getElementById('sub_notes').value.trim();
  if(!ing||!rep){ toast('Fill in both ingredient and substitute.'); return; }
  const similar=subsForName(ing);
  const doAdd=async()=>{
    try{ await apiJSON('/api/substitutions','POST',{ingredient:ing,substitute:rep,notes});
      state.showSubAddForm=false;
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
            state.showSubAddForm=false;
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
/* How many to buy. Quantities accept the same fractions ingredients do, so
   "1 1/2" and "½" are as valid here as "2". */
async function setShopQty(id, val){
  const it=shoppingList.find(s=>s.id===id);
  if(!it) return;
  const q=parseQty(val);
  if(!q || q<=0){ renderMain(); toast('Enter an amount like 2, 1/2 or 1 1/2.'); return; }
  const was=it.qty;
  it.qty=q; renderMain();                          // optimistic: a stepper must feel instant
  try{ await apiJSON('/api/shopping/'+id,'PATCH',{qty:q}); renderMain(); }
  catch(e){ it.qty=was; renderMain(); apiError(e); }
}
function bumpShopQty(id, dir){
  const it=shoppingList.find(s=>s.id===id);
  if(!it) return;
  const cur=it.qty||1;
  // under 1 the useful step is a quarter — "half a cup" is a real amount to buy
  const step=(dir>0 ? (cur<1?0.25:1) : (cur<=1?0.25:1))*dir;
  const next=Math.max(0.25, Math.round((cur+step)*100)/100);
  if(next===cur) return;
  setShopQty(id, String(next));
}
async function setShopUnit(id, val){
  const it=shoppingList.find(s=>s.id===id);
  if(!it || String(val).trim()===(it.unit||'')) return;
  try{ await apiJSON('/api/shopping/'+id,'PATCH',{unit:String(val).trim()}); renderMain(); }
  catch(e){ apiError(e); }
}
async function addManualShopItem(){
  const el=document.getElementById('manualItem'); const v=titleCase(el.value);
  if(!v){ el.focus(); return; }
  const qEl=document.getElementById('manualQty');
  const uEl=document.getElementById('manualUnit');
  const qty=parseQty(qEl?qEl.value:1)||1;
  const unit=uEl?uEl.value.trim():'';
  try{
    await apiJSON('/api/shopping','POST',{name:v,qty,unit,fromRecipe:'manual'});
    render(); toast(`Added ${fmtQty(qty)}${unit?' '+unit:''} ${v}.`);
  }catch(e){ apiError(e); }
}
function viewShopping(){
  return `
    <h1 class="title">Shopping List</h1>
    <p class="subtle">Ingredients pulled from recipes, plus anything you add by hand. Set how many of
      each you want with the − and + steppers, and each item shows substitutions from your library.</p>
    <div class="controls no-print">
      <div class="search-wrap" style="flex:2;"><input id="manualItem" type="text"
        placeholder="Add an item manually, e.g. olive oil" style="padding-left:14px;"
        onkeydown="if(event.key==='Enter'){event.preventDefault();addManualShopItem();}"></div>
      <input id="manualQty" class="add-qty" type="text" value="1" title="How many to buy"
        aria-label="How many" onkeydown="if(event.key==='Enter'){event.preventDefault();addManualShopItem();}">
      <input id="manualUnit" class="add-unit" type="text" placeholder="unit" title="Optional unit"
        aria-label="Unit" onkeydown="if(event.key==='Enter'){event.preventDefault();addManualShopItem();}">
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
          <div class="qbox no-print">
            <button class="qstep" title="One fewer" onclick="bumpShopQty('${it.id}',-1)">−</button>
            <input class="qin" type="text" value="${escA(fmtQty(it.qty))}" aria-label="How many"
              onchange="setShopQty('${it.id}',this.value)"
              onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}">
            <input class="uin" type="text" value="${escA(it.unit||'')}" placeholder="unit" aria-label="Unit"
              onchange="setShopUnit('${it.id}',this.value)"
              onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}">
            <button class="qstep" title="One more" onclick="bumpShopQty('${it.id}',1)">+</button>
          </div>
          <div style="min-width:0;">
            <div class="sname"><span class="print-only">${fmtQty(it.qty)} ${esc(it.unit)} </span>${esc(it.name)}</div>
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
          <div class="srow"><div>→ <b>${esc(s.substitute)}</b>${s.notes?`<div class="note" style="font-size:11.5px;color:var(--dim);">${esc(s.notes)}</div>`:''}</div>
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
    applyUrl();            // deep links need the data before they can resolve an id
    routeReady = true;
    syncUrl(true);         // normalise "/" to "/home" without adding a history entry
    render();
  }catch(e){
    document.getElementById('app').innerHTML =
      '<div class="boot-error"><h1>Could not load your recipes</h1>' +
      '<p>' + esc(e.message || String(e)) + '</p>' +
      '<button class="icon-btn primary" onclick="location.reload()">Try again</button></div>';
  }
}
boot();
