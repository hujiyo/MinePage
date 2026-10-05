# MinePage

极简个人 page 托管 + 社区平台。注册账号，上传一个 HTML 文件，起个名字，
就能通过 `域名/名字` 访问；`/` 是社区首页（发现流、搜索、标签筛选），
管理员在 `/admin` 管理用户和页面。

## 跑起来

```
npm install
node server.js
```

打开 http://127.0.0.1:3000

唯一的外部依赖是 `nodemailer`（发验证码邮件）；数据库用的是 Node 自带的 `node:sqlite`。

**邮件配置**：默认不配置 SMTP 时走开发模式，验证码打印在服务器控制台。
要真发信，设这些环境变量：`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`
（可选 `SMTP_FROM`、`SMTP_SECURE`）。

首次启动会自动创建管理员账号并在控制台打印，默认是 `admin` / `123`。
只在数据库里没有管理员时创建一次，之后改过密码也不会被覆盖回去。

> 启动时那行 `ExperimentalWarning: SQLite ...` 是 Node 对内置 SQLite 模块的提示，无害。

## 结构

```
server.js                     HTTP 服务：路由表 + 各接口处理
lib/config.js                 端口、上限、名字规则、保留字、会话参数
lib/db.js                     SQLite 连接与建表（幂等）
lib/auth.js                   scrypt 密码哈希、会话 token、Cookie 读写
lib/users.js                  用户与会话的数据操作、管理员种子
lib/sites.js                  站点的数据操作
lib/social.js                 社区互动数据操作（点赞 / 评论 / 收藏 / 关注 / 通知 / 浏览量 / 创作者主页）
lib/names.js                  站名校验
lib/addressing.js             「站名 ⇄ 访问地址」的唯一映射点，换地址形态只改这里
lib/email.js                  发信（SMTP），未配置时退化为控制台打印
lib/verification.js           邮箱验证码的生成、发送、校验与限流
lib/mcp/tokens.js             MCP 密钥：铸造 / 列表 / 吊销 / 鉴权（只存 sha256）
lib/mcp/tools.js              MCP 工具注册表（唯一真源）+ 10 个 backend
lib/mcp/server.js             MCP 的 JSON-RPC 分发，零依赖手写
scripts/mcp-smoke.mjs         MCP 冒烟测试（68 项，见下）
public/index.html             上传页（/upload）
public/discover.html          社区首页（/）
public/user.html              创作者主页（/u/:用户名）
public/view.html              观看页（/view/:站名，全屏 iframe + 底部吸附栏 + 评论面板）
public/notifications.html     通知列表页（/notifications）
public/favorites.html         我的收藏（/favorites）
public/history.html           观看历史（/history）
public/messages.html          私信（/messages）
public/login.html             登录 / 注册（注册需邮箱验证码）
public/forgot.html            找回密码
public/settings.html          账号设置（改密码 + 创建 MCP 密钥）
public/admin.html             管理后台
public/app.js                 公共前端脚本（顶栏 / 图标 / 站点卡片）
public/style.css              共享样式
data/minepage.db              数据库（不进 git）
```

## 注释习惯（现状，不是新规定）

这一节**只是把项目里已经在用的写法记录下来**，供新代码照着写。
数字来自对提交 `bf70a7e` 的普查：363 个函数中 130 个已有 `/** */` 注释（36%）。

### 实际在用的写法

1. **函数上方用 `/** ... */`**，中文散文体。写「这个函数干什么」，
   重点在**为什么**和**陷阱**，而不是复述代码。现有注释基本都落在这四类上：
   调用时机与前提、副作用（写库 / 发信 / 踢会话 / 删文件）、**调用方必须注意的坑**、返回值里关键字段的含义。
2. **`@param` / `@returns` 用得很少**（全项目 9 次 `@param`、1 次 `@returns`），
   基本都是用来**补充类型**（`{HTMLElement}` 这类 JS 签名给不出的信息）。
   复述参数名的那种（`@param {string} name 名字`）项目里没有，也没必要加 ——
   改了参数名就会忘记同步，然后开始骗人。
