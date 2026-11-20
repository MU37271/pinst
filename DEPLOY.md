# 部署教程：上传 GitHub 并发布为 PWA

面向：Windows + 命令行（PowerShell）。全程约 10 分钟。

最终地址形如：`https://你的用户名.github.io/pinst/`

---

## 0. 先理解你要传什么

`pinst/` 目录里只有这些文件会被上传（合计约 235 KB）：

```
pinst/
├─ index.html              应用入口
├─ styles.css              iOS 液态玻璃样式
├─ app.js                  应用逻辑 + WebGL 背景
├─ sw.js                   Service Worker（离线缓存）
├─ manifest.webmanifest    PWA 清单
├─ .nojekyll               ★ 让 GitHub Pages 原样输出文件
├─ .gitignore              排除 _lab/
└─ assets/
   ├─ icon.svg
   ├─ icon-180.png
   ├─ icon-192.png
   ├─ icon-512.png
   └─ icon-maskable-512.png
```

`_lab/` 里是测试脚本和截图（约 7.9 MB），已被 `.gitignore` 排除，**不会**被传上去。

---

## 1. 安装 Git（如果还没装）

检查：

```powershell
git --version
```

有输出（如 `git version 2.56.0`）就跳过这步。

没有的话去 https://git-scm.com/download/win 下载安装，一路默认选项即可。装完**关掉 PowerShell 重新打开**，再 `git --version` 确认。

首次使用还需设置身份（只需一次）：

```powershell
git config --global user.name "你的名字"
git config --global user.email "你的GitHub注册邮箱"
```

---

## 2. 在 GitHub 上创建仓库

1. 登录 https://github.com
2. 右上角 `+` → **New repository**
3. 填写：
   - **Repository name**：`pinst`
   - **Description**：可选
   - 可见性选 **Public**

   > ⚠️ **必须是 Public**。GitHub Pages 免费版不支持 Private 仓库发布。
4. 下面的 `Add a README` / `.gitignore` / `license` **全部不要勾选**（勾了会让本地 push 产生冲突，多一步处理）
5. 点 **Create repository**

创建成功后页面会显示一个仓库地址，形如：

```
https://github.com/你的用户名/pinst.git
```

记下它，下一步要用。

---

## 3. 在本地初始化仓库并推送

**打开 PowerShell**，依次执行（逐条复制，一条一条运行）：

### 3.1 进入项目目录

```powershell
cd E:\projects\my-html\pinst
```

> ⚠️ 注意路径是 `pinst` 这一层，**不是**外面的 `my-html`。外面那层还有别的项目，不能一起传。

### 3.2 初始化并提交

```powershell
git init
```

```powershell
git add -A
```

```powershell
git status
```

**这一步很重要**：看输出的文件列表里应该**只有**上面第 0 节列的那些文件。
如果出现了 `_lab/`、`test-glass.html`、`serve.js`、`shot-*.png` 之类，说明 `.gitignore` 没生效，**先停下来**告诉我。

确认无误后提交：

```powershell
git commit -m "feat: 提示词工作台 iOS 液态玻璃版"
```

### 3.3 关联远程仓库并推送

把下面的 `你的用户名` 换成你的 GitHub 用户名：

```powershell
git remote add origin https://github.com/你的用户名/pinst.git
```

```powershell
git branch -M main
```

```powershell
git push -u origin main
```

**关于登录**：Windows 版的 Git 会弹出浏览器窗口让你登录 GitHub（Git Credential Manager）。点授权即可，不用手动配 SSH 密钥或 token。

如果弹窗没出现、直接在终端要密码：GitHub 早已不支持密码验证，需要在 https://github.com/settings/tokens 生成一个 **Personal Access Token**（勾选 `repo` 权限），粘贴到密码处。

---

## 4. 开启 GitHub Pages

回到仓库页面：

1. 点上方 **Settings**
2. 左侧栏点 **Pages**
3. **Build and deployment** 区域：
   - **Source** 选 `Deploy from a branch`
   - **Branch** 选 `main`，目录选 `/ (root)`
4. 点 **Save**

稍等 1~2 分钟，刷新页面，顶部会出现：

```
Your site is live at https://你的用户名.github.io/pinst/
```

点进去就能用了。

> 如果等了 3 分钟还是 404：
> - 去仓库的 **Actions** 标签页看部署任务是否报错
> - 确认 `.nojekyll` 文件确实在仓库根目录（它是个空文件，在 GitHub 网页上会显示为 0 Bytes）

---

## 5. 在 iPhone 上安装成 App

**必须用 Safari**（Chrome 在 iOS 上不能添加到主屏幕）。

1. iPhone Safari 打开 `https://你的用户名.github.io/pinst/`
2. 点底部**分享**按钮（方框带向上箭头）
3. 向下划，点 **添加到主屏幕**
4. 可以改个名字，点**添加**

然后从主屏幕图标打开 —— 这时的表现才和真 App 一致：
- 全屏无浏览器地址栏
- 沉浸式状态栏（内容延伸到灵动岛下方）
- 离线可用（第一次打开过之后）

---

## 6. 验收清单

在主屏幕图标里打开，逐项确认：

| 检查项 | 预期 |
|---|---|
| 顶部 | 内容延伸到状态栏下方，大标题「提示词库」可见，右上角三个玻璃圆按钮 |
| 底部 | 悬浮玻璃 Tab 栏，不贴屏幕边缘 |
| 左右滑 | 内容区横滑，Tab 滑块跟随移动 |
| 长按卡片 | 弹出玻璃动作面板 |
| 点击放大镜 | 标题栏变成搜索框 |
| 滚动 | 顶栏出现模糊带，大标题缩小淡出 |
| 切到暗色 | 系统设置 → 显示与亮度 → 深色，App 应跟随变黑 |
| 断网 | 打开 App 仍能显示界面（内容来自本机缓存） |

---

## 7. 以后怎么更新

每次改完代码，在 `E:\projects\my-html\pinst` 下执行三条：

```powershell
git add -A
git commit -m "描述你改了什么"
git push
```

GitHub Pages 会在 1 分钟左右自动重新部署。

**如果改动了 `styles.css` / `app.js` 等文件，手机上可能还显示旧版**，因为 Service Worker 缓存了。解决方法：

把 `sw.js` 第 10 行的版本号改一下，例如：

```js
const CACHE = 'pinst-v2.0.1';
```

这样用户下次打开时会自动清掉旧缓存。

---

## 8. 常见问题

**Q：push 时报 `rejected - non-fast-forward`**
建仓库时勾选了 README 之类的文件。执行：
```powershell
git pull --rebase origin main
git push -u origin main
```

**Q：pinst 是不是要单独一个仓库？能不能和其他项目一起传？**

建议单独一个仓库。`E:\projects\my-html` 下面还有 `小说工坊`、`novel-forge-site` 等其他项目，混在一起会让 Pages 的 URL 结构很乱，而且其他项目的文件也会被公开。

**Q：想用自定义域名**

在仓库 Settings → Pages → Custom domain 填写，然后到域名服务商处添加一条 CNAME 记录指向 `你的用户名.github.io`。

**Q：Private 仓库能不能部署**

可以，但需要 GitHub Pro 及以上。免费账号只能从 Public 仓库部署 Pages。

**Q：AI 工作台调用 API 会不会因为跨域失败**

这是浏览器直连第三方 API 的通病，和部署方式无关。大部分 OpenAI 兼容端点支持浏览器直连；若某个服务商不支持，需要在它那边开启 CORS 或改用中转服务。
