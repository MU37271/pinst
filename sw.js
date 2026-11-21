/* ==========================================================================
 *  Service Worker · 提示词工作台
 *  ------------------------------------------------------------------------
 *  策略：
 *   - 应用外壳（HTML/CSS/JS/图标/清单）：stale-while-revalidate，秒开且可离线。
 *   - AI 接口（api./chat/completions）：永不拦截、永不缓存，保证联网调用不受影响。
 *   - 其他跨域请求：直接放行。
 *  升级版本：修改 CACHE 常量即可，会清掉旧缓存。
 * ========================================================================== */
const CACHE = 'pinst-v2.3.0';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
  './assets/icon-180.png'
];

self.addEventListener('install', e=>{
  e.waitUntil(
    caches.open(CACHE).then(c=>Promise.allSettled(SHELL.map(u=>c.add(u)))).then(()=>self.skipWaiting())
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
  // AI 接口与任何 api 域名：完全不碰
  if(url.pathname.includes('/chat/completions') ||
     url.pathname.includes(':generateContent') ||
     /(^|\.)api\./.test(url.hostname) ||
     url.hostname !== location.hostname) return;

  // 页面导航：网络优先，失败回退到缓存的外壳
  if(req.mode === 'navigate'){
    e.respondWith(
      fetch(req).then(res=>{
        const copy = res.clone();
        caches.open(CACHE).then(c=>c.put('./index.html', copy)).catch(()=>{});
        return res;
      }).catch(()=>caches.match('./index.html').then(r=>r || caches.match('./')))
    );
    return;
  }

  // 静态资源：先给缓存，再后台更新
  e.respondWith(
    caches.match(req).then(hit=>{
      const net = fetch(req).then(res=>{
        if(res && res.ok){
          const copy = res.clone();
          caches.open(CACHE).then(c=>c.put(req, copy)).catch(()=>{});
        }
        return res;
      }).catch(()=>hit);
      return hit || net;
    })
  );
});
