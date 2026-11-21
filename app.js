/* ==========================================================================
 *  提示词工作台 · app.js
 *  ------------------------------------------------------------------------
 *  数据层（localStorage / IndexedDB / 导入导出 JSON 结构）与旧版完全一致，
 *  仅重写外壳交互：沉浸式状态栏、大标题滚动模糊、液态玻璃 Tab（横滑联动 +
 *  可拖动滑块）、点击变身搜索、长按卡片动作面板、底部 Sheet。
 *
 *  外部事件一览：
 *    switchView / setCat / setTag / setFilter / chooseSort / chooseSort
 *    openEdit / savePrompt / openApply / openVersion / openTrans ...
 *    全部挂到 window，供 HTML 内联 onclick 调用（与旧版同名同参）。
 * ========================================================================== */

/* ============================================================
 * 0. 数据层（原样保留）
 * ============================================================ */
const STORE_KEY = 'prompt_workbench_v3';
const COLORS = ['#007AFF','#34C759','#FF9500','#FF3B30','#AF52DE','#FFCC00','#5AC8FA','#8E8E93'];
const GROUP_ICONS = ['📷','🎨','✨','👤','🌃','🌸','⚡','🎬','🖼','🔥','🌊','🍂'];
const AVATARS = ['🎨','📷','✨','🌟','🎬','🌸','🌊','🚀','🍀','🦋'];

function cid(){ return Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4); }

let state = {
  profile: {name:'我的相册', avatar:'🎨'},
  categories: [
    {id:cid(), name:'人像', color:COLORS[0]},
    {id:cid(), name:'风格', color:COLORS[1]},
    {id:cid(), name:'光影', color:COLORS[2]},
    {id:cid(), name:'构图场景', color:COLORS[4]},
  ],
  prompts: [],
  groups: [
    {id:cid(), name:'满意作品', color:COLORS[1], icon:'📷'},
    {id:cid(), name:'风格测试', color:COLORS[2], icon:'🎨'},
  ],
  gallery: [],
  modelConfigs: [],
  activeConfigId: null,
  history: [],
  settings: {provider:'openai', baseUrl:'https://api.openai.com/v1', apiKey:'', model:'gpt-4o-mini', temperature:0.7},
  ui: {activeCat:'all', activeTag:null, activeGroup:'all', search:'', view:'library', filter:'all', sort:'updated'}
};

function load(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(raw){
      const d = JSON.parse(raw);
      state = Object.assign(state, d);
      state.ui = Object.assign({activeCat:'all',activeTag:null,activeGroup:'all',search:'',view:'library',filter:'all',sort:'updated'}, d.ui||{});
      state.profile = Object.assign({name:'我的相册', avatar:'🎨'}, d.profile||{});
    }else{
      const old = localStorage.getItem('prompt_workbench_v2') || localStorage.getItem('prompt_workbench_v1');
      if(old){
        const d = JSON.parse(old);
        (d.prompts||[]).forEach(p=>{
          p.negative=p.negative||''; p.ratio=p.ratio||''; p.genModel=p.genModel||''; p.seed=p.seed||'';
          p.useCount=p.useCount||0; p.quality=p.quality||null; p.versions=p.versions||[];
          p.lastUsedAt=p.lastUsedAt||null; p.isTemplate=!!p.isTemplate;
        });
        state = Object.assign(state, d);
      }
    }
    // 兜底修复：老数据或缺字段时补齐，避免运行时崩在 undefined 上
    state.prompts = Array.isArray(state.prompts) ? state.prompts : [];
    state.gallery = Array.isArray(state.gallery) ? state.gallery : [];
    state.categories = Array.isArray(state.categories) ? state.categories : [];
    state.groups = Array.isArray(state.groups) ? state.groups : [];
    state.history = Array.isArray(state.history) ? state.history : [];
    state.prompts.forEach(p=>{
      if(!Array.isArray(p.versions)) p.versions = [];
      if(!Array.isArray(p.images)) p.images = [];
      if(!Array.isArray(p.tags)) p.tags = [];
    });
    state.gallery.forEach(g=>{
      if(!Array.isArray(g.imageKeys)) g.imageKeys = [];
      if(!Array.isArray(g.tags)) g.tags = [];
    });

    if(!Array.isArray(state.modelConfigs) || !state.modelConfigs.length){
      state.modelConfigs = [{id:cid(), name:'默认配置', provider:state.settings.provider, baseUrl:state.settings.baseUrl, apiKey:state.settings.apiKey, model:state.settings.model, temperature:state.settings.temperature}];
      state.activeConfigId = state.modelConfigs[0].id;
    }
    if(!state.activeConfigId) state.activeConfigId = state.modelConfigs[0].id;
    // 当前配置可能已被删除，回落到第一个
    if(!state.modelConfigs.some(c=>c.id===state.activeConfigId)){
      state.activeConfigId = state.modelConfigs[0].id;
    }
  }catch(e){
    console.warn('读取本地数据失败', e);
    // 数据损坏时不要静默清空，提示用户先导出/备份
    setTimeout(()=>toast('本地数据读取异常，建议先导出备份'), 1200);
  }
}
/* ============================================================
 * 本地持久化
 * ------------------------------------------------------------------
 * iOS Safari / 主屏 PWA 的坑：
 *   1) localStorage 写入可能因容量（约 5MB）静默失败 → 必须校验回读
 *   2) 主屏 App 每次启动被当作新会话，未持久化的写入可能丢失 → 立即同步落盘
 *   3) 图片一律存 IndexedDB（体积大），state 里只保存 key
 * 因此 persist() 做了三件事：同步写入 → 回读校验 → 失败时明确报错。
 * ============================================================ */
function persist(){
  let json;
  try{ json = JSON.stringify(state); }
  catch(e){ toast('数据序列化失败：' + e.message); return false; }

  try{
    localStorage.setItem(STORE_KEY, json);
  }catch(e){
    // 容量不足：先尝试清理历史版本等可牺牲数据
    const reclaimed = reclaimSpace();
    if(reclaimed){
      try{ localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
      catch(e2){ reportStorageFailure(e2, json.length); return false; }
    }else{
      reportStorageFailure(e, json.length);
      return false;
    }
  }

  // 回读校验：确认真的写进去了（iOS 上这是唯一可靠的验证方式）
  try{
    const check = localStorage.getItem(STORE_KEY);
    if(!check || check.length !== json.length){
      reportStorageFailure(new Error('写入后校验不一致'), json.length);
      return false;
    }
  }catch(e){ /* 读失败不阻断，写入本身已成功 */ }

  return true;
}

/** 容量不足时尝试回收：清空历史版本、AI 历史、过期的旧 key */
function reclaimSpace(){
  let freed = false;
  try{
    // 1. 清掉更早版本的遗留 key
    ['prompt_workbench_v2','prompt_workbench_v1'].forEach(k=>{
      if(localStorage.getItem(k)){ localStorage.removeItem(k); freed = true; }
    });
    // 2. 精简历史版本（只保留最近 3 个）
    (state.prompts||[]).forEach(p=>{
      if((p.versions||[]).length > 3){ p.versions = p.versions.slice(0,3); freed = true; }
    });
    // 3. AI 分析历史只保留最近 10 条
    if((state.history||[]).length > 10){ state.history = state.history.slice(0,10); freed = true; }
  }catch(e){}
  return freed;
}

function reportStorageFailure(err, size){
  const kb = (size/1024).toFixed(1);
  console.warn('持久化失败', err, '数据大小', kb + 'KB');
  toast(`保存失败：本地存储已满（${kb}KB）。请到「我的 → 导出备份」后清理部分数据`);
}

/** 立即同步写入一次（用于页面隐藏/关闭前的兜底） */
function persistNow(){
  try{ localStorage.setItem(STORE_KEY, JSON.stringify(state)); }catch(e){}
}

// 页面被挂起/关闭前再写一次，防止 iOS 切后台时丢最后一次写入
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'hidden') persistNow();
});
window.addEventListener('pagehide', persistNow);
window.addEventListener('beforeunload', persistNow);

/* ---- IndexedDB 图片仓库（原样） ---- */
const DB_NAME='prompt_workbench_db', IMG_STORE='imgs';
let db=null, imgCache=new Map();

function openDB(){
  return new Promise((resolve,reject)=>{
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e=>{ e.target.result.createObjectStore(IMG_STORE); };
    req.onsuccess = e=>{ db=e.target.result; resolve(); };
    req.onerror = ()=>reject(req.error);
  });
}
function dbTx(mode, fn){
  return new Promise((resolve,reject)=>{
    const t = db.transaction(IMG_STORE, mode);
    const r = fn(t.objectStore(IMG_STORE));
    r.onsuccess = ()=>resolve(r.result);
    r.onerror = ()=>reject(r.error);
  });
}
async function imgPut(dataURL){
  const key = 'img_'+cid();
  await dbTx('readwrite', s=>s.put(dataURL, key));
  imgCache.set(key, dataURL);
  return key;
}
async function imgDelete(key){
  if(!key) return;
  try{ await dbTx('readwrite', s=>s.delete(key)); }catch(e){}
  imgCache.delete(key);
}
async function imgLoadAll(){
  const keys = await dbTx('readonly', s=>s.getAllKeys());
  if(!keys || !keys.length){ imgCache=new Map(); return; }
  const vals = await dbTx('readonly', s=>s.getAll());
  imgCache = new Map(keys.map((k,i)=>[k, vals[i]]));
}
function imgGet(key){ return imgCache.get(key); }
function imgSrc(src){ return (src&&src.startsWith('data:')) ? src : imgGet(src); }

