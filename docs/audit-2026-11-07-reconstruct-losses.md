# 78b71db（PR #16）重构丢失清单

审计对象：`52c3d2d`「用户空间改为 /qwq/<用户名> 并接通前端」+ `71f1897`「首页轮播位改为后台可配置」，
合并为 `78b71db`。对照基线：其父提交 `e246686`（PR #15 合并后的 main）。

> **2026-11-07 已按「非本次意图的移除全部补回」执行修复**，见文末「修复记录」。

结论先说：**后端基本没丢（只少了 1 个函数），丢的几乎全在前端。**
`server.js` 相对基线只删掉 `injectPeekProxy` 一个函数；路由表从 73 条涨到 78 条，
**一条都没少**（多出来的是轮播 4 条 + `POST /api/account/delete`，另有 1 条是 `/view` 改两段式后重排）。
文件清单也没少：`git diff --name-status e246686 HEAD` 无删除文件，新增 `lib/banners.js`、`scripts/migrate-user-space.mjs`。

---

## A. 确认丢失、且没有等价替代（需要修）

| # | 功能 | 现状证据 | 丢失前 |
|---|---|---|---|
| A1 | **卡片封面整站实时画面（.mcover）+ 悬停自动下翻预览** | `app.js:701-731` 只剩「悬停新建一个静态 iframe」，无 `.mcover`、无 `?mpcover=1`、无滚动代理 | `app.js` 的 `buildLiveCover`/`pumpCoverQueue`/`COVER_*` + `server.js` 的 `MPEEK_PROXY`/`injectPeekProxy`/`forCover` |
| A2 | **卡片封面与卡片本体可点** | `app.js:604-704` 无 `card.addEventListener('click')`、无 `cover.tabIndex/role/aria-label`，只有 `.vtitle` 是链接；但 `style.css:250` 仍写着 `.vcard { cursor: pointer }`，光标骗人 | `7ef79e9` 加的 `cover.tabIndex=0`、`role=link`、click/keydown 跳 `/view/...` |
| A2b | **悬停预览的挂载容器与穿透** | `app.js:721` 把 iframe 挂到 `card`（整个卡片）上，且 CSS `.peek` 没有 `pointer-events: none` | 旧版挂在 `cover`（`.vcover` 有 `overflow:hidden` 剪裁）上，且带 `pointer-events:none`。现在预览会盖住标题/作者/赞藏按钮，鼠标移上去事件被 iframe 吃掉 |
| A3 | **ZIP 整包发布入口** | `public/sites.html` 全文无 `zip`；`server.js:971` 的 `handleSiteZipUpload` 还在，但已经没有任何前端调用它 | `applyPick` 的 `pickedMode='zip'` 分支 + `POST /api/sites/:name/zip` 调用 |
| A4 | **多页站「入口自动识别」**（PR #15 的成果） | `sites.html:486` 硬性要求根目录有 index.html；`sites.html:345` 提示「缺 index.html，上传会被拒绝」 | 旧版允许无 index.html，由服务端 `pickEntryPath` 取最浅 html；`server.js` 至今仍支持 |
| A5 | **多文件上传并发 + 断点续传** | `sites.html:491` 改成 `for` 串行逐个上传 | `CONCURRENCY=4` 的 worker 池 + `resumeKey/resumeDone` 跳过已成功文件 |
| A6 | **前端垃圾文件过滤** | `sites.html:434` 直接 `applyPick(files.map(...))`，丢掉了 `isJunkPath` | `JUNK_SEGMENTS`/`isJunkPath`，拖文件夹时跳过 `Thumbs.db`、`node_modules` 等 |
| A7 | **客户端站名校验** | `sites.html` 提交前只判空，不再校验 `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$` | 旧版有前端同口径校验，并在注释里写明原因：中文站名匹配不上路由正则，只会拿到 404 HTML 页，`res.json()` 就抛 `Unexpected token '<'` |

> A6 有个连带后果：服务端 `isValidSitePath` 仍会拒 `node_modules` 这类段，所以现在拖一个含垃圾文件的
> 文件夹进去，会在中途报「文件路径不合法」并中断整个上传，而不是预先过滤掉。

## B. 确认丢失、但属于有意改版（可选恢复）

| # | 功能 | 现状 |
|---|---|---|
| B1 | 登录/注册弹窗（`openLoginModal`/`mountAuthForm`/`installAuthGuard` + `.modal-*` 一整套 CSS） | 改成整页 `/login`，页面内统一 `location.href='/login?next=...'`。功能没丢，交互变了 |
| B2 | `MP.session()` / `MP.forgetSession()` | 换成 `MP.me()`（带缓存）+ `MP.requireLogin()`，覆盖等价 |
| B3 | 首页「热门」chip（`MP.TAGS` 里的 `hot` 伪标签 → 映射 `sort=views`） | `TAGS` 里已无 `hot`，只剩「按浏览量查看」入口 |
| B4 | 发现流大页码翻页器（1…5 6 7…47 七格窗口） | 换成了「上一页 / n / m（共 x 个）/ 下一页」的简化版，功能仍在 |
| B5 | 收藏页取消收藏后自动重拉（`onFavoriteChange`） | `favorites.html` 不再传该回调，在收藏页取消收藏后当前列表不会自动刷新 |