3. **未接后端的地方标** `// TODO 后端对接：替换为 fetch('/api/xxx')`，
   项目里已有 23 处。这是目前最有用的一个习惯 —— 它把「看起来能用但其实是假的」明确标了出来。
   做前端接手时 `grep -rn "TODO 后端对接"` 就是一份待办清单。

### 段落分隔线的形态**按文件各不相同**

这一点容易踩坑：**每个文件有它自己的形态，改代码时用所在文件的那一种就行。**
（曾经试图统一成一种，属于多余改动，已还原。）

| 文件 | 它自己在用的形态 |
|---|---|
| `server.js`、`lib/*.js` | `// ` + 64 个连字符 + 标题 |
| `public/app.js`、`public/view.html` | 三行块：`/* ----…` ⏎ `标题` ⏎ `----… */` |
| `lib/config.js` | `// ` + 22 个连字符 + 标题（两侧都有） |
| `scripts/mcp-smoke.mjs` | `// --- 标题 ---` |
| `public/style.css` | `/* ===== 标题 ===== */` |

### 现有注释长什么样（照这个写）

```js
/**
 * 校验站名。
 * 通过时返回 { ok: true, name }，name 是规范化后的结果（去空格、转小写），调用方必须用它。
 * 不通过时返回 { ok: false, reason }，reason 可以直接展示给用户。
 */
```

```js
/**
 * 踢掉某个用户的其他会话。找回密码后不带 keepToken（全部失效）；
 * 用户自己改密码时传当前会话 token，免得把自己也踢下线。
 */
```

两段都没写参数类型，但把**调用方必须知道的事**说清楚了。

## 十二张表

| 表 | 存什么 |
|---|---|
| `users` | 账号、scrypt 密码哈希、是否管理员、封禁状态 |
| `sites` | 站名、归属用户、HTML 内容、大小、上线状态、标题简介标签 |
| `site_files` | 多页站的文件（路径 + BLOB 内容） |
| `sessions` | 登录会话，带过期时间 |
| `email_codes` | 邮箱验证码的哈希、用途、有效期与尝试次数 |
| `mcp_tokens` | MCP 密钥的 sha256、名称、最后使用时间（明文不落库） |
| `likes` | 点赞（一人一站一条） |
| `comments` | 评论，`reply_to` 只做一级回复 |
| `favorites` | 收藏，带收藏夹名字 |
| `follows` | 关注关系 |
| `view_history` | 浏览历史（一人一站一条，重复浏览只刷新时间） |
| `messages` | 私信，`read_at` 为空表示未读 |

## 接口

一共 **72** 条路由。下面这张表由脚本从 `server.js` 生成，**鉴权是从每个 handler 的源码推导的**，
不靠人工标注（人工标注一定会和代码脱节）：

```
node tests/scripts/route-table.mjs              # 打到标准输出
node tests/scripts/route-table.mjs --out x.md   # 写到文件
```

**加了路由就重新生成，别手改表。**

鉴权列的含义：

| 标记 | 含义 |
|---|---|
| 公开 | 不需要登录 |
| 公开（读登录态） | 不登录也能用，但登录后结果不同（例如多返回「我是否已赞」） |
| 需登录 | 未登录被拒。**页面路由 302 到 `/login`，接口路由返回 401 JSON** |
| 需登录·限属主 | 还要求是站点属主（管理员例外），否则 403。由 `ownSiteOrRespond` 实施 |
| 仅管理员 | 非管理员 403 |
| 密钥鉴权 | 走 MCP 密钥，与登录 Cookie 无关 |
| 公开/需登录（按 purpose） | 见下方参数说明 |

> `siteHeaderOrRespond` 只是「站点不存在就 404」的查找助手，**不是鉴权**。
> 所以 `/api/sites/:name/stats` 和 `/api/sites/:name/comments` 是公开可读的。

### 页面

