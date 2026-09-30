# MinePage

极简个人 page 托管平台。注册账号，上传一个 HTML 文件，起个名字，
就能通过 `域名/名字` 访问。管理员在 `/admin` 管理用户和页面。

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
lib/names.js                  站名校验
lib/addressing.js             「站名 ⇄ 访问地址」的唯一映射点，换地址形态只改这里
lib/email.js                  发信（SMTP），未配置时退化为控制台打印
lib/verification.js           邮箱验证码的生成、发送、校验与限流
public/index.html             上传页
public/login.html             登录 / 注册（注册需邮箱验证码）
public/forgot.html            找回密码
public/settings.html          账号设置（改密码）
public/admin.html             管理后台
public/style.css              共享样式
data/minepage.db              数据库（不进 git）
```

## 三张表

| 表 | 存什么 |
|---|---|
| `users` | 账号、scrypt 密码哈希、是否管理员、封禁状态 |
| `sites` | 站名、归属用户、HTML 内容、大小、上线状态 |
| `sessions` | 登录会话，带过期时间 |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 上传页 |
| GET | `/login` | 登录 / 注册 |
| GET | `/admin` | 管理后台（仅管理员） |
| GET | `/api/me` | 当前登录用户 |
| POST | `/api/auth/register` | 邮箱注册 |
| POST | `/api/auth/login` | 登录（邮箱或用户名） |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/sites` | 我上传的页面 |
| POST | `/api/upload` | 上传 HTML（需登录） |
| GET | `/api/admin/users` | 用户列表 |
| POST | `/api/admin/users/:id/status` | 封禁 / 解封 |
| GET | `/api/admin/sites` | 全部页面 |
| POST | `/api/admin/sites/:id/status` | 下线 / 恢复 |
| DELETE | `/api/admin/sites/:id` | 删除页面 |
| GET | `/:名字` | 用户页面（带沙箱头） |

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

## 还没做

- 自动化测试（目前靠手动跑脚本验证全链路）
- lint / 格式化配置
- 限流与配额（验证码有 60 秒重发冷却，其他接口还没有）
