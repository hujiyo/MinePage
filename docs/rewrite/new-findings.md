# 补注释过程中读代码发现的缺陷（第二轮）

> 这一轮是"补注释 + 读懂每个函数"，**没有修任何缺陷**，只记录。
> 行号是**当前工作区的行号**，动手修之前请重新确认（有并行改动）。
>
> 上一轮的 53 条在同目录的 [`issues.md`](issues.md)。这一轮是**新发现的**，另外给上一轮的部分条目做了交叉引用。

## P0 · 用户可见且会卡住

### N1. `readBody` 分不清「JSON 解析出 falsy」和「出错、响应已回」→ 请求永久挂起

- **位置**：`server.js` 的 `readBody` / `readJsonBody`
- **现象**：`readBody` 直接把 `readJsonBody` 的解析结果返回，调用方统一写 `if (!body) return;`。
  请求体是字面量 `null` / `false` / `0` 时，`JSON.parse` 成功、返回该 falsy 值，
  调用方以为「已经回过响应了」直接 return —— **客户端什么都收不到，只能等 Node 的 request timeout**。
- **依据**：`readFileBody` 那条路拿到的是 Buffer（永不为 falsy），所以只有 JSON 这条路有洞。
- **修法**：区分「出错」与「值为 falsy」，例如返回 `undefined` 之类的哨兵，或改成抛异常。
- **状态**：静态推断，未实测。

### N2. `view.html` / `user.html` 用写死的演示身份做权限判断

- **位置**：`public/view.html`（删除按钮、评论 isOwn）、`public/user.html`（isOwn 决定「编辑资料」还是「+ 关注」）
- **现象**：判断写作 `c.author.username === MP.ME.username || MP.ME.isAdmin`，而 `MP.ME` 恒为演示用户且是管理员。
  后果：**真实作者看不到自己评论的删除按钮；任何访客都能删演示评论；真实用户打开自己的主页看到的是「+ 关注」**。
- **依据**：这两页完全不调 `MP.session()` / `/api/me`，而真实接口其实都已存在
  （`/api/u/:username/profile`、站点 stats/comments）—— **页面里那些 `TODO 后端对接` 标记已经过期**。

### N3. 上传页文案「单文件 ≤ 10 MB」与服务端上限不符

- **位置**：`public/index.html`（两处提示文案）
- **现象**：单页模式走 `POST /api/upload`，上限是 `MAX_HTML_BYTES = 2 MB`（`lib/config.js`）；
  而 10 MB 是 `MAX_FILE_BYTES`，只用于多页站的单个文件。**前端允许、后端必拒**。

### N4. 同一份 `index.html`，两条路上限差 5 倍

- **位置**：单页通道 `server.js` 卡 `MAX_HTML_BYTES`(2MB)；多页文件通道卡 `MAX_FILE_BYTES`(10MB)
- **现象**：同一份 HTML 走 `PUT /api/sites/:name` 会被 413，走
  `/api/sites/:name/files?path=index.html` 却能过。**上限取决于走哪条路，而不是内容本身。**

### N5. 网络失败时静默无反应的地方

| 位置 | 现象 |
|---|---|
| `public/sites.html` 删除回调 | 无 try/catch，`await fetch` 或 `res.json()` 抛错 → unhandled rejection，**界面"点了没反应"**，既不提示也不刷新 |
| `public/site.html` 的 `loadSite()` / `loadFiles()` | 同样无 try/catch，网络异常后页面停在**空白面板**，连提示条都不显示（对比：index.html / account.html 都有 try/catch） |
| `public/user.html` | `authorNode` 系列对 `author.name` 取首字符无兜底 |

### N6. 演示页对缺失字段无兜底

- `public/messages.html` — 预览取 `c.msgs[c.msgs.length - 1]`，**空会话会抛错**
- `public/notifications.html` — `it.actor[0]` 无兜底，actor 缺失直接抛错
- `public/user.html` / `public/view.html` / `public/messages.html` — 用 `MP.ME.name` 当"自己"，与真实登录态不一致

## P1 · 逻辑不一致 / 会误导

### N7. 管理员种子口令低于平台自己的密码下限

- **位置**：`lib/users.js` 的 `ADMIN_PASSWORD ?? '123'`；而 `lib/config.js` 的 `PASSWORD_MIN = 6`
- **现象**：`createUser` 不校验长度，所以这个口令能落库。注册/改密/重置都走 `PASSWORD_MIN`，**只有种子路径绕过它**。

### N8. 发验证码：先写库、后发信

- **位置**：`lib/verification.js` 的 `issueCode`（INSERT 在前，`await sendMail` 在后，且不捕获异常）
- **现象**：SMTP 一挂，接口 500，但该邮箱+用途的记录**已经存在** → 用户白等满 60 秒冷却才能重试。
  注册和找回密码两条路都不通。（[`issues.md`](issues.md) E6）

### N9. `updated_at` 刷新不对称 → 发现流排序不跟手

- **位置**：`lib/sites.js` — `updateSiteMeta`（改标题/简介）和 `removeSiteFile`（删文件）**都不刷新** `sites.updated_at`；
  而 `updateSiteHtml` 刷新，`upsertSiteFile` 会调 `touchSite`。
- **后果**：改标题、改简介、删文件都不会让站点在「最近更新」排序里冒头。

### N10. `originOf` 把 scheme 写死成 `http://`，且取自可伪造的 Host 头

- **位置**：`server.js` 的 `originOf`；`lib/mcp/server.js` 的 `ctx.origin` 同样写法
- **后果**：HTTPS 反代后，`/api/upload` 返回的 `url`、上传页展示的链接、MCP 工具返回的 url 全是 `http://`；
  另外 Host 完全由调用方控制，会把任意 origin 回显出去。

