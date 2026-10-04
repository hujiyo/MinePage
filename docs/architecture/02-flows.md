# MinePage 数据流（链路图）

> 按**阶段**画，不按函数画。每个节点第一行是"这一步干了什么"，第二行是"关联实现"。
> 每条链路末尾的**「断点」**是重点 —— 修的时候照它改。
> 状态标记与画法约定见 [`README.md`](README.md)。

## 分类总表

先把链路分好类。分法依据是**用户能感知的能力**，不是代码结构。

| 组 | 编号 | 链路 | 现状 |
|---|---|---|---|
| **身份** | A1 | 注册（邮箱验证码） | ✅ 通 |
| | A2 | 登录 / 登出 / 会话校验 | ✅ 通 |
| | A3 | 找回密码 / 改密码 | ✅ 通 |
| **内容供给** | B1 | 建站：单页上传 | ✅ 通 |
| | B2 | 建站：多页站文件 | ✅ 通 |
| | B3 | 站点元信息 / 编辑 / 删除 | ✅ 通 |
| **内容分发** | C1 | 发现流（搜索 / 筛选 / 排序） | ⚠️ 主列表通，侧栏假 |
| **内容消费** | C2 | 用户站点访问（沙箱渲染） | ⚠️ 站点出口通，观看页假 |
| **互动** | D1 | 点赞 / 收藏 / 关注 / 评论 | ❌ 后端全通，前端一个没接 |
| **个人** | E1 | 个人中心（收藏 / 历史 / 私信 / 通知） | ❌ 4 个页面全是假的 |
| | E2 | 创作者主页 | ❌ 后端有，前端假 |
| **运营** | F1 | 管理后台 | ✅ 通 |
| **外部** | G1 | MCP 通道 | ✅ 通 |

**一句话总结现状**：**后端该有的几乎都有了（72 条路由、12 张表），断的几乎全在前端。**

---

## A1 · 注册（邮箱验证码）

**现状**：✅ 全链路通。`login.html` 与登录弹窗共用 `MP.auth.mountForm`。

```mermaid
flowchart TD
    subgraph S1["① 浏览器"]
        A1["切到「注册」页签，填邮箱<br/>public/app.js · MP.auth.mountForm"]
        A2["点「发送验证码」<br/>login.html / 登录弹窗"]
        A3["填验证码 + 密码，提交<br/>注册表单 submit"]
    end
    subgraph S2["② HTTP 入口 server.js"]
        B1["POST /api/auth/send-code<br/>handleSendCode（purpose=register 公开）"]
        B2["POST /api/auth/register<br/>handleRegister"]
        B3["读 JSON 体<br/>readJsonBody"]
    end
    subgraph S3["③ 业务与数据"]
        C1["生成并落库验证码<br/>lib/verification.js · issueCode"]
        C2["发信（无 SMTP 则打控制台）<br/>lib/email.js · sendMail"]
        C3["校验并消费验证码<br/>verification.js · consumeCode"]
        C4["建用户 + 建会话<br/>lib/users.js · createUser / createSession"]
        C5[("email_codes<br/>users · sessions")]
    end
    subgraph S4["④ 响应与落地"]
        D1["写 Cookie mp_session<br/>server.js · setSessionCookie"]
        D2["前端跳转：管理员 /admin，否则 /<br/>MP.auth.mountForm 的 onSuccess"]
    end
    A1 --> A2 --> B1 --> B3 --> C1 --> C2 --> C5
    C2 -.->|"回 {ok, dev?}<br/>前端 60 秒倒计时"| A3
    A3 --> B2 --> B3 --> C3 --> C4 --> C5 --> D1 --> D2

    classDef ok fill:#e8f7ee,stroke:#2f9e5f,color:#1e6b3f
    class A1,A2,A3,B1,B2,B3,C1,C2,C3,C4,C5,D1,D2 ok
```

**断点**：无。两个已知隐患记在本地清单 `tests/new-findings.md` 的 N7（种子口令低于平台下限）、N8（先写库后发信，SMTP 挂了要等满 60 秒冷却）。该文件不进 git，故不做链接。

---

## A2 · 登录 / 登出 / 会话校验

**现状**：✅ 通。顶栏是**真实用户**，未登录点受保护入口**弹窗**而不跳页。