/* ============================================================
 * 1. 工具
 * ============================================================ */
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
let toastTimer = null;
function toast(msg){
  const t=$('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),1900);
}
function fmtTime(ts){ if(!ts) return '—'; const d=new Date(ts); return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function catOf(id){ return state.categories.find(c=>c.id===id); }
function groupOf(id){ return state.groups.find(g=>g.id===id); }
function promptOf(id){ return state.prompts.find(p=>p.id===id); }
function extractVars(text){ const m=[...String(text||'').matchAll(/\{([^{}]+)\}/g)].map(x=>x[1].trim()); return [...new Set(m)]; }
function fmtBytes(n){ if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(1)+' KB'; return (n/1048576).toFixed(2)+' MB'; }

function renderMarkdown(md){
  if(!md) return '';
  let html = esc(md);
  html = html.replace(/```([\s\S]*?)```/g, (m,c)=>`<pre><code>${c.trim()}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>(?=\s*<li>|$))/g, '<ul>$1</ul>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/<br>(<h3>|<ul>|<pre>)/g, '$1');
  return html;
}

/* 灰阶化分类色（黑白灰主题下不出现彩色） */
function grayOf(hex){
  try{
    const h = String(hex||'#888').replace('#','');
    const r=parseInt(h.slice(0,2),16), g=parseInt(h.slice(2,4),16), b=parseInt(h.slice(4,6),16);
    const l = Math.round(.2126*r + .7152*g + .0722*b);
    // 压到 30%~82% 明度区间，保证浅色背景上始终可见
    const v = Math.round(76 + (l/255)*129);
    return `rgb(${v},${v},${v})`;
  }catch(e){ return '#888'; }
}

/* 图标（线性 SVG，统一 24 网格） */
const I = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.6"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  star: (on)=>`<svg viewBox="0 0 24 24" fill="${on?'currentColor':'none'}" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>`,
  wrench: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.7-3.7z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.4 3.8 5.4 3.8 8.5s-1.3 6.1-3.8 8.5c-2.5-2.4-3.8-5.4-3.8-8.5S9.5 5.9 12 3.5z"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5V10H9"/><path d="M12 8v4.4l3 1.8"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  thumbUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21V10l4.4-6.4a1.6 1.6 0 0 1 2.9 1.1L13.6 9H19a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7z"/><path d="M3 10h4v11H3z"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M8 12h8"/></svg>',
  thumbDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3v11l-4.4 6.4a1.6 1.6 0 0 1-2.9-1.1L10.4 15H5a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 6.2 4H17z"/><path d="M21 14h-4V3h4z"/></svg>',
  square: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="4.5" width="15" height="15" rx="4"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l-1 6 3.5 3.5v2H6.5v-2L10 9z"/><path d="M12 14.5V21"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
};

/* ============================================================
 * 2. 外壳：Tab 分页 / 横滑 / 滚动顶边模糊
 * ============================================================ */
const TITLES = {library:'提示词库', builder:'拼装器', workbench:'AI 工作台', profile:'我的'};
const TAB_ORDER = ['library','builder','workbench','profile'];
const BIG = {library:'提示词库', builder:'拼装器', workbench:'AI 工作台', profile:'我的'};
let curTab = 0;

const pagerEl = $('pager');
const dockEl = $('tabdock');
const pillEl = $('tabpill');
const tabEls = Array.from(dockEl.querySelectorAll('.tab-item'));
const pageEls = Array.from(pagerEl.querySelectorAll('.page'));

function tabRects(){
  const d = dockEl.getBoundingClientRect();
  return tabEls.map(t => { const r = t.getBoundingClientRect(); return {l: r.left - d.left, w: r.width}; });
}
function layoutPill(i, animate = true){
  const rs = tabRects()[i]; if(!rs) return;
  if(!animate) pillEl.style.transition = 'none';
  pillEl.style.width = rs.w + 'px';
  pillEl.style.transform = `translateX(${rs.l}px)`;
  if(!animate) requestAnimationFrame(()=>{ pillEl.style.transition = ''; });
}
function setPillProgress(p){
  // p: 0 ~ 3 的连续进度，用于横滑时实时联动
  const rs = tabRects();
  const i0 = Math.max(0, Math.min(rs.length-1, Math.floor(p)));
  const i1 = Math.min(rs.length-1, i0+1);
  const f = Math.max(0, Math.min(1, p - i0));
  const l = rs[i0].l + (rs[i1].l - rs[i0].l) * f;
  const w = rs[i0].w + (rs[i1].w - rs[i0].w) * f;
  pillEl.style.width = w + 'px';
  pillEl.style.transform = `translateX(${l}px)`;
}

function setTab(i, animate = true){
  curTab = Math.max(0, Math.min(TAB_ORDER.length - 1, i));
  const key = TAB_ORDER[curTab];
  state.ui.view = key;
  pagerEl.classList.toggle('dragging', !animate);
  pagerEl.style.transform = `translateX(${-curTab * 25}%)`;
  tabEls.forEach((t, k) => { t.classList.toggle('on', k === curTab); t.setAttribute('aria-current', k === curTab ? 'page' : 'false'); });
  layoutPill(curTab, animate);
  $('compactTitle').textContent = TITLES[key];
  $('bigTitle').textContent = BIG[key];
  if(!animate) requestAnimationFrame(()=>pagerEl.classList.remove('dragging'));
  onPageScroll();
  // 首屏轻微进入动画（每次切换只跑一次）
  pageEls.forEach((p, k) => p.classList.toggle('fresh', k === curTab && animate));
}

/* 兼容旧代码调用 */
function switchView(v){ const i = TAB_ORDER.indexOf(v); if(i >= 0) setTab(i); }

/* ---- 滚动进度 → CSS 变量（驱动大标题收缩与顶栏模糊带） ---- */
let scrollRaf = 0;
function onPageScroll(){
  const p = pageEls[curTab]; if(!p) return;
  const y = p.scrollTop;
  const k = Math.max(0, Math.min(1, y / 64));
  document.documentElement.style.setProperty('--scroll', k.toFixed(3));
}
pageEls.forEach(p=>p.addEventListener('scroll', ()=>{
  if(scrollRaf) return;
  scrollRaf = requestAnimationFrame(()=>{ scrollRaf = 0; onPageScroll(); });
}, {passive:true}));

/* ---- 横滑分页（主交互 B） ---- */
let swipe = null;
pagerEl.addEventListener('pointerdown', e=>{
  // 不拦截：弹层内、按钮、输入、横向滚动条、可横向拖动的元素
  if(e.target.closest('.mask, .hscroll, .card-imgs, input, textarea, select, .tabdock, .searchbar, .icon-btn')) return;
  if(e.pointerType === 'mouse' && e.button !== 0) return;
  swipe = {x:e.clientX, y:e.clientY, t:performance.now(), base:-curTab * pagerEl.clientWidth,
           locked:null, vx:0, px:e.clientX, page:pageEls[curTab]};
});
pagerEl.addEventListener('pointermove', e=>{
  if(!swipe) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
  if(swipe.locked === null){
    swipe.locked = (Math.abs(dx) > 12 || Math.abs(dy) > 12)
      ? (Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y') : null;
    if(swipe.locked === 'x') swipe.page.style.overflowY = 'hidden';
  }
  if(swipe.locked !== 'x') return;
  const W = pagerEl.clientWidth;
  let off = swipe.base + dx;
  const minO = -(TAB_ORDER.length - 1) * W;
  if(off > 0) off = off * .32;
  if(off < minO) off = minO + (off - minO) * .32;
  pagerEl.classList.add('dragging');
  pagerEl.style.transform = `translateX(${off}px)`;
  const p = Math.max(0, Math.min(TAB_ORDER.length - 1, -off / W));
  pillEl.style.transition = 'none';
  setPillProgress(p);
  tabEls.forEach((t, k) => t.classList.toggle('on', Math.round(p) === k));
  swipe.vx = (e.clientX - swipe.px) / Math.max(1, 16); swipe.px = e.clientX;
}, {passive:true});

function endSwipe(e){
  if(!swipe) return;
  const s = swipe; swipe = null;
  pagerEl.classList.remove('dragging');
  if(s.page) s.page.style.overflowY = '';
  if(s.locked === 'x'){
    const dx = (e.clientX ?? s.px) - s.x;
    const fast = Math.abs(s.vx) > .5;
    let i = curTab;
    if(Math.abs(dx) > s.page.clientWidth * .18 || fast) i = dx < 0 ? curTab + 1 : curTab - 1;
    setTab(i);
  }else{
    pagerEl.style.transform = `translateX(${-curTab * 25}%)`;
    layoutPill(curTab);
  }
}
pagerEl.addEventListener('pointerup', endSwipe);
pagerEl.addEventListener('pointercancel', endSwipe);
pagerEl.addEventListener('pointerleave', e=>{ if(swipe && e.buttons === 0) endSwipe(e); });

/* ---- 拖动 Tab 滑块（辅助交互 A） ---- */
let dragPill = null;
dockEl.addEventListener('pointerdown', e=>{
  if(!e.target.closest('.tab-item')) return;
  const rs = tabRects();
  dragPill = {x0:e.clientX, l0:rs[curTab].l, moved:false, id:e.pointerId};
  dockEl.classList.add('dragging');
  try{ dockEl.setPointerCapture(e.pointerId); }catch(_){}
});
dockEl.addEventListener('pointermove', e=>{
  if(!dragPill) return;
  const dx = e.clientX - dragPill.x0;
  if(Math.abs(dx) > 3) dragPill.moved = true;
  if(!dragPill.moved) return;
  e.preventDefault();
  const rs = tabRects();
  const min = rs[0].l, max = rs[rs.length-1].l;
  let x = Math.max(min, Math.min(max, dragPill.l0 + dx));
  pillEl.style.transition = 'none';
  pillEl.style.width = rs[0].w + 'px';
  pillEl.style.transform = `translateX(${x}px)`;
  const p = (x - min) / Math.max(1, (max - min)) * (rs.length - 1);
  tabEls.forEach((t, k) => t.classList.toggle('on', Math.round(p) === k));
  layoutPill(Math.round(p), false); // 让宽高切换自然
  dockEl.dataset.dragTarget = String(Math.round(p));
}, {passive:false});
function endDragPill(e){
  if(!dragPill) return;
  const moved = dragPill.moved; dragPill = null;
  dockEl.classList.remove('dragging');
  pillEl.style.transition = '';
  if(moved){
    const i = Number(dockEl.dataset.dragTarget ?? curTab);
    setTab(i);
  }
  delete dockEl.dataset.dragTarget;
}
dockEl.addEventListener('pointerup', endDragPill);
dockEl.addEventListener('pointercancel', endDragPill);

/* Tab 点击 */
tabEls.forEach(t => t.addEventListener('click', ()=>{
  if(dockEl.dataset.suppressClick){ delete dockEl.dataset.suppressClick; return; }
  setTab(Number(t.dataset.tab));
}));

/* ============================================================
 * 3. 搜索（点击放大镜 → 标题栏变身搜索框）
 * ============================================================ */
let searchOpen = false;
function openSearch(){
  searchOpen = true;
  document.body.classList.add('searching');
  const inp = $('searchInput');
  inp.value = state.ui.search || '';
  setTimeout(()=>{ inp.focus(); }, 60);
}
function closeSearch(){
  searchOpen = false;
  document.body.classList.remove('searching');
  $('searchInput').blur();
}
function onSearch(){
  state.ui.search = $('searchInput').value;
  if(curTab !== 0) setTab(0);
  renderLibrary();
}
$('btnSearch').addEventListener('click', openSearch);
$('btnCancelSearch').addEventListener('click', ()=>{ $('searchInput').value=''; onSearch(); closeSearch(); });
$('searchInput').addEventListener('input', onSearch);
$('searchInput').addEventListener('keydown', e=>{ if(e.key === 'Escape'){ closeSearch(); } });

/* ============================================================
 * 4. 库视图
 * ============================================================ */
function filteredPrompts(){
  const q = state.ui.search.trim().toLowerCase();
  let list = state.prompts.filter(p=>{
    if(state.ui.activeCat!=='all' && p.categoryId!==state.ui.activeCat) return false;
    if(state.ui.activeTag && !(p.tags||[]).includes(state.ui.activeTag)) return false;
    if(state.ui.filter==='fav' && !p.favorite) return false;
    if(state.ui.filter==='tpl' && !p.isTemplate) return false;
    if(q){
      const hay = (p.title+' '+p.text+' '+p.note+' '+(p.tags||[]).join(' ')+(p.negative||'')).toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });
  const sort = state.ui.sort;
  list.sort((a,b)=>{
    if(a.pinned!==b.pinned) return b.pinned?1:-1;
    if(sort==='used') return (b.lastUsedAt||b.updatedAt)-(a.lastUsedAt||a.updatedAt);
    if(sort==='level') return (b.level||0)-(a.level||0);
    if(sort==='title') return a.title.localeCompare(b.title,'zh');
    return b.updatedAt-a.updatedAt;
  });
  return list;
}

function renderStats(){
  const total = state.prompts.length;
  const fav = state.prompts.filter(p=>p.favorite).length;
  const tpl = state.prompts.filter(p=>p.isTemplate).length;
  const uses = state.prompts.reduce((s,p)=>s+(p.useCount||0),0);
  $('statsRow').innerHTML = `
    <div class="stat-card"><div class="num">${total}</div><div class="label">提示词</div></div>
    <div class="stat-card"><div class="num">${fav}</div><div class="label">收藏</div></div>
    <div class="stat-card"><div class="num">${state.categories.length}</div><div class="label">分类</div></div>
    <div class="stat-card"><div class="num">${tpl}</div><div class="label">模版</div></div>
    <div class="stat-card"><div class="num">${uses}</div><div class="label">使用</div></div>`;
}

function renderCats(){
  const counts = id => state.prompts.filter(p=>p.categoryId===id).length;
  const allOn = state.ui.activeCat==='all';
  let html = `<button class="chip ${allOn?'on':''}" onclick="setCat('all')">全部 <span class="cnt">${state.prompts.length}</span></button>`;
  state.categories.forEach(c=>{
    html += `<button class="chip ${state.ui.activeCat===c.id?'on':''}" onclick="setCat('${c.id}')">
      <span class="dot" style="background:${grayOf(c.color)}"></span>${esc(c.name)} <span class="cnt">${counts(c.id)}</span></button>`;
  });
  $('mobileCatBar').innerHTML = html;
}

function renderTags(){
  const map = {};
  state.prompts.forEach(p=>(p.tags||[]).forEach(t=>{ map[t]=(map[t]||0)+1; }));
  const names = Object.keys(map).sort((a,b)=>map[b]-map[a]).slice(0, 40);
  const bar = $('tagBar');
  bar.innerHTML = names.map(t=>`
    <button class="chip ${state.ui.activeTag===t?'on':''}" onclick="setTag('${esc(t)}')"># ${esc(t)} <span class="cnt">${map[t]}</span></button>`).join('');
  bar.classList.toggle('hidden', !names.length);
}

function setCat(id){ state.ui.activeCat=id; state.ui.activeTag=null; renderLibrary(); }
function setTag(t){ state.ui.activeTag = state.ui.activeTag===t?null:t; renderLibrary(); }
function setFilter(f){
  state.ui.filter=f;
  document.querySelectorAll('#filterChips .chip').forEach(c=>c.classList.toggle('on',c.dataset.filter===f));
  renderLibrary();
}
function onSortPicked(s){ state.ui.sort = s; renderLibrary(); }

/* 排序：底部动作面板 */
const SORT_LABEL = {updated:'最近更新', used:'最近使用', level:'掌握程度', title:'标题'};
function openSortSheet(){ $('sortMask').classList.remove('hidden'); syncSortSheet(); }
function closeSortSheet(){ $('sortMask').classList.add('hidden'); }
function syncSortSheet(){
  document.querySelectorAll('#sortOptions .as-item').forEach(b=>{
    const on = b.dataset.sort === state.ui.sort;
    b.style.color = on ? 'var(--ink)' : 'var(--ink-2)';
    b.style.fontWeight = on ? '600' : '400';
    b.dataset.on = on ? '1' : '';
  });
}
function chooseSort(s){ state.ui.sort = s; syncSortSheet(); closeSortSheet(); $('sortLabel').textContent = SORT_LABEL[s]||s; renderLibrary(); }
$('sortBtn').addEventListener('click', openSortSheet);

function renderLibrary(){
  renderStats(); renderCats(); renderTags();
  $('sortLabel').textContent = SORT_LABEL[state.ui.sort] || '最近更新';
  const list = filteredPrompts();
  $('libraryEmpty').classList.toggle('hidden', list.length>0);
  const grid = $('cardGrid');
  if(!list.length){ grid.innerHTML=''; return; }
  grid.innerHTML = list.map((p, idx)=>{
    const c = catOf(p.categoryId);
    const lv = p.level||0;
    const starsHtml = `<span class="stars" title="掌握程度">${'★'.repeat(lv)}<span class="off">${'☆'.repeat(5-lv)}</span></span>`;
    /*
     * 图片区合并两类来源：
     *   1) 提示词自带的案例图（p.images）
     *   2) 相册里关联到这条提示词的作品（gallery[].promptId）
     * 两者去重后一起展示；关联作品加「作品」角标以示区分。
     */
    const ownImgs = (p.images||[]).map(s=>imgSrc(s)).filter(Boolean);
    const linkedGalleries = state.gallery.filter(g=>g.promptId===p.id);
    const linkedImgs = linkedGalleries.flatMap(g=>(g.imageKeys||[]).map(k=>imgGet(k)).filter(Boolean));
    const cardImgs = [...new Set([...ownImgs, ...linkedImgs])];
    const linkedCount = linkedImgs.length;
    // 点击任意图片 → 打开可左右滑动的查看器
    const imgsHtml = cardImgs.map((u,i)=>`
      <div class="card-thumb-wrap">
        <img src="${u}" alt="" loading="lazy" data-vi="${i}"
             onclick="event.stopPropagation();openCardViewer('${p.id}',${i})">
        ${i >= ownImgs.length ? '<i class="thumb-tag">作品</i>' : ''}
      </div>`).join('');
    const params = [];
    if(p.ratio) params.push(`比例 ${esc(p.ratio)}`);
    if(p.genModel) params.push(`模型 ${esc(p.genModel)}`);
    if(p.seed) params.push(`Seed ${esc(p.seed)}`);
    if(linkedCount) params.push(`作品 ${linkedCount} 张`);
    const vars = extractVars(p.text);
    const q = p.quality && QUALITY[p.quality];
    return `<div class="card ${p.pinned?'pinned':''}" data-id="${p.id}" style="animation-delay:${Math.min(idx,8)*26}ms">
      ${imgsHtml?`<div class="card-imgs">${imgsHtml}</div>`:''}
      <div class="card-body">
        <div class="card-head">
          <div class="card-title">${esc(p.title)}</div>
          ${c?`<span class="badge line">${esc(c.name)}</span>`:''}
          ${p.isTemplate?'<span class="badge solid">模版</span>':''}
          ${q?`<span class="badge">${q[1]}</span>`:''}
        </div>
        <div class="card-text">${esc(p.text)}</div>
        ${p.negative?`<div class="card-text muted">负面：${esc(p.negative)}</div>`:''}
        ${params.length?`<div class="meta-row">${params.map(x=>`<span>${x}</span>`).join('')}</div>`:''}
        ${p.note?`<div class="card-text muted">备注：${esc(p.note)}</div>`:''}
        ${(p.tags||[]).length?`<div class="meta-row">${p.tags.map(t=>`<span>#${esc(t)}</span>`).join('')}</div>`:''}
      </div>
      <div class="card-foot">
        ${starsHtml}
        <span class="use-meta">用过 ${p.useCount||0} 次</span>
        <div class="grow"></div>
        ${vars.length?`<button class="icon-btn" title="套用模版" onclick="event.stopPropagation();openApply('${p.id}')">${I.wrench}</button>`:''}
        <button class="icon-btn" title="复制提示词" onclick="event.stopPropagation();copyPrompt('${p.id}')">${I.copy}</button>
        <button class="icon-btn ${p.favorite?'on':''}" title="${p.favorite?'取消收藏':'收藏'}"
          style="${p.favorite?'color:var(--ink)':'color:var(--ink-3)'}"
          onclick="event.stopPropagation();toggleFav('${p.id}')">${I.star(!!p.favorite)}</button>
      </div>
    </div>`;
  }).join('');
  bindCardGestures();
}

const QUALITY = {good:['good','好用'], ok:['ok','一般'], bad:['bad','踩坑']};

/* ---- 卡片手势：点击=预览详情，长按=动作面板 ---- */
let lpTimer = null, lpCard = null, lpStart = null;
function bindCardGestures(){
  $('cardGrid').querySelectorAll('.card').forEach(card=>{
    card.addEventListener('pointerdown', e=>{
      if(e.target.closest('button, img')) return;
      lpCard = card; card.classList.add('pressing');
      lpStart = {x:e.clientX, y:e.clientY};
      clearTimeout(lpTimer);
      lpTimer = setTimeout(()=>{
        if(!lpCard) return;
        lpCard.classList.remove('pressing');
        if(navigator.vibrate) try{ navigator.vibrate(10); }catch(_){}
        openActionSheet(lpCard.dataset.id);
        lpCard = null;
      }, 480);
    });
    const cancel = ()=>{ clearTimeout(lpTimer); if(lpCard) lpCard.classList.remove('pressing'); lpCard = null; };
    card.addEventListener('pointerup', e=>{
      const wasLong = !lpCard;
      cancel();
      if(wasLong) return;
      if(e.target.closest('button, img')) return;
      if(Math.abs(e.clientX-lpStart.x) > 8 || Math.abs(e.clientY-lpStart.y) > 8) return;
      openDetail(card.dataset.id);
    });
    card.addEventListener('pointerleave', cancel);
    card.addEventListener('pointercancel', cancel);
    card.addEventListener('contextmenu', e=>{ e.preventDefault(); openActionSheet(card.dataset.id); });
  });
}

/* ============================================================
 * 5. 卡片动作面板 / 详情
 * ============================================================ */
let actionTargetId = null;

/* 图集查看器状态（放前面，openDetail 会写入暂存数据） */
const viewerState = {list: [], index: 0, title: '', caption: '', detailList: [], detailTitle: ''};
function openActionSheet(id){
  const p = promptOf(id); if(!p) return;
  actionTargetId = id;
  const q = p.quality && QUALITY[p.quality];
  const vars = extractVars(p.text);
  $('actionSheet').innerHTML = `
    <div class="as-group">
      <div class="as-head"><div class="t">${esc(p.title)}</div>
        <div class="s">${(p.tags||[]).map(t=>'#'+esc(t)).join(' ') || '无标签'}</div></div>
      ${vars.length?`<button class="as-item" onclick="closeActionSheet();openApply('${id}')"><span class="ico">${I.wrench}</span>套用模版（${vars.length} 个变量）</button>`:''}
      <button class="as-item" onclick="closeActionSheet();copyPrompt('${id}')"><span class="ico">${I.copy}</span>复制提示词</button>
      <button class="as-item" onclick="closeActionSheet();openTrans('${id}')"><span class="ico">${I.globe}</span>中英互译</button>
      <button class="as-item" onclick="closeActionSheet();cycleQuality('${id}')"><span class="ico">${p.quality==='good'?I.thumbUp:p.quality==='bad'?I.thumbDown:I.minus}</span>效果标记：${q?q[1]:'未标记'}</button>
      <button class="as-item" onclick="closeActionSheet();openVersion('${id}')"><span class="ico">${I.history}</span>版本历史</button>
      <button class="as-item" onclick="closeActionSheet();togglePin('${id}')"><span class="ico">${I.pin}</span>${p.pinned?'取消置顶':'置顶展示'}</button>
      <button class="as-item" onclick="closeActionSheet();openEdit('${id}')"><span class="ico">${I.edit}</span>编辑</button>
    </div>
    <div class="as-group">
      <button class="as-item danger" onclick="closeActionSheet();deletePrompt('${id}')"><span class="ico">${I.trash}</span>删除提示词</button>
    </div>
    <button class="as-cancel" onclick="closeActionSheet()">取消</button>`;
  $('actionMask').classList.remove('hidden');
}
function closeActionSheet(){ $('actionMask').classList.add('hidden'); }
function togglePin(id){ const p = promptOf(id); if(!p) return; p.pinned = !p.pinned; p.updatedAt = Date.now(); persist(); renderLibrary(); toast(p.pinned?'已置顶':'已取消置顶'); }

/* 详情：底部面板（点击卡片）。内容区独立滚动，顶部留白避免被遮挡 */
function openDetail(id){
  const p = promptOf(id); if(!p) return;
  const c = catOf(p.categoryId);
  const lv = p.level||0;
  // 关联作品：相册里挂了这条提示词的图集
  const linked = state.gallery.filter(g=>g.promptId===id);
  const linkedImgs = linked.flatMap(g=>(g.imageKeys||[]).map(k=>imgGet(k)).filter(Boolean));
  // 提示词自带的案例图 + 关联作品图，合并成一个可滑动的列表
  const ownImgs = (p.images||[]).map(s=>imgSrc(s)).filter(Boolean);
  const allImgs = [...new Set([...ownImgs, ...linkedImgs])];
  // 暂存给查看器（openViewerAt 读取）
  viewerState.detailList = allImgs;
  viewerState.detailTitle = p.title;

  $('detailSheet').innerHTML = `
    <div class="detail-head">
      <div class="detail-grab"><i></i></div>
      <button class="detail-close" onclick="closeDetail()" aria-label="关闭">✕</button>
      <div class="detail-title">${esc(p.title)}</div>
      <div class="detail-sub">${c?esc(c.name):'未分类'} · ${fmtTime(p.updatedAt)} · 用过 ${p.useCount||0} 次</div>
    </div>
    <div class="detail-scroll">
      <div class="detail-text">${esc(p.text)}</div>
      ${allImgs.length?`
        <div class="detail-imgs">
          ${allImgs.map((u,i)=>`<img src="${u}" alt="" loading="lazy" data-vi="${i}" onclick="openViewerAt(${i})">`).join('')}
        </div>`:''}
      ${p.negative?`<div class="detail-block"><b>负面提示词</b>${esc(p.negative)}</div>`:''}
      ${p.note?`<div class="detail-block"><b>备注 / 心得</b>${esc(p.note)}</div>`:''}
      ${linked.length?`<div class="detail-block"><b>关联作品（${linked.length} 组 / ${linkedImgs.length} 张）</b>${linked.map(g=>esc(g.title)).join('、')}</div>`:''}
      <div class="meta-row" style="margin-top:14px">
        <span>${'★'.repeat(lv)}${'☆'.repeat(5-lv)}</span>
        ${p.ratio?`<span>比例 ${esc(p.ratio)}</span>`:''}
        ${p.genModel?`<span>模型 ${esc(p.genModel)}</span>`:''}
        ${p.seed?`<span>Seed ${esc(p.seed)}</span>`:''}
        ${(p.tags||[]).map(t=>`<span>#${esc(t)}</span>`).join('')}
      </div>
    </div>
    <div class="detail-foot">
      <button class="btn" onclick="closeDetail();openActionSheet('${id}')">更多</button>
      <button class="btn primary" onclick="copyPrompt('${id}')">复制提示词</button>
    </div>`;
  $('detailMask').classList.remove('hidden');
}
function closeDetail(){ $('detailMask').classList.add('hidden'); }

/* ============ 图集查看器：左右滑动浏览 ============ */
/** 打开查看器（任意图片列表） */
function openViewer(list, index = 0, title = '', caption = ''){
  if(!list || !list.length) return;
  viewerState.list = list.slice();
  viewerState.index = Math.max(0, Math.min(list.length - 1, index));
  viewerState.title = title || '';
  viewerState.caption = caption || '';
  renderViewer();
  $('viewer').classList.remove('hidden');
  requestAnimationFrame(()=>{
    const track = $('viewerTrack');
    track.scrollLeft = viewerState.index * track.clientWidth;
  });
}

/** 从详情面板的缩略图打开：数据在最近一次 openDetail 里暂存 */
function openViewerAt(i){
  openViewer(viewerState.detailList, i, viewerState.detailTitle, '');
}

/** 从提示词卡片的图片打开：现场收集该提示词的全部图片 */
function openCardViewer(promptId, i){
  const p = promptOf(promptId); if(!p) return;
  const ownImgs = (p.images||[]).map(s=>imgSrc(s)).filter(Boolean);
  const linkedGalleries = state.gallery.filter(g=>g.promptId===promptId);
  const linkedImgs = linkedGalleries.flatMap(g=>(g.imageKeys||[]).map(k=>imgGet(k)).filter(Boolean));
  const list = [...new Set([...ownImgs, ...linkedImgs])];
  openViewer(list, i, p.title, list.length > 1 ? '左右滑动查看' : '');
}

/** 从相册封面打开整组作品 */
function openGalleryViewer(galleryId, i = 0){
  const g = state.gallery.find(x=>x.id===galleryId); if(!g) return;
  const list = (g.imageKeys||[]).map(k=>imgGet(k)).filter(Boolean);
  const caption = [g.note, (g.tags||[]).map(t=>'#'+t).join(' ')].filter(Boolean).join(' · ');
  openViewer(list, i, g.title, caption);
}

function renderViewer(){
  const {list, index, title} = viewerState;
  $('viewerTitle').textContent = title;
  $('viewerCount').textContent = `${index+1} / ${list.length}`;
  $('viewerCaption').textContent = viewerState.caption || '';
  $('viewerTrack').innerHTML = list.map((u,i)=>`
    <div class="viewer-slide"><img src="${u}" alt="" data-index="${i}"></div>`).join('');
  $('viewerDots').innerHTML = list.map((_,i)=>`<i class="${i===index?'on':''}"></i>`).join('');
}

function closeViewer(){ $('viewer').classList.add('hidden'); }

/* 查看器滑动的索引同步（只绑定一次） */
(function bindViewer(){
  let raf = 0;
  const track = $('viewerTrack');
  if(!track) return;
  track.addEventListener('scroll', ()=>{
    if(raf) return;
    raf = requestAnimationFrame(()=>{
      raf = 0;
      const w = track.clientWidth || 1;
      const i = Math.round(track.scrollLeft / w);
      if(i === viewerState.index) return;
      viewerState.index = i;
      $('viewerCount').textContent = `${i+1} / ${viewerState.list.length}`;
      [...$('viewerDots').children].forEach((d,k)=>d.classList.toggle('on', k===i));
    });
  }, {passive:true});

  // 键盘：左右切换、Esc 关闭
  document.addEventListener('keydown', e=>{
    if($('viewer').classList.contains('hidden')) return;
    if(e.key === 'Escape') closeViewer();
    if(e.key === 'ArrowLeft' || e.key === 'ArrowRight'){
      const w = track.clientWidth || 1;
      const i = Math.max(0, Math.min(viewerState.list.length-1,
        viewerState.index + (e.key === 'ArrowRight' ? 1 : -1)));
      track.scrollTo({left: i * w, behavior:'smooth'});
    }
  });

  // 桌面端：点击空白处关闭
  $('viewer').addEventListener('click', e=>{
    if(e.target === $('viewer') || e.target.classList.contains('viewer-slide')) closeViewer();
  });
})();

/* ============================================================
 * 6. 卡片编辑（原逻辑）
 * ============================================================ */
let editingId = null;
let editingImages = [];
let editingTags = [];
let prefill = null;

function openEdit(id, pre){
  editingId = id||null;
  prefill = pre||null;
  const p = id ? promptOf(id) : null;
  editingImages = p? [...(p.images||[])] : [];
  editingTags = p? [...(p.tags||[])] : [];
  $('editModalTitle').textContent = p?'编辑提示词':'记录提示词';
  $('fTitle').value = p?.title||prefill?.title||'';
  $('fText').value = p?.text||prefill?.text||'';
  $('fNegative').value = p?.negative||prefill?.negative||'';
  $('fRatio').value = p?.ratio||'';
  $('fGenModel').value = p?.genModel||'';
  $('fSeed').value = p?.seed||'';
  $('fNote').value = p?.note||'';
  $('fLevel').value = p?.level||3;
  $('levelVal').textContent = p?.level||3;
  $('fFavorite').checked = !!p?.favorite;
  $('fPinned').checked = !!p?.pinned;
  const sel = $('fCategory');
  sel.innerHTML = '<option value="">未分类</option>' + state.categories.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
  if(p?.categoryId) sel.value = p.categoryId;
  else if(prefill?.categoryId) sel.value = prefill.categoryId;
  renderTagChips(); renderImgThumbs();
  $('editMask').classList.remove('hidden');
}
function closeEdit(){ $('editMask').classList.add('hidden'); }

function renderTagChips(){
  const wrap = $('tagWrap');
  wrap.querySelectorAll('.tag-chip').forEach(e=>e.remove());
  editingTags.forEach((t,i)=>{
    const chip = document.createElement('span');
    chip.className='tag-chip';
    chip.innerHTML = `#${esc(t)}<button onclick="removeTag(${i})">✕</button>`;
    wrap.insertBefore(chip, $('tagInput'));
  });
}
function onTagKey(e){
  if(e.key==='Enter'||e.key===','){
    e.preventDefault();
    const v = e.target.value.trim().replace(/,/g,'');
    if(v && !editingTags.includes(v)){ editingTags.push(v); renderTagChips(); }
    e.target.value='';
  }else if(e.key==='Backspace' && !e.target.value && editingTags.length){
    editingTags.pop(); renderTagChips();
  }
}
function removeTag(i){ editingTags.splice(i,1); renderTagChips(); }

function renderImgThumbs(){
  const box = $('imgPicker');
  box.querySelectorAll('.img-thumb').forEach(e=>e.remove());
  const add = box.querySelector('.img-add');
  editingImages.forEach((src,i)=>{
    const u = imgSrc(src); if(!u) return;
    const d = document.createElement('div');
    d.className='img-thumb';
    d.innerHTML = `<img src="${u}" alt=""><button class="rm" onclick="removeImage(${i})">✕</button>`;
    box.insertBefore(d, add);
  });
}
function removeImage(i){ editingImages.splice(i,1); renderImgThumbs(); }

function compressFile(file, cb){
  const reader = new FileReader();
  reader.onload = e=>{
    const img = new Image();
    img.onload = ()=>{
      const MAX = 1400;
      let w = img.width, h = img.height;
      if(w > MAX || h > MAX){ const k = MAX/Math.max(w,h); w = Math.round(w*k); h = Math.round(h*k); }
      const cv = document.createElement('canvas'); cv.width=w; cv.height=h;
      cv.getContext('2d').drawImage(img,0,0,w,h);
      cb(cv.toDataURL('image/jpeg', .82));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
async function onImagesPicked(e){
  const files = [...e.target.files];
  e.target.value='';
  for(const f of files){
    await new Promise(res=>compressFile(f, async d=>{ editingImages.push(await imgPut(d)); res(); }));
  }
  renderImgThumbs();
}

async function savePrompt(){
  const title = $('fTitle').value.trim();
  const text = $('fText').value.trim();
  if(!title){ toast('标题必填'); return; }
  if(!text){ toast('提示词正文必填'); return; }
  const data = {
    title, text,
    categoryId: $('fCategory').value || null,
    negative: $('fNegative').value.trim(),
    ratio: $('fRatio').value.trim(),
    genModel: $('fGenModel').value.trim(),
    seed: $('fSeed').value.trim(),
    note: $('fNote').value.trim(),
    level: Number($('fLevel').value)||3,
    favorite: $('fFavorite').checked,
    pinned: $('fPinned').checked,
    tags: [...editingTags],
    images: [...editingImages]
  };
  if(editingId){
    const p = promptOf(editingId);
    if(p.text !== data.text){ p.versions = p.versions||[]; p.versions.unshift({text:p.text, note:p.note||'', createdAt:Date.now()}); if(p.versions.length>20) p.versions.pop(); }
    Object.assign(p, data, {updatedAt:Date.now()});
  }else{
    state.prompts.push({id:cid(), ...data, isTemplate:false, useCount:0, quality:null, versions:[], lastUsedAt:null, createdAt:Date.now(), updatedAt:Date.now()});
  }
  const saved = persist();
  closeEdit(); renderLibrary();
  toast(saved ? '已保存' : '已保存到界面，但本地存储失败，请先导出备份');
}

function toggleFav(id){ const p=promptOf(id); p.favorite=!p.favorite; persist(); renderLibrary(); toast(p.favorite?'已收藏':'已取消收藏'); }
function copyPrompt(id){
  const p = promptOf(id); if(!p) return;
  p.useCount = (p.useCount||0)+1; p.lastUsedAt = Date.now(); persist();
  const done = ()=>{ toast('已复制'); renderLibrary(); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(p.text).then(done).catch(()=>{ fallbackCopy(p.text); done(); });
  }else{ fallbackCopy(p.text); done(); }
}
function fallbackCopy(t){
  const ta = document.createElement('textarea'); ta.value = t; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select(); try{ document.execCommand('copy'); }catch(_){}
  document.body.removeChild(ta);
}
function cycleQuality(id){
  const p = promptOf(id); if(!p) return;
  const order = [null,'good','ok','bad'];
  p.quality = order[(order.indexOf(p.quality)+1) % order.length];
  persist(); renderLibrary();
  toast(p.quality ? '效果标记：'+QUALITY[p.quality][1] : '已清除标记');
}
function deletePrompt(id){
  const p = promptOf(id); if(!p) return;
  if(!confirm(`删除「${p.title}」？不可恢复。`)) return;
  state.prompts = state.prompts.filter(x=>x.id!==id);
  persist(); renderLibrary(); toast('已删除');
}

/* ============================================================
 * 7. 分类（原逻辑，颜色点改为灰阶）
 * ============================================================ */
let catEditingId = null;
let pickedColor = COLORS[0];
const GRAYS = ['#1C1C1E','#3A3A3C','#5A5A5C','#7A7A7C','#9A9A9C','#B8B8BA'];

function openCatModal(){ catEditingId=null; $('catModalTitle').textContent='新分类'; $('catName').value=''; pickedColor=GRAYS[0]; renderColorRow(); $('catDeleteBtn').classList.add('hidden'); $('catMask').classList.remove('hidden'); }
function editActiveCat(){
  if(state.ui.activeCat==='all'){ toast('先选一个分类再管理'); return; }
  const c = catOf(state.ui.activeCat); if(!c) return;
  catEditingId=c.id; $('catModalTitle').textContent='管理分类'; $('catName').value=c.name; pickedColor=c.color; renderColorRow();
  $('catDeleteBtn').classList.remove('hidden'); $('catMask').classList.remove('hidden');
}
function closeCat(){ $('catMask').classList.add('hidden'); }
function renderColorRow(){
  $('colorRow').innerHTML = GRAYS.map(c=>`<div class="color-dot ${pickedColor===c?'active':''}" style="background:${c}" onclick="pickedColor='${c}';renderColorRow()"></div>`).join('');
}
function saveCat(){
  const name = $('catName').value.trim();
  if(!name){ toast('分类名称必填'); return; }
  if(catEditingId){ const c = catOf(catEditingId); c.name=name; c.color=pickedColor; }
  else{ state.categories.push({id:cid(), name, color:pickedColor}); }
  persist(); closeCat(); renderLibrary(); toast('分类已保存');
}
function deleteCat(){
  if(!catEditingId) return;
  const used = state.prompts.filter(p=>p.categoryId===catEditingId).length;
  if(!confirm(`删除后，${used} 条提示词将变为未分类。确定删除？`)) return;
  state.prompts.forEach(p=>{ if(p.categoryId===catEditingId) p.categoryId=null; });
  state.categories = state.categories.filter(c=>c.id!==catEditingId);
  state.ui.activeCat='all'; persist(); closeCat(); renderLibrary();
}

/* ============================================================
 * 8. 模版套用
 * ============================================================ */
let applyId = null;
function openApply(id){
  const p = promptOf(id); if(!p) return;
  applyId = id;
  const vars = extractVars(p.text);
  const box = $('applyVars');
  if(!vars.length){ box.innerHTML = '<p style="color:var(--ink-3);font-size:13.5px;margin:0 0 14px">这条提示词没有占位符，可直接复制正文。</p>'; }
  else{
    box.innerHTML = vars.map(v=>`<div class="field"><label>${esc(v)}</label><input data-var="${esc(v)}" placeholder="填入 ${esc(v)}"></div>`).join('');
  }
  $('applyResult').value = p.text;
  $('applyMask').classList.remove('hidden');
  setTimeout(()=>{ const inp=box.querySelector('input'); if(inp) inp.focus(); },120);
}
function closeApply(){ $('applyMask').classList.add('hidden'); }
function applyFill(){
  const p = promptOf(applyId); if(!p) return p.text;
  let out = p.text;
  document.querySelectorAll('#applyVars input[data-var]').forEach(inp=>{
    const v = inp.dataset.var; const val = inp.value.trim();
    out = out.replaceAll(`{${v}}`, val||`{${v}}`);
  });
  return out;
}
function copyApplyResult(){
  const out = applyFill();
  $('applyResult').value = out;
  const p = promptOf(applyId);
  if($('applyMarkUsed').checked && p){ p.useCount=(p.useCount||0)+1; p.lastUsedAt=Date.now(); persist(); }
  navigator.clipboard.writeText(out).then(()=>toast('成品已复制')).catch(()=>{ fallbackCopy(out); toast('成品已复制'); });
  renderLibrary();
}

/* ============================================================
 * 9. 版本历史
 * ============================================================ */
let versionId = null;
function openVersion(id){
  versionId = id;
  const p = promptOf(id); if(!p) return;
  const box = $('versionList');
  const items = [{text:p.text, note:p.note||'', createdAt:p.updatedAt||p.createdAt, current:true}, ...(p.versions||[])];
  if(items.length<=1){ box.innerHTML = '<p style="color:var(--ink-3);font-size:13.5px">暂无历史版本，保存时若正文有改动会自动留档。</p>'; }
  else{
    box.innerHTML = items.map((v,i)=>`
      <div class="version-item">
        <div class="v-head">
          ${v.current?'<span class="badge solid">当前</span>':'<span class="badge">历史</span>'}
          <span class="v-time">${fmtTime(v.createdAt)}</span>
          ${v.current?'':`<button class="btn sm" onclick="rollbackVersion(${i-1})">回滚</button>
            <button class="icon-btn" style="width:30px;height:30px;color:var(--ink-3)" title="删除此版本" onclick="deleteVersion(${i-1})">${I.trash}</button>`}
        </div>
        <div class="v-text">${esc(v.text)}</div>
        ${v.note?`<div class="v-text" style="color:var(--ink-3);margin-top:4px">备注：${esc(v.note)}</div>`:''}
      </div>`).join('');
  }
  $('versionMask').classList.remove('hidden');
}
function closeVersion(){ $('versionMask').classList.add('hidden'); }
function rollbackVersion(idx){
  const p = promptOf(versionId); if(!p) return;
  const v = (p.versions||[])[idx]; if(!v) return;
  if(!confirm('回滚将把当前正文存入历史，再恢复到所选版本。')) return;
  p.versions = p.versions||[];
  p.versions.unshift({text:p.text, note:p.note||'', createdAt:Date.now()});
  p.text = v.text; p.note = v.note||''; p.updatedAt = Date.now();
  persist(); closeVersion(); renderLibrary(); toast('已回滚');
}
/* 删除单个历史版本（不能删"当前"版本，那个走回滚覆盖） */
function deleteVersion(idx){
  const p = promptOf(versionId); if(!p) return;
  const v = (p.versions||[])[idx]; if(!v) return;
  const preview = String(v.text||'').slice(0,40).replace(/\s+/g,' ');
  if(!confirm(`删除这个历史版本？\n\n${preview}…\n\n删除后不可恢复。`)) return;
  p.versions.splice(idx, 1);
  persist();
  openVersion(versionId);   // 重新渲染列表
  toast('已删除该版本');
}
/* 清空全部历史版本 */
function clearVersions(){
  const p = promptOf(versionId); if(!p) return;
  const n = (p.versions||[]).length;
  if(!n) return;
  if(!confirm(`删除全部 ${n} 个历史版本？当前正文会保留，仅清空历史。`)) return;
  p.versions = [];
  persist();
  openVersion(versionId);
  toast('历史版本已清空');
}

/* ============================================================
 * 10. 翻译
 * ============================================================ */
let transId = null;
async function openTrans(id){
  const p = promptOf(id); if(!p) return;
  transId = id;
  $('transSource').textContent = p.text;
  $('transResult').textContent = '翻译中…';
  $('transMask').classList.remove('hidden');
  try{
    const out = await callAI(
      '你是专业的 AI 绘图提示词翻译。若原文为中文则译为地道英文提示词，若为英文则译为中文；保留提示词的模块结构与专有名词，只输出译文本身，不要解释。',
      p.text
    );
    $('transResult').textContent = out;
  }catch(err){
    $('transResult').innerHTML = `<span class="err" style="color:#b03a3a">翻译失败：${esc(err.message||err)}</span>`;
  }
}
function closeTrans(){ $('transMask').classList.add('hidden'); }
function copyTrans(){
  navigator.clipboard.writeText($('transResult').textContent).then(()=>toast('译文已复制')).catch(()=>toast('复制失败'));
}
function replaceByTrans(){
  const p = promptOf(transId); if(!p) return;
  const t = $('transResult').textContent.trim();
  if(!t || t === '翻译中…' || t.includes('翻译失败')){ toast('译文还未生成'); return; }
  p.versions = p.versions||[];
  p.versions.unshift({text:p.text, note:p.note||'', createdAt:Date.now()});
  p.text = t; p.updatedAt = Date.now();
  persist(); closeTrans(); renderLibrary(); toast('正文已替换为译文');
}

/* ============================================================
 * 11. 拼装器
 * ============================================================ */
/*
 * 字段顺序决定拼装出来的语序。按「先是谁 → 在做什么 → 在哪 → 什么光 → 什么质感 → 怎么拍」
 * 组织，这最接近提示词模型理解画面的习惯。
 */
const BUILD_FIELDS = [
  ['bSubject', '主体'],
  ['bAppear',  '外貌'],
  ['bHair',    '发型妆容'],
  ['bCloth',   '服装配饰'],
  ['bAction',  '动作姿态'],
  ['bExpr',    '表情眼神'],
  ['bBg',      '背景'],
  ['bProp',    '环境元素'],
  ['bLight',   '光影'],
  ['bColor',   '色调'],
  ['bTex',     '质感细节'],
  ['bMood',    '氛围'],
  ['bComp',    '构图'],
  ['bLens',    '镜头'],
  ['bStyle',   '风格'],
  ['bModel',   '模型'],
  ['bRatio',   '比例'],
];

/** 收集已填写的模块，返回 [{label, value}] */
function collectBuilderParts(){
  return BUILD_FIELDS
    .map(([id, label])=>({label, value: ($(id)?.value || '').trim()}))
    .filter(x=>x.value);
}

/** 拼装成品文本（不含负面） */
function buildPromptText(parts, neg){
  let out = parts.map(p=>p.value).join(', ');
  if(neg) out += `\nNegative prompt: ${neg}`;
  return out;
}

function assemble(){
  const parts = collectBuilderParts();
  const neg = $('bNeg').value.trim();
  const out = buildPromptText(parts, neg);
  $('bResult').value = out;
  // 改动后旧译文作废
  $('bTransOut').classList.add('hidden');
  if(!out){ toast('先填写至少一个模块'); return; }
  toast(`已拼装 ${parts.length} 个模块`);
}

function copyBuilder(){
  const v = $('bResult').value.trim();
  if(!v){ toast('还没有拼装结果'); return; }
  navigator.clipboard.writeText(v).then(()=>toast('成品已复制')).catch(()=>{ fallbackCopy(v); toast('成品已复制'); });
}
function saveBuilderToLib(){
  const v = $('bResult').value.trim();
  if(!v){ toast('先拼装出结果再存库'); return; }
  const neg = $('bNeg').value.trim();
  openEdit(null, {text:v, negative:neg, categoryId:state.ui.activeCat!=='all'?state.ui.activeCat:null, title:$('bSubject').value.trim()||'拼装提示词'});
}
function clearBuilder(){
  BUILD_FIELDS.forEach(([id])=>{ const el=$(id); if(el) el.value=''; });
  ['bNeg','bResult'].forEach(id=>{ const el=$(id); if(el) el.value=''; });
  $('bTransOut').classList.add('hidden');
  $('bTransText').textContent = '';
  toast('已清空');
}

/* ---- 拼装器翻译：中 → 英 / 英 → 中，逐模块翻，保留结构 ---- */
let lastBuilderTrans = '';
function detectLang(text){
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  return cjk > text.replace(/\s/g,'').length * 0.15 ? 'zh' : 'en';
}

async function translateBuilder(){
  const parts = collectBuilderParts();
  if(!parts.length){ toast('先填写至少一个模块'); return; }
  const cfg = getActiveConfig();
  if(!cfg?.model){ toast('请先在「我的」里配置模型'); return; }

  // 若还没拼装，先拼
  if(!$('bResult').value.trim()) assemble();

  const neg = $('bNeg').value.trim();
  const srcText = parts.map(p=>p.value).join(', ');
  const toEn = detectLang(srcText) === 'zh';

  const out = $('bTransOut');
  const body = $('bTransText');
  out.classList.remove('hidden');
  $('bTransLabel').textContent = toEn ? 'English' : '中文';
  body.innerHTML = '<span style="color:var(--ink-3)">翻译中…</span>';

  // 按模块翻译，保证输出能一一对应回填
  const lines = parts.map((p,i)=>`${i+1}. [${p.label}] ${p.value}`).join('\n');
  const system = toEn
    ? '你是 AI 绘图提示词翻译。把用户给出的每个"编号 + [模块名] + 内容"逐条翻译为地道的英文绘图提示词，保持编号和 [模块名] 不变，只翻译内容。专有名词、镜头参数（如 35mm、f/1.8）、比例（如 3:4）保持原样。只输出翻译结果，每行一条，不要额外解释。'
    : '你是 AI 绘图提示词翻译。把用户给出的每个"编号 + [模块名] + 内容"逐条翻译为简洁的中文，保持编号和 [模块名] 不变，只翻译内容。专有名词、镜头参数（如 35mm、f/1.8）、比例（如 3:4）保持原样。只输出翻译结果，每行一条，不要额外解释。';

  try{
    const res = await callAI(system, lines);
    // 解析回模块，避免模型排版差异导致错位
    const map = {};
    String(res).split('\n').forEach(line=>{
      const m = line.match(/^\s*(\d+)[.、)]\s*(?:\[[^\]]*\]\s*)?(.*)$/);
      if(m) map[Number(m[1])] = m[2].trim();
    });
    const translated = parts.map((p,i)=>{
      const v = map[i+1] || p.value;
      return v;
    });
    const clean = translated.map(t=>t.replace(/[\r\n]+/g,' ').trim()).filter(Boolean);
    let text = clean.join(', ');
    if(neg){
      let negT = neg;
      const negLine = String(res).split('\n').find(l=>/negative|负面/i.test(l));
      if(toEn && negLine){
        negT = negLine.replace(/^.*?(negative prompt|负面提示词)\s*[:：]?\s*/i,'').trim() || neg;
      }
      text += `\nNegative prompt: ${negT}`;
    }
    lastBuilderTrans = text;
    body.textContent = text;
    body.style.whiteSpace = 'pre-wrap';
    body.style.color = 'var(--ink)';
  }catch(err){
    body.innerHTML = `<span style="color:#b03a3a">翻译失败：${esc(err.message||err)}</span>`;
    body.style.whiteSpace = '';
  }
}
function copyBuilderTrans(){
  if(!lastBuilderTrans){ toast('还没有译文'); return; }
  navigator.clipboard.writeText(lastBuilderTrans)
    .then(()=>toast('译文已复制'))
    .catch(()=>{ fallbackCopy(lastBuilderTrans); toast('译文已复制'); });
}

/* ============================================================
 * 12. 模型配置（原逻辑）
 * ============================================================ */
function getActiveConfig(){ return state.modelConfigs.find(c=>c.id===state.activeConfigId)||state.modelConfigs[0]; }

function renderModelList(){
  const box = $('modelList');
  if(!state.modelConfigs.length){ box.innerHTML = '<p style="color:var(--ink-3);font-size:13.5px;margin:0 0 8px">还没有模型配置，点右上「新增」接入。</p>'; return; }
  box.innerHTML = state.modelConfigs.map(c=>{
    const active = c.id===state.activeConfigId;
    return `<div class="model-card">
      <div class="m-head">
        <span class="m-name">${esc(c.name)}</span>
        ${active?'<span class="badge solid">使用中</span>':''}
      </div>
      <div class="m-info">${c.provider==='gemini'?'Gemini':'OpenAI 兼容'} · ${esc(c.model||'未填模型')}</div>
      <div class="m-info">${esc(c.baseUrl||'')}</div>
      <div class="m-actions">
        ${active?'':`<button class="btn sm" onclick="activateConfig('${c.id}')">设为当前</button>`}
        <button class="btn sm" onclick="openModelModal('${c.id}')">编辑</button>
        <button class="btn sm" onclick="testConfig('${c.id}')">测试连接</button>
        <button class="btn sm danger" onclick="deleteConfig('${c.id}')">删除</button>
      </div>
    </div>`;
  }).join('');
}

let modelEditingId = null;
function openModelModal(id){
  modelEditingId = id||null;
  const c = id? state.modelConfigs.find(x=>x.id===id) : null;
  $('modelModalTitle').textContent = c?'编辑模型配置':'新增模型配置';
  $('mName').value = c?.name||'';
  $('mProvider').value = c?.provider||'openai';
  $('mBaseUrl').value = c?.baseUrl||'https://api.openai.com/v1';
  $('mApiKey').value = c?.apiKey||'';
  $('mModel').value = c?.model||'';
  $('mTemp').value = c?.temperature??0.7;
  $('mTempVal').textContent = c?.temperature??0.7;
  onModelProviderChange();
  $('modelMask').classList.remove('hidden');
}
function closeModelModal(){ $('modelMask').classList.add('hidden'); }
function onModelProviderChange(){
  const v = $('mProvider').value;
  if(v==='gemini'){
    $('mBaseUrl').placeholder='https://generativelanguage.googleapis.com';
    if(!$('mBaseUrl').value.includes('generativelanguage')) $('mBaseUrl').value='https://generativelanguage.googleapis.com';
  }else{
    $('mBaseUrl').placeholder='https://api.openai.com/v1';
    if($('mBaseUrl').value.includes('generativelanguage')) $('mBaseUrl').value='https://api.openai.com/v1';
  }
}
function saveModelConfig(){
  const name = $('mName').value.trim()||'未命名配置';
  const cfg = {
    id: modelEditingId||cid(), name,
    provider:$('mProvider').value, baseUrl:$('mBaseUrl').value.trim(),
    apiKey:$('mApiKey').value.trim(), model:$('mModel').value.trim(),
    temperature:Number($('mTemp').value)
  };
  if(modelEditingId){
    Object.assign(state.modelConfigs.find(x=>x.id===modelEditingId), cfg);
  }else{
    state.modelConfigs.push(cfg);
    // 新增的配置直接设为当前：用户刚填完一套，显然是想用它
    state.activeConfigId = cfg.id;
  }
  // 保存必须落盘成功才算成功，失败时明确告知
  const saved = persist();
  closeModelModal(); renderModelList(); renderProfileHero();
  toast(saved ? '配置已保存并设为当前' : '配置已添加，但本地保存失败');
}
function activateConfig(id){ state.activeConfigId=id; persist(); renderModelList(); renderProfileHero(); toast('已切换当前模型'); }
function deleteConfig(id){
  if(state.modelConfigs.length<=1){ toast('至少保留一套配置'); return; }
  if(!confirm('删除这套模型配置？')) return;
  state.modelConfigs = state.modelConfigs.filter(x=>x.id!==id);
  if(state.activeConfigId===id) state.activeConfigId=state.modelConfigs[0].id;
  persist(); renderModelList(); renderProfileHero();
}
async function testConfig(id){
  const cfg = state.modelConfigs.find(x=>x.id===id); if(!cfg) return;
  toast('正在测试连接…');
  try{
    const t0=Date.now();
    await callAI('ping','只回复 ok 两个字', {cfg});
    toast(`连接成功，${Date.now()-t0}ms`);
  }catch(err){ toast('连接失败：'+(err.message||err)); }
}

/* ============================================================
 * 13. 工作台（原逻辑 + 分段任务选择）
 * ============================================================ */
const TASK_LIST = [
  ['summary','模版总结'], ['advice','写作建议'], ['optimize','单条优化'],
  ['review','质检打分'], ['variants','扩写变体'], ['reverse','图片反推'], ['free','自由问答']
];
const TASK_DESC = {
  summary:'提炼共性结构，给出带占位符的模版范例',
  advice:'归纳写法规律与常见踩坑点',
  optimize:'润色并给出增强版本，说明改动理由',
  review:'按要素完整性逐项打分并给出改进点',
  variants:'保留核心设定，生成多个不同角度版本',
  reverse:'由案例图反推中英文提示词',
  free:'针对所选素材自由提问'
};
function renderTaskSeg(){
  $('taskSeg').innerHTML = TASK_LIST.map(([v,t], i)=>`<button data-task="${v}" class="${i===0?'on':''}" onclick="pickTask('${v}')">${t}</button>`).join('');
  // 分段控件两行更易点按：把 7 项拆成 2 列网格
  $('taskSeg').style.display = 'grid';
  $('taskSeg').style.gridTemplateColumns = 'repeat(4, 1fr)';
  $('taskSeg').style.gap = '2px';
}
function pickTask(v){
  document.querySelectorAll('#taskSeg button').forEach(b=>b.classList.toggle('on', b.dataset.task===v));
  const r = document.querySelector(`input[name="taskType"][value="${v}"]`);
  if(r){ r.checked = true; }
  onTaskChange();
  $('taskDesc').textContent = TASK_DESC[v] || '';
}

function renderWorkbench(){
  renderTaskSeg();
  const cfg = getActiveConfig();
  $('wbModelPill').innerHTML = `<span class="dot"></span>${esc(cfg?.name||'未配置')} · ${esc(cfg?.model||'未选模型')}`;
  $('wbCatPick').innerHTML = state.categories.map(c=>`
    <label><input type="checkbox" class="wb-cat" value="${c.id}"> ${esc(c.name)}（${state.prompts.filter(p=>p.categoryId===c.id).length}）</label>`).join('')
    || '<p style="font-size:13px;color:var(--ink-3);padding:6px;margin:0">暂无分类</p>';
  $('wbPromptPick').innerHTML = state.prompts.map(p=>`
    <label><input type="checkbox" class="wb-prompt" value="${p.id}"> ${esc(p.title)}</label>`).join('')
    || '<p style="font-size:13px;color:var(--ink-3);padding:6px;margin:0">库里还没有提示词</p>';
  renderHistory();
}

function onTaskChange(){
  const checked = document.querySelector('input[name="taskType"]:checked');
  const t = checked ? checked.value : 'summary';
  $('varCountField').classList.toggle('hidden', t!=='variants');
  $('reverseField').classList.toggle('hidden', t!=='reverse');
  $('freeQField').classList.toggle('hidden', t!=='free');
  document.querySelectorAll('#taskSeg button').forEach(b=>b.classList.toggle('on', b.dataset.task===t));
}

function collectSelected(){
  const catIds = [...document.querySelectorAll('.wb-cat:checked')].map(i=>i.value);
  const promptIds = [...document.querySelectorAll('.wb-prompt:checked')].map(i=>i.value);
  let items = state.prompts.filter(p=>promptIds.includes(p.id));
  if(catIds.length) items = items.concat(state.prompts.filter(p=>catIds.includes(p.categoryId) && !items.includes(p)));
  return items;
}

function buildUserPrompt(items, taskType, freeQ){
  const blocks = items.map((p,i)=>{
    const c = catOf(p.categoryId);
    return `【素材 ${i+1}】${p.title}（分类：${c?c.name:'未分类'}；标签：${(p.tags||[]).join('、')||'无'}）\n提示词：\n${p.text}\n${p.negative?`负面提示词：${p.negative}`:''}\n${p.note?`备注：${p.note}`:''}`;
  }).join('\n\n');

  const taskMap = {
    summary: '请基于以上提示词素材，总结这类提示词的可复用模版：① 提炼共性结构（主体 / 风格 / 光影 / 构图 / 质感 / 氛围等模块）；② 给出带占位符（如 {主体}、{场景}、{风格}）的模版范例；③ 列出 3-5 条可迁移的写作套路。用中文，层次清晰。',
    advice: '请基于以上提示词素材，归纳这类提示词的写作规律：① 高质量条目通常包含哪些要素；② 常见写法建议与表达技巧；③ 容易遗漏或写坏的踩坑点。用中文，分条输出。',
    optimize: '请逐条或整体优化选中的提示词：保留原意，补足画面细节、质感、光影与镜头语言，给出增强后的提示词版本，并说明改了哪里、为什么。模版部分用代码块给出。',
    review: '请对选中的提示词做质检：按主体明确度、风格、光影、构图、质感、氛围、细节密度逐项打分（每项 1-5 分），给出总分（折算 10 分制），指出缺失要素和具体可执行的改进建议。用中文，先给评分表再给建议。',
    variants: `请基于以下提示词，生成 ${$('varCount').value} 个不同角度 / 氛围的变体版本；保留核心设定，每个版本独立成段，依次标注「变体一 / 变体二 / …」，并各附一句差异说明。`,
    reverse: '请根据这张图片反推一段可用于 AI 绘图的提示词：描述主体、外观、服饰、姿态、场景、光影、色调、构图、镜头与质感；先给中文提示词，再给一段英文提示词，最后列一组适用的负面提示词。',
    free: `请结合以上素材回答我的问题：${freeQ||'（未填写问题）'}。用中文，结合素材给出具体可操作的建议。`
  };
  const head = items.length ? `以下是用户收藏的提示词素材：\n\n${blocks}\n\n` : '';
  return head + taskMap[taskType];
}

let wbMessages = [];
let reverseImage = null;
let lastResult = '';

async function callAI(system, user, opts={}){
  const cfg = opts.cfg || getActiveConfig();
  if(!cfg) throw new Error('请先在「我的」页面添加模型配置');
  if(!cfg.baseUrl || !cfg.model) throw new Error('模型配置缺少接口地址或模型名称');
  const images = opts.images||[];
  const history = wbMessages.length ? wbMessages : [{role:'user', content:user}];

  if(cfg.provider==='gemini'){
    const base = cfg.baseUrl.replace(/\/+$/,'');
    const url = `${base}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
    const contents = history.map(m=>({
      role: m.role==='assistant' ? 'model' : 'user',
      parts: m.parts || [{text:m.content}]
    }));
    const last = contents[contents.length-1];
    images.forEach(src=>{
      const [meta,data] = src.split(',');
      const mime = /data:(.*?);/.exec(meta)?.[1]||'image/jpeg';
      last.parts.push({inlineData:{mimeType:mime, data}});
    });
    const resp = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({contents, systemInstruction:{parts:[{text:system}]}, generationConfig:{temperature:cfg.temperature}})});
    const data = await resp.json();
    if(!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);
    return data.candidates?.[0]?.content?.parts?.map(p=>p.text).join('') || '（模型未返回内容）';
  }

  const base = cfg.baseUrl.replace(/\/+$/,'');
  const url = `${base}/chat/completions`;
  const messages = history.map(m=>{
    if(m.parts) return {role:m.role, content:m.parts};
    return {role:m.role, content:m.content};
  });
  const last = messages[messages.length-1];
  if(images.length && typeof last.content==='string'){
    last.content = [{type:'text', text:last.content}];
    images.forEach(src=>last.content.push({type:'image_url', image_url:{url:src}}));
  }
  const resp = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${cfg.apiKey}`},
    body:JSON.stringify({model:cfg.model, temperature:cfg.temperature, messages:[{role:'system',content:system}, ...messages]})});
  const data = await resp.json();
  if(!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);
  return data.choices?.[0]?.message?.content || '（模型未返回内容）';
}

