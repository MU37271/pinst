/* ==========================================================================
 *  Service Worker · 提示词工作台
 *  ------------------------------------------------------------------------
 *  策略（v2.4.0 起）：
 *   - 应用文件（HTML/CSS/JS/清单）：**网络优先**。联网时永远拿最新代码，
 *     彻底避免"改了代码但用户还看旧界面"的缓存问题；断网时回退缓存。
 *   - 图标等静态资源：缓存优先，后台更新（几乎不变，省流量）。
 *   - AI 接口：永不拦截、永不缓存。
 *  升级版本：修改 CACHE 常量即可，会清掉旧缓存。
 * ========================================================================== */
const CACHE = 'pinst-v3.0.0';

/* 需要"永远拿最新"的应用文件 */
const APP_FILES = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest'];

/* 可长期缓存的静态资源 */
const STATIC_FILES = [
  './assets/vendor/gsap.min.js',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
  './assets/icon-180.png'
];

const SHELL = [...APP_FILES, ...STATIC_FILES];

self.addEventListener('install', e=>{
  e.waitUntil(
    caches.open(CACHE)
      .then(c=>Promise.allSettled(SHELL.map(u=>c.add(new Request(u, {cache:'reload'})))))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', e=>{
  const req = e.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);

  // 跨域 / AI 接口：完全不碰
  if(url.hostname !== location.hostname) return;
  if(url.pathname.includes('/chat/completions') || url.pathname.includes(':generateContent')) return;

  const isAppFile = req.mode === 'navigate'
    || /\.(html|css|js|webmanifest)$/.test(url.pathname)
    || url.pathname.endsWith('/');

  // ---- 应用文件：网络优先，失败回退缓存 ----
  if(isAppFile){
    e.respondWith(
      fetch(new Request(req, {cache:'reload'}))
        .then(res=>{
          if(res && res.ok){
            const copy = res.clone();
            caches.open(CACHE).then(c=>c.put(req, copy)).catch(()=>{});
          }
          return res;
        })
        .catch(async ()=>{
          const hit = await caches.match(req);
          if(hit) return hit;
          if(req.mode === 'navigate'){
            return (await caches.match('./index.html')) || (await caches.match('./'));
          }
          return Response.error();
        })
    );
    return;
  }

  // ---- 静态资源：缓存优先 ----
  e.respondWith(
    caches.match(req).then(hit=>{
      if(hit) return hit;
      return fetch(req).then(res=>{
        if(res && res.ok){
          const copy = res.clone();
          caches.open(CACHE).then(c=>c.put(req, copy)).catch(()=>{});
        }
        return res;
      });
    })
  );
});

/* 允许页面主动要求跳过等待，立即启用新版本 */
self.addEventListener('message', e=>{
  if(e.data === 'SKIP_WAITING') self.skipWaiting();
});