```mermaid
flowchart TD
    subgraph S1["① 浏览器"]
        A1["页面加载<br/>public/app.js · MP.topbar 先渲染未登录态"]
        A2["异步补丁<br/>MP.session → GET /api/me"]
        A3["点「登录 / 注册」或受保护链接<br/>MP.auth.openLogin（弹窗，URL 不变）"]
        A4["顶栏菜单点「退出登录」<br/>事件委托绑在 #tuser 上"]
    end
    subgraph S2["② HTTP 入口 server.js"]
        B1["GET /api/me<br/>handleMe"]
        B2["POST /api/auth/login<br/>handleLogin"]
        B3["POST /api/auth/logout<br/>handleLogout"]
        B4["Cookie → 会话<br/>currentUser"]
    end
    subgraph S3["③ 业务与数据"]
        C1["按邮箱或用户名查<br/>lib/users.js · findUserByLogin"]
        C2["恒定时间比对密码<br/>lib/auth.js · verifyPassword"]
        C3["建 / 删会话<br/>users.js · createSession / deleteSession"]
        C4[("sessions")]
    end
    subgraph S4["④ 响应与落地"]
        D1["回 {user, unread, unreadMessages}<br/>顶栏换成真实账号"]
        D2["Set-Cookie + 前端跳转<br/>setSessionCookie"]
    end
    A1 --> A2 --> B1 --> B4 --> C4 --> D1
    A3 --> B2 --> C1 --> C2 --> C3 --> C4 --> D2
    A4 --> B3 --> C3

    classDef ok fill:#e8f7ee,stroke:#2f9e5f,color:#1e6b3f
    class A1,A2,A3,A4,B1,B2,B3,B4,C1,C2,C3,C4,D1,D2 ok
```

**断点**：无。

**注意**：`GET /api/me` 是**公开**路由（未登录回 `user: null`，不是 401）。
所以「有没有登录」在前端要靠 `MP.session()` 的结果判断，不能靠状态码。

---

## A3 · 找回密码 / 改密码

**现状**：✅ 通。但**两个改密入口行为不一致**。

```mermaid
flowchart TD
    subgraph S1["① 浏览器"]
        A1["/forgot 填邮箱<br/>public/forgot.html"]
        A2["/forgot 填验证码 + 新密码"]
        A3["/settings 改密（当前密码 + 邮箱码）<br/>public/settings.html"]
        A4["/account 改密<br/>public/account.html"]
    end
    subgraph S2["② HTTP 入口 server.js"]
        B1["POST /api/auth/forgot-password<br/>handleForgotPassword"]
        B2["POST /api/auth/reset-password<br/>handleResetPassword"]
        B3["POST /api/auth/password<br/>handleChangePassword"]
        B4["POST /api/account/password<br/>handleAccountPassword"]
    end
    subgraph S3["③ 业务与数据"]
        C1["发码（purpose=reset）<br/>verification.js · issueCode"]
        C2["邮箱不存在也静默成功<br/>（回复统一，防探测）"]
        C3["校验 + 消费码，改密码<br/>consumeCode → users.js · updatePassword"]
        C4["踢掉其他设备<br/>users.js · deleteOtherSessions"]
        C5[("email_codes<br/>users · sessions")]
    end
    subgraph S4["④ 响应与落地"]
        D1["回 200，前端提示后跳 /login"]
        D2["保留当前会话，回 200"]
    end
    A1 --> B1 --> C1 --> C2 --> C5
    A2 --> B2 --> C3 --> C4 --> C5 --> D1
    A3 --> B3 --> C3 --> D2
    A4 --> B4 --> C3

    classDef ok fill:#e8f7ee,stroke:#2f9e5f,color:#1e6b3f
    classDef warn fill:#fff4e5,stroke:#d98a1f,color:#8a5a00
    class A1,A2,A3,A4,B1,B2,B3,B4,C1,C2,C3,C4,C5,D1,D2 ok
    class B4 warn
```

**断点**：无功能断裂。但 `POST /api/account/password`（A4 那条）**不校验邮箱验证码、也不踢其他会话**，
与 `/api/auth/password` 行为不同 —— 同一个「改密码」有两个入口两套规则。

---

## B1 · 建站：单页上传

**现状**：✅ 通（含 2 MB 上限拦截）。

