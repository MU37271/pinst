# pinst

提示词收藏与学习工作台。纯静态单文件应用，可直接部署到 GitHub Pages。

## 部署到 GitHub Pages

本仓库根目录就是站点根目录，开启 Pages 即可：

1. 打开仓库 **Settings → Pages**
2. **Source** 选择 `Deploy from a branch`
3. **Branch** 选择 `main`，目录选 `/ (root)`，点 **Save**
4. 等待 1~2 分钟，访问 `https://<用户名>.github.io/pinst/`

> 也可以用 Netlify / Vercel / Cloudflare Pages 部署，构建命令留空，发布目录填 `/`。

## PWA 说明

- 需要 **HTTPS** 才能安装到主屏（GitHub Pages 自带 HTTPS）
- iPhone / iPad：Safari 打开 → 分享 → 添加到主屏幕
- Android：Chrome 打开 → 菜单 → 安装应用
- 桌面 Chrome / Edge：地址栏右侧的安装按钮
- 直接用 `file://` 双击打开也能使用，但无法安装

## 目录

```
index.html            应用全部代码（单文件）
manifest.webmanifest  PWA 清单
sw.js                 离线缓存
assets/               应用图标（PNG 多尺寸 + SVG）
vendor/gsap.min.js    本地动画库（保证离线可用）
.nojekyll             让 GitHub Pages 跳过 Jekyll
```

## 数据

所有提示词、相册图片与 API Key 只保存在浏览器本地（localStorage + IndexedDB），不会上传到任何服务器。
换设备前请在「我的 → 数据管理」导出 JSON 备份。