function resetConversation(){
  wbMessages = []; reverseImage = null;
  $('reversePreview').innerHTML=''; $('reverseImg').value='';
  $('wbResult').innerHTML = '<p style="color:var(--ink-3);margin:0">对话已清空，可开启新任务。</p>';
  $('followupBox').classList.add('hidden');
  $('btnCopyResult').classList.add('hidden'); $('btnSaveTpl').classList.add('hidden');
}

async function runWorkbench(){
  const checked = document.querySelector('input[name="taskType"]:checked');
  const taskType = checked ? checked.value : 'summary';
  onTaskChange();
  const items = collectSelected();

  if(taskType!=='reverse' && !items.length){ toast('请先勾选分类或提示词'); return; }
  if(taskType==='reverse' && !reverseImage){ toast('请先上传要反推的案例图'); return; }
  if(!getActiveConfig()?.model){ toast('请先在「我的」里配置模型'); return; }

  const system = '你是资深 AI 绘画 / 生成式提示词教练，擅长从优秀案例中提炼结构、沉淀模版，并给出可落地的写作建议。回答简洁专业，避免空话。';
  const user = buildUserPrompt(items, taskType, $('freeQuestion').value.trim());

  wbMessages = [{role:'user', content:user}];
  const box = $('wbResult');
  box.innerHTML = '<p class="loading" style="margin:0">正在调用模型分析，请稍候…</p>';
  $('btnCopyResult').classList.add('hidden'); $('btnSaveTpl').classList.add('hidden'); $('followupBox').classList.add('hidden');

  try{
    const out = await callAI(system, user, {images: taskType==='reverse'?[reverseImage]:[]});
    wbMessages.push({role:'assistant', content:out});
    lastResult = out;
    box.innerHTML = renderMarkdown(out);
    $('btnCopyResult').classList.remove('hidden');
    $('btnSaveTpl').classList.remove('hidden');
    $('followupBox').classList.remove('hidden');
    state.history.unshift({id:cid(), type:taskType, title:items.map(i=>i.title).slice(0,3).join('、')+(items.length>3?` 等 ${items.length} 条`:taskType==='reverse'?'图片反推':''), prompt:user, result:out, createdAt:Date.now()});
    if(state.history.length>30) state.history.pop();
    persist(); renderHistory();
    pageEls[2].scrollTo({top: pageEls[2].querySelector('#wbResult').getBoundingClientRect().top + pageEls[2].scrollTop - 120, behavior:'smooth'});
  }catch(err){
    box.innerHTML = `<p style="color:#b03a3a;margin:0">调用失败：${esc(err.message||err)}</p><p style="color:var(--ink-3);margin:8px 0 0;font-size:13px">常见原因：接口地址 / Key / 模型名填错、模型不支持图片输入、浏览器跨域受限，或所选兼容端点不支持浏览器直连。请在「我的 · 模型接入」核对配置后重试。</p>`;
  }
}