```mermaid
flowchart TD
    subgraph S1["① 浏览器"]
        A1["/upload 选一个 HTML 文件<br/>public/index.html"]
        A2["读进内存，POST {name, html}<br/>fetch /api/upload"]
    end
    subgraph S2["② HTTP 入口 server.js"]
        B1["POST /api/upload<br/>handleUpload"]
        B2["鉴权<br/>requireLogin"]
        B3["读体（上限 2 MB）<br/>readJsonBody → MAX_HTML_BYTES"]
        B4["站名校验 / 规范化<br/>lib/names.js · checkName"]
    end
    subgraph S3["③ 业务与数据"]
        C1["建站，同名抛 NAME_TAKEN<br/>lib/sites.js · createSite"]
        C2[("sites<br/>html 列存整段 HTML")]
    end
    subgraph S4["④ 响应与落地"]
        D1["回 {ok, url}，前端显示访问地址"]
        D2["访问 /站名<br/>handleSite → 带沙箱 CSP 直出"]
    end
    A1 --> A2 --> B1 --> B2 --> B3 --> B4 --> C1 --> C2
    C2 --> D1
    C2 --> D2

    classDef ok fill:#e8f7ee,stroke:#2f9e5f,color:#1e6b3f
    classDef broken fill:#fdecec,stroke:#d64545,color:#8f2f2f
    class A1,A2,B1,B2,B4,C1,C2,D1,D2 ok
    class B3 broken
```

**断点**：

| # | 现象 | 依据 |
|---|---|---|
| 1 | **超过 2 MB 时客户端拿到的是 `socket hang up` 而不是 413** —— `readRawBody` 超限先 `req.destroy()` 再回 413，连接已断，413 发不出去 | 回归里的已知失败 `BC-11` |

---

## B2 · 建站：多页站文件

**现状**：✅ 通（4 个文件的多页站在库里跑着）。

```mermaid
flowchart TD
    subgraph S1["① 浏览器"]
        A1["/upload 或 /edit/:名字 选文件<br/>public/index.html · site.html"]
        A2["逐个 POST /api/sites/:名字/files?path=…"]
    end
    subgraph S2["② HTTP 入口 server.js"]
        B1["POST /api/sites/:名字/files<br/>handleSiteFileUpload"]
        B2["鉴权 + 限属主<br/>requireLogin → ownSiteOrRespond"]
        B3["读原始字节（上限 10 MB）<br/>readRawBody → MAX_FILE_BYTES"]
        B4["路径合法性 + 文件数上限<br/>isValidSitePath · MAX_FILES_PER_SITE"]
    end
    subgraph S3["③ 业务与数据"]
        C1["站点不存在时用空 html 占位建站<br/>sites.js · createSite"]
        C2["写入或覆盖文件<br/>sites.js · upsertSiteFile"]
        C3["顺带刷新站点更新时间<br/>sites.js · touchSite"]
        C4[("site_files<br/>content 是 BLOB")]
    end
    subgraph S4["④ 响应与落地"]
        D1["文件清单 GET .../files<br/>handleSiteFilesList（不带内容）"]
        D2["读单文件 GET .../files/content<br/>handleSiteFileContent"]
        D3["删文件 DELETE .../files<br/>handleSiteFileDelete"]
    end
    A1 --> A2 --> B1 --> B2 --> B3 --> B4 --> C1 --> C2 --> C3 --> C4
    C4 --> D1
    C4 --> D2
    C4 --> D3

    classDef ok fill:#e8f7ee,stroke:#2f9e5f,color:#1e6b3f
    classDef broken fill:#fdecec,stroke:#d64545,color:#8f2f2f
    classDef warn fill:#fff4e5,stroke:#d98a1f,color:#8a5a00
    class A1,A2,B1,B2,B3,B4,C1,C2,C3,C4,D1,D2 ok
    class D3 warn
    class C1 broken
```

**断点**：

| # | 现象 | 依据 |
|---|---|---|
| 1 | **站名含大写时这条路走不通**：路由正则 `([a-z0-9-]+)` 只认小写 → 匹配不上任何路由 → 返回 404 HTML → 前端按 JSON 解析失败显示「网络出问题了」。而同一个站名走**单页**上传却成功（`checkName` 会转小写）。 | 已知失败 `BC-21` |
| 2 | **同一份 `index.html` 两条路上限差 5 倍**：走单页通道限 2 MB，走这条文件通道限 10 MB | `B1` 的 B3 vs 本图 B3 |
| 3 | **先建站、后读请求体**：上传中断或正文为空会留下 `html=''`、0 文件的**空站点**，访问它只 404 | `new-findings.md` N11 |
| 4 | **判「文件是否存在」要把整个 BLOB 读出来**：覆盖 10 MB 文件前先读 10 MB | N12 |
| 5 | 删文件**不刷新** `sites.updated_at`（写文件会刷新），所以删文件不会让站点在「最近更新」排序里冒头 | N9 |