| 方法 | 路径 | 鉴权 |
|---|---|---|
| GET | `/` | 公开 |
| GET | `/upload` | 需登录 |
| GET | `/u/:名字/*` | 公开 |
| GET | `/view/:名字/*` | 公开 |
| GET | `/notifications` | 需登录 |
| GET | `/favorites` | 需登录 |
| GET | `/history` | 需登录 |
| GET | `/messages` | 需登录 |
| GET | `/login` | 公开（读登录态） |
| GET | `/account` | 需登录 |
| GET | `/sites` | 需登录 |
| GET | `/edit/:名字` | 需登录 |
| GET | `/admin` | 仅管理员 |
| GET | `/settings` | 需登录 |
| GET | `/forgot` | 公开（读登录态） |
| GET | `/_assets/:文件` | 公开 |
| GET | `/:名字` | 公开（用户站点，带沙箱头） |

### 账号与凭据

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/me` | 公开（读登录态） | 当前登录用户；未登录时 `user: null` |
| POST | `/api/auth/register` | 公开 | 邮箱注册（需 `code`） |
| POST | `/api/auth/login` | 公开 | 登录（邮箱或用户名） |
| POST | `/api/auth/logout` | 公开 | 登出 |
| POST | `/api/auth/send-code` | 公开/需登录（按 purpose） | `purpose=register` 时公开（那时还没账号）；`purpose=change` 时需登录。60 秒冷却，命中返回 429 |
| POST | `/api/auth/password` | 需登录 | 改密码 |
| POST | `/api/auth/forgot-password` | 公开 | 发重置验证码 |
| POST | `/api/auth/reset-password` | 公开 | 凭验证码重置 |
| POST | `/api/account/username` | 需登录 | 设置用户名（创作者主页地址用） |
| POST | `/api/account/password` | 需登录 | 改密码（同 `/api/auth/password`） |
| POST | `/api/account/bio` | 需登录 | 改个人简介 |

### 站点内容

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/discover` | 公开 | 发现流，参数见下 |
| GET | `/api/sites` | 需登录 | 我上传的页面 |
| POST | `/api/upload` | 需登录 | 建单页站（`{name, html}`） |
| GET | `/api/sites/:名字` | 需登录·限属主 | 详情；单页站带 `html`，多页站带文件数 |
| PUT | `/api/sites/:名字` | 需登录·限属主 | 整体替换单页站 HTML |
| PUT | `/api/sites/:名字/meta` | 需登录·限属主 | 改标题 / 简介 / 标签 |
| DELETE | `/api/sites/:名字` | 需登录·限属主 | 删站（级联清站点文件） |
| GET | `/api/sites/:名字/files` | 需登录 | 文件清单 |
| POST | `/api/sites/:名字/files` | 需登录 | 上传/覆盖文件（`?path=`） |
| GET | `/api/sites/:名字/files/content` | 需登录·限属主 | 读文件内容 |
| DELETE | `/api/sites/:名字/files` | 需登录·限属主 | 删文件（`?path=`） |
| GET | `/api/sites/:名字/stats` | 公开（读登录态） | 浏览 / 赞 / 评 / 藏，以及「我是否已赞/已藏」 |
| POST | `/api/sites/:名字/like` | 需登录 | 点赞 |
| DELETE | `/api/sites/:名字/like` | 需登录 | 取消点赞 |
| GET | `/api/sites/:名字/comments` | 公开 | 评论列表 |
| POST | `/api/sites/:名字/comments` | 需登录 | 发评论（回复带 `replyTo`） |
| DELETE | `/api/sites/:名字/comments/:id` | 需登录 | 删评论（作者或管理员） |
| POST | `/api/sites/:名字/favorite` | 需登录 | 收藏（可选 `folder`） |
| DELETE | `/api/sites/:名字/favorite` | 需登录 | 取消收藏 |