async function sendFollowup(){
  const q = $('followupInput').value.trim();
  if(!q) return;
  if(!wbMessages.length){ toast('请先完成一次分析'); return; }
  $('followupInput').value='';
  wbMessages.push({role:'user', content:q});
  const box = $('wbResult');
  box.innerHTML += `<p class="loading" style="margin-top:12px">继续追问中…</p>`;
  try{
    const system = '你是资深 AI 绘画提示词教练，结合上文对话继续回答，保持简洁专业。';
    const out = await callAI(system, q);
    wbMessages.push({role:'assistant', content:out});
    lastResult = out;
    box.innerHTML = renderMarkdown(out);
    $('btnCopyResult').classList.remove('hidden'); $('btnSaveTpl').classList.remove('hidden');
  }catch(err){
    box.innerHTML += `<p style="color:#b03a3a;margin-top:8px">追问失败：${esc(err.message||err)}</p>`;
  }
}

function onReversePicked(e){
  const file = e.target.files[0]; if(!file) return;
  compressFile(file, d=>{ reverseImage = d; $('reversePreview').innerHTML = `<img src="${d}" alt="">`; });
  e.target.value='';
}

function copyResult(){
  navigator.clipboard.writeText(lastResult).then(()=>toast('结果已复制')).catch(()=>{ fallbackCopy(lastResult); toast('结果已复制'); });
}