---

## B3 · 站点元信息 / 编辑 / 删除

**现状**：✅ 通。

```mermaid
flowchart TD
    subgraph S1["① 浏览器"]
        A1["/edit/:名字 打开<br/>public/site.html"]
        A2["改标题 / 简介 / 标签"]
        A3["改单页站 HTML 内容"]
        A4["删除站点"]
        A5["/sites 我的站点列表<br/>public/sites.html"]
    end
    subgraph S2["② HTTP 入口 server.js"]
        B1["GET /api/sites/:名字<br/>handleSiteDetail"]
        B2["PUT /api/sites/:名字/meta<br/>handleSiteSaveMeta"]
        B3["PUT /api/sites/:名字<br/>handleSiteSaveHtml"]
        B4["DELETE /api/sites/:名字<br/>handleSiteDelete"]
        B5["GET /api/sites<br/>handleMySites"]
    end
    subgraph S3["③ 业务与数据"]
        C1["改元信息<br/>sites.js · updateSiteMeta"]
        C2["换 HTML 并同步 size / updated_at<br/>sites.js · updateSiteHtml"]
        C3["删站，级联清站点文件<br/>sites.js · deleteSite"]
        C4[("sites · site_files")]
    end
    subgraph S4["④ 响应与落地"]
        D1["回最新值 / 200，前端就地刷新"]
    end
    A1 --> B1
    A2 --> B2 --> C1 --> C4
    A3 --> B3 --> C2 --> C4
    A4 --> B4 --> C3 --> C4
    A5 --> B5 --> C4
    C4 --> D1

    classDef ok fill:#e8f7ee,stroke:#2f9e5f,color:#1e6b3f
    classDef warn fill:#fff4e5,stroke:#d98a1f,color:#8a5a00
    class A1,A2,A3,A4,A5,B1,B2,B3,B4,B5,C2,C3,C4,D1 ok
    class C1 warn
```

**断点**：无功能断裂。`updateSiteMeta` **不刷新** `updated_at`（而 `updateSiteHtml` 刷新）——
改标题、改简介不会让站点在发现流的「最近更新」排序里冒头（N9）。

---

## C1 · 发现流（搜索 / 标签筛选 / 排序）

**现状**：⚠️ **主列表已经是真实数据**（2026-10 接线），但**侧栏还是演示数据**。

```mermaid
flowchart TD
    subgraph S1["① 浏览器"]
        A1["顶栏搜索框<br/>app.js · MP.goSearch → /?q=…"]
        A2["/ 打开<br/>public/discover.html"]
        A3["点标签筛选条<br/>MP.TAGS → renderChips"]
        A4["🔶 右侧栏：热门榜单 / 热搜<br/>renderSide → MP.topSites / MP.HOT"]
        A5["⬜ 轮播位（已停用）<br/>mountBanner 未调用"]
    end
    subgraph S2["② HTTP 入口 server.js"]
        B1["GET /api/discover?q=&tag=&sort=<br/>handleDiscover"]
        B2["参数白名单<br/>非法 tag/sort 静默退化，不报错"]
    end
    subgraph S3["③ 业务与数据"]
        C1["模糊搜 + 筛选 + 排序<br/>lib/social.js · discoverSites"]
        C2["子查询带出赞/评/藏/文件数<br/>COUNT ← likes / comments / favorites / site_files"]
        C3[("sites + 互动表")]
    end
    subgraph S4["④ 响应与落地"]
        D1["真实列表 → 卡片<br/>app.js · MP.renderCards → MP.vcard"]
    end
    A1 --> A2
    A2 --> A3
    A3 --> B1
    A2 --> B1
    B1 --> B2 --> C1 --> C2 --> C3 --> D1
    A4 -.->|"不发请求"| A4
    A5 -.->|"不发请求"| A5

    classDef ok fill:#e8f7ee,stroke:#2f9e5f,color:#1e6b3f
    classDef demo fill:#fff4e5,stroke:#d98a1f,color:#8a5a00
    classDef missing fill:#f1f2f3,stroke:#9499a0,color:#61666d
    class A1,A2,A3,B1,B2,C1,C2,C3,D1 ok
    class A4 demo
    class A5 missing
```

**断点**：

