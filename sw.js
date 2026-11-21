/* pinst Service Worker · 外壳离线可用
   - 页面(index.html)走「网络优先，失败回退缓存」：保证更新后立即拿到新版
   - 静态资源(图标/GSAP)走「缓存优先」：二次打开秒开
   - 模型 API 等跨域请求一律直连，不缓存 */
const VERSION = 'v5';
const CACHE = 'pinst-shell-' + VERSION;
const SHELL = [
  './',
  './index.html',
  './vendor/gsap.min.js',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/icon-180.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
  './assets/favicon-32.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {}))   // 任一文件缺失也不阻塞安装
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 页面可发送 {type:'skip-waiting'} 主动更新
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;                  // AI 接口直连

  // 导航请求：网络优先，离线时回退到缓存的外壳
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./index.html').then(hit => hit || caches.match('./')))
    );
    return;
  }

  // 静态资源：缓存优先，后台顺带更新
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