function saveAsTemplate(){
  if(!lastResult) return;
  const firstLine = lastResult.split('\n').find(l=>l.trim()) || 'AI 沉淀模版';
  state.prompts.push({
    id:cid(), title:firstLine.replace(/^#+\s*/,'').slice(0,40), categoryId:state.ui.activeCat!=='all'?state.ui.activeCat:null,
    tags:['AI模版'], text:lastResult, negative:'', ratio:'', genModel:'', seed:'',
    note:'由工作台 AI 分析沉淀，可在此基础上改写套用。',
    images:[], level:3, favorite:false, pinned:false, isTemplate:true,
    useCount:0, quality:null, versions:[], lastUsedAt:null,
    createdAt:Date.now(), updatedAt:Date.now()
  });
  persist(); renderLibrary(); toast('已存为模版');
}

function renderHistory(){
  const box = $('historyList');
  $('historyEmpty').classList.toggle('hidden', state.history.length>0);
  const TYPE = {summary:'模版总结',advice:'写作建议',optimize:'单条优化',review:'质检打分',variants:'扩写变体',reverse:'图片反推',free:'自由问答'};
  box.innerHTML = state.history.map(h=>`
    <div class="history-item">
      <div class="h-head">
        <span class="badge">${TYPE[h.type]||h.type}</span>
        <span class="h-title">${esc(h.title)}</span>
        <span class="h-time">${fmtTime(h.createdAt)}</span>
        <button class="icon-btn" style="width:26px;height:26px;color:var(--ink-3)" title="再次查看" onclick="viewHistory('${h.id}')">${I.eye}</button>
        <button class="icon-btn" style="width:26px;height:26px;color:var(--ink-3)" title="删除" onclick="deleteHistory('${h.id}')">${I.trash}</button>
      </div>
      <div class="h-body">${esc(h.result)}</div>
    </div>`).join('');
}
function viewHistory(id){
  const h = state.history.find(x=>x.id===id); if(!h) return;
  lastResult = h.result;
  $('wbResult').innerHTML = renderMarkdown(h.result);
  $('btnCopyResult').classList.remove('hidden');
  $('btnSaveTpl').classList.remove('hidden');
  pageEls[2].scrollTo({top: pageEls[2].querySelector('#wbResult').getBoundingClientRect().top + pageEls[2].scrollTop - 120, behavior:'smooth'});
}
function deleteHistory(id){ state.history = state.history.filter(x=>x.id!==id); persist(); renderHistory(); }

/* ============================================================
 * 14. 个人中心 / 相册（原逻辑）
 * ============================================================ */
function renderProfile(){
  renderProfileHero(); renderGroupBar(); renderAlbum(); renderModelList();
  $('activeCatHint').textContent = state.ui.activeCat==='all' ? '（当前为「全部」，先选分类）' : `（${catOf(state.ui.activeCat)?.name||''}）`;
}
function renderProfileHero(){
  $('heroAvatar').textContent = state.profile.avatar||'🎨';
  $('heroName').textContent = state.profile.name||'我的相册';
  const n = state.gallery.length;
  $('heroSub').textContent = n? `共 ${n} 组图集 · ${state.gallery.reduce((s,g)=>s+(g.imageKeys||[]).length,0)} 张好图` : '还没有作品集，上传第一张满意的好图吧';
  const lsSize = new Blob([JSON.stringify(stripForBackup())]).size;
  let imgSize = 0;
  imgCache.forEach(d=>{ if(typeof d==='string') imgSize += d.length; });
  imgSize = Math.round(imgSize*0.75);
  const total = lsSize+imgSize || 1;
  $('barLs').style.width = (lsSize/total*100)+'%';
  $('barImgs').style.width = (imgSize/total*100)+'%';
  $('storageMeta').innerHTML = `<span>文本/配置 ${fmtBytes(lsSize)}</span><span>相册图片 ${fmtBytes(imgSize)}</span>`;
}
function renderGroupBar(){
  const allOn = state.ui.activeGroup==='all';
  let html = `<button class="chip ${allOn?'on':''}" onclick="setGroup('all')">全部 <span class="cnt">${state.gallery.length}</span></button>`;
  state.groups.forEach(g=>{
    const n = state.gallery.filter(x=>x.groupId===g.id).length;
    html += `<button class="chip ${state.ui.activeGroup===g.id?'on':''}" onclick="setGroup('${g.id}')"><span>${g.icon||''}</span>${esc(g.name)} <span class="cnt">${n}</span></button>`;
  });
  $('groupBar').innerHTML = html;
}
function setGroup(id){ state.ui.activeGroup=id; renderGroupBar(); renderAlbum(); }

function renderAlbum(){
  const box = $('albumGrid');
  const list = state.gallery.filter(g=>state.ui.activeGroup==='all'||g.groupId===state.ui.activeGroup);
  $('albumEmpty').classList.toggle('hidden', list.length>0);
  if(!list.length){ box.innerHTML=''; return; }
  box.innerHTML = list.map(g=>{
    const cover = g.imageKeys&&g.imageKeys.length? imgGet(g.imageKeys[0]) : null;
    const gp = groupOf(g.groupId);
    const linked = g.promptId? promptOf(g.promptId) : null;
    const n = (g.imageKeys||[]).length;
    // 点击卡片 = 看图（可左右滑动）；右上角铅笔 = 编辑；长按 = 编辑
    return `<div class="album-card" data-gid="${g.id}" onclick="onAlbumClick(event,'${g.id}')">
      <div class="album-cover">
        ${cover?`<img src="${cover}" alt="" loading="lazy">`:'<div class="ph">🖼</div>'}
        ${n?`<span class="count">${n}</span>`:''}
        <button class="album-edit" title="编辑图集" aria-label="编辑图集"
                onclick="event.stopPropagation();openGalleryEdit('${g.id}')">${I.edit}</button>
      </div>
      <div class="album-body">
        <div class="album-title">${esc(g.title)}</div>
        <div class="album-meta">${gp?esc(gp.name):'未分组'}${linked?' · 🔗 '+esc(linked.title):''}</div>
      </div>
    </div>`;
  }).join('');
  bindAlbumLongPress();
}

/* 长按会先触发编辑；随后浏览器可能补发一次 click，用这个标志吞掉 */
let suppressAlbumClick = false;
function onAlbumClick(e, id){
  if(e.target.closest('.album-edit')) return;
  if(suppressAlbumClick){ suppressAlbumClick = false; return; }
  openGalleryViewer(id, 0);
}

/* 相册卡片长按 → 编辑 */
let albumLpTimer = null;
function bindAlbumLongPress(){
  $('albumGrid').querySelectorAll('.album-card').forEach(card=>{
    card.addEventListener('pointerdown', ()=>{
      clearTimeout(albumLpTimer);
      albumLpTimer = setTimeout(()=>{
        suppressAlbumClick = true;
        openGalleryEdit(card.dataset.gid);
        if(navigator.vibrate) try{ navigator.vibrate(10); }catch(_){}
      }, 480);
    });
    const cancel = ()=>clearTimeout(albumLpTimer);
    card.addEventListener('pointerup', cancel);
    card.addEventListener('pointerleave', cancel);
    card.addEventListener('pointercancel', cancel);
    card.addEventListener('pointermove', e=>{
      // 手指明显移动说明是在滑动，不是长按
      if(Math.abs(e.movementX) > 4 || Math.abs(e.movementY) > 4) cancel();
    });
    card.addEventListener('contextmenu', e=>e.preventDefault());
  });
}

let galleryEditingId = null, galleryImageKeys = [], galleryTags = [], galleryColorsPicked = null;
function openGalleryEdit(id){
  galleryEditingId = id||null;
  const g = id? state.gallery.find(x=>x.id===id) : null;
  galleryImageKeys = g? [...(g.imageKeys||[])] : [];
  galleryTags = g? [...(g.tags||[])] : [];
  $('galleryModalTitle').textContent = g?'编辑图集':'上传好图';
  $('gTitle').value = g?.title||'';
  $('gNote').value = g?.note||'';
  const gsel = $('gGroup');
  gsel.innerHTML = '<option value="">未分组</option>' + state.groups.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('');
  if(g?.groupId) gsel.value = g.groupId;
  const psel = $('gPrompt');
  psel.innerHTML = '<option value="">不关联</option>' + state.prompts.map(p=>`<option value="${p.id}">${esc(p.title)}</option>`).join('');
  if(g?.promptId) psel.value = g.promptId;
  refreshLinkedPrompt();
  $('gDeleteBtn').classList.toggle('hidden', !g);
  renderGalleryThumbs(); renderGalleryTags();
  $('galleryMask').classList.remove('hidden');
}
function refreshLinkedPrompt(){
  const pid = $('gPrompt').value;
  const p = pid? promptOf(pid) : null;
  $('gPromptLink').classList.toggle('hidden', !p);
  if(p) $('gPromptLinkTitle').textContent = p.title;
}
function copyLinkedPrompt(){
  const p = promptOf($('gPrompt').value); if(!p) return;
  navigator.clipboard.writeText(p.text).then(()=>toast('提示词已复制')).catch(()=>toast('复制失败'));
}
function closeGalleryEdit(){ $('galleryMask').classList.add('hidden'); }
function renderGalleryThumbs(){
  const box = $('gImgPicker');
  box.querySelectorAll('.img-thumb').forEach(e=>e.remove());
  const add = box.querySelector('.img-add');
  galleryImageKeys.forEach((k,i)=>{
    const u = imgGet(k); if(!u) return;
    const d = document.createElement('div');
    d.className='img-thumb';
    d.innerHTML = `<img src="${u}" alt=""><button class="rm" onclick="removeGalleryImage(${i})">✕</button>`;
    box.insertBefore(d, add);
  });
}
function removeGalleryImage(i){ const k = galleryImageKeys.splice(i,1)[0]; imgDelete(k); renderGalleryThumbs(); }
async function onGalleryImagesPicked(e){
  const files = [...e.target.files];
  e.target.value='';
  for(const f of files){
    await new Promise(res=>compressFile(f, async d=>{ galleryImageKeys.push(await imgPut(d)); res(); }));
  }
  renderGalleryThumbs();
}
function renderGalleryTags(){
  const wrap = $('gTagWrap');
  wrap.querySelectorAll('.tag-chip').forEach(e=>e.remove());
  galleryTags.forEach((t,i)=>{
    const chip = document.createElement('span');
    chip.className='tag-chip';
    chip.innerHTML = `#${esc(t)}<button onclick="removeGalleryTag(${i})">✕</button>`;
    wrap.insertBefore(chip, $('gTagInput'));
  });
}
function onGalleryTagKey(e){
  if(e.key==='Enter'||e.key===','){
    e.preventDefault();
    const v = e.target.value.trim().replace(/,/g,'');
    if(v && !galleryTags.includes(v)){ galleryTags.push(v); renderGalleryTags(); }
    e.target.value='';
  }
}
function removeGalleryTag(i){ galleryTags.splice(i,1); renderGalleryTags(); }

function saveGallery(){
  const title = $('gTitle').value.trim();
  if(!title){ toast('标题必填'); return; }
  const data = {
    title, groupId:$('gGroup').value||null, promptId:$('gPrompt').value||null,
    note:$('gNote').value.trim(), tags:galleryTags, imageKeys:galleryImageKeys
  };
  if(galleryEditingId){
    const g = state.gallery.find(x=>x.id===galleryEditingId);
    Object.assign(g, data, {updatedAt:Date.now()});
  }else{
    state.gallery.push({id:cid(), ...data, createdAt:Date.now(), updatedAt:Date.now()});
  }
  const saved = persist();
  closeGalleryEdit(); renderProfile();
  toast(saved ? '图集已保存' : '图集已保存到界面，但本地存储失败，请先导出备份');
}
function deleteGallery(){
  if(!galleryEditingId) return;
  if(!confirm('删除这组图集？图片将从本机数据库移除。')) return;
  const g = state.gallery.find(x=>x.id===galleryEditingId);
  (g?.imageKeys||[]).forEach(imgDelete);
  state.gallery = state.gallery.filter(x=>x.id!==galleryEditingId);
  persist(); closeGalleryEdit(); renderProfile(); toast('图集已删除');
}

function reverseFromGallery(){
  if(!galleryImageKeys.length){ toast('图集里还没有图片'); return; }
  const dataURL = imgGet(galleryImageKeys[0]);
  if(!dataURL){ toast('图片读取中，请稍候'); return; }
  reverseImage = dataURL;
  pickTask('reverse');
  $('reversePreview').innerHTML = `<img src="${dataURL}" alt="">`;
  closeGalleryEdit();
  setTab(2);
  toast('已带入图集首图，点「让 AI 分析整理」反推提示词');
}

/* ===== 分组管理 ===== */
let groupEditingId = null;
let pickedGroupColor = GRAYS[0];
let pickedGroupIcon = GROUP_ICONS[0];
function openGroupModal(){ groupEditingId=null; $('groupModalTitle').textContent='相册分组'; $('groupName').value=''; pickedGroupColor=GRAYS[0]; pickedGroupIcon=GROUP_ICONS[0]; $('groupDeleteBtn').classList.add('hidden'); renderGroupEditor(); renderGroupColorRow(); $('groupMask').classList.remove('hidden'); }
function closeGroupModal(){ $('groupMask').classList.add('hidden'); }
function renderGroupEditor(){
  $('groupIconRow').innerHTML = GROUP_ICONS.map(i=>`<div class="icon-opt ${pickedGroupIcon===i?'active':''}" onclick="pickedGroupIcon='${i}';renderGroupEditor()">${i}</div>`).join('');
  $('groupList').innerHTML = state.groups.map(g=>`
    <div class="model-card" style="margin-bottom:8px">
      <div class="m-head"><span class="m-name">${g.icon||''} ${esc(g.name)}</span>
        <button class="btn sm" onclick="editGroup('${g.id}')">编辑</button>
      </div>
    </div>`).join('') || '<p style="color:var(--ink-3);font-size:13.5px;margin:0 0 8px">还没有分组</p>';
}
function renderGroupColorRow(){
  $('groupColorRow').innerHTML = GRAYS.map(c=>`<div class="color-dot ${pickedGroupColor===c?'active':''}" style="background:${c}" onclick="pickedGroupColor='${c}';renderGroupColorRow()"></div>`).join('');
}
function editGroup(id){
  const g = groupOf(id); if(!g) return;
  groupEditingId = id; $('groupName').value = g.name; pickedGroupColor = g.color||GRAYS[0]; pickedGroupIcon = g.icon||GROUP_ICONS[0];
  $('groupDeleteBtn').classList.remove('hidden');
  renderGroupEditor(); renderGroupColorRow();
}
function saveGroup(){
  const name = $('groupName').value.trim();
  if(!name){ toast('分组名称必填'); return; }
  if(groupEditingId){ Object.assign(groupOf(groupEditingId), {name, color:pickedGroupColor, icon:pickedGroupIcon}); }
  else{ state.groups.push({id:cid(), name, color:pickedGroupColor, icon:pickedGroupIcon}); }
  persist(); groupEditingId=null; $('groupName').value=''; $('groupDeleteBtn').classList.add('hidden');
  renderGroupEditor(); renderProfile(); toast('分组已保存');
}
function deleteGroup(){
  if(!groupEditingId) return;
  if(!confirm('删除分组？组内图集将变为未分组。')) return;
  state.gallery.forEach(g=>{ if(g.groupId===groupEditingId) g.groupId=null; });
  state.groups = state.groups.filter(x=>x.id!==groupEditingId);
  groupEditingId=null; persist(); closeGroupModal(); renderProfile(); toast('分组已删除');
}

/* ===== 个人资料 ===== */
function openProfileEdit(){
  $('pName').value = state.profile.name||'';
  renderAvatarRow();
  $('profileMask').classList.remove('hidden');
}
function closeProfileEdit(){ $('profileMask').classList.add('hidden'); }
function renderAvatarRow(){
  $('pAvatarRow').innerHTML = AVATARS.map(a=>`<div class="icon-opt ${state.profile.avatar===a?'active':''}" onclick="state.profile.avatar='${a}';renderAvatarRow()">${a}</div>`).join('');
}
function saveProfile(){
  state.profile.name = $('pName').value.trim() || '我的相册';
  persist(); closeProfileEdit(); renderProfileHero(); toast('资料已保存');
}

/* ============================================================
 * 15. 导出 / 导入 / 清空（原逻辑）
 * ============================================================ */
function openExportModal(){
  const sel = $('exportScope');
  sel.innerHTML = `<option value="all">全部分类</option>` + state.categories.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('exportMask').classList.remove('hidden');
}
function closeExport(){ $('exportMask').classList.add('hidden'); }
function doExport(){
  const scope = $('exportScope').value;
  const fmt = $('exportFormat').value;
  let list = state.prompts.filter(p=>scope==='all'||p.categoryId===scope);
  if(!list.length){ toast('该范围下没有提示词'); return; }
  let content = '';
  if(fmt==='md'){
    const groups = scope==='all' ? state.categories : [catOf(scope)].filter(Boolean);
    content += `# 提示词合集（导出于 ${new Date().toLocaleString()}）\n\n`;
    const writeItem = p=>{
      const c = catOf(p.categoryId);
      content += `## ${p.title}\n\n`;
      content += `- 分类：${c?c.name:'未分类'}　标签：${(p.tags||[]).join('、')||'无'}\n`;
      if(p.ratio) content += `- 比例：${p.ratio}\n`;
      if(p.genModel) content += `- 模型：${p.genModel}\n`;
      if(p.seed) content += `- Seed：${p.seed}\n`;
      content += `\n**提示词：**\n\n${p.text}\n`;
      if(p.negative) content += `\n**负面提示词：** ${p.negative}\n`;
      if(p.note) content += `\n**备注：** ${p.note}\n`;
      content += `\n---\n\n`;
    };
    if(scope==='all'){
      groups.forEach(g=>{ list.filter(p=>p.categoryId===g.id).forEach(writeItem); });
      list.filter(p=>!p.categoryId).forEach(writeItem);
    }else{ list.forEach(writeItem); }
  }else{
    content = list.map(p=>`【${p.title}】\n${p.text}${p.negative?`\n负面：${p.negative}`:''}`).join('\n\n================\n\n');
  }
  const blob = new Blob([content], {type:'text/plain;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `提示词合集_${scope==='all'?'全部':catOf(scope)?.name||'分类'}.${fmt}`;
  a.click(); URL.revokeObjectURL(a.href);
  closeExport(); toast('合集已导出');
}

function stripForBackup(){
  const copy = JSON.parse(JSON.stringify(state));
  copy.gallery.forEach(g=>{ g.imageKeys = (g.imageKeys||[]).map(k=>imgGet(k)).filter(Boolean); });
  return copy;
}
function exportJSON(){
  const blob = new Blob([JSON.stringify(stripForBackup(),null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `提示词备份_${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(a.href);
  toast('备份文件已导出（含相册图片）');
}
async function importJSON(e){
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = async ()=>{
    try{
      const d = JSON.parse(reader.result);
      if(!d.prompts || !d.categories) throw new Error('文件格式不正确');
      if(!confirm('导入将覆盖当前库中的提示词、相册与配置。继续？')) return;
      for(const k of imgCache.keys()){ try{ await imgDelete(k); }catch(_){} }
      state.categories = d.categories; state.prompts = d.prompts; state.history = d.history||[];
      state.groups = d.groups||[]; state.profile = Object.assign({name:'我的相册',avatar:'🎨'}, d.profile||{});
      state.modelConfigs = d.modelConfigs||[]; state.activeConfigId = state.modelConfigs[0]?.id||null;
      state.gallery = (d.gallery||[]).map(g=>({...g, imageKeys:[]}));
      const rawGallery = d.gallery||[];
      for(let i=0;i<rawGallery.length;i++){
        const keys = [];
        for(const src of (rawGallery[i].imageKeys||[])){
          if(src && src.startsWith('data:')) keys.push(await imgPut(src));
          else if(src) keys.push(src);
        }
        state.gallery[i].imageKeys = keys;
      }
      persist(); renderLibrary(); renderWorkbench(); renderProfile(); toast('导入完成');
    }catch(err){ toast('导入失败：'+err.message); }
  };
  reader.readAsText(file);
  e.target.value='';
}
async function clearAll(){
  if(!confirm('将清空所有提示词、相册、分组、配置与历史记录，且不可恢复。确定？')) return;
  if(!confirm('再次确认：真的要清空全部数据吗？')) return;
  for(const k of imgCache.keys()){ try{ await imgDelete(k); }catch(_){} }
  localStorage.removeItem(STORE_KEY);
  state = {profile:{name:'我的相册',avatar:'🎨'}, categories:[], prompts:[], groups:[], gallery:[], modelConfigs:[], activeConfigId:null, history:[], settings:state.settings, ui:{activeCat:'all',activeTag:null,activeGroup:'all',search:'',view:'library',filter:'all',sort:'updated'}};
  persist(); renderLibrary(); renderProfile(); toast('已清空');
}

/* ============================================================
 * 16. 更多菜单 / 灯箱 / Sheet 拖拽关闭
 * ============================================================ */
function openMoreSheet(){ $('moreMask').classList.remove('hidden'); }
function closeMoreSheet(){ $('moreMask').classList.add('hidden'); }
function openLightbox(src){ $('lightboxImg').src = src; $('lightbox').classList.remove('hidden'); }

/* Sheet：拖动 grabber 下滑关闭 */
document.querySelectorAll('.modal-grabber[data-drag]').forEach(g=>{
  const mask = g.closest('.mask');
  const sheet = g.closest('.modal');
  let st = null;
  g.addEventListener('pointerdown', e=>{
    st = {y:e.clientY, dy:0};
    sheet.style.transition = 'none';
    try{ g.setPointerCapture(e.pointerId); }catch(_){}
  });
  g.addEventListener('pointermove', e=>{
    if(!st) return;
    st.dy = Math.max(0, e.clientY - st.y);
    const k = Math.min(1, st.dy / 400);
    sheet.style.transform = `translateY(${st.dy}px)`;
    mask.style.background = `rgba(8,8,10,${.32 * (1 - k)})`;
  });
  const end = ()=>{
    if(!st) return;
    const close = st.dy > 110;
    sheet.style.transition = '';
    sheet.style.transform = '';
    mask.style.background = '';
    if(close) mask.classList.add('hidden');
    st = null;
  };
  g.addEventListener('pointerup', end);
  g.addEventListener('pointercancel', end);
});

/* ============================================================
 * 17. WebGL 液态玻璃背景（黑白灰 / 静态降级安全）
 * ============================================================ */
(function initGL(){
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cv = $('glbg');
  // preserveDrawingBuffer: 让 canvas 在每帧后仍可被读回（调试/截图/合成更可靠）
  const gl = cv.getContext('webgl', {alpha:true, antialias:false, premultipliedAlpha:false,
    preserveDrawingBuffer:true, powerPreference:'low-power'});
  if(!gl){ cv.style.display = 'none'; return; }

  const VS = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
  const FS = `
  precision highp float;
  uniform vec2 uRes; uniform float uT; uniform float uDark;
  float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
  float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
  float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.03;a*=.5;}return v;}
  void main(){
    vec2 uv=gl_FragCoord.xy/uRes; vec2 p=uv; p.x*=uRes.x/uRes.y;
    float t=uT*.05;
    vec2 q=vec2(fbm(p*1.5+vec2(t,0.)),fbm(p*1.5+vec2(0.,t*.8)));
    float n=fbm(p*2.1+q*1.2+vec2(t*.4,-t*.35));
    // 三个极淡的光斑，营造"玻璃后面的流体"
    float g=0.;
    g+=exp(-3.6*length(p-vec2(.30+.10*sin(t*.6),.86+.05*cos(t*.5))));
    g+=exp(-4.6*length(p-vec2(.88+.07*cos(t*.7),.52+.08*sin(t*.8))));
    g+=exp(-6.0*length(p-vec2(.45+.09*sin(t*.35),.02+.04*cos(t*.6))));
    // 黑白灰：浅色模式几乎全白，暗色模式几乎全黑，只留极细的灰阶起伏
    float v = mix(1.0, 0.035, uDark) - mix(.075, .05, uDark) * (n * .8 + g);
    v += (hash(gl_FragCoord.xy+fract(uT)*90.)-.5) * .012;
    vec2 c=uv-.5; v -= dot(c,c) * mix(.045, .012, uDark);
    gl_FragColor=vec4(v,v,v,1.0);
  }`;
  function sh(type, src){
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){ console.warn(gl.getShaderInfoLog(s)); return null; }
    return s;
  }
  const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
  if(!vs || !fs){ cv.style.display='none'; return; }
  const pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
  if(!gl.getProgramParameter(pr, gl.LINK_STATUS)){ cv.style.display='none'; return; }
  gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'a');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uRes = gl.getUniformLocation(pr, 'uRes'), uT = gl.getUniformLocation(pr, 'uT'),
        uDark = gl.getUniformLocation(pr, 'uDark');

  // 跟随系统明暗
  const darkMQ = matchMedia('(prefers-color-scheme: dark)');
  let isDark = darkMQ.matches;
  darkMQ.addEventListener?.('change', e=>{ isDark = e.matches; });
  const syncDark = ()=>{ gl.uniform1f(uDark, isDark ? 1 : 0); };

  // 只按需渲染：静止时降到 12fps，视口变化/滚动时临时拉满，兼顾省电与流畅
  let dprCap = Math.min(devicePixelRatio || 1, 2);
  function resize(){
    cv.width = Math.round(innerWidth * dprCap);
    cv.height = Math.round(innerHeight * dprCap);
    gl.viewport(0, 0, cv.width, cv.height);
    gl.uniform2f(uRes, cv.width, cv.height);
  }
  resize(); addEventListener('resize', resize, {passive:true});

  /*
   * 用 rAF 驱动，但首帧必须同步画出：某些环境（后台标签页、无头浏览器、
   * 页面刚加载完的那一帧）rAF 会被推迟，若不先画一帧，背景会是透明的。
   * 另外加一个低频 setInterval 兜底，防止 rAF 停摆导致背景"冻"在破帧上。
   */
  let last = 0, interval = 80;
  function draw(now){
    gl.uniform1f(uT, (now || performance.now()) / 1000);
    syncDark();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  // 首帧：立刻画
  draw(0);

  if(reduce){ return; } // 减少动态：只保留这一帧

  function loop(now){
    requestAnimationFrame(loop);
    if(now - last < interval) return;
    last = now;
    draw(now);
  }
  requestAnimationFrame(loop);
  // 兜底：即使 rAF 不下发，每秒也重绘几帧
  setInterval(()=>{ if(!document.hidden) draw(); }, 250);
  // 明暗切换后立刻重绘
  darkMQ.addEventListener?.('change', ()=>draw());
  // 滚动/切换时临时提高帧率（玻璃背景流动更明显）
  let boostTimer = 0;
  const boost = ()=>{ interval = 24; clearTimeout(boostTimer); boostTimer = setTimeout(()=>{ interval = 80; }, 700); };
  pagerEl.addEventListener('scroll', boost, {passive:true, capture:true});
  dockEl.addEventListener('pointermove', boost);
})();

/* ============================================================
 * 18. 启动
 * ============================================================ */
$('btnMore').addEventListener('click', openMoreSheet);
$('btnAdd').addEventListener('click', ()=>openEdit());

(async function init(){
  load();
  try{ await openDB(); await imgLoadAll(); }
  catch(e){ console.warn('IndexedDB 不可用，相册图片将无法持久化', e); toast('当前浏览器数据库不可用，相册图片可能无法保存'); }
  $('searchInput').value = state.ui.search||'';
  setFilter(state.ui.filter||'all');
  renderWorkbench();

  /* URL 参数：?view=builder|workbench|profile  以及 PWA 快捷方式 ?action=new */
  let qs = null;
  try{ qs = new URLSearchParams(location.search); }catch(e){}
  const viewParam = qs ? qs.get('view') : null;
  const actionParam = qs ? qs.get('action') : null;
  const startView = (viewParam && TAB_ORDER.includes(viewParam)) ? viewParam : state.ui.view;

  // 恢复上次视图（URL 优先）
  const v = TAB_ORDER.indexOf(startView);
  setTab(v >= 0 ? v : 0, false);
  renderLibrary();
  // 首屏布局稳定后重排滑块
  requestAnimationFrame(()=>{ layoutPill(curTab, false); });
  window.addEventListener('resize', ()=>{ layoutPill(curTab, false); }, {passive:true});

  // 快捷方式：直接打开记录提示词
  if(actionParam === 'new'){ setTimeout(()=>openEdit(), 120); }

  // PWA：仅 http(s) 下注册 Service Worker
  if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
})();

/* ============================================================
 * 18.5 视口跟踪：让底部 Tab 栏始终贴住真实视口底部
 * ------------------------------------------------------------------
 * iOS Safari 的问题：软键盘弹出、顶部地址栏收起/展开时，
 * 页面布局视口（innerHeight / dvh）和真实可视区会不同步，
 * 绝对定位的底部元素就会"浮"到半空。
 * visualViewport 给出的是真实可视区，用它换算底部偏移最可靠。
 * ============================================================ */
(function trackViewport(){
  const vv = window.visualViewport;
  const root = document.documentElement;
  if(!vv) return;

  let raf = 0;
  function update(){
    raf = 0;
    /*
     * 键盘弹起的判定：
     * 真实的"可视区底部" = vv.height + vv.offsetTop。
     * 只有它明显小于 window.innerHeight 时才算键盘弹起。
     * 阈值放宽到 150px，避免 iOS 工具栏高度变化被误判成键盘。
     */
    const visibleBottom = vv.height + vv.offsetTop;
    const offsetBottom = Math.max(0, window.innerHeight - visibleBottom);
    root.style.setProperty('--vvb', offsetBottom.toFixed(1) + 'px');

    // 外壳高度：键盘弹起时收缩到可视区，否则用完整视口（保证贴底）
    const kb = offsetBottom > 150;
    document.body.classList.toggle('kb-open', kb);
    if(kb){
      root.style.setProperty('--app-h', vv.height.toFixed(1) + 'px');
      // 键盘弹起时收起 Tab 栏，避免挡住输入框（iOS 原生做法）
      dockEl.style.transform = 'translateX(-50%) translateY(140%)';
      dockEl.style.opacity = '0';
      dockEl.style.pointerEvents = 'none';
    }else{
      // 清掉内联高度，交回 CSS 的 100dvh —— 这是贴底的关键
      root.style.removeProperty('--app-h');
      dockEl.style.transform = '';
      dockEl.style.opacity = '';
      dockEl.style.pointerEvents = '';
    }
  }
  const schedule = ()=>{ if(!raf) raf = requestAnimationFrame(update); };
  vv.addEventListener('resize', schedule, {passive:true});
  vv.addEventListener('scroll', schedule, {passive:true});
  window.addEventListener('resize', schedule, {passive:true});
  window.addEventListener('orientationchange', ()=>{ schedule(); setTimeout(schedule, 300); }, {passive:true});
  update();
})();

/* 输入框聚焦时，滚动到可见区域（配合键盘收起 Tab 栏） */
document.addEventListener('focusin', e=>{
  const el = e.target;
  if(!el.matches('input, textarea, select')) return;
  setTimeout(()=>{
    try{ el.scrollIntoView({block:'center', behavior:'smooth'}); }catch(_){}
  }, 280);
});
/* ============================================================
 * 19. 对外暴露（HTML 内联 onclick 依赖）
 * ============================================================ */
Object.assign(window, {
  switchView, setCat, setTag, setFilter, chooseSort, openSortSheet, closeSortSheet,
  openEdit, closeEdit, savePrompt, toggleFav, copyPrompt, cycleQuality, deletePrompt, togglePin,
  openActionSheet, closeActionSheet, openDetail,
  openCatModal, editActiveCat, closeCat, saveCat, deleteCat,
  openApply, closeApply, copyApplyResult,
  openVersion, closeVersion, rollbackVersion,
  openTrans, closeTrans, copyTrans, replaceByTrans,
  assemble, copyBuilder, saveBuilderToLib, clearBuilder,
  translateBuilder, copyBuilderTrans,
  renderWorkbench, renderModelList, openModelModal, closeModelModal, onModelProviderChange,
  saveModelConfig, activateConfig, deleteConfig, testConfig,
  onTaskChange, pickTask, runWorkbench, sendFollowup, onReversePicked, copyResult, saveAsTemplate,
  renderHistory, viewHistory, deleteHistory,
  renderProfile, openGalleryEdit, closeGalleryEdit, saveGallery, deleteGallery, refreshLinkedPrompt,
  copyLinkedPrompt, removeGalleryImage, onGalleryImagesPicked, onGalleryTagKey, removeGalleryTag,
  reverseFromGallery, openGroupModal, closeGroupModal, editGroup, saveGroup, deleteGroup,
  openProfileEdit, closeProfileEdit, saveProfile,
  openExportModal, closeExport, doExport, exportJSON, importJSON, clearAll,
  openMoreSheet, closeMoreSheet, openLightbox, removeTag, removeImage, onTagKey,
  /* 本轮新增 */
  openDetail, closeDetail, openViewer, openViewerAt, openCardViewer, openGalleryViewer,
  closeViewer, deleteVersion, clearVersions, onAlbumClick
});