| # | 现象 | 依据 |
|---|---|---|
| 1 | **右侧栏与主列表口径不一致**：主列表是真实站点（浏览量 0~3），侧栏「热门榜单」还是写死的 6.8 万、「热搜」128.6 万。点侧栏会进 `/view/<演示站名>` | `discover.html` 的 `renderSide()` |
| 2 | **`/api/hot` 不存在**，`app.js` 里有条 TODO 说要用它 | `app.js` 的 `MP.HOT` 上方 |
| 3 | **轮播位被停用**（`mountBanner()` 未调用）：它指向的三个站点库里不存在，图片还是外部第三方地址 | `discover.html` 末尾注释 |
| 4 | **「排行榜」入口本身是坏的**：顶栏指向 `/?sort=rank`，而 `rank` 不在服务端白名单里，会静默退化为默认排序（即和首页同一个列表）。目前在前端被显式映射成 `sort=views` 兜住 | `discover.html` 的 `reload()` |
| 5 | 搜索**不匹配作者名**（只匹配标题 / 简介 / 站名），而前端的演示数据版本会匹配 | `discoverSites` 的 SQL |

---

## C2 · 用户站点访问（沙箱渲染 + 浏览量）

**现状**：⚠️ **站点出口是通的**（能访问、带沙箱、计数），但**观看页 `view.html` 还是演示页**。

```mermaid
flowchart TD
    subgraph S1["① 浏览器"]
        A1["从卡片点进观看页<br/>/view/:名字 → public/view.html"]
        A2["直接访问站点原始地址<br/>/站名 或 /站名/子路径"]
    end
    subgraph S2["② HTTP 入口 server.js"]
        B1["handleSite（兜底路由）<br/>用 lib/addressing.js 解析站名"]
        B2["查站点是否存在<br/>findSiteHeaderByName / findSiteByName"]
    end
    subgraph S3["③ 业务与数据"]
        C1["多页站：按 path 取文件<br/>sites.js · getSiteFile"]
        C2["老单页站：读 sites.html 列"]
        C3["浏览量 +1（只有入口页）<br/>social.js · incrementViews"]
        C4[("sites · site_files")]
    end
    subgraph S4["④ 响应与落地"]
        D1["直出内容 + 沙箱 CSP<br/>serveSiteFile / sendHtml<br/>sandbox 且绝不含 allow-same-origin"]
        D2["🔶 view.html 的 iframe 还是 srcdoc 占位<br/>未指向真实站点"]
        D3["🔶 互动数据 / 评论面板<br/>未调 /api/sites/:name/stats 与 /comments"]
    end
    A2 --> B1 --> B2 --> C1 --> C4
    B2 --> C2 --> C4
    C4 --> C3
    C4 --> D1
    A1 --> D2
    A1 --> D3

    classDef ok fill:#e8f7ee,stroke:#2f9e5f,color:#1e6b3f
    classDef demo fill:#fff4e5,stroke:#d98a1f,color:#8a5a00
    class A2,B1,B2,C1,C2,C3,C4,D1 ok
    class D2,D3 demo
```

**断点**：

| # | 现象 | 依据 |
|---|---|---|
| 1 | **观看页 `view.html` 不请求任何接口**（9 处 `TODO 后端对接`）：iframe 是 `srcdoc` 占位、互动数字和评论都是内存数组 | `view.html` |
| 2 | 因为 iframe 没指向真实站点，**从观看页进去不会产生浏览量**（只有直接访问 `/站名` 才会） | 本图 C3 的触发条件 |
| 3 | 浏览量口径粗糙：只在入口页 +1，子资源不算，**不去重、不防刷**，同一个人刷新也照加 | `incrementViews` |

---

## D1 · 社区互动（点赞 / 收藏 / 关注 / 评论）

**现状**：❌ **后端全通、表都在，前端一个都没接。**