## C. 不是这次引入的（改动前就存在）

| # | 问题 | 证据 |
|---|---|---|
| C1 | 编辑页「卡片封面」上传 / 移除去哪了 | 全历史（`git rev-list --all`）里 `server.js` **从未有过** `/api/sites/.../cover` 路由，`lib/db.js` 也从未有封面列。UI 是 `c145e6d` 先写的前端，后端一直没做 |
| C2 | 首页卡片点赞只 toggle class | 那是 `91615f5` 之前的老问题，`7ef79e9` 已修好，`52c3d2d` 保留的是修好的版本 |

**但 C1 被这次重构放大了**：`52c3d2d` 删掉了 `.coverPreview` 和 `.srFile` 两条 CSS，
于是 `site.html:41-42` 的 `<img class="coverPreview">` 和 `<input class="srFile" type="file">`
现在完全没有样式——原本被视觉隐藏的文件选择框会**直接裸露在页面上**，和「选择图片」按钮并排出现。
这是新增的可视缺陷。

## D. 文案与代码不一致

| # | 位置 | 问题 |
|---|---|---|
| D1 | `history.html:15` | 写「只保留最近 30 天」，但 `lib/social.js` 的 `listHistory` 是 `LIMIT 100`，**没有任何时间过滤**。旧文案「最多保留 100 条」才是对的 |
| D2 | `notifications.html:154` | 服务端每条已带 `unread`，前端又用 `me.unread` 按「前 N 条」重算一遍覆盖掉 |
| D3 | `app.js:1-7` | 文件头仍写「当前为纯前端阶段：所有用户态与列表数据均为本地演示数据」，早已接真实接口 |
| D4 | `site.html:152/394/486` 注释、`app.js:170` | 还留着 `GET /api/sites/:name` 旧形态的说明，实际已是 `/api/sites/:用户名/:站名` |

## E. 测试覆盖的净损失

`scripts/api-smoke.mjs`：基线 170 条 `check()` → 现在 152 条（实跑 151 项通过 / 0 失败）。
本地已用 `MYSQL_PORT=13306` 连隧道、`MYSQL_DATABASE=minepage_smoke` 实跑确认全绿，所以**不是坏了，是没人测了**。

被删且对应功能仍然存在的断言：

- ZIP 全部（无效 ZIP、全被跳过、有效发布 2 个文件、ZIP 首页可访问）
- 子目录入口全部（跳转保留封面参数、相对 CSS、封面注入代理、浏览计数去重）
- 卡片读回互动状态（发现流 / 创作者主页的 liked、favorited、isFollowing）
- 私信未读、通知未读、通知匿名访问
- 后台站点列表、粉丝数读回、评论级联删除

即：**A1/A3/A4 这三块功能，现在既没有实现也没有测试**。

## F. 没丢（可以放心）

- 全部 78 条路由（基线 73 条，只增不减）；砂箱 CSP（`SANDBOX_CSP` 未动，无 `allow-same-origin`）
- 站名唯一键 `(owner_id, name)`、外键 CASCADE、配额、改名、注销
- MCP 10 个工具（名字一一对应，只改了描述里的地址形态）
- gzip、Range、ZIP 服务端处理、`pickEntryPath`、`JUNK_SEGMENTS` 校验
- 生产库数据完好：158 用户 / 467 站点，`username` 无 NULL，`sites` 唯一键与 CASCADE 均已生效

## 修复优先级建议

1. A2 卡片可点（一行级改动，影响最大，用户第一反应就是「卡片坏了」）
2. A4 + A6 上传体验（PR #15 的成果被前端挡掉了）
3. A1 实时封面 + 悬停下翻（工作量最大，涉及 `server.js` 注入）
4. A3 ZIP 入口、A5 并发上传
5. C1 封面 UI：要么补后端，要么先把这块 UI 从 `site.html` 摘掉并恢复 `.srFile` 隐藏样式
6. D1/D3 文案
7. E 补回冒烟断言

---

## 修复记录（2026-11-07）

全部按「明显不是本次改版意图、却被顺手删掉」的范围补回，**没有动地址形态、没有动认证方式**。

### 已补回