### N11. 多页站上传：先建站、后读请求体

- **位置**：`server.js` 的 `handleSiteFileUpload`
- **现象**：上传中断或正文为空时，会留下一个 `html=''`、0 个文件的**空站点**，访问它只会 404。
  （与 `issues.md` G5「多页上传半个站点」相关但不是同一条）

### N12. 用 `getSiteFile` 判断「文件是否存在」，要把整个 BLOB 读出来

- **位置**：`server.js`（覆盖前做存在性检查处）
- **现象**：覆盖一个 10 MB 文件前，先把这 10 MB 读进内存。（`issues.md` B8）

### N13. 建表语句不是完整 schema

- **位置**：`lib/db.js` — `sites.views`、`users.notify_seen_at` **不在** `CREATE TABLE` 里，只由 `migrate()` 补列。
- **注意**：`migrate` 上方原有注释写「新库建表时已带上」，对这两列**不成立**。
  （实测：新库确实能建出这两列，因为新库也走 `migrate()`，所以功能没问题，只是注释与建表语句的口径不一致）

### N14. `favorites.folder` 的 `DEFAULT '默认收藏夹'` 永远不会生效

- `favoriteSite` 的 INSERT 显式提供了这一列；传空串会照存。没有收藏夹表，也没有重命名操作。

### N15. `addressing.js` 的 `siteNameFromRequest` 没有调用方，且解析规则已经分叉

- **位置**：`lib/addressing.js` 的 `siteNameFromRequest` vs `server.js` 的兜底路由 `/^\/([a-z0-9-]+)(\/.*)?$/`
- **现象**：兜底正则接受 `/站名/子路径`，这个函数只认单段。**而这个文件被设计成「站名 ⇄ 地址」的唯一映射点** ——
  两处规则不一致，换子域式地址时必漏改一处。

### N16. 死代码 / 死参数

| 位置 | 说明 |
|---|---|
| `lib/config.js` 的 `ASSET_PREFIX` | 全仓库无消费者；`/_assets/` 在路由和页面里都是硬编码 |
| `public/app.js` 的 `const DEMO = { enabled: true }` | 全仓库无人读取 |
| `public/app.js` 的 `MP.querySites` | 无页面调用（发现页已改走真实接口） |
| 多个页面的 `MP.topbar({ active: 'upload' \| 'dynamic' \| ... })` | **死参数**：`NAVS` 只有 `home` / `rank`，这些值永远匹配不上，顶栏不会有任何高亮 |

### N17. 前端标签相关的两个残留

- `tagLabel('')` 返回的是「全部」而不是空串（`TAGS` 首项 key 就是 `''`），
  所以 `vcard` 里 `tagLabel(site.tag) || '页面'` 的兜底**对空标签无效** —— 真实接口若返回空 tag，卡片会显示「全部」。
- `public/favorites.html` 的「+ 新建收藏夹」提示「新建收藏夹需要登录后使用」，
  但 `/favorites` 在服务端**已经强制登录**（未登录直接重定向），这句话永远不成立；且服务端没有收藏夹模型。

### N18. `view.html` 评论 id 用 `Date.now()`

- 回复（一处）和新评论（一处）都写 `id: Date.now()`，而 `rootOf` / 回复定位 / 删除都用 `find(x => x.id === ...)`。
- 同一毫秒的两条会**互相顶掉**；删除时 `x.replyTo !== c.id` 还可能连带误删。

### N19. 索引缺口

- `view_history` 主键是 `(user_id, site_id)`，**没有以 `site_id` 打头的索引** → 删站点时对它的级联删除要全表扫。
  （`likes` / `favorites` 的复合主键以 `site_id` 打头，可以直接用）

### N20. MCP 侧的三个细节

| 位置 | 现象 |
|---|---|
| `lib/mcp/server.js` 未知方法分发 | 没有 id 的通知（notification）也会收到错误响应对象，绕过了 202 分支。JSON-RPC 2.0 规定通知不得有响应。危害低 |
| `lib/mcp/server.js` 请求体超限 | 与主 server 同一模式：先 `req.destroy()` 再回 413，**413 实际送不到** |
| `lib/mcp/tokens.js` | 「`countMcpTokens` 判上限 → INSERT」非原子，并发创建理论上能落出第 11 把（DB 无对应约束） |

## P2 · 测试自身的脆弱点

- `scripts/mcp-smoke.mjs` 把 2MB 阈值写死（`2 * 1024 * 1024 + 1`），与 `MAX_HTML_BYTES` 各自独立，改配置后失去边界覆盖
- 同文件多处断言依赖**中文文案子串**（`'不是你自己的站点'` / `'已经被占用'` / `'多页'`），改文案即误报

## 与上一轮重复、已交叉引用（不重复分级）

`issues.md` 的 A1 / G1（超限 413 发不出去）、C1（`/api/account/password` 不校验验证码也不踢会话）、
G4（并发注册撞 UNIQUE → 500，且验证码已被消费）、B3（多页站建站塞空 html 占位）、
B7（过期会话只在启动时清一次）、B8（覆盖前整块读 BLOB）、D8（种子口令）、
D10（封禁不吊销会话，登录态在 server.js 按 status 现查）、E6（发码先写库后发信）、G5。

## 统计

| 级别 | 条数 |
|---|---|
| P0（用户可见且会卡住） | 6 |
| P1（逻辑不一致 / 会误导） | 14 |
| P2（测试脆弱） | 1 类 |