```mermaid
flowchart TD
    subgraph S1["① 浏览器 —— 全部未接"]
        A1["⬜ 卡片快捷赞 / 藏<br/>app.js · vcard 的 ops"]
        A2["⬜ 观看页点赞 / 收藏<br/>public/view.html"]
        A3["⬜ 创作者页关注<br/>public/user.html"]
        A4["⬜ 观看页评论 / 回复 / 删除<br/>public/view.html"]
    end
    subgraph S2["② HTTP 入口 server.js"]
        B1["POST / DELETE /api/sites/:名字/like<br/>handleSiteLike / handleSiteUnlike"]
        B2["POST / DELETE /api/sites/:名字/favorite<br/>handleSiteFavorite / handleSiteUnfavorite"]
        B3["POST / DELETE /api/users/:id/follow<br/>handleUserFollow / handleUserUnfollow"]
        B4["GET / POST /api/sites/:名字/comments<br/>DELETE …/comments/:id<br/>handleSiteCommentsList / Add / Delete"]
        B5["GET /api/sites/:名字/stats<br/>handleSiteStats（公开）"]
    end
    subgraph S3["③ 业务与数据"]
        C1["lib/social.js<br/>likeSite / unlikeSite / hasLiked / countLikes"]
        C2["social.js<br/>favoriteSite / hasFavorited"]
        C3["social.js<br/>followUser / unfollowUser / isFollowing"]
        C4["social.js<br/>addComment / listComments / deleteComment"]
        C5["social.js<br/>siteStats（汇总四个数字）"]
        C6[("likes · favorites<br/>follows · comments")]
    end
    subgraph S4["④ 响应与落地"]
        D1["⬜ 前端就地更新计数与按钮态"]
        D2["通知由此推导（非事件表）<br/>social.js · NOTIFICATIONS_SQL"]
    end
    B1 --> C1
    B2 --> C2
    B3 --> C3
    B4 --> C4
    B5 --> C5
    C1 --> C6
    C2 --> C6
    C3 --> C6
    C4 --> C6
    C6 --> C5
    C5 --> D1
    C6 --> D2
    A1 -.->|"未接"| B1
    A2 -.->|"未接"| B1
    A3 -.->|"未接"| B3
    A4 -.->|"未接"| B4

    classDef ok fill:#e8f7ee,stroke:#2f9e5f,color:#1e6b3f
    classDef missing fill:#f1f2f3,stroke:#9499a0,color:#61666d
    class B1,B2,B3,B4,B5,C1,C2,C3,C4,C5,C6,D2 ok
    class A1,A2,A3,A4,D1 missing
```

**断点**：

| # | 现象 | 依据 |
|---|---|---|
| 1 | **卡片上的快捷赞 / 藏按钮只改内存**，刷新即复原（`app.js` 里有 TODO 指向 `/api/sites/:name/like \| /favorite`） | `app.js` · `vcard` |
| 2 | 观看页的点赞、收藏、评论、回复、删除**全部是内存数组** | `view.html` |
| 3 | 创作者页的「+ 关注」也是内存状态 | `user.html` |
| 4 | 前端的**权限判断用的是写死的演示身份**（`MP.ME`），所以真实作者看不到自己评论的删除按钮、任何访客都能删演示评论 | `new-findings.md` N2 |

---

## E1 · 个人中心（我的站点 / 收藏 / 历史 / 私信 / 通知）

**现状**：❌ **5 个页面里只有「我的站点」是真的，其余 4 个全是演示数据。**

```mermaid
flowchart TD
    subgraph S1["① 浏览器"]
        A1["✅ /sites 我的站点<br/>public/sites.html"]
        A2["🔶 /favorites 我的收藏<br/>public/favorites.html"]
        A3["🔶 /history 观看历史<br/>public/history.html"]
        A4["🔶 /messages 私信<br/>public/messages.html"]
        A5["🔶 /notifications 通知<br/>public/notifications.html"]
    end
    subgraph S2["② HTTP 入口 —— 后端全都存在"]
        B1["GET /api/sites<br/>handleMySites"]
        B2["GET /api/favorites<br/>handleFavoritesList"]
        B3["GET / POST / DELETE /api/history<br/>handleHistoryList / Record / Clear / Delete"]
        B4["GET /api/messages · /api/messages/:id<br/>POST /api/messages/:id<br/>handleConversations / MessagesWith / MessageSend"]
        B5["GET /api/notifications<br/>POST /api/notifications/seen<br/>handleNotificationsList / Seen"]
    end
    subgraph S3["③ 业务与数据"]
        C1["sites.js · listSitesByOwner"]
        C2["social.js · listFavorites"]
        C3["social.js · listHistory / recordView / removeHistory / clearHistory"]
        C4["social.js · listConversations / listMessages / sendMessage"]
        C5["social.js · NOTIFICATIONS_SQL / countUnread"]
        C6[("sites · favorites · view_history<br/>messages · 互动四表")]
    end
    A1 --> B1 --> C1 --> C6
    A2 -.->|"未接"| B2
    A3 -.->|"未接"| B3
    A4 -.->|"未接"| B4
    A5 -.->|"未接"| B5
    B2 --> C2
    B3 --> C3
    B4 --> C4
    B5 --> C5
    C2 --> C6
    C3 --> C6
    C4 --> C6
    C5 --> C6

    classDef ok fill:#e8f7ee,stroke:#2f9e5f,color:#1e6b3f
    classDef demo fill:#fff4e5,stroke:#d98a1f,color:#8a5a00
    class A1,B1,B2,B3,B4,B5,C1,C2,C3,C4,C5,C6 ok
    class A2,A3,A4,A5 demo
```