| 项 | 落点 |
|---|---|
| A1 实时封面 + 悬停自动下翻 | [`app.js`](../public/app.js) 恢复 `buildLiveCover` / `pumpCoverQueue` / `COVER_*`（`?mpcover=1`、并发 3、视口滚入 400ms 排队、载入淡入）；[`server.js`](../server.js) 恢复 `MPEEK_PROXY` + `injectPeekProxy`，入口页（含子目录入口与老单页站）按 `?mpcover=1` 注入 |
| A2 封面/整卡可点 | `MP.vcard` 恢复 `cover.tabIndex / role=link / aria-label` 与 click、Enter/Space 键盘激活；`style.css` 恢复 `.vcover { cursor:pointer }` 与角标 `z-index:6` |
| A2b 预览挂载与穿透 | iframe 改挂 `.vcover`（`overflow:hidden` 剪裁），CSS 恢复 `pointer-events:none`，不再遮挡标题与赞藏按钮 |
| A3 ZIP 发布 | [`sites.html`](../public/sites.html) 恢复 `pickedMode='zip'` 分支、`POST /api/sites/:用户名/:站名/zip`、`saved/skipped/skipList` 结果展开 |
| A4 入口自动识别 | restore `hasAnyHtml` 分支，去掉「缺 index.html 就拒绝」；提示改为「入口自动识别」 |
| A5 并发 + 断点续传 | 恢复 `CONCURRENCY=4` worker 池、`resumeKey/resumeDone`、失败重试 3 次、失败后重提跳过已成功文件 |
| A6 垃圾文件过滤 | 恢复 `JUNK_SEGMENTS` / `isJunkPath`，选择文件、拖文件夹、拖散文件三处都过滤 |
| A7 客户端站名校验 | 恢复 `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$` 前置校验（避免中文站名拿到 404 HTML 后 `res.json()` 抛错） |
| B3 热门 chip | `MP.TAGS` 恢复 `{ key:'hot', label:'热门' }`；首页把它映射成 `sort=views`；顶栏热门搜索排除该伪标签 |
| B5 收藏页自动重拉 | `MP.vcard` 恢复 `onFavoriteChange` 回调，`favorites.html` 取消收藏后重拉列表 |
| C1 封面 UI 样式 | 恢复 `.coverPreview` / `.srFile`，文件选择框重新被视觉隐藏 |
| D2 通知未读 | 直接用服务端返回的逐条 `unread`，删掉前端按 `me.unread` 猜的逻辑 |
| D1 历史文案 | 改回「最多保留 100 条」（后端确实是 `LIMIT 100`） |
| B4 数字页码翻页器 | `discover.html` 恢复「上一页 / 1 2 3 … 47 / 下一页」七格窗口，可直接跳页；`style.css` 恢复 `.pager .pg` 一整套样式 |
| D4 旧接口注释 | `site.html` 三处注释改成 `/api/sites/:用户名/:站名` |
| E 冒烟断言 | 补回 ZIP 4 项、子目录入口 7 项、卡片互动状态 5 项、私信/通知未读 4 项、粉丝数读回、评论级联删除 |

### 顺带修掉的两个真 bug

1. **子目录入口跳转丢了一段站名**：`handleSite` 里 `/${前缀}/${用户名}/${filePath}` 少了 `${name}`，
   子目录入口的站（PR #15 的 `nested-entry`）一点就 404。已修成 `/${前缀}/${用户名}/${站名}/${filePath}`。
2. **MPEEK_PROXY 在顶层窗口也会 `parent.postMessage`**：`/qwq/.../?mpcover=1` 直接被打开时
   会在顶层页面里空转一个滚动代理。已加 `if(window.parent!==window)` 守卫。

### 没恢复（有意保留新样子）

- B1 登录弹窗 → 整页 `/login`：这是 `52c3d2d` 明确改的交互（login.html 整页重写），不是顺手删的。
  **但它的副作用补回来了**：原来弹窗登录完还停在原页面，改成整页后未登录访问 `/favorites` 之类会跳到
  `/login` 然后回 `/`，原页面丢了。新增 `sendLoginRedirect()`，8 个受保护页面现在都带 `?next=`
  回跳（`/login` 侧本来就校验必须是站内相对地址）。
- B2 `MP.session` / `MP.forgetSession` → `MP.me()` + `MP.requireLogin()`：纯内部函数名，用户看不到区别。

### 验证

- `npm run smoke`（`MYSQL_DATABASE=minepage_smoke`，走 13306 隧道）：**180 项通过 / 0 项失败**（修复前 151 项）。
- 本地起服务实测：`/qwq/smoke-a/probe-nested/dist/index.html?mpcover=1` 返回含 `mpReady` 的注入脚本，
  且 `Content-Security-Policy` 仍是 `sandbox ...`（无 `allow-same-origin`）；不带 `?mpcover=1` 时不注入。
- 全部页面内联脚本 + `app.js` + `server.js` + `scripts/api-smoke.mjs` 均过 `node --check`。

