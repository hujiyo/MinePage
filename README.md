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

外部依赖只有两个：`nodemailer`（发验证码邮件）和 `mysql2`（数据库驱动）。
存储用 **MySQL 8**，启动时自动建表（幂等），库和账号要提前建好，
连接参数走环境变量：`MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` /
`MYSQL_PASSWORD` / `MYSQL_DATABASE`（默认连 `127.0.0.1:3306` 的 `minepage` 库）。
连不上会直接启动失败并把原因打到控制台。

**邮件配置**：默认不配置 SMTP 时走开发模式，验证码打印在服务器控制台。
要真发信，设这些环境变量：`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`
（可选 `SMTP_FROM`、`SMTP_SECURE`）。

首次启动会自动创建管理员账号并在控制台打印，默认是 `admin` / `123`。
只在数据库里没有管理员时创建一次，之后改过密码也不会被覆盖回去。

## 结构

```
server.js                     HTTP 服务：路由表 + 各接口处理
lib/config.js                 端口、上限、名字规则、保留字、会话参数
lib/db.js                     MySQL 连接池、建表（幂等）、老库补列
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
scripts/api-smoke.mjs         全站接口冒烟测试（129 项，自己拉起临时服务，见下）
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

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 社区首页（发现流、搜索、标签筛选） |
| GET | `/upload` | 上传站点 |
| GET | `/u/:用户名` | 创作者公开主页 |
| GET | `/view/:站名` | 观看页（全屏沙箱 iframe + 底部吸附栏 + 评论面板） |
| GET | `/notifications` | 通知列表页（收到的互动） |
| GET | `/login` | 登录 / 注册 |
| GET | `/admin` | 管理后台（仅管理员） |
| GET | `/api/me` | 当前登录用户 |
| POST | `/api/auth/register` | 邮箱注册 |
| POST | `/api/auth/login` | 登录（邮箱或用户名） |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/discover` | 社区发现流（?q= 模糊搜索，?tag= 标签筛选） |
| GET | `/api/u/:username/profile` | 创作者主页数据（资料 / 粉丝关注数 / 总浏览量 / TA 的站点） |
| GET | `/api/sites` | 我上传的页面 |
| POST | `/api/upload` | 上传 HTML（需登录） |
| GET | `/api/sites/:name/stats` | 站点互动数字（浏览 / 赞 / 评 / 藏） |
| POST / DELETE | `/api/sites/:name/like` | 点赞 / 取消（需登录） |
| GET / POST | `/api/sites/:name/comments` | 评论列表 / 发评论（回复带 replyTo） |
| DELETE | `/api/sites/:name/comments/:id` | 删评论（作者或管理员） |
| POST / DELETE | `/api/sites/:name/favorite` | 收藏 / 取消（可选 folder 名字） |
| POST / DELETE | `/api/users/:id/follow` | 关注 / 取关（不能关注自己） |
| GET | `/api/users/:id/social` | 粉丝数 / 关注数 / 是否已关注 |
| GET | `/api/notifications` | 通知列表（最近的互动事件，新到旧，最多 50 条） |
| POST | `/api/notifications/seen` | 推进已读时间戳（进通知页自动调用） |
| GET | `/api/admin/users` | 用户列表 |
| POST | `/api/admin/users/:id/status` | 封禁 / 解封 |
| GET | `/api/admin/sites` | 全部页面 |
| POST | `/api/admin/sites/:id/status` | 下线 / 恢复 |
| DELETE | `/api/admin/sites/:id` | 删除页面 |
| GET | `/api/mcp/tokens` | 我的 MCP 密钥列表 |
| POST | `/api/mcp/tokens` | 创建 MCP 密钥（明文只回一次） |
| POST | `/api/mcp/tokens/:id/revoke` | 吊销密钥 |
| POST | `/mcp` | MCP 运行时（密钥鉴权，与登录态无关） |
| GET | `/:名字` | 用户页面（带沙箱头） |

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

**回归脚本**（都用独立的冒烟库 `MYSQL_DATABASE=minepage_smoke`，别拿生产库跑）：

```
# 起一个测试服务（冒烟库，种子管理员 admin/123）
$env:PORT=3100; $env:MYSQL_DATABASE='minepage_smoke'; node server.js

node scripts/mcp-smoke.mjs                        # 主流程 51 项
node scripts/mcp-smoke.mjs --isolation smoke-friend   # 跨账号隔离 8 项（$env:SMOKE_LOGIN 换个账号跑）
node scripts/mcp-smoke.mjs --revoke-check         # 吊销 4 项
node scripts/mcp-smoke.mjs --ban-check b@smoke.local  # 封禁联动 5 项（需要库里有个 b@smoke.local）
```

全站接口回归不用自己起服务，脚本会拉一个临时服务，开跑前自动清空
冒烟库的表，跑完自己收拾：

```
node scripts/api-smoke.mjs          # 129 项：注册/登录/站点/文件/社交/权限/后台/改密
node scripts/api-smoke.mjs --json   # 末尾多打印一段 JSON，换库前后可以拿来对比
```

验证码在开发模式下打印到服务端控制台，脚本就是从子进程输出里捞的，
所以这个脚本**必须在开发模式（不配 SMTP_HOST）下跑**。
想拿它打已有服务就设 `BASE_URL`，此时管理员凭据从 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 读。

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
| `MYSQL_HOST` | `127.0.0.1` | MySQL 地址 |
| `MYSQL_PORT` | `3306` | MySQL 端口 |
| `MYSQL_USER` | `minepage` | 数据库账号 |
| `MYSQL_PASSWORD` | 空 | 数据库密码 |
| `MYSQL_DATABASE` | `minepage` | 库名；跑回归脚本时指向 `minepage_smoke` |
| `ADMIN_USERNAME` | `admin` | 管理员用户名 |
| `ADMIN_PASSWORD` | `123` | 管理员密码，首次创建时生效 |
| `ADMIN_EMAIL` | `admin@minepage.local` | 管理员邮箱 |
| `COOKIE_SECURE` | 关 | 设为 `1` 时 Cookie 带上 Secure |
| `SMTP_HOST` 等 | 空 | 发信配置，见「跑起来」；不配置则验证码打印到控制台 |

## 还没做

- 自动化测试只盖到接口层（`npm run smoke`），页面上的 JS 交互还没覆盖
- lint / 格式化配置
- 限流与配额（验证码有 60 秒重发冷却，其他接口还没有）