**断点**：

| # | 页面 | 现象 |
|---|---|---|
| 1 | `/favorites` | 渲染 `MP.SITES` 现算的假收藏夹；`GET /api/favorites` 存在但没人调。且服务端**没有收藏夹模型**（只有一个平铺列表），页面上的「新建收藏夹」做不出来 |
| 2 | `/history` | `records = MP.SITES.slice(0,9)`；整套 `/api/history` 没人调。「只保留最近 30 天」是内存文案 |
| 3 | `/messages` | 页内 `CONVS` 数组；自己的身份取 `MP.ME`（演示用户），与真实登录态不一致 |
| 4 | `/notifications` | 页内 `items` 数组；服务端连「未读数」都已经算好了（`MP.session()` 里的 `unread`），只是页面不用 |

---

## E2 · 创作者主页

**现状**：❌ **后端接口可用（实测 200），前端是演示页。**

```mermaid
flowchart TD
    subgraph S1["① 浏览器"]
        A1["🔶 /u/:名字<br/>public/user.html"]
    end
    subgraph S2["② HTTP 入口 server.js"]
        B1["GET /api/u/:名字/profile<br/>handleCreatorProfile（公开，读登录态）"]
    end
    subgraph S3["③ 业务与数据"]
        C1["资料 + 社交数字 + TA 的公开站点<br/>social.js · creatorPage"]
        C2["粉丝数 / 关注数<br/>social.js · socialProfile"]
        C3[("users · sites · follows")]
    end
    subgraph S4["④ 响应与落地"]
        D1["🔶 页面渲染 MP.SITES 演示数据<br/>关注状态取 MP.ME"]
    end
    A1 -.->|"未接"| B1
    B1 --> C1 --> C3
    C1 --> C2 --> C3
    C1 --> D1

    classDef ok fill:#e8f7ee,stroke:#2f9e5f,color:#1e6b3f
    classDef demo fill:#fff4e5,stroke:#d98a1f,color:#8a5a00
    class B1,C1,C2,C3 ok
    class A1,D1 demo
```

**断点**：`user.html` 完全不发请求。而且它用 `MP.ME` 判断「是不是我自己」，
所以**真实用户打开自己的主页会看到「+ 关注」而不是「编辑资料」**（N2）。

---

## F1 · 管理后台

**现状**：✅ 通。

```mermaid
flowchart TD
    subgraph S1["① 浏览器"]
        A1["/admin 打开<br/>public/admin.html"]
        A2["封禁 / 解封用户"]
        A3["下线 / 恢复站点，删除站点"]
    end
    subgraph S2["② HTTP 入口 server.js"]
        B1["GET /api/me + /api/admin/users<br/>+ /api/admin/sites（并发三发）<br/>handleAdminUsers / handleAdminSites"]
        B2["POST /api/admin/users/:id/status<br/>handleAdminUserStatus"]
        B3["POST /api/admin/sites/:id/status<br/>handleAdminSiteStatus"]
        B4["DELETE /api/admin/sites/:id<br/>handleAdminDeleteSite"]
        B5["鉴权<br/>仅管理员（非管理员 403）"]
    end
    subgraph S3["③ 业务与数据"]
        C1["users.js · listUsers / setUserStatus"]
        C2["sites.js · listAllSites / setSiteStatus / deleteSiteById"]
        C3[("users · sites")]
    end
    subgraph S4["④ 响应与落地"]
        D1["两张表就地刷新"]
    end
    A1 --> B1 --> B5 --> C1 --> C3 --> D1
    B5 --> C2
    A2 --> B2 --> C1
    A3 --> B3 --> C2
    A3 --> B4 --> C2

    classDef ok fill:#e8f7ee,stroke:#2f9e5f,color:#1e6b3f
    classDef warn fill:#fff4e5,stroke:#d98a1f,color:#8a5a00
    class A1,A2,A3,B1,B2,B3,B4,B5,C1,C2,C3,D1 ok
    class B2 warn
```