### 社区

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/u/:名字/profile` | 公开（读登录态） | 创作者主页：资料 / 粉丝关注数 / 总浏览 / TA 的站点 |
| POST | `/api/users/:id/follow` | 需登录 | 关注（不能关注自己） |
| DELETE | `/api/users/:id/follow` | 需登录 | 取关 |
| GET | `/api/users/:id/social` | 公开（读登录态） | 粉丝数 / 关注数 / 是否已关注 |
| GET | `/api/users/:id/follow-list` | 公开（读登录态） | 粉丝或关注列表（`?type=followers\|following`） |
| GET | `/api/users/search` | 公开 | 按用户名/邮箱前缀搜用户（`?q=`） |
| GET | `/api/notifications` | 需登录 | 收到的互动，新到旧，最多 50 条 |
| POST | `/api/notifications/seen` | 需登录 | 推进已读时间戳 |
| GET | `/api/history` | 需登录 | 浏览历史 |
| POST | `/api/history` | 需登录 | 记一条浏览（观看页打开时调） |
| DELETE | `/api/history` | 需登录 | 清空历史 |
| DELETE | `/api/history/:名字` | 需登录 | 删单条 |
| GET | `/api/favorites` | 需登录 | 我的收藏 |
| GET | `/api/messages` | 需登录 | 会话列表 |
| GET | `/api/messages/:id` | 需登录 | 与某人的私信 |
| POST | `/api/messages/:id` | 需登录 | 发私信 |

### 管理后台

| 方法 | 路径 | 鉴权 |
|---|---|---|
| GET | `/api/admin/users` | 仅管理员 |
| POST | `/api/admin/users/:id/status` | 仅管理员 |
| GET | `/api/admin/sites` | 仅管理员 |
| POST | `/api/admin/sites/:id/status` | 仅管理员 |
| DELETE | `/api/admin/sites/:id` | 仅管理员 |

### MCP

| 方法 | 路径 | 鉴权 |
|---|---|---|
| POST | `/mcp` | 密钥鉴权 |
| POST | `/mcp/:key` | 密钥鉴权 |
| GET | `/api/mcp/tokens` | 需登录 |
| POST | `/api/mcp/tokens` | 需登录 |
| POST | `/api/mcp/tokens/:id/revoke` | 需登录 |

### 参数与约定

#### `GET /api/discover`

| 参数 | 取值 | 说明 |
|---|---|---|
| `q` | 任意，截断到 50 字 | 同时模糊匹配**标题 / 简介 / 站名**。**不匹配作者名** |
| `tag` | 见下方词表 | **非法值被静默忽略（变成不筛选），不报错** |
| `sort` | `''`(默认，按更新时间) · `views` · `likes` · `favorites` · `comments` · `newest` | **白名单；非法值退化为默认排序，不报错** |

返回每个站点：`name / title / description / tag / tagLabel / views / likes / comments / favorites /
fileCount / kind / updatedAt / author{id,name,username}`。上限 100 条。

> ⚠️ **`tag` 和 `sort` 都是「静默退化」**：传错了不报错，只返回一个看起来正常但不对的结果。
> 所以前端**不能把自造的取值直接透传**。例如 `tag=hot` 是前端伪标签、服务端没有，
> 直接透传会返回全部站点（看着像成功）。`public/discover.html` 里做了映射并写了注释。
> 「排行榜」入口的 `?sort=rank` 同理（白名单里没有 `rank`），也映射成 `views`。

#### 内容标签词表（服务端是权威）

`lib/sites.js` 的 `SITE_TAGS`：

`resume` 求职简历 · `portfolio` 作品集 · `social` 社交聚合页 · `blog` 技术博客 ·
`event` 活动落地页 · `opensource` 开源项目 · `docs` 学习笔记 · `other` 其他

**`hot` 不在其中** —— 它和 `''`（全部）一样只是前端筛选条上的伪标签。
前端的 `MP.TAGS` 必须与这份词表对齐，`tests/scripts/consistency.mjs` 会核对这件事
（曾经漂移过：服务端 `opensource`、前端 `oss`，导致「开源项目」永远筛不出来）。

#### 上限（`lib/config.js`）

| 项 | 值 |
|---|---|
| 单页站 HTML | 2 MB |
| 单个文件 | 10 MB |
| 每站文件数 | 200 |
| 标题 / 简介 | 80 / 300 字 |
| 每账号 MCP 密钥 | 10 把 |

## 前端页面的数据来源

**这张表很重要**：有一部分页面是"能看但假"的——它们渲染的是 `public/app.js` 里的演示数据
（`MP.SITES` / `MP.HOT` 等），完全没有请求后端。看界面看不出来，只有翻源码或看网络面板才知道。

| 页面 | 数据来源 | 状态 |
|---|---|---|
| `index.html`（`/upload`） | `/api/upload`、`/api/sites/:name/files`、`/meta` | ✅ 真实接口 |
| `site.html`（`/edit/:名字`） | `/api/sites/:name`、`/files`、`/meta` | ✅ 真实接口 |
| `sites.html`（`/sites`） | `/api/sites`、`DELETE /api/sites/:name` | ✅ 真实接口 |
| `account.html`（`/account`） | `/api/account/*` | ✅ 真实接口 |
| `settings.html`（`/settings`） | `/api/account/*`、`/api/mcp/tokens` | ✅ 真实接口 |
| `admin.html`（`/admin`） | `/api/admin/*` | ✅ 真实接口 |
| `login.html`（`/login`） | `MP.auth.mountForm` → `/api/auth/*` | ✅ 真实接口 |
| `forgot.html`（`/forgot`） | `/api/auth/forgot-password`、`/reset-password` | ✅ 真实接口 |
| `discover.html`（`/`） | `/api/discover` | ✅ 真实接口（**轮播 / 热门榜单 / 热搜仍是演示数据**，见下） |
| `view.html`（`/view/:名字`） | — | ❌ **演示数据** |
| `user.html`（`/u/:名字`） | — | ❌ **演示数据** |
| `favorites.html`（`/favorites`） | — | ❌ **演示数据** |
| `history.html`（`/history`） | — | ❌ **演示数据** |
| `messages.html`（`/messages`） | — | ❌ **演示数据** |
| `notifications.html`（`/notifications`） | — | ❌ **演示数据** |

`discover.html` 里这三块**仍是演示数据**，点进去的目标站点在库里不存在：

- **轮播位** 已暂时停用（`mountBanner()` 未调用）。它原本指向 `aurora-portfolio` /
  `mini-vue` / `opensource-landing` 三个库里没有的站点，且图片来自外部第三方地址。
- **热门榜单** 读 `MP.topSites()`，**热搜** 读 `MP.HOT` —— 都是写死的。

「热门榜单」和顶栏「排行榜」的区别、热搜该不该是随机的，这几个问题还没定，
所以先留着不动。

## 接入 MCP（让 AI 直接管页面）

在 `/settings` 里给密钥起个名字，创建后会得到一串 `mp_mcp_...`（**只显示这一次**），
然后填进 AI 客户端的 MCP 配置。之后建站、改内容、管文件都靠对话完成，不用再回网页。

```
claude mcp add --transport http minepage http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer mp_mcp_xxxxx"
```

不能自定义请求头的客户端（豆包等）直接把地址填成 `http://127.0.0.1:3000/mcp/mp_mcp_xxxxx`。

服务端是标准的 Streamable HTTP MCP（无状态、JSON 响应模式），手写 JSON-RPC，
不引 MCP SDK，零新依赖。密钥走 `mcp_tokens` 表，只存 sha256、可随时吊销、
每账户上限 10 把；账号被封后手里的密钥立刻失效。

工具一共 10 个，**都只作用于密钥主人自己的站点**（管理员的密钥也不例外）：

| 工具 | 作用 |
|---|---|
| `list_sites` / `get_site` | 列出站点、看单站详情（单页站带 HTML，多页站带文件清单） |
| `create_site` | 建单页站（名字 + 完整 HTML） |
| `update_site_html` | 整体替换单页站 HTML |
| `update_site_meta` | 改标题 / 简介 / 内容标签（只传要改的字段） |
| `write_file` / `delete_file` / `list_files` / `read_file` | 多页站的文件增删改查 |
| `delete_site` | 删整个站点 |

**回归脚本**（另起一个端口和库，别拿常驻服务跑）：

```
$env:PORT=3100; $env:DB_FILE='data/mcp-smoke.db'; node server.js
node scripts/mcp-smoke.mjs                        # 主流程 51 项
node scripts/mcp-smoke.mjs --isolation smoke-friend   # 跨账号隔离 8 项（换个账号跑）
node scripts/mcp-smoke.mjs --revoke-check         # 吊销 4 项
node scripts/mcp-smoke.mjs --ban-check b@smoke.local  # 封禁联动 5 项
```

## 三条不能忘的约束

- 用户页面的响应必须带 `Content-Security-Policy: sandbox ...`，
  且**绝不能加 `allow-same-origin`** —— 加了脚本能自己解除沙箱，等于没做。
  平台上现在有登录 Cookie，这道墙是必需品而不是可选装饰。
- 密码只存 scrypt 哈希，任何情况下不要把明文写进数据库或日志。
- 上线走 HTTPS 之后设 `COOKIE_SECURE=1`。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `DB_FILE` | `data/minepage.db` | 数据库位置（相对项目根目录） |
| `ADMIN_USERNAME` | `admin` | 管理员用户名 |
| `ADMIN_PASSWORD` | `123` | 管理员密码，首次创建时生效 |
| `ADMIN_EMAIL` | `admin@minepage.local` | 管理员邮箱 |
| `COOKIE_SECURE` | 关 | 设为 `1` 时 Cookie 带上 Secure |
| `SMTP_HOST` 等 | 空 | 发信配置，见「跑起来」；不配置则验证码打印到控制台 |

## 已知缺陷

| 编号 | 现象 | 位置 |
|---|---|---|
| 大文件上传 | 单个文件超过 10MB 时客户端拿到的是 `socket hang up` 而不是 413。服务端在 `readRawBody` 超限时调了 `req.destroy()`，连带把 socket 断了，413 发不出去 | `server.js` 的 `readRawBody` |
| 站名大写 | 站名含大写字母时，**多文件**接口匹配不上路由（`/^\/api\/sites\/([a-z0-9-]+)\/files$/` 只认小写），返回 404 HTML，前端按 JSON 解析失败显示「网络出问题了」；而同一个站名走**单页**上传却成功（`checkName` 会转小写）。两种模式行为不一致 | `server.js` 路由表 + 上传页 |

## 还没做

- **前端 6 个页面还是演示数据**（`view` / `user` / `favorites` / `history` / `messages` / `notifications`），
  见上面「前端页面的数据来源」
- **`discover.html` 的轮播 / 热门榜单 / 热搜**仍是写死的。这三块和顶栏「排行榜」的语义
  还没定清楚（热门榜单和排行榜有什么区别、热搜该不该是随机的）
- **排行榜入口是坏的**：顶栏「排行榜」指向 `/?sort=rank`，而 `rank` 不在服务端排序白名单里，
  会静默退化为默认排序 —— 也就是说它和首页显示的是同一个列表。
  目前 `discover.html` 里把它映射成了 `views` 来兜住
- **`/api/hot` 不存在**，`app.js` 里有条 TODO 说要换成它
- lint / 格式化配置
- 限流与配额（验证码有 60 秒重发冷却，其他接口还没有）
- **浏览量口径粗糙**：只在访问入口页（`/站名` 或 `/站名/`）时 +1，站内 css/js/图片不算；
  没有去重、没有防刷。所以按 `sort=views` 排出来的「热榜」目前噪音很大

## 测试现状

进 git 的只有 `scripts/mcp-smoke.mjs`（MCP 的回归脚本，见上）：

```
$env:PORT=3100; $env:DB_FILE='data/mcp-smoke.db'; node server.js
node scripts/mcp-smoke.mjs                        # 主流程 51 项
node scripts/mcp-smoke.mjs --isolation smoke-friend   # 跨账号隔离 8 项
node scripts/mcp-smoke.mjs --revoke-check         # 吊销 4 项
node scripts/mcp-smoke.mjs --ban-check b@smoke.local  # 封禁联动 5 项
```

除此之外的联调一直是手工做的。`node --check server.js` 只能查语法，查不出运行时问题 ——
比如 `lib/social.js` 里曾把关注列表写成 `ORDER BY f.id DESC`，而 `follows` 表的主键是
`(follower_id, followee_id)`、**没有 `id` 列**，于是 `GET /api/users/:id/follow-list`
对任何用户都必然 500。这类问题只有真的请求一次才会暴露。