**断点**：无功能断裂。**封禁不吊销会话**（登录态在 `currentUser` 里按 `status` 现查，所以行为上是对的，
只是 `sessions` 表里留着行）。

---

## G1 · MCP 通道

**现状**：✅ 通。**与登录 Cookie 无关的第二条凭据通道。**

```mermaid
flowchart TD
    subgraph S1["① 浏览器（只在建/吊销密钥时用）"]
        A1["/settings 创建密钥<br/>public/settings.html"]
        A2["/settings 吊销密钥"]
    end
    subgraph S2["② HTTP 入口 server.js"]
        B1["POST /api/mcp/tokens<br/>handleMcpTokenCreate"]
        B2["GET /api/mcp/tokens<br/>handleMcpTokenList"]
        B3["POST /api/mcp/tokens/:id/revoke<br/>handleMcpTokenRevoke"]
        B4["POST /mcp · /mcp/:key<br/>handleMcp（密钥鉴权，不看 Cookie）"]
    end
    subgraph S3["③ 业务与数据"]
        C1["铸造密钥（明文只回一次）<br/>lib/mcp/tokens.js · mintToken"]
        C2["库内只存 sha256<br/>tokens.js · publicToken"]
        C3["校验密钥 + 用户 active<br/>tokens.js（封禁即刻失效）"]
        C4["JSON-RPC 分发<br/>lib/mcp/server.js（手写，不引 SDK）"]
        C5["10 个工具<br/>lib/mcp/tools.js · 注册表 + backend"]
        C6[("mcp_tokens")]
    end
    subgraph S4["④ 响应与落地"]
        D1["回 {ok, token} 明文；界面只显示一次"]
        D2["工具直接调 lib/sites.js<br/>同进程，不绕自己的 HTTP 接口"]
        D3["权限 = 网页登录，但只作用于密钥主人自己的站点"]
    end
    A1 --> B1 --> C1 --> C2 --> C6 --> D1
    A2 --> B3 --> C6
    A1 --> B2 --> C6
    B4 --> C3 --> C6
    C3 --> C4 --> C5 --> D2
    C5 --> D3

    classDef ok fill:#e8f7ee,stroke:#2f9e5f,color:#1e6b3f
    class A1,A2,B1,B2,B3,B4,C1,C2,C3,C4,C5,C6,D1,D2,D3 ok
```

**断点**：无功能断裂。三个细节见 `new-findings.md` 的 N20（无 id 的通知也会收到响应、超限 413 送不到、密钥上限判断非原子）。

---

## 汇总：断在哪

按「修起来值不值」排序。**判断标准是：这条断点会不会在后续接线中被顺带重写掉。**

### 一、前端没接（占绝大多数，都是"后端已就绪、前端未调"）

| 链路 | 未接的页面 | 后端状态 |
|---|---|---|
| D1 社区互动 | `view.html`、`user.html`、`app.js` 卡片 | ✅ 4 张表 + 全部接口可用 |
| E1 个人中心 | `favorites` `history` `messages` `notifications` | ✅ 接口全在 |
| E2 创作者主页 | `user.html` | ✅ 实测 200 |
| C2 观看页 | `view.html` 的 iframe 与互动区 | ✅ stats / comments 可用 |

**共 6 个页面是"能看但假"**，全部集中在 D1 / E1 / E2 / C2。

### 二、后端与前端口径不一致

| # | 现象 |
|---|---|
| 1 | 发现流**主列表真实、侧栏演示**，两套数字并排显示 |
| 2 | `discover.html` 的轮播位被停用（指向的站点不存在） |
| 3 | 顶栏「排行榜」指向的 `sort=rank` 不在服务端白名单里（目前前端硬映射兜住） |
| 4 | 搜索不匹配作者名，而前端的演示数据版本会匹配 |

### 三、后端自身的缺陷（**不会**被前端接线顺带修掉，值得单独修）

`BC-11`（超限 413 发不出去）、`BC-21`（站名大写走不通多文件接口）、
2MB/10MB 两条路不一致、先建站后读体、`updated_at` 刷新不对称、封禁不吊销会话、
`readBody` 遇 falsy 请求体挂起（N1）。

完整清单在本地（不进 git，故不做链接）：`tests/new-findings.md`（本轮新发现 21 条）+ `tests/issues.md`（上一轮 53 条）。
上面每个「断点」小节已经把这轮相关的部分就地写全了，不必跳出去看。
